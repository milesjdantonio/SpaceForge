# TerraSim contract v2: field guide

[baseline.json](baseline.json) is the blank template, with every field present and no values. It has two parts:

- **`request`**: what Gemma gets. The website fills it in from the user's outline and answers.
- **`design`**: what Gemma sends back: the building to draw and, in `design.cost`, what it costs. The website builds the 3D building on the map,
  the floor plans and the walkthrough from this file alone. The same file is saved in the database
  and loaded again later to draw the same building. See [STORAGE.md](STORAGE.md).

The flow:

```
website ──request──▶ Gemma ──design (with its cost)──▶ database ──▶ website renderer
```

The renderer draws exactly what the design file says. It does not guess walls, move rooms or fill
gaps: anything it needs is a field in the file. If the file breaks a rule in this guide, the website
shows an error instead of a broken building.

The instructions Gemma itself gets (what each user answer should mean for the design, and the order
to work in) are built in code by the design service, in `housecost/` (for example `BuildProgramPrompt`
in program.go).

Conventions:

- All lengths are metres, all areas square metres, all money USD. `displayUnits` only changes what
  the user sees.
- Map positions are `[longitude, latitude]`.
- Positions inside the building are `[x, y]` in metres in the building's own frame: x runs along the
  width, y along the depth, y = 0 is the front (the street side), and every point has x ≥ 0 and y ≥ 0
  except a garage, porch or parking area outside the main building.
