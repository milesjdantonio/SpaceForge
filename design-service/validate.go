package main

// Fault detection: every Gemma answer is checked against the measured data and
// building rules; failures go back to Gemma as a numbered list.

import (
	"fmt"
	"math"
	"strings"
)

type hazard struct{ key, desc string }

func hazardsOrdered(s Site) []hazard {
	var hz []hazard
	t, soil := s.Terrain, s.Soil
	if t.BestPadSlope != nil && *t.BestPadSlope > 15 {
		hz = append(hz, hazard{"slope", fmt.Sprintf("pad slope %g%%", *t.BestPadSlope)})
	}
	if soil.ShrinkSwell == "high" || soil.ShrinkSwell == "very high" {
		hz = append(hz, hazard{"shrink", soil.ShrinkSwell + " shrink-swell"})
	}
	if soil.GoverningUSCS == "unknown" {
		hz = append(hz, hazard{"soil_unknown", "no engineering soil data (geotechnical test needed)"})
	}
	if soil.MinBedrockIn != nil && *soil.MinBedrockIn < 60 {
		hz = append(hz, hazard{"bedrock", fmt.Sprintf("bedrock at %d in", *soil.MinBedrockIn)})
	}
	if soil.MinWaterIn != nil && *soil.MinWaterIn < 40 {
		hz = append(hz, hazard{"water", fmt.Sprintf("water table at %d in", *soil.MinWaterIn)})
	}
	if math.Max(t.PadMaxCutFt, t.PadMaxFillFt) > 4 {
		hz = append(hz, hazard{"retaining", "cut/fill over 4 ft"})
	}
	if s.Flood.InSFHA {
		hz = append(hz, hazard{"flood", "FEMA flood zone " + s.Flood.FloodZone})
	}
	if strings.ContainsAny(firstChar(s.Seismic.SDC), "DEF") {
		hz = append(hz, hazard{"seismic", "seismic design category " + s.Seismic.SDC})
	}
	if s.Climate.MaxWindGustMph > 90 {
		hz = append(hz, hazard{"wind", fmt.Sprintf("wind gusts to %d mph", s.Climate.MaxWindGustMph)})
	}
	return hz
}

func Hazards(s Site) map[string]string {
	m := map[string]string{}
	for _, h := range hazardsOrdered(s) {
		m[h.key] = h.desc
	}
	return m
}

func firstChar(s string) string {
	if s == "" {
		return ""
	}
	return s[:1]
}

var riskWords = map[string][]string{"slope": {"slope", "grade"}, "shrink": {"shrink", "swell", "expansive"},
	"bedrock": {"rock"}, "water": {"water table", "groundwater"}, "retaining": {"retain", "cut", "fill"},
	"flood": {"flood"}, "seismic": {"seismic", "earthquake"}, "wind": {"wind"}, "soil_unknown": {"soil", "geotech"}}

// Hazards that could justify not_feasible on a lot where the footprint fits.
var blocking = []string{"slope", "bedrock", "water", "flood"}

