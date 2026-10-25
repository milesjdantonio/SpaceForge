package main

// Materials for the drawn design: Gemma picks catalog items for the whole
// building and per room type; code adds the items the design itself implies
// (stairs, elevators, garage doors, sprinklers, balconies, porch) and works out
// every quantity from the design's geometry.

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
)

const sqftPerM2, ftPerM = 10.7639, 3.28084

type RoomPick struct {
	RoomType  string
	CatalogID string
	Count     *int
	Reason    string
}

type MaterialPlan struct {
	Shell       []Pick
	Rooms       []RoomPick
	Assumptions []string
}

func ParseMaterialPlan(text string) (MaterialPlan, error) {
	m, err := extractJSON(text)
	if err != nil {
		return MaterialPlan{}, err
	}
	var mp MaterialPlan
	var fe fieldErrs
	shell, ok := m["shell"].([]any)
	if !ok {
		fe.add("shell: field required (a list)")
	}
	for _, x := range shell {
		// A broken row is dropped rather than failing the reply: if it mattered, the checks
		// below ask for what's missing.
		o, ok := x.(map[string]any)
		if !ok {
			continue
		}
		var p Pick
		p.CatalogID, _ = asString(o["catalog_id"])
		p.Reason, _ = asString(o["reason"])
		if c, ok := o["count"]; ok && c != nil {
			if n, ok := asInt(c); ok {
				p.Count = &n
			}
		}
		if p.CatalogID == "" {
			continue
		}
		mp.Shell = append(mp.Shell, p)
	}
	rooms, ok := m["rooms"].([]any)
	if !ok {
		fe.add("rooms: field required (a list)")
	}
	for _, x := range rooms {
		o, ok := x.(map[string]any)
		if !ok {
			continue
		}
		var p RoomPick
		p.RoomType, _ = asString(o["roomType"])
		p.CatalogID, _ = asString(o["catalog_id"])
		p.Reason, _ = asString(o["reason"])
		if c, ok := o["count"]; ok && c != nil {
			if n, ok := asInt(c); ok {
				p.Count = &n
			}
		}
		if p.CatalogID == "" || p.RoomType == "" {
			continue
		}
		mp.Rooms = append(mp.Rooms, p)
	}
	if v, ok := m["assumptions"]; ok && v != nil {
		mp.Assumptions, _ = asStrings(v)
	}
	return mp, fe.err()
}

// roomTypeStats: room types in the design with how many and their total floor area.
type rtStat struct {
	Count  int
	AreaM2 float64
}

func roomTypes(d *Design) map[string]rtStat {
	out := map[string]rtStat{}
	for _, lv := range d.Levels {
		for _, r := range lv.Rooms {
			s := out[r.Type]
			s.Count++
			s.AreaM2 += r.AreaM2
			out[r.Type] = s
		}
	}
	return out
}

var concreteFloorTypes = map[string]bool{"garage": true, "stair": true, "elevator": true, "mechanical": true,
	"trash": true, "bike-storage": true, "storage": true}
var wetTypes = map[string]bool{"kitchen": true, "bath": true, "powder": true, "laundry": true, "mudroom": true,
	"shared-bath": true, "shared-laundry": true, "shared-kitchen": true}

func needsStructureItem(structure string) string {
	switch structure {
	case "wood-frame":
		return "framing_lumber"
	}
	return "structural_frame"
}

func shellRequired(p Program) []string {
	req := []string{"roof_underlayment", "roofing", "siding", "windows", "exterior_doors", "insulation_wall",
		"insulation_ceiling", "drywall", "paint", "hvac", "electrical", "plumbing_rough_in", "water_heater",
		needsStructureItem(p.Structure)}
	if p.Structure != "concrete" && p.Structure != "masonry" {
		req = append(req, "sheathing")
	}
	return req
}

