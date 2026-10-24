package main

// Prices the design's materials and builds the estimate: build cost range and
// breakdown, materials list, and 30-year cost of ownership.

import (
	"fmt"
	"math"
	"sort"
	"time"
)

type pricedPick struct {
	id, roomType, reason string
	count                *int
}

// PriceDesign prices every material the plan and the design imply.
func PriceDesign(p Program, mp MaterialPlan, t Takeoff, s Site, sups []Supplier, ov map[string]Override) []ReportLine {
	wf := s.Labor.WageFactor
	if wf == 0 {
		wf = 1
	}
	var picks []pricedPick
	for _, m := range mp.Shell {
		picks = append(picks, pricedPick{m.CatalogID, "", m.Reason, m.Count})
	}
	for _, m := range autoItems(p, t) {
		picks = append(picks, pricedPick{m.CatalogID, "", m.Reason, nil})
	}
	for _, m := range mp.Rooms {
		picks = append(picks, pricedPick{m.CatalogID, m.RoomType, m.Reason, m.Count})
	}
	var lines []ReportLine
	for _, pk := range picks {
		c, ok := Catalog[pk.id]
		if !ok {
			continue
		}
		qty := designQuantity(c, pk.count, pk.roomType, t)
		if qty <= 0 {
			continue
		}
		price, source := c.Price, "baseline"
		if c.Installed {
			price, source = r2(c.Price*wf), "baseline × local wages"
		}
		if o, ok := ov[pk.id]; ok {
			price, source = o.Price, o.Supplier
		}
		buy := "—"
		if sp := NearestSupplier(c.Category, sups); sp != nil {
			buy = fmt.Sprintf("%s (%g mi)", sp.Name, sp.Miles)
		} else if contains(trades, c.Category) || c.Installed {
			buy = "local contractor (quote)"
		}
		lines = append(lines, ReportLine{ID: fmt.Sprintf("M-%d", len(lines)+1), CatalogID: pk.id, Category: c.Category,
			RoomType: pk.roomType, Name: c.Name, Quantity: qty, Unit: c.Unit, UnitCost: price, Cost: r2(qty * price),
			Installed: c.Installed, PriceSource: source, BuyAt: buy, Reason: pk.reason})
	}
	return lines
}

var lineGroups = []struct {
	id, name string
	cats     []string
}{
	{"foundation", "Foundation", []string{"foundation_concrete", "foundation_rebar", "foundation_drainage", "waterproofing",
		"vapor_barrier", "flood_vents", "foundation_piles"}},
	{"structure", "Structure and framing", []string{"framing_lumber", "structural_frame", "sheathing", "structural_connectors", "stairs"}},
	{"envelope", "Roof, walls, windows and doors", []string{"house_wrap", "siding", "roof_underlayment", "roofing", "windows",
		"exterior_doors", "garage_door", "insulation_wall", "insulation_ceiling", "insulation_floor", "outdoor", "roof_drainage"}},
	{"interiors", "Interior finishes", []string{"drywall", "paint", "flooring", "interior_doors", "cabinets", "countertops", "interior_trim"}},
	{"fixtures", "Fixtures and appliances", []string{"plumbing_fixture", "appliance", "lighting", "water_heater"}},
	{"systems", "Mechanical, electrical, plumbing and elevators", []string{"hvac", "electrical", "plumbing_rough_in", "elevator", "sprinklers"}},
}

const (
	overheadRate = 0.15 // general conditions, overhead and profit
	permitsRate  = 0.06 // permits, plans and engineering
	inflation    = 0.028
	appreciation = 0.035
)