func ValidateAssessment(a Assessment, s Site) []string {
	var e []string
	add := func(format string, v ...any) { e = append(e, fmt.Sprintf(format, v...)) }
	t, soil := s.Terrain, s.Soil
	fz, sdc := s.Flood.FloodZone, s.Seismic.SDC
	hz := hazardsOrdered(s)
	hm := Hazards(s)

	if a.EchoClimateZone != s.Climate.ClimateZone {
		add("echo_climate_zone is %d; the data says %d.", a.EchoClimateZone, s.Climate.ClimateZone)
	}
	if a.EchoFloodZone != fz {
		add("echo_flood_zone is %s; the data says %s.", a.EchoFloodZone, fz)
	}
	if a.EchoSDC != sdc {
		add("echo_seismic_design_category is %s; the data says %s.", a.EchoSDC, sdc)
	}
	if a.EchoUSCS != soil.GoverningUSCS {
		add("echo_governing_uscs_class is %s; the data says %s.", a.EchoUSCS, soil.GoverningUSCS)
	}
	if t.BestPadSlope != nil && (a.EchoBestPadSlope == nil || math.Abs(*a.EchoBestPadSlope-*t.BestPadSlope) > 0.05) {
		got := "None"
		if a.EchoBestPadSlope != nil {
			got = fmt.Sprint(*a.EchoBestPadSlope)
		}
		add("echo_best_pad_slope_percent is %s; the data says %g.", got, *t.BestPadSlope)
	}
	if soil.GoverningBearing != nil && (a.BearingPsf == nil || *a.BearingPsf != *soil.GoverningBearing) {
		add("presumptive_bearing_psf should be %d per IRC R401.4.1.", *soil.GoverningBearing)
	}

	if !t.Fits && a.Feasibility != "not_feasible" {
		add("The %s ft footprint does not fit the %s ft buildable area; feasibility must be not_feasible.",
			t.FootprintFt, t.EnvelopeFt)
	}
	isBlocking := false
	for _, k := range blocking {
		if _, ok := hm[k]; ok {
			isBlocking = true
		}
	}
	if t.Fits && a.Feasibility == "not_feasible" && !isBlocking {
		use := "feasible"
		if len(hz) > 0 {
			use = "feasible_with_mitigation"
		}
		add("The %s ft footprint FITS the %s ft buildable area and no slope, bedrock, water-table or flood "+
			"hazard was measured, so not_feasible is wrong. Use %s.", t.FootprintFt, t.EnvelopeFt, use)
	}
	if len(hz) > 0 && a.Feasibility == "feasible" {
		var d []string
		for _, h := range hz {
			d = append(d, h.desc)
		}
		add("Verdict is feasible but these hazards need mitigation: %s.", strings.Join(d, "; "))
	}
	risk := strings.ToLower(strings.Join(a.Risks, " "))
	for _, h := range hz {
		if !containsAny(risk, riskWords[h.key]) {
			add("risks omit a measured hazard: %s.", h.desc)
		}
	}
	if a.Feasibility == "not_feasible" {
		if a.FoundationType != "none" {
			add("foundation_type must be 'none' when not_feasible.")
		}
		return e
	}

	f := a.FoundationType
	pad := 0.0
	if t.BestPadSlope != nil {
		pad = *t.BestPadSlope
	}
	rock, water := 999, 999
	if soil.MinBedrockIn != nil {
		rock = *soil.MinBedrockIn
	}
	if soil.MinWaterIn != nil {
		water = *soil.MinWaterIn
	}
	basement := strings.Contains(f, "basement")
	_, needWall := hm["retaining"]
	switch {
	case f == "none":
		add("Choose a foundation_type for a buildable site.")
	}
	if pad > 15 && f == "slab_on_grade" {
		add("No slab_on_grade at %g%% pad slope.", pad)
	}
	if pad > 30 && f != "pier_and_beam" && f != "helical_piles" {
		add("At %g%% pad slope only pier_and_beam or helical_piles are allowed.", pad)
	}
	if (soil.ShrinkSwell == "high" || soil.ShrinkSwell == "very high") && f == "slab_on_grade" {
		add("No slab_on_grade on %s shrink-swell soil.", soil.ShrinkSwell)
	}
	if basement && (rock <= 96 || water <= 96) {
		add("Basements need bedrock and water table below 96 in (bedrock %s, water %s).",
			intOrNone(soil.MinBedrockIn), intOrNone(soil.MinWaterIn))
	}
	if basement && (strings.HasPrefix(fz, "A") || strings.HasPrefix(fz, "V")) {
		add("No basement in FEMA zone %s.", fz)
	}
	if strings.HasPrefix(fz, "V") && f != "pier_and_beam" && f != "helical_piles" {
		add("FEMA zone %s requires pier_and_beam or helical_piles.", fz)
	}
	if a.RetainingWallNeed != needWall {
		add("retaining_wall_needed should be %v (max cut %g ft, fill %g ft).", pyBool(needWall), t.PadMaxCutFt, t.PadMaxFillFt)
	}
	return e
}

func intOrNone(p *int) string {
	if p == nil {
		return "None"
	}
	return fmt.Sprint(*p)
}

