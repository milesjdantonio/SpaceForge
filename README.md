# TerraSim

**[Try TerraSim → terrasim.house](https://terrasim.house/)**

_Formerly SpaceForge; the checkout, Compose project and storage Go module still use that name._

Outline land on a 3D map, describe what you want to build, and turn the brief into a building on
that lot. TerraSim combines Gemma through the Gemini API with site data, room layout and cost
estimation to produce floor plans, a furnished 3D walkthrough, materials and ownership costs.

It supports houses, tiny homes, townhouses, duplexes, mansions, villas, apartments, condos, dorms
and hotels, plus neighborhoods and trailer parks with roads and lots. The interface supports
metric and imperial units; estimates are in USD.

[Quick start](#quick-start) · [Architecture](#architecture) · [Full local setup](#full-local-setup) ·
[Using the app](#using-the-app) · [Tests](#tests) · [Deployment](#deployment)

## Architecture

```mermaid
flowchart TB
    user["Browser · website/<br/>HTML, CSS, JavaScript<br/>MapLibre · three.js · Rive"]
    maps["Map, search and terrain providers"]
    auth["Firebase Auth<br/>Local emulator :9099"]

    subgraph account["Account workflow"]
        api["Go account API · storage-service/<br/>:8080 · Firebase token verification<br/>Projects, buildings and durable design jobs"]
        db[("PostgreSQL / PostGIS · :5432<br/>Profiles, projects, JSONB buildings<br/>Design tasks, progress and leases")]
        api <-->|"SQL reads / writes"| db
    end

    design["Go design service · design-service/<br/>:8000 · Site assessment, layout and pricing<br/>Also serves website/ in standalone mode"]
    model["Gemma via Gemini API"]
    data["Site and pricing data sources"]

    user -->|"Tiles, imagery and search"| maps
    user <-->|"Sign-in and token refresh"| auth
    user <-->|"Firebase ID token · account API requests"| api
    api -->|"Verify identity"| auth
    api -->|"POST /internal/generate · service token"| design
    design -->|"Stream progress and result"| api
    design <-->|"Server-side API key"| model
    design <-->|"Soil, elevation, climate, flood and wages"| data
    user -.->|"Standalone: direct /api requests, no account"| design
```

There are two ways to run it:

| Mode | Run | What you get |
|---|---|---|
| **Standalone** | Design service, which also serves the website | Design without signing in. Jobs run in memory; completed results are written to `design-service/results/`. No private account storage. |
| **Full stack** | Website + account API + design service + PostgreSQL + Firebase Auth | Sign-in, private buildings, project grouping and durable generation. Signed-in generation goes through the account API. |

In the account workflow, the API records a design task in SQL, claims it with a renewable lease,
and calls the design worker with a separate service token. It commits the completed task and
building together. Accepted jobs continue when the browser closes, and interrupted jobs can be
reclaimed. A retry can repeat provider computation, while the database prevents duplicate completion.

The design service supports both public standalone routes and the token-protected worker route.
For an account deployment, keep it on an internal network or restrict external access to its
standalone routes. Firebase ID tokens go to the account API; provider keys and the shared service
token stay on the server.

## Quick start

### Try generation without an AI key

From the repository root, with **Go 1.22+** installed:

```bash
cd design-service
go run . -serve -fake -addr 127.0.0.1:8000
```

Open **http://127.0.0.1:8000**. `-fake` replaces Gemma responses with a stand-in; it still fetches
real site data, so internet access is required and generation is not instantaneous. This mode
does not need Node.js, Docker, Firebase or PostgreSQL. Sign-in and account saves need the full stack.

For real generation, set `GEMINI_API_KEY` in the design service's terminal and run the same command
without `-fake`. Alternatively, put the raw key in the gitignored `APIKey.txt` in `design-service/`
or a parent directory. A key file takes precedence over the environment variable.

### Explore the interface without generation

With **Node.js and npm**, from the repository root:

```bash
cd website
npm start
```

Open **http://127.0.0.1:5173**. No dependency install or build is needed to serve the site: runtime
libraries are checked into `website/vendor/`. In **My Builds → Open a Design File**, select
[`website/fixtures/mock-house/design.json`](website/fixtures/mock-house/design.json) to explore
the sample's model, plans and walkthrough. Map imagery and search still require internet access.

## Full local setup

Requirements: **Go 1.25+**, **Node.js with npm**, **Docker with Compose**, and **OpenSSL** to generate
the shared token. The storage service requires a newer Go version than the standalone design service.
The commands below use Bash; start each terminal at the repository root.

### 1. Configure the environment and start dependencies

Copy the example only if you do not already have a local `.env`:

```bash
if [ ! -f .env ]; then cp .env.example .env; fi
openssl rand -hex 32
```

Edit `.env` and set these values, pasting the generated token as `GENERATION_SERVICE_TOKEN`:

```dotenv
GENERATION_URL=http://127.0.0.1:8000
GENERATION_SERVICE_TOKEN=<paste the generated token here>
GENERATION_WORKERS=2
```

Keep the other local defaults in [`.env.example`](.env.example). For real Gemma generation, also
set `GEMINI_API_KEY`; the stand-in used below does not need it. Both Go processes must receive
the **same token**, at least 32 characters long. `.env` is gitignored and is not loaded automatically.

```bash
set -a
source .env
set +a
docker compose up -d --build --wait
```

Compose starts PostgreSQL/PostGIS on `127.0.0.1:5432` and the Firebase Auth emulator on
`127.0.0.1:9099`. No cloud Firebase project is needed for local development.

### 2. Start the account API — terminal 1

```bash
set -a
source .env
set +a
cd storage-service
go run ./cmd/migrate
go run ./cmd/api
```

The API listens on **http://127.0.0.1:8080**. Apply migrations again after backend updates.

### 3. Start the design worker — terminal 2

```bash
set -a
source .env
set +a
cd design-service
go run . -serve -fake -addr 127.0.0.1:8000
```

For real generation, remove `-fake` after configuring the Gemini key. Use a US lot for the account
workflow: the current private worker rejects sites outside its US coverage. Standalone generation
also supports sites elsewhere, using worldwide data and labelled assumptions.

### 4. Start the website — terminal 3

```bash
cd website
npm start
```

Open **http://127.0.0.1:5173**, then **Sign In** and create an email/password account. The local
frontend defaults already point at the account API and Auth emulator. Signed-in generation uses
the account API, which saves the result automatically.

To check the running services, open the API's [`/readyz`](http://127.0.0.1:8080/readyz) and the
design service's [`/api/health`](http://127.0.0.1:8000/api/health). An empty `GENERATION_URL` leaves
account storage and projects available, but signed-in generation returns `503`.

Stop each foreground process with **Ctrl+C**, then run `docker compose stop` from the root to stop
the dependencies. Database data persists in a Docker volume. Emulator accounts must be recreated
after the Auth container restarts. See [the local development guide](docs/running-locally.md) for
API examples, job recovery details and browser integration checks.

## Using the app

1. **Find land:** search for a place or navigate the globe, then outline a lot on the map.
2. **Write a brief:** choose a housing type, size, floors and rooms, then describe the style or
   features you want. Review the fit feedback before generating.
3. **Generate and explore:** follow the progress, then inspect floor plans, materials, costs,
   the orbiting Preview or the full-screen walkthrough.
4. **Place and save:** select a building and choose **Move** to drag or turn it. **Done** keeps a
   placement inside the land and automatically saves moves to an account-saved building.
   Imported designs and sample previews use **Save building** first.
5. **Organize and share:** use **My Builds** to reopen, delete or group saved buildings by project.
   Sign-in or refresh restores your saved houses. **Share** creates a link carrying a copy of the
   building, with a file option for large designs; recipients do not need access to your account.
   Sample previews share their land and brief.

Private records belong to the signed-in account; there is no public catalog or listings workflow.
Site drafts stay in the browser. Sharing a building copies its data into the link or file rather
than granting access to the private SQL record.

## Repository guide

| Path | Responsibility |
|---|---|
| [`website/`](website/README.md) | Plain HTML/CSS/JavaScript frontend: map, brief, 3D buildings, floor plans, walkthrough and account UI. `js/controllers/` coordinates storage, scenes, sessions and generation. |
| [`design-service/`](design-service/README.md) | Go design pipeline, site data, Gemma calls, geometry and pricing; standalone HTTP server, private generation worker and CLI. |
| [`storage-service/`](storage-service/README.md) | Go account API: Firebase verification, private projects/buildings, SQL task queue, leases and atomic generated-building saves. Entry points: `cmd/api`, `cmd/migrate`. |
| [`contracts/`](contracts/) | [Design request/output fields](contracts/FIELDS.md) and [saved-building envelope](contracts/STORAGE.md). |
| [`docs/`](docs/) | [Local development](docs/running-locally.md), [account API reference](docs/storage-service-api.md), [product context](docs/product.md), [status notes](docs/status.md) and [libraries/data sources](docs/resources.md). |
| [`dev/auth/`](dev/auth/) | Local Firebase Auth emulator image and configuration. |
| [`compose.yaml`](compose.yaml), [`.env.example`](.env.example) | Local database/Auth dependencies and backend environment settings. Compose does not launch the Go services or website. |
| [`render.yaml`](render.yaml) | Standalone Render deployment: design service and website in one process. |

### Generate from a request file

With a Gemini key configured, run from the root:

```bash
cd design-service
go run . -request request.example.json -out request.example.result.json
```

The output contains the original request, design, estimate and site/cost report. The CLI needs
neither the account API nor a database. See the [design service README](design-service/README.md)
for pipeline details and additional flags.

## Tests

Run each block from the repository root:

```bash
cd design-service
go vet ./...
go test -race ./...
```

```bash
cd storage-service
go vet ./...
go test -race ./...
```

```bash
cd website
npm test
```

Go tests use offline model/provider stand-ins. Frontend unit tests need no dependency install.
Storage SQL integration tests skip unless `TEST_DATABASE_URL` points to a **dedicated test
database**. With Compose running, create it once and run:

```bash
docker compose exec -T db createdb -U spaceforge spaceforge_test
cd storage-service
TEST_DATABASE_URL='postgres://spaceforge:spaceforge_local@127.0.0.1:5432/spaceforge_test?sslmode=disable' \
  go test -race -count=1 ./...
```

For browser tests, install the tooling with `npm install` in `website/` and follow the
[browser integration instructions](docs/running-locally.md#test). Run browser checks one at a time.

## Deployment

[`render.yaml`](render.yaml) deploys the **standalone** website/design service. Create a Render
Blueprint from this repository and supply `GEMINI_API_KEY` when prompted. The service uses Render's
`PORT` and exposes `/api/health`. This blueprint does not provision accounts, PostgreSQL or durable
account jobs; standalone results live on the service's local disk.

A full account deployment also needs the storage API, PostgreSQL and a real Firebase project with
email/password sign-in enabled. Configure `APP_ENV=production`, `DATABASE_URL`, `FIREBASE_PROJECT_ID`,
Google application default credentials, exact HTTPS `ALLOWED_ORIGINS`, and the internal generation
URL/shared token. Unset `FIREBASE_AUTH_EMULATOR_HOST` and apply migrations before starting the API.

In [`website/js/config.js`](website/js/config.js), set `storageBaseUrl` to the HTTPS account API,
`auth.apiKey` to Firebase's public web API key, and `auth.emulatorUrl` to an empty string. Keep the
Gemini key, service token and Google service-account credentials out of frontend configuration.
See [the local guide's Firebase configuration](docs/running-locally.md#sign-in) for the backend
requirements and [resources](docs/resources.md) for map/data provider considerations.
