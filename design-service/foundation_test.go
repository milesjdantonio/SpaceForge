package main

import (
	"math"
	"testing"
)

func TestGroundPlaneAndFoundation(t *testing.T) {
	// A 30 × 30 m grid that rises 0.2 m per metre northward (20%).
	g := Grid{Rows: 30, Cols: 30, Res: 1, Z: make([]float64, 900)}
	for i := 0; i < 30; i++ {
		for j := 0; j < 30; j++ {
			north := 15 - (float64(i) + 0.5)
			g.Z[i*30+j] = 100 + 0.2*north
		}
	}
	lat, lon := 37.0, -80.0
	p := fitGround(g, lat, lon)
	if !p.ok || math.Abs(p.C-0.2) > 1e-6 || math.Abs(p.B) > 1e-6 || math.Abs(p.A-100) > 1e-6 {
		t.Fatalf("plane: %+v", p)
	}
	// A 10 × 8 m building whose x axis points east: y (front to back) points north, so the front
	// (south) is downhill and the ground falls 1.6 m across its depth.
	d := &Design{Size: Size{WidthM: 10, DepthM: 8}, Levels: []DLevel{{ElevationM: 0}}}
	f := NewFrame(lat, lon)
	at := func(q Pt) Pt { return f.ToLngLat(Pt{q[0], q[1]}) } // x east, y north
	fd := foundationFor(d, p, "slab_on_grade", at)
	if fd == nil || math.Abs(fd.DropM-1.6) > 0.02 || fd.Downhill != "front" || fd.Type != "stepped" {
		t.Fatalf("foundation: %+v", fd)
	}
	if fd.GroundM[2] != 0 || math.Abs(fd.GroundM[0]+1.6) > 0.02 {
		t.Fatalf("ground at corners, from the uphill floor: %v", fd.GroundM)
	}
	if fp := foundationFor(d, p, "pier_and_beam", at); fp.Type != "piers" {
		t.Fatalf("piers: %+v", fp)
	}
	flat := foundationFor(d, groundPlane{Lat0: lat, Lon0: lon, A: 5, ok: true}, "slab_on_grade", at)
	if flat.Type != "slab" || flat.DropM != 0 || flat.Downhill != "" {
		t.Fatalf("flat land: %+v", flat)
	}
}
