package main

// A stand-in for Gemma that answers each step at once, the way a well-behaved model would. The
// tests use it, and `go run . -serve -fake` runs the website on it, so the whole flow (brief,
// loading, placement, panel, walkthrough, edit) can be tried in seconds without the Gemini API.
// The site data (elevation, soil, climate...) is still real, so slopes and foundations are too.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// fataler is a *testing.T; outside tests it's nil and an unknown prompt is an error instead.
type fataler interface {
	Fatalf(format string, args ...any)
}

type fakeGemma struct {
	t          fataler
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
	case strings.Contains(prompt, "The user wants it changed"):
		f.calls = append(f.calls, "edit")
		return `{"designPrompt": "A bright family house, now with a fourth bedroom and a round plan.", "bedrooms": 4}`, nil
	case strings.Contains(prompt, "site planner naming"):
		f.calls = append(f.calls, "site words")
		return `{"title": "Test Commons", "summary": "A test neighborhood.", "description": ["Streets, homes and a park."]}`, nil
	case strings.Contains(prompt, "site-feasibility engineer"):
		f.calls = append(f.calls, "assessment")
		if f.t == nil {
			return fakeAssessment(prompt)
		}
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
	if f.t != nil {
		f.t.Fatalf("unexpected prompt: %.200s", prompt)
	}
	return "", fmt.Errorf("the stand-in for Gemma has no answer for this step (-fake)")
}

// fakeAssessment answers the site assessment for real site data: it reads the data back from the
// prompt, echoes it, lists every measured hazard, and picks the first foundation the real checks
// accept, so -fake designs stand on whatever the land asks for (piers on a steep slope, and so on).
func fakeAssessment(prompt string) (string, error) {
	i := strings.Index(prompt, "SITE DATA:")
	if i < 0 {
		return "", fmt.Errorf("the stand-in for Gemma couldn't find the site data")
	}
	var s Site
	if err := json.NewDecoder(strings.NewReader(prompt[i+len("SITE DATA:"):])).Decode(&s); err != nil {
		return "", fmt.Errorf("the stand-in for Gemma couldn't read the site data: %v", err)
	}
	a := Assessment{EchoClimateZone: s.Climate.ClimateZone, EchoFloodZone: s.Flood.FloodZone, EchoSDC: s.Seismic.SDC,
		EchoBestPadSlope: s.Terrain.BestPadSlope, EchoUSCS: s.Soil.GoverningUSCS, BearingPsf: s.Soil.GoverningBearing,
		Feasibility: "feasible", Risks: []string{}, FoundationReason: "Picked by the stand-in for Gemma (-fake)."}
	for _, h := range hazardsOrdered(s) {
		a.Feasibility = "feasible_with_mitigation"
		a.Risks = append(a.Risks, fmt.Sprintf("%s (%s)", h.desc, strings.Join(riskWords[h.key], ", ")))
	}
	if len(a.Risks) == 0 {
		a.Risks = []string{"none significant"}
	}
	if !s.Terrain.Fits {
		a.Feasibility, a.FoundationType = "not_feasible", "none"
	} else {
		for _, fd := range Foundations {
			a.FoundationType = fd
			if len(ValidateAssessment(a, s)) == 0 {
				break
			}
		}
		a.RetainingWallNeed = a.FoundationType == "stepped_footing" || a.FoundationType == "walkout_basement"
	}
	out, _ := json.Marshal(map[string]any{"echo_climate_zone": a.EchoClimateZone, "echo_flood_zone": a.EchoFloodZone,
		"echo_seismic_design_category": a.EchoSDC, "echo_best_pad_slope_percent": a.EchoBestPadSlope,
		"echo_governing_uscs_class": a.EchoUSCS, "presumptive_bearing_psf": a.BearingPsf, "feasibility": a.Feasibility,
		"risks": a.Risks, "foundation_type": a.FoundationType, "foundation_rationale": a.FoundationReason,
		"retaining_wall_needed": a.RetainingWallNeed})
	return string(out), nil
}
