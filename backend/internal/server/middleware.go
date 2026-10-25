package server

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"spaceforge/backend/internal/httpx"
)

const maxBodyBytes = 1 << 20

func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > maxBodyBytes {
			httpx.Error(w, r, http.StatusRequestEntityTooLarge, "body_too_large", "Request body exceeds 1 MiB.")
			return
		}
		if r.Body != nil {
			defer r.Body.Close()
			body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
			if len(body) > maxBodyBytes {
				httpx.Error(w, r, http.StatusRequestEntityTooLarge, "body_too_large", "Request body exceeds 1 MiB.")
				return
			}
			if err != nil {
				httpx.Error(w, r, http.StatusBadRequest, "invalid_body", "Cannot read request body.")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		next.ServeHTTP(w, r)
	})
}

func cors(origins []string, next http.Handler) http.Handler {
	allowed := make(map[string]bool, len(origins))
	for _, origin := range origins {
		allowed[origin] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		if origin != "" && !allowed[origin] {
			httpx.Error(w, r, http.StatusForbidden, "origin_not_allowed", "This origin is not allowed.")
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Expose-Headers", "X-Request-ID, Location")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.Header().Add("Vary", "Access-Control-Request-Method")
			w.Header().Add("Vary", "Access-Control-Request-Headers")
			method := r.Header.Get("Access-Control-Request-Method")
			if origin == "" || (method != "GET" && method != "HEAD" && method != "POST" && method != "PUT" && method != "DELETE") {
				httpx.Error(w, r, http.StatusForbidden, "cors_not_allowed", "This cross-origin request is not supported.")
				return
			}
			for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
				switch strings.ToLower(strings.TrimSpace(header)) {
				case "", "authorization", "content-type":
				default:
					httpx.Error(w, r, http.StatusForbidden, "cors_not_allowed", "This request header is not supported.")
					return
				}
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (w *responseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func observe(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		id := uuid.NewString()
		r = r.WithContext(httpx.WithRequestID(r.Context(), id))
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		rw := &responseWriter{ResponseWriter: w}
		defer func() {
			if recover() != nil {
				log.Error("request panicked", "request_id", id)
				if rw.status == 0 {
					httpx.Error(rw, r, http.StatusInternalServerError, "internal_error", "An internal error occurred.")
				}
			}
			status := rw.status
			if status == 0 {
				status = http.StatusOK
			}
			log.Info("request", "request_id", id, "method", r.Method,
				"route", r.Pattern, "status", status, "duration_ms", time.Since(start).Milliseconds())
		}()
		next.ServeHTTP(rw, r)
	})
}
