package server

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"spaceforge/storage-service/internal/auth"
	"spaceforge/storage-service/internal/building"
	"spaceforge/storage-service/internal/httpx"
)

type Pinger interface{ Ping(context.Context) error }

func New(log *slog.Logger, db Pinger, verifier auth.Verifier, users auth.UserStore, buildings building.Repository, origins []string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := db.Ping(ctx); err != nil {
			httpx.Error(w, r, http.StatusServiceUnavailable, "not_ready", "Database is not ready.")
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	// The frontend storage client attaches Firebase ID tokens to these routes.
	requireUser := auth.RequireUser(verifier, users)
	mux.Handle("GET /api/me", requireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, _ := auth.CurrentUser(r.Context())
		httpx.JSON(w, http.StatusOK, u)
	})))
	buildingHandler := building.Handler{Store: buildings}
	mux.Handle("POST /api/buildings", requireUser(http.HandlerFunc(buildingHandler.Create)))
	mux.Handle("GET /api/buildings", requireUser(http.HandlerFunc(buildingHandler.List)))
	mux.Handle("GET /api/buildings/{id}", requireUser(http.HandlerFunc(buildingHandler.Get)))
	mux.Handle("PUT /api/buildings/{id}", requireUser(http.HandlerFunc(buildingHandler.Update)))
	mux.Handle("DELETE /api/buildings/{id}", requireUser(http.HandlerFunc(buildingHandler.Delete)))
	// Centralize JSON 404/405 responses while allowing ServeMux to resolve routes.
	routes := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pattern := mux.Handler(r)
		if pattern == "" {
			allowed := make([]string, 0)
			probe := r.Clone(r.Context())
			for _, method := range []string{"GET", "HEAD", "POST", "PUT", "DELETE"} {
				probe.Method = method
				if _, candidate := mux.Handler(probe); candidate != "" {
					allowed = append(allowed, method)
				}
			}
			if len(allowed) > 0 {
				w.Header().Set("Allow", strings.Join(allowed, ", "))
				httpx.Error(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "This HTTP method is not supported.")
			} else {
				httpx.Error(w, r, http.StatusNotFound, "not_found", "Resource not found.")
			}
			return
		}
		mux.ServeHTTP(w, r)
	})
	return observe(log, cors(origins, limitBody(routes)))
}
