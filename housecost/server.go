// Web server mode: the TerraSim website and its design API in one process.
//
//	go run . -serve              website and API on http://localhost:8000
//	go run . -serve -addr :9000  another port
//
// The website (../frontend) is served at /, and the API at /api, following contracts/STORAGE.md:
//
//	GET  /api/health                         { ok, model, key }
//	POST /api/fit                            a request (description may be empty)  ->  does the building fit the land
//	POST /api/designs                        a terrasim.design-request/2  ->  202 { jobId }
//	GET  /api/designs/jobs/{id}?since=N      { status, progress, message, steps, log, logFrom, designId, error }
//	POST /api/designs/jobs/{id}/cancel       stops a queued or running design  ->  { status: "cancelled" }
//	GET  /api/designs/{id}                   terrasim.design/2 (with its cost)
//	GET  /api/designs/{id}/estimate          terrasim.estimate/1
//	GET  /api/designs/{id}/report            housecost.report/1
//
// Each request runs the same pipeline as -request (site data, three Gemma calls, layout, pricing).
// Progress follows the pipeline's own steps; each step's expected length starts from a typical run
// and is replaced by the measured length as designs complete, so the bar gets more accurate.
// Jobs run one at a time: the free Gemini tier and the free data sources are rate-limited.
// Finished results are kept in memory and written to results/<design id>.json.
package main

import (
	"bytes"
	"context"
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
	{"edit", "Reading your change", true, regexp.MustCompile(`^Gemma: your change \(attempt (\d+) of (\d+)\)`)},
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
}{s: map[string]float64{"edit": 6, "sizing": 3, "site": 4, "assessment": 8, "program": 18, "drawing": 2, "materials": 32, "pricing": 4}}

type jobStep struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	Gemma    bool    `json:"gemma"`
	Status   string  `json:"status"` // pending | running | done | failed | skipped (not part of this job)
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
	Status   string // queued | running | done | failed | cancelled
	Message  string
	Steps    []*jobStep
	Log      []logLine
	Partial  string // the line being written (Gemma's "waiting....")
	Started  time.Time
	DesignID string
	Error    string
	Advice   *Advice
	Request  json.RawMessage // for an edit, the brief the change became (sent with the result)
	ctx      context.Context
	cancel   context.CancelFunc
}