// BuildEstimate turns priced lines into the contract's estimate and the report's cost summary.
func BuildEstimate(lines []ReportLine, p Program, a Assessment, d *Design, t Takeoff, s Site, budget *float64,
	cautions []string, now time.Time) (*Estimate, *CostSummary) {
	wf := s.Labor.WageFactor
	if wf == 0 {
		wf = 1
	}
	byCat := map[string]float64{}
	var mat, inst float64
	for _, l := range lines {
		byCat[l.Category] += l.Cost
		if l.Installed {
			inst += l.Cost
		} else {
			mat += l.Cost
		}
	}
	labor := mat * LaborFactor * wf
	tr := s.Terrain
	site := (float64(tr.PadCutCY)*12 + float64(tr.PadFillCY)*30) * wf
	if a.RetainingWallNeed {
		site += math.Max(tr.PadMaxCutFt, tr.PadMaxFillFt) * t["footprint_side_ft"] * 45 * wf
	}
	subtotal := mat + inst + labor + site
	overhead := subtotal * overheadRate
	permits := subtotal * permitsRate

	var cl []CostLine
	add := func(id, name string, amt float64) {
		if amt > 0.5 {
			cl = append(cl, CostLine{id, name, math.Round(amt)})
		}
	}
	add("site-work", "Site work (excavation, fill, retaining)", site)
	for _, g := range lineGroups {
		sum := 0.0
		for _, c := range g.cats {
			sum += byCat[c]
		}
		add(g.id, g.name, sum)
	}
	add("labor", "Installation labor", labor)
	add("overhead", "General conditions, overhead and profit", overhead)
	add("permits", "Permits, plans and engineering", permits)
	expected := 0.0
	for _, l := range cl {
		expected += l.Amount
	}

	finishedSqft := d.Totals.FinishedAreaM2 * sqftPerM2
	confidence, lo, hi := "moderate", 0.85, 1.20
	if s.Soil.GoverningUSCS == "unknown" || len(s.Warnings) > 0 || len(cautions) > 2 {
		confidence, lo, hi = "low", 0.75, 1.35
	}
	quoted := 0.0
	for _, l := range lines {
		if l.PriceSource != "baseline" && l.PriceSource != "baseline × local wages" {
			quoted += l.Cost
		}
	}
	if mat+inst > 0 && quoted/(mat+inst) >= 0.5 {
		confidence, lo, hi = "high", 0.92, 1.10
	}
	est := &Estimate{Schema: "terrasim.estimate/1", DesignID: d.ID, Currency: "USD", AsOf: now.Format("2006-01"),
		BuildCost: BuildCost{Low: math.Round(expected * lo), Expected: expected, High: math.Round(expected * hi),
			PerSqFt: r2(expected / math.Max(1, finishedSqft)), Confidence: confidence, Lines: cl,
			Assumptions: []string{
				"Excludes land, landscaping, driveway, utility connections, furniture and financing.",
				"Material prices are national baseline estimates; installed work and labor are scaled by local carpenter wages (BLS).",
				fmt.Sprintf("Labor on uninstalled materials is %.0f%% of their cost, adjusted by the local wage factor %.2f.", LaborFactor*100, wf),
				fmt.Sprintf("General conditions, overhead and profit %.0f%%; permits, plans and engineering %.0f%%.", overheadRate*100, permitsRate*100),
				"Quantities come from the drawn design and include 10% waste on cut materials.",
			}}}
	for _, l := range lines {
		est.Materials = append(est.Materials, EMaterial{l.ID, l.Name, l.Quantity, l.Unit, l.UnitCost, l.Cost})
	}
	if est.Materials == nil {
		est.Materials = []EMaterial{}
	}
	est.OverTime = overTime(expected, lines, p, d, t, s)

	cs := &CostSummary{Materials: math.Round(mat), InstalledWork: math.Round(inst), Labor: math.Round(labor),
		SiteWork: math.Round(site), Overhead: math.Round(overhead), Permits: math.Round(permits), Total: expected,
		PerSqFt: est.BuildCost.PerSqFt, PerM2: r2(expected / math.Max(1, d.Totals.FinishedAreaM2)), WageFactor: wf,
		BudgetUSD: budget}
	if budget != nil && expected > *budget {
		over := math.Round(expected - *budget)
		cs.OverBudgetBy = &over
	}
	return est, cs
}

func overTime(expected float64, lines []ReportLine, p Program, d *Design, t Takeoff, s Site) OverTime {
	const years = 30
	ot := OverTime{Years: years, Assumptions: OTAssumptions{Inflation: inflation, Appreciation: appreciation}}
	cost := func(cats ...string) float64 {
		sum := 0.0
		for _, l := range lines {
			if contains(cats, l.Category) {
				sum += l.Cost
			}
		}
		return sum
	}
	life := map[string]int{"asphalt-shingle": 25, "metal": 45, "tile": 50, "slate": 75, "membrane": 20}[p.Roofing]
	type ev struct {
		every int
		name  string
		base  float64
	}
	evs := []ev{
		{life, "Replace roof", cost("roofing", "roof_underlayment") * 1.6},
		{15, "Replace heating and cooling equipment", cost("hvac") * 0.45},
		{12, "Replace water heater(s)", cost("water_heater") * 1.5},
		{15, "Replace appliances", cost("appliance") * 1.2},
	}
	switch p.Cladding {
	case "lap-siding", "board-batten", "timber", "fiber-cement":
		evs = append(evs, ev{10, "Repaint exterior", t["ext_wall_sqft"] * 2.5})
	}
	for _, l := range lines {
		if l.CatalogID == "carpet" {
			evs = append(evs, ev{10, "Replace carpet", l.Cost * 1.8})
			break
		}
	}
	zoneF := map[int]float64{1: 1.15, 2: 1.1, 3: 1.0, 4: 1.05, 5: 1.15, 6: 1.25, 7: 1.35, 8: 1.5}[s.Climate.ClimateZone]
	if zoneF == 0 {
		zoneF = 1.1
	}
	eff := 1.0
	if contains(p.Priorities, "efficiency") {
		eff *= 0.8
	}
	for _, l := range lines {
		if l.CatalogID == "hvac_cold_hp" || l.CatalogID == "hvac_hp" {
			eff *= 0.9
			break
		}
	}
	energy0 := d.Totals.FinishedAreaM2 * sqftPerM2 * 1.10 * zoneF * eff
	if isMulti(p.HousingType) {
		energy0 = t["gross_floor_sqft"] * 1.0 * zoneF * eff
	}
	repl := map[int]float64{}
	for _, e := range evs {
		if e.every <= 0 || e.base <= 0 {
			continue
		}
		for y := e.every; y <= years; y += e.every {
			amt := math.Round(e.base * math.Pow(1+inflation, float64(y)))
			ot.Events = append(ot.Events, OTEvent{y, e.name, amt})
			repl[y] += amt
		}
	}
	sort.Slice(ot.Events, func(i, j int) bool { return ot.Events[i].Year < ot.Events[j].Year })
	if ot.Events == nil {
		ot.Events = []OTEvent{}
	}
	for y := 0; y <= years; y++ {
		row := OTRow{Year: y, Value: math.Round(expected * math.Pow(1+appreciation, float64(y)))}
		if y > 0 {
			g := math.Pow(1+inflation, float64(y))
			row.Maintenance = math.Round(expected * 0.01 * g)
			row.Energy = math.Round(energy0 * g)
			row.Replacements = repl[y]
		}
		ot.Rows = append(ot.Rows, row)
	}
	return ot
}
