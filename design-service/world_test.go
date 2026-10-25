package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Terrarium tiles are decoded as (R × 256 + G + B / 256) − 32768 metres.
func TestTerrariumDEM(t *testing.T) {
	tileFor := func(h float64) []byte {
		v := h + 32768
		r, g := int(v)/256, int(v)%256
		b := int((v - math.Floor(v)) * 256)
		im := image.NewRGBA(image.Rect(0, 0, 256, 256))
		for y := 0; y < 256; y++ {
			for x := 0; x < 256; x++ {
				im.Set(x, y, color.RGBA{uint8(r), uint8(g), uint8(b), 255})
			}
		}
		var buf bytes.Buffer
		png.Encode(&buf, im)
		return buf.Bytes()
	}
	tile := tileFor(123.5)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(tile) }))
	defer srv.Close()
	old := TerrariumURL
	TerrariumURL = srv.URL
	defer func() { TerrariumURL = old }()
	g, src, err := FetchTerrariumDEM(48.85, 2.35, [2]float64{60, 40})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(src, "estimated") || g.Rows < 10 || g.Cols < 15 {
		t.Fatalf("grid %d × %d, source %q", g.Rows, g.Cols, src)
	}
	for _, z := range g.Z {
		if math.Abs(z-123.5) > 0.01 {
			t.Fatalf("flat tile at 123.5 m read as %v", z)
		}
	}
}

func TestSoilGridsClasses(t *testing.T) {
	var reply string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, reply) }))
	defer srv.Close()
	old := SoilGridsURL
	SoilGridsURL = srv.URL
	defer func() { SoilGridsURL = old }()
	layer := func(name string, v any) string {
		return fmt.Sprintf(`{"name":%q,"depths":[{"values":{"mean":%v}}]}`, name, v)
	}
	for _, c := range []struct {
		clay, sand, silt any
		want, swell      string
	}{{480, 200, 320, "CH", "high"}, {300, 300, 400, "CL", "moderate"}, {80, 750, 170, "SM", "low"}, {"null", "null", "null", "CL", "moderate"}} {
		reply = `{"properties":{"layers":[` + layer("clay", c.clay) + "," + layer("sand", c.sand) + "," + layer("silt", c.silt) + `]}}`
		s, err := FetchSoilGrids(47, 3)
		if err != nil || s.GoverningUSCS != c.want || s.ShrinkSwell != c.swell || s.GoverningBearing == nil || s.Note == "" {
			t.Errorf("clay %v sand %v: got %+v %v, want %s %s", c.clay, c.sand, s, err, c.want, c.swell)
		}
	}
}

// Outside the US every assumption is stated and the site is marked estimated.
func TestWorldAssumptions(t *testing.T) {
	var s Site
	worldAssumptions(&s)
	if !s.Estimated || s.Labor.WageFactor != 1 || s.Flood.FloodZone != "unknown" || len(s.Warnings) < 4 {
		t.Fatalf("%+v", s)
	}
	if inUSData(2.35, 48.85) || !inUSData(-80.41, 37.23) {
		t.Fatal("US coverage boxes")
	}
	r := testRequest("house")
	f := NewFrame(48.85, 2.35)
	var ring [][]*float64
	for _, p := range []Pt{{-20, -20}, {20, -20}, {20, 20}, {-20, 20}, {-20, -20}} {
		ll := f.ToLngLat(p)
		ring = append(ring, []*float64{ptr(ll[0]), ptr(ll[1])})
	}
	r.Site.Geometry.Coordinates = [][][]*float64{ring}
	if probs := ValidateRequest(r); len(probs) > 0 {
		t.Fatalf("land in Paris should be accepted: %v", probs)
	}
}
