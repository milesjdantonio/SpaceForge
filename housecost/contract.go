package main

// TerraSim contract v2 types (see FIELDS.md): request (website → here),
// design and estimate (here → database → renderer).

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

type Pt = [2]float64 // [x, y] in building metres, or [lng, lat] on the map

// ------------------------------------------------------------------ request

type Request struct {
	Schema      string      `json:"schema"`
	ID          *string     `json:"id"`
	HousingType *string     `json:"housingType"`
	Site        SiteFeature `json:"site"`
	Brief       Brief       `json:"brief"`
	Advanced    Advanced    `json:"advanced"`
	AIDecides   []string    `json:"aiDecides"`
	Mode        *string     `json:"mode"`
	Builder     *Builder    `json:"builder"`
	Client      ClientInfo  `json:"client"`
	// asks is what the description plainly asks for, read by code (describe.go).
	asks descAsks
}

type SiteFeature struct {
	Type     string `json:"type"`
	Geometry struct {
		Type        string         `json:"type"`
		Coordinates [][][]*float64 `json:"coordinates"`
	} `json:"geometry"`
	Properties struct {
		AreaM2     *float64   `json:"areaM2"`
		PerimeterM *float64   `json:"perimeterM"`
		Centroid   []*float64 `json:"centroid"`
		SetbackM   *float64   `json:"setbackM"`
		// Streets near the land as [lng, lat] lines, from the website's own map, so the front can
		// face the street without a slow lookup. Optional.
		Streets [][]Pt `json:"streets,omitempty"`
	} `json:"properties"`
}

type Brief struct {
	// The user's own description of the building and its style: the base of the brief
	// (contracts/FIELDS.md). The numbers below win where they disagree with it.
	DesignPrompt *string  `json:"designPrompt"`
	Floors       *int     `json:"floors"`
	AreaM2       *float64 `json:"areaM2"`
	UnitCount    *int     `json:"unitCount"`
	Bedrooms     *int     `json:"bedrooms"`
	Bathrooms    *float64 `json:"bathrooms"`
	Residents    *int     `json:"residents"`
	RoomType     *string  `json:"roomType"`
	BudgetUSD    *float64 `json:"budgetUSD"`
}

type UnitMix struct {
	Studio   *int `json:"studio"`
	OneBed   *int `json:"oneBed"`
	TwoBed   *int `json:"twoBed"`
	ThreeBed *int `json:"threeBed"`
}

func (u UnitMix) set() bool {
	return u.Studio != nil || u.OneBed != nil || u.TwoBed != nil || u.ThreeBed != nil
}

func (u UnitMix) counts() map[string]int {
	v := func(p *int) int {
		if p == nil {
			return 0
		}
		return *p
	}
	return map[string]int{"studio": v(u.Studio), "oneBed": v(u.OneBed), "twoBed": v(u.TwoBed), "threeBed": v(u.ThreeBed)}
}

type Advanced struct {
	Style           *string  `json:"style"`
	Quality         *string  `json:"quality"`
	Garage          *int     `json:"garage"`
	ParkingSpaces   *int     `json:"parkingSpaces"`
	Structure       *string  `json:"structure"`
	Cladding        *string  `json:"cladding"`
	Roofing         *string  `json:"roofing"`
	Priorities      []string `json:"priorities"`
	Extras          []string `json:"extras"`
	UnitMix         UnitMix  `json:"unitMix"`
	BathroomSharing *string  `json:"bathroomSharing"`
	CommonSpaces    []string `json:"commonSpaces"`
	Notes           *string  `json:"notes"`
}

type Builder struct {
	Name       *string `json:"name"`
	Company    *string `json:"company"`
	Email      *string `json:"email"`
	Landowner  *bool   `json:"landowner"`
	Permission *bool   `json:"permission"`
}

type ClientInfo struct {
	DisplayUnits *string `json:"displayUnits"`
	CreatedAt    *string `json:"createdAt"`
}

