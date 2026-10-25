// Private generation worker. Account authorization, jobs and persistence live in backend/.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---- the pipeline's steps -----------------------------------------------------------------------

type stepDef struct {
	ID, Label string
	Gemma     bool
	start     *regexp.Regexp // the log line that begins it
}

var stepDefs = []stepDef{
	{"sizing", "Sizing the building to the land", false, regexp.MustCompile(`^Sizing a first version`)},
	{"site", "Gathering site data", false, regexp.MustCompile(`^Gathering site data`)},
	{"assessment", "Assessing the site", true, regexp.MustCompile(`^Gemma: site assessment \(attempt (\d+) of (\d+)\)`)},
	{"program", "Planning the design", true, regexp.MustCompile(`^Gemma: design program \(attempt (\d+) of (\d+)\)`)},
	{"drawing", "Drawing floors, walls and furniture", false, regexp.MustCompile(`^Drawing the design`)},
	{"materials", "Choosing materials", true, regexp.MustCompile(`^Gemma: materials \(attempt (\d+) of (\d+)\)`)},
	{"pricing", "Pricing and nearby suppliers", false, regexp.MustCompile(`^Pricing:`)},
}

// Expected seconds per step, from typical runs on the free tier; replaced by measured times.
var stepExpect = struct {
	sync.Mutex
	s map[string]float64
}{s: map[string]float64{"sizing": 4, "site": 25, "assessment": 35, "program": 45, "drawing": 4, "materials": 55, "pricing": 15}}

type jobStep struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	Gemma    bool    `json:"gemma"`
	Status   string  `json:"status"` // pending | running | done | failed
	Attempt  int     `json:"attempt,omitempty"`
	Attempts int     `json:"attempts,omitempty"`
	Seconds  float64 `json:"seconds,omitempty"`
	started  time.Time
}

type logLine struct {
	T    float64 `json:"t"` // seconds since the job started
	Text string  `json:"text"`
}

type job struct {
	mu       sync.Mutex
	ID       string
	Status   string // queued | running | done | failed
	Message  string
	Steps    []*jobStep
	Log      []logLine
	Partial  string // the line being written (Gemma's "waiting....")
	Started  time.Time
	DesignID string
	Error    string
}

func newJob() *job {
	j := &job{ID: fmt.Sprintf("job-%d", time.Now().UnixNano()), Status: "queued", Message: "Waiting for the design service."}
	for _, d := range stepDefs {
		j.Steps = append(j.Steps, &jobStep{ID: d.ID, Label: d.Label, Gemma: d.Gemma, Status: "pending"})
	}
	return j
}

func (j *job) set(f func(*job)) { j.mu.Lock(); f(j); j.mu.Unlock() }

// line records one log line and moves the steps along when it marks one starting.
func (j *job) line(text string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	now := time.Now()
	j.Log = append(j.Log, logLine{T: sround1(now.Sub(j.Started).Seconds()), Text: text})
	if len(j.Log) > 2000 {
		j.Log = j.Log[len(j.Log)-2000:]
	}
	trimmed := strings.TrimSpace(text)
	for i, d := range stepDefs {
		m := d.start.FindStringSubmatch(trimmed)
		if m == nil {
			continue
		}
		s := j.Steps[i]
		// Everything before this step is finished.
		for _, p := range j.Steps[:i] {
			if p.Status == "running" {
				p.Status, p.Seconds = "done", sround1(now.Sub(p.started).Seconds())
				learn(p.ID, p.Seconds/float64(max(1, p.Attempt)))
			} else if p.Status == "pending" {
				p.Status = "done"
			}
		}
		if s.Status != "running" {
			s.Status, s.started = "running", now
		}
		if len(m) == 3 {
			s.Attempt, _ = strconv.Atoi(m[1])
			s.Attempts, _ = strconv.Atoi(m[2])
		}
		j.Message = s.Label
		if s.Attempt > 1 {
			j.Message = fmt.Sprintf("%s (try %d of %d: fixing what the checks found)", s.Label, s.Attempt, s.Attempts)
		}
	}
}

