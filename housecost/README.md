# housecost (Go)

Turns a TerraSim **design request** (the website's `request` JSON, see FIELDS.md) into a
drawable **design**, a priced **estimate**, and a **report** with the site data, the materials
list with quantities, the cost build-up and nearby suppliers. Standard library only.

## Run

```
go run . -request request.example.json                 # writes request.example.result.json
go run . -request my_request.json -out my_result.json
go run . -request my_request.json -model <model> -thinking low
go test ./...                                          # offline tests, all 7 housing types
```

The Gemini API key is read from `APIKey.txt` (this folder or any parent folder) or `GEMINI_API_KEY`.
Without `-request`, the older interactive wizard (`-inputs inputs.json`) still works.

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
(up to 3 tries). CLI raw replies are saved in `gemma_log/`; server mode disables reply files.

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

## Private worker mode

`go run . -serve -addr 127.0.0.1:8000` runs a private computation service. Set the same
random GENERATION_SERVICE_TOKEN (at least 32 characters) in this process and the
account API. POST /internal/generate requires that service token and streams NDJSON
progress/result frames. The authenticated account API owns jobs, recovery and SQL
persistence; this service has no local HTTP job queue or result files. The retired
/api/designs endpoints are unavailable. CLI request/file-output mode is unchanged.
See [BACKEND.md](../BACKEND.md) for the complete setup.
