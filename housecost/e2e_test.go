package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func fakeSite(q SiteQuery) (Site, error) {
	soil := SummarizeSoil([]map[string]any{{"muname": "Groseclose silt loam", "compname": "Groseclose", "comppct_r": "85",
		"brockdepmin": "152", "uscs": "CL", "lep_max": "4.5"}})
	g := slopedGrid(int(math.Max(3, q.FootprintFt[1]*MPerFt)), int(math.Max(3, q.FootprintFt[0]*MPerFt)), 1, 4)
	t := AnalyzeFootprint(g)
	t.ElevationSource = "test"
	return Site{Location: LocInfo{"24060", "Blacksburg", "Montgomery County", "Virginia", "VA"},
		Climate: Climate{ClimateZone: 4, HDD65: 4800, CDD50: 3000, RecordLowF: -2, AnnualPrecipIn: 40,
			AnnualSnowfallIn: 20, MaxWindGustMph: 62, FrostDepthIn: 24},
		Flood: Flood{"X", false}, Seismic: Seismic{SDC: "B"}, Soil: soil, Terrain: t,
		Labor: Labor{WageFactor: 0.92}}, nil
}

// fakeGemma answers each prompt like a well-behaved model would.
type fakeGemma struct {
	t          *testing.T
	r          Request
	calls      []string
	badProgram bool
}

var rtRow = regexp.MustCompile(`(?m)^([a-z-]+) \| (\d+) \| \d+ \| (.*)$`)
var echoRe = map[string]*regexp.Regexp{
	"zone":  regexp.MustCompile(`"climate_zone": (\d+)`),
	"slope": regexp.MustCompile(`"best_pad_slope_percent": ([\d.]+)`),
}

