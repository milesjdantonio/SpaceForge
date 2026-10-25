package building

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ Pool *pgxpool.Pool }

func (s *Store) Create(ctx context.Context, ownerID string, input Input) (Building, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Building{}, err
	}
	defer tx.Rollback(context.Background())
	var projectID string
	if input.ProjectID == nil {
		err = tx.QueryRow(ctx, `INSERT INTO projects(owner_id,name,land) VALUES($1,$2,
		CASE WHEN jsonb_typeof($3::jsonb->'site')='object' THEN $3::jsonb->'site' ELSE '{}'::jsonb END) RETURNING id::text`, ownerID, input.Name, input.Data).Scan(&projectID)
	} else {
		err = tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND owner_id=$2 FOR KEY SHARE`, *input.ProjectID, ownerID).Scan(&projectID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Building{}, ErrNotFound
	}
	if err != nil {
		return Building{}, dataError(err)
	}
	b, err := scan(tx.QueryRow(ctx, `INSERT INTO buildings(owner_id, project_id, name, data)
		VALUES ($1, $2, $3, $4) RETURNING id::text, name, data, created_at, updated_at, project_id::text`, ownerID, projectID, input.Name, input.Data))
	if err != nil {
		return b, err
	}
	return b, tx.Commit(ctx)
}

func (s *Store) List(ctx context.Context, ownerID string, limit, offset int) ([]Summary, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id::text, name, created_at, updated_at, project_id::text
		FROM buildings WHERE owner_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, ownerID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Summary, 0)
	for rows.Next() {
		var b Summary
		if err := rows.Scan(&b.ID, &b.Name, &b.CreatedAt, &b.UpdatedAt, &b.ProjectID); err != nil {
			return nil, err
		}
		items = append(items, b)
	}
	return items, rows.Err()
}

func (s *Store) Get(ctx context.Context, ownerID, id string) (Building, error) {
	return scan(s.Pool.QueryRow(ctx, `SELECT id::text, name, data, created_at, updated_at, project_id::text
		FROM buildings WHERE id=$1 AND owner_id=$2`, id, ownerID))
}

func (s *Store) Update(ctx context.Context, ownerID, id string, input Input) (Building, error) {
	return scan(s.Pool.QueryRow(ctx, `UPDATE buildings SET name=$3, data=$4, project_id=COALESCE($5::uuid,project_id)
		WHERE id=$1 AND owner_id=$2 AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM projects WHERE id=$5 AND owner_id=$2))
		RETURNING id::text, name, data, created_at, updated_at, project_id::text`, id, ownerID, input.Name, input.Data, input.ProjectID))
}

func (s *Store) Delete(ctx context.Context, ownerID, id string) error {
	result, err := s.Pool.Exec(ctx, "DELETE FROM buildings WHERE id=$1 AND owner_id=$2", id, ownerID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// AssignProject changes only membership, so it cannot overwrite a concurrent placement save.
func (s *Store) AssignProject(ctx context.Context, ownerID, id, projectID string) (Building, error) {
	return scan(s.Pool.QueryRow(ctx, `UPDATE buildings SET project_id=$3
	WHERE id=$1 AND owner_id=$2 AND EXISTS(SELECT 1 FROM projects WHERE id=$3 AND owner_id=$2)
	RETURNING id::text,name,data,created_at,updated_at,project_id::text`, id, ownerID, projectID))
}

func scan(row pgx.Row) (Building, error) {
	var b Building
	err := row.Scan(&b.ID, &b.Name, &b.Data, &b.CreatedAt, &b.UpdatedAt, &b.ProjectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, ErrNotFound
	}
	return b, dataError(err)
}

func dataError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// JSON permits representations PostgreSQL JSONB cannot store, including
		// escaped null characters, invalid Unicode, and out-of-range numbers.
		switch pgErr.Code {
		case "22P02", "22P05", "22021", "22003":
			return ErrInvalidData
		}
	}
	return err
}
