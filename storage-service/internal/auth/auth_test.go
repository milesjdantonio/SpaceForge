package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"spaceforge/storage-service/internal/user"
)

type verifierFunc func(context.Context, string) (user.Identity, error)

func (f verifierFunc) Verify(ctx context.Context, token string) (user.Identity, error) {
	return f(ctx, token)
}

type storeFunc func(context.Context, user.Identity) (user.User, error)

func (f storeFunc) SyncIdentity(ctx context.Context, identity user.Identity) (user.User, error) {
	return f(ctx, identity)
}

func TestAuthenticationFailures(t *testing.T) {
	tests := []struct {
		name        string
		headers     []string
		verifyError error
		storeError  error
		status      int
	}{
		{"missing token", nil, nil, nil, 401},
		{"wrong scheme", []string{"Basic abc"}, nil, nil, 401},
		{"missing bearer", []string{"Bearer"}, nil, nil, 401},
		{"duplicate headers", []string{"Bearer one", "Bearer two"}, nil, nil, 401},
		{"invalid token", []string{"Bearer invalid"}, ErrInvalidToken, nil, 401},
		{"provider unavailable", []string{"Bearer token"}, ErrUnavailable, nil, 503},
		{"database unavailable", []string{"Bearer token"}, nil, errors.New("private database details"), 503},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			storeCalled := false
			h := RequireUser(verifierFunc(func(context.Context, string) (user.Identity, error) {
				return user.Identity{Subject: "alice"}, tt.verifyError
			}), storeFunc(func(context.Context, user.Identity) (user.User, error) {
				storeCalled = true
				return user.User{ID: "alice"}, tt.storeError
			}))(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("unauthorized request reached handler") }))
			r := httptest.NewRequest("GET", "/api/me", nil)
			for _, value := range tt.headers {
				r.Header.Add("Authorization", value)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tt.status {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
			if tt.status == 401 && storeCalled {
				t.Fatal("invalid authentication touched user store")
			}
		})
	}
}
