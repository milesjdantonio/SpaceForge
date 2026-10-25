package main

// The request → design + estimate pipeline.

import (
	"errors"
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"
	"sync"
	"time"
)

// SiteQuery is what the site-data fetch needs.
type SiteQuery struct {
	Centroid    Pt         // [lng, lat] of the site
	Footprint   Pt         // [lng, lat] of the building's centre
	FootprintFt [2]float64 // building width, depth in feet
	SiteBox     BBox
	SetbackM    float64
	SiteAreaM2  float64
	SiteDimsFt  [2]float64
}

// Deps holds everything that talks to the outside world, so tests can replace it.
type Deps struct {
	FetchSite func(SiteQuery) (Site, error)
	Roads     func(f Frame, centre Pt) ([]float64, error)
	Suppliers func(lat, lon float64) ([]Supplier, error)
	Ask       AskFunc
	Now       func() time.Time
	Log       io.Writer
	Overrides map[string]Override
	// Ctx is cancelled when the user stops the design; nil runs to the end.
	Ctx context.Context
	// Advise is a quick Gemma call (no retries, short timeout) for the recommendation shown when
	// a design fails; nil skips it.
	Advise AskFunc
}

// stopped is true once the user has cancelled this design.
func (dp Deps) stopped() bool { return dp.Ctx != nil && dp.Ctx.Err() != nil }

func LiveDeps(ask AskFunc, log io.Writer, ov map[string]Override) Deps {
	return Deps{
		FetchSite: FetchSiteData,
		Roads:     func(f Frame, c Pt) ([]float64, error) { return withTimeout(roadsTimeout, func() ([]float64, error) { return FetchRoadBearings(f, c, 120) }) },
		Suppliers: func(lat, lon float64) ([]Supplier, error) { return FetchSuppliers(lat, lon, SearchRadiusKm) },
		Ask:       ask, Now: time.Now, Log: log, Overrides: ov,
	}
}

// FetchSiteData pulls every free data source for the site and the building's footprint. The
// sources are separate services, so they're asked at the same time: the slowest one sets the wait.
func FetchSiteData(q SiteQuery) (Site, error) {
	lat, lon := q.Footprint[1], q.Footprint[0]
	ft := q.SetbackM / MPerFt
	s := Site{Setbacks: Setbacks{ft, ft, ft}, LotFt: q.SiteDimsFt}
	if !inUSData(q.Centroid[0], q.Centroid[1]) {
		return fetchWorldSite(q, s)
	}
	var mu sync.Mutex
	warn := func(label string, err error) {
		mu.Lock()
		s.Warnings = append(s.Warnings, fmt.Sprintf("%s unavailable (%v); used a default.", label, err))
		mu.Unlock()
	}
	var wg sync.WaitGroup
	var demErr, climateErr, soilErr error
	run := func(f func()) { wg.Add(1); go func() { defer wg.Done(); f() }() }
	run(func() {
		var err error
		if s.Location, err = FetchLocation(q.Centroid[1], q.Centroid[0]); err != nil {
			warn("Location", err)
		}
		// Wages need the state the location lookup found.
		if s.Labor, err = FetchWageFactor(s.Location.StateCode); err != nil {
			warn("BLS wages", err)
			s.Labor = Labor{WageFactor: 1}
		}
	})
	run(func() {
		grid, src, err := FetchDEM(lat, lon, q.FootprintFt)
		if err != nil {
			demErr = err
			return
		}
		s.Terrain = AnalyzeFootprint(grid)
		s.Terrain.ElevationSource = src
		s.ground = fitGround(grid, lat, lon)
	})
	run(func() { s.Climate, climateErr = FetchClimate(lat, lon) })
	run(func() {
		var err error
		if s.Flood, err = FetchFlood(lat, lon); err != nil {
			warn("FEMA flood zone", err)
			s.Flood = Flood{"unknown", false}
		}
	})
	run(func() {
		var err error
		if s.Seismic, err = FetchSeismic(lat, lon); err != nil {
			warn("USGS seismic", err)
			s.Seismic = Seismic{SDC: "unknown"}
		}
	})
	run(func() { s.Soil, soilErr = FetchSoil(q.SiteBox) })
	wg.Wait()
	switch {
	case demErr != nil:
		return s, fmt.Errorf("elevation: %w", demErr)
	case climateErr != nil:
		return s, fmt.Errorf("climate: %w", climateErr)
	case soilErr != nil:
		return s, fmt.Errorf("soil: %w", soilErr)
	}
	return s, nil
}