func ValidateMaterialPlan(mp MaterialPlan, a Assessment, p Program, d *Design, s Site) []string {
	var e []string
	add := func(f string, v ...any) { e = append(e, fmt.Sprintf(f, v...)) }
	zone, fz := s.Climate.ClimateZone, s.Flood.FloodZone
	hm := Hazards(s)
	rts := roomTypes(d)
	ids, cats := map[string]bool{}, map[string]bool{}
	for i, m := range mp.Shell {
		c, ok := Catalog[m.CatalogID]
		if !ok {
			add("shell[%d]: '%s' is not a catalog id.", i, m.CatalogID)
			continue
		}
		if c.Auto {
			add("shell[%d]: '%s' is added automatically from the design; leave it out.", i, m.CatalogID)
			continue
		}
		if c.PerRoom() {
			add("shell[%d]: '%s' is a per-room item; list it under rooms with a roomType.", i, m.CatalogID)
			continue
		}
		if c.Key == "count" && (m.Count == nil || *m.Count < 1 || *m.Count > 10) {
			add("%s: count must be 1–10.", m.CatalogID)
		}
		ids[m.CatalogID], cats[c.Category] = true, true
	}
	byType := map[string][]string{}
	for i, m := range mp.Rooms {
		c, ok := Catalog[m.CatalogID]
		if !ok {
			add("rooms[%d]: '%s' is not a catalog id.", i, m.CatalogID)
			continue
		}
		if _, ok := rts[m.RoomType]; !ok {
			var have []string
			for t := range rts {
				have = append(have, t)
			}
			sort.Strings(have)
			add("rooms[%d]: room type '%s' isn't in the design (types: %s).", i, m.RoomType, strings.Join(have, ", "))
			continue
		}
		if !c.PerRoom() {
			add("rooms[%d]: '%s' is a whole-building item; list it under shell.", i, m.CatalogID)
			continue
		}
		if c.Key == "count" && (m.Count == nil || *m.Count < 1 || *m.Count > 10) {
			add("rooms[%d] %s: count (per room) must be 1–10.", i, m.CatalogID)
		}
		byType[m.RoomType] = append(byType[m.RoomType], m.CatalogID)
	}

	for _, cat := range shellRequired(p) {
		if !cats[cat] {
			add("Missing required shell category '%s'.", cat)
		}
	}
	if p.Structure != "wood-frame" {
		found := false
		for id := range ids {
			if Catalog[id].Structure == p.Structure {
				found = true
			}
		}
		if !found {
			add("structure is %s: include the matching structural_frame item.", p.Structure)
		}
	}
	cladOK, roofOK := false, false
	for id := range ids {
		c := Catalog[id]
		if c.Category == "siding" && contains(c.Cladding, p.Cladding) {
			cladOK = true
		}
		if c.Category == "roofing" && c.Roofing == p.Roofing {
			roofOK = true
		}
		if c.Category == "roofing" && c.Roofing != p.Roofing {
			add("%s is %s roofing but the design uses %s.", id, c.Roofing, p.Roofing)
		}
	}
	if !cladOK {
		add("cladding is %s: include a siding item for it.", p.Cladding)
	}
	if !roofOK {
		add("roofing is %s: include a roofing item for it.", p.Roofing)
	}

	f := a.FoundationType
	if f == "helical_piles" && !ids["helical_pile"] {
		add("helical_piles foundation needs the helical_pile item.")
	}
	if f != "helical_piles" && f != "none" && !cats["foundation_concrete"] {
		add("%s needs a foundation_concrete item.", f)
	}
	if f == "crawlspace" || f == "pier_and_beam" {
		for _, cat := range []string{"insulation_floor", "vapor_barrier"} {
			if !cats[cat] {
				add("%s needs %s.", f, cat)
			}
		}
	}
	if strings.Contains(f, "basement") {
		for _, cat := range []string{"waterproofing", "foundation_drainage"} {
			if !cats[cat] {
				add("%s needs %s.", f, cat)
			}
		}
	}
	if strings.HasPrefix(fz, "A") && f == "crawlspace" && !ids["flood_vent"] {
		add("Crawlspace in FEMA zone %s needs flood_vent.", fz)
	}
	wallR, ceilR := 0.0, 0.0
	for id := range ids {
		c := Catalog[id]
		switch c.Category {
		case "insulation_wall":
			wallR += c.R
		case "insulation_ceiling":
			ceilR = math.Max(ceilR, c.R)
		}
	}
	if cats["insulation_wall"] && wallR < MinRWall[zone] {
		add("Wall insulation totals R-%g; climate zone %d needs R-%g (add continuous insulation or a thicker batt).", wallR, zone, MinRWall[zone])
	}
	if cats["insulation_ceiling"] && ceilR < MinRCeiling[zone] {
		add("Attic/roof insulation is R-%g; climate zone %d needs R-%g.", ceilR, zone, MinRCeiling[zone])
	}
	for id := range ids {
		if u := Catalog[id].U; u > 0 && u > MaxWindowU[zone] {
			add("%s has U-%g; climate zone %d allows at most U-%g.", id, u, zone, MaxWindowU[zone])
		}
	}
	if zone >= 5 && p.RoofType != "flat" && !ids["ice_water_shield"] {
		add("Climate zone %d needs ice_water_shield.", zone)
	}
	for id := range ids {
		if c := Catalog[id]; zone >= 6 && c.Category == "hvac" && !c.ColdOK {
			add("Climate zone %d needs a cold_ok hvac system.", zone)
		}
	}
	if w, ok := hm["wind"]; ok {
		for id := range ids {
			if c := Catalog[id]; c.Category == "roofing" && c.WindMph < 110 {
				add("Roofing must be rated 110 mph or more for %s.", w)
			}
		}
	}
	_, seismic := hm["seismic"]
	_, windy := hm["wind"]
	if (seismic || windy) && !ids["connectors"] && p.Structure == "wood-frame" {
		add("Add connectors for the measured %s.", map[bool]string{true: "seismic hazard", false: "wind"}[seismic])
	}

	// every room type
	var types []string
	for t := range rts {
		types = append(types, t)
	}
	sort.Strings(types)
	for _, t := range types {
		got := byType[t]
		has := func(pred func(Item) bool) bool {
			for _, id := range got {
				if pred(Catalog[id]) {
					return true
				}
			}
			return false
		}
		if !concreteFloorTypes[t] {
			if !has(func(c Item) bool { return c.Category == "flooring" }) {
				add("room type '%s' needs a flooring item.", t)
			}
			if wetTypes[t] && has(func(c Item) bool { return c.Category == "flooring" && !c.WetOK }) {
				add("room type '%s' is a wet room; its flooring must be wet_ok.", t)
			}
		}
		switch t {
		case "kitchen", "shared-kitchen":
			for _, n := range []struct {
				desc string
				f    func(Item) bool
			}{
				{"per-room cabinets", func(c Item) bool { return c.Category == "cabinets" && c.Key != "count" }},
				{"countertops", func(c Item) bool { return c.Category == "countertops" }},
				{"a sink", func(c Item) bool { return c.Role == "sink" }},
				{"a range", func(c Item) bool { return strings.HasSuffix(c.ID, "_range") }},
				{"a refrigerator", func(c Item) bool { return c.ID == "refrigerator" }},
			} {
				if !has(n.f) {
					add("room type '%s' needs %s.", t, n.desc)
				}
			}
		case "bath", "shared-bath":
			for _, r := range []string{"toilet", "sink", "bathing"} {
				if !has(func(c Item) bool { return c.Role == r }) {
					add("room type '%s' needs a %s fixture.", t, map[string]string{"toilet": "toilet", "sink": "sink/vanity", "bathing": "shower or tub"}[r])
				}
			}
		case "powder":
			for _, r := range []string{"toilet", "sink"} {
				if !has(func(c Item) bool { return c.Role == r }) {
					add("room type 'powder' needs a %s.", map[string]string{"toilet": "toilet", "sink": "sink/vanity"}[r])
				}
			}
		case "laundry", "shared-laundry":
			if !has(func(c Item) bool { return c.ID == "washer" }) || !has(func(c Item) bool { return c.ID == "dryer" }) {
				add("room type '%s' needs a washer and a dryer.", t)
			}
		}
	}
	return e
}