// newJob starts a design job; an edit job also reads the user's change first.
func newJob(edit ...bool) *job {
	j := &job{ID: fmt.Sprintf("job-%d", time.Now().UnixNano()), Status: "queued", Message: "Waiting for the design service."}
	j.ctx, j.cancel = context.WithCancel(context.Background())
	for _, d := range stepDefs {
		st := "pending"
		if d.ID == "edit" && (len(edit) == 0 || !edit[0]) {
			st = "skipped"
		}
		j.Steps = append(j.Steps, &jobStep{ID: d.ID, Label: d.Label, Gemma: d.Gemma, Status: st})
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
			} else if p.Status == "pending" { // skipped steps stay skipped
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
		case "skipped":
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
	if j.Advice != nil {
		v["advice"] = j.Advice
	}
	if len(j.Request) > 0 && j.Status == "done" {
		v["request"] = j.Request
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
	os.Stdout.Write(p)
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

// ---- the server ---------------------------------------------------------------------------------

type server struct {
	newGemma func() (*Gemma, error)
	keyFile  string
	model    string
	mu       sync.Mutex
	jobs     map[string]*job
	results  map[string]*Output
	queue    chan func()
	resDir   string
	// fake is -fake: no Gemma calls, see fake.go.
	fake bool
	// deps builds the pipeline's connections for one design; tests swap it for stand-ins.
	deps func(ctx context.Context, log io.Writer, raw []byte) (Deps, error)
}

func serve(addr, siteDir, model, keyFile string, newGemma func() (*Gemma, error), fake bool) error {
	s := &server{newGemma: newGemma, keyFile: keyFile, model: model, jobs: map[string]*job{}, results: map[string]*Output{},
		queue: make(chan func(), 64), resDir: "results", fake: fake}
	s.deps = func(ctx context.Context, log io.Writer, raw []byte) (Deps, error) {
		if fake {
			// -fake: the stand-in answers every Gemma step at once (fake.go); the site data is real.
			var r Request
			if err := json.Unmarshal(raw, &r); err != nil {
				return Deps{}, err
			}
			ov, err := LoadOverrides("prices.csv")
			if err != nil {
				return Deps{}, err
			}
			d := LiveDeps((&fakeGemma{r: r}).ask, log, ov)
			d.Ctx = ctx
			return d, nil
		}
		g, err := s.newGemma()
		if err != nil {
			return Deps{}, err
		}
		g.Out = log // Gemma's waiting dots, retries and slow-API notes go to the terminal too
		g.Ctx = ctx
		ov, err := LoadOverrides("prices.csv")
		if err != nil {
			return Deps{}, err
		}
		d := LiveDeps(g.Ask, log, ov)
		d.Ctx = ctx
		quick := *g
		quick.Timeout, quick.NoRetry = 45*time.Second, true
		d.Advise = quick.Ask
		return d, nil
	}
	return s.listen(addr, siteDir)
}

// listen serves the website and the API.
func (s *server) listen(addr, siteDir string) error {
	go func() {
		for run := range s.queue {
			run()
		}
	}()

	abs, _ := filepath.Abs(siteDir)
	if fileExists(filepath.Join(siteDir, "index.html")) {
		fmt.Printf("Website: %s\n", abs)
	} else {
		fmt.Printf("No website found at %s (use -site); serving the API only.\n", abs)
	}
	if _, _, err := loadKey(s.keyFile); err != nil {
		fmt.Printf("\nWARNING: %v\nDesigns will fail until a key is in place.\n\n", err)
	}
	host := addr
	if strings.HasPrefix(host, ":") {
		host = "localhost" + host
	}
	fmt.Printf("TerraSim is running: open http://%s\n", host)
	return http.ListenAndServe(addr, s.handler(siteDir))
}

// handler is shared by the running server and HTTP integration tests.
func (s *server) handler(siteDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("POST /api/designs", s.create)
	mux.HandleFunc("GET /api/coverage", s.coverage)
	mux.HandleFunc("POST /api/fit", s.fit)
	// One route for jobs/{id}, {id}, {id}/estimate and {id}/report (Go's router can't tell
	// "jobs/{id}" from "{id}/estimate" apart on its own).
	mux.HandleFunc("GET /api/designs/{rest...}", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.PathValue("rest"), "/"), "/")
		switch {
		case len(parts) == 2 && parts[0] == "jobs":
			since, _ := strconv.Atoi(r.URL.Query().Get("since"))
			s.jobStatus(w, parts[1], since)
		case len(parts) == 1:
			s.part(w, parts[0], "design")
		case len(parts) == 2 && (parts[1] == "estimate" || parts[1] == "report"):
			s.part(w, parts[0], parts[1])
		default:
			writeJSON(w, 404, map[string]string{"message": "Not found."})
		}
	})
	mux.HandleFunc("POST /api/designs/jobs/{id}/cancel", s.cancelJob)
	mux.HandleFunc("POST /api/designs/edit", s.editDesign)
	mux.HandleFunc("GET /api/listings", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, []any{}) })
	mux.HandleFunc("OPTIONS /api/", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })

	if fileExists(filepath.Join(siteDir, "index.html")) {
		mux.Handle("/", noCache(http.FileServer(http.Dir(siteDir))))
	}
	return cors(mux)
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	_, _, err := loadKey(s.keyFile)
	if s.fake {
		writeJSON(w, 200, map[string]any{"ok": true, "service": "housecost", "model": "stand-in (-fake)", "key": true, "fake": true})
		return
	}
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
	j := newJob()
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
func (s *server) run(j *job, raw []byte, edit ...EditRequest) {
	// A design cancelled while it waited in the queue never starts.
	if j.ctx.Err() != nil {
		return
	}
	j.set(func(j *job) { j.Status, j.Message, j.Started = "running", "Starting the design.", time.Now() })
	fail := func(msg string) {
		if j.ctx.Err() != nil {
			s.markCancelled(j)
			return
		}
		j.finish(false)
		j.set(func(j *job) { j.Status, j.Error, j.Partial = "failed", msg, "" })
		fmt.Printf("[%s] failed: %s\n", j.ID, msg)
	}
	defer func() {
		if r := recover(); r != nil {
			fail(fmt.Sprintf("The design service hit an internal error (%v).", r))
		}
	}()
	log := &jobLog{j: j}
	deps, err := s.deps(j.ctx, log, raw)
	if err != nil {
		fail(err.Error())
		return
	}
	if len(edit) > 0 {
		// The change becomes a new brief first; then the design is made from it as usual.
		r, err := EditRequestFor(edit[0], deps.Ask, func(line string) { fmt.Fprintln(log, line) })
		if err != nil {
			fail(err.Error())
			return
		}
		if probs := ValidateRequest(r); len(probs) > 0 {
			fail("The changed brief can't be designed: " + strings.Join(probs, " "))
			return
		}
		raw, _ = json.Marshal(r)
		j.set(func(j *job) { j.Request = raw })
	}
	res, runErr := RunRequest(raw, deps)
	if j.ctx.Err() != nil {
		s.markCancelled(j)
		return
	}
	if res == nil || res.Design == nil {
		msg := "The design service couldn't design this site."
		if res != nil && len(res.Report.Problems) > 0 {
			msg = strings.Join(res.Report.Problems, " ")
		} else if runErr != nil {
			msg = runErr.Error()
		}
		s.advise(j, raw, msg, deps)
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
	j.finish(true)
	j.set(func(j *job) { j.Status, j.DesignID, j.Message, j.Partial = "done", id, "Design ready.", "" })
	fmt.Printf("[%s] done: %s\n", j.ID, id)
}

// advise asks Gemma what to change after a failed design. It's skipped when the user cancelled
// and when Gemma itself can't be reached (the website explains those without it).
func (s *server) advise(j *job, raw []byte, failure string, deps Deps) {
	if deps.Advise == nil || j.ctx.Err() != nil {
		return
	}
	low := strings.ToLower(failure)
	if strings.Contains(low, "api key") || strings.Contains(low, "http 4") || strings.Contains(low, "http 5") {
		return
	}
	var r Request
	if json.Unmarshal(raw, &r) != nil {
		return
	}
	j.mu.Lock()
	var tail []string
	for _, l := range j.Log[max(0, len(j.Log)-12):] {
		tail = append(tail, l.Text)
	}
	j.mu.Unlock()
	fmt.Fprintln(deps.Log, "Gemma: recommendation (what to change)")
	j.set(func(j *job) { j.Message = "Working out what to change…" })
	a, err := AdviseFailure(r, failure, tail, deps.Advise)
	if err != nil {
		fmt.Fprintf(deps.Log, "  no recommendation (%s)\n", truncate(err.Error(), 120))
		return
	}
	j.set(func(j *job) { j.Advice = &a })
}

// editDesign queues a redesign from a change the user wrote (edit.go).
func (s *server) editDesign(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	var e EditRequest
	if err != nil || json.Unmarshal(body, &e) != nil {
		writeJSON(w, 400, map[string]string{"message": "The edit isn't valid JSON."})
		return
	}
	if strings.TrimSpace(e.Change) == "" || len([]rune(e.Change)) > 600 {
		writeJSON(w, 422, map[string]string{"message": "Write the change in 1 to 600 characters."})
		return
	}
	var orig Request
	switch {
	case e.Request != nil && len(*e.Request) > 2:
		if err := json.Unmarshal(*e.Request, &orig); err != nil {
			writeJSON(w, 422, map[string]string{"message": "The original request isn't readable."})
			return
		}
	case e.Design != nil && len(e.Design.Site.Outline) >= 3:
		orig = requestFromDesign(e.Design)
	default:
		writeJSON(w, 422, map[string]string{"message": "Send the design to change."})
		return
	}
	raw, _ := json.Marshal(orig)
	j := newJob(true)
	s.mu.Lock()
	s.jobs[j.ID] = j
	s.mu.Unlock()
	select {
	case s.queue <- func() { s.run(j, raw, e) }:
	default:
		writeJSON(w, 429, map[string]string{"message": "The design service is busy. Try again in a few minutes."})
		return
	}
	writeJSON(w, 202, map[string]string{"jobId": j.ID})
}

// cancelJob stops a design the user no longer wants. A queued one is skipped; a running one stops
// at its next step, and any Gemma call in progress is cut off.
func (s *server) cancelJob(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.jobs[r.PathValue("id")]
	s.mu.Unlock()
	if j == nil {
		writeJSON(w, 404, map[string]string{"message": "That design job isn't known (the server may have restarted)."})
		return
	}
	j.mu.Lock()
	st := j.Status
	j.mu.Unlock()
	if st == "done" || st == "failed" {
		writeJSON(w, 409, map[string]string{"status": st, "message": "That design has already finished."})
		return
	}
	j.cancel()
	s.markCancelled(j)
	writeJSON(w, 200, map[string]string{"status": "cancelled"})
}

func (s *server) markCancelled(j *job) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.Status == "cancelled" {
		return
	}
	for _, st := range j.Steps {
		if st.Status == "running" {
			st.Status = "failed"
		}
	}
	j.Status, j.Message, j.Partial = "cancelled", "Cancelled.", ""
	fmt.Printf("[%s] cancelled\n", j.ID)
}

func (s *server) jobStatus(w http.ResponseWriter, id string, since int) {
	s.mu.Lock()
	j := s.jobs[id]
	s.mu.Unlock()
	if j == nil {
		writeJSON(w, 404, map[string]string{"message": "That design job isn't known (the server may have restarted)."})
		return
	}
	writeJSON(w, 200, j.view(since))
}

// part serves one part of a finished result, from memory or from results/<id>.json.
func (s *server) part(w http.ResponseWriter, id, which string) {
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

const coverageMessage = "Outside the US, TerraSim estimates the site: elevation from worldwide maps, soil from SoilGrids, and typical flood, earthquake and price assumptions. The design is labelled estimated."

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
	// Every place can be designed for; outside the US the site data is estimated (world.go).
	if covered(lng, lat) {
		writeJSON(w, 200, map[string]any{"covered": true})
		return
	}
	writeJSON(w, 200, map[string]any{"covered": true, "estimated": true, "message": coverageMessage})
}
