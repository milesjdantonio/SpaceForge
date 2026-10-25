package main

// Program: every decision the layout and estimate are built from. User choices
// come from the request; Gemma fills the rest (and writes the overview text).

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

type Program struct {
	HousingType     string
	Floors          int
	AreaM2          float64
	AreaFromGemma   bool // the user left the size to Gemma
	UnitCount       int
	Bedrooms        int
	Bathrooms       float64
	Residents       int
	RoomType        string
	Style           string
	Quality         string
	Structure       string
	Cladding        string
	Roofing         string
	RoofType        string
	RoofPitch       float64
	GarageCars      int
	ParkingSpaces   int
	Priorities      []string
	Extras          []string
	CommonSpaces    []string
	UnitMix         map[string]int
	BathroomSharing string
	Accessible      bool
	Basement        bool
	// Shape of the footprint: rectangle, round or land (shape.go). ShapeFromUser is set when the
	// user's own description asked for it, which Gemma's choice doesn't override.
	Shape         string
	ShapeFromUser bool
	Palette         []PaletteColor
	Text            ProgramText
}

type ProgramText struct {
	Title        string
	Summary      string
	Description  []string
	SiteResponse []string
	Features     []string
	Cautions     []string
}

// DefaultProgram fills Gemma's decisions with sensible defaults: used for the
// first sizing pass (before Gemma is asked) and in tests.
func DefaultProgram(r Request) Program {
	b, a := r.Brief, r.Advanced
	ht := sv(r.HousingType)
	p := Program{HousingType: ht, Floors: iv(b.Floors), AreaM2: fv(b.AreaM2), UnitCount: iv(b.UnitCount),
		Bedrooms: iv(b.Bedrooms), Bathrooms: fv(b.Bathrooms), Residents: iv(b.Residents), RoomType: sv(b.RoomType),
		Style: or(sv(a.Style), "contemporary"), Quality: or(sv(a.Quality), "standard"),
		Structure: or(sv(a.Structure), "wood-frame"), Cladding: or(sv(a.Cladding), "lap-siding"),
		Roofing: or(sv(a.Roofing), "asphalt-shingle"), RoofType: "gable", RoofPitch: 0.5,
		Priorities: a.Priorities, Extras: a.Extras, CommonSpaces: a.CommonSpaces,
		BathroomSharing: or(sv(a.BathroomSharing), "hall")}
	if b.AreaM2 == nil && !roomsNotHomes(ht) {
		// A first guess for sizing; Gemma chooses the real figure in the design program.
		p.AreaM2, p.AreaFromGemma = defaultArea(ht, iv(b.Bedrooms), fv(b.Bathrooms)), true
	}
	switch ht {
	case "house":
		p.UnitCount = 1
		p.GarageCars = 1
		if len(a.Extras) == 0 {
			p.Extras = []string{"porch"}
		}
	case "tiny-home":
		p.UnitCount = 1
	case "townhouse":
		p.GarageCars = 1
	case "duplex":
		p.UnitCount = 2
	case "mansion":
		p.UnitCount = 1
		p.GarageCars = 3
		p.Quality = or(sv(a.Quality), "premium")
		p.RoofType = "hip"
		if len(a.Extras) == 0 {
			p.Extras = []string{"porch", "office", "deck"}
		}
	case "villa":
		p.UnitCount = 1
		p.GarageCars = 2
		p.Style, p.Cladding = or(sv(a.Style), "mediterranean"), or(sv(a.Cladding), "stucco")
		p.Roofing, p.RoofType, p.RoofPitch = or(sv(a.Roofing), "tile"), "hip", 0.4
		if len(a.Extras) == 0 {
			p.Extras = []string{"deck"}
		}
	case "apartment", "condo", "dorm", "hotel":
		p.RoofType, p.RoofPitch, p.Roofing = "flat", 0, or(sv(a.Roofing), "membrane")
		if a.Structure == nil && p.Floors > 5 {
			p.Structure = "concrete"
		}
		if len(a.CommonSpaces) == 0 {
			p.CommonSpaces = []string{"mail", "laundry"}
		}
		p.ParkingSpaces = int(math.Round(float64(p.UnitCount) * 1.0))
		if ht == "dorm" {
			p.ParkingSpaces = p.Residents / 6
		}
		if ht == "hotel" {
			p.ParkingSpaces = int(math.Round(float64(p.UnitCount) * 0.8))
			if len(a.CommonSpaces) == 0 {
				p.CommonSpaces = []string{"restaurant", "lounge", "gym", "laundry"}
			}
		}
	}
	if a.Garage != nil && !isMulti(ht) {
		p.GarageCars = *a.Garage
	}
	if a.ParkingSpaces != nil && isMulti(ht) {
		p.ParkingSpaces = *a.ParkingSpaces
	}
	if ht == "dorm" && b.RoomType != nil && *b.RoomType == "suite" {
		p.BathroomSharing = "suite"
	}
	if ht == "apartment" || ht == "condo" {
		if a.UnitMix.set() {
			p.UnitMix = a.UnitMix.counts()
		} else {
			p.UnitMix = defaultMix(p.UnitCount, p.Bedrooms)
		}
	}
	p.Accessible = contains(p.Priorities, "accessible")
	p.Basement = contains(p.Extras, "basement") && !isMulti(ht)
	p.Shape = ShapeRect
	if s := shapeFromPrompt(sv(b.DesignPrompt)); s != "" {
		p.Shape, p.ShapeFromUser = shapeForType(ht, s), true
	}
	p.Palette = []PaletteColor{{"Warm white", "#EDE8DF", "walls"}, {"Charcoal", "#3A3D40", "roof"},
		{"Black frame", "#1E1E1E", "windows"}, {"Oak", "#B58B5A", "doors"}}
	return p
}