// AnalyzeFootprint: slope under the building and the cut/fill to level it.
func AnalyzeFootprint(g Grid) Terrain {
	var slopes, zs []float64
	for i := 0; i < g.Rows; i++ {
		for j := 0; j < g.Cols; j++ {
			s := math.Hypot(grad(g, i, j, false), grad(g, i, j, true)) * 100
			if !math.IsNaN(s) {
				slopes = append(slopes, s)
			}
			if z := g.at(i, j); !math.IsNaN(z) {
				zs = append(zs, z)
			}
		}
	}
	t := Terrain{DemResolutionM: g.Res, Fits: true, PadMethod: "whole building footprint, levelled at its average height"}
	if len(slopes) == 0 || len(zs) == 0 {
		t.PadMethod = "no elevation data under the footprint"
		return t
	}
	t.SlopeMean = fptr(round1(sum(slopes) / float64(len(slopes))))
	t.SlopeMax = fptr(round1(maxOf(slopes)))
	t.BestPadSlope = t.SlopeMean
	mean := sum(zs) / float64(len(zs))
	var cut, fill, mc, mf float64
	for _, z := range zs {
		d := z - mean
		if d > 0 {
			cut += d
			mc = math.Max(mc, d)
		} else {
			fill -= d
			mf = math.Max(mf, -d)
		}
	}
	px := g.Res * g.Res
	t.PadCutCY, t.PadFillCY = int(math.Round(cut*px*CYPerM3)), int(math.Round(fill*px*CYPerM3))
	t.PadMaxCutFt, t.PadMaxFillFt = round1(mc/MPerFt), round1(mf/MPerFt)
	return t
}

type fitted struct {
	l  *Layout
	sp SitePlan
}

func fitLayout(p Program, local []Pt, setback float64, bearings []float64) (fitted, error) {
	var lastErr error
	q := shapedProgram(p)
	for v := 0; ; v++ {
		l, err := BuildLayout(q, v)
		if err == ErrNoPreset {
			break
		}
		if err != nil {
			lastErr = err
			continue
		}
		nd := l.Needs(p.ParkingSpaces)
		if p.Shape == ShapeRound {
			// The round building reaches past the planned rectangle on every side.
			mx, my := roundMargins(l.W, l.D)
			nd.Left, nd.Right = math.Max(nd.Left, mx), math.Max(nd.Right, mx)
			nd.Front, nd.Back = math.Max(nd.Front, my), math.Max(nd.Back, my)
		}
		sp, err := FitBuilding(local, setback, nd, bearings)
		if err != nil {
			lastErr = err
			continue
		}
		return fitted{l, sp}, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no layout fits")
	}
	return fitted{}, lastErr
}

