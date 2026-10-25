package database

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Open(ctx context.Context, connectionString string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(connectionString)
	if err != nil {
		return nil, errors.New("invalid DATABASE_URL")
	}
	cfg.MaxConns = maxConns
	cfg.MinConns = 0
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "10000"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, errors.New("cannot configure database pool")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("database unavailable")
	}
	return pool, nil
}
