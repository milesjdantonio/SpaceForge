package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Exercise the real HTTP queue, pipeline, polling, and disk retrieval. Only the
// external model and site-data providers use stand-ins; no API key is needed.
func TestDesignHTTPWorkflow(t *testing.T) {
	s := &server{jobs: map[string]*job{}, results: map[string]*Output{}, queue: make(chan func(), 1), resDir: t.TempDir()}
	s.deps = func(log io.Writer, raw []byte) (Deps, error) {
		var req Request
		if err := json.Unmarshal(raw, &req); err != nil {
			return Deps{}, err
		}
		fg := &fakeGemma{t: t, r: req}
		return Deps{FetchSite: fakeSite, Ask: fg.ask, Log: log, Now: time.Now, Suppliers: func(float64, float64) ([]Supplier, error) {
			return []Supplier{}, nil
		}}, nil
	}
	h := s.handler("../frontend")
	do := func(method, path string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Origin", "http://127.0.0.1:5173")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		body string
		code int
	}{{"{", 400}, {`{}`, 422}} {
		w := do(http.MethodPost, "/api/designs", []byte(tc.body))
		if w.Code != tc.code || len(s.queue) != 0 {
			t.Fatalf("bad request: got %d, queued %d: %s", w.Code, len(s.queue), w.Body)
		}
	}
	preflight := do(http.MethodOptions, "/api/designs", nil)
	if preflight.Code != 204 || preflight.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Fatalf("browser preflight failed: %d", preflight.Code)
	}
	req := testRequest("house")
	raw, _ := json.Marshal(req)
	w := do(http.MethodPost, "/api/designs", raw)
	if w.Code != http.StatusAccepted {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var accepted struct {
		JobID string `json:"jobId"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &accepted); err != nil || accepted.JobID == "" {
		t.Fatalf("missing job ID: %s", w.Body)
	}
	queued := do(http.MethodGet, "/api/designs/jobs/"+accepted.JobID+"?since=0", nil)
	var progress struct {
		Status   string    `json:"status"`
		DesignID string    `json:"designId"`
		LogTotal int       `json:"logTotal"`
		Steps    []jobStep `json:"steps"`
	}
	if err := json.Unmarshal(queued.Body.Bytes(), &progress); err != nil || progress.Status != "queued" {
		t.Fatalf("queued status: %s", queued.Body)
	}
	done := make(chan struct{})
	go func() { defer close(done); (<-s.queue)() }()
	deadline := time.After(10 * time.Second)
	for progress.Status != "done" {
		select {
		case <-deadline:
			t.Fatal("design job did not complete")
		case <-time.After(10 * time.Millisecond):
		}
		w = do(http.MethodGet, "/api/designs/jobs/"+accepted.JobID+"?since=0", nil)
		if err := json.Unmarshal(w.Body.Bytes(), &progress); err != nil || progress.Status == "failed" {
			t.Fatalf("job failed: %s", w.Body)
		}
	}
	<-done
	if progress.LogTotal == 0 || len(progress.Steps) != len(stepDefs) {
		t.Fatalf("missing live progress: %+v", progress)
	}
	w = do(http.MethodGet, "/api/designs/"+progress.DesignID, nil)
	var design Design
	if err := json.Unmarshal(w.Body.Bytes(), &design); err != nil || w.Code != 200 || design.Cost == nil || design.Cost.BuildCost.Expected <= 0 {
		t.Fatalf("design with inline cost missing: %d %s", w.Code, w.Body)
	}
	if design.RequestID != *req.ID {
		t.Fatalf("request identity changed: %s", design.RequestID)
	}
	for _, part := range []string{"estimate", "report"} {
		if w := do(http.MethodGet, "/api/designs/"+progress.DesignID+"/"+part, nil); w.Code != 200 {
			t.Fatalf("%s: %d %s", part, w.Code, w.Body)
		}
	}
	// Losing the in-memory result on restart must still permit reading the file.
	s.mu.Lock()
	s.results = map[string]*Output{}
	s.mu.Unlock()
	if w := do(http.MethodGet, "/api/designs/"+progress.DesignID, nil); w.Code != 200 {
		t.Fatalf("disk restore failed: %d %s", w.Code, w.Body)
	}
	if _, err := os.Stat(filepath.Join(s.resDir, progress.DesignID+".json")); err != nil {
		t.Fatal(err)
	}
	if w := do(http.MethodGet, "/api/designs/jobs/missing", nil); w.Code != 404 {
		t.Fatalf("unknown job: %d", w.Code)
	}
}
