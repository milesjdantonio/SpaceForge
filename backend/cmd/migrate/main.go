package main

import (
	"context"
	"log"
	"os"
	"time"

	"spaceforge/backend/internal/database"
	"spaceforge/backend/migrations"
)

func main() {
	if os.Getenv("DATABASE_URL") == "" {
		log.Fatal("DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool, err := database.Open(ctx, os.Getenv("DATABASE_URL"), 1)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := migrations.Up(ctx, pool); err != nil {
		log.Fatal(err)
	}
	log.Print("database migrations applied")
}
