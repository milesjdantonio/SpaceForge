# SpaceForge backend

Go API for Firebase authentication and private building JSON storage in PostgreSQL.
The frontend renders buildings; this API saves, lists, loads, replaces, and deletes
its JSON documents. See [API reference](docs/api.md).

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

Apply migrations and restart the API after backend updates. Database data persists
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
design service: valid replies automatically save while signed in. Save changes
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

frontend/js/config.js separates storageBaseUrl (the Go API, local default port 8080)
from apiBaseUrl (the external Gemma/design service, still selected with ?api=).
Firebase tokens go only to the storage service. Signing out clears private render
state and account caches. Sessions survive page reload within a tab using a Firebase
refresh token in sessionStorage; passwords and ID tokens are kept only in memory.

On non-local hosts, configure storageBaseUrl to your HTTPS API and auth.apiKey to
the Firebase public web API key, with auth.emulatorUrl empty. No AI/provider secret
or service-account key belongs in the frontend. Real Gemma generation still requires
its separately configured design service; saving/importing existing JSON works
independently.

## Run Gemma generation

The merged housecost/ module is a separate Go process. Put your Gemini key in
GEMINI_API_KEY in the root .env, or put only the key in root APIKey.txt. Both files
are ignored by Git. An APIKey.txt file takes precedence over the environment.
Keep the key on the server; frontend/js/config.js needs no Gemini key.

In another terminal, starting at the repository root:

```bash
set -a
source .env
set +a
cd housecost
go run . -serve -addr 127.0.0.1:8000
```

Keep the auth/storage API on 8080 and frontend on 5173 running. Reload the frontend:
it discovers the generation service on port 8000. To select it explicitly, open
http://127.0.0.1:5173/?api=http://127.0.0.1:8000/api (include /api).
GET http://127.0.0.1:8000/api/health reports whether a key was found; it does not
verify the key with Google. Designs use queued jobs, progress polling, and inline
design.cost; signed-in users save the complete result to private SQL storage.

The generation service currently supports US sites. Its generation jobs and local
results have no account authorization; use its loopback address for development.
The account storage API separately enforces Firebase authentication and ownership.
If using the frontend served directly on port 8000 instead of 5173, add that exact
origin to ALLOWED_ORIGINS in .env and restart the storage API to enable login there.

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
browser flow for signup, fixture Gemma output, save/reload, account isolation, import,
and deletion. It also drags a house twice with a delayed save response and verifies
that reopening restores the latest position. It also checks automatic restoration
of two houses, camera/selection persistence, and removing private models on sign-out.
It creates and cleans up isolated
emulator test accounts. Use
TEST_STORAGE_URL to target a temporary test API/database rather than the app database.

From frontend/, node tools/building-drag.mjs checks mouse and mobile selection, orange highlighting, Move mode (roof and grip dragging, turning, keeping spots inside the land),
camera stability, release outside the canvas, and touch cancellation using fixture
JSON only. Run browser checks one at a time.
