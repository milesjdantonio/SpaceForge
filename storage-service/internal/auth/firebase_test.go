package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	firebase "firebase.google.com/go/v4"
	"github.com/golang-jwt/jwt/v4"
	"google.golang.org/api/option"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Exercise the real SDK's emulator validation and revocation RPC with fixtures.
// Production signature verification is delegated to the official Admin SDK.
func TestFirebaseEmulatorVerification(t *testing.T) {
	now := time.Now()
	var revoked, disabled, unavailable atomic.Bool
	emulator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unavailable.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if !strings.HasSuffix(r.URL.Path, "accounts:lookup") {
			t.Error("unexpected outbound request in test")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		validSince := "0"
		if revoked.Load() {
			validSince = "9999999999"
		}
		body, _ := json.Marshal(map[string]any{"users": []any{map[string]any{
			"localId": "alice", "validSince": validSince, "disabled": disabled.Load(),
		}}})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	defer emulator.Close()
	t.Setenv("FIREBASE_AUTH_EMULATOR_HOST", strings.TrimPrefix(emulator.URL, "http://"))
	app, err := firebase.NewApp(context.Background(), &firebase.Config{ProjectID: "demo-spaceforge"})
	if err != nil {
		t.Fatal(err)
	}
	admin, err := app.Auth(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	verifier := &Firebase{client: admin}
	for _, name := range []string{"valid", "expired", "wrong issuer", "wrong audience", "other tenant", "revoked", "disabled", "unavailable"} {
		t.Run(name, func(t *testing.T) {
			claims := jwt.MapClaims{
				"iss": "https://securetoken.google.com/demo-spaceforge", "aud": "demo-spaceforge", "sub": "alice",
				"iat": now.Unix() - 300, "exp": now.Unix() + 3600, "auth_time": now.Unix() - 300,
				"email": "alice@example.test", "email_verified": true, "role": "admin",
			}
			if name == "expired" {
				claims["exp"] = now.Unix() - 3600
			}
			if name == "wrong issuer" {
				claims["iss"] = "https://securetoken.google.com/attacker"
			}
			if name == "wrong audience" {
				claims["aud"] = "another-project"
			}
			if name == "other tenant" {
				claims["firebase"] = map[string]any{"tenant": "other-tenant", "sign_in_provider": "password"}
			}
			revoked.Store(name == "revoked")
			disabled.Store(name == "disabled")
			unavailable.Store(name == "unavailable")
			raw, err := jwt.NewWithClaims(jwt.SigningMethodNone, claims).SignedString(jwt.UnsafeAllowNoneSignatureType)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			identity, verifyErr := verifier.Verify(ctx, raw)
			switch name {
			case "valid":
				if verifyErr != nil {
					t.Fatal(verifyErr)
				}
				if identity.Subject != "alice" || !identity.EmailVerified {
					t.Fatalf("identity: %+v", identity)
				}
			case "unavailable":
				if !errors.Is(verifyErr, ErrUnavailable) {
					t.Fatalf("expected unavailable, got %v", verifyErr)
				}
			default:
				if !errors.Is(verifyErr, ErrInvalidToken) {
					t.Fatalf("expected invalid token, got %v", verifyErr)
				}
			}
		})
	}
}

func TestFirebaseProductionRejectsUnsignedTokens(t *testing.T) {
	t.Setenv("FIREBASE_AUTH_EMULATOR_HOST", "")
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Error("unsigned tokens must be rejected before any network lookup")
		return nil, errors.New("network disabled")
	})}
	app, err := firebase.NewApp(context.Background(), &firebase.Config{ProjectID: "spaceforge-test"}, option.WithHTTPClient(client))
	if err != nil {
		t.Fatal(err)
	}
	admin, err := app.Auth(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	raw, err := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{
		"iss": "https://securetoken.google.com/spaceforge-test", "aud": "spaceforge-test",
		"sub": "attacker", "iat": now - 60, "exp": now + 3600, "auth_time": now - 60,
	}).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&Firebase{client: admin}).Verify(context.Background(), raw); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("unsigned production token: %v", err)
	}
}
