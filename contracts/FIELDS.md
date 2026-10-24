# TerraSim contract v2: field guide

[baseline.json](baseline.json) is the blank template, with every field present and no values. It has two parts:

- **`request`**: what the website fills in from the user and sends to Gemma.
- **`design`**: the render file Gemma fills in and sends back. The website draws the building
  (on the map, the floor plans and the walkthrough) from this file alone. The same file is saved in
  the database and loaded again later to draw the same building. See [STORAGE.md](STORAGE.md).

The flow:

```
website ──request──▶ Gemma ──design──▶ database ──design──▶ website renderer
```

The renderer never asks the AI to draw anything. If a field is missing or wrong, the website shows
an error instead of guessing.

Conventions:

- All lengths are metres, all areas square metres, all money USD. `displayUnits` only changes what
  the user sees.
- Map positions are `[longitude, latitude]`.
- Positions inside the building are `[x, y]` in metres in the building's own frame: x runs along the
  width, y along the depth, and y = 0 is the front.
- In the baseline, an array with one blank item (for example `rooms: [{...}]`) shows the shape of each
  item. Real files have as many items as needed.
- `null` in the request means "the user didn't choose; Gemma decides".

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
| `aiDecides` | string[] | Names of the `advanced` fields the user left for Gemma, for example `["style", "roofing"]`. Same information as the nulls, listed so a prompt can say it plainly. |
| `mode` | string | `dream` (private, never listed) or `build` (a builder's public listing). |
| `builder` | object or null | Only for `build`. `permission` must be `true`; the website won't send a listing without it. |
| `client.displayUnits` | string | `imperial` or `metric`. Display only. |
| `client.createdAt` | string | ISO date and time. |

### `site`

| Field | Meaning |
|---|---|
| `geometry.coordinates` | One closed ring of `[lng, lat]` points (first point repeated at the end). |
| `properties.areaM2` | Area of the outline. |
| `properties.perimeterM` | Length around the outline. |
| `properties.centroid` | `[lng, lat]` of the middle of the outline. |
| `properties.setbackM` | Distance kept clear from every boundary (currently 3). |

### `brief`: required questions, by housing type

✓ = required box. – = doesn't apply, sent as `null`. A number = fixed by the type, filled in by the website.

| Field | house | tiny-home | townhouse | duplex | apartment | condo | dorm |
|---|---|---|---|---|---|---|---|
| `floors` | ✓ 1–3 | ✓ 1–2 | ✓ 2–4 | ✓ 1–3 | ✓ 2–12 | ✓ 2–12 | ✓ 2–12 |
| `areaM2` | ✓ living area | ✓ living area | ✓ per home | ✓ per home | ✓ average per home | ✓ average per home | – |
| `unitCount` | 1 | 1 | ✓ 2–12 | 2 | ✓ 4–200 | ✓ 4–200 | – |
| `bedrooms` | ✓ | ✓ | ✓ per home | ✓ per home | ✓ typical per home | ✓ typical per home | – |
| `bathrooms` | ✓ | ✓ | ✓ per home | ✓ per home | ✓ typical per home | ✓ typical per home | – |
| `residents` | – | – | – | – | – | – | ✓ beds in the building |
| `roomType` | – | – | – | – | – | – | ✓ `single`, `double` or `suite` |
| `budgetUSD` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

- `areaM2` never includes garages or parking.
- `budgetUSD` is for the whole building. `null` here means the user ticked "No limit"; the website
  never sends an empty budget otherwise.

### `advanced`: optional questions (null = Gemma decides)

| Field | Values | Applies to |
|---|---|---|
| `style` | `modern`, `farmhouse`, `craftsman`, `cabin`, `mediterranean`, `prairie`, `contemporary`, `brick-traditional` | all |
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
| `notes` | free text, up to 600 characters | all |

---

## Part 2: `design` (Gemma → database → renderer)

Everything the renderer needs. Gemma writes every field; `null` is only allowed where the table says so.
A filled-in house example (older v1 shape, same ideas) is
[frontend/fixtures/mock-house/design.json](../frontend/fixtures/mock-house/design.json).

### Top level

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | Always `"terrasim.design/2"`. |
| `id` | string | Unique design id. The database stores the file under this id. |
| `requestId` | string | The `request.id` this design answers. |
| `createdAt` | string | ISO date and time. |
| `housingType` | string | Same as the request. |
| `title` | string | Short name, for example "The Bank Gable House". |
| `summary` | string | One sentence. |
| `description` | string[] | One to three short paragraphs. |
| `siteResponse` | string[] | How the design answers this land: one fact and what the building does about it, per line. |
| `style` | string | One of the style values. |
| `floors` | number | Storeys above ground. |
| `unitCount` | number | Homes in the building (1 for a house; 0 for a dorm). |
| `bedrooms`, `bathrooms` | number | Totals for the whole building. |
| `residents` | number or null | Beds, for dorms. `null` for other types. |
| `finishedAreaM2` | number | Total finished area, all homes. |
| `grossAreaM2` | number | Total floor area including halls, stairs, lobbies and walls. |

### `site` and `placement`: where it stands

| Field | Meaning |
|---|---|
| `site.outline` | The user's outline, `[lng, lat]` points (not closed). |
| `site.areaM2` | Its area. |
| `placement.origin` | `[lng, lat]` of the building's `[0, 0]` corner on the ground. |
| `placement.xAxisBearingDeg` | Compass bearing of the building's x axis (0 = north, 90 = east). |
| `placement.footprint` | The four outer corners as `[lng, lat]`, used to click the building on the map. |
| `size.widthM`, `size.depthM` | The outer rectangle in metres. Every room fits inside it. |
| `size.heightM` | Ground to the highest point of the roof. |

The website does not move or turn a returned building; it draws it where `placement` says.

### `units`: the homes in the building

One item per home (for a house, one item). Empty `[]` for a dorm.

| Field | Meaning |
|---|---|
| `id` | For example `"U-3B"`. Rooms point to it with `unitId`. |
| `name` | What the user sees, for example "Apartment 3B". |
| `kind` | `house`, `studio`, `1-bed`, `2-bed`, `3-bed`, `4-bed`, `townhome`. |
| `levelIndex` | The level its entry door is on. |
| `bedrooms`, `bathrooms`, `areaM2` | For this home. |
| `residents` | `null` (only used for dorms). |

### `levels`: one per storey, bottom first

| Field | Meaning |
|---|---|
| `index` | 0 for the ground floor, then 1, 2, … |
| `name` | "Ground floor", "Floor 2", … |
| `elevationM` | Floor level above the ground floor (0 for the ground floor). |
| `heightM` | Floor to floor, usually 2.8–3.2. |
| `rooms` | Every room on this storey. |
| `openings` | Doors and windows. |
| `stairs` | Stair outlines. |
| `furnishings` | Furniture, shown in the walkthrough. |

**Rooms**

| Field | Meaning |
|---|---|
| `id` | Unique in the file, for example `"L2R7"`. |
| `name` | "Kitchen", "Bedroom 2", "Corridor". |
| `type` | See the list below. Picks colours, floor finish and where walls go. |
| `unitId` | The home it belongs to, or `null` for shared space (corridors, lobby, stairs, common rooms). |
| `polygon` | Outline as `[x, y]` points in metres. Simple shape, not self-crossing. Rooms on a level don't overlap. |
| `areaM2` | Area of the polygon. |

Room types: `living`, `kitchen`, `dining`, `family`, `entry`, `mudroom`, `laundry`, `powder`, `office`,
`bedroom`, `bath`, `closet`, `linen`, and for larger buildings `corridor`, `lobby`, `elevator`,
`stair-core`, `common`, `study`, `gym`, `mail`, `storage`, `mechanical`, `trash`, `bike-storage`,
`dorm-room`.

**Openings**: straight segments lying on walls.

| Field | Meaning |
|---|---|
| `kind` | `window`, `entry` (front door of the building or a home), `patio` (glass door), `garage`, `interior` (door inside), `passage` (opening with no door). |
| `x1`, `y1`, `x2`, `y2` | The two ends, in metres, on a wall. |
| `sillM`, `headM` | Windows only: bottom and top above the floor. `null` for doors. |

**Stairs**

| Field | Meaning |
|---|---|
| `polygon` | Rectangle outline of the stair. About 2.6 m by 3.2 m fits a 3 m floor height. |
| `direction` | `up` on the lower level, `down` on the level above, at the same outline. A middle floor of a taller building has both an `up` and a `down` item at the same outline. |

**Furnishings**: optional; an empty `[]` is fine.

| Field | Meaning |
|---|---|
| `type` | `sofa`, `armchair`, `coffee-table`, `side-table`, `rug`, `media-unit`, `dining-table`, `chair`, `stool`, `counter`, `upper-cabinets`, `island`, `fridge`, `bed`, `nightstand`, `dresser`, `wardrobe`, `desk`, `office-chair`, `bookshelf`, `bench`, `cabinet`, `console`, `shelves`, `toilet`, `vanity`, `bathtub`, `shower`, `washer`, `dryer`, `plant`, `floor-lamp`, `pendant`. Unknown types are skipped. |
| `x`, `y` | Centre of the item, in metres. |
| `w`, `d` | Width and depth in metres. |
| `h` | Height, only for `bookshelf` and `cabinet`; otherwise `null`. |
| `rotationDeg` | 0 faces the front of the building (y = 0), 90 faces +x, 180 the back, 270 −x. |
| `size` | Beds only: `twin`, `full`, `queen`, `king`. |
| `sink`, `cooktop` | Counters only: `true` to add a sink or cooktop. |
| `double` | Vanities only: `true` for two sinks. |
| `wide` | Pendants only: `true` for a wide shade. |

### Garage, porch, roof, materials

| Field | Meaning |
|---|---|
| `garage` | `{ cars, polygon }` in building metres, or `null`. May sit outside the main rectangle (negative x is fine). |
| `porch` | `{ polygon }`, or `null`. |
| `roof.type` | `gable`, `hip` or `flat`. Apartments, condos and dorms usually `flat`. |
| `roof.pitch` | Rise over run (0 for flat). |
| `roof.eaveM` | Overhang. |
| `roof.ridgeAxis` | `x` or `y`, the direction the ridge runs. |
| `roof.ridgeHeightM` | Ground to ridge. |
| `materials.structure`, `cladding`, `roofing` | One of the advanced values. |
| `materials.palette` | `{ name, hex, use }` items. The 3D model colours walls from an item whose `use` contains "wall", the roof from "roof", and window frames from "window" or "trim". |
| `features` | Short lines the user sees, for example "Covered porch at the entry". |
| `cautions` | Things to check, for example zoning or height limits. |

### Rules the renderer relies on

These are the same rules as [GEMMA.md](../GEMMA.md) section 2, extended to whole buildings.

1. **Walls come from room outlines.** A wall is drawn along every room edge. Between two open-plan
   rooms (`living`, `kitchen`, `dining`, `family`) inside the same home there is no wall.
2. **Every closed room needs a door**: an `interior` or `passage` opening on one of its edges.
3. **Halls**: in a house, space between rooms is walkable hall and doesn't need to be a room. In
   larger buildings, draw corridors as `corridor` rooms with `unitId: null`.
4. **Each home has one `entry` opening** onto a corridor, lobby or the outside.
5. **Exterior openings** lie on the outer walls (x = 0, x = width, y = 0, y = depth), or they won't
   show on the 3D model.
6. **Stairs and elevators line up** floor to floor at the same outline. The foot and the top of each
   stair are on its low-y side, so that side should face a corridor or hall.
7. **Every room fits inside `size`**, except the garage and porch.

### Output two: the estimate

Unchanged: `terrasim.estimate/1`, described in [GEMMA.md](../GEMMA.md) section 3. Its `designId`
matches `design.id`.
