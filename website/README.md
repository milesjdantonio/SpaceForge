# Website

The site people use: a 3D map to outline land, the brief, and the finished building drawn where it
stands, with its plans, walkthrough and cost. Plain HTML, CSS and JavaScript; the libraries (MapLibre,
three.js, Rive, PMTiles) are copied into `vendor/`, so there's no build step.

The design service serves this folder (`go run . -serve` in `design-service/`). On its own,
`npm start` serves it on http://localhost:5173 and it finds a design service on :8000.

## What's where

| Path | What it is |
|---|---|
| `index.html`, `css/app.css` | The page and its styles. |
| `js/main.js` | The app: modes (globe, outlining, brief, sending, building), the map's clicks, panels and flows. |
| `js/config.js` | Settings for where it runs: the storage service, Firebase, map and data sources. |
| `js/api/` | Talking to the services: the design request (`request.js`), the design service (`client.js`), saved buildings (`buildings.js`). |
| `js/lib/` | Logic with no drawing: the design and site formats and their checks (`design.js`, `site.js`), housing types and the brief (`housing.js`), the fit check (`fit.js`), placing on land (`place.js`), sharing, saving, errors, geometry and terrain. |
| `js/map/` | The map: the 3D buildings and sites (`house-layer.js`), outlining land (`draw.js`), moving a building (`mover.js`), contours (`topo.js`), search (`places.js`). |
| `js/panels/` | The side panels: the brief, sending, the building's details, My Builds, Share. |
| `js/render/` | Floor plans (SVG) and the cost-over-time chart. |
| `js/walk/` | The walkthrough: the building, its furniture and the real surroundings outside. |
| `js/ui/` | Small parts: icons, toasts, the full-screen plan viewer, account, help. |
| `assets/` | Fonts, icons and the Rive animations (`assets/rive/`). |
| `fixtures/` | The one sample house, for trying the site without a design service. |
| `lab/` | Pages for looking at parts on their own (`lab/rive.html` shows every animation). |
| `tests/` | `npm test`: unit tests. |
| `tools/` | Development scripts: the local server, browser checks (`flow.mjs`, `building-drag.mjs`, `auth-storage.mjs`), screenshots, refreshing `vendor/`, and the Rive animations' source (`tools/rive/`, built with `npm run rive`). |
| `vendor/` | Copied libraries. Refresh with `npm install` then `npm run vendor`. |