func roomTypeTable(d *Design) string {
	rts := roomTypes(d)
	var types []string
	for t := range rts {
		types = append(types, t)
	}
	sort.Strings(types)
	var b strings.Builder
	b.WriteString("roomType | rooms | total m² | notes\n")
	for _, t := range types {
		note := ""
		switch {
		case concreteFloorTypes[t]:
			note = "concrete floor (no flooring item)"
		case wetTypes[t]:
			note = "wet room: wet_ok flooring"
		}
		switch t {
		case "kitchen", "shared-kitchen":
			note += "; cabinets, countertops, sink, a range, refrigerator"
		case "bath", "shared-bath":
			note += "; toilet, sink/vanity, shower or tub"
		case "powder":
			note += "; toilet, sink/vanity"
		case "laundry", "shared-laundry":
			note += "; washer, dryer"
		}
		fmt.Fprintf(&b, "%s | %d | %.0f | %s\n", t, rts[t].Count, rts[t].AreaM2, strings.TrimPrefix(note, "; "))
	}
	return b.String()
}

const materialsPlanExample = `{"shell": [{"catalog_id": "ready_mix_3000", "count": null, "reason": "slab on CL soil"}, {"catalog_id": "water_heater_hp", "count": 1, "reason": "efficiency priority"}], "rooms": [{"roomType": "kitchen", "catalog_id": "lvp", "count": null, "reason": "wet room"}, {"roomType": "bath", "catalog_id": "toilet", "count": 1, "reason": "required fixture"}], "assumptions": ["<short>"]}`

