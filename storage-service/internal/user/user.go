package user

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Identity struct {
	Subject       string
	Email         string
	EmailVerified bool
	DisplayName   string
}

type User struct {
	ID            string    `json:"id"`
	AuthSubject   string    `json:"auth_subject"`
	Email         string    `json:"email"`
	EmailVerified bool      `json:"email_verified"`
	DisplayName   string    `json:"display_name"`
	CreatedAt     time.Time `json:"created_at"`
}

type Store struct{ Pool *pgxpool.Pool }

// SyncIdentity synchronizes the profile from the verified Firebase identity.
func (s *Store) SyncIdentity(ctx context.Context, identity Identity) (User, error) {
	var u User
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO users (auth_subject, email, email_verified, display_name)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (auth_subject) DO UPDATE SET
		    email=EXCLUDED.email, email_verified=EXCLUDED.email_verified,
		    display_name=EXCLUDED.display_name
		RETURNING id::text, auth_subject, email, email_verified, display_name, created_at`,
		identity.Subject, identity.Email, identity.EmailVerified, identity.DisplayName,
	).Scan(&u.ID, &u.AuthSubject, &u.Email, &u.EmailVerified, &u.DisplayName, &u.CreatedAt)
	return u, err
}
