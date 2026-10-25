# TerraSim progress

Last updated 2026-10-24. Branch: `FrontEnd-Refresh`, cut from `main` at `a28dbd3` (same as
`origin/main`). `Backend-Gemma` and Noah's `backend` are both merged into `main`. The to-do list for
this branch is [UPDATE.md](UPDATE.md).

## How to run

Three processes, each in its own terminal (details in [BACKEND.md](BACKEND.md)):

```bash
docker compose up -d --build --wait     # Postgres + Firebase Auth emulator (from repo root, after sourcing .env)
cd backend && go run ./cmd/migrate && go run ./cmd/api      # sign-in + saved buildings on :8080
cd housecost && go run . -serve -addr 127.0.0.1:8000        # Gemma design service on :8000
cd frontend && npm start                                    # website on :5173
```

The Gemini key goes in `GEMINI_API_KEY` in `.env` or in `APIKey.txt` (both git-ignored). The site
finds the design service on :8000 by itself. Without the storage API and emulator, the site still
works but Sign in fails. Windows Smart App Control is on; `go run` works, Go test binaries sometimes
get blocked.

## Two Go services

- `housecost/` (Gemma design service, :8000): job queue, step tracking, log streaming, coverage,
  results in `housecost/results/`. No accounts.
- `backend/` (Noah, :8080): Firebase ID-token auth and private building storage in Postgres JSONB.
  `GET /api/me`, `POST/GET/PUT/DELETE /api/buildings`. No sharing, publishing or public routes.
  Routes in [docs/api.md](docs/api.md); the saved document is in [contracts/STORAGE.md](contracts/STORAGE.md).

## Done

**Contract** (`contracts/`): `baseline.json`, `FIELDS.md`, `GEMMA_PROMPT.md`, `STORAGE.md`.
- Request: housing type, `brief.designPrompt` (required, the base prompt), required boxes per type,
  Advanced options (blank = Gemma decides), `brief.areaM2` may be null (Gemma chooses).
- Design: walls/openings/rooms/stairs/elevators/furniture; cost inside the design (`design.cost`);
  `design.site.soil`. Site data is US-only (`GET /api/coverage`, 422 outside it).
- Saved building: `{ schema: 'terrasim.saved-building/1', design, estimate, site, placement }`,
  one SQL record per building, named after `design.overview.title`.

**Website** (`frontend/`):
- Brief form, design prompt, Advanced menu, area-by-Gemma, coverage alert, imagery notice.
- Renderer for design v2 (map model, plans, walkthrough), contract checker (8 rules), Open a design file.
- Loading page with real steps, live terminal, glowing grid over the lot.
- Map: globe home, search, controls, place chip, location marker, draggable drawing hint, Rive assets.
- Accounts (Noah): email/password sign-in (`auth.js`, `ui/account.js`), session kept per tab.
- Saved buildings (Noah): signed-in users auto-save each Gemma reply; My Builds lists, reopens and
  deletes them; on sign-in every saved house is drawn on the map and the last view and selection
  come back (`lib/saved-scene.js`). Other saved houses stay visible when one is selected.
- Saving placement (Noah): a saved building's new position saves when a move ends
  (`lib/building-saver.js` keeps saves in order). Picking hits the 3D model, not just the footprint.
- Share site: copies a link with the outline and brief only, never the building.

**Tests**: `go test` in `housecost/` and `backend/`, `npm test` in `frontend/` (auth/storage), and
Playwright flows `tools/auth-storage.mjs` and `tools/building-drag.mjs`.

## Verified

- Stand-in Gemma: loading page, grid, coverage alert, area option, retries shown.
- Real Gemma (one run): site data and assessment OK; design program failed on style wording, fixed
  with `closestChoice` but **not yet re-run with real Gemma**.
- Noah's checks (per BACKEND.md): auth, storage, drag-and-save flows. Not re-run on this branch yet.

## Decisions (2026-10-24, from UPDATE.md)

- **One building per land.** Keep today's model: each saved building has its own land. UPDATE.md's
  "one land, many buildings" is dropped for now.
- **Sharing sends one building**, packed (compressed) into the link: design, placement and land. No
  server or sign-in needed.