var (
	HousingTypes    = []string{"house", "tiny-home", "townhouse", "duplex", "mansion", "villa", "apartment", "condo", "dorm", "hotel",
		"neighborhood", "trailer-park", "manufactured"}
	Styles          = []string{"modern", "farmhouse", "craftsman", "cabin", "mediterranean", "prairie", "contemporary", "brick-traditional"}
	Qualities       = []string{"essential", "standard", "premium"}
	Structures      = []string{"wood-frame", "steel-frame", "concrete", "mass-timber", "masonry"}
	Claddings       = []string{"board-batten", "lap-siding", "brick", "stucco", "stone", "fiber-cement", "metal-panel", "timber"}
	Roofings        = []string{"asphalt-shingle", "metal", "tile", "slate", "membrane"}
	PriorityValues  = []string{"efficiency", "maintenance", "light", "privacy", "accessible", "quiet"}
	ExtraValues     = []string{"office", "porch", "deck", "basement", "balconies", "roof-terrace"}
	SharingValues   = []string{"private", "suite", "hall"}
	CommonValues    = []string{"lobby", "lounge", "study", "gym", "laundry", "kitchen", "bike-storage", "mail", "restaurant",
		"park", "playground", "pool", "clubhouse"}
	RoomTypeValues  = []string{"single", "double", "suite"}
	PaletteUses     = []string{"walls", "roof", "trim", "windows", "doors", "accent", "interior-walls", "floors"}
	singleHomeTypes = []string{"house", "tiny-home", "townhouse", "duplex", "mansion", "villa", "manufactured"}
	multiTypes      = []string{"apartment", "condo", "dorm", "hotel"}
	// FloorRanges is how many storeys each type may have.
	FloorRanges = map[string][2]int{"house": {1, 3}, "tiny-home": {1, 2}, "townhouse": {2, 4}, "duplex": {1, 3},
		"mansion": {1, 4}, "villa": {1, 3}, "apartment": {2, 12}, "condo": {2, 12}, "dorm": {2, 12}, "hotel": {2, 12},
		"neighborhood": {1, 3}, "trailer-park": {1, 1}, "manufactured": {1, 1}}
)

func isMulti(t string) bool { return contains(multiTypes, t) }

// roomsNotHomes is true for buildings of rooms rather than homes (dorms and hotels): no units, no
// living area per home, and their rooms are counted from the plan.
func roomsNotHomes(t string) bool { return t == "dorm" || t == "hotel" }

// bedBathRange is how many bedrooms and bathrooms a home of this type may have.
func bedBathRange(t string) (bedLo, bedHi int, bathLo, bathHi float64) {
	switch t {
	case "mansion":
		return 3, 12, 2, 14
	case "villa":
		return 1, 10, 1, 10
	case "manufactured", "trailer-park":
		return 1, 4, 1, 3
	case "neighborhood":
		return 1, 6, 1, 5
	}
	return 0, 8, 1, 6
}

// garageMax is the most garage spaces a home of this type may have.
func garageMax(t string) int {
	if t == "mansion" {
		return 4
	}
	return 3
}

// unitCountRange is how many homes (or a hotel's guest rooms) a type may have; ok is false when the
// type doesn't ask.
func unitCountRange(t string) (lo, hi int, ok bool) {
	switch t {
	case "townhouse":
		return 2, 12, true
	case "apartment", "condo":
		return 4, 200, true
	case "hotel":
		return 8, 400, true
	case "neighborhood":
		return 4, 150, true
	case "trailer-park":
		return 4, 300, true
	}
	return 0, 0, false
}

