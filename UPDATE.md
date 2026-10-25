# TerraSim: status and what's left

Last updated 2026-10-25. Work happens on `FrontEnd-Refresh`, merged into `main` when teammates need it.
This file replaces the old UPDATE.md to-do list and PROGRESS.md.

## How to run

Three processes, each in its own terminal (details in [BACKEND.md](BACKEND.md)):

```bash
docker compose up -d --build --wait     # Postgres + Firebase Auth emulator (from repo root, after sourcing .env)
cd backend && go run ./cmd/migrate && go run ./cmd/api      # sign-in + saved buildings on :8080
cd housecost && go run . -serve -addr 127.0.0.1:8000        # Gemma design service on :8000
cd frontend && npm start                                    # website on :5173
```

The Gemini key goes in `GEMINI_API_KEY` in `.env` or in `APIKey.txt` (both git-ignored). The site
finds the design service on :8000 by itself. Without the storage API and emulator the site still
works, but Sign in can't be reached (it says so and offers to carry on without an account).

- `housecost/` (Gemma design service, :8000): job queue, step tracking, log streaming, cancel,
  fit check (`POST /api/fit`), coverage, results in `housecost/results/`. No accounts.
- `backend/` (Noah, :8080): Firebase sign-in and private building storage in Postgres. Routes in
  [docs/api.md](docs/api.md); the saved document in [contracts/STORAGE.md](contracts/STORAGE.md).

## Decisions

- **No catalog, listings or inquiries.** Every design is private. Save it, then share it with a builder
  or landowner: Share (next to My Builds) makes a link that carries the building itself, or a file
  for very large ones, and keeps every link made. The brief no longer asks "who it's for".
- **One building per land.** Each saved building has its own land.
- **Trailer park and neighborhood** need a new design format, `terrasim.design/3`: one site holding
  several buildings and roads (agreed; not started). Mansion, hotel and villa fit the current format.
- **Shapes**: Gemma picks the footprint, `rectangle`, `round` or `land`; the user's own words win
  ("make it a circle", "follow the shape of the lot"). Rooms are planned as rectangles, then the outer
  rooms grow out to an ellipse through the plan's corners, or to the land's outline pulled in to the
  setback. Curves are true curves in the design file (FIELDS.md, "Curved walls"); pitched roofs on
  them become cones. A round plan is about 57% larger than its rectangle (the rooms can't shrink
  below their minimums), and the design says so in its cautions.
- **Building axes**: the y axis is x turned 90° counter-clockwise, so the front faces the x-axis
  bearing plus 90° (a true view from above, as the website draws it). The design service used the
  opposite until 2026-10-25; designs saved before then sit mirrored, a depth away from their land.
- **The brief carries over** only the housing type, the Advanced menu and the description; the
  numbers start empty for each new building.
- **Selection**: a clicked building keeps its colours; a thin line on the ground marks it.
- **Generating**: the land locks (corners and Outline new land) until the design arrives or is
  cancelled; the map can still be moved.
- **Moving**: select a building, choose Move beside it; turn by the ring grip (any angle), move by the
  top grip or the roof. It may go past its land while moving (red outline) but Done only keeps spots
  inside; Escape puts it back.
- **Clicking a building** opens its details straight away (cost, materials, plans).
- **Map mouse**: left-drag moves the map; Ctrl + drag turns and tilts (taught on the map); right-drag
  does nothing.
- **Outside the US**: design it anyway; Gemma assumes typical site conditions and the result is
  labelled as estimated. The brief says so up front.
- **"Force the design into the building"** means both: the written description shapes the building
  much more (form, roof, materials, rooms), and the building uses the land better.
- **Errors** always say what happened and offer a next step. When a design fails, a short Gemma
  call writes a recommendation that leads the failure panel, with a button that applies its change.
- **Backend can change** when a feature needs it.

## Done

**2026-10-25 (on `FrontEnd-Refresh`, pushed, not merged into main):**
- Cancel while generating (asks once more; the service stops the job and any Gemma call).
- The land locks while a design is generating.
- Fit check by the design service: the brief places a first version of the building with the real
  placement code, and suggests floors or a size that fits. Buildable area is counted on a grid in
  both, so a spike or sharp corner in an outline no longer breaks it.
- Gemma's recommendation first in the failure panel (`housecost/advise.go`).
- The placement animation waits for the camera, then sweeps the land, pulses a ring and raises the
  building floor by floor through a glowing seam.
