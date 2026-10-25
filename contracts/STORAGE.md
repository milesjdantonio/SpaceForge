# Private building storage

The Go backend stores rendered buildings in PostgreSQL JSONB. Firebase login is
connected in the frontend. The authenticated API owns private projects and durable
generation jobs; a private worker computes designs using [FIELDS.md](FIELDS.md).

## Saved document

The web client sends {name, data} to POST /api/buildings. Data uses this envelope:

```json
{
  "schema": "terrasim.saved-building/1",
  "design": {},
  "estimate": null,
  "site": null,
  "placement": null
}
```

- design is the complete, validated terrasim.design/2 output, including its cost;
  its id/requestId stay intact.
- estimate is the matching terrasim.estimate/1 document for older services, or null.
- site preserves the outlined land and original brief.
- placement preserves where the renderer actually placed the building, including
  relocated sample previews, without changing the original Gemma geometry.

The database returns a separate SQL UUID, project_id, name, data, and creation/update timestamps.
Use that UUID for later saves; it is not the Gemma design ID. JSONB preserves values,
but can normalize whitespace, key order, and duplicate keys.

## Endpoints

All storage API routes below require Authorization: Bearer <Firebase ID token>.

| Call | Result |
| --- | --- |
| GET /api/me | Verify identity and synchronize the local profile |
| POST /api/buildings | Save {name, data}; return 201 and the SQL record |
| GET /api/buildings?limit=20&offset=0 | List the caller's metadata and next_offset |
| GET /api/buildings/{uuid} | Load the owner's full document |
| PUT /api/buildings/{uuid} | Replace the complete name/data |
| DELETE /api/buildings/{uuid} | Delete the owner's building; return 204 |

Missing/other-user records return 404. Errors use {error: {code, message, request_id}}.
Requests are limited to 1 MiB. See [API reference](../docs/api.md).

## Frontend flow

1. Sign in or create an email/password account using the top bar. A refresh token
   in this tab's sessionStorage restores login on reload; passwords and ID tokens
   remain in memory. Production needs the real Firebase public key and storage URL.
2. Generation requires sign-in. The server records the task and automatically saves
   its result in SQL, even if the tab closes. Reload restores saved designs and
   resumes observation of pending tasks; no browser save bridges the two services.
3. Imported design/estimate files and previews can be saved manually. Subsequent
   saves PUT the existing SQL UUID, avoiding duplicate records. Dragging a saved
   building automatically saves its actual placement when Done is selected. Saves
   run in order so overlapping moves preserve the latest position; the original
   design.placement stays intact. Failed saves can be retried with Save changes.
4. My Builds lists private saved buildings and local site drafts. Opening a SQL record
   validates the design and restores the same building, estimate, site, and placement
   without calling Gemma again. Load more follows next_offset.
   Sign-in/session restoration also loads every page automatically and draws all
   valid saved houses. The last selected SQL UUID and camera view are remembered
   per account in the browser, so refresh restores the scene without My Builds.
   Selecting another saved house keeps the remaining models on the map.
5. Owners can delete records. Signing out clears private rendered data and account
   document caches. Switching accounts cannot display another user's delayed SQL
   response. Deleting a record removes its map model as well as its SQL document.

The frontend uses storageBaseUrl for generation, projects, and saved buildings.
Firebase tokens are sent only to that configured API; `?api=` is ignored. The API
calls housecost using a separate server-only service token. Durable jobs and their
progress live in SQL; successful completion commits the saved building atomically.

All building records have project_id. POST /api/buildings accepts optional
project_id; omission creates a project from the saved site snapshot. PUT may assign
an owned project or omit the field to retain membership. Membership-only updates
use PUT /api/buildings/{id}/project and preserve data. GET /api/projects/{id}
returns shared land and member buildings; project CRUD and task routes are specified
in [the API reference](../docs/api.md). The migration preserves existing documents
and backfills one private project per existing building.

Frontend lifecycle responsibilities are split across controllers/ (account changes,
scene restoration, storage, generation observation, map interaction and library).
Publishing, public listings and inquiries remain unimplemented. Share packs a copy
of the building (design, placement, land) into the link itself (#b=...,
terrasim.shared-building/1); it never grants access to the private record.
