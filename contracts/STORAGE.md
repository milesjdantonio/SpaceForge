# Private building storage

The Go backend stores rendered buildings in PostgreSQL JSONB. Firebase login is
connected in the frontend. Generation remains a separate service using
[GEMMA.md](../GEMMA.md) and [FIELDS.md](FIELDS.md).

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

The database returns a separate SQL UUID, name, data, and creation/update timestamps.
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
2. Signed-in users automatically save valid Gemma replies. A failed save leaves the
   displayed building available, with Save building to retry.
3. Imported design/estimate files and previews can be saved manually. Subsequent
   saves PUT the existing SQL UUID, avoiding duplicate records. Dragging a saved
   building automatically saves its actual placement when the drag ends. Saves
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

The frontend uses storageBaseUrl for Go storage and apiBaseUrl for the external
Gemma service. Firebase tokens are never sent to a ?api= design-service URL.
The separate housecost Go service provides generation at POST /api/designs,
with job polling and design/cost retrieval on port 8000. Its jobs/results are local
to that service; private account persistence uses the SQL routes above.
The Go storage API does not implement generation jobs, publishing, public listings,
or inquiries. Share site copies the outline/brief, not access to the private record.