- Polygons list their corners in order and are not closed (don't repeat the first point).
- In the baseline, an array with one blank item (for example `rooms: [{...}]`) shows the shape of each
  item. Real files have as many items as needed, or `[]` for none.
- In the request, `null` means "the user didn't choose; Gemma decides". In the design and estimate,
  `null` is allowed only where this guide says so.
- Ids are short strings, unique in the whole file: `"U-3B"`, `"L2-R7"`, `"L2-W14"`, `"L2-O5"`.

---

## Part 1: `request` (website → Gemma)

### Top level

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | Always `"terrasim.design-request/2"`. |
| `id` | string | Request id made by the website. Gemma copies it into `design.requestId`. |
| `housingType` | string | `house`, `tiny-home`, `townhouse`, `duplex`, `apartment`, `condo` or `dorm`. Gemma designs the **whole building** for every type. |
| `site` | GeoJSON Feature | The land the user outlined. |
| `brief` | object | The required questions (main form). Each one is its own box; the website won't send until every box that applies is filled. |
| `advanced` | object | The optional questions (Advanced menu at the bottom of the form). `null` or `[]` means Gemma decides. |
| `aiDecides` | string[] | Names of the `advanced` fields the user left for Gemma, for example `["quality", "roofing"]`. Same information as the nulls, listed so a prompt can say it plainly. |
| `mode` | string | Always `dream`: every design is private and shared by link (there are no listings since 2026-10-24). |
| `builder` | null | Kept for older requests; the website no longer collects builder details. |
| `client.displayUnits` | string | `imperial` or `metric`. Display only. |
| `client.createdAt` | string | ISO date and time. |

### `site`

| Field | Meaning |
|---|---|
| `geometry.coordinates` | One closed ring of `[lng, lat]` points (first point repeated at the end, as GeoJSON requires). |
| `properties.areaM2` | Area of the outline. |
| `properties.perimeterM` | Length around the outline. |
| `properties.centroid` | `[lng, lat]` of the middle of the outline. |
| `properties.setbackM` | Distance kept clear from every boundary (currently 3). |

### `brief`: required questions, by housing type

✓ = required box. – = doesn't apply, sent as `null`. A number = fixed by the type, filled in by the website.

| Field | house | tiny-home | townhouse | duplex | apartment | condo | dorm |
|---|---|---|---|---|---|---|---|
| `designPrompt` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `floors` | ✓ 1–3 | ✓ 1–2 | ✓ 2–4 | ✓ 1–3 | ✓ 2–12 | ✓ 2–12 | ✓ 2–12 |
| `areaM2` | ✓ living area | ✓ living area | ✓ per home | ✓ per home | ✓ average per home | ✓ average per home | – |
| `unitCount` | 1 | 1 | ✓ 2–12 | 2 | ✓ 4–200 | ✓ 4–200 | – |
| `bedrooms` | ✓ | ✓ | ✓ per home | ✓ per home | ✓ typical per home | ✓ typical per home | – |
| `bathrooms` | ✓ | ✓ | ✓ per home | ✓ per home | ✓ typical per home | ✓ typical per home | – |
| `residents` | – | – | – | – | – | – | ✓ beds in the building |
| `roomType` | – | – | – | – | – | – | ✓ `single`, `double` or `suite` |
| `budgetUSD` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

- `designPrompt` is the user's own description of the building and its style, 15 to 1,000
  characters, for example "A bright modern farmhouse that opens to the view, with a big kitchen at
  its heart and a quiet office away from the bedrooms." It is the base of what Gemma is asked for:
  style, feel, and anything to keep or avoid all come from here. The numbers in the other boxes
  are firm requirements; where the text and a box disagree, the box wins.
- `areaM2` never includes garages or parking. `null` means the user ticked "Let Gemma choose the size": Gemma
  chooses it (see the program prompt in housecost/program.go), and `aiDecides` includes `"areaM2"`.
- `budgetUSD` is for the whole building. `null` here means the user ticked "No limit"; the website
  never sends an empty budget otherwise.

### `advanced`: optional questions (null = Gemma decides)

| Field | Values | Applies to |
|---|---|---|
| `quality` | `essential`, `standard`, `premium` | all |
| `garage` | cars: `0`–`3` | house, tiny-home, townhouse (per home), duplex (per home) |
| `parkingSpaces` | number, for the whole site | apartment, condo, dorm |
| `structure` | `wood-frame`, `steel-frame`, `concrete`, `mass-timber`, `masonry` | all |
| `cladding` | `board-batten`, `lap-siding`, `brick`, `stucco`, `stone`, `fiber-cement`, `metal-panel`, `timber` | all |
| `roofing` | `asphalt-shingle`, `metal`, `tile`, `slate`, `membrane` | all |
| `priorities` | any of `efficiency`, `maintenance`, `light`, `privacy`, `accessible`, `quiet` | all |
| `extras` | any of `office`, `porch`, `deck`, `basement`, `balconies`, `roof-terrace` | all |
| `unitMix` | counts of `studio`, `oneBed`, `twoBed`, `threeBed`; they add up to `unitCount` | apartment, condo |
| `bathroomSharing` | `private`, `suite` (shared by a few rooms), `hall` (shared per floor) | dorm |
| `commonSpaces` | any of `lobby`, `lounge`, `study`, `gym`, `laundry`, `kitchen`, `bike-storage`, `mail` | apartment, condo, dorm |

Style isn't a choice from a list: the user writes it in `designPrompt`.

---

## Part 2: `design` (Gemma → database → renderer)

A complete example, the sample house, is [frontend/fixtures/mock-house/design.json](../frontend/fixtures/mock-house/design.json).
On the website, **My Builds → Open a design file** loads any design file, checks it against the rules
below and draws it where it stands, so Gemma's output can be checked before the API exists.

### How the building is described

A building is a stack of **levels**. Each level is drawn from four lists, all in building metres:

- **`outline`**: the outer edge of the floor slab. The floor and ceiling fill it.
- **`rooms`**: the named spaces, each a polygon, each tagged with the home it belongs to.
- **`walls`**: every wall to draw, as straight segments. Nothing else becomes a wall.
- **`openings`**: doors, windows and openings, each placed on one wall.

Stairs and elevators are listed once for the whole building, because they connect levels.
The roof, garage, porch, parking and materials are in `exterior`.

### Top level

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | Always `"terrasim.design/2"`. |
| `id` | string | Unique design id. The database stores the file under this id. |
| `requestId` | string | The `request.id` this design answers. |
| `createdAt` | string | ISO date and time. |
| `housingType` | string | Same as the request. |

### `overview`: the words the user reads

| Field | Meaning |
|---|---|
| `title` | Short name, for example "The Bank Gable House" or "Linden Court Apartments". |
| `summary` | One sentence. |
| `description` | One to three short paragraphs. |
| `siteResponse` | One line per fact about this land and what the building does about it, for example "The lot slopes 8% to the east; the ground floor steps down with it." |
| `features` | Short lines, for example "Covered porch at the entry", "Roof terrace for all residents". |
| `cautions` | Things the user must check, for example zoning, height limits, parking rules. |
| `style` | A short name for the style, in Gemma's words, taken from the design prompt, for example "Modern farmhouse". |

### `totals`: the numbers shown on the panel and the catalog

| Field | Meaning |
|---|---|
| `floors` | Storeys above ground. |
| `levelsBelowGround` | Basement levels (usually 0). |
| `unitCount` | Homes in the building (1 for a house; 0 for a dorm). |
| `bedrooms`, `bathrooms` | Totals for the whole building. A half bath (toilet and sink) counts 0.5. |
| `residents` | Beds, for dorms. `null` for other types. |
| `finishedAreaM2` | Total finished area of all homes (or all dorm rooms and suites). |
| `grossAreaM2` | Total floor area including corridors, stairs, lobbies, walls and common rooms. |
| `parkingSpaces` | Garage spaces plus parking spaces. |

### `site`, `placement` and `size`: where it stands

| Field | Meaning |
|---|---|
| `site.outline` | The user's outline, copied from the request, `[lng, lat]` points (not closed). |
| `site.areaM2` | Its area. |
| `site.soil` | What the soil survey found under the building and the foundation chosen for it: `{ source, name, uscsClass, bearingPsf, shrinkSwell, depthToBedrockIn, depthToWaterTableIn, foundation, foundationReason, note }`. |
| `placement.origin` | `[lng, lat]` of the building's `[0, 0]` corner on the ground (front left). |
| `placement.xAxisBearingDeg` | Compass bearing of the building's x axis (0 = north, 90 = east). The front faces this bearing minus 90°. |
| `placement.footprint` | The four corners of the `size` rectangle as `[lng, lat]`, in the order (0,0), (W,0), (W,D), (0,D). |
| `size.widthM`, `size.depthM` | The rectangle every level's `outline` fits inside. |
| `size.heightM` | Ground to the highest point of the roof. |

The whole `footprint` (and any garage, porch or parking) must lie inside the site outline, at least
`setbackM` from every boundary. The website checks this (rule 8). Users can drag the building to
another spot inside the outline; the website then updates `placement.origin` and `footprint` in its
own copy.

### `units`: the homes in the building

One item per home. A house has one. A dorm has none (`[]`); its rooms use `unitId: null`.

| Field | Meaning |
|---|---|
| `id` | For example `"U-3B"`. Rooms point to it with `unitId`. |
| `name` | What the user sees, for example "Apartment 3B" or "Townhome 2". For a house, "The house". |
| `kind` | `house`, `studio`, `1-bed`, `2-bed`, `3-bed`, `4-bed`, `townhome`. |
| `levels` | Indexes of the levels it has rooms on, for example `[2]` or `[0, 1, 2]` for a townhome. |
| `entryOpeningId` | The `entry` opening that is this home's front door. |
| `bedrooms`, `bathrooms`, `areaM2` | For this home. |
| `residents` | `null` (only used for dorms). |

### `levels`: one per storey, lowest first

| Field | Meaning |
|---|---|
| `index` | 0, 1, 2, … from the lowest level. With a basement, the basement is 0. |
| `name` | "Basement", "Ground floor", "Floor 2", … |
| `elevationM` | Floor level relative to the ground floor's floor (0 for the ground floor, negative for a basement). |
| `heightM` | Floor to the next floor, usually 2.8–3.2 for homes and 3.5–4.5 for a ground-floor lobby. |
| `ceilingHeightM` | Floor to ceiling, usually `heightM` − 0.3. |
| `outline` | Polygon of the outer edge of this level's floor. Rectangle or any shape made of straight sides (an L, a U, a courtyard). Upper levels may be smaller than lower ones. |
| `rooms` | Every space on this level. |
| `walls` | Every wall on this level. |
| `openings` | Every door, window and opening on this level. |
| `balconies` | Outdoor platforms on this level, or `[]`. |
| `furnishings` | Furniture, or `[]`. |

**`rooms`**

Rooms cover the whole `outline` with no gaps and no overlaps: corridors, halls, closets and
stairwells are rooms too. Room polygons are drawn to the centre lines of their walls, so two
neighbouring rooms share an edge exactly.

| Field | Meaning |
|---|---|
| `id` | For example `"L2-R7"`. |
| `name` | "Kitchen", "Bedroom 2", "Corridor", "Stair A". |
| `type` | One of the room types below. |
| `unitId` | The home it belongs to, or `null` for shared space (corridors, lobby, stairs, common rooms, every dorm room). |
| `polygon` | Corners in building metres. Straight sides only, not self-crossing. |
| `areaM2` | Area of the polygon. |
| `floorFinish` | `wood`, `tile`, `carpet`, `concrete`, `stone` or `vinyl`. |

Room types:

- In homes: `living`, `kitchen`, `dining`, `family`, `entry`, `hall`, `mudroom`, `laundry`, `powder`
  (half bath), `bath`, `office`, `bedroom`, `closet`, `linen`, `pantry`, `storage`, `garage`.
- Shared: `corridor`, `lobby`, `stair`, `elevator`, `common`, `lounge`, `study`, `gym`, `mail`,
  `bike-storage`, `trash`, `mechanical`, `shared-kitchen`, `shared-bath`, `shared-laundry`.
- Dorms: `dorm-room` (sleeping room for `single` or `double`), `suite-common` (the shared living room of
  a suite).

**`walls`**

Every wall the renderer draws is in this list. If two rooms should flow into each other (an open-plan
kitchen and living room), leave the wall out.

| Field | Meaning |
|---|---|
| `id` | For example `"L2-W14"`. |
| `kind` | `exterior` (outer wall), `party` (between two homes, or a home and a corridor, stair or lobby; thick for sound and fire), `interior` (inside a home or a shared area). |
| `x1`, `y1`, `x2`, `y2` | The centre line of the wall, end to end. |
| `thicknessM` | `exterior` 0.3, `party` 0.25, `interior` 0.12 are good defaults. |

Walls run along room edges. Exterior walls run along the level's `outline`. A wall stops where
another wall meets it; walls don't cross each other.

**`openings`**

| Field | Meaning |
|---|---|
| `id` | For example `"L2-O5"`. |
| `kind` | `window`; `door` (ordinary door inside); `entry` (the front door of the building or of a home); `patio` (glass door to the outside or a balcony); `garage` (garage door); `passage` (opening with no door); `cased` (wide opening with no door, 1.2 m or more). |
| `wallId` | The wall it sits in. |
| `offsetM` | Distance from the wall's (x1, y1) end to the near edge of the opening. |
| `widthM` | Width. `offsetM + widthM` is no more than the wall's length. Doors 0.8–0.9 (0.9 for `accessible`), entries 0.9–1.0, building entries 1.8, garage doors 2.5 per car. |
| `sillM`, `headM` | Windows: bottom and top above the floor (for example 0.8 and 2.2). Doors and other kinds: `null` for sill, `headM` 2.1 (2.4 for building entries and garage doors). |
| `connects` | The two sides: two room ids, or a room id and `"outside"`. Every room that isn't open to a neighbour through a missing wall needs at least one door, passage or cased opening. |

**`balconies`**

| Field | Meaning |
|---|---|
| `id` | For example `"L3-B2"`. |
| `unitId` | The home it belongs to, or `null` for a shared terrace. |
| `polygon` | In building metres, outside the level's `outline` (or on top of a lower level's roof for a terrace). |
| `railing` | `glass`, `metal` or `solid`. |