func describe(p Program, l *Layout) string {
	switch p.HousingType {
	case "dorm":
		return fmt.Sprintf("a %d-floor dorm for %d residents (%s rooms)", p.Floors, p.Residents, p.RoomType)
	case "hotel":
		kind := map[string]string{"single": "king", "double": "two-queen", "suite": "suite"}[p.RoomType]
		return fmt.Sprintf("a %d-floor hotel with %d guest rooms (%s rooms)", p.Floors, p.UnitCount, kind)
	case "apartment", "condo":
		return fmt.Sprintf("a %d-floor %s building with %d homes (average %.0f m²)", p.Floors, p.HousingType, p.UnitCount, p.AreaM2)
	}
	s := fmt.Sprintf("a %d-floor %s", p.Floors, p.HousingType)
	if p.HousingType == "mansion" || p.HousingType == "villa" {
		s = fmt.Sprintf("a %d-floor %s (one large home)", p.Floors, p.HousingType)
	}
	if p.HousingType == "townhouse" {
		s = fmt.Sprintf("a row of %d %d-floor townhomes", p.UnitCount, p.Floors)
	}
	s += fmt.Sprintf(", %.0f m² living area per home, %d bedrooms, %g bathrooms", p.AreaM2, p.Bedrooms, p.Bathrooms)
	if p.Basement {
		s += "; the user wants a basement (choose a basement foundation if the rules allow)"
	}
	return s
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// RunRequest does the whole job for one website request.
func RunRequest(raw []byte, dp Deps) (*Output, error) {
	log := dp.Log
	out := &Output{Request: json.RawMessage(raw), Report: Report{Schema: "housecost.report/1", LineItems: []ReportLine{},
		Suppliers: []Supplier{}, Warnings: []string{}}}
	var r Request
	if err := json.Unmarshal(raw, &r); err != nil {
		out.Report.Verdict, out.Report.Problems = "invalid_request", []string{err.Error()}
		return out, fmt.Errorf("request isn't valid JSON: %w", err)
	}
	if probs := ValidateRequest(r); len(probs) > 0 {
		out.Report.Verdict, out.Report.Problems = "invalid_request", probs
		return out, fmt.Errorf("request problems:\n- %s", strings.Join(probs, "\n- "))
	}
	// The description's plain asks become the user's choices where the form left them open.
	var took []string
	r, r.asks, took = applyDescription(r)
	if len(took) > 0 {
		fmt.Fprintf(log, "From the description: %s\n", strings.Join(took, ", "))
	}
	ring, _ := r.SiteRing()
	setback := r.Setback()
	var cLng, cLat float64
	for _, p := range ring {
		cLng, cLat = cLng+p[0], cLat+p[1]
	}
	cLng, cLat = cLng/float64(len(ring)), cLat/float64(len(ring))
	frame := NewFrame(cLat, cLng)
	var local []Pt
	minE, minN, maxE, maxN := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, p := range ring {
		q := frame.ToLocal(p)
		local = append(local, q)
		minE, minN, maxE, maxN = math.Min(minE, q[0]), math.Min(minN, q[1]), math.Max(maxE, q[0]), math.Max(maxN, q[1])
	}
	siteArea := PolyArea(local)
	centre := PolyCentroid(local)
	var warnings, cautions []string

	// Nearby suppliers only need the site's position: look them up while Gemma works.
	type supResult struct {
		list []Supplier
		err  error
	}
	supDone := make(chan supResult, 1)
	go func() {
		if dp.Suppliers == nil {
			supDone <- supResult{}
			return
		}
		list, err := dp.Suppliers(cLat, cLng)
		supDone <- supResult{list, err}
	}()

	// 1. which way the front faces: toward the nearest mapped street
	var bearings []float64
	if st := r.Site.Properties.Streets; len(st) > 0 {
		bearings = streetBearings(frame, centre, st)
	}
	if bearings == nil && dp.Roads != nil {
		if b, err := dp.Roads(frame, centre); err != nil {
			warnings = append(warnings, fmt.Sprintf("Street lookup unavailable (%v); the front faces the best-fitting site edge.", err))
		} else {
			bearings = b
		}
	}

	// 2. size and place a first version of the building
	p0 := DefaultProgram(r)
	fmt.Fprintf(log, "Sizing a first version of the building on the %.0f m² site...\n", siteArea)
	f0, err := fitLayout(p0, local, setback, bearings)
	if err != nil {
		out.Report.Verdict = "not_feasible"
		out.Report.Problems = []string{fmt.Sprintf("The building doesn't fit on the site: %v.", err)}
		out.Report.Warnings = warnings
		return out, nil
	}
	fpCentre := BuildingToLngLat(frame, f0.sp, Pt{f0.l.W / 2, f0.l.D / 2})
	box := BBox{frame.ToLngLat(Pt{minE, minN})[0], frame.ToLngLat(Pt{minE, minN})[1],
		frame.ToLngLat(Pt{maxE, maxN})[0], frame.ToLngLat(Pt{maxE, maxN})[1]}

	// 3. site data
	if dp.stopped() {
		return out, ErrCancelled
	}
	fmt.Fprintln(log, "Gathering site data: soil, elevation, climate, flood zone, seismic, wages...")
	site, err := dp.FetchSite(SiteQuery{Centroid: Pt{cLng, cLat}, Footprint: fpCentre,
		FootprintFt: [2]float64{f0.l.W / MPerFt, f0.l.D / MPerFt}, SiteBox: box, SetbackM: setback,
		SiteAreaM2: siteArea, SiteDimsFt: [2]float64{(maxE - minE) / MPerFt, (maxN - minN) / MPerFt}})
	if err != nil {
		out.Report.Verdict, out.Report.Problems = "error", []string{err.Error()}
		return out, err
	}
	site.Terrain.Fits = true
	site.Terrain.FootprintFt = fmt.Sprintf("%.0f x %.0f", f0.l.W/MPerFt, f0.l.D/MPerFt)
	site.Terrain.EnvelopeFt = fmt.Sprintf("%.0f m² site with a %.0f m setback (placement checked by code)", siteArea, setback)
	warnings = append(warnings, site.Warnings...)
	if site.Estimated {
		cautions = append(cautions, site.Warnings...) // outside the US: every assumption is a caution
	}
	out.Report.Site = &site

	// 4. Gemma: site assessment
	if dp.stopped() {
		return out, ErrCancelled
	}
	a, err := AskUntilValid(BuildAssessmentPromptFor(site, describe(p0, f0.l)), ParseAssessment,
		func(x Assessment) []string { return ValidateAssessment(x, site) }, dp.Ask, "site assessment", 8192, 3, log)
	if err != nil {
		out.Report.Verdict, out.Report.Problems = "error", []string{err.Error()}
		return out, err
	}
	out.Report.Assessment = &ReportAssess{a.Feasibility, a.FoundationType, a.FoundationReason, a.BearingPsf,
		a.RetainingWallNeed, a.Risks}
	out.Report.Verdict = a.Feasibility
	fmt.Fprintf(log, "  verdict: %s, foundation: %s\n", humanize(a.Feasibility), humanize(a.FoundationType))
	if a.Feasibility == "not_feasible" {
		out.Report.Problems = a.Risks
		out.Report.Warnings = dedupe(warnings)
		return out, nil
	}

	// the user's basement wish may be ruled out by the foundation
	rAdj := r
	if contains(r.Advanced.Extras, "basement") && !strings.Contains(a.FoundationType, "basement") {
		var ex []string
		for _, x := range r.Advanced.Extras {
			if x != "basement" {
				ex = append(ex, x)
			}
		}
		rAdj.Advanced.Extras = ex
		cautions = append(cautions, fmt.Sprintf("The basement was left out: the site calls for a %s foundation (%s).",
			humanize(a.FoundationType), a.FoundationReason))
	}

	// 5. Gemma: design program and the words the user reads
	if dp.stopped() {
		return out, ErrCancelled
	}
	sizing := fmt.Sprintf("a first version is %.1f × %.1f m with %d levels; site %.0f m² with a %.0f m setback from every boundary",
		f0.l.W, f0.l.D, len(f0.l.Levels), siteArea, setback)
	sizing += "\n" + landNote(local, setback, f0.l)
	// The user's own choices are put back by code when Gemma changes them, instead of a retry.
	parseProgram := func(text string) (ProgramReply, error) {
		pr, err := ParseProgram(text)
		for _, n := range keepUserChoices(&pr, rAdj) {
			fmt.Fprintf(log, "  fixed: %s\n", n)
		}
		return pr, err
	}
	pr, err := AskUntilValid(BuildProgramPrompt(rAdj, site, a, sizing), parseProgram,
		func(x ProgramReply) []string { return ValidateProgram(x, rAdj, site, a) }, dp.Ask, "design program", 8192, 3, log)
	if err != nil {
		out.Report.Verdict, out.Report.Problems = "error", []string{err.Error()}
		return out, err
	}
	p := DefaultProgram(rAdj).Merge(pr)
	if len(took) > 0 {
		p.Text.Features = append(p.Text.Features, "From your description: "+joinAnd(took)+".")
	}
	if p.HousingType == "dorm" && p.BathroomSharing == "suite" {
		p.RoomType = "suite"
	}

	// 6. final layout and placement
	fin, err := fitLayout(p, local, setback, bearings)
	if err != nil {
		q := p
		q.Extras = nil
		for _, x := range p.Extras {
			if x == "office" || x == "basement" {
				q.Extras = append(q.Extras, x)
			}
		}
		if q.GarageCars > 1 {
			q.GarageCars = 1
		}
		if fin, err = fitLayout(q, local, setback, bearings); err != nil {
			out.Report.Verdict = "not_feasible"
			out.Report.Problems = []string{fmt.Sprintf("The chosen design doesn't fit on the site: %v.", err)}
			out.Report.Warnings = dedupe(warnings)
			return out, nil
		}
		cautions = append(cautions, "Porch, deck, balconies and extra garage bays were dropped so the building fits the site.")
		p = q
	}
	l := fin.l
	cautions = append(cautions, l.Cautions...)
	if fin.sp.ParkingMsg != "" {
		cautions = append(cautions, fin.sp.ParkingMsg)
	}
	if contains(p.Extras, "roof-terrace") {
		if c := addRoofTerrace(l, p); c != "" {
			cautions = append(cautions, c)
		} else if p.Accessible || len(l.Elevators) > 0 {
			cautions = append(cautions, "The roof terrace is reached by the stair only; taking the elevator to the roof needs a taller machine room, so check with the elevator supplier.")
		}
	}
	fmt.Fprintf(log, "Drawing the design: %.1f × %.1f m, %d levels...\n", l.W, l.D, len(l.Levels))
	d, err := BuildDesign(l, p)
	if err != nil {
		out.Report.Verdict, out.Report.Problems = "error", []string{"layout error: " + err.Error()}
		return out, err
	}
	now := dp.Now()
	h := sha1.Sum(append(raw, []byte(now.String())...))
	d.ID = fmt.Sprintf("D-%x", h[:5])
	d.RequestID = or(sv(r.ID), "REQ-local")
	d.CreatedAt = now.UTC().Format(time.RFC3339)
	finishDesign(d, p, l, fin.sp, frame, ring, siteArea)
	d.Site.Soil = soilSummary(site, a)
	d.Site.Estimated = site.Estimated

	if probs := CheckDesign(d, ring, setback); len(probs) > 0 {
		out.Design = d
		out.Report.Verdict, out.Report.Problems = "error", probs
		return out, fmt.Errorf("the generated design breaks %d renderer rules", len(probs))
	}
	// How the building meets sloping ground (a shaped building works this out as it's shaped).
	if p.Shape != ShapeRound && p.Shape != ShapeLand {
		d.Exterior.Foundation = foundationFor(d, site.ground, a.FoundationType, func(q Pt) Pt { return BuildingToLngLat(frame, fin.sp, q) })
	}
	if p.Shape == ShapeRound || p.Shape == ShapeLand {
		fmt.Fprintf(log, "Shaping the building: %s...\n", p.Shape)
		if err := shapeDesign(d, p, fin.sp, frame, local, setback, ring, site, a.FoundationType); err != nil {
			fmt.Fprintf(log, "  kept it rectangular (%v)\n", err)
			cautions = append(cautions, fmt.Sprintf("The building is drawn rectangular: the %s shape couldn't be fitted here (%v).", p.Shape, err))
		}
	}

	// Curved walls inside, on a copy: kept only if the design still passes its checks.
	if p.CurvedInside {
		c := cloneDesign(d)
		n, err := curveInteriorWalls(c)
		if err == nil && n > 0 {
			if probs := CheckShaped(c, ring, setback); len(probs) > 0 {
				err = fmt.Errorf("%s", probs[0])
			}
		}
		switch {
		case err != nil:
			fmt.Fprintf(log, "  kept the inside walls straight (%v)\n", err)
			cautions = append(cautions, fmt.Sprintf("The walls inside are drawn straight: a curved one didn't fit (%v).", err))
		case n == 0:
			cautions = append(cautions, "The walls inside are drawn straight: no wall of the main rooms was long enough to curve.")
		default:
			fmt.Fprintf(log, "Curving %d wall(s) inside...\n", n)
			*d = *c
		}
	}

	if line := d.Exterior.Foundation.siteLine(); line != "" {
		d.Overview.SiteResponse = append(d.Overview.SiteResponse, line)
	}

	// 7. Gemma: materials
	if dp.stopped() {
		return out, ErrCancelled
	}
	// Small slips in the reply are fixed by code before the checks, so they don't cost a retry.
	parseFixed := func(text string) (MaterialPlan, error) {
		mp, err := ParseMaterialPlan(text)
		if err == nil {
			for _, n := range fixMaterialPlan(&mp, d) {
				fmt.Fprintf(log, "  fixed: %s\n", n)
			}
		}
		return mp, err
	}
	checkMaterials := func(x MaterialPlan) []string { return ValidateMaterialPlan(x, a, p, d, site) }
	mp, err := AskUntilValid(BuildMaterialsPlanPrompt(p, a, d, site), parseFixed, checkMaterials, dp.Ask, "materials", 16384, 3, log)
	if err != nil && !errors.Is(err, ErrCancelled) && !dp.stopped() && strings.Contains(err.Error(), "still fails") {
		// A design without materials has no cost: start the materials over once, in a fresh
		// conversation (a long back-and-forth sometimes keeps Gemma stuck on the same mistake).
		fmt.Fprintln(log, "Materials didn't pass the checks; asking again from the start...")
		mp, err = AskUntilValid(BuildMaterialsPlanPrompt(p, a, d, site), parseFixed, checkMaterials, dp.Ask, "materials", 16384, 3, log)
	}
	if err != nil {
		out.Design = d
		out.Report.Verdict, out.Report.Problems = "error", []string{err.Error()}
		return out, err
	}
	finish := map[string]string{}
	for _, m := range mp.Rooms {
		if f := floorFinishFor(m.CatalogID); f != "" {
			finish[m.RoomType] = f
		}
	}
	for li := range d.Levels {
		for ri := range d.Levels[li].Rooms {
			if f, ok := finish[d.Levels[li].Rooms[ri].Type]; ok {
				d.Levels[li].Rooms[ri].FloorFinish = f
			}
		}
	}

	// 8. quantities, prices, suppliers, estimate
	if dp.stopped() {
		return out, ErrCancelled
	}
	fmt.Fprintln(log, "Pricing: nearby suppliers, quantities, labor and site work...")
	var sups []Supplier
	// The supplier search has had all of Gemma's time; give it a little more, then price without it.
	select {
	case res := <-supDone:
		sups = res.list
		if res.err != nil {
			warnings = append(warnings, fmt.Sprintf("Supplier search unavailable (%v).", res.err))
		}
	case <-time.After(supplierGrace):
		warnings = append(warnings, "The nearby supplier search took too long; prices use regional averages.")
	}
	take := DesignTakeoff(d, a.FoundationType, d.Exterior.Roof.EaveM)
	lines := PriceDesign(p, mp, take, site, sups, dp.Overrides)
	est, cs := BuildEstimate(lines, p, a, d, take, site, r.Brief.BudgetUSD, cautions, now)
	est.BuildCost.Assumptions = append(est.BuildCost.Assumptions, mp.Assumptions...)
	if cs.OverBudgetBy != nil {
		cautions = append(cautions, fmt.Sprintf("Expected cost $%s is $%s over the $%s budget.",
			commas(int(cs.Total)), commas(int(*cs.OverBudgetBy)), commas(int(*cs.BudgetUSD))))
	}
	d.Overview.Cautions = dedupe(append(append(d.Overview.Cautions, cautions...),
		"Confirm setbacks, height limits, lot coverage and parking rules with the local zoning office."))
	out.Design, out.Estimate = d, est
	if sups == nil {
		sups = []Supplier{}
	}
	if len(sups) > 25 {
		sups = sups[:25]
	}
	// The design carries its own cost, so one file holds everything the website shows.
	near := sups
	if len(near) > 8 {
		near = near[:8]
	}
	d.Cost = &DesignCost{Currency: est.Currency, AsOf: est.AsOf, BuildCost: est.BuildCost, Breakdown: cs,
		Materials: est.Materials, OverTime: est.OverTime, Suppliers: near}
	fmt.Fprintln(log, "Design ready.")
	out.Report.LineItems, out.Report.CostSummary, out.Report.Suppliers = lines, cs, sups
	out.Report.Warnings = dedupe(warnings)
	return out, nil
}

// finishDesign fills in everything that depends on where the building stands.
func finishDesign(d *Design, p Program, l *Layout, sp SitePlan, f Frame, ring []Pt, siteArea float64) {
	t := p.Text
	d.Overview = Overview{Title: t.Title, Summary: t.Summary, Description: nz(t.Description),
		SiteResponse: nz(t.SiteResponse), Features: nz(t.Features), Cautions: nz(t.Cautions), Style: p.Style}
	if d.Overview.Title == "" {
		d.Overview.Title = title(p.Style) + " " + p.HousingType
	}
	for _, q := range ring {
		d.Site.Outline = append(d.Site.Outline, Pt{math.Round(q[0]*1e7) / 1e7, math.Round(q[1]*1e7) / 1e7})
	}
	d.Site.AreaM2 = r1(siteArea)
	d.Placement = Placement{Origin: BuildingToLngLat(f, sp, Pt{0, 0}), XAxisBearingDeg: r2(sp.Bearing)}
	for _, c := range []Pt{{0, 0}, {l.W, 0}, {l.W, l.D}, {0, l.D}} {
		d.Placement.Footprint = append(d.Placement.Footprint, BuildingToLngLat(f, sp, c))
	}

	// height and roof
	above := 0.0
	for _, lv := range l.Levels {
		if lv.Elev >= -0.01 {
			above += lv.Height
		}
	}
	roof := Roof{Type: p.RoofType, Pitch: p.RoofPitch, EaveM: 0.45}
	switch {
	case p.RoofType == "flat":
		roof.EaveM, roof.Pitch = 0.1, 0
		roof.RidgeHeightM = r2(above + 0.6) // parapet
	default:
		if p.Style == "craftsman" || p.Style == "prairie" {
			roof.EaveM = 0.6
		}
		axis, span := "x", l.D
		if l.D > l.W {
			axis, span = "y", l.W
		}
		if len(l.RoofWings) > 0 {
			// One roof per wing, every wing as deep as the main one.
			span = l.RoofWings[0].Y1 - l.RoofWings[0].Y0
			roof.Wings = l.RoofWings
		}
		roof.RidgeAxis = &axis
		roof.RidgeHeightM = r2(above + p.RoofPitch*(span/2+roof.EaveM))
	}
	d.Exterior.Roof = roof
	d.Size.HeightM = roof.RidgeHeightM

	// garage, porch, parking
	if l.GarageCars > 0 {
		for _, lv := range d.Levels {
			for _, r := range lv.Rooms {
				if r.Type == "garage" && d.Exterior.Garage == nil {
					d.Exterior.Garage = &XGarage{Cars: l.GarageCars, Polygon: r.Polygon.Flat(), HeightM: lv.HeightM}
				}
			}
		}
	}
	if l.Porch != nil {
		d.Exterior.Porch = &XPorch{Polygon: l.Porch.Poly()}
	}
	d.Exterior.Parking = []XParking{}
	spaces := 0
	for _, pk := range sp.Parking {
		d.Exterior.Parking = append(d.Exterior.Parking, XParking{Polygon: pk.Rect.Poly(), Spaces: pk.Spaces})
		spaces += pk.Spaces
	}
	d.Totals.ParkingSpaces = l.GarageCars + spaces
	d.Exterior.Materials = XMaterials{Structure: p.Structure, Cladding: p.Cladding, Roofing: p.Roofing, Palette: p.Palette}
}

func nz(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// soilSummary records the soil under the building and the foundation chosen for it.
func soilSummary(s Site, a Assessment) *SiteSoil {
	so := s.Soil
	name := ""
	if len(so.Components) > 0 {
		name = so.Components[0].Component
	}
	source := "USDA Soil Data Access"
	if s.Estimated {
		source = "ISRIC SoilGrids estimate (outside the US)"
	}
	return &SiteSoil{Source: source, SoilName: name, USCS: so.GoverningUSCS, BearingPSF: so.GoverningBearing,
		ShrinkSwell: so.ShrinkSwell, BedrockIn: so.MinBedrockIn, WaterTableIn: so.MinWaterIn,
		Foundation: humanize(a.FoundationType), FoundationWhy: a.FoundationReason, Note: so.Note}
}

// The street lookup (OpenStreetMap Overpass) is often slow; past this the front faces the best
// site edge instead. The website usually sends the streets itself, so it's rarely needed.
var roadsTimeout = 8 * time.Second

// How long pricing waits for the supplier search once Gemma is done.
var supplierGrace = 10 * time.Second

// withTimeout gives up on f after d (f keeps running in the background and its answer is dropped).
func withTimeout[T any](d time.Duration, f func() (T, error)) (T, error) {
	type res struct {
		v   T
		err error
	}
	ch := make(chan res, 1)
	go func() { v, err := f(); ch <- res{v, err} }()
	select {
	case r := <-ch:
		return r.v, r.err
	case <-time.After(d):
		var zero T
		return zero, fmt.Errorf("no answer in %s", d)
	}
}

// streetBearings faces the front toward the nearest of the streets the website sent ([lng, lat]).
func streetBearings(f Frame, centre Pt, streets [][]Pt) []float64 {
	bestD := math.Inf(1)
	var bestA, bestB Pt
	for _, line := range streets {
		for i := 0; i+1 < len(line); i++ {
			a, b := f.ToLocal(line[i]), f.ToLocal(line[i+1])
			if d := distToSeg(centre, a, b); d < bestD && d < 150 {
				bestD, bestA, bestB = d, a, b
			}
		}
	}
	if math.IsInf(bestD, 1) {
		return nil
	}
	return roadFacingBearings(centre, bestA, bestB)
}

// landNote tells Gemma what the land offers, so the program uses it: how much is buildable, how
// much the first version covers, and the lot's proportions.
func landNote(local []Pt, setback float64, l *Layout) string {
	build := buildableArea(local, setback)
	if build <= 0 {
		return ""
	}
	b := boundsOf(local)
	long, short := b.W(), b.D()
	if short > long {
		long, short = short, long
	}
	share := l.W * l.D / build
	var advice string
	switch {
	case share > 0.8:
		advice = "The building nearly fills the buildable area: keep the footprint compact (a rectangle), go up a floor if the type allows, and leave out what spreads it (deck, wide garage)."
	case share < 0.2 && build > 600:
		advice = "There's plenty of land to spare: the home can spread out and live outdoors (a deck or terrace, a porch, one or two floors rather than three), and a large home reads well as wings (footprintShape l, u or courtyard) round a yard."
	default:
		advice = "The building uses a fair share of the land: keep the yard usable and put the deck or terrace on the side away from the street."
	}
	if long/short > 2.2 {
		advice += " The lot is long and narrow: a long, narrow building along it suits it better than wings."
	}
	return fmt.Sprintf("LAND: %.0f m² is buildable inside the setbacks; the first version covers %.0f%% of it. The lot is about %.0f × %.0f m. %s",
		build, share*100, long, short, advice)
}
