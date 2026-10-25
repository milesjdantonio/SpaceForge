package main

// Building rules, the material catalog, room types and the starter template.

const (
	DefaultModel   = "gemma-4-26b-a4b-it"
	UserAgent      = "house-cost-estimator/1.0 (student project)"
	SearchRadiusKm = 25
	LaborFactor    = 1.1 // labor ≈ 110% of uninstalled materials, scaled by local wages
	MPerFt         = 0.3048
	CYPerM3        = 1.30795
	Circulation    = 1.15 // halls, stairs and wall thickness on top of room areas
)

// IRC Table R401.4.1 presumptive load-bearing values (psf).
var Bearing = map[string]int{
	"CL": 1500, "ML": 1500, "MH": 1500, "CH": 1500, "OL": 1500, "OH": 1500, "PT": 1500,
	"SW": 2000, "SP": 2000, "SM": 2000, "SC": 2000, "GM": 2000, "GC": 2000,
	"GW": 3000, "GP": 3000,
}

// 2021 IECC prescriptive minimums by climate zone (wall = cavity + continuous).
var MinRCeiling = map[int]float64{1: 30, 2: 49, 3: 49, 4: 60, 5: 60, 6: 60, 7: 60, 8: 60}
var MinRWall = map[int]float64{1: 13, 2: 13, 3: 20, 4: 20, 5: 20, 6: 25, 7: 25, 8: 25}
var MaxWindowU = map[int]float64{1: 0.50, 2: 0.40, 3: 0.30, 4: 0.30, 5: 0.30, 6: 0.30, 7: 0.27, 8: 0.27}

// Approximate frost depth by climate zone — confirm with the local building department.
var FrostIn = map[int]int{1: 12, 2: 12, 3: 18, 4: 24, 5: 36, 6: 42, 7: 54, 8: 60}

// Item is one catalog entry. Key is the takeoff quantity it is bought against;
// Cov is how many units of that quantity one purchase unit covers.
type Item struct {
	ID, Category, Name, Unit string
	Price                    float64
	Key                      string
	Cov                      float64
	Installed                bool // price already includes labor
	R, U                     float64
	WindMph                  int
	WetOK, ColdOK            bool
	Ice, ShellCount          bool
	Role                     string   // sink | toilet | bathing
	Structure                string   // structure value this item provides
	Cladding                 []string // cladding values this item provides
	Roofing                  string   // roofing value this item provides
	Auto                     bool     // added by code from the design, not chosen by Gemma
}

type opt func(*Item)

func installed() opt         { return func(i *Item) { i.Installed = true } }
func rv(r float64) opt       { return func(i *Item) { i.R = r } }
func uv(u float64) opt       { return func(i *Item) { i.U = u } }
func wind(m int) opt         { return func(i *Item) { i.WindMph = m } }
func wet(b bool) opt         { return func(i *Item) { i.WetOK = b } }
func cold(b bool) opt        { return func(i *Item) { i.ColdOK = b } }
func ice() opt               { return func(i *Item) { i.Ice = true } }
func shell() opt             { return func(i *Item) { i.ShellCount = true } }
func role(r string) opt      { return func(i *Item) { i.Role = r } }
func structure(s string) opt { return func(i *Item) { i.Structure = s } }
func clad(c ...string) opt   { return func(i *Item) { i.Cladding = c } }
func roofs(r string) opt     { return func(i *Item) { i.Roofing = r } }
func auto() opt              { return func(i *Item) { i.Auto = true } }
func it(id, cat, name, unit string, price float64, key string, cov float64, opts ...opt) Item {
	if cov == 0 {
		cov = 1
	}
	i := Item{ID: id, Category: cat, Name: name, Unit: unit, Price: price, Key: key, Cov: cov}
	for _, o := range opts {
		o(&i)
	}
	return i
}