func or(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// defaultMix centres the unit mix on the typical bedroom count.
func defaultMix(n, beds int) map[string]int {
	keys := []string{"studio", "oneBed", "twoBed", "threeBed"}
	b := int(math.Max(0, math.Min(3, float64(beds))))
	m := map[string]int{"studio": 0, "oneBed": 0, "twoBed": 0, "threeBed": 0}
	main := n * 6 / 10
	m[keys[b]] = main
	rest := n - main
	for i := 0; rest > 0; i++ {
		k := b - 1 + 2*(i%2)
		if k < 0 || k > 3 {
			k = b
		}
		m[keys[k]]++
		rest--
	}
	return m
}

// ------------------------------------------------------------------ Gemma: program call

type ProgramReply struct {
	Style, Quality, Structure, Cladding, Roofing string
	RoofType                                     string
	RoofPitch                                    float64
	GarageCars                                   *int
	ParkingSpaces                                *int
	Extras, Priorities, CommonSpaces             []string
	UnitMix                                      map[string]int
	BathroomSharing                              string
	Palette                                      []PaletteColor
	AreaM2                                       *float64 // only when the user left brief.areaM2 to Gemma
	Shape                                        string   // footprintShape: rectangle, round or land
	Text                                         ProgramText
}

func ParseProgram(text string) (ProgramReply, error) {
	m, err := extractJSON(text)
	if err != nil {
		return ProgramReply{}, err
	}
	var pr ProgramReply
	var fe fieldErrs
	str := func(k string, dst *string, required bool) {
		v, ok := m[k]
		if !ok || v == nil {
			if required {
				fe.add("%s: field required", k)
			}
			return
		}
		if *dst, ok = asString(v); !ok {
			fe.add("%s: must be a string", k)
		}
	}
	list := func(k string) []string {
		v, ok := m[k]
		if !ok || v == nil {
			return []string{}
		}
		l, ok := asStrings(v)
		if !ok {
			fe.add("%s: must be a list of strings", k)
		}
		return l
	}
	if v, ok := m["areaM2"]; ok && v != nil {
		if f, ok := asFloat(v); ok {
			pr.AreaM2 = &f
		} else {
			fe.add("areaM2: must be a number or null")
		}
	}
	optInt := func(k string) *int {
		v, ok := m[k]
		if !ok || v == nil {
			return nil
		}
		n, ok := asInt(v)
		if !ok {
			fe.add("%s: must be an integer or null", k)
			return nil
		}
		return &n
	}
	for _, f := range []struct {
		k   string
		dst *string
	}{{"style", &pr.Style}, {"quality", &pr.Quality}, {"structure", &pr.Structure}, {"cladding", &pr.Cladding},
		{"roofing", &pr.Roofing}, {"roofType", &pr.RoofType}, {"title", &pr.Text.Title}, {"summary", &pr.Text.Summary}} {
		str(f.k, f.dst, true)
	}
	str("bathroomSharing", &pr.BathroomSharing, false)
	str("footprintShape", &pr.Shape, false)
	pr.Shape = normalizeShape(pr.Shape)
	if v, ok := m["roofPitch"]; ok && v != nil {
		if f, ok := asFloat(v); ok {
			pr.RoofPitch = f
		} else {
			fe.add("roofPitch: must be a number")
		}
	} else {
		fe.add("roofPitch: field required")
	}
	pr.GarageCars, pr.ParkingSpaces = optInt("garageCars"), optInt("parkingSpaces")
	pr.Extras, pr.Priorities, pr.CommonSpaces = list("extras"), list("priorities"), list("commonSpaces")
	pr.Text.Description, pr.Text.SiteResponse = list("description"), list("siteResponse")
	pr.Text.Features, pr.Text.Cautions = list("features"), list("cautions")
	if v, ok := m["unitMix"].(map[string]any); ok {
		pr.UnitMix = map[string]int{}
		for k, x := range v {
			n, ok := asInt(x)
			if !ok && x != nil {
				fe.add("unitMix.%s: must be an integer", k)
			}
			pr.UnitMix[k] = n
		}
	}
	if v, ok := m["palette"].([]any); ok {
		for i, x := range v {
			o, ok := x.(map[string]any)
			if !ok {
				fe.add("palette[%d]: must be an object", i)
				continue
			}
			var c PaletteColor
			c.Name, _ = asString(o["name"])
			c.Hex, _ = asString(o["hex"])
			c.Use, _ = asString(o["use"])
			pr.Palette = append(pr.Palette, c)
		}
	} else {
		fe.add("palette: field required (a list)")
	}
	normalizeProgram(&pr)
	return pr, fe.err()
}

var hexRe = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// ValidateProgram checks Gemma's program against the request, the site data and building rules.
func ValidateProgram(pr ProgramReply, r Request, s Site, a Assessment) []string {
	var e []string
	add := func(f string, v ...any) { e = append(e, fmt.Sprintf(f, v...)) }
	ht := sv(r.HousingType)
	adv := r.Advanced
	keep := func(field string, user *string, got string, allowed []string) {
		if !contains(allowed, got) {
			add("%s must be one of %v.", field, allowed)
		}
		if user != nil && got != *user {
			add("%s: the user chose %q; keep it.", field, *user)
		}
	}
	keep("style", adv.Style, pr.Style, Styles)
	if pr.Shape != "" && !contains([]string{ShapeRect, ShapeRound, ShapeLand, ShapeL, ShapeU, ShapeCourt}, pr.Shape) {
		add("footprintShape must be rectangle, l, u, courtyard, round or land.")
	}
	if r.Brief.AreaM2 == nil && !roomsNotHomes(ht) {
		lo, hi := areaRange(ht)
		if pr.AreaM2 == nil {
			add("areaM2: the user left the living area to you; give it in m² (%.0f–%.0f for %s).", lo, hi, ht)
		} else if *pr.AreaM2 < lo || *pr.AreaM2 > hi {
			add("areaM2: %.0f m² is outside %.0f–%.0f m² for %s.", *pr.AreaM2, lo, hi, ht)
		}
	}
	keep("quality", adv.Quality, pr.Quality, Qualities)
	keep("structure", adv.Structure, pr.Structure, Structures)
	keep("cladding", adv.Cladding, pr.Cladding, Claddings)
	keep("roofing", adv.Roofing, pr.Roofing, Roofings)
	sameSet := func(field string, user, got, allowed []string) {
		for _, x := range got {
			if !contains(allowed, x) {
				add("%s: %q is not one of %v.", field, x, allowed)
			}
		}
		if len(user) > 0 {
			for _, x := range user {
				if !contains(got, x) {
					add("%s must include the user's choice %q.", field, x)
				}
			}
		}
	}
	sameSet("extras", adv.Extras, pr.Extras, ExtraValues)
	sameSet("priorities", adv.Priorities, pr.Priorities, PriorityValues)
	if isMulti(ht) {
		sameSet("commonSpaces", adv.CommonSpaces, pr.CommonSpaces, CommonValues)
	}

	// roof
	switch pr.RoofType {
	case "flat":
		if pr.RoofPitch > 0.05 {
			add("roofPitch must be 0 for a flat roof.")
		}
	case "gable", "hip":
		if pr.RoofPitch < 0.17 || pr.RoofPitch > 1.0 {
			add("roofPitch for a %s roof should be 0.17–1.0 (2:12 to 12:12), not %g.", pr.RoofType, pr.RoofPitch)
		}
	default:
		add("roofType must be gable, hip or flat.")
	}
	minPitch := map[string]float64{"asphalt-shingle": 0.17, "tile": 0.33, "slate": 0.33, "metal": 0.08, "membrane": 0}
	if mp, ok := minPitch[pr.Roofing]; ok && pr.RoofPitch < mp-1e-9 {
		add("%s roofing needs a pitch of at least %.2f; use a steeper roof or membrane.", pr.Roofing, mp)
	}
	if pr.Roofing == "membrane" && pr.RoofPitch > 0.17 {
		add("membrane roofing is for flat or very low-slope roofs (pitch ≤ 0.17).")
	}
	floors := iv(r.Brief.Floors)
	if floors > 5 && pr.Structure == "wood-frame" {
		add("%d floors is beyond light wood-frame construction (5 storeys); use concrete, steel-frame or mass-timber.", floors)
	}
	if floors > 4 && pr.Structure == "masonry" {
		add("load-bearing masonry above 4 floors isn't practical here; use concrete or steel-frame.")
	}
	if contains(pr.Extras, "basement") && !strings.Contains(a.FoundationType, "basement") {
		add("extras includes basement but the foundation is %s; remove basement (the site assessment ruled it out).", a.FoundationType)
	}
	if !isMulti(ht) {
		if pr.GarageCars == nil || *pr.GarageCars < 0 || *pr.GarageCars > garageMax(ht) {
			add("garageCars must be 0–%d for a %s.", garageMax(ht), ht)
		} else if adv.Garage != nil && *pr.GarageCars != *adv.Garage {
			add("garageCars: the user chose %d; keep it.", *adv.Garage)
		}
	} else {
		if pr.ParkingSpaces == nil || *pr.ParkingSpaces < 0 {
			add("parkingSpaces must be a whole number ≥ 0 for a %s.", ht)
		} else if adv.ParkingSpaces != nil && *pr.ParkingSpaces != *adv.ParkingSpaces {
			add("parkingSpaces: the user chose %d; keep it.", *adv.ParkingSpaces)
		}
	}
	if ht == "apartment" || ht == "condo" {
		sum := 0
		for _, k := range []string{"studio", "oneBed", "twoBed", "threeBed"} {
			sum += pr.UnitMix[k]
		}
		if sum != iv(r.Brief.UnitCount) {
			add("unitMix (studio, oneBed, twoBed, threeBed) must add up to unitCount %d (got %d).", iv(r.Brief.UnitCount), sum)
		}
		if adv.UnitMix.set() {
			for k, v := range adv.UnitMix.counts() {
				if pr.UnitMix[k] != v {
					add("unitMix.%s: the user chose %d; keep it.", k, v)
				}
			}
		}
	}
	if ht == "dorm" {
		want := sv(adv.BathroomSharing)
		if sv(r.Brief.RoomType) == "suite" {
			want = "suite"
		}
		if !contains(SharingValues, pr.BathroomSharing) {
			add("bathroomSharing must be private, suite or hall.")
		} else if want != "" && pr.BathroomSharing != want {
			add("bathroomSharing must be %q.", want)
		}
	}
	uses := map[string]bool{}
	for i, c := range pr.Palette {
		if !hexRe.MatchString(c.Hex) {
			add("palette[%d].hex must look like #A1B2C3.", i)
		}
		if !contains(PaletteUses, c.Use) {
			add("palette[%d].use must be one of %v.", i, PaletteUses)
		}
		uses[c.Use] = true
	}
	for _, u := range []string{"walls", "roof", "windows"} {
		if !uses[u] {
			add("palette needs a %q colour.", u)
		}
	}
	if strings.TrimSpace(pr.Text.Title) == "" || strings.TrimSpace(pr.Text.Summary) == "" {
		add("title and summary are required.")
	}
	if n := len(pr.Text.Description); n < 1 || n > 3 {
		add("description needs 1–3 paragraphs.")
	}
	if len(pr.Text.Features) == 0 {
		add("features needs at least one line.")
	}
	sr := strings.ToLower(strings.Join(pr.Text.SiteResponse, " "))
	if len(pr.Text.SiteResponse) < 2 || !strings.Contains(sr, "slope") {
		add("siteResponse needs at least two lines, including what the building does about the measured slope.")
	}
	if s.Soil.GoverningUSCS != "" && !strings.Contains(sr, "soil") && !strings.Contains(sr, "clay") && !strings.Contains(sr, "sand") && !strings.Contains(sr, "rock") {
		add("siteResponse needs a line on the measured soil (its class, bearing or shrink-swell) and what the building does about it.")
	}
	return e
}

// Merge applies Gemma's reply to the program.
func (p Program) Merge(pr ProgramReply) Program {
	p.Style, p.Quality, p.Structure, p.Cladding, p.Roofing = pr.Style, pr.Quality, pr.Structure, pr.Cladding, pr.Roofing
	if p.AreaFromGemma && pr.AreaM2 != nil {
		p.AreaM2 = *pr.AreaM2
	}
	p.RoofType, p.RoofPitch = pr.RoofType, pr.RoofPitch
	if !p.ShapeFromUser && pr.Shape != "" {
		p.Shape = shapeForType(p.HousingType, pr.Shape)
	}
	if pr.GarageCars != nil && !isMulti(p.HousingType) {
		p.GarageCars = *pr.GarageCars
	}
	if pr.ParkingSpaces != nil && isMulti(p.HousingType) {
		p.ParkingSpaces = *pr.ParkingSpaces
	}
	p.Extras, p.Priorities = pr.Extras, pr.Priorities
	if isMulti(p.HousingType) {
		p.CommonSpaces = pr.CommonSpaces
	}
	if p.HousingType == "apartment" || p.HousingType == "condo" {
		p.UnitMix = pr.UnitMix
	}
	if p.HousingType == "dorm" && pr.BathroomSharing != "" {
		p.BathroomSharing = pr.BathroomSharing
	}
	p.Accessible = contains(p.Priorities, "accessible")
	p.Basement = contains(p.Extras, "basement") && !isMulti(p.HousingType)
	p.Palette = pr.Palette
	p.Text = pr.Text
	return p
}

func briefJSON(r Request) string {
	m := map[string]any{"housingType": sv(r.HousingType), "brief": r.Brief, "advanced": r.Advanced,
		"aiDecides": r.AIDecides}
	b, _ := json.MarshalIndent(m, "", " ")
	return string(b)
}

const programExample = `{
 "style": "<one of the style values>", "quality": "<essential | standard | premium>",
 "structure": "<structure value>", "cladding": "<cladding value>", "roofing": "<roofing value>",
 "roofType": "<gable | hip | flat>", "roofPitch": 0.5,
 "footprintShape": "<rectangle | l | u | courtyard | round | land>",
 "areaM2": "<only if brief.areaM2 is null: the living area per home in m² you choose (the whole home for house/tiny-home/mansion/villa, the average for apartment/condo); otherwise null>",
 "garageCars": "<0-3 for house/tiny-home/townhouse/duplex/villa (per home), 0-4 for a mansion, else null>",
 "parkingSpaces": "<whole site, for apartment/condo/dorm/hotel, else null>",
 "extras": ["<any of: office porch deck basement balconies roof-terrace>"],
 "priorities": ["<any of: efficiency maintenance light privacy accessible quiet>"],
 "commonSpaces": ["<apartment/condo/dorm/hotel: any of lobby lounge study gym laundry kitchen bike-storage mail restaurant>"],
 "unitMix": {"studio": 0, "oneBed": 0, "twoBed": 0, "threeBed": 0},
 "bathroomSharing": "<dorm only: private | suite | hall>",
 "palette": [{"name": "Warm white", "hex": "#EDE8DF", "use": "walls"}, {"name": "...", "hex": "#...", "use": "roof"}, {"name": "...", "hex": "#...", "use": "windows"}],
 "title": "<short name>", "summary": "<one sentence>",
 "description": ["<1-3 short paragraphs>"],
 "siteResponse": ["<one line per site fact and what the building does about it>"],
 "features": ["<short lines>"], "cautions": ["<things the user must check>"]
}`

func BuildProgramPrompt(r Request, s Site, a Assessment, sizing string) string {
	return fmt.Sprintf(`You are the architect for this building. The site has been assessed; now choose the
design program. Code will draw the floor plans and price it from your choices.

USER REQUEST (null = the user left it for you to decide; never change a non-null choice):
%s

SITE (measured):
%s

ASSESSMENT: verdict %s; foundation %s; risks: %s

SIZING: %s

The user's DESCRIPTION (brief.designPrompt, in their own words) is the base of the request. Follow
it: pick the style value closest to what it describes (write the code exactly, for example
farmhouse rather than "modern farmhouse"; the same for cladding and roofing, and put the nuance in the
description), take its feel, materials and colours into the
program, keep or avoid what it asks when the site and numbers allow, and say in the description
how the design follows it (in cautions when something it asks can't be done). Where it disagrees
with a number in brief, the number wins.

SOIL (from the USDA survey, in SITE above: soil.governing_uscs_class, governing_bearing_psf,
shrink_swell, min_depth_to_bedrock_in, min_depth_to_water_table_in) shapes the building, not only the
foundation: low bearing or high shrink-swell favours lighter structures, fewer floors and simple,
compact footprints; shallow bedrock or a high water table rules out basements and favours a slab or
crawlspace; poorly drained soils favour raised floors. Say in siteResponse what the soil is and what
the building does about it.

LIVING AREA: if brief.areaM2 is null, the user left the size to you. Choose areaM2 from the bedrooms,
bathrooms, housing type, budget and lot; use roughly these ranges: house 70–400, tiny-home 15–40,
townhouse and duplex 60–250 per home, apartment and condo 35–150 average per home, villa 150–700,
mansion 450–2000.

BUILDING TYPES: a mansion is a large, formal home: code gives it a formal living room, family room,
library, mudroom and pantry, and a media room and gym when it's big enough; a wine cellar with a
basement. Lean premium. A villa is a relaxed, open home that lives outdoors: terraces, deep shade,
low hip or tile roofs, an open living room onto a terrace (keep "deck" in extras). A hotel is guest
rooms off corridors (brief.unitCount rooms; brief.roomType single = king rooms, double = two-queen
rooms, suite = suites) over a ground floor with a lobby and the common spaces you choose; a
restaurant is the usual one. Hotels are usually flat-roofed.

Decide:
- style, quality, structure, cladding, roofing (keep the user's non-null choices; choose the rest
  to suit the climate, hazards and style). Rough build cost per m² of floor: essential ≈ $1,600,
  standard ≈ $2,100, premium ≈ $2,900. Fit the budget if there is one.
- roofType and roofPitch (rise over run). flat → 0. gable/hip 0.17–1.0. Asphalt shingles need
  ≥ 0.17, tile and slate ≥ 0.33, metal ≥ 0.08; membrane only for flat roofs. Heavy snow favours
  steeper pitches. Apartments, condos and dorms are usually flat.
- footprintShape: round for a circular or oval building with curved outer walls (when the
  description asks for round, circular, curved, oval, a tower, silo or rotunda); land to take the
  shape of the user's land (when it asks to follow or fill the lot's shape); otherwise rectangle.
  A round or land-shaped building has no porch, deck or balconies, and a pitched roof on it
  becomes a cone. For a house, mansion or villa there are also wing plans: l (a main wing and a
  side wing running back from one end), u (side wings at both ends round a yard) and courtyard
  (four wings round an open court, the deck in the court); use them when the description asks
  for an L, U, wings, a courtyard or atrium, or when a wide plan suits the land and the home is
  large (a mansion or villa of 350 m² or more often reads best as an L or U). Say in the
  description how the shape follows the request.
- more than 5 floors can't be wood-frame; more than 4 can't be masonry.
- garageCars (per home) for house/tiny-home/townhouse/duplex/villa/mansion; parkingSpaces for the
  whole site for apartment/condo/dorm/hotel (a hotel needs about 0.8 per guest room).
- extras (must include every extra the user listed; add others only if they suit the site):
  basement only if the foundation is a basement.
- unitMix for apartment/condo (adds up to unitCount; keep the user's mix if given).
- bathroomSharing for dorms (suite if roomType is suite).
- a colour palette with at least walls, roof and windows (hex like #A1B2C3).
- the words the user reads: title, summary, 1-3 description paragraphs, siteResponse (one line per
  measured fact — slope, soil, flood, climate — and what the building does about it), features,
  cautions (zoning, height limits, parking rules, geotechnical tests, anything uncertain).

Reply with ONLY this JSON object (same keys), no markdown, no prose:
%s`, briefJSON(r), siteForPrompt(s), a.Feasibility, a.FoundationType, strings.Join(a.Risks, "; "), sizing, programExample)
}

// sortedKeys is a small helper for stable output.
func sortedKeys(m map[string]int) []string {
	var ks []string
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// areaRange is what Gemma may choose when the user leaves the living area to it (m² per home).
func areaRange(ht string) (float64, float64) {
	switch ht {
	case "tiny-home":
		return 12, 45
	case "townhouse", "duplex":
		return 50, 350
	case "apartment", "condo":
		return 30, 250
	case "villa":
		return 120, 1200
	case "mansion":
		return 350, 3000
	default:
		return 50, 900
	}
}

// defaultArea is the first guess at living area for sizing, before Gemma chooses.
func defaultArea(ht string, bedrooms int, baths float64) float64 {
	switch ht {
	case "tiny-home":
		return 28
	case "townhouse", "duplex":
		return 55 + 25*float64(bedrooms) + 6*baths
	case "apartment", "condo":
		return 35 + 22*float64(bedrooms)
	case "villa":
		return 90 + 45*float64(bedrooms) + 10*baths
	case "mansion":
		return 200 + 60*float64(bedrooms) + 15*baths
	default:
		return 60 + 30*float64(bedrooms) + 8*baths
	}
}

// normalizeProgram maps Gemma's wording onto the allowed values before the checks run, so a reply
// like "modern farmhouse" or "standing seam metal" (natural when the user describes the style in
// their own words) counts as farmhouse or metal instead of costing a retry. Values that match
// nothing are left as they are, and the checks say so. List items Gemma added that match nothing
// (a "view" priority) are dropped; the user's own choices are checked separately and always kept.
func normalizeProgram(pr *ProgramReply) {
	pr.Style = closestChoice(pr.Style, Styles)
	pr.Quality = closestChoice(pr.Quality, Qualities)
	pr.Structure = closestChoice(pr.Structure, Structures)
	pr.Cladding = closestChoice(pr.Cladding, Claddings)
	pr.Roofing = closestChoice(pr.Roofing, Roofings)
	pr.Priorities = onlyKnown(pr.Priorities, PriorityValues)
	pr.Extras = onlyKnown(pr.Extras, ExtraValues)
	for i := range pr.Palette {
		pr.Palette[i].Use = closestChoice(pr.Palette[i].Use, PaletteUses)
	}
}

// closestChoice returns v if it's allowed; otherwise the allowed value found in it that ends last
// ("modern farmhouse" -> farmhouse, the noun), the longest on a tie; otherwise v unchanged.
func closestChoice(v string, allowed []string) string {
	key := strings.ToLower(strings.TrimSpace(v))
	key = strings.NewReplacer(" and ", "-", "&", "-", "_", "-", " ", "-").Replace(key)
	if contains(allowed, key) {
		return key
	}
	best, bestEnd := "", -1
	for _, a := range allowed {
		if i := strings.LastIndex(key, a); i >= 0 {
			if end := i + len(a); end > bestEnd || (end == bestEnd && len(a) > len(best)) {
				best, bestEnd = a, end
			}
		}
	}
	if best == "" {
		// Words like "standing seam metal roof" or "vinyl lap siding": try each allowed value's
		// last word ("siding" -> lap-siding) as a fallback.
		for _, a := range allowed {
			parts := strings.Split(a, "-")
			if last := parts[len(parts)-1]; len(last) > 3 && strings.Contains(key, last) {
				return a
			}
		}
		return v
	}
	return best
}

func onlyKnown(list, allowed []string) []string {
	out := []string{}
	for _, x := range list {
		if c := closestChoice(x, allowed); contains(allowed, c) && !contains(out, c) {
			out = append(out, c)
		}
	}
	return out
}

// keepUserChoices puts back every choice the user made that Gemma's program changed (style,
// materials, garage, parking, the unit mix, and the extras, priorities and common spaces the user
// listed), so that doesn't cost a retry. It returns what it put back, for the log.
func keepUserChoices(pr *ProgramReply, r Request) []string {
	var notes []string
	a := r.Advanced
	str := func(field string, user *string, got *string) {
		if user != nil && *got != *user {
			notes = append(notes, fmt.Sprintf("%s back to the user's %q", field, *user))
			*got = *user
		}
	}
	str("style", a.Style, &pr.Style)
	str("quality", a.Quality, &pr.Quality)
	str("structure", a.Structure, &pr.Structure)
	str("cladding", a.Cladding, &pr.Cladding)
	str("roofing", a.Roofing, &pr.Roofing)
	ht := sv(r.HousingType)
	if a.Garage != nil && !isMulti(ht) && (pr.GarageCars == nil || *pr.GarageCars != *a.Garage) {
		g := *a.Garage
		pr.GarageCars = &g
		notes = append(notes, fmt.Sprintf("garage back to the user's %d", g))
	}
	if a.ParkingSpaces != nil && isMulti(ht) && (pr.ParkingSpaces == nil || *pr.ParkingSpaces != *a.ParkingSpaces) {
		n := *a.ParkingSpaces
		pr.ParkingSpaces = &n
		notes = append(notes, fmt.Sprintf("parking back to the user's %d", n))
	}
	if (ht == "apartment" || ht == "condo") && a.UnitMix.set() {
		if pr.UnitMix == nil {
			pr.UnitMix = map[string]int{}
		}
		for k, v := range a.UnitMix.counts() {
			if pr.UnitMix[k] != v {
				pr.UnitMix[k] = v
				notes = append(notes, fmt.Sprintf("unit mix %s back to the user's %d", k, v))
			}
		}
	}
	include := func(field string, user []string, got *[]string) {
		for _, x := range user {
			if !contains(*got, x) {
				*got = append(*got, x)
				notes = append(notes, fmt.Sprintf("%s: added the user's %q", field, x))
			}
		}
	}
	include("extras", a.Extras, &pr.Extras)
	include("priorities", a.Priorities, &pr.Priorities)
	if isMulti(ht) {
		include("commonSpaces", a.CommonSpaces, &pr.CommonSpaces)
	}
	return notes
}