- New failure animation (`failed.riv`): the building's windows go dark, it cracks, the floors fall,
  and its outline is left with a warning badge. Fixed `riv.mjs`, which ended every "play, then rest"
  animation after 100 ms (the failure story was never seen).
- Round and land-shaped buildings with curved walls (`housecost/shape.go`, `curve.go`; plans, map
  model and walkthrough draw them).
- House panel: Preview (circles the camera round the building) beside Walk through; Save and
  Share below.
- Fixed the design service's building axes (see Decisions), which mirrored its buildings on the map.
- Walkthrough: drag grabs the view (Street View style); a click on a rug reaches the floor.
- Dining chairs face their tables; storage rooms, closets and pantries are lined with shelves.
- The expanded plan zooms out to 25%.

**Earlier on this branch, merged into main:**
- Size check in the brief (`lib/fit.js`): fits / tight / too big (with a floors suggestion) / small.
- Move and turn (`map/mover.js`, `handle.riv`); `tools/building-drag.mjs` covers it.
- Walkthrough: no longer mirrored; real ground, terrain and neighbouring buildings outside; natural
  field of view; drag turns the way you drag; front doors stand open.
- Map buildings from Overture Maps (OpenStreetMap plus Google, Microsoft and Esri footprints), so
  thinly mapped cities stand in 3D; OpenFreeMap's buildings are the fallback. Buildings on land being
  designed for are hidden.
- Topography: contour lines over the land, a hillshade, and the brief's "lie of the land" (slope,
  rise and fall, which way it drops).
- Share: building links (`lib/share.js`), the Share panel, long-link file fallback; opening a link
  shows the building where it stands.
- Rename buildings; expandable plans (zoom, pan, floors); search as you type with a clear button.
- Intro: three ways to start, location spinner, neon outline on "Click your marker"; compass
  re-centres the globe on you.
- How to guide with Rive scenes (`guide.riv`); button press ripple; failure animation (`failed.riv`)
  and a red crumble of the grid on the map when a design fails.
- Errors explain what happened and offer a next step (`lib/errors.js`), with suggested brief changes
  after a failed design; toasts can carry an action.
- Loading says "Generating Build" and "This may take a while"; step labels without "Gemma 3".
- My Builds rename, "TerraSim" tab title, favicon matching the logo.

**Earlier:** contract v2 (`contracts/`), brief form, renderer (map model, plans, walkthrough),
loading page with live steps, Noah's sign-in, saved buildings and saved scene.

**Tests:** `go test` in `housecost/` and `backend/`; `npm test` in `frontend/` (fit, placement, share,
auth/storage); browser flows `tools/auth-storage.mjs` and `tools/building-drag.mjs`; Rive files with
`node tools/rive/check.mjs`. (Windows Smart App Control sometimes blocks `go test`'s temporary
program; `go test -c -o ../housecost.test.exe . && ../housecost.test.exe` works around it.)

## What's left

**Interface**
- A stairs menu to go up or down, like the elevator's.
- Walkthrough speed for large builds.
- The first outline corner pulsing; a clearer error when outline edges cross.
- Check the open front doors, curved walls and Preview in a real browser (checked headless only).
- Spell and text check across the site; check sign-in end to end.

**Gemma and backend (`housecost/`)**
- Elevation outside the US: fall back from USGS 3DEP to worldwide Terrarium tiles; make soil, flood,
  seismic and wage data optional with stated assumptions; drop the 422; label the design as estimated.
- Mountainside designs: stepped foundations, walkout levels, a floor raised on piers (pillars).
- Gemma following the description more strongly, and using the land better.
- Round plans smaller: clip rooms to a circle of the asked-for area instead of growing them out
  (today a round plan is about 57% larger than its rectangle).
- Speed: cut the materials step's retries (it took 3 tries, about 80 s lost, in the last run).
- Edit a design by prompt (send the current JSON and the change).
- Re-run automatically when cost or materials come back missing.
- More building tools: pillars, bridges, roof terraces; L, U and courtyard plans; curved walls
  inside a building.
- New types: mansion, hotel, villa; then trailer park and neighborhood on `terrasim.design/3`.
- Rooms that suit each building type.
- Run a full design with real Gemma end to end.

**Needs the user**
- Whether the grey patch that sometimes followed a building is gone: it was likely the design
  service's mirrored axes (fixed 2026-10-25). If it's still there, a screenshot.
- Overture's building tiles are a beta source not meant for production traffic: host an extract
  (`pmtiles extract`) before launch.