func sv(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func iv(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func fv(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// SiteRing returns the outline as [lng, lat] points, not closed.
func (r Request) SiteRing() ([]Pt, error) {
	c := r.Site.Geometry.Coordinates
	if len(c) == 0 || len(c[0]) < 4 {
		return nil, fmt.Errorf("site.geometry.coordinates needs one ring of at least 4 [lng, lat] points (closed)")
	}
	var ring []Pt
	for i, p := range c[0] {
		if len(p) < 2 || p[0] == nil || p[1] == nil {
			return nil, fmt.Errorf("site point %d is not [lng, lat]", i)
		}
		ring = append(ring, Pt{*p[0], *p[1]})
	}
	if ring[0] == ring[len(ring)-1] {
		ring = ring[:len(ring)-1]
	}
	if len(ring) < 3 {
		return nil, fmt.Errorf("site outline needs at least 3 distinct points")
	}
	return ring, nil
}

func (r Request) Setback() float64 {
	if s := r.Site.Properties.SetbackM; s != nil && *s >= 0 {
		return *s
	}
	return 3
}

// ValidateRequest checks the request against the field guide.
func ValidateRequest(r Request) []string {
	var e []string
	add := func(f string, a ...any) { e = append(e, fmt.Sprintf(f, a...)) }
	if r.Schema != "terrasim.design-request/2" {
		add("schema must be \"terrasim.design-request/2\" (got %q)", r.Schema)
	}
	ht := sv(r.HousingType)
	if !contains(HousingTypes, ht) {
		add("housingType must be one of %v", HousingTypes)
		return e
	}
	ring, err := r.SiteRing()
	if err != nil {
		add("%v", err)
	} else {
		for _, p := range ring {
			if math.Abs(p[1]) > 85 || math.Abs(p[0]) > 180 {
				add("site point [%g, %g] isn't a place on Earth (points are [longitude, latitude])", p[0], p[1])
				break
			}
		}
	}
	b := r.Brief
	floorRange := FloorRanges[ht]
	if b.Floors == nil || *b.Floors < floorRange[0] || *b.Floors > floorRange[1] {
		add("brief.floors must be %d–%d for %s", floorRange[0], floorRange[1], ht)
	}
	if ht == "dorm" {
		if b.Residents == nil || *b.Residents < 1 {
			add("brief.residents is required for a dorm")
		}
		if !contains(RoomTypeValues, sv(b.RoomType)) {
			add("brief.roomType must be single, double or suite for a dorm")
		}
	} else if ht == "trailer-park" || ht == "manufactured" {
		if ht == "trailer-park" && (b.UnitCount == nil || *b.UnitCount < 4 || *b.UnitCount > 300) {
			add("brief.unitCount (home pads) must be 4–300 for a trailer park")
		}
		if sv(b.RoomType) != "single" && sv(b.RoomType) != "double" {
			add("brief.roomType must be single (single-wide homes) or double (double-wide homes) for a %s", ht)
		}
		if b.Bedrooms == nil || *b.Bedrooms < 1 || *b.Bedrooms > 4 {
			add("brief.bedrooms is required (1–4 for %s)", ht)
		}
		if b.Bathrooms == nil || *b.Bathrooms < 1 || *b.Bathrooms > 3 || math.Mod(*b.Bathrooms*2, 1) != 0 {
			add("brief.bathrooms is required (1–3 for %s, in steps of 0.5)", ht)
		}
	} else if ht == "hotel" {
		if b.UnitCount == nil || *b.UnitCount < 8 || *b.UnitCount > 400 {
			add("brief.unitCount (guest rooms) must be 8–400 for a hotel")
		}
		if !contains(RoomTypeValues, sv(b.RoomType)) {
			add("brief.roomType must be single (king rooms), double (two-queen rooms) or suite for a hotel")
		}
	} else {
		// null = the user left the size to Gemma (it chooses areaM2 in the design program).
		if b.AreaM2 != nil && *b.AreaM2 < 12 {
			add("brief.areaM2 must be at least 12 m² (or null to let the design system choose)")
		}
		bedLo, bedHi, bathLo, bathHi := bedBathRange(ht)
		if b.Bedrooms == nil || *b.Bedrooms < bedLo || *b.Bedrooms > bedHi {
			add("brief.bedrooms is required (%d–%d for %s)", bedLo, bedHi, ht)
		}
		if b.Bathrooms == nil || *b.Bathrooms < bathLo || *b.Bathrooms > bathHi || math.Mod(*b.Bathrooms*2, 1) != 0 {
			add("brief.bathrooms is required (%g–%g for %s, in steps of 0.5)", bathLo, bathHi, ht)
		}
		switch ht {
		case "neighborhood":
			if b.UnitCount == nil || *b.UnitCount < 4 || *b.UnitCount > 150 {
				add("brief.unitCount (homes) must be 4–150 for a neighborhood")
			}
		case "townhouse":
			if b.UnitCount == nil || *b.UnitCount < 2 || *b.UnitCount > 12 {
				add("brief.unitCount must be 2–12 for townhouses")
			}
		case "apartment", "condo":
			if b.UnitCount == nil || *b.UnitCount < 4 || *b.UnitCount > 200 {
				add("brief.unitCount must be 4–200 for %s", ht)
			}
		}
	}
	if b.BudgetUSD != nil && *b.BudgetUSD <= 0 {
		add("brief.budgetUSD must be positive, or null for no limit")
	}
	a := r.Advanced
	enum := func(name string, v *string, allowed []string) {
		if v != nil && !contains(allowed, *v) {
			add("advanced.%s must be one of %v (or null)", name, allowed)
		}
	}
	enum("style", a.Style, Styles)
	enum("quality", a.Quality, Qualities)
	enum("structure", a.Structure, Structures)
	enum("cladding", a.Cladding, Claddings)
	enum("roofing", a.Roofing, Roofings)
	enum("bathroomSharing", a.BathroomSharing, SharingValues)
	list := func(name string, v, allowed []string) {
		for _, x := range v {
			if !contains(allowed, x) {
				add("advanced.%s: %q is not one of %v", name, x, allowed)
			}
		}
	}
	list("priorities", a.Priorities, PriorityValues)
	list("extras", a.Extras, ExtraValues)
	list("commonSpaces", a.CommonSpaces, CommonValues)
	if a.Garage != nil && (*a.Garage < 0 || *a.Garage > 3) {
		add("advanced.garage must be 0–3 cars")
	}
	if a.UnitMix.set() && (ht == "apartment" || ht == "condo") {
		sum := 0
		for _, n := range a.UnitMix.counts() {
			sum += n
		}
		if sum != iv(b.UnitCount) {
			add("advanced.unitMix adds up to %d but unitCount is %d", sum, iv(b.UnitCount))
		}
	}
	if a.Notes != nil && len([]rune(*a.Notes)) > 600 {
		add("advanced.notes is limited to 600 characters")
	}
	if sv(r.Mode) == "build" && (r.Builder == nil || r.Builder.Permission == nil || !*r.Builder.Permission) {
		add("mode \"build\" needs builder.permission = true")
	}
	return e
}

// ------------------------------------------------------------------ design

type Design struct {
	Schema      string       `json:"schema"`
	ID          string       `json:"id"`
	RequestID   string       `json:"requestId"`
	CreatedAt   string       `json:"createdAt"`
	HousingType string       `json:"housingType"`
	Overview    Overview     `json:"overview"`
	Totals      DesignTotals `json:"totals"`
	Site        DSite        `json:"site"`
	Placement   Placement    `json:"placement"`
	Size        Size         `json:"size"`
	Units       []DUnit      `json:"units"`
	Levels      []DLevel     `json:"levels"`
	Stairs      []DStair     `json:"stairs"`
	Elevators   []DElevator  `json:"elevators"`
	Exterior    Exterior     `json:"exterior"`
	// What it costs, in the same file as the design (contracts/FIELDS.md, `cost`).
	Cost *DesignCost `json:"cost,omitempty"`
}

// DesignCost is the estimate plus the cost breakdown, the budget check and nearby suppliers.
type DesignCost struct {
	Currency  string       `json:"currency"`
	AsOf      string       `json:"asOf"`
	BuildCost BuildCost    `json:"buildCost"`
	Breakdown *CostSummary `json:"breakdown"`
	Materials []EMaterial  `json:"materials"`
	OverTime  OverTime     `json:"overTime"`
	Suppliers []Supplier   `json:"suppliers"`
}

type Overview struct {
	Title        string   `json:"title"`
	Summary      string   `json:"summary"`
	Description  []string `json:"description"`
	SiteResponse []string `json:"siteResponse"`
	Features     []string `json:"features"`
	Cautions     []string `json:"cautions"`
	Style        string   `json:"style"`
}

type DesignTotals struct {
	Floors            int     `json:"floors"`
	LevelsBelowGround int     `json:"levelsBelowGround"`
	UnitCount         int     `json:"unitCount"`
	Bedrooms          int     `json:"bedrooms"`
	Bathrooms         float64 `json:"bathrooms"`
	Residents         *int    `json:"residents"`
	FinishedAreaM2    float64 `json:"finishedAreaM2"`
	GrossAreaM2       float64 `json:"grossAreaM2"`
	ParkingSpaces     int     `json:"parkingSpaces"`
}

type DSite struct {
	Outline []Pt      `json:"outline"`
	AreaM2  float64   `json:"areaM2"`
	Soil    *SiteSoil `json:"soil,omitempty"`
	// Estimated is true outside the US: worldwide sources and stated assumptions stood in for
	// the US site data (the cautions list them).
	Estimated bool `json:"estimated,omitempty"`
}

// SiteSoil is what the soil survey found under the building, and what the design did about it.
type SiteSoil struct {
	Source        string `json:"source"`
	SoilName      string `json:"name"`
	USCS          string `json:"uscsClass"`
	BearingPSF    *int   `json:"bearingPsf"`
	ShrinkSwell   string `json:"shrinkSwell"`
	BedrockIn     *int   `json:"depthToBedrockIn"`
	WaterTableIn  *int   `json:"depthToWaterTableIn"`
	Foundation    string `json:"foundation"`
	FoundationWhy string `json:"foundationReason"`
	Note          string `json:"note,omitempty"`
}

type Placement struct {
	Origin          Pt      `json:"origin"`
	XAxisBearingDeg float64 `json:"xAxisBearingDeg"`
	Footprint       []Pt    `json:"footprint"`
}

type Size struct {
	WidthM  float64 `json:"widthM"`
	DepthM  float64 `json:"depthM"`
	HeightM float64 `json:"heightM"`
}

type DUnit struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Kind           string  `json:"kind"`
	Levels         []int   `json:"levels"`
	EntryOpeningID string  `json:"entryOpeningId"`
	Bedrooms       int     `json:"bedrooms"`
	Bathrooms      float64 `json:"bathrooms"`
	Residents      *int    `json:"residents"`
	AreaM2         float64 `json:"areaM2"`
}

type DLevel struct {
	Index          int           `json:"index"`
	Name           string        `json:"name"`
	ElevationM     float64       `json:"elevationM"`
	HeightM        float64       `json:"heightM"`
	CeilingHeightM float64       `json:"ceilingHeightM"`
	Outline        Ring          `json:"outline"`
	// Roof marks the stair house of a roof terrace: a level on the roof, not a floor.
	Roof           bool          `json:"roof,omitempty"`
	Rooms          []DRoom       `json:"rooms"`
	Walls          []DWall       `json:"walls"`
	Openings       []DOpening    `json:"openings"`
	Balconies      []DBalcony    `json:"balconies"`
	Furnishings    []DFurnishing `json:"furnishings"`
}

type DRoom struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Type        string  `json:"type"`
	UnitID      *string `json:"unitId"`
	Polygon     Ring    `json:"polygon"`
	AreaM2      float64 `json:"areaM2"`
	FloorFinish string  `json:"floorFinish"`
}

type DWall struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	X1         float64 `json:"x1"`
	Y1         float64 `json:"y1"`
	X2         float64 `json:"x2"`
	Y2         float64 `json:"y2"`
	// Arc, when set, curves the wall along an ellipse from (x1, y1) to (x2, y2) (curve.go).
	Arc        *Arc    `json:"arc,omitempty"`
	ThicknessM float64 `json:"thicknessM"`
}

