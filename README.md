# TerraSim

_Formerly SpaceForge._

TerraSim turns an outlined lot and a building brief into a private building design,
materials list, and cost estimate. The map renders the design, supports moving and
turning it, and offers a walkthrough. Saved buildings can be grouped into private
projects and shared as a copied design in a link or file.

Generation uses **Gemma 4 through Google's Gemini API**. The default model is
`gemma-4-26b-a4b-it`; `GEMMA_MODEL` or the worker's `-model` flag can override it.

## Local services

| Service | Location | Local address |
| --- | --- | --- |
| Frontend: plain HTML/CSS/JavaScript, MapLibre, three.js, Rive | `frontend/` | http://127.0.0.1:5173 |
| Account API: Firebase authentication, projects, buildings, durable jobs | `backend/` | http://127.0.0.1:8080 |
| Private Go design worker | `housecost/` | http://127.0.0.1:8000 |
| PostgreSQL/PostGIS | Docker Compose | `127.0.0.1:5432` |
| Firebase Auth emulator | Docker Compose | `127.0.0.1:9099` |

The browser talks to the account API. That API authenticates generation requests,
queues them in PostgreSQL, calls the private worker, and commits each completed
building to private SQL storage. Closing the browser does not stop accepted work.

## Run locally

Requirements: **Go 1.25+**, **Node.js 22+ and npm**, **Docker with Docker Compose**,
and **OpenSSL** for generating the shared service token. Internet access is needed
for map imagery, site data, and real model generation. Local authentication uses
the emulator and does not require a cloud Firebase account.

Run setup commands from the repository root. Each application terminal below must
also start in the repository root.

### 1. Configure the environment

Create `.env` if it does not already exist:

```bash
cp -n .env.example .env
```

`-n` preserves an existing `.env`; it does **not** add new settings to it. When
upgrading an existing checkout, compare with `.env.example` and add missing keys.

Generate a shared service token once:

```bash
openssl rand -hex 32
```

Edit `.env` and set:

```dotenv
GENERATION_URL=http://127.0.0.1:8000
GENERATION_SERVICE_TOKEN=PASTE_THE_GENERATED_TOKEN_HERE
GENERATION_WORKERS=2
GEMMA_MODEL=gemma-4-26b-a4b-it
GEMINI_API_KEY=PASTE_YOUR_GOOGLE_API_KEY_HERE
```

Keep the development database, origin, and Firebase emulator settings from
`.env.example`. The API and worker must load the **same** service token. This token
is separate from the Google API key and is never sent to the browser.

Alternatively, put only the Google API key in a gitignored `APIKey.txt` in the
repository root. An `APIKey.txt` found in the worker's current directory or a parent
directory takes precedence over `GEMINI_API_KEY`. Keep `.env` and key files private.

### 2. Start the database and authentication emulator

```bash
docker compose up -d --build --wait
docker compose ps
```

Wait until both `db` and `auth` are healthy. The first run builds the Auth emulator
container. If Docker reports permission denied on Linux, use `sudo docker compose`
for the Docker commands.

### 3. Start the API — terminal 1

From the repository root:

```bash
set -a
source .env
set +a

cd backend
go run ./cmd/migrate
go run ./cmd/api
```

The migration command must succeed before starting the API. Apply migrations after
backend updates as well. Existing building IDs/documents are preserved; migration
`000003` creates projects and durable generation jobs.

Leave the API running on port **8080**.

### 4. Start the design worker — terminal 2

From the repository root:

```bash
set -a
source .env
set +a

cd housecost
go run . -serve -addr 127.0.0.1:8000
```

Expect `Private design worker listening on 127.0.0.1:8000`. Leave it running.
The worker reports generation start, completion, and failure without printing
credentials or private design documents.

### 5. Start the frontend — terminal 3

From the repository root:

```bash
cd frontend
npm ci
npm start
```

