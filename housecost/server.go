// Web server mode: the TerraSim website and its design API in one process.
//
//	go run . -serve              website and API on http://localhost:8000
//	go run . -serve -addr :9000  another port
//
// The website (../frontend) is served at /, and the API at /api, following contracts/STORAGE.md:
//
//	GET  /api/health                     { ok, model, key }
//	POST /api/designs                    a terrasim.design-request/2  ->  202 { jobId }
//	GET  /api/designs/jobs/{id}          { status, progress, message, designId, error }
//	GET  /api/designs/{id}               terrasim.design/2
//	GET  /api/designs/{id}/estimate      terrasim.estimate/1
//	GET  /api/designs/{id}/report        housecost.report/1
//
// Each request runs the same pipeline as -request (site data, three Gemma calls, layout, pricing).
// Jobs run one at a time, because the free Gemini tier and the free data sources are rate-limited.
// Finished results are kept in memory and written to results/<design id>.json.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type job struct {
	mu       sync.Mutex
	ID       string
	Status   string // queued | running | done | failed
	Message  string
	Lines    int
	DesignID string
	Error    string
}

func (j *job) set(f func(*job)) { j.mu.Lock(); f(j); j.mu.Unlock() }

func (j *job) view() map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	v := map[string]any{"status": j.Status, "message": j.Message}
	if j.Status == "running" {
		// The pipeline logs about 25 lines on a typical run; this is a rough guide, not a promise.
		v["progress"] = minF(0.95, float64(j.Lines)/28)
	}
	if j.DesignID != "" {
		v["designId"] = j.DesignID
	}
	if j.Error != "" {
		v["error"] = j.Error
	}
	return v
}

func minF(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// jobLog copies the pipeline's log to the console and turns each line into the job's message.
type jobLog struct {
	j   *job
	buf bytes.Buffer
}

func (w *jobLog) Write(p []byte) (int, error) {
	os.Stdout.Write(p)
	w.buf.Write(p)
	for {
		line, err := w.buf.ReadString('\n')
		if err != nil {
			w.buf.WriteString(line)
			break
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if len(line) > 140 {
			line = line[:137] + "…"
		}
		w.j.set(func(j *job) { j.Message = line; j.Lines++ })
	}
	return len(p), nil
}

type server struct {
	newGemma func() (*Gemma, error)
	keyFile  string
	model    string
	mu       sync.Mutex
	jobs     map[string]*job
	results  map[string]*Output
	queue    chan func()
	resDir   string
}

func serve(addr, siteDir, model, keyFile string, newGemma func() (*Gemma, error)) error {
	s := &server{newGemma: newGemma, keyFile: keyFile, model: model, jobs: map[string]*job{}, results: map[string]*Output{},
		queue: make(chan func(), 64), resDir: "results"}
	go func() {
		for run := range s.queue {
			run()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("POST /api/designs", s.create)
	// One route for jobs/{id}, {id}, {id}/estimate and {id}/report (Go's router can't tell
	// "jobs/{id}" from "{id}/estimate" apart on its own).
	mux.HandleFunc("GET /api/designs/{rest...}", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.PathValue("rest"), "/"), "/")
		switch {
		case len(parts) == 2 && parts[0] == "jobs":
			s.jobStatus(w, parts[1])
		case len(parts) == 1:
			s.part(w, parts[0], "design")
		case len(parts) == 2 && (parts[1] == "estimate" || parts[1] == "report"):
			s.part(w, parts[0], parts[1])
		default:
			writeJSON(w, 404, map[string]string{"message": "Not found."})
		}
	})
	mux.HandleFunc("GET /api/listings", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, []any{}) })
	mux.HandleFunc("OPTIONS /api/", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })

	abs, _ := filepath.Abs(siteDir)
	if fileExists(filepath.Join(siteDir, "index.html")) {
		mux.Handle("/", noCache(http.FileServer(http.Dir(siteDir))))
		fmt.Printf("Website: %s\n", abs)
	} else {
		fmt.Printf("No website found at %s (use -site); serving the API only.\n", abs)
	}
	if _, _, err := loadKey(keyFile); err != nil {
		fmt.Printf("\nWARNING: %v\nDesigns will fail until a key is in place.\n\n", err)
	}
	host := addr
	if strings.HasPrefix(host, ":") {
		host = "localhost" + host
	}
	fmt.Printf("TerraSim is running: open http://%s\n", host)
	return http.ListenAndServe(addr, cors(mux))
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	_, _, err := loadKey(s.keyFile)
	writeJSON(w, 200, map[string]any{"ok": true, "service": "housecost", "model": s.model, "key": err == nil})
}