// CatalogList holds national baseline prices (USD, approximate). Edit freely, or
// override any line with your own quote in prices.csv.
var CatalogList = []Item{
	// foundation
	it("ready_mix_3000", "foundation_concrete", "Ready-mix concrete 3000 psi", "cy", 165, "concrete_cy", 1),
	it("ready_mix_4000", "foundation_concrete", "Ready-mix concrete 4000 psi", "cy", 180, "concrete_cy", 1),
	it("helical_pile", "foundation_piles", "Helical pile, installed", "each", 1800, "pile_count", 1, installed()),
	it("rebar_4", "foundation_rebar", "#4 rebar, 20 ft", "each", 15, "foundation_perimeter_lf", 6.7),
	it("drain_pipe_4in", "foundation_drainage", "4 in perforated drain pipe w/ sock, 100 ft", "roll", 110, "foundation_perimeter_lf", 100),
	it("drain_stone", "foundation_drainage", "#57 drainage stone", "ton", 45, "foundation_perimeter_lf", 3),
	it("damproofing", "waterproofing", "Asphalt foundation damproofing, 5 gal", "pail", 95, "foundation_wall_sqft", 200),
	it("wp_membrane", "waterproofing", "Rubberized foundation waterproofing membrane", "sqft", 2.5, "foundation_wall_sqft", 1),
	it("vapor_barrier", "vapor_barrier", "10 mil poly vapor barrier, 10x100 ft", "roll", 120, "footprint_sqft", 1000),
	it("flood_vent", "flood_vents", "Engineered flood vent, 8x16", "each", 120, "footprint_sqft", 200),
	// framing / envelope
	it("spf_2x4", "framing_lumber", "2x4x8 SPF stud", "each", 4.5, "framing_bf", 5.33, structure("wood-frame")),
	it("spf_2x6", "framing_lumber", "2x6x8 SPF stud", "each", 7.0, "framing_bf", 8, structure("wood-frame")),
	it("osb_716", "sheathing", "7/16 in OSB, 4x8", "sheet", 17, "ext_wall_sqft", 32),
	it("plywood_1532", "sheathing", "15/32 in CDX plywood, 4x8", "sheet", 32, "ext_wall_sqft", 32),
	it("zip_sheathing", "sheathing", "ZIP System wall sheathing 7/16, 4x8 (built-in WRB)", "sheet", 38, "ext_wall_sqft", 32),
	it("connectors", "structural_connectors", "Hurricane ties + hold-down package", "sqft", 0.9, "gross_floor_sqft", 1),
	it("house_wrap", "house_wrap", "House wrap, 9x150 ft", "roll", 180, "ext_wall_sqft", 1350),
	// roof
	it("synthetic_underlay", "roof_underlayment", "Synthetic roof underlayment, 10 sq", "roll", 95, "roof_sqft", 1000),
	it("felt_15", "roof_underlayment", "#15 felt underlayment, 4 sq", "roll", 30, "roof_sqft", 400),
	it("ice_water_shield", "roof_underlayment", "Ice & water shield, 2 sq", "roll", 120, "roof_eave_sqft", 200, ice()),
	it("shingle_3tab", "roofing", "3-tab asphalt shingles (60 mph)", "bundle", 33, "roof_sqft", 33.3, wind(60), roofs("asphalt-shingle")),
	it("shingle_arch", "roofing", "Architectural asphalt shingles (130 mph)", "bundle", 42, "roof_sqft", 33.3, wind(130), roofs("asphalt-shingle")),
	it("shingle_class4", "roofing", "Class 4 impact-resistant shingles (130 mph)", "bundle", 55, "roof_sqft", 33.3, wind(130), roofs("asphalt-shingle")),
	it("metal_roof", "roofing", "Standing-seam metal roof panels (140 mph)", "sqft", 5.5, "roof_sqft", 1, wind(140), roofs("metal")),
	// siding
	it("vinyl_siding", "siding", "Vinyl siding", "square", 140, "ext_wall_sqft", 100, clad("lap-siding")),
	it("fiber_cement", "siding", "Fiber-cement lap siding, 12 ft plank", "plank", 14, "ext_wall_sqft", 7, clad("lap-siding", "fiber-cement")),
	it("eng_wood_siding", "siding", "Engineered wood lap siding, 16 ft", "plank", 20, "ext_wall_sqft", 9.5, clad("lap-siding")),
	it("brick_veneer", "siding", "Brick veneer (material)", "sqft", 9, "ext_wall_sqft", 1, clad("brick")),
	it("board_batten", "siding", "Fiber-cement board-and-batten panels, 4x8", "sheet", 48, "ext_wall_sqft", 32, clad("board-batten", "fiber-cement")),
	it("stucco", "siding", "Three-coat stucco, installed", "sqft", 9.5, "ext_wall_sqft", 1, installed(), clad("stucco")),
	it("stone_veneer", "siding", "Manufactured stone veneer (material)", "sqft", 13, "ext_wall_sqft", 1, clad("stone")),
	it("metal_panel", "siding", "Insulated metal wall panel", "sqft", 14, "ext_wall_sqft", 1, clad("metal-panel")),
	it("timber_cladding", "siding", "Cedar shiplap cladding", "sqft", 9, "ext_wall_sqft", 1, clad("timber")),
	// structure other than wood framing (installed, per sq ft of floor)
	it("steel_frame", "structural_frame", "Structural steel frame + metal deck, installed", "sqft", 30, "gross_floor_sqft", 1, installed(), structure("steel-frame")),
	it("concrete_frame", "structural_frame", "Cast-in-place concrete frame + slabs, installed", "sqft", 34, "gross_floor_sqft", 1, installed(), structure("concrete")),
	it("mass_timber", "structural_frame", "CLT / glulam mass-timber frame, installed", "sqft", 38, "gross_floor_sqft", 1, installed(), structure("mass-timber")),
	it("cmu_block", "structural_frame", "8 in CMU block (load-bearing walls)", "each", 2.8, "ext_wall_sqft", 0.89, structure("masonry")),
	it("clay_tile_roof", "roofing", "Clay roof tile", "square", 520, "roof_sqft", 100, wind(130), roofs("tile")),
	it("slate_roof", "roofing", "Natural slate roofing", "square", 950, "roof_sqft", 100, wind(130), roofs("slate")),
	it("tpo_membrane", "roofing", "TPO membrane roofing, installed", "sqft", 7.5, "roof_sqft", 1, installed(), wind(140), roofs("membrane")),
	// added by code from the design
	it("stair_flight_wood", "stairs", "Wood stair flight, installed", "each", 2800, "stair_flights", 1, installed(), auto()),
	it("stair_flight_steel", "stairs", "Steel/concrete egress stair flight, installed", "each", 14000, "stair_flights", 1, installed(), auto()),
	it("elevator_stop", "elevator", "Passenger elevator, installed (per stop)", "each", 32000, "elevator_stops", 1, installed(), auto()),
	it("garage_door", "garage_door", "Insulated garage door (per car width)", "each", 1400, "garage_door_cars", 1, auto()),
	it("sprinklers", "sprinklers", "Fire sprinkler system, installed", "sqft", 4.2, "gross_floor_sqft", 1, installed(), auto()),
	it("balcony_deck", "outdoor", "Balcony/deck structure + railing, installed", "sqft", 48, "balcony_sqft", 1, installed(), auto()),
	it("porch_deck", "outdoor", "Covered porch, installed", "sqft", 55, "porch_sqft", 1, installed(), auto()),
	it("roof_sheathing", "sheathing", "7/16 in OSB roof sheathing, 4x8", "sheet", 17, "roof_sqft", 32, auto()),
	it("subfloor", "sheathing", "23/32 in T&G subfloor, 4x8", "sheet", 38, "subfloor_sqft", 32, auto()),
	it("trim_allowance", "interior_trim", "Interior trim, hardware and finish carpentry allowance", "sqft", 4.0, "gross_floor_sqft", 1, auto()),
	it("gutters", "roof_drainage", "Aluminum gutters and downspouts, installed", "lf", 11, "eave_lf", 1, installed(), auto()),
	it("exterior_paint", "paint", "Exterior paint, installed", "sqft", 2.2, "ext_wall_sqft", 1, installed(), auto()),
	// openings
	it("window_double", "windows", "Vinyl double-hung, double-pane low-E (U-0.30)", "each", 380, "windows_count", 1, uv(0.30)),
	it("window_triple", "windows", "Vinyl triple-pane low-E (U-0.20)", "each", 650, "windows_count", 1, uv(0.20)),
	it("window_impact", "windows", "Impact-rated vinyl window (U-0.32)", "each", 950, "windows_count", 1, uv(0.32)),
	it("door_fiberglass", "exterior_doors", "Fiberglass prehung entry door", "each", 550, "exterior_doors_count", 1),
	it("door_steel", "exterior_doors", "Steel prehung entry door", "each", 350, "exterior_doors_count", 1),
	it("int_door_hollow", "interior_doors", "Prehung hollow-core interior door", "each", 120, "interior_doors_count", 1),
	it("int_door_solid", "interior_doors", "Prehung solid-core interior door", "each", 240, "interior_doors_count", 1),
	// insulation
	it("batt_r13", "insulation_wall", "R-13 fiberglass batt (2x4)", "bag", 45, "ext_wall_sqft", 40, rv(13)),
	it("batt_r15", "insulation_wall", "R-15 fiberglass batt (2x4)", "bag", 58, "ext_wall_sqft", 40, rv(15)),
	it("batt_r21", "insulation_wall", "R-21 fiberglass batt (2x6)", "bag", 62, "ext_wall_sqft", 49, rv(21)),
	it("polyiso_1in", "insulation_wall", "1 in polyiso continuous insulation, 4x8 (R-6)", "sheet", 35, "ext_wall_sqft", 32, rv(6)),
	it("polyiso_2in", "insulation_wall", "2 in polyiso continuous insulation, 4x8 (R-13)", "sheet", 60, "ext_wall_sqft", 32, rv(13)),
	it("blown_r38", "insulation_ceiling", "Blown fiberglass attic insulation to R-38", "bag", 45, "ceiling_sqft", 50, rv(38)),
	it("blown_r49", "insulation_ceiling", "Blown fiberglass attic insulation to R-49", "bag", 45, "ceiling_sqft", 40, rv(49)),
	it("blown_r60", "insulation_ceiling", "Blown fiberglass attic insulation to R-60", "bag", 45, "ceiling_sqft", 30, rv(60)),
	it("floor_batt_r30", "insulation_floor", "R-30 floor batt", "bag", 70, "floor_framing_sqft", 50, rv(30)),
	// interior finishes
	it("drywall", "drywall", "1/2 in drywall, 4x8", "sheet", 15, "drywall_sqft", 32),
	it("drywall_mr", "drywall", "1/2 in moisture-resistant drywall, 4x8 (per room)", "sheet", 20, "room_wall", 32),
	it("primer", "paint", "Drywall primer", "gallon", 25, "drywall_sqft", 300),
	it("paint_interior", "paint", "Interior latex paint", "gallon", 38, "drywall_sqft", 350),
	it("lvp", "flooring", "Waterproof luxury vinyl plank", "sqft", 3.2, "room_floor", 1, wet(true)),
	it("porcelain_tile", "flooring", "Porcelain floor tile", "sqft", 4.5, "room_floor", 1, wet(true)),
	it("eng_hardwood", "flooring", "Engineered hardwood", "sqft", 6.0, "room_floor", 1, wet(false)),
	it("solid_hardwood", "flooring", "Solid oak hardwood", "sqft", 7.0, "room_floor", 1, wet(false)),
	it("laminate", "flooring", "Laminate flooring", "sqft", 2.5, "room_floor", 1, wet(false)),
	it("carpet", "flooring", "Carpet with pad", "sqft", 3.5, "room_floor", 1, wet(false)),
	// kitchen
	it("cab_stock", "cabinets", "Stock cabinets, base + wall", "lf", 220, "room_cabinet_lf", 1),
	it("cab_semi", "cabinets", "Semi-custom cabinets, base + wall", "lf", 450, "room_cabinet_lf", 1),
	it("island_6ft", "cabinets", "Kitchen island cabinet, 6 ft", "each", 1500, "count", 1),
	it("counter_laminate", "countertops", "Laminate countertop", "sqft", 30, "room_countertop_sqft", 1),
	it("counter_granite", "countertops", "Granite countertop, installed", "sqft", 60, "room_countertop_sqft", 1, installed()),
	it("counter_quartz", "countertops", "Quartz countertop, installed", "sqft", 75, "room_countertop_sqft", 1, installed()),
	it("kitchen_sink", "plumbing_fixture", "Stainless kitchen sink + faucet", "each", 400, "count", 1, role("sink")),
	it("gas_range", "appliance", "Gas range, 30 in", "each", 950, "count", 1),
	it("electric_range", "appliance", "Electric range, 30 in", "each", 750, "count", 1),
	it("induction_range", "appliance", "Induction range, 30 in", "each", 1400, "count", 1),
	it("range_hood", "appliance", "Vented range hood", "each", 300, "count", 1),
	it("dishwasher", "appliance", "Dishwasher, 24 in", "each", 700, "count", 1),
	it("refrigerator", "appliance", "Refrigerator, 30 in", "each", 1600, "count", 1),
	it("washer", "appliance", "Clothes washer", "each", 850, "count", 1),
	it("dryer", "appliance", "Clothes dryer", "each", 850, "count", 1),
	// bath / laundry
	it("toilet", "plumbing_fixture", "Toilet, 1.28 gpf", "each", 280, "count", 1, role("toilet")),
	it("vanity_single", "plumbing_fixture", "Single vanity + sink + faucet, 36 in", "each", 500, "count", 1, role("sink")),
	it("vanity_double", "plumbing_fixture", "Double vanity + sinks + faucets, 60 in", "each", 1200, "count", 1, role("sink")),
	it("pedestal_sink", "plumbing_fixture", "Pedestal sink + faucet", "each", 220, "count", 1, role("sink")),
	it("laundry_sink", "plumbing_fixture", "Utility laundry sink", "each", 250, "count", 1, role("sink")),
	it("bathtub", "plumbing_fixture", "Alcove bathtub", "each", 500, "count", 1, role("bathing")),
	it("tub_shower_combo", "plumbing_fixture", "Tub/shower combo unit + valve", "each", 800, "count", 1, role("bathing")),
	it("walk_in_shower", "plumbing_fixture", "Walk-in shower kit + valve", "each", 1100, "count", 1, role("bathing")),
	it("water_heater_tank", "water_heater", "50 gal tank water heater", "each", 900, "count", 1, shell()),
	it("water_heater_tankless", "water_heater", "Tankless gas water heater", "each", 1400, "count", 1, shell()),
	it("water_heater_hp", "water_heater", "Heat-pump water heater, 50 gal", "each", 1800, "count", 1, shell()),
	// systems (installed, per sq ft of floor)
	it("hvac_cold_hp", "hvac", "Cold-climate ducted heat pump, installed", "sqft", 14, "gross_floor_sqft", 1, installed(), cold(true)),
	it("hvac_hp", "hvac", "Standard ducted heat pump, installed", "sqft", 10, "gross_floor_sqft", 1, installed(), cold(false)),
	it("hvac_furnace_ac", "hvac", "Gas furnace + central AC, installed", "sqft", 11, "gross_floor_sqft", 1, installed(), cold(true)),
	it("electrical", "electrical", "Electrical service, wiring and devices, installed", "sqft", 7, "gross_floor_sqft", 1, installed()),
	it("plumbing_rough", "plumbing_rough_in", "Plumbing supply and drain rough-in, installed", "sqft", 8, "gross_floor_sqft", 1, installed()),
	it("lighting", "lighting", "Light fixture allowance", "sqft", 1.5, "gross_floor_sqft", 1),
}

