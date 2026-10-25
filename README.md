# TerraSim

_Formerly SpaceForge._

Outline a piece of land on a 3D map, describe what you want to build, and TerraSim designs it for that
land with Gemma (Google's hosted AI model): a full building with floor plans, a 3D model standing
where it would stand, a walkthrough, a build cost, materials and the cost of owning it over time.
It designs houses, tiny homes, townhouses, duplexes, mansions, villas, apartments, condos, dorms and
hotels, and whole neighborhoods and trailer parks with their streets and lots.

## What's where

| Folder | What it is |
|---|---|
| [`website/`](website/) | The site people use: the map, the brief, the 3D models, plans and walkthrough. Plain HTML, CSS and JavaScript (MapLibre, three.js, Rive), no build step. |
| [`design-service/`](design-service/) | The Go service that designs buildings: gathers site data, asks Gemma, lays out the rooms, prices it. It also serves the website, so it's the one thing to deploy. |
| [`storage-service/`](storage-service/) | The Go service for sign-in (Firebase) and saved buildings (Postgres). Optional: without it, the site works and says sign-in isn't available. |
| [`contracts/`](contracts/) | The formats the services share: the design request and design file ([FIELDS.md](contracts/FIELDS.md)), saved buildings ([STORAGE.md](contracts/STORAGE.md)). |
| [`docs/`](docs/) | [Status and what's left](docs/status.md), [running everything locally](docs/running-locally.md), [the storage service's routes](docs/storage-service-api.md), [product notes](docs/product.md), [libraries and data sources](docs/resources.md). |
| [`dev/`](dev/) | Local-only helpers: the Firebase sign-in emulator for [`compose.yaml`](compose.yaml). |
| [`render.yaml`](render.yaml) | The Render setup: one web service running the design service with the website. |

Inside each service, its own README says which file does what.

## Run it on your computer

You need Go 1.22 or newer. The design service serves the website too:

```bash
cd design-service
go run . -serve          # open http://localhost:8000
```

Put your Gemini API key in `design-service/APIKey.txt`, or set the `GEMINI_API_KEY` environment
variable (free key: https://aistudio.google.com/apikey). The key file is git-ignored.

To try the whole flow without a key or waiting on Gemma, use the stand-in:

```bash
go run . -serve -fake    # every Gemma step answers at once; a design takes about 30 s
```

Sign-in and saved buildings need the storage service, Postgres and the sign-in emulator:
[docs/running-locally.md](docs/running-locally.md).

## Put it online (Render)

[`render.yaml`](render.yaml) describes one web service. In Render: **New → Blueprint**, pick this
repository, and set `GEMINI_API_KEY` when it asks. The full steps are in
[docs/status.md](docs/status.md#hosting-on-render).

## Tests

- `go test ./...` in `design-service/` and `storage-service/`.
- `npm test` in `website/`.