func (f *fakeGemma) ask(msgs []Msg, maxTokens int) (string, error) {
	prompt := msgs[0].Text
	last := msgs[len(msgs)-1].Text
	switch {
	case strings.Contains(prompt, "site-feasibility engineer"):
		f.calls = append(f.calls, "assessment")
		slope := echoRe["slope"].FindStringSubmatch(prompt)[1]
		return fmt.Sprintf(`{"echo_climate_zone": 4, "echo_flood_zone": "X", "echo_seismic_design_category": "B",
			"echo_best_pad_slope_percent": %s, "echo_governing_uscs_class": "CL", "presumptive_bearing_psf": 1500,
			"feasibility": "feasible", "risks": ["none significant"], "foundation_type": "crawlspace",
			"foundation_rationale": "gentle slope, moderate shrink-swell", "retaining_wall_needed": false}`, slope), nil
	case strings.Contains(prompt, "You are the architect"):
		f.calls = append(f.calls, "program")
		a := f.r.Advanced
		ht := sv(f.r.HousingType)
		pick := func(user *string, def string) string {
			if user != nil {
				return *user
			}
			return def
		}
		roofing, roofType, pitch := pick(a.Roofing, "asphalt-shingle"), "gable", 0.5
		structure := pick(a.Structure, "wood-frame")
		if isMulti(ht) {
			roofing, roofType, pitch = pick(a.Roofing, "membrane"), "flat", 0
			if iv(f.r.Brief.Floors) > 5 {
				structure = pick(a.Structure, "concrete")
			}
		}
		if f.badProgram && len(msgs) == 1 {
			roofing, pitch = "slate", 0.2 // slate needs 0.33: should be sent back
		}
		garage, parking := "1", "null"
		if isMulti(ht) {
			garage, parking = "null", "12"
		}
		if a.Garage != nil {
			garage = fmt.Sprint(*a.Garage)
		}
		mix := `{"studio": 0, "oneBed": 0, "twoBed": 0, "threeBed": 0}`
		if ht == "apartment" || ht == "condo" {
			n := iv(f.r.Brief.UnitCount)
			mix = fmt.Sprintf(`{"studio": %d, "oneBed": %d, "twoBed": %d, "threeBed": 0}`, n/4, n/4, n-2*(n/4))
		}
		sharing := "hall"
		if sv(f.r.Brief.RoomType) == "suite" {
			sharing = "suite"
		}
		extras, _ := json.Marshal(append([]string{}, a.Extras...))
		prios, _ := json.Marshal(append([]string{}, a.Priorities...))
		common := `["mail", "laundry", "lounge"]`
		return fmt.Sprintf(`{"style": "%s", "quality": "%s", "structure": "%s", "cladding": "%s", "roofing": "%s",
			"roofType": "%s", "roofPitch": %g, "garageCars": %s, "parkingSpaces": %s, "extras": %s, "priorities": %s,
			"commonSpaces": %s, "unitMix": %s, "bathroomSharing": "%s",
			"palette": [{"name": "Chalk", "hex": "#EDE8DF", "use": "walls"}, {"name": "Slate", "hex": "#3A3D40", "use": "roof"},
			            {"name": "Black", "hex": "#1E1E1E", "use": "windows"}],
			"title": "Test Building", "summary": "A test building.", "description": ["Paragraph."],
			"siteResponse": ["The site slopes 4%%; the crawlspace absorbs it.", "CL soil: footings below frost."],
			"features": ["Open kitchen"], "cautions": ["Check zoning."]}`,
			pick(a.Style, "craftsman"), pick(a.Quality, "standard"), structure, pick(a.Cladding, "lap-siding"),
			roofing, roofType, pitch, garage, parking, extras, prios, common, mix, sharing), nil
	case strings.Contains(prompt, "construction estimator. The building is designed"):
		f.calls = append(f.calls, "materials")
		_ = last
		shell := []string{"ready_mix_3000", "rebar_4", "vapor_barrier", "floor_batt_r30", "osb_716", "house_wrap",
			"synthetic_underlay", "window_double", "door_steel", "int_door_hollow", "batt_r21",
			"blown_r60", "drywall", "paint_interior", "hvac_hp", "electrical", "plumbing_rough", "lighting"}
		structure := regexp.MustCompile(`Structure ([a-z-]+), cladding ([a-z-]+), roofing ([a-z-]+)`).FindStringSubmatch(prompt)
		switch structure[1] {
		case "wood-frame":
			shell = append(shell, "spf_2x6")
		case "concrete":
			shell = append(shell, "concrete_frame")
		case "steel-frame":
			shell = append(shell, "steel_frame")
		}
		shell = append(shell, map[string]string{"lap-siding": "fiber_cement", "brick": "brick_veneer", "stucco": "stucco",
			"board-batten": "board_batten", "fiber-cement": "fiber_cement", "metal-panel": "metal_panel", "timber": "timber_cladding",
			"stone": "stone_veneer"}[structure[2]])
		shell = append(shell, map[string]string{"asphalt-shingle": "shingle_arch", "metal": "metal_roof", "membrane": "tpo_membrane",
			"tile": "clay_tile_roof", "slate": "slate_roof"}[structure[3]])
		var b strings.Builder
		b.WriteString(`{"shell": [`)
		for i, id := range shell {
			if i > 0 {
				b.WriteString(",")
			}
			fmt.Fprintf(&b, `{"catalog_id": %q, "count": null, "reason": "test"}`, id)
		}
		b.WriteString(`, {"catalog_id": "water_heater_tank", "count": 1, "reason": "test"}], "rooms": [`)
		first := true
		addRoom := func(rt, id string, count int) {
			if !first {
				b.WriteString(",")
			}
			first = false
			c := "null"
			if count > 0 {
				c = fmt.Sprint(count)
			}
			fmt.Fprintf(&b, `{"roomType": %q, "catalog_id": %q, "count": %s, "reason": "test"}`, rt, id, c)
		}
		for _, m := range rtRow.FindAllStringSubmatch(prompt, -1) {
			rt, note := m[1], m[3]
			if !strings.Contains(note, "concrete floor") {
				if strings.Contains(note, "wet room") {
					addRoom(rt, "lvp", 0)
				} else {
					addRoom(rt, "eng_hardwood", 0)
				}
			}
			switch rt {
			case "kitchen", "shared-kitchen":
				addRoom(rt, "cab_stock", 0)
				addRoom(rt, "counter_laminate", 0)
				addRoom(rt, "kitchen_sink", 1)
				addRoom(rt, "electric_range", 1)
				addRoom(rt, "refrigerator", 1)
			case "bath", "shared-bath":
				addRoom(rt, "toilet", 1)
				addRoom(rt, "vanity_single", 1)
				addRoom(rt, "tub_shower_combo", 1)
			case "powder":
				addRoom(rt, "toilet", 1)
				addRoom(rt, "pedestal_sink", 1)
			case "laundry", "shared-laundry":
				addRoom(rt, "washer", 1)
				addRoom(rt, "dryer", 1)
			}
		}
		b.WriteString(`], "assumptions": ["8 ft ceilings"]}`)
		return b.String(), nil
	}
	f.t.Fatalf("unexpected prompt: %.200s", prompt)
	return "", nil
}