// Catalog is CatalogList indexed by id.
var Catalog = func() map[string]Item {
	m := map[string]Item{}
	for _, i := range CatalogList {
		m[i.ID] = i
	}
	return m
}()

var RoomKeys = map[string]bool{"room_floor": true, "room_wall": true, "room_cabinet_lf": true, "room_countertop_sqft": true}

// PerRoom reports whether an item must name a room.
func (i Item) PerRoom() bool {
	return RoomKeys[i.Key] || (i.Key == "count" && !i.ShellCount)
}

type RoomType struct {
	Key, Label string
	Wet        bool
	L, W       float64
}

var RoomTypes = []RoomType{
	{"kitchen", "Kitchen", true, 14, 16}, {"bathroom", "Full bathroom", true, 9, 8},
	{"half_bath", "Half bath", true, 6, 5}, {"bedroom", "Bedroom", false, 12, 12},
	{"living", "Living room", false, 16, 18}, {"dining", "Dining room", false, 12, 12},
	{"laundry", "Laundry room", true, 6, 8}, {"office", "Office", false, 10, 11},
}

func roomType(key string) (RoomType, bool) {
	for _, t := range RoomTypes {
		if t.Key == key {
			return t, true
		}
	}
	return RoomType{}, false
}

type Feature struct {
	Name string
	IDs  []string // catalog ids that satisfy the feature
}

