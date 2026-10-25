package generation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"spaceforge/backend/internal/testutil"
	"spaceforge/backend/internal/user"
)

func enqueue(t *testing.T, pool *pgxpool.Pool, key string) string {
	t.Helper()
	ctx := context.Background()
	owner, err := (&user.Store{Pool: pool}).SyncIdentity(ctx, user.Identity{Subject: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	var projectID, id string
	if err := pool.QueryRow(ctx, `INSERT INTO projects(owner_id,name) VALUES($1,'Project') RETURNING id::text`, owner.ID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO design_tasks(owner_id,project_id,request_key,request_hash,request) VALUES($1,$2,$3,'hash','{"request":{"id":"request"},"site":{"ring":[[0,0],[1,0],[1,1]]}}') RETURNING id::text`, owner.ID, projectID, key).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
func testOutput() output {
	return output{Design: json.RawMessage(`{"schema":"terrasim.design/2","id":"generated","requestId":"request","overview":{"title":"Saved design"},"placement":{}}`), Estimate: json.RawMessage(`null`)}
}

func TestRestartRecoveryFencesStaleWorkersAndCommitsOnce(t *testing.T) {
	pool := testutil.Database(t)
	ctx := context.Background()
	id := enqueue(t, pool, "recover")
	old := &Service{Pool: pool}
	first, err := old.claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE design_tasks SET lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	// A fresh service instance recovers the interrupted task entirely from SQL.
	restarted := &Service{Pool: pool}
	second, err := restarted.claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || first.Lease == second.Lease {
		t.Fatal("task was not recovered with a new fenced lease")
	}
	if err := old.complete(ctx, first, testOutput()); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("stale worker can commit: %v", err)
	}
	if err := restarted.complete(ctx, second, testOutput()); err != nil {
		t.Fatal(err)
	}
	if err := restarted.complete(ctx, second, testOutput()); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("completion can run twice: %v", err)
	}
	var count int
	var status string
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM buildings`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected one saved building, got %d", count)
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM design_tasks WHERE id=$1`, id).Scan(&status); err != nil || status != "done" {
		t.Fatalf("task/building were not committed together: %s %v", status, err)
	}
}
func TestConcurrentClaimsAndRetryLimit(t *testing.T) {
	pool := testutil.Database(t)
	ctx := context.Background()
	s := &Service{Pool: pool}
	for _, key := range []string{"one", "two", "three"} {
		enqueue(t, pool, key)
	}
	ids := make(chan string, 3)
	errs := make(chan error, 3)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			task, err := s.claim(ctx)
			if err != nil {
				errs <- err
				return
			}
			ids <- task.ID
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for id := range ids {
		if seen[id] {
			t.Fatal("workers claimed the same task")
		}
		seen[id] = true
	}
	if len(seen) != 3 {
		t.Fatal("concurrent workers did not claim independent tasks")
	}
	if _, err := pool.Exec(ctx, `UPDATE design_tasks SET attempts=3,lease_until=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.claim(ctx); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("exhausted task was reclaimed: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM design_tasks WHERE status='failed' AND lease_token IS NULL`).Scan(&count); err != nil || count != 3 {
		t.Fatalf("retry exhaustion failed: %d %v", count, err)
	}
}
func TestInvalidResultLeavesNoPartialBuilding(t *testing.T) {
	pool := testutil.Database(t)
	ctx := context.Background()
	enqueue(t, pool, "invalid")
	s := &Service{Pool: pool}
	task, err := s.claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	wrong := testOutput()
	wrong.Design = json.RawMessage(`{"schema":"terrasim.design/2","id":"wrong","requestId":"another-request","overview":{"title":"Wrong"}}`)
	if err := s.complete(ctx, task, wrong); err == nil {
		t.Fatal("accepted result for another request")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM buildings`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial building leaked: %d %v", count, err)
	}
}

func TestWorkerFailureReasonPersistsForBrowser(t *testing.T) {
	pool := testutil.Database(t)
	ctx := context.Background()
	enqueue(t, pool, "fit-failure")
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "design-does-not-fit", "error": "The building does not fit inside the land with its setbacks."})
	}))
	defer worker.Close()
	s := &Service{Pool: pool, URL: worker.URL, Token: "offline-fixture-token-at-least-32-characters"}
	task, err := s.claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s.execute(ctx, task)
	var status, message, code string
	err = pool.QueryRow(ctx, `SELECT status,error,progress->>'error_code' FROM design_tasks WHERE id=$1`, task.ID).Scan(&status, &message, &code)
	if err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != "design-does-not-fit" || !strings.Contains(message, "setbacks") {
		t.Fatalf("failure hidden from browser: status=%s code=%s message=%s", status, code, message)
	}
}