func (s *server) create(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil || !json.Valid(raw) {
		writeJSON(w, 400, map[string]string{"message": "The request isn't valid JSON."})
		return
	}
	// Check the request before queueing, so a bad one is answered straight away.
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		writeJSON(w, 400, map[string]string{"message": "The request doesn't match terrasim.design-request/2: " + err.Error()})
		return
	}
	if probs := ValidateRequest(req); len(probs) > 0 {
		writeJSON(w, 422, map[string]string{"message": "The design service can't use this request: " + strings.Join(probs, " ")})
		return
	}
	j := &job{ID: fmt.Sprintf("job-%d", time.Now().UnixNano()), Status: "queued", Message: "Waiting for the design service."}
	s.mu.Lock()
	s.jobs[j.ID] = j
	ahead := len(s.queue)
	s.mu.Unlock()
	if ahead > 0 {
		j.set(func(j *job) { j.Message = fmt.Sprintf("Queued behind %d other design%s.", ahead, plural(ahead)) })
	}
	select {
	case s.queue <- func() { s.run(j, raw) }:
	default:
		writeJSON(w, 429, map[string]string{"message": "The design service is busy. Try again in a few minutes."})
		return
	}
	writeJSON(w, 202, map[string]string{"jobId": j.ID})
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// run does one design: the same pipeline as -request, logging into the job.
func (s *server) run(j *job, raw []byte) {
	j.set(func(j *job) { j.Status, j.Message = "running", "Starting the design." })
	fail := func(msg string) {
		j.set(func(j *job) { j.Status, j.Error = "failed", msg })
		fmt.Printf("[%s] failed: %s\n", j.ID, msg)
	}
	defer func() {
		if r := recover(); r != nil {
			fail(fmt.Sprintf("The design service hit an internal error (%v).", r))
		}
	}()
	g, err := s.newGemma()
	if err != nil {
		fail(err.Error())
		return
	}
	ov, err := LoadOverrides("prices.csv")
	if err != nil {
		fail(err.Error())
		return
	}
	log := &jobLog{j: j}
	res, runErr := RunRequest(raw, LiveDeps(g.Ask, log, ov))
	if res == nil || res.Design == nil {
		msg := "The design service couldn't design this site."
		if res != nil && len(res.Report.Problems) > 0 {
			msg = strings.Join(res.Report.Problems, " ")
		} else if runErr != nil {
			msg = runErr.Error()
		}
		fail(msg)
		return
	}
	id := res.Design.ID
	s.mu.Lock()
	s.results[id] = res
	s.mu.Unlock()
	if err := os.MkdirAll(s.resDir, 0o755); err == nil {
		b, _ := json.MarshalIndent(res, "", "  ")
		_ = os.WriteFile(filepath.Join(s.resDir, id+".json"), b, 0o644)
	}
	j.set(func(j *job) { j.Status, j.DesignID, j.Message = "done", id, "Design ready." })
	fmt.Printf("[%s] done: %s\n", j.ID, id)
}

func (s *server) jobStatus(w http.ResponseWriter, id string) {
	s.mu.Lock()
	j := s.jobs[id]
	s.mu.Unlock()
	if j == nil {
		writeJSON(w, 404, map[string]string{"message": "That design job isn't known (the server may have restarted)."})
		return
	}
	writeJSON(w, 200, j.view())
}

// part serves one part of a finished result, from memory or from results/<id>.json.
func (s *server) part(w http.ResponseWriter, id, which string) {
	{
		s.mu.Lock()
		res := s.results[id]
		s.mu.Unlock()
		if res == nil && !strings.ContainsAny(id, `/\.`) {
			if b, err := os.ReadFile(filepath.Join(s.resDir, id+".json")); err == nil {
				var o Output
				if json.Unmarshal(b, &o) == nil {
					res = &o
					s.mu.Lock()
					s.results[id] = res
					s.mu.Unlock()
				}
			}
		}
		if res == nil {
			writeJSON(w, 404, map[string]string{"message": "No design with that id."})
			return
		}
		switch which {
		case "design":
			writeJSON(w, 200, res.Design)
		case "estimate":
			if res.Estimate == nil {
				writeJSON(w, 404, map[string]string{"message": "No estimate for this design."})
				return
			}
			writeJSON(w, 200, res.Estimate)
		default:
			writeJSON(w, 200, res.Report)
		}
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// cors lets a website served elsewhere (npm start on :5173) call the API.
func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Headers", "content-type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		h.ServeHTTP(w, r)
	})
}

// noCache keeps the browser from holding on to old copies of the website's files during work.
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}
