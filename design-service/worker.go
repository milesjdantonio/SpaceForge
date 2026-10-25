package main

// The private generation worker, for when sign-in owns generation: the storage service
// (storage-service/internal/generation) calls POST /internal/generate with a service token, streams
// the progress, and saves the finished building to the signed-in account. It's switched on by
// GENERATION_SERVICE_TOKEN (32 characters or more), shared with the storage service.
//
// The public API in server.go stays: without the storage service (one Render service, local runs),
// the website calls the design service directly and nobody needs to sign in.

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// workerRoutes adds the token-guarded worker routes to mux when the token is set.
func (s *server) workerRoutes(mux *http.ServeMux) {
	if len(s.token) < 32 {
		return
	}
	private := http.NewServeMux()
	private.HandleFunc("POST /internal/generate", s.generate)
	mux.Handle("/internal/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		values := r.Header.Values("Authorization")
		if len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte("Bearer "+s.token)) != 1 {
			writeJSON(w, 401, map[string]string{"message": "Service authorization required."})
			return
		}
		private.ServeHTTP(w, r)
	}))
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
			if result.err != nil || result.result.DesignID() == "" {
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
			var design any = result.result.Design
			if result.result.SiteDesign != nil {
				design = result.result.SiteDesign // a neighborhood or trailer park (sites.go)
			}
			send(map[string]any{"result": map[string]any{"design": design, "estimate": result.result.Estimate}})
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
