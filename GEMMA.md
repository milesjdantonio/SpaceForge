# What the interface needs from the Gemma system

> **Version 2 is in [contracts/](contracts/).** [baseline.json](contracts/baseline.json) is the blank
> request and render file, [FIELDS.md](contracts/FIELDS.md) explains every field (housing types,
> whole apartment and dorm buildings, required and advanced questions, furniture), and
> [STORAGE.md](contracts/STORAGE.md) is the plan for storing designs. The v1 shapes below still
> describe the sample house and the estimate.

TerraSim's Gemma system designs the houses. The web interface only collects the site and brief,
sends them, and shows what comes back. This file is the contract between the two.

**Status:** not connected. With `apiBaseUrl` empty in `frontend/js/config.js`, sending fails with a
clear "not connected yet" message. One sample response lives in `frontend/fixtures/mock-house/` so
every screen can be built and tested; it is labelled as a sample wherever it appears.

## 1. What the interface sends

`POST {apiBaseUrl}/designs` with a `terrasim.design-request/1` body. The interface's
"The request that would be sent" box (after sending fails) shows the exact JSON for any site.

```json
{
  "schema": "terrasim.design-request/1",
  "site": {
    "type": "Feature",
    "geometry": { "type": "Polygon", "coordinates": [[[-82.5928, 35.6400], [-82.5921, 35.6401], [-82.5920, 35.6396], [-82.5927, 35.6395], [-82.5928, 35.6400]]] },
    "properties": { "areaM2": 2212, "perimeterM": 189, "centroid": [-82.59245, 35.63980], "setbackM": 3 }
  },
  "brief": {
    "style": "farmhouse",
    "areaM2": 195,
    "floors": 2,
    "bedrooms": 3,
    "bathrooms": 2,
    "garage": 1,
    "quality": "standard",
    "budget": 650000,
    "priorities": ["light"],
    "extras": [],
    "notes": "Keep the oak by the road",
    "structure": null, "cladding": null, "roofing": null
  },
  "mode": "dream",
  "builder": null,
  "client": { "units": "imperial", "createdAt": "2026-10-24T18:00:00.000Z" }
}
```

| Field | Meaning |
|---|---|
| `site.geometry` | The outline the user drew: a GeoJSON polygon in `[lng, lat]`, closed. |
| `site.properties` | Measurements the interface already shows (for logging and sanity checks). |
| `brief.style` | `modern`, `farmhouse`, `craftsman`, `cabin`, `mediterranean` or `prairie`. |
| `brief.areaM2` | Finished living area, excluding the garage. |
| `brief.priorities` | Any of `efficiency`, `maintenance`, `light`, `privacy`, `accessible`. |
| `brief.extras` | Any of `office`, `porch`, `deck`, `basement`. |
| `brief.quality` | `essential`, `standard` or `premium`. |
| `brief.budget` | USD for the build, or `null` for no limit. |
| `brief.notes` | Free text, up to 600 characters. |
| `structure`, `cladding`, `roofing` | `null` means the design system chooses. |
| `mode` | `dream` (private, never listed) or `build` (a listing). |
| `builder` | For `build`: `{ name, company, email, landowner, permission: true }`. `permission` must be true; the interface won't send a listing without it. |
| `client.units` | Display preference only. Everything in the contract is metres and USD. |

### Responses

- `202 { "jobId": "..." }`: accepted. The interface then polls `GET /designs/jobs/{jobId}` until it
  returns `{ "status": "done", "designId": "..." }` (or `"failed"` with `"error"`). While running it may
  return `{ "status": "running", "progress": 0.4, "message": "Laying out the ground floor" }`; the
  interface prints `message` in its log.
- Errors: any non-2xx with `{ "message": "..." }`. The interface shows the message as is, so write it
  for the user. `429` is shown as "busy, try again".

Then `GET /designs/{id}` returns the design and `GET /designs/{id}/estimate` the numbers (the two
separate outputs below).

## 2. Output one: the design (`terrasim.design/1`)

The structured floor plan. Full example: [frontend/fixtures/mock-house/design.json](frontend/fixtures/mock-house/design.json).

The interface uses it for: the 3D house on the map, the floor plans, the walkthrough, the overview text.

