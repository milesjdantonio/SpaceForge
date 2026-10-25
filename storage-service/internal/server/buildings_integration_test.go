package server_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"spaceforge/storage-service/internal/building"
	"spaceforge/storage-service/internal/server"
	"spaceforge/storage-service/internal/testutil"
	"spaceforge/storage-service/internal/user"
)

// Only the identity provider is stubbed; routes, authorization, SQL, and JSONB are real.
type identities struct{}

func (identities) Verify(_ context.Context, token string) (user.Identity, error) {
	return user.Identity{Subject: token}, nil
}

func TestBuildingsPersistenceAndIsolation(t *testing.T) {
	pool := testutil.Database(t)
	users := &user.Store{Pool: pool}
	h := server.New(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, identities{}, users, &building.Store{Pool: pool}, []string{"http://localhost:5173"})
	input := `{"name":"  My rendered house  ","data":{"schemaVersion":1,"large":9007199254740993,"rooms":[{"type":"bedroom"}],"camera":{"position":[1,2,3]}}}`
	for _, route := range []struct{ method, path string }{
		{"POST", "/api/buildings"}, {"GET", "/api/buildings"},
		{"GET", "/api/buildings/123"}, {"PUT", "/api/buildings/123"}, {"DELETE", "/api/buildings/123"},
	} {
		expect(t, call(h, "", route.method, route.path, input), 401)
	}
	created := call(h, "alice", "POST", "/api/buildings", input)
	expect(t, created, 201)
	var saved building.Building
	decode(t, created, &saved)
	if saved.ID == "" || saved.Name != "My rendered house" || saved.CreatedAt.IsZero() || created.Header().Get("Location") != "/api/buildings/"+saved.ID {
		t.Fatalf("created building: %+v", saved)
	}
	var scene map[string]json.RawMessage
	if err := json.Unmarshal(saved.Data, &scene); err != nil {
		t.Fatal(err)
	}
	if string(scene["large"]) != "9007199254740993" {
		t.Fatal("JSON number lost precision")
	}
	path := "/api/buildings/" + saved.ID
	loaded := call(h, "alice", "GET", path, "")
	expect(t, loaded, 200)
	var roundTrip building.Building
	decode(t, loaded, &roundTrip)
	if string(saved.Data) != string(roundTrip.Data) {
		t.Fatal("renderer data did not round-trip")
	}

	// A legacy database role must not bypass ownership.
	expect(t, call(h, "bob", "GET", "/api/me", ""), 200)
	if _, err := pool.Exec(context.Background(), "UPDATE users SET role='admin' WHERE auth_subject='bob'"); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		expect(t, call(h, "bob", method, path, `{"name":"stolen","data":{}}`), 404)
	}
	otherList := call(h, "bob", "GET", "/api/buildings", "")
	expect(t, otherList, 200)
	var empty struct {
		Items []building.Summary `json:"items"`
		Next  *int               `json:"next_offset"`
	}
	decode(t, otherList, &empty)
	if empty.Items == nil || len(empty.Items) != 0 || empty.Next != nil {
		t.Fatalf("other user saw buildings: %+v", empty)
	}

	replaced := call(h, "alice", "PUT", path, `{"name":"Updated house","data":{"walls":[1,2],"version":2}}`)
	expect(t, replaced, 200)
	var updated building.Building
	decode(t, replaced, &updated)
	if updated.ID != saved.ID || !updated.CreatedAt.Equal(saved.CreatedAt) || !updated.UpdatedAt.After(saved.UpdatedAt) || updated.Name != "Updated house" {
		t.Fatalf("update metadata: %+v", updated)
	}
	if strings.Contains(string(updated.Data), "camera") {
		t.Fatal("PUT merged instead of replacing data")
	}

	expect(t, call(h, "alice", "POST", "/api/buildings", `{"name":"Second house","data":{}}`), 201)
	listed := call(h, "alice", "GET", "/api/buildings?limit=1", "")
	expect(t, listed, 200)
	var page struct {
		Items []map[string]json.RawMessage `json:"items"`
		Next  *int                         `json:"next_offset"`
	}
	decode(t, listed, &page)
	if len(page.Items) != 1 || page.Next == nil || *page.Next != 1 || page.Items[0]["data"] != nil {
		t.Fatalf("pagination response: %s", listed.Body)
	}
	secondPage := call(h, "alice", "GET", "/api/buildings?limit=1&offset=1", "")
	expect(t, secondPage, 200)
	var nextPage struct {
		Items []building.Summary `json:"items"`
		Next  *int               `json:"next_offset"`
	}
	decode(t, secondPage, &nextPage)
	if len(nextPage.Items) != 1 || nextPage.Items[0].ID != saved.ID || nextPage.Next != nil {
		t.Fatalf("second page: %s", secondPage.Body)
	}
	for _, query := range []string{"limit=0", "limit=101", "offset=-1", "offset=1000001", "limit=1&limit=2", "limit=banana"} {
		expect(t, call(h, "alice", "GET", "/api/buildings?"+query, ""), 400)
	}
	for _, data := range []string{`{"text":"\u0000"}`, `{"number":1e1000000}`} {
		expect(t, call(h, "alice", "POST", "/api/buildings", `{"name":"bad JSONB","data":`+data+`}`), 400)
	}
	expect(t, call(h, "alice", "GET", "/api/buildings/not-a-uuid", ""), 404)
	expect(t, call(h, "alice", "PATCH", path, `{}`), 405)
	expect(t, call(h, "alice", "DELETE", path, ""), 204)
	expect(t, call(h, "alice", "GET", path, ""), 404)
	expect(t, call(h, "alice", "DELETE", path, ""), 404)
	// A fresh server instance reads the same SQL data; there is no process-local store.
	fresh := server.New(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, identities{}, users, &building.Store{Pool: pool}, nil)
	remaining := call(fresh, "alice", "GET", "/api/buildings", "")
	expect(t, remaining, 200)
	var last struct {
		Items []building.Summary `json:"items"`
	}
	decode(t, remaining, &last)
	if len(last.Items) != 1 || last.Items[0].Name != "Second house" {
		t.Fatalf("saved building missing after server recreation: %s", remaining.Body)
	}
}

func call(h http.Handler, token, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func expect(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("want HTTP %d, got %d: %s", status, w.Code, w.Body)
	}
}

func decode(t *testing.T, w *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), target); err != nil {
		t.Fatal(err)
	}
}