A balcony is reached through a `patio` opening in the exterior wall next to it, with `connects`
set to the room and `"outside"`.

**`furnishings`**

| Field | Meaning |
|---|---|
| `type` | `sofa`, `armchair`, `coffee-table`, `side-table`, `rug`, `media-unit`, `dining-table`, `chair`, `stool`, `counter`, `upper-cabinets`, `island`, `fridge`, `bed`, `nightstand`, `dresser`, `wardrobe`, `desk`, `office-chair`, `bookshelf`, `bench`, `cabinet`, `console`, `shelves`, `toilet`, `vanity`, `bathtub`, `shower`, `washer`, `dryer`, `plant`, `floor-lamp`, `pendant`. |
| `roomId` | The room it stands in. The whole item fits inside that room. |
| `x`, `y` | Centre of the item, in building metres. |
| `w`, `d` | Width (side to side as you face it) and depth (front to back), in metres. |
| `h` | Height, only for `bookshelf` and `cabinet`; otherwise `null`. |
| `rotationDeg` | The way the item's front faces: 0 toward y = 0 (the building's front), 90 toward +x, 180 toward the back, 270 toward −x. A bed's front is its foot; a sofa's front is where you sit. |
| `size` | Beds only: `twin`, `full`, `queen`, `king`. Otherwise `null`. |
| `sink`, `cooktop` | Counters only: `true` to add a sink or cooktop. Otherwise `null`. |
| `double` | Vanities only: `true` for two sinks. Otherwise `null`. |
| `wide` | Pendants only: `true` for a wide shade. Otherwise `null`. |

