# Design service (Go)

Turns a TerraSim **design request** (the website's `request` JSON, see FIELDS.md) into a
drawable **design**, a priced **estimate**, and a **report** with the site data, the materials
list with quantities, the cost build-up and nearby suppliers. Standard library only.

## Run

```
go run . -request request.example.json                 # writes request.example.result.json
go run . -request my_request.json -out my_result.json
go run . -request my_request.json -model <model> -thinking low
go run . -serve                                       # the website and the design API on :8000
go run . -serve -fake                                 # the same with a stand-in for Gemma (no key, fast)
go test ./...                                          # offline tests, every housing type
```

The Gemini API key is read from `APIKey.txt` (this folder or any parent folder) or `GEMINI_API_KEY`.
Without `-request`, the older interactive wizard (`-inputs inputs.json`) still works.

## Which file does what

One Go package (`main`); the files group by job.

| Job | Files |
|---|---|
| Entry points | `main.go` (flags, the API key), `server.go` (the website and the design API, the job queue), `wizard.go` (the old terminal questions) |
| The formats | `contract.go` (request, design, estimate types), `report_types.go`, `sites.go` (the site format `terrasim.design/3` as well as site planning) |
| The pipeline | `pipeline.go` (request → design + estimate, step by step), `sites.go` (neighborhoods and trailer parks), `edit.go` (change a design by prompt), `advise.go` (what to change after a failure), `fitcheck.go` (the brief's fit check) |
| Site data | `fetch.go` (US sources), `world.go` (outside the US), `terrain.go` (elevation and slope), `foundation.go` (how the building meets sloping ground), `sitegeo.go` (placing the building on the land) |
| Gemma | `gemma.go` (prompts and the client), `program.go` (the design program), `describe.go` (what the description asks for), `validate.go` (checks on Gemma's answers), `fake.go` (the stand-in for tests and `-fake`) |
| Laying out rooms | `layout.go` (straight plans and corridor buildings), `wings.go` (L, U, courtyard plans and bridges), `manufactured.go` (single- and double-wide homes), `roofterrace.go`, `furnish.go` (furniture) |
| Shapes | `shape.go` (round and land-shaped buildings), `curve.go` (curved edges), `interiorcurve.go` (curved walls inside) |
| The drawable design | `designgen.go` (walls, doors, windows from the rooms), `designcheck.go` (the renderer's rules) |
| Cost | `catalog.go` (materials and rules), `materials2.go`, `materials_fix.go`, `takeoff.go` (quantities), `cost.go`, `estimate.go`, `report.go` |

## Output file

```
{
  "request":  <the request, unchanged>,
  "design":   terrasim.design/2   (levels, rooms, walls, openings, furniture, stairs, elevators, exterior)
  "estimate": terrasim.estimate/1 (build cost range + lines, materials, 30-year cost of ownership)
  "report":   site data, Gemma's assessment, line items with supplier and price source,
              cost summary vs budget, nearby suppliers, warnings
}
```

`design` and `estimate` are `null` when the site isn't buildable; `report.verdict` and
`report.problems` say why (`not_feasible`, `invalid_request` or `error`).

## How it works

1. Check the request against FIELDS.md (required boxes per housing type, allowed values).
2. Size a first version of the building and find where it fits inside the site with the setback,
   front facing the nearest mapped street (OpenStreetMap), trying several layout variants.
3. Fetch site data at the footprint: soil (USDA), elevation and slope (USGS 3DEP), climate
   (Open-Meteo), flood zone (FEMA), seismic category (USGS), local wages (BLS).
4. **Gemma call 1 – site assessment**: verdict, risks, foundation. Checked against the data.
5. **Gemma call 2 – design program**: style, quality, structure, cladding, roofing, roof pitch,
   garage/parking, extras, unit mix, dorm bathrooms, colours, and all the text the user reads.
   Checked against the user's choices and building rules (roof pitch vs roofing, height vs
   structure, basement vs foundation, …).
6. **Code draws the building** (`layout.go`, `designgen.go`, `furnish.go`): rooms that exactly tile
   every level, walls derived from the room edges, doors/windows/entries on those walls, stairs,
   elevators, balconies, porch, parking, furniture. Homes use a hall spine; apartments, condos and
   dorms use a double-loaded corridor with stair/elevator cores.
7. `CheckDesign` enforces all 8 renderer rules plus the furniture rules before anything is written.
8. **Gemma call 3 – materials** per room type and for the shell, from the catalog. Checked
   (insulation vs climate zone, cladding/roofing/structure match, fixtures per room type, …).
9. Quantities come from the drawn design; code prices them, adds labor, site work, overhead and
   permits, builds the cost range and the 30-year table.

Every Gemma answer that fails a check goes back to Gemma with a numbered list of problems
(up to 3 tries). Raw replies are saved in `gemma_log/`.

## Prices

National baseline prices live in `catalog.go`. Put your own quotes in `prices.csv`:

```
catalog_id,unit_price,supplier
ready_mix_3000,172,Roanoke Ready Mix
```

## Files

| File | What it does |
|---|---|
| `contract.go` | request / design / estimate types, request validation |
| `pipeline.go` | the whole request → result flow, site-data fetch, final assembly |
| `sitegeo.go` | lng/lat ↔ metres, setback fit, orientation, parking placement, street lookup |
| `layout.go` | room layouts for all 7 housing types |
| `designgen.go` | walls from rooms, doors/windows, ids, units, totals |
| `furnish.go` | furniture placement |
| `designcheck.go` | the renderer's rules |
| `program.go` | Gemma call 2: prompt, parsing, checks |
| `materials2.go` | Gemma call 3, quantities from the design |
| `estimate.go` | pricing, cost lines, 30-year cost of ownership |
| `catalog.go` | building rules, materials and prices, room types |
| `fetch.go`, `terrain.go` | free data sources, elevation |
| `gemma.go`, `validate.go` | Gemini client, call 1 (assessment) and its checks |

## Limits of this version

- Level outlines and rooms are rectangles; every level has the same outline.
- Roof terraces aren't drawn (a caution says so).
- `exterior.garage` holds one garage; townhomes/duplexes with several list the first, with the total cars.
- Elevation is sampled over a north-aligned box around the footprint.
- Prices are national baselines scaled by local wages, not live quotes.
