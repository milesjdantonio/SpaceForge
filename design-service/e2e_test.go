package main

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
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

func TestPipelineEveryHousingType(t *testing.T) {
	for _, ht := range HousingTypes {
		t.Run(ht, func(t *testing.T) {
			if isSiteType(ht) {
				t.Skip("sites have their own test (sites_test.go)")
			}
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
			t.Run("frontend-renderer", func(t *testing.T) {
				node, err := exec.LookPath("node")
				if err != nil {
					t.Skip("Node.js is needed to check the actual frontend renderer contract")
				}
				cmd := exec.Command(node, "--input-type=module", "-e", `
import { readFileSync } from 'node:fs';
import { checkDesign } from './website/js/lib/design.js';
const result = checkDesign(JSON.parse(readFileSync(0, 'utf8')).design);
if (!result.ok) throw new Error(JSON.stringify(result.errors));
`)
				cmd.Dir = ".."
				cmd.Stdin = bytes.NewReader(out)
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("generated design rejected by frontend: %v\n%s", err, output)
				}
			})
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