var Features = map[string][]Feature{
	"kitchen": {{"island", []string{"island_6ft"}}, {"gas range", []string{"gas_range"}},
		{"electric range", []string{"electric_range"}}, {"induction range", []string{"induction_range"}},
		{"range hood", []string{"range_hood"}}, {"dishwasher", []string{"dishwasher"}},
		{"refrigerator", []string{"refrigerator"}}},
	"bathroom": {{"walk-in shower", []string{"walk_in_shower"}}, {"bathtub", []string{"bathtub", "tub_shower_combo"}},
		{"tub/shower combo", []string{"tub_shower_combo"}}, {"double vanity", []string{"vanity_double"}}},
	"half_bath": {{"pedestal sink", []string{"pedestal_sink"}}},
	"laundry":   {{"washer", []string{"washer"}}, {"dryer", []string{"dryer"}}, {"laundry sink", []string{"laundry_sink"}}},
}

func featureIDs(roomType, feature string) []string {
	for _, f := range Features[roomType] {
		if f.Name == feature {
			return f.IDs
		}
	}
	return nil
}

type Need struct {
	Desc string
	Test func(ids []string) bool
}

func anyID(ids []string, f func(Item) bool) bool {
	for _, id := range ids {
		if f(Catalog[id]) {
			return true
		}
	}
	return false
}