func TestPipelineEveryHousingType(t *testing.T) {
	for _, ht := range HousingTypes {
		t.Run(ht, func(t *testing.T) {
			r := testRequest(ht)
			if ht == "house" {
				r.Advanced.Extras = []string{"porch", "deck"}
			}
			if ht == "apartment" {
				r.Advanced.Extras = []string{"balconies"}
				r.Advanced.Priorities = []string{"accessible"}
			}
			raw, _ := json.Marshal(r)
			fg := &fakeGemma{t: t, r: r, badProgram: ht == "house"}
			var log bytes.Buffer
			sups := []Supplier{{Name: "Lowe's", Type: "doityourself", Miles: 6.1}, {Name: "Floor Store", Type: "flooring", Miles: 3}}
			res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: fg.ask, Log: &log,
				Now:       func() time.Time { return time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC) },
				Suppliers: func(lat, lon float64) ([]Supplier, error) { return sups, nil }})
			if err != nil {
				t.Fatalf("%v\n%s\nproblems: %v", err, log.String(), res.Report.Problems)
			}
			d, e := res.Design, res.Estimate
			if d == nil || e == nil {
				t.Fatalf("no design/estimate: verdict %s %v", res.Report.Verdict, res.Report.Problems)
			}
			ring, _ := r.SiteRing()
			if probs := CheckDesign(d, ring, r.Setback()); len(probs) > 0 {
				t.Fatalf("renderer rules: %v", probs)
			}
			sum := 0.0
			for _, l := range e.BuildCost.Lines {
				sum += l.Amount
			}
			if math.Abs(sum-e.BuildCost.Expected) > 0.5 || e.BuildCost.Low >= e.BuildCost.Expected || e.BuildCost.High <= e.BuildCost.Expected {
				t.Fatalf("estimate lines/range wrong: %+v", e.BuildCost)
			}
			for _, m := range e.Materials {
				if math.Abs(m.Cost-r2(m.Quantity*m.UnitCost)) > 0.01 {
					t.Fatalf("material %s cost ≠ quantity × unitCost", m.ID)
				}
			}
			if len(e.OverTime.Rows) != 31 || e.OverTime.Rows[0].Value != e.BuildCost.Expected || e.OverTime.Rows[0].Maintenance != 0 {
				t.Fatalf("overTime rows wrong")
			}
			for _, ev := range e.OverTime.Events {
				if e.OverTime.Rows[ev.Year].Replacements <= 0 {
					t.Fatalf("event year %d has no replacements", ev.Year)
				}
			}
			if ht == "house" && !strings.Contains(log.String(), "slate roofing needs a pitch of at least 0.33") {
				t.Errorf("bad program should have been sent back:\n%s", log.String())
			}
			finishes := map[string]bool{}
			for _, lv := range d.Levels {
				for _, rm := range lv.Rooms {
					finishes[rm.FloorFinish] = true
				}
			}
			if !finishes["vinyl"] {
				t.Errorf("floor finishes not taken from the materials: %v", finishes)
			}
			out, _ := json.MarshalIndent(res, "", "  ")
			path := filepath.Join(t.TempDir(), "result.json")
			os.WriteFile(path, out, 0o644)
			var back map[string]any
			if err := json.Unmarshal(out, &back); err != nil {
				t.Fatal(err)
			}
			t.Logf("%s: %.1f×%.1f m, bearing %.0f°, %d floors, %d units, %.0f m² finished; $%s ($%.0f/sqft, %s); %d materials; %d KB JSON; gemma calls %v",
				d.Overview.Title, d.Size.WidthM, d.Size.DepthM, d.Placement.XAxisBearingDeg, d.Totals.Floors, d.Totals.UnitCount,
				d.Totals.FinishedAreaM2, commas(int(e.BuildCost.Expected)), e.BuildCost.PerSqFt, e.BuildCost.Confidence,
				len(e.Materials), len(out)/1024, fg.calls)
		})
	}
}

func TestSiteTooSmall(t *testing.T) {
	r := testRequest("apartment")
	f := NewFrame(37.2296, -80.4139)
	var ring [][]*float64
	for _, p := range []Pt{{-8, -8}, {8, -8}, {8, 8}, {-8, 8}, {-8, -8}} {
		ll := f.ToLngLat(p)
		ring = append(ring, []*float64{ptr(ll[0]), ptr(ll[1])})
	}
	r.Site.Geometry.Coordinates = [][][]*float64{ring}
	raw, _ := json.Marshal(r)
	res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &bytes.Buffer{}, Now: time.Now})
	if err != nil || res.Report.Verdict != "not_feasible" || res.Design != nil {
		t.Fatalf("expected not_feasible: %v %+v", err, res.Report)
	}
}

func TestInvalidRequest(t *testing.T) {
	r := testRequest("house")
	r.Brief.Floors = ptr(7)
	r.Advanced.Style = ptr("gothic")
	raw, _ := json.Marshal(r)
	res, err := RunRequest(raw, Deps{Log: &bytes.Buffer{}, Now: time.Now})
	if err == nil || res.Report.Verdict != "invalid_request" || len(res.Report.Problems) != 2 {
		t.Fatalf("expected 2 request problems, got %v %v", err, res.Report.Problems)
	}
}