Every kitchen needs a counter with `sink`, a counter with `cooktop`, and a `fridge`. Every `bath` needs
a `toilet`, a `vanity` and a `shower` or `bathtub`; a `powder` needs a `toilet` and a `vanity`.
Every `bedroom` and `dorm-room` needs a `bed` per resident.

### `stairs`

One item per flight between two levels. A stair that runs up four storeys is three items stacked at
the same `x`, `y`, `widthM`, `depthM`.

| Field | Meaning |
|---|---|
| `id` | For example `"S-A-0"` (stair A, from level 0). |
| `shape` | `switchback` (two flights with a half landing; you get on and off on the same side) or `straight` (one flight; you get on at one side and off at the opposite side). |
| `fromLevel`, `toLevel` | Level indexes; `toLevel` is `fromLevel + 1`. |
| `x`, `y` | The stair rectangle's corner with the lowest x and y. |
| `widthM`, `depthM` | Size along x and along y. A switchback needs about 2.6 × 3.2 for a 3 m storey; a straight stair about 1.0 × 4.2. |
| `accessSide` | The side of the rectangle you step on from: `front` (low y), `back` (high y), `left` (low x) or `right` (high x). That side must face a hall or corridor on both levels. |

The stair rectangle is also a room of type `stair` on both levels it connects (with `unitId` of the
home for a stair inside a home, `null` for a shared stair). The renderer cuts the floor above open over
the stair.

