package database_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"spaceforge/backend/internal/testutil"
	"spaceforge/backend/internal/user"
	"spaceforge/backend/migrations"
)

func TestBuildingSchema(t *testing.T) {
	pool := testutil.Database(t)
	ctx := context.Background()
	if err := migrations.Up(ctx, pool); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	owner, err := (&user.Store{Pool: pool}).SyncIdentity(ctx, user.Identity{Subject: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []struct{ name, data string }{
		{"", "{}"}, {"  ", "{}"}, {"Array", "[]"}, {"Null", "null"},
	} {
		_, err := pool.Exec(ctx, "INSERT INTO buildings(owner_id,name,data) VALUES($1,$2,$3::jsonb)", owner.ID, input.name, input.data)
		constraint(t, err, "23514")
	}
	_, err = pool.Exec(ctx, `INSERT INTO buildings(owner_id,name,data) VALUES('00000000-0000-0000-0000-000000000000','Missing owner','{}')`)
	constraint(t, err, "23503")
}

func TestProfileSyncPreservesIdentity(t *testing.T) {
	pool := testutil.Database(t)
	ctx := context.Background()
	store := &user.Store{Pool: pool}
	identity := user.Identity{Subject: "alice", Email: "alice@example.test", DisplayName: "Alice"}
	first, err := store.SyncIdentity(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	identity.DisplayName = "Updated"
	identity.EmailVerified = true
	next, err := store.SyncIdentity(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	if next.ID != first.ID || !next.CreatedAt.Equal(first.CreatedAt) || next.DisplayName != "Updated" || !next.EmailVerified {
		t.Fatalf("profile did not synchronize: %+v", next)
	}
}

func constraint(t *testing.T, err error, code string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != code {
		t.Fatalf("wanted database constraint %s, got %v", code, err)
	}
}
