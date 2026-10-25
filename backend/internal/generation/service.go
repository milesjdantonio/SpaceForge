// Package generation owns account-authorized, durable design tasks. The design
// service computes results; this package atomically commits them to private storage.
package generation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"spaceforge/backend/internal/auth"
	"spaceforge/backend/internal/building"
	"spaceforge/backend/internal/httpx"
)

type Service struct {
	Pool       *pgxpool.Pool
	URL, Token string
	Workers    int
	Client     *http.Client
}

type Task struct {
	ID         string          `json:"jobId"`
	ProjectID  string          `json:"projectId"`
	Status     string          `json:"status"`
	Progress   json.RawMessage `json:"details"`
	BuildingID *string         `json:"buildingId,omitempty"`
	Error      string          `json:"error,omitempty"`
}

func (s *Service) Register(mux *http.ServeMux, require func(http.Handler) http.Handler) {
	mux.Handle("POST /api/designs", require(http.HandlerFunc(s.create)))
	mux.Handle("GET /api/designs/jobs", require(http.HandlerFunc(s.list)))
	mux.Handle("GET /api/designs/jobs/{id}", require(http.HandlerFunc(s.get)))
	mux.Handle("DELETE /api/designs/jobs/{id}", require(http.HandlerFunc(s.remove)))
	mux.Handle("GET /api/designs/{id}", require(http.HandlerFunc(s.design)))
	mux.Handle("GET /api/designs/{id}/{part}", require(http.HandlerFunc(s.design)))
	// Coverage is provider metadata, but still goes through the trusted API.
	mux.Handle("GET /api/coverage", require(http.HandlerFunc(s.coverage)))
}

