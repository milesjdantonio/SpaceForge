package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const leaseDuration = 45 * time.Second
const maxAttempts = 3

type claimedTask struct {
	ID, OwnerID, ProjectID, Lease string
	Payload                       json.RawMessage
}
type output struct {
	Design   json.RawMessage `json:"design"`
	Estimate json.RawMessage `json:"estimate"`
}
type frame struct {
	Progress json.RawMessage `json:"progress,omitempty"`
	Result   *output         `json:"result,omitempty"`
	Error    string          `json:"error,omitempty"`
	Code     string          `json:"code,omitempty"`
}

// Start runs independent consumers against a shared durable queue. SKIP LOCKED
// and fenced leases allow multiple API processes without duplicate SQL results.
func (s *Service) Start(ctx context.Context) func() {
	var wg sync.WaitGroup
	n := s.Workers
	if n < 1 {
		n = 2
	}
	if s.URL != "" {
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for ctx.Err() == nil {
					task, err := s.claim(ctx)
					if err == nil {
						s.execute(ctx, task)
						continue
					}
					select {
					case <-ctx.Done():
						return
					case <-time.After(time.Second):
					}
				}
			}()
		}
	}
	return wg.Wait
}

func (s *Service) claim(ctx context.Context) (claimedTask, error) {
	var t claimedTask
	// A process that repeatedly dies must eventually leave an actionable failure.
	_, err := s.Pool.Exec(ctx, `UPDATE design_tasks SET status='failed',lease_token=NULL,lease_until=NULL,error='Generation was interrupted repeatedly. Submit a new request to retry.'
 WHERE status='running' AND lease_until<now() AND attempts >= $1`, maxAttempts)
	if err != nil {
		return t, err
	}
	t.Lease = uuid.NewString()
	err = s.Pool.QueryRow(ctx, `WITH candidate AS (
 SELECT id FROM design_tasks WHERE attempts<$1 AND (status='queued' AND retry_at<=now() OR status='running' AND lease_until<now())
 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE design_tasks t SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+$3::interval,
 error='',progress='{"message":"Generating your building.","progress":0}'::jsonb
 FROM candidate c WHERE t.id=c.id RETURNING t.id::text,t.owner_id::text,t.project_id::text,t.request`, maxAttempts, t.Lease, leaseDuration.String()).Scan(&t.ID, &t.OwnerID, &t.ProjectID, &t.Payload)
	return t, err
}

