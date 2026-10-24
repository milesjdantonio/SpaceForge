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

Remaining integration points are marked in code:

- TODO(frontend): attach tokens, connect save/autosave, and load JSON into the renderer.
- TODO(building-module): agree the export format and add document-specific validation.

## Test

```bash
cd backend
go vet ./...
go test -race ./...
```

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