func (s *Service) create(w http.ResponseWriter, r *http.Request) {
	if media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || media != "application/json" {
		httpx.Error(w, r, 415, "unsupported_media_type", "Use Content-Type: application/json.")
		return
	}
	if s.URL == "" {
		httpx.Error(w, r, 503, "not_connected", "The design service is not configured.")
		return
	}
	var input struct {
		Request    json.RawMessage `json:"request"`
		Site       json.RawMessage `json:"site"`
		ProjectID  string          `json:"project_id"`
		RequestKey string          `json:"request_key"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&input) != nil || dec.Decode(new(any)) != io.EOF {
		httpx.Error(w, r, 400, "invalid_request", "Provide one design request, site and request key.")
		return
	}
	var request struct {
		Schema string `json:"schema"`
		Site   struct {
			Geometry struct {
				Coordinates [][][]float64 `json:"coordinates"`
			} `json:"geometry"`
		} `json:"site"`
	}
	if json.Unmarshal(input.Request, &request) != nil || request.Schema != "terrasim.design-request/2" || len(request.Site.Geometry.Coordinates) == 0 || len(request.Site.Geometry.Coordinates[0]) < 4 || len(input.RequestKey) < 1 || len(input.RequestKey) > 200 {
		httpx.Error(w, r, 400, "invalid_request", "Provide a version 2 design request with a site polygon and a 1-200 character request key.")
		return
	}
	var site map[string]json.RawMessage
	if len(input.Site) == 0 {
		input.Site = json.RawMessage(`{}`)
	}
	if json.Unmarshal(input.Site, &site) != nil || site == nil {
		httpx.Error(w, r, 400, "invalid_request", "Site must be an object.")
		return
	}
	// The server always preserves a usable land outline, even for non-browser clients.
	ring, _ := json.Marshal(request.Site.Geometry.Coordinates[0][:len(request.Site.Geometry.Coordinates[0])-1])
	site["ring"] = ring
	input.Site, _ = json.Marshal(site)
	if input.ProjectID != "" {
		if _, err := uuid.Parse(input.ProjectID); err != nil {
			httpx.Error(w, r, 400, "invalid_project", "Project ID must be a UUID.")
			return
		}
	}
	// Canonicalize object key ordering while preserving exact JSON numbers.
	canonical := func(raw json.RawMessage) json.RawMessage {
		var v any
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		_ = d.Decode(&v)
		b, _ := json.Marshal(v)
		return b
	}
	snapshot, _ := json.Marshal(map[string]any{"request": canonical(input.Request), "site": canonical(input.Site), "project_id": input.ProjectID})
	sum := sha256.Sum256(snapshot)
	hash := hex.EncodeToString(sum[:])
	owner, _ := auth.CurrentUser(r.Context())
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		taskError(w, r, err)
		return
	}
	defer tx.Rollback(context.Background())
	// Serialize retries for the same account/key before allocating a project.
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner.ID+":"+input.RequestKey); err != nil {
		taskError(w, r, err)
		return
	}
	var id, oldHash string
	err = tx.QueryRow(r.Context(), `SELECT id::text,request_hash FROM design_tasks WHERE owner_id=$1 AND request_key=$2`, owner.ID, input.RequestKey).Scan(&id, &oldHash)
	if err == nil {
		if oldHash != hash {
			httpx.Error(w, r, 409, "request_conflict", "This request key was already used for different input.")
			return
		}
		httpx.JSON(w, 202, map[string]string{"jobId": id})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		taskError(w, r, err)
		return
	}
	if input.ProjectID == "" {
		err = tx.QueryRow(r.Context(), `INSERT INTO projects(owner_id,name,land) VALUES($1,'New build',$2) RETURNING id::text`, owner.ID, input.Site).Scan(&input.ProjectID)
	} else {
		var checked string
		err = tx.QueryRow(r.Context(), `SELECT id::text FROM projects WHERE id=$1 AND owner_id=$2 FOR KEY SHARE`, input.ProjectID, owner.ID).Scan(&checked)
	}
	if err != nil {
		taskError(w, r, err)
		return
	}
	// Site/form is a task snapshot; the project remains the shared land entity.
	payload, _ := json.Marshal(map[string]any{"request": input.Request, "site": input.Site})
	err = tx.QueryRow(r.Context(), `INSERT INTO design_tasks(owner_id,project_id,request_key,request_hash,request) VALUES($1,$2,$3,$4,$5) RETURNING id::text`, owner.ID, input.ProjectID, input.RequestKey, hash, payload).Scan(&id)
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		taskError(w, r, err)
		return
	}
	w.Header().Set("Location", "/api/designs/jobs/"+id)
	httpx.JSON(w, 202, map[string]string{"jobId": id, "projectId": input.ProjectID})
}

func (s *Service) get(w http.ResponseWriter, r *http.Request) {
	owner, _ := auth.CurrentUser(r.Context())
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		taskError(w, r, pgx.ErrNoRows)
		return
	}
	var task Task
	err := s.Pool.QueryRow(r.Context(), `SELECT id::text,project_id::text,status,progress,building_id::text,error FROM design_tasks WHERE id=$1 AND owner_id=$2`, id, owner.ID).Scan(&task.ID, &task.ProjectID, &task.Status, &task.Progress, &task.BuildingID, &task.Error)
	if err != nil {
		taskError(w, r, err)
		return
	}
	result := map[string]any{}
	_ = json.Unmarshal(task.Progress, &result)
	result["jobId"], result["projectId"], result["status"] = task.ID, task.ProjectID, task.Status
	if task.Error != "" {
		result["error"] = task.Error
	}
	if task.BuildingID != nil {
		record, err := (&building.Store{Pool: s.Pool}).Get(r.Context(), owner.ID, *task.BuildingID)
		if err != nil {
			taskError(w, r, err)
			return
		}
		result["building"] = record
	}
	httpx.JSON(w, 200, result)
}
func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	owner, _ := auth.CurrentUser(r.Context())
	rows, err := s.Pool.Query(r.Context(), `SELECT id::text,project_id::text,status,progress,building_id::text,error FROM design_tasks WHERE owner_id=$1 AND (NOT $2 OR status IN ('queued','running')) ORDER BY created_at DESC,id DESC LIMIT 100`, owner.ID, r.URL.Query().Get("active") == "1")
	if err != nil {
		taskError(w, r, err)
		return
	}
	defer rows.Close()
	tasks := []Task{}
	for rows.Next() {
		var t Task
		if err := rows.Scan(&t.ID, &t.ProjectID, &t.Status, &t.Progress, &t.BuildingID, &t.Error); err != nil {
			taskError(w, r, err)
			return
		}
		tasks = append(tasks, t)
	}
	if err := rows.Err(); err != nil {
		taskError(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": tasks})
}

// Removing a running task revokes its lease. A completed building stays private
// storage data until explicitly deleted through the building API.
func (s *Service) remove(w http.ResponseWriter, r *http.Request) {
	owner, _ := auth.CurrentUser(r.Context())
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		taskError(w, r, pgx.ErrNoRows)
		return
	}
	result, err := s.Pool.Exec(r.Context(), `DELETE FROM design_tasks WHERE id=$1 AND owner_id=$2`, id, owner.ID)
	if err != nil {
		taskError(w, r, err)
		return
	}
	if result.RowsAffected() == 0 {
		taskError(w, r, pgx.ErrNoRows)
		return
	}
	w.WriteHeader(204)
}
func (s *Service) design(w http.ResponseWriter, r *http.Request) {
	owner, _ := auth.CurrentUser(r.Context())
	var data json.RawMessage
	err := s.Pool.QueryRow(r.Context(), `SELECT data FROM buildings WHERE owner_id=$1 AND data->'design'->>'id'=$2 ORDER BY created_at DESC LIMIT 1`, owner.ID, r.PathValue("id")).Scan(&data)
	if err != nil {
		taskError(w, r, err)
		return
	}
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(data, &doc)
	part := r.PathValue("part")
	if part == "" {
		part = "design"
	}
	if part != "design" && part != "estimate" {
		taskError(w, r, pgx.ErrNoRows)
		return
	}
	if len(doc[part]) == 0 || string(doc[part]) == "null" {
		taskError(w, r, pgx.ErrNoRows)
		return
	}
	httpx.JSON(w, 200, doc[part])
}
func (s *Service) coverage(w http.ResponseWriter, r *http.Request) {
	if s.URL == "" {
		httpx.Error(w, r, 503, "not_connected", "The design service is not configured.")
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), "GET", strings.TrimRight(s.URL, "/")+"/api/coverage?"+r.URL.RawQuery, nil)
	if err != nil {
		taskError(w, r, err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	res, err := client.Do(req)
	if err != nil {
		httpx.Error(w, r, 503, "provider_unavailable", "Site coverage is temporarily unavailable.")
		return
	}
	defer res.Body.Close()
	var data json.RawMessage
	if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&data) != nil {
		taskError(w, r, errors.New("invalid coverage"))
		return
	}
	httpx.JSON(w, res.StatusCode, data)
}
func taskError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, building.ErrNotFound):
		httpx.Error(w, r, 404, "not_found", "Design job, building or project not found.")
	default:
		httpx.Error(w, r, 500, "storage_error", "Design storage is temporarily unavailable.")
	}
}
