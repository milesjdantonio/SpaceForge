# SpaceForge backend

Go API for Firebase authentication, private projects/buildings, and durable design
jobs in PostgreSQL. The frontend renders buildings; the API owns generation
authorization and saves completed designs without depending on the browser. See [API reference](docs/api.md).

## Run locally

Requirements: Go 1.25+, Docker Compose, curl, and jq.

```bash
cp -n .env.example .env
set -a
source .env
set +a
docker compose up -d --build --wait
cd backend
go run ./cmd/migrate
go run ./cmd/api
```

Apply migrations and restart the API after backend updates. Migration 000003 adds
projects and durable design tasks, backfilling one project per existing building
without changing building IDs, documents, or timestamps. Applied migrations stay immutable. Database data persists
in the Docker volume. The PostGIS image supports historical migrations; new building
storage uses JSONB. Applied migrations and existing data are preserved.

## Sign in

The local Auth emulator needs no cloud account. In another terminal:

```bash
AUTH_RESPONSE=$(curl -fsS \
  'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local' \
  -H 'Content-Type: application/json' \
  --data '{"email":"alice@example.test","password":"local-example-password","returnSecureToken":true}')
AUTH_TOKEN=$(printf '%s' "$AUTH_RESPONSE" | jq -er '.idToken')

curl -fsS http://127.0.0.1:8080/api/me \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq
```

For a new account, replace accounts:signInWithPassword with accounts:signUp once.
Emulator accounts must be recreated after its container restarts. Firebase manages
passwords and token refresh; Go verifies ID tokens and stores the local profile.

For real Firebase, configure your project/sign-in providers, set APP_ENV=production
and FIREBASE_PROJECT_ID, unset FIREBASE_AUTH_EMULATOR_HOST, and supply Google
application default credentials with permission to look up Firebase users. Configure
HTTPS frontend origins and serve the API behind HTTPS. Emulator mode is forbidden
in production.

## Save a building

```bash
BUILDING=$(curl -fsS http://127.0.0.1:8080/api/buildings \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"My house","data":{}}')
BUILDING_ID=$(printf '%s' "$BUILDING" | jq -er '.id')

curl -fsS "http://127.0.0.1:8080/api/buildings/$BUILDING_ID" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq
```

Replace the example's empty data object with the building module's export. Use PUT
on the same ID for subsequent saves; send the full name/data each time. All building
operations require a valid token and enforce ownership.

## Use the frontend

Start the Go API and Auth emulator above, then in another terminal:

```bash
cd frontend
npm start
```

Open http://127.0.0.1:5173. Choose Sign in to log in or create an email/password
account. My Builds lists your private saved buildings and browser site drafts.
After sign-in or a page refresh, the map automatically loads all your saved houses
at their saved positions. It restores the last selected house and map view without
requiring My Builds. The view preference (camera and selected SQL UUID) is stored
per account in this browser; house documents are loaded from the authenticated API.
Selecting a house on the map keeps the other saved houses visible. Signing out
removes all private models and resets the view; deleting a record removes its model.
Open a Gemma design file and choose Save building, or generate through a configured
design worker: generation requires sign-in and saves its result on the server.
Closing the tab does not stop accepted jobs or prevent saving. Save changes
updates the existing SQL record. Reopening restores the original design, estimate,
site/brief, and actual preview placement; Delete removes the account's saved record.
Moving a saved building automatically saves its new position when you choose Done.
Zoom close to the house and click or tap its visible roof or walls to select it in
orange, then choose Move beside it: drag the top grip (or the roof) to move it and
the ring grip to turn it. Done keeps spots inside the land; Escape puts it back.
Click empty land to deselect; dragging empty land still pans the map. Picking uses
the rendered 3D model in tilted views. Releasing outside the map or cancelling a
touch restores the controls. Selection tint never changes the saved design colors.
Overlapping saves run in order, including moves made while the first save is still
running or after selecting another house. A failed position save leaves the house visible and offers Save changes
to retry. Unsaved imports and previews still use Save building first.

frontend/js/config.js uses storageBaseUrl for every account operation, including
generation and projects. Firebase tokens go only to that configured API. Query-string
`?api=` overrides and provider discovery have been removed. Signing out clears private
render state and account caches. Sessions survive reload within a tab using a Firebase
refresh token in sessionStorage; passwords and ID tokens are kept only in memory.

On non-local hosts, configure storageBaseUrl to your HTTPS API and auth.apiKey to
the Firebase public web API key, with auth.emulatorUrl empty. No AI/provider secret,
service token, or service-account key belongs in the frontend.

My Builds has project filtering, project creation, and a project selector for each
building. Each project has an owner, name, and shared land JSON object. Multiple
buildings can reference the same project; composite foreign keys prevent crossing
account boundaries. Saved design/site documents remain snapshots of their original
inputs. Creating/importing a building without project_id creates a project atomically;
PUT without project_id keeps its current membership. The membership-only
PUT /api/buildings/{id}/project endpoint preserves data during reassignment. Nonempty projects cannot be
deleted. Remove their buildings/tasks or move the buildings first.

