# TerraSim

_Formerly SpaceForge._

TerraSim lets a user draw/highlight an area on a map — an empty city lot, a hillside, any plot of land — and uses an AI model (Gemma, via Google's hosted AI API) to generate a house design for that site. Each generated design is stored along with predicted cost, materials, and cost-over-time projections, so other users can browse past designs, see the numbers behind them, and message the developer directly if they want to buy or build one.

## Core idea

1. **Select a site** — user highlights a region on an interactive map (specific map provider TBD, see [AGENT.md](AGENT.md)).
2. **Describe the house** — user provides inputs: style, size, number of rooms/floors, budget, materials preference, etc.
3. **Generate** — the selected area + inputs are sent to Gemma (via Google's hosted AI API) to produce a house design for that specific site.
4. **Predict** — the system stores/derives predictions: estimated build cost, materials list, and projected cost over time (maintenance, appreciation, etc.).
5. **Browse & contact** — other users can browse generated designs/listings and message the developer directly if they're interested in a specific design.

## Status

Early/hackathon stage. Architecture and integrations are still being decided — see [AGENT.md](AGENT.md) for current decisions, open questions, and how to work on this repo.

## Stack

- **Accounts service:** Go — handles user accounts/auth.
- **API:** Python — the main app API (map/design requests, predictions, inquiries), calls out to Gemma via Google's hosted AI API.
- **Data/analytics:** Python and R — data processing and the cost/materials/cost-over-time prediction models.
- **Frontend:** HTML/CSS/JavaScript, with Rive for interactive/animated UI elements.
- **Map:** provider TBD (Mapbox, Google Maps, or Leaflet/OSM are the candidates)
- **Data store:** TBD — needs to hold users, generated designs, predictions, and contact/inquiry messages

## Getting started

The web interface lives in [frontend/](frontend/). It has no build step; you need Node.js 22 or newer
to serve it.

```bash
cd frontend
npm start            # serves http://localhost:5173
```

Open http://localhost:5173. Click your location marker to fly home, click anywhere else on the globe
to go there, or search for a place. Use **Outline land**, choose what to build, describe it in your
own words, fill in the boxes and send. Until a design service is connected, sending says so and offers
to place the one sample house on your land.

### Run the whole thing: website + Gemma design service

The Go design service in [housecost/](housecost/) also serves the website, so one command runs both
(Go 1.22 or newer):

```bash
cd housecost
go run . -serve        # open http://localhost:8000
```

Put your Gemini API key in `housecost/APIKey.txt` (free at https://aistudio.google.com/apikey); it's
read for each design, so no restart is needed, and it's in `.gitignore`. Designs take a few
minutes (site data plus three Gemma calls); the sending panel shows each step. Finished results are
saved in `housecost/results/`.

### Test the AI (Gemma) in the website

The contract between the website and Gemma is in [contracts/](contracts/): the blank
[baseline.json](contracts/baseline.json), the [field guide](contracts/FIELDS.md), the
[instructions for Gemma](contracts/GEMMA_PROMPT.md) and the [storage plan](contracts/STORAGE.md).

1. Run your design service with CORS allowing `http://localhost:5173`.
2. Open `http://localhost:5173/?api=http://localhost:8000` (your server's address). The site remembers
   it in this browser; `?api=` with nothing after it forgets it. Or set `apiBaseUrl` in
   `frontend/js/config.js`.
3. Outline land, fill in the brief and send. The site posts a `terrasim.design-request/2` to
   `POST /designs` and accepts any of these replies:
   - `{ "design": {...}, "estimate": {...} }`: drawn straight away;
   - `{ "designId": "..." }`: it then loads `GET /designs/{id}` and `GET /designs/{id}/estimate`;
   - `{ "jobId": "..." }`: it polls `GET /designs/jobs/{jobId}` every 2 seconds, showing each
     `message`, until `{ "status": "done", "designId": "..." }` (or `"failed"` with `"error"`).
4. The design is checked against the contract before it's drawn. If it breaks a rule, a panel lists
   exactly which, so the fix can go into Gemma's output.

To check a design file without a server, use **My sites → Open a design file**: it takes a
`terrasim.design/2` JSON file (or a `{ design, estimate }` reply), checks it and draws it where it
stands.

### Tools

- `npm install` then `npm run vendor` refreshes the vendored libraries (MapLibre, three.js, Rive, Motion).
- `npm run rive` rebuilds the Rive animations from `frontend/tools/rive/art/`; open
  http://localhost:5173/lab/rive.html to see them.
- `node tools/flow.mjs` (with the server running) drives the whole flow in a headless browser and saves
  screenshots.

Map tiles and satellite imagery need an internet connection.