var RoomNeeds = map[string][]Need{
	"kitchen": {
		{"cabinets", func(ids []string) bool {
			return anyID(ids, func(i Item) bool { return i.Category == "cabinets" && i.Key != "count" })
		}},
		{"countertops", func(ids []string) bool { return anyID(ids, func(i Item) bool { return i.Category == "countertops" }) }},
		{"a sink", func(ids []string) bool { return anyID(ids, func(i Item) bool { return i.Role == "sink" }) }},
	},
	"bathroom": {
		{"a toilet", func(ids []string) bool { return anyID(ids, func(i Item) bool { return i.Role == "toilet" }) }},
		{"a sink or vanity", func(ids []string) bool { return anyID(ids, func(i Item) bool { return i.Role == "sink" }) }},
		{"a shower or tub", func(ids []string) bool { return anyID(ids, func(i Item) bool { return i.Role == "bathing" }) }},
	},
	"half_bath": {
		{"a toilet", func(ids []string) bool { return anyID(ids, func(i Item) bool { return i.Role == "toilet" }) }},
		{"a sink or vanity", func(ids []string) bool { return anyID(ids, func(i Item) bool { return i.Role == "sink" }) }},
	},
}

var ShellRequired = []string{"framing_lumber", "sheathing", "roof_underlayment", "roofing", "siding", "windows",
	"exterior_doors", "interior_doors", "insulation_wall", "insulation_ceiling", "drywall",
	"paint", "hvac", "electrical", "plumbing_rough_in", "water_heater"}

func template3BR() []Room {
	return []Room{
		{"Kitchen", "kitchen", 1, 14, 16, []string{"island", "gas range", "dishwasher", "refrigerator"}},
		{"Living Room", "living", 1, 16, 18, []string{}},
		{"Dining Room", "dining", 1, 12, 12, []string{}},
		{"Half Bath", "half_bath", 1, 6, 5, []string{}},
		{"Laundry", "laundry", 1, 6, 8, []string{"washer", "dryer"}},
		{"Primary Bedroom", "bedroom", 2, 14, 15, []string{}},
		{"Primary Bath", "bathroom", 2, 10, 9, []string{"double vanity", "walk-in shower"}},
		{"Bedroom 2", "bedroom", 2, 11, 12, []string{}},
		{"Bedroom 3", "bedroom", 2, 11, 11, []string{}},
		{"Hall Bath", "bathroom", 2, 8, 6, []string{"bathtub"}},
	}
}
