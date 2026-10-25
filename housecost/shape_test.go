package main

import (
	"bytes"
	"encoding/json"
	"math"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestShapeFromPrompt(t *testing.T) {
	for text, want := range map[string]string{
		"A round house with a big window wall":                   ShapeRound,
		"make it a circle":                                       ShapeRound,
		"An oval tower of apartments":                            ShapeRound,
		"Please follow the shape of the lot, brick, two storeys": ShapeLand,
		"Fill the land with a low courtyard building":            ShapeLand,
		"A modern farmhouse with a wrap-around porch":            "",
		"Grounded and calm; surround the garden":                 "",
	} {
		if got := shapeFromPrompt(text); got != want {
			t.Errorf("%q: got %q, want %q", text, got, want)
		}
	}
	if normalizeShape("Circular") != ShapeRound || normalizeShape("follow the lot") != ShapeLand || normalizeShape("Rectangle") != ShapeRect {
		t.Error("normalizeShape")
	}
}

func TestRingJSONKeepsCurves(t *testing.T) {
	e := &Arc{CX: 5, CY: 5, RX: 5, RY: 5}
	r := Ring{Pts: []Pt{{10, 5}, {5, 10}, {0, 5}, {5, 0}}, Arcs: []*Arc{e, e, e, e}}
	b, _ := json.Marshal(r)
	if !strings.Contains(string(b), `[10,5,{"cx":5,"cy":5,"rx":5,"ry":5}]`) {
		t.Fatalf("curve not written: %s", b)
	}
	var back Ring
	if err := json.Unmarshal(b, &back); err != nil || !back.Curved() || len(back.Pts) != 4 {
		t.Fatalf("curve not read back: %v %+v", err, back)
	}
	if a := back.Area(); math.Abs(a-math.Pi*25) > 0.3 {
		t.Fatalf("a circle of radius 5 has area %.2f, got %.2f", math.Pi*25, a)
	}
	plain, _ := json.Marshal(RingOf([]Pt{{0, 0}, {1, 0}, {1, 1}}))
	if string(plain) != "[[0,0],[1,0],[1,1]]" {
		t.Fatalf("straight rings stay plain: %s", plain)
	}
	w := DWall{X1: 10, Y1: 5, X2: 5, Y2: 10, Arc: e}
	if l := w.Length(); math.Abs(l-math.Pi*5/2) > 0.02 {
		t.Fatalf("a quarter circle of radius 5 is %.3f m, got %.3f", math.Pi*5/2, l)
	}
}

// A round or land-shaped building through the whole pipeline: curved outline, rooms that still fill
// it, every opening on a wall, inside the land, and accepted by the website's own checks.
func TestShapedBuildings(t *testing.T) {
	cases := []struct{ ht, prompt, shape string }{
		{"house", "A round house of white stucco, open and bright, with a cone roof.", ShapeRound},
		{"tiny-home", "A little circular cabin in the woods.", ShapeRound},
		{"apartment", "An oval apartment building with a calm courtyard feel.", ShapeRound},
		{"house", "Follow the shape of the lot: a long low brick house.", ShapeLand},
	}
	for _, tc := range cases {
		t.Run(tc.ht+"-"+tc.shape, func(t *testing.T) {
			r := testRequest(tc.ht)
			r.Brief.DesignPrompt = ptr(tc.prompt)
			if tc.shape == ShapeLand {
				// A five-sided lot, so following it shows.
				f := NewFrame(37.2296, -80.4139)
				var ring [][]*float64
				for _, p := range []Pt{{-30, -40}, {28, -36}, {36, 10}, {0, 44}, {-34, 18}, {-30, -40}} {
					ll := f.ToLngLat(p)
					ring = append(ring, []*float64{ptr(ll[0]), ptr(ll[1])})
				}
				r.Site.Geometry.Coordinates = [][][]*float64{ring}
			}
			raw, _ := json.Marshal(r)
			var log bytes.Buffer
			res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &log,
				Now: time.Now, Suppliers: func(float64, float64) ([]Supplier, error) { return nil, nil }})
			if err != nil || res.Design == nil {
				t.Fatalf("%v\n%s\n%v", err, log.String(), res.Report.Problems)
			}
			d := res.Design
			if !strings.Contains(log.String(), "Shaping the building") || strings.Contains(log.String(), "kept it rectangular") {
				t.Fatalf("not shaped:\n%s", log.String())
			}
			ground := d.Levels[0].Outline
			if tc.shape == ShapeRound && !ground.Curved() {
				t.Fatal("a round building needs a curved outline")
			}
			if tc.shape == ShapeLand && len(ground.Pts) < 5 {
				t.Fatalf("the land-shaped outline should follow the five-sided lot: %v", ground.Pts)
			}
			ring, _ := r.SiteRing()
			if probs := CheckShaped(d, ring, r.Setback()); len(probs) > 0 {
				t.Fatalf("shaped check: %v", probs)
			}
			for _, lv := range d.Levels {
				for _, p := range lv.Outline.Flat() {
					if p[0] < -0.01 || p[1] < -0.01 || p[0] > d.Size.WidthM+0.01 || p[1] > d.Size.DepthM+0.01 {
						t.Fatalf("outline point %v outside size %v × %v", p, d.Size.WidthM, d.Size.DepthM)
					}
				}
			}
			if tc.shape == ShapeRound && d.Exterior.Roof.Type != "flat" && d.Exterior.Roof.Type != "cone" {
				t.Fatalf("a pitched roof on a round plan is a cone, got %s", d.Exterior.Roof.Type)
			}
			out, _ := json.Marshal(res)
			if node, err := exec.LookPath("node"); err == nil {
				cmd := exec.Command(node, "--input-type=module", "-e", `
import { readFileSync } from 'node:fs';
import { checkDesign } from './frontend/js/lib/design.js';
const result = checkDesign(JSON.parse(readFileSync(0, 'utf8')).design);
if (!result.ok) throw new Error(JSON.stringify(result.errors));
`)
				cmd.Dir = ".."
				cmd.Stdin = bytes.NewReader(out)
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("the website rejects the shaped design: %v\n%s", err, output)
				}
			}
			t.Logf("%s: %.1f × %.1f m, %d points round the ground floor, %.0f m² finished, roof %s",
				tc.shape, d.Size.WidthM, d.Size.DepthM, len(ground.Flat()), d.Totals.FinishedAreaM2, d.Exterior.Roof.Type)
		})
	}
}

func TestWingShapeWords(t *testing.T) {
	for text, want := range map[string]string{
		"A home built round a courtyard":              ShapeCourt,
		"A Spanish courtyard house":                   ShapeCourt,
		"rooms around a central atrium":               ShapeCourt,
		"An L-shaped farmhouse":                       ShapeL,
		"an L shape with the garage wing":             ShapeL,
		"A U-shaped villa round a pool garden":        ShapeU,
		"An oval building with a calm courtyard feel": ShapeRound,
		"Lovely garden, nothing special about shape":  "",
	} {
		if got := shapeFromPrompt(text); got != want {
			t.Errorf("%q: got %q, want %q", text, got, want)
		}
	}
	if shapeForType("townhouse", ShapeL) != ShapeRect || shapeForType("villa", ShapeU) != ShapeU {
		t.Error("shapeForType")
	}
}
