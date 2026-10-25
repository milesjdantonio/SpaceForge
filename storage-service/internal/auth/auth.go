package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"spaceforge/storage-service/internal/httpx"
	"spaceforge/storage-service/internal/user"
)

type userKey struct{}

type UserStore interface {
	SyncIdentity(context.Context, user.Identity) (user.User, error)
}

func CurrentUser(ctx context.Context) (user.User, bool) {
	u, ok := ctx.Value(userKey{}).(user.User)
	return u, ok
}

func RequireUser(verifier Verifier, users UserStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			values := r.Header.Values("Authorization")
			if len(values) != 1 {
				unauthorized(w, r)
				return
			}
			parts := strings.Fields(values[0])
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || len(parts[1]) > 16384 {
				unauthorized(w, r)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			identity, err := verifier.Verify(ctx, parts[1])
			if errors.Is(err, ErrInvalidToken) {
				unauthorized(w, r)
				return
			}
			if err != nil {
				httpx.Error(w, r, http.StatusServiceUnavailable, "auth_unavailable", "Authentication is temporarily unavailable.")
				return
			}
			if identity.Subject == "" || len(identity.Subject) > 128 {
				unauthorized(w, r)
				return
			}
			u, err := users.SyncIdentity(ctx, identity)
			if err != nil {
				httpx.Error(w, r, http.StatusServiceUnavailable, "database_unavailable", "Account information is temporarily unavailable.")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)))
		})
	}
}

func unauthorized(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	httpx.Error(w, r, http.StatusUnauthorized, "unauthorized", "A valid sign-in token is required.")
}
