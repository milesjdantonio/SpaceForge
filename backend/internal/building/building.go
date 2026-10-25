package building

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrNotFound    = errors.New("building not found")
	ErrInvalidData = errors.New("building data cannot be stored as JSON")
)

type Input struct {
	Name string `json:"name"`
	// The web client stores design, estimate, site and placement together here.
	Data json.RawMessage `json:"data"`
}

type Building struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Data      json.RawMessage `json:"data"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

type Summary struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Every operation is scoped to an authenticated user's local database ID.
type Repository interface {
	Create(context.Context, string, Input) (Building, error)
	List(context.Context, string, int, int) ([]Summary, error)
	Get(context.Context, string, string) (Building, error)
	Update(context.Context, string, string, Input) (Building, error)
	Delete(context.Context, string, string) error
}