### `elevators`

| Field | Meaning |
|---|---|
| `id` | For example `"E-1"`. |
| `x`, `y`, `widthM`, `depthM` | The shaft rectangle, about 2.0 × 2.2. It is a room of type `elevator` on every level it serves. |
| `levels` | Level indexes it stops at. |
| `doorSide` | `front`, `back`, `left` or `right`; that side faces a lobby or corridor on every level it serves. |

Buildings of three or more floors with `accessible` priority, and all apartment, condo and dorm
buildings of four or more floors, have at least one elevator.

### `exterior`

| Field | Meaning |
|---|---|
| `roof.type` | `gable`, `hip` or `flat`. Apartments, condos and dorms are usually `flat`. |
| `roof.pitch` | Rise over run (0 for flat). |
| `roof.eaveM` | Overhang past the walls (0.1 for flat with a parapet). |
| `roof.ridgeAxis` | `x` or `y`: the direction the ridge runs. `null` for flat. |
| `roof.ridgeHeightM` | Ground to the top of the roof. Equals `size.heightM`. |
| `garage` | `{ cars, polygon, heightM }`, or `null`. A detached or attached garage outside the main `outline` (negative x or y is fine). A garage inside a level's outline is a room of type `garage` instead, with this field still filled in for the map. |
| `porch` | `{ polygon }`, or `null`. |
| `parking` | Outdoor parking areas `{ polygon, spaces, covered }`, or `[]`. |
| `materials.structure`, `cladding`, `roofing` | One of the advanced values each. |
| `materials.palette` | `{ name, hex, use }` items. `use` is one of `walls`, `roof`, `trim`, `windows`, `doors`, `accent`, `interior-walls`, `floors`. The renderer needs at least `walls`, `roof` and `windows`. |