func BuildMaterialsPlanPrompt(p Program, a Assessment, d *Design, s Site) string {
	zone := s.Climate.ClimateZone
	var hz []string
	for _, h := range hazardsOrdered(s) {
		hz = append(hz, h.desc)
	}
	units := ""
	if p.HousingType != "dorm" {
		units = fmt.Sprintf("%d home(s), ", len(d.Units))
	}
	var shellCat []string
	for _, c := range CatalogList {
		if !c.Auto {
			shellCat = append(shellCat, c.ID)
		}
	}
	_ = shellCat
	return fmt.Sprintf(`You are a construction estimator. The building is designed; choose its materials from the
CATALOG. Code works out every quantity from the drawings and prices them.

BUILDING: %s, %s%d floors, %.0f m² gross. Style %s, quality %s.
Structure %s, cladding %s, roofing %s (%s roof, pitch %g). Foundation %s.
Climate zone %d; flood zone %s; seismic %s; max wind gust %d mph; soil %s (%s shrink-swell).
Hazards: %s. Priorities: %s.

ROOM TYPES IN THE DESIGN (choose items per room type; they apply to every room of that type):
%s
CATALOG (ids only from here; "per room" and "count, per room" items go under rooms; others under shell):
%s
Do NOT list stair flights, elevators, garage doors, sprinklers, balconies or porch: code adds them.

Rules:
- shell must include: %s.
- Structure %s: %s. Cladding %s: a siding item tagged for it. Roofing %s: a roofing item tagged for it.
- Foundation %s: %s.
- Wall insulation r values add up (cavity + continuous) to at least R-%g; roof/attic insulation at
  least R-%g; window u at most %g.
- Climate zone 5+ with a pitched roof: ice_water_shield. Zone 6+: hvac with cold_ok=True.
- Wind gusts over 90 mph: roofing wind_mph 110+, and connectors for wood frames. Seismic D+: connectors.
- Every room type listed needs a flooring item unless its note says concrete; wet rooms need wet_ok.
- Fixtures per room type as noted. Set "count" (1-10, per room) only on count items.
- Quality %s: essential → economical items, premium → better ones.
- Keep each reason to 8 words or fewer.

Reply with ONLY one JSON object in this shape, no markdown, no prose:
%s`, p.HousingType, units, d.Totals.Floors, d.Totals.GrossAreaM2, p.Style, p.Quality, p.Structure, p.Cladding,
		p.Roofing, p.RoofType, p.RoofPitch, a.FoundationType, zone, s.Flood.FloodZone, s.Seismic.SDC,
		s.Climate.MaxWindGustMph, s.Soil.GoverningUSCS, s.Soil.ShrinkSwell, orNone(hz), orNone(p.Priorities),
		roomTypeTable(d), catalogTableNoAuto(), strings.Join(shellRequired(p), ", "), p.Structure,
		map[bool]string{true: "framing_lumber (2x4 or 2x6 studs)", false: "the structural_frame item tagged " + p.Structure}[p.Structure == "wood-frame"],
		p.Cladding, p.Roofing, a.FoundationType,
		map[bool]string{true: "helical_pile", false: "a foundation_concrete item (plus floor insulation and vapor barrier for crawlspace/pier, waterproofing and drainage for basements)"}[a.FoundationType == "helical_piles"],
		MinRWall[zone], MinRCeiling[zone], MaxWindowU[zone], p.Quality, materialsPlanExample)
}

func orNone(l []string) string {
	if len(l) == 0 {
		return "none"
	}
	return strings.Join(l, "; ")
}