func (w DWall) Length() float64 {
	if w.Arc == nil {
		return math.Hypot(w.X2-w.X1, w.Y2-w.Y1)
	}
	return PolyPerimeter(w.wallPath()) - math.Hypot(w.X2-w.X1, w.Y2-w.Y1) // open path: drop the closing side
}

type DOpening struct {
	ID       string    `json:"id"`
	Kind     string    `json:"kind"`
	WallID   string    `json:"wallId"`
	OffsetM  float64   `json:"offsetM"`
	WidthM   float64   `json:"widthM"`
	SillM    *float64  `json:"sillM"`
	HeadM    float64   `json:"headM"`
	Connects [2]string `json:"connects"`
}

type DBalcony struct {
	ID      string  `json:"id"`
	UnitID  *string `json:"unitId"`
	Polygon []Pt    `json:"polygon"`
	Railing string  `json:"railing"`
}

type DFurnishing struct {
	Type        string   `json:"type"`
	RoomID      string   `json:"roomId"`
	X           float64  `json:"x"`
	Y           float64  `json:"y"`
	W           float64  `json:"w"`
	D           float64  `json:"d"`
	H           *float64 `json:"h"`
	RotationDeg float64  `json:"rotationDeg"`
	Size        *string  `json:"size"`
	Sink        *bool    `json:"sink"`
	Cooktop     *bool    `json:"cooktop"`
	Double      *bool    `json:"double"`
	Wide        *bool    `json:"wide"`
}

