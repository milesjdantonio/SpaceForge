package auth

import (
	"context"
	"errors"

	firebase "firebase.google.com/go/v4"
	firebaseauth "firebase.google.com/go/v4/auth"

	"spaceforge/backend/internal/user"
)

var (
	ErrInvalidToken = errors.New("invalid authentication token")
	ErrUnavailable  = errors.New("authentication provider unavailable")
)

type Verifier interface {
	Verify(context.Context, string) (user.Identity, error)
}

type Firebase struct{ client *firebaseauth.Client }

// NewFirebase must be called after config.Load has validated emulator restrictions.
func NewFirebase(ctx context.Context, projectID string) (*Firebase, error) {
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectID})
	if err != nil {
		return nil, errors.New("cannot initialize Firebase application")
	}
	client, err := app.Auth(ctx)
	if err != nil {
		return nil, errors.New("cannot initialize Firebase authentication; check project and application default credentials")
	}
	return &Firebase{client: client}, nil
}

func (f *Firebase) Verify(ctx context.Context, raw string) (user.Identity, error) {
	token, err := f.client.VerifyIDTokenAndCheckRevoked(ctx, raw)
	if err != nil {
		if firebaseauth.IsIDTokenInvalid(err) || firebaseauth.IsIDTokenExpired(err) ||
			firebaseauth.IsIDTokenRevoked(err) || firebaseauth.IsUserDisabled(err) ||
			firebaseauth.IsUserNotFound(err) || firebaseauth.IsTenantIDMismatch(err) {
			return user.Identity{}, ErrInvalidToken
		}
		return user.Identity{}, ErrUnavailable
	}
	// This application maps a single project's default tenant by UID. Tenant-aware
	// identity keys must be designed before enabling Identity Platform multi-tenancy.
	if token.Firebase.Tenant != "" {
		return user.Identity{}, ErrInvalidToken
	}
	email, _ := token.Claims["email"].(string)
	verified, _ := token.Claims["email_verified"].(bool)
	name, _ := token.Claims["name"].(string)
	return user.Identity{Subject: token.UID, Email: email, EmailVerified: verified, DisplayName: name}, nil
}
