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
object; its internal building format is not defined yet. Only name and data are
accepted at the top level. Requests are limited to 1 MiB.

Create, get, and update responses contain id, name, data, created_at, and updated_at.
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

Items contain id, name, created_at, and updated_at. Fetch a building by ID to load
its data. Follow next_offset when non-null.

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
| 405 | Unsupported method; see Allow header |
| 413 | Request exceeds 1 MiB |
| 415 | Use application/json for POST/PUT |
| 500 | Storage/internal error; details are omitted |
| 503 | Authentication provider/database unavailable or not ready |

Configured exact CORS origins may send GET, HEAD, POST, PUT, and DELETE with
Authorization and Content-Type headers. X-Request-ID and Location are exposed.
See [BACKEND.md](../BACKEND.md) for setup and integration TODOs.