func ValidateMaterials(a Assessment, mats []Pick, s Site, in Interior) []string {
	var e []string
	add := func(format string, v ...any) { e = append(e, fmt.Sprintf(format, v...)) }
	zone, fz, f := s.Climate.ClimateZone, s.Flood.FloodZone, a.FoundationType
	hm := Hazards(s)
	rooms := map[string]Room{}
	var roomNames []string
	for _, r := range in.Rooms {
		rooms[r.Name] = r
		roomNames = append(roomNames, r.Name)
	}

	var picks []Pick
	for i, m := range mats {
		c, ok := Catalog[m.CatalogID]
		if !ok {
			add("Material %d: '%s' is not a catalog id.", i+1, m.CatalogID)
			continue
		}
		picks = append(picks, m)
		_, roomOK := rooms[deref(m.Room)]
		if c.PerRoom() && (m.Room == nil || !roomOK) {
			add("%s: needs \"room\" set to one of %s.", m.CatalogID, pyList(roomNames))
		}
		if !c.PerRoom() && m.Room != nil {
			add("%s: whole-house item; set room to null.", m.CatalogID)
		}
		if c.Key == "count" && (m.Count == nil || *m.Count < 1 || *m.Count > 10) {
			add("%s: count must be between 1 and 10.", m.CatalogID)
		}
	}
	cats, ids := map[string]bool{}, map[string]bool{}
	for _, m := range picks {
		cats[Catalog[m.CatalogID].Category] = true
		ids[m.CatalogID] = true
	}
	for _, cat := range ShellRequired {
		if !cats[cat] {
			add("Missing required category '%s'.", cat)
		}
	}
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
		add("Wall insulation totals R-%g; climate zone %d needs R-%g (add continuous insulation or a thicker batt).",
			wallR, zone, MinRWall[zone])
	}
	if cats["insulation_ceiling"] && ceilR < MinRCeiling[zone] {
		add("Attic insulation is R-%g; climate zone %d needs R-%g.", ceilR, zone, MinRCeiling[zone])
	}
	for _, c := range CatalogList { // catalog order keeps messages stable
		if ids[c.ID] && c.U > 0 && c.U > MaxWindowU[zone] {
			add("%s has U-%g; climate zone %d allows at most U-%g.", c.ID, c.U, zone, MaxWindowU[zone])
		}
	}
	if zone >= 5 && !ids["ice_water_shield"] {
		add("Climate zone %d needs ice_water_shield.", zone)
	}
	if zone >= 6 {
		for id := range ids {
			if c := Catalog[id]; c.Category == "hvac" && !c.ColdOK {
				add("Climate zone %d needs a cold_ok hvac system.", zone)
				break
			}
		}
	}
	if w, ok := hm["wind"]; ok {
		for id := range ids {
			if c := Catalog[id]; c.Category == "roofing" && c.WindMph < 110 {
				add("Roofing must be rated 110 mph or more for %s.", w)
				break
			}
		}
	}
	_, seismic := hm["seismic"]
	_, windy := hm["wind"]
	if (seismic || windy) && !ids["connectors"] {
		why := hm["seismic"]
		if why == "" {
			why = hm["wind"]
		}
		add("Add connectors for %s.", why)
	}

	for _, r := range in.Rooms {
		var rp []string
		for _, m := range picks {
			if deref(m.Room) == r.Name {
				rp = append(rp, m.CatalogID)
			}
		}
		var floorIDs []string
		for _, id := range rp {
			if Catalog[id].Category == "flooring" {
				floorIDs = append(floorIDs, id)
			}
		}
		if len(floorIDs) == 0 {
			add("%s: no flooring.", r.Name)
		}
		rt, _ := roomType(r.Type)
		for _, id := range floorIDs {
			if rt.Wet && !Catalog[id].WetOK {
				add("%s: %s is not suitable for a wet room.", r.Name, id)
			}
		}
		for _, n := range RoomNeeds[r.Type] {
			if !n.Test(rp) {
				add("%s: missing %s.", r.Name, n.Desc)
			}
		}
		for _, feat := range r.Features {
			okIDs := featureIDs(r.Type, feat)
			if len(okIDs) == 0 {
				continue
			}
			found := false
			for _, id := range okIDs {
				found = found || contains(rp, id)
			}
			if !found {
				add("%s: requested feature '%s' needs one of %s in this room.", r.Name, feat, pyList(okIDs))
			}
		}
	}
	return e
}

// Validate runs both stages (used by tests).
func Validate(p Plan, s Site, in Interior) []string {
	e := ValidateAssessment(p.Assessment, s)
	if len(e) == 0 && p.Feasibility != "not_feasible" {
		e = append(e, ValidateMaterials(p.Assessment, p.Materials, s, in)...)
	}
	return e
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func pyList(items []string) string {
	q := make([]string, len(items))
	for i, s := range items {
		q[i] = "'" + s + "'"
	}
	return "[" + strings.Join(q, ", ") + "]"
}
