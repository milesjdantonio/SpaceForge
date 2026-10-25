// Package testutil creates isolated integration-test schemas in a dedicated database.
package testutil

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"spaceforge/backend/migrations"
)

func Database(t *testing.T) *pgxpool.Pool {
	t.Helper()
	connectionString := os.Getenv("TEST_DATABASE_URL")
	if connectionString == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, connectionString)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	// Packages run concurrently against the same test database. IF NOT EXISTS
	// alone does not serialize extension creation and can still race in PostgreSQL.
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(731790103)"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	schema := "spaceforge_test_" + uuid.New().String()
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanup, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	cfg, err := pgxpool.ParseConfig(connectionString)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 5
	cfg.ConnConfig.RuntimeParams["search_path"] = quoted + ", public"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := migrations.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}