func (j *job) finish(ok bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	now := time.Now()
	for _, s := range j.Steps {
		if s.Status != "running" {
			continue
		}
		if ok {
			s.Status, s.Seconds = "done", sround1(now.Sub(s.started).Seconds())
			learn(s.ID, s.Seconds/float64(max(1, s.Attempt)))
		} else {
			s.Status = "failed"
		}
	}
}

// learn moves a step's expected length toward what it just took.
func learn(id string, secs float64) {
	if secs <= 0 {
		return
	}
	stepExpect.Lock()
	stepExpect.s[id] = 0.5*stepExpect.s[id] + 0.5*secs
	stepExpect.Unlock()
}

// progress: finished steps count in full; the running one by its elapsed share of what it
// usually takes (never quite reaching the end until it's done). A Gemma retry adds another try's
// worth of time to its step.
func (j *job) progress() float64 {
	stepExpect.Lock()
	defer stepExpect.Unlock()
	var total, done float64
	now := time.Now()
	for _, s := range j.Steps {
		exp := stepExpect.s[s.ID]
		tries := float64(max(1, s.Attempt))
		switch s.Status {
		case "done":
			total += exp
			done += exp
		case "running":
			span := exp * tries
			total += span
			el := now.Sub(s.started).Seconds()
			done += span * minF(0.95, el/span) * (1 - 0.15*expDecay(el, span))
		default:
			total += exp
		}
	}
	if total == 0 {
		return 0
	}
	return minF(0.99, done/total)
}

// expDecay is 1 at the start of a step and falls toward 0, so early progress isn't overstated.
func expDecay(el, span float64) float64 {
	if span <= 0 {
		return 0
	}
	x := el / span
	if x >= 1 {
		return 0
	}
	return 1 - x
}

func (j *job) view(since int) map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	v := map[string]any{"status": j.Status, "message": j.Message}
	steps := make([]jobStep, len(j.Steps))
	for i, s := range j.Steps {
		steps[i] = *s
		if s.Status == "running" {
			steps[i].Seconds = sround1(time.Since(s.started).Seconds())
		}
	}
	v["steps"] = steps
	if j.Status == "running" {
		v["progress"] = sround3(j.progress())
	} else if j.Status == "done" {
		v["progress"] = 1
	}
	if since < 0 || since > len(j.Log) {
		since = 0
	}
	v["log"] = j.Log[since:]
	v["logFrom"] = since
	v["logTotal"] = len(j.Log)
	if j.Partial != "" {
		v["logPartial"] = j.Partial
	}
	if !j.Started.IsZero() {
		v["elapsed"] = sround1(time.Since(j.Started).Seconds())
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
func sround1(x float64) float64 { return float64(int(x*10+0.5)) / 10 }
func sround3(x float64) float64 { return float64(int(x*1000+0.5)) / 1000 }

// jobLog copies the pipeline's (and Gemma's) output to the console and into the job.
type jobLog struct {
	j   *job
	buf bytes.Buffer
}

func (w *jobLog) Write(p []byte) (int, error) {
	w.buf.Write(p)
	for {
		line, err := w.buf.ReadString('\n')
		if err != nil {
			w.buf.WriteString(line)
			break
		}
		line = strings.TrimRight(line, "\r\n")
		if strings.TrimSpace(line) == "" {
			continue
		}
		w.j.line(line)
	}
	partial := w.buf.String()
	w.j.set(func(j *job) { j.Partial = partial })
	return len(p), nil
}

// ---- the private worker service ---------------------------------------------------------------

type server struct {
	keyFile, model, token string
	deps                  func(context.Context, io.Writer, []byte) (Deps, error)
}

func serve(addr, siteDir, model, keyFile string, newGemma func() (*Gemma, error)) error {
	token := os.Getenv("GENERATION_SERVICE_TOKEN")
	if len(token) < 32 {
		return fmt.Errorf("GENERATION_SERVICE_TOKEN must contain at least 32 characters")
	}
	s := &server{keyFile: keyFile, model: model, token: token}
	s.deps = func(ctx context.Context, log io.Writer, raw []byte) (Deps, error) {
		g, err := newGemma()
		if err != nil {
			return Deps{}, err
		}
		g.Out, g.LogDir, g.Context = log, "", ctx
		ov, err := LoadOverrides("prices.csv")
		if err != nil {
			return Deps{}, err
		}
		return LiveDeps(g.Ask, log, ov), nil
	}
	fmt.Printf("Private design worker listening on %s\n", addr)
	srv := &http.Server{Addr: addr, Handler: s.handler(siteDir), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Minute, IdleTimeout: 60 * time.Second}
	return srv.ListenAndServe()
}

func (s *server) handler(siteDir string) http.Handler {
	private := http.NewServeMux()
	private.HandleFunc("POST /internal/generate", s.generate)
	private.HandleFunc("GET /api/coverage", s.coverage)
	private.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) })
	guard := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		values := r.Header.Values("Authorization")
		if len(s.token) < 32 || len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte("Bearer "+s.token)) != 1 {
			writeJSON(w, 401, map[string]string{"message": "Service authorization required."})
			return
		}
		private.ServeHTTP(w, r)
	})
	mux := http.NewServeMux()
	mux.Handle("/internal/", guard)
	mux.Handle("/api/", guard)
	if fileExists(filepath.Join(siteDir, "index.html")) {
		mux.Handle("/", noCache(http.FileServer(http.Dir(siteDir))))
	}
	return mux
}

