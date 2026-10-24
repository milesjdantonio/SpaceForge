# TerraSim progress

Last updated 2026-10-24. Branch: `Backend-Gemma` (local only, not pushed; it holds Noah's `housecost/`
backend merged with `main`). `main` and `FrontEnd` on GitHub are at `2e7a37f` and don't have the
work below.

## How to run

```bash
cd housecost
go run . -serve          # website + design API on http://localhost:8000
```

The Gemini key goes in `housecost/APIKey.txt` (git-ignored). Opening the site from
`npm start` (:5173) also works: it finds the service on :8000. Windows Smart App Control is on;
`go run` works, but Go test binaries (`go test -c`, and sometimes `go test`) get blocked.

## Done

**Contract** (`contracts/`): `baseline.json`, `FIELDS.md`, `GEMMA_PROMPT.md`, `STORAGE.md`.
- Request: housing type, `brief.designPrompt` (user's own description, required, the base prompt),
  required boxes per type, Advanced options (blank = Gemma decides). `brief.areaM2` may be null
  ("Let Gemma choose the size"; `aiDecides` then includes `areaM2`).
- Design: explicit walls/openings/rooms/stairs/elevators/furniture; **cost is inside the design**
  (`design.cost`: buildCost, breakdown vs budget, materials, overTime, suppliers); `design.site.soil`.
- Coverage: site data is US-only; `GET /api/coverage` and a 422 on `POST /designs` outside it.

**Website** (`frontend/`):
- Brief form with per-box errors, design prompt with style ideas, Advanced menu, area-by-Gemma option,
  coverage alert before sending, imagery-missing notice.
- Renderer for design v2 (map model, plans, walkthrough with furniture/stairs/elevator), contract
  checker with 8 rules (rule 8: building inside the lot), "Open a design file".
- Building can be dragged on the map, only to spots fully inside the lot.
- Loading page: progress bar from the service's real steps, step list (Gemma calls tagged, try N of 3),
  live terminal; glowing grid rises over the lot while it works.
- Map: borders/labels, search, controls, place chip, location marker, intro on the left; zooming all
  the way out (and the Globe button) resets the Earth to its start view.
- Drawing hint bottom-left, draggable by its grip (remembered), with `pin.riv`.
- Rive: forge (generation), types (7 housing drawings), outline demo, pin, mark.

**Backend** (`housecost/`, Noah's pipeline + my additions):
- `server.go`: `-serve` mode, job queue, step tracking with learned durations, log streaming
  (`?since=`), coverage, results saved to `housecost/results/`.
- Reads `designPrompt` and tells Gemma it's the base; soil rules in the program prompt; Gemma chooses
  `areaM2` when null; `design.cost` and `design.site.soil` filled; wording like "modern farmhouse"
  mapped to allowed codes (`closestChoice` in program.go).
- `go test ./...` passes.

## Verified

- Stand-in Gemma: loading page, grid, coverage alert, area option, retries shown.
- Real Gemma (one run): site data + assessment OK; design program failed on style wording → fixed with
  `closestChoice`, **not yet re-run with real Gemma**.
- Not yet seen in a browser: finished building with `design.cost` panel sections, dragging, new hint.

## In progress / next

1. Rooms appropriate per building type (baths, kitchens, common rooms per house/tiny/townhouse/
   duplex/apartment/condo/dorm) — in `housecost/layout.go` + `furnish.go`.
2. Model scale: check the 3D model, plans and walkthrough match real metres.
3. Re-run a real Gemma design end to end; commit; decide with Noah before pushing `Backend-Gemma`.
4. Open question to the user: keep the progress-bar shine animation?