Frontend orchestration lives in frontend/js/controllers/: building-storage handles
ordered saves; scene restores private models/camera; account-session invalidates
private state on account changes; building-interaction handles picking and movement;
library handles project/building browsing; generation resumes observation after reload.
main.js connects these controllers to the map and panels.

## Run Gemma generation

housecost/ computes designs as a private worker service. The browser never calls it.
Configure both processes with the same random GENERATION_SERVICE_TOKEN (at least
32 characters). Generate one with `openssl rand -hex 32` and put it in your ignored
.env, along with:

```dotenv
GENERATION_URL=http://127.0.0.1:8000
GENERATION_SERVICE_TOKEN=<the generated token>
GENERATION_WORKERS=2
```

Use GEMINI_API_KEY in .env or the ignored APIKey.txt for the Gemini key. APIKey.txt
takes precedence over the environment. Keep all these secrets on the server.
Source .env and restart the API. In another terminal, from the repository root:

```bash
set -a
source .env
set +a
cd housecost
go run . -serve -addr 127.0.0.1:8000
```

Keep the frontend on 5173 and account API on 8080 running. An empty GENERATION_URL
leaves account/storage/project features available but rejects new generation with
503. Non-loopback worker URLs require HTTPS. The worker requires service authorization
for /internal/generate and /api/coverage; it exposes no browser CORS or public result
endpoints. Its optional static frontend serving still uses the account API for data.
Current generation site-data coverage remains US-only.

The workflow is:

1. POST /api/designs verifies Firebase identity and records an immutable request/site
   snapshot, project relationship, and account-scoped idempotency key in SQL.
2. Configurable concurrent consumers claim tasks with FOR UPDATE SKIP LOCKED and
   45-second leases. Heartbeats extend leases every 15 seconds. Multiple API instances
   can share the queue. Each attempt has a 15-minute deadline.
3. A consumer calls the private worker using the service token. The worker streams
   step metadata and the result; it uses no process-local queue, result files, or
   provider-reply files in server mode. Safe start/completion/failure messages appear
   in the worker terminal. An unbuildable footprint returns design-does-not-fit;
   the API persists that reason and the browser offers a smaller brief or larger lot.
   The CLI file-output mode is unchanged.
4. The consumer commits the building and completed task in one SQL transaction.
   Fenced lease tokens reject late completions from an obsolete worker. SQL results
   are committed once; after interruption, provider computation can run again.
5. A crashed process leaves a lease for another consumer to reclaim. Transport and
   temporary worker failures retry with backoff, up to three attempts; exhausted
   tasks become failed. Polling is optional: the server saves while the tab is closed.
   On reload the frontend restores saved buildings and watches pending jobs.

DELETE /api/designs/jobs/{id} removes a task and revokes an active lease; deleting a
completed task leaves its saved building. Deleting a generated building removes its
completed task. This also removes that task's idempotency key. Lease decisions use the database clock.

## Test

```bash
cd backend
go vet ./...
go test -race ./...
```

Run go vet ./... and go test -race ./... from housecost/ too. Its tests replace
external model/site providers and cover all seven housing types and the HTTP
generation workflow without using a real Gemini key.

SQL integration tests require a dedicated database. Create it once from the repo root:

```bash
docker compose exec -T db createdb -U spaceforge spaceforge_test
cd backend
TEST_DATABASE_URL='postgres://spaceforge:spaceforge_local@127.0.0.1:5432/spaceforge_test?sslmode=disable' \
  go test -race -count=1 ./...
```

The tests cover authentication, request validation, JSON persistence, pagination,
server restarts, and isolation between users. Without TEST_DATABASE_URL, SQL tests
explicitly skip. Configuration is listed in [.env.example](.env.example).

Run npm test from frontend/ for session/refresh/storage checks. With the local Go API
and Auth emulator running, npm ci followed by node tools/auth-storage.mjs runs a
browser flow for signup, fixture import, save/reload, account isolation,
and deletion. It also drags a house twice with a delayed save response and verifies
that reopening restores the latest position. It also checks automatic restoration
of two houses, camera/selection persistence, and removing private models on sign-out.
It creates and cleans up isolated
emulator test accounts. No generation provider is called by that storage test. Use
TEST_STORAGE_URL to target a temporary test API/database rather than the app database.

From frontend/, node tools/building-drag.mjs checks mouse and mobile selection, orange highlighting, Move mode (roof and grip dragging, turning, keeping spots inside the land),
camera stability, release outside the canvas, and touch cancellation using fixture
JSON only. Run browser checks one at a time.

To exercise browser-to-SQL generation and project grouping with offline Firebase/model
stand-ins, install frontend dependencies and run from backend/ with a dedicated
TEST_DATABASE_URL:

```bash
RUN_BROWSER_TESTS=1 go test -race -count=1 -run TestBrowserGenerationAndProjects -v ./internal/server
```

This test calls frontend/tools/architecture-flow.mjs and verifies reload during a job,
automatic server persistence, project reassignment, and account isolation in a browser.