```jsonc
{
  "schema": "terrasim.design/1",
  "id": "string",
  "createdAt": "ISO date",
  "title": "The Bank Gable House",
  "summary": "One sentence.",
  "description": ["Paragraph", "Paragraph"],
  "siteResponse": ["How the design answers this land: one fact and what the house does about it"],
  "style": "farmhouse",
  "floors": 2,
  "bedrooms": 4,
  "bathrooms": 3,
  "finishedAreaM2": 205,

  "site": { "outline": [[lng, lat], ...], "areaM2": 2208 },

  // Where the house stands. The house has its own frame in metres: x along its width, y along its
  // depth, y = 0 being the front. `origin` is the house's (0, 0) corner on the ground.
  "placement": {
    "origin": [lng, lat],
    "xAxisBearingDeg": 94.4,          // compass bearing of the house's x axis
    "footprint": [[lng, lat], ...]    // the four outer corners, used to click the house on the map
  },
  "size": { "widthM": 13.1, "depthM": 8.4, "heightM": 9.4 },

  "levels": [
    {
      "index": 0,
      "name": "Ground floor",
      "elevationM": 0,                // floor level above the ground floor
      "heightM": 3.0,                 // floor to floor
      "rooms": [
        { "id": "L0R0", "name": "Kitchen", "type": "kitchen", "polygon": [[x, y], ...], "areaM2": 16.8 }
      ],
      // Doors and windows as straight segments lying on walls, in house metres.
      "openings": [
        { "kind": "window", "x1": 0.8, "y1": 0, "x2": 2.4, "y2": 0, "sillM": 0.75, "headM": 2.2 },
        { "kind": "entry",  "x1": 6.1, "y1": 8.4, "x2": 7.1, "y2": 8.4 },
        { "kind": "interior", "x1": 3.3, "y1": 4.0, "x2": 4.1, "y2": 4.0 }
      ],
      "stairs": [{ "polygon": [[x, y], ...], "direction": "up" }]
    }
  ],
  "garage": { "cars": 2, "polygon": [[x, y], ...] },   // or null
  "porch": { "polygon": [[x, y], ...] },                // or null
  "roof": { "type": "gable", "pitch": 0.83, "eaveM": 0.45, "ridgeAxis": "x", "ridgeHeightM": 9.4 },
  "materials": {
    "structure": "wood-frame",
    "cladding": "board-batten",
    "roofing": "metal",
    "palette": [{ "name": "Barn white battens", "hex": "#efece4", "use": "walls" }]
  },
  "features": ["Covered porch at the entry"],
  "cautions": ["Check local zoning for setbacks, height limits and lot coverage."]
}
```

Rules the interface relies on:

- **Room polygons** are simple (not self-crossing), in metres, and rooms on a level don't overlap. Any
  shape works; rectangles are fine.
- **Room `type`** picks colours and floor finish in the walkthrough. Known types: `living`, `kitchen`,
  `dining`, `family`, `entry`, `mudroom`, `laundry`, `powder`, `office`, `bedroom`, `bath`, `closet`,
  `linen`. Unknown types still draw.
- **Opening `kind`**: `window`, `entry`, `patio`, `garage`, `interior`, `passage` (a doorless opening).
  Exterior openings must lie on the outer walls (x = 0, x = width, y = 0, y = depth) to show on the 3D
  model.
- **Walls come from room outlines.** The walkthrough draws a wall along every room edge, except:
  between two open-plan rooms (`living`, `kitchen`, `dining`, `family`) there is no wall, and where an
  open-plan room meets space that isn't a room (a hall), the interface leaves a wide cased opening. Any
  other room is reached only through its `interior`/`passage` openings, so every closed room needs one.
- **Halls** don't need to be rooms: the floor covers the whole footprint, so space between rooms is
  walkable hall.
- **Stairs** are given once, on the lower level, as their outline (`direction: "up"`), plus a matching
  outline on the upper level (`direction: "down"`). The interface builds a two-flight switchback inside
  the outline: the foot and the top are both on the outline's low-y side, so that side should face a
  hall. An outline about 2.6 m by 3.2 m fits a 3 m floor-to-floor height.
- **Roof `type`**: `gable`, `hip` or `flat`. `pitch` is rise over run.
- **Palette `use`**: the 3D model colours walls from an item whose `use` contains "wall", the roof
  from "roof", and window frames from "window" or "trim".
- `placement` is for the drawn site. The interface does not move or rotate a returned house.

## 3. Output two: the numbers (`terrasim.estimate/1`)

Separate from the design. Full example: [frontend/fixtures/mock-house/estimate.json](frontend/fixtures/mock-house/estimate.json).

```jsonc
{
  "schema": "terrasim.estimate/1",
  "designId": "string",
  "currency": "USD",
  "asOf": "2026-10",
  "buildCost": {
    "low": 446000, "expected": 514000, "high": 602000,
    "perSqFt": 233,
    "confidence": "moderate",          // low | moderate | high
    "lines": [{ "id": "foundation", "name": "Foundation", "amount": 45000 }],
    "assumptions": ["Excludes land, landscaping and furniture"]
  },
  "materials": [
    { "id": "lumber", "name": "Framing lumber", "quantity": 14100, "unit": "board ft", "unitCost": 1.05, "cost": 14805 }
  ],
  "overTime": {
    "years": 30,
    "assumptions": { "inflation": 0.028, "appreciation": 0.034 },
    "rows": [{ "year": 0, "maintenance": 0, "energy": 0, "replacements": 0, "value": 514000 }],
    "events": [{ "year": 24, "name": "Replace roof", "amount": 23000 }]
  }
}
```

- `lines` add up to `expected`.
- `rows` run from year 0 to `years`, one per year. The interface charts `maintenance + energy +
  replacements` per year and highlights years with `replacements > 0`.

## 4. What I need back from you

1. The API base URL (or local address) to put in `frontend/js/config.js`, and whether it's the job
   flow above or a single synchronous response.
2. One real design and estimate from the Gemma system for any site, saved next to the sample as
   `frontend/fixtures/gemma-real/design.json` and `estimate.json`, so I can check the interface
   against real output.
3. Anything in these shapes the Gemma system can't produce, or produces differently. The interface is
   easier to adapt than the model.