type DStair struct {
	ID         string  `json:"id"`
	Shape      string  `json:"shape"`
	FromLevel  int     `json:"fromLevel"`
	ToLevel    int     `json:"toLevel"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	WidthM     float64 `json:"widthM"`
	DepthM     float64 `json:"depthM"`
	AccessSide string  `json:"accessSide"`
}

type DElevator struct {
	ID       string  `json:"id"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	WidthM   float64 `json:"widthM"`
	DepthM   float64 `json:"depthM"`
	Levels   []int   `json:"levels"`
	DoorSide string  `json:"doorSide"`
}

type Exterior struct {
	Roof      Roof       `json:"roof"`
	Garage    *XGarage   `json:"garage"`
	Porch     *XPorch    `json:"porch"`
	Parking   []XParking `json:"parking"`
	// Foundation is how the building meets the ground, from the slope under it (foundation.go).
	Foundation *XFoundation `json:"foundation,omitempty"`
	Materials  XMaterials   `json:"materials"`
}

type Roof struct {
	Type         string  `json:"type"`
	Pitch        float64 `json:"pitch"`
	EaveM        float64 `json:"eaveM"`
	RidgeAxis    *string `json:"ridgeAxis"`
	RidgeHeightM float64 `json:"ridgeHeightM"`
	// Wings, on an L, U or courtyard plan, is one pitched roof per wing (wings.go).
	Wings []RoofWing `json:"wings,omitempty"`
}