func catalogTableNoAuto() string {
	var lines []string
	for _, line := range strings.Split(catalogTable(), "\n") {
		id := strings.TrimSpace(strings.SplitN(line, "|", 2)[0])
		if c, ok := Catalog[id]; ok && c.Auto {
			continue
		}
		if c, ok := Catalog[id]; ok {
			var tags []string
			if c.Structure != "" {
				tags = append(tags, "structure="+c.Structure)
			}
			if len(c.Cladding) > 0 {
				tags = append(tags, "cladding="+strings.Join(c.Cladding, "/"))
			}
			if c.Roofing != "" {
				tags = append(tags, "roofing="+c.Roofing)
			}
			if len(tags) > 0 {
				line += " " + strings.Join(tags, " ")
			}
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// ------------------------------------------------------------------ takeoff from the design

func DesignTakeoff(d *Design, foundation string, roofEave float64) Takeoff {
	t := Takeoff{}
	W, D := d.Size.WidthM, d.Size.DepthM
	m2 := func(x float64) float64 { return x * sqftPerM2 }
	t["footprint_sqft"] = math.Round(m2(W * D))
	t["foundation_perimeter_lf"] = math.Round(2 * (W + D) * ftPerM)
	t["footprint_side_ft"] = math.Sqrt(W*D) * ftPerM
	gross, top, ground := 0.0, 0.0, 0.0
	var extWall, drywall float64
	windows, extDoors, intDoors, garageCars := 0.0, 0.0, 0.0, 0.0
	for _, lv := range d.Levels {
		area := lv.Outline.Area()
		gross += area
		if lv.ElevationM >= -0.01 {
			top = area
			if ground == 0 {
				ground = area
			}
		}
		wallLen := map[string]float64{}
		for _, w := range lv.Walls {
			wallLen[w.ID] = w.Length()
			switch w.Kind {
			case "exterior":
				extWall += w.Length() * lv.HeightM
				drywall += w.Length() * lv.CeilingHeightM
			default:
				drywall += 2 * w.Length() * lv.CeilingHeightM
			}
		}
		for _, r := range lv.Rooms {
			drywall += r.AreaM2 // ceilings
		}
		for _, o := range lv.Openings {
			ext := o.Connects[0] == "outside" || o.Connects[1] == "outside"
			switch o.Kind {
			case "window":
				windows++
				sill := 0.0
				if o.SillM != nil {
					sill = *o.SillM
				}
				extWall -= o.WidthM * (o.HeadM - sill)
			case "entry", "patio":
				extDoors++
				if ext {
					extWall -= o.WidthM * o.HeadM
				}
			case "garage":
				garageCars += math.Round(o.WidthM / 2.5)
				extWall -= o.WidthM * o.HeadM
			case "door":
				intDoors++
			}
		}
	}
	t["gross_floor_sqft"] = math.Round(m2(gross))
	t["ceiling_sqft"] = math.Round(m2(top))
	t["floor_framing_sqft"] = math.Round(m2(ground))
	t["framing_bf"] = math.Round(m2(gross) * 6.5)
	t["ext_wall_sqft"] = math.Round(m2(math.Max(0, extWall)))
	t["drywall_sqft"] = math.Round(m2(drywall))
	t["windows_count"], t["exterior_doors_count"], t["interior_doors_count"] = windows, extDoors, intDoors
	t["garage_door_cars"] = garageCars
	roof := d.Exterior.Roof
	plan := (W + 2*roofEave) * (D + 2*roofEave)
	if roof.Type == "flat" {
		t["roof_sqft"] = math.Round(m2(W * D * 1.05))
	} else {
		t["roof_sqft"] = math.Round(m2(plan * math.Sqrt(1+roof.Pitch*roof.Pitch)))
	}
	t["roof_eave_sqft"] = math.Round(2 * (W + D) * ftPerM * 6)
	t["eave_lf"] = math.Round(2 * (W + D) * ftPerM)
	// framed floors: every level above the lowest, plus the lowest over a crawlspace or piers
	sub := gross - ground
	if foundation == "crawlspace" || foundation == "pier_and_beam" || foundation == "helical_piles" {
		sub = gross
	}
	t["subfloor_sqft"] = math.Round(m2(math.Max(0, sub)))
	t["stair_flights"] = float64(len(d.Stairs))
	stops := 0
	for _, e := range d.Elevators {
		stops += len(e.Levels)
	}
	t["elevator_stops"] = float64(stops)
	balc := 0.0
	for _, lv := range d.Levels {
		for _, b := range lv.Balconies {
			balc += PolyArea(b.Polygon)
		}
	}
	t["balcony_sqft"] = math.Round(m2(balc))
	if d.Exterior.Porch != nil {
		t["porch_sqft"] = math.Round(m2(PolyArea(d.Exterior.Porch.Polygon)))
	}
	for typ, st := range roomTypes(d) {
		k := "rt:" + typ
		t[k+":floor"] = math.Round(m2(st.AreaM2))
		t[k+":count"] = float64(st.Count)
	}
	for _, lv := range d.Levels {
		for _, r := range lv.Rooms {
			per := r.Polygon.Perimeter()
			k := "rt:" + r.Type
			t[k+":wall"] += math.Round(m2(per * lv.CeilingHeightM))
			if r.Type == "kitchen" || r.Type == "shared-kitchen" {
				cab := math.Round(per * ftPerM * 0.35)
				t[k+":cabinet_lf"] += cab
				t[k+":countertop_sqft"] += math.Round(cab * 2.1)
			}
		}
	}
	for k, v := range FoundationTakeoff(foundation, t) {
		t[k] = v
	}
	return t
}

func designQuantity(c Item, count *int, roomType string, t Takeoff) float64 {
	n := 1.0
	if count != nil {
		n = float64(*count)
	}
	var base float64
	switch {
	case c.Key == "count" && roomType != "":
		return n * t["rt:"+roomType+":count"]
	case c.Key == "count":
		return n
	case RoomKeys[c.Key]:
		base = t["rt:"+roomType+":"+strings.TrimPrefix(c.Key, "room_")]
	default:
		base = t[c.Key]
	}
	if base <= 0 {
		return 0
	}
	waste := 0.1
	if strings.HasSuffix(c.Key, "_count") || c.Key == "gross_floor_sqft" || c.Installed || c.Key == "eave_lf" ||
		c.Key == "stair_flights" || c.Key == "elevator_stops" || c.Key == "garage_door_cars" {
		waste = 0
	}
	return math.Ceil(math.Round(base*(1+waste)/c.Cov*1e6) / 1e6)
}

// autoItems lists what the design itself implies.
func autoItems(p Program, t Takeoff) []Pick {
	var out []Pick
	add := func(id, why string) { out = append(out, Pick{CatalogID: id, Reason: why}) }
	if t["stair_flights"] > 0 {
		if isMulti(p.HousingType) {
			add("stair_flight_steel", "egress stairs in the design")
		} else {
			add("stair_flight_wood", "stairs in the design")
		}
	}
	if t["elevator_stops"] > 0 {
		add("elevator_stop", "elevator in the design")
	}
	if t["garage_door_cars"] > 0 {
		add("garage_door", "garage in the design")
	}
	if isMulti(p.HousingType) {
		add("sprinklers", "required for multi-family buildings")
	}
	if t["balcony_sqft"] > 0 {
		add("balcony_deck", "balconies/deck in the design")
	}
	if t["porch_sqft"] > 0 {
		add("porch_deck", "porch in the design")
	}
	if p.RoofType != "flat" {
		add("roof_sheathing", "pitched roof deck")
		add("gutters", "pitched roof eaves")
	}
	if p.Structure == "wood-frame" && t["subfloor_sqft"] > 0 {
		add("subfloor", "wood-framed floors")
	}
	add("trim_allowance", "doors, base, casing and hardware")
	switch p.Cladding {
	case "fiber-cement", "board-batten", "timber":
		add("exterior_paint", "painted cladding")
	case "lap-siding":
		add("exterior_paint", "painted siding (skip if vinyl)")
	}
	return out
}

// floorFinishFor maps a flooring item to the renderer's floorFinish value.
func floorFinishFor(id string) string {
	switch id {
	case "lvp":
		return "vinyl"
	case "porcelain_tile":
		return "tile"
	case "carpet":
		return "carpet"
	case "eng_hardwood", "solid_hardwood", "laminate":
		return "wood"
	}
	return ""
}

func (mp MaterialPlan) String() string {
	b, _ := json.Marshal(mp)
	return string(b)
}
