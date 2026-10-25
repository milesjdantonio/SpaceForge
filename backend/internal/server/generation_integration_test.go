package server_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"spaceforge/backend/internal/building"
	"spaceforge/backend/internal/generation"
	"spaceforge/backend/internal/server"
	"spaceforge/backend/internal/testutil"
	"spaceforge/backend/internal/user"
)

func TestAuthorizedGenerationPersistsWithoutBrowserAndGroupsProjects(t *testing.T) {
	pool := testutil.Database(t)
	fixture, err := os.ReadFile("../../../frontend/fixtures/mock-house/design.json")
	if err != nil {
		t.Fatal(err)
	}
	var design map[string]json.RawMessage
	if err := json.Unmarshal(fixture, &design); err != nil {
		t.Fatal(err)
	}
	design["requestId"] = json.RawMessage(`"request-one"`)
	const serviceToken = "private-worker-token-at-least-32-characters"
	var calls atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+serviceToken || r.URL.Path != "/internal/generate" {
			t.Error("wrong worker authorization or route")
			w.WriteHeader(401)
			return
		}
		if strings.Contains(r.Header.Get("Authorization"), "alice") {
			t.Error("Firebase token forwarded to worker")
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		enc := json.NewEncoder(w)
		_ = enc.Encode(map[string]any{"progress": map[string]any{"message": "Planning the design", "progress": 0.5, "log": []string{"must not be retained"}}})
		_ = enc.Encode(map[string]any{"result": map[string]any{"design": design, "estimate": nil}})
	}))
	defer worker.Close()
	service := &generation.Service{Pool: pool, URL: worker.URL, Token: serviceToken, Workers: 2}
	users := &user.Store{Pool: pool}
	newAPI := func() http.Handler {
		return server.New(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, identities{}, users, &building.Store{Pool: pool}, nil, service)
	}
	h := newAPI()
	for _, route := range []struct{ method, path string }{{"POST", "/api/designs"}, {"GET", "/api/designs/jobs"}, {"GET", "/api/designs/jobs/id"}, {"GET", "/api/designs/id"}, {"GET", "/api/projects"}, {"POST", "/api/projects"}, {"GET", "/api/coverage"}} {
		expect(t, call(h, "", route.method, route.path, `{}`), 401)
	}
	input := `{"request_key":"idempotent-one","request":{"schema":"terrasim.design-request/2","id":"request-one","site":{"geometry":{"coordinates":[[[-105,40],[-104.99,40],[-104.99,40.01],[-105,40]]]}}},"site":{"form":{"housingType":"house"}}}`
	accepted := call(h, "alice", "POST", "/api/designs", input)
	expect(t, accepted, 202)
	var job struct {
		ID        string `json:"jobId"`
		ProjectID string `json:"projectId"`
	}
	decode(t, accepted, &job)
	again := call(h, "alice", "POST", "/api/designs", input)
	expect(t, again, 202)
	var repeated struct {
		ID string `json:"jobId"`
	}
	decode(t, again, &repeated)
	if repeated.ID != job.ID {
		t.Fatal("retry created another task")
	}
	expect(t, call(h, "alice", "POST", "/api/designs", strings.Replace(input, "request-one", "different", 1)), 409)
	expect(t, call(h, "bob", "GET", "/api/designs/jobs/"+job.ID, ""), 404)
	expect(t, call(h, "bob", "GET", "/api/projects/"+job.ProjectID, ""), 404)
	expect(t, call(h, "bob", "PUT", "/api/projects/"+job.ProjectID, `{"name":"stolen","land":{}}`), 404)
	expect(t, call(h, "bob", "DELETE", "/api/projects/"+job.ProjectID, ""), 404)
	otherJobs := call(h, "bob", "GET", "/api/designs/jobs", "")
	expect(t, otherJobs, 200)
	var list struct {
		Items []generation.Task `json:"items"`
	}
	decode(t, otherJobs, &list)
	if len(list.Items) != 0 {
		t.Fatal("other account saw private jobs")
	}
	foreign := strings.TrimSuffix(input, "}") + `,"project_id":"` + job.ProjectID + `"}`
	expect(t, call(h, "bob", "POST", "/api/designs", foreign), 404)
	// The browser is gone. A fresh API process and worker consume the persisted task.
	h = newAPI()
	ctx, cancel := context.WithCancel(context.Background())
	wait := service.Start(ctx)
	defer func() { cancel(); wait() }()
	var completed struct {
		Status   string            `json:"status"`
		Building building.Building `json:"building"`
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		w := call(h, "alice", "GET", "/api/designs/jobs/"+job.ID, "")
		expect(t, w, 200)
		decode(t, w, &completed)
		if completed.Status == "done" {
			break
		}
		if completed.Status == "failed" {
			t.Fatalf("job failed: %s", w.Body)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if completed.Status != "done" || completed.Building.ID == "" {
		t.Fatal("server did not save without browser")
	}
	if calls.Load() != 1 {
		t.Fatalf("duplicate generation: %d calls", calls.Load())
	}
	if completed.Building.ProjectID != job.ProjectID {
		t.Fatal("generated building lost project membership")
	}
	var stored struct {
		Schema string `json:"schema"`
		Site   struct {
			Ring [][]float64 `json:"ring"`
		} `json:"site"`
		Design map[string]json.RawMessage `json:"design"`
	}
	if err := json.Unmarshal(completed.Building.Data, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Schema != "terrasim.saved-building/1" || len(stored.Site.Ring) != 3 || string(stored.Design["id"]) != string(design["id"]) {
		t.Fatal("saved envelope lost design or land")
	}
	var progress string
	if err := pool.QueryRow(ctx, `SELECT progress::text FROM design_tasks WHERE id=$1`, job.ID).Scan(&progress); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(progress, "must not be retained") {
		t.Fatal("raw worker logs persisted")
	}
	var designID string
	_ = json.Unmarshal(design["id"], &designID)
	expect(t, call(h, "alice", "GET", "/api/designs/"+designID, ""), 200)
	expect(t, call(h, "bob", "GET", "/api/designs/"+designID, ""), 404)
	// The same shared project can group additional independently rendered buildings.
	second := call(h, "alice", "POST", "/api/buildings", `{"name":"Second house","data":{"marker":42},"project_id":"`+job.ProjectID+`"}`)
	expect(t, second, 201)
	var secondBuilding building.Building
	decode(t, second, &secondBuilding)
	project := call(h, "alice", "GET", "/api/projects/"+job.ProjectID, "")
	expect(t, project, 200)
	var group struct {
		Buildings []building.Summary `json:"buildings"`
	}
	decode(t, project, &group)
	if len(group.Buildings) != 2 {
		t.Fatalf("project did not group buildings: %s", project.Body)
	}
	expect(t, call(h, "bob", "POST", "/api/buildings", `{"name":"stolen","data":{},"project_id":"`+job.ProjectID+`"}`), 404)
	expect(t, call(h, "alice", "DELETE", "/api/projects/"+job.ProjectID, ""), 409)
	newProject := call(h, "alice", "POST", "/api/projects", `{"name":"Other land","land":{"ring":[[0,0],[1,0],[1,1]]}}`)
	expect(t, newProject, 201)
	var destination struct {
		ID string `json:"id"`
	}
	decode(t, newProject, &destination)
	expect(t, call(h, "bob", "PUT", "/api/buildings/"+secondBuilding.ID+"/project", `{"project_id":"`+destination.ID+`"}`), 404)
	moved := call(h, "alice", "PUT", "/api/buildings/"+secondBuilding.ID+"/project", `{"project_id":"`+destination.ID+`"}`)
	expect(t, moved, 200)
	var assigned building.Building
	decode(t, moved, &assigned)
	if string(assigned.Data) != string(secondBuilding.Data) || assigned.ProjectID != destination.ID {
		t.Fatal("membership assignment overwrote the document or lost the destination")
	}
	// A normal autosave that omits project_id must preserve the new membership.
	updated := call(h, "alice", "PUT", "/api/buildings/"+secondBuilding.ID, `{"name":"Moved house","data":{"marker":43}}`)
	expect(t, updated, 200)
	decode(t, updated, &assigned)
	if assigned.ProjectID != destination.ID {
		t.Fatal("normal autosave reverted project membership")
	}
	// A generated building can still be deleted; its completed task is removed by FK cascade.
	expect(t, call(h, "alice", "DELETE", "/api/buildings/"+completed.Building.ID, ""), 204)
	expect(t, call(h, "alice", "GET", "/api/designs/jobs/"+job.ID, ""), 404)
	expect(t, call(h, "alice", "DELETE", "/api/projects/"+job.ProjectID, ""), 204)
}
