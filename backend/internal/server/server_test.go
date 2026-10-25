package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"spaceforge/backend/internal/auth"
	"spaceforge/backend/internal/user"
)

type pingFunc func(context.Context) error

func (f pingFunc) Ping(ctx context.Context) error { return f(ctx) }

type validVerifier struct{}

func (validVerifier) Verify(context.Context, string) (user.Identity, error) {
	return user.Identity{Subject: "alice"}, nil
}

type users struct{}

func (users) SyncIdentity(context.Context, user.Identity) (user.User, error) {
	return user.User{ID: "alice"}, nil
}

func handler(dbError error) http.Handler {
	return New(slog.New(slog.NewTextHandler(io.Discard, nil)), pingFunc(func(context.Context) error { return dbError }), validVerifier{}, users{}, nil, []string{"http://localhost:5173"})
}

func TestHealthReadinessAndMe(t *testing.T) {
	for _, tt := range []struct {
		path, token string
		dbError     error
		status      int
	}{
		{"/healthz", "", errors.New("offline"), 200},
		{"/readyz", "", errors.New("offline"), 503},
		{"/readyz", "", nil, 200},
		{"/api/me", "", nil, 401},
		{"/api/me", "Bearer valid", nil, 200},
		{"/api/unknown", "", nil, 404},
	} {
		t.Run(tt.path+tt.token, func(t *testing.T) {
			r := httptest.NewRequest("GET", tt.path, nil)
			if tt.token != "" {
				r.Header.Set("Authorization", tt.token)
			}
			r.Header.Set("X-Request-ID", "untrusted-client-input")
			w := httptest.NewRecorder()
			handler(tt.dbError).ServeHTTP(w, r)
			if w.Code != tt.status {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
			if id := w.Header().Get("X-Request-ID"); id == "" || id == "untrusted-client-input" {
				t.Fatal("missing server-generated request ID")
			}
			if !json.Valid(w.Body.Bytes()) {
				t.Fatal("response is not JSON")
			}
		})
	}
}

func TestCORSAndBodyLimits(t *testing.T) {
	for _, tt := range []struct {
		name, method, origin, requestedMethod string
		body                                  io.Reader
		size                                  int64
		status                                int
	}{
		{"allowed origin", "GET", "http://localhost:5173", "", nil, 0, 200},
		{"rejected origin", "GET", "https://attacker.example", "", nil, 0, 403},
		{"allowed preflight", "OPTIONS", "http://localhost:5173", "GET", nil, 0, 204},
		{"rejected preflight method", "OPTIONS", "http://localhost:5173", "PATCH", nil, 0, 403},
		{"method mismatch", "POST", "", "", nil, 0, 405},
		{"known large body", "GET", "", "", strings.NewReader(strings.Repeat("x", maxBodyBytes+1)), maxBodyBytes + 1, 413},
		{"chunked large body", "GET", "", "", strings.NewReader(strings.Repeat("x", maxBodyBytes+1)), -1, 413},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(tt.method, "/healthz", tt.body)
			r.ContentLength = tt.size
			r.Header.Set("Origin", tt.origin)
			if tt.requestedMethod != "" {
				r.Header.Set("Access-Control-Request-Method", tt.requestedMethod)
				r.Header.Set("Access-Control-Request-Headers", "authorization")
			}
			w := httptest.NewRecorder()
			handler(nil).ServeHTTP(w, r)
			if w.Code != tt.status {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
			if tt.status < 400 && tt.origin != "" && w.Header().Get("Access-Control-Allow-Origin") != tt.origin {
				t.Fatal("missing exact CORS origin")
			}
		})
	}
}

func TestRecoveryAndLogsDoNotExposeSecrets(t *testing.T) {
	var logs bytes.Buffer
	h := observe(slog.New(slog.NewJSONHandler(&logs, nil)), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("private-provider-secret")
	}))
	r := httptest.NewRequest("GET", "/private-path?token=private-query-secret", nil)
	r.Header.Set("Authorization", "Bearer private-header-secret")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 500 {
		t.Fatalf("status %d", w.Code)
	}
	for _, secret := range []string{"private-provider-secret", "private-query-secret", "private-header-secret", "/private-path"} {
		if strings.Contains(logs.String(), secret) || strings.Contains(w.Body.String(), secret) {
			t.Fatalf("leaked %s", secret)
		}
	}
}

var _ auth.UserStore = users{}