// Progress is streamed to the authenticated API, which persists safe step snapshots.
// No local queue, result files or shared provider-reply logs are used by this path.
func (s *server) generate(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		writeJSON(w, 413, map[string]string{"message": "Request exceeds 1 MiB."})
		return
	}
	var request Request
	if json.Unmarshal(raw, &request) != nil {
		writeJSON(w, 400, map[string]string{"message": "Invalid design request."})
		return
	}
	if problems := ValidateRequest(request); len(problems) > 0 {
		writeJSON(w, 422, map[string]string{"message": strings.Join(problems, " ")})
		return
	}
	if ring, err := request.SiteRing(); err == nil && len(ring) > 0 {
		var lng, lat float64
		for _, p := range ring {
			lng += p[0]
			lat += p[1]
		}
		if !covered(lng/float64(len(ring)), lat/float64(len(ring))) {
			writeJSON(w, 422, map[string]string{"message": coverageMessage})
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()
	fmt.Printf("Design generation started (model=%s, type=%s).\n", s.model, sv(request.HousingType))
	j := newJob()
	j.set(func(j *job) { j.Status = "running"; j.Message = "Starting the design."; j.Started = time.Now() })
	deps, err := s.deps(ctx, &jobLog{j: j}, raw)
	if err != nil {
		writeJSON(w, 503, map[string]string{"message": "Generation providers are unavailable."})
		return
	}
	type finished struct {
		result *Output
		err    error
	}
	done := make(chan finished, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- finished{err: fmt.Errorf("pipeline failed")}
			}
		}()
		out, err := RunRequest(raw, deps)
		done <- finished{out, err}
	}()
	w.Header().Set("Content-Type", "application/x-ndjson")
	encoder := json.NewEncoder(w)
	send := func(value any) bool {
		if encoder.Encode(value) != nil {
			return false
		}
		return http.NewResponseController(w).Flush() == nil
	}
	progress := func() bool {
		snapshot := j.view(0)
		// Only step metadata crosses the process boundary. Raw provider logs may contain private input.
		delete(snapshot, "log")
		delete(snapshot, "logFrom")
		delete(snapshot, "logTotal")
		delete(snapshot, "logPartial")
		return send(map[string]any{"progress": snapshot})
	}
	if !progress() {
		return
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if !progress() {
				return
			}
		case result := <-done:
			if result.err != nil || result.result == nil || result.result.Design == nil {
				code, message := generationFailure(result.result, result.err)
				j.finish(false)
				j.set(func(j *job) { j.Status = "failed"; j.Message = message })
				fmt.Printf("Design generation failed (code=%s).\n", code)
				if !progress() {
					return
				}
				send(map[string]string{"error": message, "code": code})
				return
			}
			j.finish(true)
			j.set(func(j *job) { j.Status = "done" })
			if !progress() {
				return
			}
			send(map[string]any{"result": map[string]any{"design": result.result.Design, "estimate": result.result.Estimate}})
			fmt.Println("Design generation completed.")
			return
		}
	}
}

