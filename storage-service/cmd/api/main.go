package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"spaceforge/storage-service/internal/auth"
	"spaceforge/storage-service/internal/building"
	"spaceforge/storage-service/internal/config"
	"spaceforge/storage-service/internal/database"
	"spaceforge/storage-service/internal/server"
	"spaceforge/storage-service/internal/user"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("API stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	pool, err := database.Open(startup, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		return err
	}
	defer pool.Close()
	var schemaReady bool
	if err := pool.QueryRow(startup, "SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.buildings') IS NOT NULL").Scan(&schemaReady); err != nil || !schemaReady {
		return errors.New("database schema is not ready; run cmd/migrate first")
	}
	verifier, err := auth.NewFirebase(startup, cfg.ProjectID)
	if err != nil {
		return err
	}
	if cfg.EmulatorHost != "" {
		log.Warn("local Firebase Auth emulator enabled; development use only")
	}
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.New(log, pool, verifier, &user.Store{Pool: pool}, &building.Store{Pool: pool}, cfg.Origins),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 32 * 1024,
	}
	errorsCh := make(chan error, 1)
	go func() { errorsCh <- srv.ListenAndServe() }()
	log.Info("API listening", "address", cfg.HTTPAddr, "environment", cfg.Environment)
	select {
	case err := <-errorsCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("HTTP listener failed: %w", err)
		}
		return nil
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			_ = srv.Close()
			return errors.New("HTTP shutdown timed out")
		}
		return nil
	}
}
