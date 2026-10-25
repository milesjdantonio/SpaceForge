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
	return scan(s.Pool.QueryRow(ctx, `INSERT INTO buildings(owner_id, name, data)
		VALUES ($1, $2, $3) RETURNING id::text, name, data, created_at, updated_at`, ownerID, input.Name, input.Data))
}

func (s *Store) List(ctx context.Context, ownerID string, limit, offset int) ([]Summary, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id::text, name, created_at, updated_at
		FROM buildings WHERE owner_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, ownerID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Summary, 0)
	for rows.Next() {
		var b Summary
		if err := rows.Scan(&b.ID, &b.Name, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, b)
	}
	return items, rows.Err()
}

func (s *Store) Get(ctx context.Context, ownerID, id string) (Building, error) {
	return scan(s.Pool.QueryRow(ctx, `SELECT id::text, name, data, created_at, updated_at
		FROM buildings WHERE id=$1 AND owner_id=$2`, id, ownerID))
}

func (s *Store) Update(ctx context.Context, ownerID, id string, input Input) (Building, error) {
	return scan(s.Pool.QueryRow(ctx, `UPDATE buildings SET name=$3, data=$4
		WHERE id=$1 AND owner_id=$2 RETURNING id::text, name, data, created_at, updated_at`, id, ownerID, input.Name, input.Data))
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

func scan(row pgx.Row) (Building, error) {
	var b Building
	err := row.Scan(&b.ID, &b.Name, &b.Data, &b.CreatedAt, &b.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// JSON permits representations PostgreSQL JSONB cannot store, including
		// escaped null characters, invalid Unicode, and out-of-range numbers.
		switch pgErr.Code {
		case "22P02", "22P05", "22021", "22003":
			return b, ErrInvalidData
		}
	}
	return b, err
}