// Classify failures without exposing credentials, private prompts or provider replies.
func generationFailure(out *Output, err error) (string, string) {
	if out != nil && out.Report.Verdict == "not_feasible" {
		fit := out.Report.Assessment == nil
		for _, problem := range out.Report.Problems {
			if strings.Contains(problem, "doesn't fit on the site") {
				fit = true
			}
		}
		if fit {
			return "design-does-not-fit", "The requested building does not fit inside the land with the required setbacks. Reduce its size or number of homes, or outline a larger lot."
		}
		return "site-not-feasible", "The site assessment could not support this design. Adjust the brief or choose different land."
	}
	if err != nil {
		message := err.Error()
		if strings.Contains(message, "HTTP 401") || strings.Contains(message, "HTTP 403") {
			return "model-access-denied", "The design provider rejected access. Check the server's Google API key and model permissions."
		}
		if strings.Contains(message, "HTTP 404") {
			return "model-not-found", "The configured design model is unavailable. Check the server's model setting and account access."
		}
		if strings.Contains(message, "HTTP 429") {
			return "provider-busy", "The design provider is rate limited. Wait a few minutes and try again."
		}
	}
	return "generation-failed", "Generation could not finish. Adjust the brief or try again."
}

func writeJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

// noCache keeps the browser from holding on to old copies of the website's files during work.
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

// ---- where the site data reaches ---------------------------------------------------------------

// The free sources the pipeline uses (USDA soil, USGS elevation and seismic, FEMA flood, BLS wages)
// cover the United States. These boxes are a quick first check; a source that still has no data
// for a spot inside them makes the design fail with that source named.
var coverageBoxes = []struct {
	name       string
	w, s, e, n float64
}{
	{"the contiguous United States", -125.0, 24.4, -66.9, 49.4},
	{"Alaska", -170.0, 51.2, -129.9, 71.5},
	{"Hawaii", -160.6, 18.8, -154.7, 22.4},
	{"Puerto Rico", -67.4, 17.8, -65.2, 18.6},
}

const coverageMessage = "TerraSim's site data (soil, elevation, flood zones, seismic risk and local wages) only covers the United States, so it can't design for this land yet. Outline land in the US to try it."

func covered(lng, lat float64) bool {
	for _, b := range coverageBoxes {
		if lng >= b.w && lng <= b.e && lat >= b.s && lat <= b.n {
			return true
		}
	}
	return false
}

func (s *server) coverage(w http.ResponseWriter, r *http.Request) {
	lng, err1 := strconv.ParseFloat(r.URL.Query().Get("lng"), 64)
	lat, err2 := strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
	if err1 != nil || err2 != nil {
		writeJSON(w, 400, map[string]string{"message": "Give lng and lat."})
		return
	}
	if covered(lng, lat) {
		writeJSON(w, 200, map[string]any{"covered": true})
		return
	}
	writeJSON(w, 200, map[string]any{"covered": false, "message": coverageMessage})
}
