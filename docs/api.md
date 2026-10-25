# Backend API

Send `Authorization: Bearer <Firebase ID token>` for /api routes. Firebase handles
sign-in, registration, passwords, and token refresh. The backend verifies tokens
and synchronizes the caller's local profile at GET /api/me.

| Method and path | Result |
| --- | --- |
| GET /healthz | 200: API process responding; public |
| GET /readyz | 200: database reachable, otherwise 503; public |
| GET /api/me | 200: current user's profile |
| POST /api/buildings | 201: create a building; Location header identifies it |
| GET /api/buildings | 200: list your building metadata |
| GET /api/buildings/{id} | 200: load your full building document |
| PUT /api/buildings/{id} | 200: replace your building's name and complete data |
| DELETE /api/buildings/{id} | 204: delete your building |
| PUT /api/buildings/{id}/project | 200: assign an owned project without rewriting data |
| POST /api/projects | 201: create a private project and shared land document |
| GET /api/projects?offset=0 | 200: 20 projects and next_offset |
| GET /api/projects/{id} | 200: project, land, and member building metadata |
| PUT /api/projects/{id} | 200: replace project name and land |
| DELETE /api/projects/{id} | 204: delete an empty project; 409 if referenced |
| POST /api/designs | 202: enqueue an account-owned durable design task |
| GET /api/designs/jobs | 200: latest 100 task records; ?active=1 limits to queued/running |
| GET /api/designs/jobs/{id} | 200: persisted progress; completed task includes building |
| DELETE /api/designs/jobs/{id} | 204: remove task/revoke its lease; keep any saved building |
| GET /api/designs/{designId} | 200: original design from your saved buildings |
| GET /api/designs/{designId}/estimate | 200: stored estimate, or 404 when absent |
| GET /api/coverage?lng=-105&lat=40 | 200: private worker site-data coverage |

GET routes also support HEAD. Missing, invalid, and other-user building IDs return
404. Ownership comes from the verified user, never request fields or role claims.

## Building JSON

POST and PUT require Content-Type: application/json:

```json
{
  "name": "My house",
  "data": {}
}
```

Name is required, trimmed, and limited to 1-120 characters. Data must be a JSON
object. The web client stores {schema, design, estimate, site, placement}, using
schema "terrasim.saved-building/1"; the API remains flexible. An optional project_id UUID associates a building with an owned project.
POST without it creates a project; PUT without it keeps existing membership.
Other top-level fields are rejected. The membership-only endpoint accepts
`{ "project_id": "owned-project-uuid" }` and preserves the complete document. Requests are limited to 1 MiB.

Create, get, and update responses contain id, project_id, name, data, created_at, and updated_at.
IDs are UUIDs; timestamps use RFC 3339. Each POST creates a new record; autosave
should PUT the existing ID. PUT fully replaces data rather than merging it.
PostgreSQL JSONB preserves values, including large integers, but normalizes text
formatting/key order and retains the last occurrence of duplicate keys.

## Listing

GET /api/buildings?limit=20&offset=0 returns newest-created first, with ID as the
ordering tie-breaker. Limit accepts 1-100 (default 20); offset accepts 0-1000000
(default 0). New inserts/deletes can shift offsets between requests.

```json
{"items":[],"next_offset":null}
```

Items contain id, project_id, name, created_at, and updated_at. Fetch a building by ID to load
its data. Follow next_offset when non-null.

## Projects and generation

Project POST/PUT bodies are `{ "name": "My project", "land": {} }`. Land is a shared
JSON object; design/site data inside individual saved buildings remains an original
snapshot. Project GET includes `buildings: [{id, name}]`. Ownership is enforced on
projects, tasks and building membership; another account's IDs return 404.

Generation POST uses this envelope (the request itself follows contracts/FIELDS.md):

```json
{
  "request_key": "a-client-generated-unique-request-id",
  "project_id": "optional-owned-project-uuid",
  "request": { "schema": "terrasim.design-request/2", "id": "request-id", "site": {} },
  "site": { "form": {} }
}
```

Supply the complete valid request, including its site polygon. Omit project_id to
create a new project. Site is an optional UI/brief snapshot; the server derives its
ring from the request polygon. A request key is 1-200 characters. Repeating the same
key/input returns the existing job; changing its input returns 409. Keys are scoped
to the verified account. Snapshot key ordering is canonicalized before hashing.

The response is `{jobId, projectId}` with a Location header. An idempotent replay
returns `{jobId}`. Polling the job returns jobId, projectId, status and available step
metadata (`progress`, `message`, `steps`). Status is queued, running, done, or failed.
Done includes `building`, the complete private SQL record. Failure includes a safe
error message. Account identity is never taken from the request body. The browser
does not POST the generated result to storage; completing the job and inserting the
building are one transaction. Closing the page does not cancel generation.

The private worker at GENERATION_URL requires a server-only service token. The API
never forwards Firebase tokens to it. POST /internal/generate streams NDJSON step
metadata and a result; it is not a public/client API. Queue leases, retries, and
production configuration are documented in [BACKEND.md](../BACKEND.md).

## Errors and browser access

Responses include X-Request-ID and Cache-Control: no-store. Errors use this envelope:

```json
{
  "error": {
    "code": "not_found",
    "message": "Building not found.",
    "request_id": "83f362de-f1b6-4e59-a244-7bfca9d00af5"
  }
}
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON, name/data, pagination, Unicode, or numeric values |
| 401 | Missing, invalid, expired, revoked, or disabled-user token |
| 403 | Disallowed CORS origin or preflight request |
| 404 | Missing route or inaccessible building |
| 409 | Reused request key with different input, or project still in use |
| 405 | Unsupported method; see Allow header |
| 413 | Request exceeds 1 MiB |
| 415 | Use application/json for POST/PUT |
| 500 | Storage/internal error; details are omitted |
| 503 | Authentication provider/database unavailable or not ready |

Configured exact CORS origins may send GET, HEAD, POST, PUT, and DELETE with
Authorization and Content-Type headers. X-Request-ID and Location are exposed.
See [BACKEND.md](../BACKEND.md) for setup and the connected frontend workflow.
