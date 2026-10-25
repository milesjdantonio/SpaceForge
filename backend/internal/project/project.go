// Package project owns private groups of buildings and their shared land document.
package project

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"spaceforge/backend/internal/auth"
	"spaceforge/backend/internal/httpx"
)

type Project struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Land json.RawMessage `json:"land"`
}
type Handler struct{ Pool *pgxpool.Pool }

func (h Handler) Register(mux *http.ServeMux, require func(http.Handler) http.Handler) {
	mux.Handle("POST /api/projects", require(http.HandlerFunc(h.write)))
	mux.Handle("PUT /api/projects/{id}", require(http.HandlerFunc(h.write)))
	mux.Handle("GET /api/projects", require(http.HandlerFunc(h.list)))
	mux.Handle("GET /api/projects/{id}", require(http.HandlerFunc(h.get)))
	mux.Handle("DELETE /api/projects/{id}", require(http.HandlerFunc(h.remove)))
}

func (h Handler) write(w http.ResponseWriter, r *http.Request) {
	if media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || media != "application/json" {
		httpx.Error(w, r, 415, "unsupported_media_type", "Use Content-Type: application/json.")
		return
	}
	var input struct {
		Name string          `json:"name"`
		Land json.RawMessage `json:"land"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&input) != nil || dec.Decode(new(any)) != io.EOF {
		httpx.Error(w, r, 400, "invalid_project", "Provide one project name and land object.")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if len(input.Land) == 0 {
		input.Land = json.RawMessage(`{}`)
	}
	var land map[string]json.RawMessage
	if utf8.RuneCountInString(input.Name) < 1 || utf8.RuneCountInString(input.Name) > 120 || strings.ContainsRune(input.Name, '\x00') || json.Unmarshal(input.Land, &land) != nil || land == nil {
		httpx.Error(w, r, 400, "invalid_project", "Name must be 1-120 characters and land must be an object.")
		return
	}
	owner, _ := auth.CurrentUser(r.Context())
	var p Project
	var row pgx.Row
	status := http.StatusCreated
	if r.Method == "POST" {
		row = h.Pool.QueryRow(r.Context(), `INSERT INTO projects(owner_id,name,land) VALUES($1,$2,$3) RETURNING id::text,name,land`, owner.ID, input.Name, input.Land)
	} else {
		if _, err := uuid.Parse(r.PathValue("id")); err != nil {
			projectError(w, r, pgx.ErrNoRows)
			return
		}
		row = h.Pool.QueryRow(r.Context(), `UPDATE projects SET name=$3,land=$4 WHERE id=$1 AND owner_id=$2 RETURNING id::text,name,land`, r.PathValue("id"), owner.ID, input.Name, input.Land)
		status = http.StatusOK
	}
	if err := row.Scan(&p.ID, &p.Name, &p.Land); err != nil {
		projectError(w, r, err)
		return
	}
	if status == 201 {
		w.Header().Set("Location", "/api/projects/"+p.ID)
	}
	httpx.JSON(w, status, p)
}
func (h Handler) list(w http.ResponseWriter, r *http.Request) {
	owner, _ := auth.CurrentUser(r.Context())
	offset, err := strconv.Atoi(r.URL.Query().Get("offset"))
	if r.URL.Query().Get("offset") == "" {
		offset = 0
		err = nil
	}
	if err != nil || offset < 0 || offset > 1000000 {
		httpx.Error(w, r, 400, "invalid_pagination", "Use a valid offset.")
		return
	}
	rows, err := h.Pool.Query(r.Context(), `SELECT id::text,name,land FROM projects WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET $2`, owner.ID, offset)
	if err != nil {
		projectError(w, r, err)
		return
	}
	defer rows.Close()
	items := []Project{}
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Land); err != nil {
			projectError(w, r, err)
			return
		}
		items = append(items, p)
	}
	if err := rows.Err(); err != nil {
		projectError(w, r, err)
		return
	}
	var next *int
	if len(items) > 20 {
		items = items[:20]
		n := offset + 20
		next = &n
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "next_offset": next})
}
func (h Handler) get(w http.ResponseWriter, r *http.Request) {
	owner, _ := auth.CurrentUser(r.Context())
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		projectError(w, r, pgx.ErrNoRows)
		return
	}
	var p Project
	if err := h.Pool.QueryRow(r.Context(), `SELECT id::text,name,land FROM projects WHERE id=$1 AND owner_id=$2`, id, owner.ID).Scan(&p.ID, &p.Name, &p.Land); err != nil {
		projectError(w, r, err)
		return
	}
	rows, err := h.Pool.Query(r.Context(), `SELECT id::text,name FROM buildings WHERE project_id=$1 AND owner_id=$2 ORDER BY created_at,id`, id, owner.ID)
	if err != nil {
		projectError(w, r, err)
		return
	}
	defer rows.Close()
	items := []map[string]string{}
	for rows.Next() {
		var bid, name string
		if err := rows.Scan(&bid, &name); err != nil {
			projectError(w, r, err)
			return
		}
		items = append(items, map[string]string{"id": bid, "name": name})
	}
	if err := rows.Err(); err != nil {
		projectError(w, r, err)
		return
	}
	httpx.JSON(w, 200, struct {
		Project
		Buildings []map[string]string `json:"buildings"`
	}{p, items})
}
func (h Handler) remove(w http.ResponseWriter, r *http.Request) {
	owner, _ := auth.CurrentUser(r.Context())
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		projectError(w, r, pgx.ErrNoRows)
		return
	}
	result, err := h.Pool.Exec(r.Context(), `DELETE FROM projects WHERE id=$1 AND owner_id=$2`, id, owner.ID)
	if err != nil {
		projectError(w, r, err)
		return
	}
	if result.RowsAffected() == 0 {
		projectError(w, r, pgx.ErrNoRows)
		return
	}
	w.WriteHeader(204)
}
func projectError(w http.ResponseWriter, r *http.Request, err error) {
	var pe *pgconn.PgError
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, r, 404, "not_found", "Project not found.")
	case errors.As(err, &pe) && pe.Code == "23503":
		httpx.Error(w, r, 409, "project_in_use", "Remove or move the project's buildings and jobs before deleting it.")
	case errors.As(err, &pe) && (pe.Code == "22P02" || pe.Code == "22P05" || pe.Code == "22021" || pe.Code == "22003"):
		httpx.Error(w, r, 400, "invalid_project", "Project land cannot be stored as JSON.")
	default:
		httpx.Error(w, r, 500, "storage_error", "Project storage is temporarily unavailable.")
	}
}
