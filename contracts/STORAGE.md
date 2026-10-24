# Storing designs: the plan

**Status:** not built yet. This is the plan the website will be written against, so whoever builds the
database knows exactly what to make. Until it exists, the website keeps designs in the browser only
(see "Until the database exists" below).

## What gets stored

The database stores files exactly as they are sent. It never changes a design; the renderer draws
the stored file as is.

| Record | Contents | Key |
|---|---|---|
| **request** | The `request` part of [baseline.json](baseline.json), as the website sent it. | `request.id` |
| **design** | The `design` part, as Gemma returned it. This is the render file. | `design.id` |
| **estimate** | The `terrasim.estimate/1` file ([GEMMA.md](../GEMMA.md) section 3). | `estimate.designId` |
| **job** | Progress of one request while Gemma works. | `jobId` |

A design is never edited. A changed brief makes a new request and a new design, so a link to a
design always shows the same building.

## Tables (or collections)

Any database that stores JSON documents works. The simplest fit is Postgres with `jsonb` columns
(Supabase gives this with a free tier) or Firestore. The design file is stored whole in one column;
the other columns are copies of a few fields so lists and the map can be searched without opening
every file.

```
requests
  id            text primary key        -- request.id
  created_at    timestamptz
  mode          text                    -- dream | build
  housing_type  text
  body          jsonb                   -- the whole request

jobs
  id            text primary key
  request_id    text references requests(id)
  status        text                    -- queued | running | done | failed
  progress      real                    -- 0 to 1
  message       text                    -- shown to the user, e.g. "Laying out floor 3"
  design_id     text                    -- set when done
  error         text                    -- set when failed, written for the user
  updated_at    timestamptz

designs
  id            text primary key        -- design.id
  request_id    text references requests(id)
  schema        text                    -- "terrasim.design/2"
  created_at    timestamptz
  housing_type  text
  title         text
  lng           double precision        -- placement.origin, for finding designs on the map
  lat           double precision
  listed        boolean default false   -- true only for published build listings
  body          jsonb                   -- the whole design (render file)

estimates
  design_id     text primary key references designs(id)
  body          jsonb
```

Builder contact details (`request.builder`) stay inside `requests.body` and are never returned by the
public endpoints. Listings show the builder's name and company only.

## Endpoints the website calls

Base URL goes in `frontend/js/config.js` (`apiBaseUrl`). Errors are any non-2xx with
`{ "message": "..." }` written for the user.

| Call | Does |
|---|---|
| `POST /designs` | Body: a request. Saves it, starts Gemma, returns `202 { "jobId": "..." }`. |
| `GET /designs/jobs/{jobId}` | Returns the job: `{ status, progress, message, designId, error }`. The website polls it every 2 seconds. |
| `GET /designs/{id}` | Returns the stored design file, unchanged. |
| `GET /designs/{id}/estimate` | Returns the stored estimate. |
| `GET /listings` | Returns `[{ design, estimate, builder: { name, company } }]` for designs with `listed = true`. |
| `POST /designs/{id}/publish` | Body: `{ permission: true }`. Sets `listed = true` for a `build` design. |
| `POST /designs/{id}/inquiries` | Body: `{ name, email, message }`. Forwards a buyer's message to the builder. |

## Order of events

1. The user fills the form. The website checks every required box, builds the request and sends
   `POST /designs`.
2. The server saves the request, creates a job (`queued`) and passes the request to Gemma.
3. Gemma returns a design and an estimate. The server checks `design.schema`, saves both, and marks
   the job `done` with the `designId`. If Gemma fails or returns a file that doesn't match the
   contract, the job is `failed` with a plain message.
4. The website sees `done`, loads `GET /designs/{id}`, checks the file, and draws it on the map.
5. Later visits (My sites, share links, the catalog) load the same stored design by id and draw it
   again. Nothing is generated twice.

## Until the database exists

- `apiBaseUrl` stays empty, so sending fails with a clear "not connected yet" message.
- The website saves sites, briefs and any design it has drawn in the browser (`localStorage`), so
  My sites still works on one device. These copies use the same shapes as above, so moving them to
  the database later is a straight copy.
- The one sample house in `frontend/fixtures/mock-house/` stands in for a stored design, and is
  labelled as a sample wherever it appears.

## Decisions for the backend team

1. Which database (Postgres/Supabase or Firestore are the easy choices).
2. Whether Gemma is called by the server in the background (the job flow above) or answers in one
   request. The job flow is recommended because a whole apartment building takes a while.
3. Whether accounts are needed. Without them, "My sites" stays per browser and private designs are
   reachable only by their link.
