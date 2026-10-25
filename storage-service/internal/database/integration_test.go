package database_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"spaceforge/storage-service/internal/testutil"
	"spaceforge/storage-service/internal/user"
	"spaceforge/storage-service/migrations"
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
	var projectID string
	if err := pool.QueryRow(ctx, `INSERT INTO projects(owner_id,name) VALUES($1,'Schema test') RETURNING id::text`, owner.ID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	for _, input := range []struct{ name, data string }{
		{"", "{}"}, {"  ", "{}"}, {"Array", "[]"}, {"Null", "null"},
	} {
		_, err := pool.Exec(ctx, "INSERT INTO buildings(owner_id,name,data,project_id) VALUES($1,$2,$3::jsonb,$4)", owner.ID, input.name, input.data, projectID)
		constraint(t, err, "23514")
	}
	_, err = pool.Exec(ctx, `INSERT INTO buildings(owner_id,name,data,project_id) VALUES('00000000-0000-0000-0000-000000000000','Missing owner','{}',$1)`, projectID)
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

func TestProjectMigrationPreservesExistingDocuments(t *testing.T) {
	pool := testutil.Database(t)
	ctx := context.Background()
	// Recreate the schema immediately before migration 3 in this isolated test schema.
	_, err := pool.Exec(ctx, `DROP TABLE design_tasks;
 ALTER TABLE buildings DROP COLUMN project_id;
 ALTER TABLE buildings DROP CONSTRAINT buildings_id_owner_unique;
 DROP TABLE projects;
 DELETE FROM schema_migrations WHERE version='000003_projects_and_design_tasks.sql';`)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := (&user.Store{Pool: pool}).SyncIdentity(ctx, user.Identity{Subject: "existing-owner"})
	if err != nil {
		t.Fatal(err)
	}
	var id, original string
	err = pool.QueryRow(ctx, `INSERT INTO buildings(owner_id,name,data) VALUES($1,'Existing house','{"site":{"ring":[[0,0],[1,0],[1,1]]},"large":9007199254740993}') RETURNING id::text,data::text`, owner.ID).Scan(&id, &original)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrations.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var document, projectID, land string
	err = pool.QueryRow(ctx, `SELECT b.data::text,p.id::text,p.land::text FROM buildings b JOIN projects p ON p.id=b.project_id AND p.owner_id=b.owner_id WHERE b.id=$1 AND b.owner_id=$2`, id, owner.ID).Scan(&document, &projectID, &land)
	if err != nil {
		t.Fatal(err)
	}
	if document != original || projectID != id || !strings.Contains(land, "ring") {
		t.Fatal("migration changed a document, lost its identity, or failed to preserve land")
	}
	if err := migrations.Up(ctx, pool); err != nil {
		t.Fatal("migration is not repeatable:", err)
	}
}
