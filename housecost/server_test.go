package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const workerTestToken = "test-service-token-with-at-least-32-characters"

// The real HTTP worker runs the pipeline using offline model/site stand-ins.
func TestPrivateDesignHTTPWorkflow(t *testing.T) {
	s := &server{token: workerTestToken}
	s.deps = func(ctx context.Context, log io.Writer, raw []byte) (Deps, error) {
		var req Request
		if err := json.Unmarshal(raw, &req); err != nil {
			return Deps{}, err
		}
		fg := &fakeGemma{t: t, r: req}
		return Deps{FetchSite: fakeSite, Ask: fg.ask, Log: log, Now: time.Now, Suppliers: func(float64, float64) ([]Supplier, error) { return []Supplier{}, nil }}, nil
	}
	h := s.handler("")
	do := func(path string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+workerTestToken)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		body string
		code int
	}{{"{", 400}, {`{}`, 422}} {
		w := do("/internal/generate", []byte(tc.body))
		if w.Code != tc.code {
			t.Fatalf("want %d got %d: %s", tc.code, w.Code, w.Body)
		}
	}
	request := testRequest("house")
	raw, _ := json.Marshal(request)
	w := do("/internal/generate", raw)
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("generate: %d %s", w.Code, w.Body)
	}
	dec := json.NewDecoder(w.Body)
	var design *Design
	progress := 0
	for {
		var f struct {
			Progress map[string]json.RawMessage `json:"progress"`
			Result   *struct {
				Design   *Design   `json:"design"`
				Estimate *Estimate `json:"estimate"`
			} `json:"result"`
			Error string `json:"error"`
		}
		err := dec.Decode(&f)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if f.Error != "" {
			t.Fatal(f.Error)
		}
		if f.Progress != nil {
			progress++
			if len(f.Progress["steps"]) == 0 {
				t.Fatal("missing step progress")
			}
			if f.Progress["log"] != nil {
				t.Fatal("raw provider logs crossed worker boundary")
			}
		}
		if f.Result != nil {
			design = f.Result.Design
			if f.Result.Estimate == nil {
				t.Fatal("estimate missing")
			}
		}
	}
	if progress == 0 || design == nil || design.Cost == nil || design.Cost.BuildCost.Expected <= 0 {
		t.Fatal("missing progress or priced design")
	}
	if design.RequestID != *request.ID {
		t.Fatal("request identity changed")
	}
	if w := do("/api/designs", raw); w.Code != 404 {
		t.Fatalf("retired process-local queue remains active: %d", w.Code)
	}
}

func TestPrivateWorkerRequiresServiceAuthorization(t *testing.T) {
	for _, path := range []string{"/internal/generate", "/api/designs", "/api/designs/jobs/anything", "/api/designs/result", "/api/coverage", "/api/health"} {
		for _, token := range []string{"", "wrong", workerTestToken} {
			s := &server{token: workerTestToken}
			r := httptest.NewRequest("GET", path, nil)
			if token != "" {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			s.handler("").ServeHTTP(w, r)
			if token != workerTestToken && w.Code != http.StatusUnauthorized {
				t.Fatalf("%s accepted invalid token: %d", path, w.Code)
			}
			if w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("private worker allows browser CORS")
			}
		}
	}
	s := &server{}
	r := httptest.NewRequest("GET", "/api/health", nil)
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 32))
	w := httptest.NewRecorder()
	s.handler("").ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("unconfigured worker did not fail closed")
	}
}

func TestPrivateWorkerExplainsPlacementFailureWithoutCallingProviders(t *testing.T) {
	s := &server{token: workerTestToken, deps: func(ctx context.Context, log io.Writer, raw []byte) (Deps, error) {
		return Deps{Log: log, FetchSite: func(SiteQuery) (Site, error) {
			t.Error("unbuildable footprint must fail before site data or AI")
			return Site{}, nil
		}}, nil
	}}
	request := testRequest("townhouse")
	request.Brief.AreaM2 = ptr(10000.0)
	raw, _ := json.Marshal(request)
	r := httptest.NewRequest("POST", "/internal/generate", bytes.NewReader(raw))
	r.Header.Set("Authorization", "Bearer "+workerTestToken)
	w := httptest.NewRecorder()
	s.handler("").ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("worker response: %d %s", w.Code, w.Body)
	}
	dec := json.NewDecoder(w.Body)
	found := false
	for {
		var frame struct {
			Code, Error string
			Result      json.RawMessage
		}
		err := dec.Decode(&frame)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(frame.Result) > 0 {
			t.Fatal("unbuildable design reported success")
		}
		if frame.Error != "" {
			found = true
			if frame.Code != "design-does-not-fit" || !strings.Contains(frame.Error, "setbacks") {
				t.Fatalf("missing actionable fit error: %+v", frame)
			}
		}
	}
	if !found {
		t.Fatal("worker did not emit the placement failure")
	}
}