type XGarage struct {
	Cars    int     `json:"cars"`
	Polygon []Pt    `json:"polygon"`
	HeightM float64 `json:"heightM"`
}

type XPorch struct {
	Polygon []Pt `json:"polygon"`
}

type XParking struct {
	Polygon []Pt `json:"polygon"`
	Spaces  int  `json:"spaces"`
	Covered bool `json:"covered"`
}

type XMaterials struct {
	Structure string         `json:"structure"`
	Cladding  string         `json:"cladding"`
	Roofing   string         `json:"roofing"`
	Palette   []PaletteColor `json:"palette"`
}

type PaletteColor struct {
	Name string `json:"name"`
	Hex  string `json:"hex"`
	Use  string `json:"use"`
}

// ------------------------------------------------------------------ estimate

type Estimate struct {
	Schema    string      `json:"schema"`
	DesignID  string      `json:"designId"`
	Currency  string      `json:"currency"`
	AsOf      string      `json:"asOf"`
	BuildCost BuildCost   `json:"buildCost"`
	Materials []EMaterial `json:"materials"`
	OverTime  OverTime    `json:"overTime"`
}

type BuildCost struct {
	Low         float64    `json:"low"`
	Expected    float64    `json:"expected"`
	High        float64    `json:"high"`
	PerSqFt     float64    `json:"perSqFt"`
	Confidence  string     `json:"confidence"`
	Lines       []CostLine `json:"lines"`
	Assumptions []string   `json:"assumptions"`
}

type CostLine struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Amount float64 `json:"amount"`
}

type EMaterial struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Quantity float64 `json:"quantity"`
	Unit     string  `json:"unit"`
	UnitCost float64 `json:"unitCost"`
	Cost     float64 `json:"cost"`
}

type OverTime struct {
	Years       int           `json:"years"`
	Assumptions OTAssumptions `json:"assumptions"`
	Rows        []OTRow       `json:"rows"`
	Events      []OTEvent     `json:"events"`
}

type OTAssumptions struct {
	Inflation    float64 `json:"inflation"`
	Appreciation float64 `json:"appreciation"`
}

type OTRow struct {
	Year         int     `json:"year"`
	Maintenance  float64 `json:"maintenance"`
	Energy       float64 `json:"energy"`
	Replacements float64 `json:"replacements"`
	Value        float64 `json:"value"`
}

type OTEvent struct {
	Year   int     `json:"year"`
	Name   string  `json:"name"`
	Amount float64 `json:"amount"`
}

// ------------------------------------------------------------------ output file

// Output is the JSON file this program writes: the contract's three parts plus
// a report with the site data, materials list, cost build-up and suppliers.
type Output struct {
	Request  json.RawMessage `json:"request"`
	Design   *Design         `json:"design"`
	Estimate *Estimate       `json:"estimate"`
	// SiteDesign is a neighborhood or trailer park (terrasim.design/3, sites.go); Design is then nil.
	SiteDesign *SiteDesign `json:"siteDesign,omitempty"`
	Report   Report          `json:"report"`
}

func r2(x float64) float64 { return math.Round(x*100) / 100 }
func r1(x float64) float64 { return math.Round(x*10) / 10 }

func title(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// DesignID is the id of what the run made: a building or a site.
func (o *Output) DesignID() string {
	switch {
	case o == nil:
		return ""
	case o.SiteDesign != nil:
		return o.SiteDesign.ID
	case o.Design != nil:
		return o.Design.ID
	}
	return ""
}