- **Neighborhood** is a housing type: one Gemma design holding several houses plus roads, saved and
  shared as one item.
- **New housing types**: mansion, hotel, trailer park, villa, neighborhood.
- **Moving is ours**, replacing Noah's click-then-drag: selecting a house shows a Move button beside
  it; that opens a rotate ring (any angle) and a drag handle on top, both Rive; Done/Esc ends it.
- **Boundaries**: the building may go outside its land while moving; the outline turns red and that
  spot can't be saved.
- **Size check before sending**: a live warning when the brief's building is too big for the
  buildable land or tiny on a huge lot. A warning only; sending is still allowed.
- **"Shadow following the building"**: a dark grey patch near the house, sometimes. Not found in the
  code yet; find it in the running app or ask for a screenshot.
- **Backend can change** when a feature needs it (`housecost/` or `backend/`).
- **Scale** feels off both on the map and in the walkthrough: measure both against the design file
  and real sizes, and fix.
- **"Force the design into the building"** means both: the written description should shape the
  building much more (form, roof, materials, rooms), and the building should use the land better.
- **Clicking a building** should open its details (cost, materials, plans) straight away, not a
  different menu.
- **Outside the US**: send it anyway; Gemma assumes typical site conditions and the result is
  labelled as estimated without local site data.
- **Errors**: every error says what happened and offers a backup option; the design-failed screen
  has its own Rive animation.

## Done on this branch (not committed yet)

- **Size check** (`lib/fit.js`, brief): footprint from the brief (floor area / floors + garage and
  parking) against the buildable land; Fits / Tight / Too big (with a floors suggestion) / Small for
  this land, with a bar. Tests in `tests/fit.test.js`.
- **Move and turn** (`map/mover.js`, `assets/rive/handle.riv`): Move button beside a selected house;
  ring with a turn grip (any angle, Shift snaps 15°), grip above the roof, roof drag, "Front faces"
  angle box, arrow keys and [ ]; red outline and Done disabled outside the land; Escape restores.
  Replaces Noah's second-press drag; `tools/building-drag.mjs` rewritten for it and passing.
  Placement math in `lib/place.js` (`transformPlacement`), tested in `tests/place.test.js`.
- **Walkthrough**: no longer mirrored (world group flips Z; plans already matched the map);
  horizontal drag turns the way you drag; the view outside shows the real ground (Esri imagery on
  Terrarium terrain, 180 m round, flattened under the house) and the map's neighbouring buildings
  (`walk/surroundings.js`).
- **Search** suggests as you type (Photon; Nominatim forbids autocomplete), Enter takes the first;
  an X clears it.
- **Intro**: "Three ways to start" (your marker / anywhere / scroll), as options joined by "or"; the
  marker option is greyed with a spinner until the location is found.
- **How to** (question-mark button by the units): a step-by-step guide with a looping Rive scene per
  step (`assets/rive/guide.riv`, plus outline.riv and forge.riv).
- **Buttons** sink and ripple when pressed (`ui/press.js`).
- **Map drag**: left or right button drag both move the map; Ctrl-drag turns and tilts
  (`rightDragPans` in `map/map.js`; right-drag no longer turns).
- Renamed My sites → My Builds; tab title is just "TerraSim"; favicon now matches the logo mark.

## Still to do (from UPDATE.md and later requests)

- Share a building packed into the link (decided above).
- Plans: expandable close-up. Doors open in the walkthrough. Chairs facing tables. Stairs down menu.
- Walkthrough performance for large builds.
- Nameable buildings; reselecting UX; Rive animation when a building is placed.
- Gemma (in `housecost/`): stronger use of the design prompt, edit-by-prompt on the current JSON,
  re-run when cost/materials are missing, more building tools (pillars, modern, bridges, roofs), the
  five new types, errors that always come with a suggested next step.
- Outline: error when corners cross (exists: "Two edges cross"); first corner pulses; land
  elevation; building outside the US with a "may not be perfect" note.
- Loading text: "Generating Build", "This may take a while", no "Gemma 3".
- Scale of buildings; rooms per type; re-run a real Gemma design; spell/text check; check login.
- Find the grey "shadow" patch.