Open **http://127.0.0.1:5173**. Use this address consistently during local testing.

Click **Sign in** and create a local account. Outline land in the **United States**,
complete the building brief, and submit it. For a first design, use a generous lot
and a modest house. The footprint must fit inside the land after setbacks.

Completed designs save automatically. **My Builds** lists saved buildings and local
site drafts, lets you create projects, and lets you change a building's project.
Select a building, choose **Move**, move/turn it, and select **Done** to save its
placement. Refreshing restores saved buildings and watches pending jobs.

### 6. Check connectivity

In another terminal, from the repository root:

```bash
set -a
source .env
set +a

curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
curl -fsS \
  -H "Authorization: Bearer ${GENERATION_SERVICE_TOKEN}" \
  http://127.0.0.1:8000/api/health
```

Expect `{"status":"ok"}`, `{"status":"ready"}`, and `{"ok":true}`. These checks
verify connectivity; a generation request verifies Google key/model access. The
private worker returns **401** when called without the service token.

### Common setup issues

- **Changed `.env`:** restart both Go processes after loading it again with
  `set -a`, `source .env`, `set +a` in each terminal.
- **Generation unavailable:** set `GENERATION_URL`, configure the matching service
  token in both processes, and start the worker. Leaving the URL empty allows
  account/storage features but disables new generation.
- **Database schema not ready:** run `go run ./cmd/migrate` from `backend/` after
  loading `.env`, then restart the API.
- **Building does not fit:** reduce its size/number of homes or outline a larger
  lot. The app reports this before making AI calls when initial placement fails.
- **Choosing materials, try 2 of 3:** the materials response is being corrected
  after validation. It is a retry of that stage; successful validation continues
  to pricing.

Use Ctrl+C to stop each application process. PostgreSQL data persists in its Docker
volume. The current Auth emulator configuration does not persist accounts across
container restarts, so keep it running when testing account restoration between
application restarts. `docker compose stop` stops the containers when finished.

## Test

The automated tests use offline model/provider stand-ins and do not spend Google
API quota. SQL tests need a dedicated test database; they skip when
`TEST_DATABASE_URL` is unset.

Create the test database once, from the repository root:

```bash
docker compose exec -T db createdb -U spaceforge spaceforge_test
```

If that database already exists, continue. Run backend tests:

```bash
cd backend
export TEST_DATABASE_URL='postgres://spaceforge:spaceforge_local@127.0.0.1:5432/spaceforge_test?sslmode=disable'
go vet ./...
go test -race -count=1 ./...
```

In `housecost/`:

```bash
go vet ./...
go test -race -count=1 ./...
```

In `frontend/`:

```bash
npm test
```

### Browser checks

Install the browser once from `frontend/`:

```bash
npx playwright install chromium
```

From `backend/`, run the browser-to-SQL test:

```bash
export TEST_DATABASE_URL='postgres://spaceforge:spaceforge_local@127.0.0.1:5432/spaceforge_test?sslmode=disable'
RUN_BROWSER_TESTS=1 go test -race -count=1 \
  -run TestBrowserGenerationAndProjects -v ./internal/server
```

This starts its own test API and fixture worker. It checks generation across reload,
automatic saving, project grouping, account isolation, and an actionable error for
an unbuildable footprint. Only the test database needs to be running; real model
credentials and the application API/worker are not required for this check.

From `frontend/`, test desktop and mobile building interaction:

```bash
node tools/building-drag.mjs
```

Run browser checks one at a time.

## Further documentation

- [BACKEND.md](BACKEND.md): authentication, storage, worker configuration, and job recovery.
- [API reference](docs/api.md): authenticated project, building, and job endpoints.
- [Design contracts](contracts/FIELDS.md) and [storage contract](contracts/STORAGE.md).
- [UPDATE.md](UPDATE.md): product decisions and remaining work.
- [AGENT.md](AGENT.md): repository conventions.
