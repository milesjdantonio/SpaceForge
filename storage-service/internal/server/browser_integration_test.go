package server_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
	"time"

	"spaceforge/storage-service/internal/building"
	"spaceforge/storage-service/internal/generation"
	"spaceforge/storage-service/internal/server"
	"spaceforge/storage-service/internal/testutil"
	"spaceforge/storage-service/internal/user"
)

func TestBrowserGenerationAndProjects(t *testing.T) {
	if os.Getenv("RUN_BROWSER_TESTS") != "1" {
		t.Skip("set RUN_BROWSER_TESTS=1 with frontend Playwright dependencies installed")
	}
	pool := testutil.Database(t)
	fixture, err := os.ReadFile("../../../frontend/fixtures/mock-house/design.json")
	if err != nil {
		t.Fatal(err)
	}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/coverage" {
			_ = json.NewEncoder(w).Encode(map[string]bool{"covered": true})
			return
		}
		var req struct {
			ID    string `json:"id"`
			Brief struct {
				DesignPrompt string `json:"designPrompt"`
			} `json:"brief"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if req.Brief.DesignPrompt == "An oversized building for failure regression." {
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "design-does-not-fit", "error": "The building does not fit inside the land with its setbacks. Reduce its size or choose a larger lot."})
			return
		}
		var design map[string]json.RawMessage
		_ = json.Unmarshal(fixture, &design)
		design["requestId"], _ = json.Marshal(req.ID)
		design["id"], _ = json.Marshal("browser-generated-" + req.ID)
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"design": design, "estimate": nil}})
	}))
	defer worker.Close()
	service := &generation.Service{Pool: pool, URL: worker.URL, Token: "browser-fixture-service-token-at-least-32-characters", Workers: 2}
	api := httptest.NewServer(server.New(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, identities{}, &user.Store{Pool: pool}, &building.Store{Pool: pool}, []string{"http://127.0.0.1:5196"}, service))
	defer api.Close()
	ctx, cancel := context.WithCancel(context.Background())
	wait := service.Start(ctx)
	defer func() { cancel(); wait() }()
	command := exec.Command("node", "../../../frontend/tools/architecture-flow.mjs")
	command.Env = append(os.Environ(), "TEST_STORAGE_URL="+api.URL)
	output, err := command.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
