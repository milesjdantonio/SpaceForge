package main

// The request → design + estimate pipeline.

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"
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
}

// stopped is true once the user has cancelled this design.
func (dp Deps) stopped() bool { return dp.Ctx != nil && dp.Ctx.Err() != nil }

func LiveDeps(ask AskFunc, log io.Writer, ov map[string]Override) Deps {
	return Deps{
		FetchSite: FetchSiteData,
		Roads:     func(f Frame, c Pt) ([]float64, error) { return FetchRoadBearings(f, c, 120) },
		Suppliers: func(lat, lon float64) ([]Supplier, error) { return FetchSuppliers(lat, lon, SearchRadiusKm) },
		Ask:       ask, Now: time.Now, Log: log, Overrides: ov,
	}
}

// FetchSiteData pulls every free data source for the site and the building's footprint.
func FetchSiteData(q SiteQuery) (Site, error) {
	lat, lon := q.Footprint[1], q.Footprint[0]
	ft := q.SetbackM / MPerFt
	s := Site{Setbacks: Setbacks{ft, ft, ft}, LotFt: q.SiteDimsFt}
	warn := func(label string, err error) {
		s.Warnings = append(s.Warnings, fmt.Sprintf("%s unavailable (%v); used a default.", label, err))
	}
	var err error
	if s.Location, err = FetchLocation(q.Centroid[1], q.Centroid[0]); err != nil {
		warn("Location", err)
	}
	grid, src, err := FetchDEM(lat, lon, q.FootprintFt)
	if err != nil {
		return s, fmt.Errorf("elevation: %w", err)
	}
	s.Terrain = AnalyzeFootprint(grid)
	s.Terrain.ElevationSource = src
	if s.Climate, err = FetchClimate(lat, lon); err != nil {
		return s, fmt.Errorf("climate: %w", err)
	}
	if s.Flood, err = FetchFlood(lat, lon); err != nil {
		warn("FEMA flood zone", err)
		s.Flood = Flood{"unknown", false}
	}
	if s.Seismic, err = FetchSeismic(lat, lon); err != nil {
		warn("USGS seismic", err)
		s.Seismic = Seismic{SDC: "unknown"}
	}
	if s.Soil, err = FetchSoil(q.SiteBox); err != nil {
		return s, fmt.Errorf("soil: %w", err)
	}
	if s.Labor, err = FetchWageFactor(s.Location.StateCode); err != nil {
		warn("BLS wages", err)
		s.Labor = Labor{WageFactor: 1}
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
	for v := 0; ; v++ {
		l, err := BuildLayout(p, v)
		if err == ErrNoPreset {
			break
		}
		if err != nil {
			lastErr = err
			continue
		}
		sp, err := FitBuilding(local, setback, l.Needs(p.ParkingSpaces), bearings)
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
	case "apartment", "condo":
		return fmt.Sprintf("a %d-floor %s building with %d homes (average %.0f m²)", p.Floors, p.HousingType, p.UnitCount, p.AreaM2)
	}
	s := fmt.Sprintf("a %d-floor %s", p.Floors, p.HousingType)
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

	// 1. which way the front faces: toward the nearest mapped street
	var bearings []float64
	if dp.Roads != nil {
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
	pr, err := AskUntilValid(BuildProgramPrompt(rAdj, site, a, sizing), ParseProgram,
		func(x ProgramReply) []string { return ValidateProgram(x, rAdj, site, a) }, dp.Ask, "design program", 8192, 3, log)
	if err != nil {
		out.Report.Verdict, out.Report.Problems = "error", []string{err.Error()}
		return out, err
	}
	p := DefaultProgram(rAdj).Merge(pr)
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
		cautions = append(cautions, "The roof terrace isn't drawn in this version; it would need a stair or elevator to the roof and a guard rail.")
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

	if probs := CheckDesign(d, ring, setback); len(probs) > 0 {
		out.Design = d
		out.Report.Verdict, out.Report.Problems = "error", probs
		return out, fmt.Errorf("the generated design breaks %d renderer rules", len(probs))
	}

	// 7. Gemma: materials
	if dp.stopped() {
		return out, ErrCancelled
	}
	mp, err := AskUntilValid(BuildMaterialsPlanPrompt(p, a, d, site), ParseMaterialPlan,
		func(x MaterialPlan) []string { return ValidateMaterialPlan(x, a, p, d, site) }, dp.Ask, "materials", 16384, 3, log)
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
	if dp.Suppliers != nil {
		if sups, err = dp.Suppliers(cLat, cLng); err != nil {
			warnings = append(warnings, fmt.Sprintf("Supplier search unavailable (%v).", err))
		}
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
					d.Exterior.Garage = &XGarage{Cars: l.GarageCars, Polygon: r.Polygon, HeightM: lv.HeightM}
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
	return &SiteSoil{Source: "USDA Soil Data Access", SoilName: name, USCS: so.GoverningUSCS, BearingPSF: so.GoverningBearing,
		ShrinkSwell: so.ShrinkSwell, BedrockIn: so.MinBedrockIn, WaterTableIn: so.MinWaterIn,
		Foundation: humanize(a.FoundationType), FoundationWhy: a.FoundationReason, Note: so.Note}
}