func (s *Service) execute(parent context.Context, t claimedTask) {
	ctx, cancel := context.WithTimeout(parent, 15*time.Minute)
	defer cancel()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		tick := time.NewTicker(leaseDuration / 3)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				result, err := s.Pool.Exec(ctx, `UPDATE design_tasks SET lease_until=now()+$3::interval WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()`, t.ID, t.Lease, leaseDuration.String())
				if err != nil || result.RowsAffected() != 1 {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-heartbeatDone }()
	var payload struct {
		Request json.RawMessage `json:"request"`
	}
	if json.Unmarshal(t.Payload, &payload) != nil {
		s.fail(ctx, t, false)
		return
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(s.URL, "/")+"/internal/generate", bytes.NewReader(payload.Request))
	if err != nil {
		s.fail(ctx, t, false)
		return
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	req.Header.Set("Content-Type", "application/json")
	client := s.Client
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(req)
	if err != nil {
		s.failAfterCancellation(parent, t, true)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		s.fail(ctx, t, response.StatusCode >= 500 || response.StatusCode == 429)
		return
	}
	dec := json.NewDecoder(io.LimitReader(response.Body, 64<<20))
	for {
		var f frame
		if err = dec.Decode(&f); err != nil {
			s.failAfterCancellation(parent, t, true)
			return
		}
		if len(f.Progress) > 0 {
			// Persist a bounded, safe status snapshot, not provider output or design documents in logs.
			var details map[string]json.RawMessage
			if json.Unmarshal(f.Progress, &details) != nil {
				s.fail(ctx, t, false)
				return
			}
			safe := map[string]json.RawMessage{}
			for _, key := range []string{"progress", "message", "steps", "elapsed"} {
				if value, ok := details[key]; ok {
					safe[key] = value
				}
			}
			b, _ := json.Marshal(safe)
			if len(b) > 64<<10 {
				s.fail(ctx, t, false)
				return
			}
			result, err := s.Pool.Exec(ctx, `UPDATE design_tasks SET progress=$3 WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()`, t.ID, t.Lease, b)
			if err != nil || result.RowsAffected() != 1 {
				return
			}
		}
		if f.Error != "" {
			s.failWithReason(ctx, t, false, f.Code, f.Error)
			return
		}
		if f.Result != nil {
			if err = s.complete(ctx, t, *f.Result); err != nil {
				s.failAfterCancellation(parent, t, true)
			}
			return
		}
	}
}

func (s *Service) complete(ctx context.Context, t claimedTask, out output) error {
	var design struct {
		Schema, ID string
		RequestID  string `json:"requestId"`
		Overview   struct {
			Title string `json:"title"`
		} `json:"overview"`
		Placement json.RawMessage `json:"placement"`
	}
	if json.Unmarshal(out.Design, &design) != nil || design.Schema != "terrasim.design/2" || design.ID == "" || strings.TrimSpace(design.Overview.Title) == "" {
		return errors.New("invalid design result")
	}
	var payload struct {
		Site    json.RawMessage `json:"site"`
		Request struct {
			ID string `json:"id"`
		} `json:"request"`
	}
	if err := json.Unmarshal(t.Payload, &payload); err != nil {
		return err
	}
	if payload.Request.ID != "" && design.RequestID != payload.Request.ID {
		return errors.New("result request identity mismatch")
	}
	name := []rune(strings.TrimSpace(design.Overview.Title))
	if len(name) > 120 {
		name = name[:120]
	}
	document, err := json.Marshal(map[string]any{"schema": "terrasim.saved-building/1", "design": out.Design, "estimate": out.Estimate, "site": payload.Site, "placement": design.Placement})
	if err != nil {
		return err
	}
	if len(document) > 1<<20 {
		return errors.New("result exceeds building size limit")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var id string
	// Lock and fence before inserting. A stale worker can never create a building.
	err = tx.QueryRow(ctx, `SELECT id::text FROM design_tasks WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE`, t.ID, t.Lease).Scan(&id)
	if err != nil {
		return err
	}
	err = tx.QueryRow(ctx, `INSERT INTO buildings(owner_id,project_id,name,data) VALUES($1,$2,$3,$4) RETURNING id::text`, t.OwnerID, t.ProjectID, string(name), document).Scan(&id)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE design_tasks SET status='done',building_id=$3,lease_token=NULL,lease_until=NULL,error='',progress=progress || '{"message":"Design saved to your account.","progress":1}'::jsonb WHERE id=$1 AND lease_token=$2`, t.ID, t.Lease, id)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) failAfterCancellation(parent context.Context, t claimedTask, retry bool) {
	// A shutdown leaves the lease for another process to reclaim. Other transport
	// failures are recorded even if the HTTP request's deadline has expired.
	if parent.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	s.fail(ctx, t, retry)
}
func (s *Service) fail(ctx context.Context, t claimedTask, retry bool) {
	s.failWithReason(ctx, t, retry, "generation-failed", "Generation could not finish. Submit a new request to retry.")
}

func (s *Service) failWithReason(ctx context.Context, t claimedTask, retry bool, code, message string) {
	switch code {
	case "design-does-not-fit", "site-not-feasible", "model-access-denied", "model-not-found", "provider-busy", "generation-failed":
	default:
		code = "generation-failed"
		message = "Generation could not finish. Submit a new request to retry."
	}
	if len(message) == 0 || len(message) > 1024 || strings.ContainsRune(message, '\x00') {
		message = "Generation could not finish. Submit a new request to retry."
	}
	_, _ = s.Pool.Exec(ctx, `UPDATE design_tasks SET
 status=CASE WHEN $3 AND attempts<$4 THEN 'queued' ELSE 'failed' END,
 error=CASE WHEN $3 AND attempts<$4 THEN '' ELSE $5 END,
 progress=progress || jsonb_build_object('message',CASE WHEN $3 AND attempts<$4 THEN 'Waiting to retry generation.' ELSE $5 END,'error_code',$6::text),
 retry_at=now()+interval '5 seconds'*attempts,
 lease_token=NULL,lease_until=NULL
 WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()`, t.ID, t.Lease, retry, maxAttempts, message, code)
}
