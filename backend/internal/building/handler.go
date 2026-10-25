package building

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"spaceforge/backend/internal/auth"
	"spaceforge/backend/internal/httpx"
)

type Handler struct{ Store Repository }

// Create stores the client's building document and returns its SQL ID.
func (h Handler) Create(w http.ResponseWriter, r *http.Request) {
	owner, ok := currentOwner(w, r)
	if !ok {
		return
	}
	input, ok := decodeInput(w, r)
	if !ok {
		return
	}
	b, err := h.Store.Create(r.Context(), owner, input)
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.Header().Set("Location", "/api/buildings/"+b.ID)
	httpx.JSON(w, http.StatusCreated, b)
}

func (h Handler) List(w http.ResponseWriter, r *http.Request) {
	owner, ok := currentOwner(w, r)
	if !ok {
		return
	}
	limit, offset := 20, 0
	for key, target := range map[string]*int{"limit": &limit, "offset": &offset} {
		values, exists := r.URL.Query()[key]
		if !exists {
			continue
		}
		if len(values) != 1 {
			httpx.Error(w, r, http.StatusBadRequest, "invalid_pagination", "Use one limit and one offset value.")
			return
		}
		n, err := strconv.Atoi(values[0])
		if err != nil || (key == "limit" && (n < 1 || n > 100)) || (key == "offset" && (n < 0 || n > 1000000)) {
			httpx.Error(w, r, http.StatusBadRequest, "invalid_pagination", "Limit must be 1-100 and offset must be 0-1000000.")
			return
		}
		*target = n
	}
	items, err := h.Store.List(r.Context(), owner, limit+1, offset)
	if err != nil {
		writeError(w, r, err)
		return
	}
	var nextOffset *int
	if len(items) > limit {
		items = items[:limit]
		next := offset + limit
		if next <= 1000000 {
			nextOffset = &next
		}
	}
	httpx.JSON(w, http.StatusOK, struct {
		Items      []Summary `json:"items"`
		NextOffset *int      `json:"next_offset"`
	}{Items: items, NextOffset: nextOffset})
}

// Get returns the complete document for the frontend's validated renderer.
func (h Handler) Get(w http.ResponseWriter, r *http.Request) {
	owner, id, ok := ownerAndID(w, r)
	if !ok {
		return
	}
	b, err := h.Store.Get(r.Context(), owner, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, b)
}

// Update replaces both the name and complete renderer JSON object.
func (h Handler) Update(w http.ResponseWriter, r *http.Request) {
	owner, id, ok := ownerAndID(w, r)
	if !ok {
		return
	}
	input, ok := decodeInput(w, r)
	if !ok {
		return
	}
	b, err := h.Store.Update(r.Context(), owner, id, input)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, b)
}

func (h Handler) Delete(w http.ResponseWriter, r *http.Request) {
	owner, id, ok := ownerAndID(w, r)
	if !ok {
		return
	}
	if err := h.Store.Delete(r.Context(), owner, id); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h Handler) AssignProject(w http.ResponseWriter, r *http.Request) {
	owner, id, ok := ownerAndID(w, r)
	if !ok {
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		httpx.Error(w, r, 415, "unsupported_media_type", "Use Content-Type: application/json.")
		return
	}
	var input struct {
		ProjectID string `json:"project_id"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&input) != nil || dec.Decode(new(any)) != io.EOF {
		httpx.Error(w, r, 400, "invalid_project", "Provide a project_id UUID.")
		return
	}
	projectID, err := uuid.Parse(input.ProjectID)
	if err != nil {
		httpx.Error(w, r, 400, "invalid_project", "Provide a project_id UUID.")
		return
	}
	record, err := h.Store.AssignProject(r.Context(), owner, id, projectID.String())
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpx.JSON(w, 200, record)
}

func currentOwner(w http.ResponseWriter, r *http.Request) (string, bool) {
	u, ok := auth.CurrentUser(r.Context())
	if !ok || u.ID == "" {
		httpx.Error(w, r, http.StatusUnauthorized, "unauthorized", "A valid sign-in token is required.")
		return "", false
	}
	return u.ID, true
}

func ownerAndID(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	owner, ok := currentOwner(w, r)
	if !ok {
		return "", "", false
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, r, ErrNotFound)
		return "", "", false
	}
	return owner, id.String(), true
}

func decodeInput(w http.ResponseWriter, r *http.Request) (Input, bool) {
	var input Input
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		httpx.Error(w, r, http.StatusUnsupportedMediaType, "unsupported_media_type", "Use Content-Type: application/json.")
		return input, false
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "invalid_building", "Provide a JSON object containing name, data and optionally project_id.")
		return input, false
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		httpx.Error(w, r, http.StatusBadRequest, "invalid_building", "Provide one JSON object per request.")
		return input, false
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.ProjectID != nil {
		id, err := uuid.Parse(*input.ProjectID)
		if err != nil {
			httpx.Error(w, r, 400, "invalid_project", "Project ID must be a UUID.")
			return input, false
		}
		*input.ProjectID = id.String()
	}
	input.Data = bytes.TrimSpace(input.Data)
	if utf8.RuneCountInString(input.Name) < 1 || utf8.RuneCountInString(input.Name) > 120 || strings.ContainsRune(input.Name, '\x00') || len(input.Data) == 0 || input.Data[0] != '{' || !utf8.Valid(input.Data) {
		httpx.Error(w, r, http.StatusBadRequest, "invalid_building", "Name must be 1-120 characters and data must be a JSON object.")
		return input, false
	}
	// Scene-specific validation belongs to the client; this API stores JSON objects.
	return input, true
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.Error(w, r, http.StatusNotFound, "not_found", "Building not found.")
	case errors.Is(err, ErrInvalidData):
		httpx.Error(w, r, http.StatusBadRequest, "invalid_building", "Building data contains unsupported Unicode or numeric values.")
	default:
		httpx.Error(w, r, http.StatusInternalServerError, "storage_error", "Building storage is temporarily unavailable.")
	}
}