### Rules the renderer checks

The website rejects a design that breaks these, and shows the user which rule failed.

1. Every id is unique in the file, and every reference (`unitId`, `wallId`, `roomId`, `connects`,
   `entryOpeningId`, stair and elevator levels) points to something that exists.
2. Every level's `outline` fits inside `size`. Rooms fill the `outline` with no gaps or overlaps.
3. Every opening fits on its wall: `offsetM + widthM` ≤ wall length.
4. Every room can be reached from a building `entry` through doors, passages, cased openings, missing
   walls, stairs and elevators.
5. Every home has exactly one `entry` opening as its `entryOpeningId`.
6. Stairs connect neighbouring levels and line up at the same rectangle, and their stair rooms exist
   on both levels. Elevators are rooms on every level they serve.
7. `totals` matches the `units` and `rooms` (bedroom, bathroom and area counts).
8. `placement.footprint` lies inside the site outline.

---

## Part 3: `design.cost` (what it costs, inside the design)

The cost travels in the design file, so one file holds everything the website shows. (Older services
sent a separate `terrasim.estimate/1` with `buildCost`, `materials` and `overTime`; the website still
accepts that.)

| Field | Meaning |
|---|---|
| `currency` | `"USD"`. |
| `asOf` | Month the prices are from, `"YYYY-MM"`. |
| `buildCost.low`, `expected`, `high` | Total to build, as a range. |
| `buildCost.perSqFt` | `expected` divided by finished area in square feet. |
| `buildCost.confidence` | `low`, `moderate` or `high`. |
| `buildCost.lines` | Cost breakdown `{ id, name, amount }`, for example foundation, framing, roofing, finishes, systems, site work. The amounts add up to `expected`. |
| `buildCost.assumptions` | Short lines, for example "Excludes land, landscaping and furniture". |
| `materials` | `{ id, name, quantity, unit, unitCost, cost }`, where `cost` = `quantity × unitCost`. |
| `overTime.years` | Usually 30. |
| `overTime.assumptions.inflation`, `appreciation` | Yearly rates as decimals, for example 0.028. |
| `overTime.rows` | One per year from 0 to `years`: `{ year, maintenance, energy, replacements, value }`. Year 0 has zero costs and `value` = `expected`. |
| `overTime.events` | Big one-off costs `{ year, name, amount }`, for example "Replace roof". Their years have `replacements` > 0. |
| `breakdown` | Where the money goes: `materials`, `installedWork`, `labor`, `siteWork`, `overheadAndProfit`, `permitsAndDesign`, `total`, `perSqFt`, `perM2`, `wageFactor` (local wages against the national average), `budgetUSD` and `overBudgetBy` (`null` when within budget). |
| `suppliers` | Building suppliers near the land, nearest first: `{ Name, Type, Address, Phone, Website, Miles }`. |

## Where site data reaches

The site data (USDA soil, USGS elevation and seismic, FEMA flood zones, BLS wages) covers the United
States. The design service answers `GET /api/coverage?lng=…&lat=…` with `{ covered, message }`; the
website asks as soon as land is outlined and blocks sending, with that message, when it isn't covered.
`POST /designs` refuses such land with a 422 and the same message.
