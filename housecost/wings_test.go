package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Every wing plan, for each type that has them, runs the whole pipeline and passes the design
// service's and the website's checks.
func TestWingPlans(t *testing.T) {
	for _, shape := range []string{ShapeL, ShapeU, ShapeCourt} {
		for _, ht := range []string{"house", "mansion", "villa"} {
			t.Run(shape+"/"+ht, func(t *testing.T) {
				r := testRequest(ht)
				prompt := map[string]string{ShapeL: "An L-shaped home with a deck.", ShapeU: "A U-shaped home round a garden.",
					ShapeCourt: "A home built round a courtyard."}[shape]
				r.Brief.DesignPrompt = &prompt
				r.Advanced.Extras = []string{"porch", "deck"}
				if ht == "house" {
					// One floor of 320 m²: a smaller home is too small for a courtyard.
					r.Brief.Floors, r.Brief.AreaM2 = ptr(1), ptr(320.0)
				}
				if ht == "villa" {
					r.Brief.AreaM2 = ptr(450.0)
				}
				raw, _ := json.Marshal(r)
				var log bytes.Buffer
				res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &log, Now: time.Now})
				if err != nil {
					t.Fatalf("%v\n%s\nproblems: %v", err, log.String(), res.Report.Problems)
				}
				d := res.Design
				ring, _ := r.SiteRing()
				if probs := CheckDesign(d, ring, r.Setback()); len(probs) > 0 {
					t.Fatalf("checks: %v", probs)
				}
				if len(d.Exterior.Roof.Wings) < 2 {
					t.Fatalf("expected a roof per wing, got %+v", d.Exterior.Roof)
				}
				out := d.Levels[0].Outline.Flat()
				wantPts := map[string]int{ShapeL: 6, ShapeU: 8, ShapeCourt: 11}[shape]
				if len(out) != wantPts {
					t.Fatalf("outline has %d points, want %d: %v", len(out), wantPts, out)
				}
				if a := d.Levels[0].Outline.Area(); a >= d.Size.WidthM*d.Size.DepthM-1 {
					t.Fatalf("outline area %.1f fills the whole %.1f × %.1f box", a, d.Size.WidthM, d.Size.DepthM)
				}
				node, err := exec.LookPath("node")
				if err != nil {
					t.Skip("Node.js is needed to check the website's renderer rules")
				}
				body, _ := json.Marshal(res)
				cmd := exec.Command(node, "--input-type=module", "-e", `
import { readFileSync } from 'node:fs';
import { checkDesign } from './frontend/js/lib/design.js';
const result = checkDesign(JSON.parse(readFileSync(0, 'utf8')).design);
if (!result.ok) throw new Error(JSON.stringify(result.errors));
`)
				cmd.Dir = ".."
				cmd.Stdin = bytes.NewReader(body)
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("website rejected it: %v\n%s", err, output)
				}
			})
		}
	}
}

// A home too small for the plan it asked for is drawn straight, and the design says why.
func TestWingPlanTooSmall(t *testing.T) {
	r := testRequest("house")
	prompt := "A small house round a courtyard."
	r.Brief.DesignPrompt = &prompt
	raw, _ := json.Marshal(r)
	var log bytes.Buffer
	res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &log, Now: time.Now})
	if err != nil {
		t.Fatalf("%v\n%s", err, log.String())
	}
	if n := len(res.Design.Levels[0].Outline.Flat()); n != 4 {
		t.Fatalf("expected a straight plan, outline has %d points", n)
	}
	found := false
	for _, c := range res.Design.Overview.Cautions {
		if strings.Contains(c, "too small for a courtyard plan") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no caution saying why: %v", res.Design.Overview.Cautions)
	}
}
