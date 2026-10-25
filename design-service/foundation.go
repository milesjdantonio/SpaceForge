package main

// Buildings on sloping land. The elevation grid under the building is fitted with a plane, so the
// ground's height is known at any corner of the finished building; with the foundation the site
// assessment chose, that becomes the design's exterior.foundation: how the building meets the
// ground. On a slope it stands on piers, on a stepped footing, or over a walkout lower level, and
// the website draws exactly that (contracts/FIELDS.md, exterior.foundation).

import (
	"fmt"
	"math"
	"strings"
)

// groundPlane is z = A + B·east + C·north (metres), around a point.
type groundPlane struct {
	Lat0, Lon0, A, B, C float64
	ok                  bool
}

func (g groundPlane) at(lng, lat float64) float64 {
	de := (lng - g.Lon0) * 111320 * math.Cos(g.Lat0*math.Pi/180)
	dn := (lat - g.Lat0) * 110574
	return g.A + g.B*de + g.C*dn
}

// fitGround fits the plane to a north-up grid centred on (lat, lon) by least squares.
func fitGround(g Grid, lat, lon float64) groundPlane {
	w, d := float64(g.Cols)*g.Res, float64(g.Rows)*g.Res
	var n, sx, sy, sz, sxx, syy, sxy, sxz, syz float64
	for i := 0; i < g.Rows; i++ {
		for j := 0; j < g.Cols; j++ {
			z := g.at(i, j)
			if math.IsNaN(z) {
				continue
			}
			x := (float64(j)+0.5)*g.Res - w/2
			y := d/2 - (float64(i)+0.5)*g.Res
			n++
			sx, sy, sz = sx+x, sy+y, sz+z
			sxx, syy, sxy = sxx+x*x, syy+y*y, sxy+x*y
			sxz, syz = sxz+x*z, syz+y*z
		}
	}
	if n < 3 {
		return groundPlane{}
	}
	// Normal equations for [A B C].
	m := [3][4]float64{{n, sx, sy, sz}, {sx, sxx, sxy, sxz}, {sy, sxy, syy, syz}}
	for c := 0; c < 3; c++ {
		p := c
		for r := c + 1; r < 3; r++ {
			if math.Abs(m[r][c]) > math.Abs(m[p][c]) {
				p = r
			}
		}
		m[c], m[p] = m[p], m[c]
		if math.Abs(m[c][c]) < 1e-12 {
			return groundPlane{Lat0: lat, Lon0: lon, A: sz / n, ok: true} // flat or degenerate: level
		}
		for r := 0; r < 3; r++ {
			if r != c {
				f := m[r][c] / m[c][c]
				for k := c; k < 4; k++ {
					m[r][k] -= f * m[c][k]
				}
			}
		}
	}
	return groundPlane{Lat0: lat, Lon0: lon, A: m[0][3] / m[0][0], B: m[1][3] / m[1][1], C: m[2][3] / m[2][2], ok: true}
}

// XFoundation is how the building meets the ground (exterior.foundation in the design).
type XFoundation struct {
	// Type: slab, crawlspace, basement, stepped (a footing that steps down the slope), walkout (a
	// lower level open to the downhill side) or piers (the floor raised on pillars).
	Type string `json:"type"`
	// GroundM is the ground's height at the corners of the size rectangle, (0,0), (W,0), (W,D),
	// (0,D), in metres from the ground floor's floor (negative: below it).
	GroundM [4]float64 `json:"groundM"`
	// DropM is how far the ground falls across the building.
	DropM float64 `json:"dropM"`
	// Downhill is the side the ground falls toward: front, back, left or right.
	Downhill string `json:"downhill"`
}

// foundationFor works out the foundation of a finished design on its land. at converts a point in
// the design's building metres to [lng, lat].
func foundationFor(d *Design, g groundPlane, assessed string, at func(Pt) Pt) *XFoundation {
	if !g.ok {
		return nil
	}
	W, D := d.Size.WidthM, d.Size.DepthM
	corners := []Pt{{0, 0}, {W, 0}, {W, D}, {0, D}}
	var h [4]float64
	hi, lo := math.Inf(-1), math.Inf(1)
	for i, c := range corners {
		ll := at(c)
		h[i] = g.at(ll[0], ll[1])
		hi, lo = math.Max(hi, h[i]), math.Min(lo, h[i])
	}
	f := &XFoundation{DropM: r2(hi - lo)}
	// The ground floor sits at the uphill ground; everything is measured from there.
	for i := range h {
		f.GroundM[i] = r2(h[i] - hi)
	}
	// Which side is lowest: the mean of each side's two corners.
	sides := map[string]float64{"front": h[0] + h[1], "right": h[1] + h[2], "back": h[2] + h[3], "left": h[3] + h[0]}
	low := math.Inf(1)
	for _, s := range []string{"front", "right", "back", "left"} {
		if sides[s] < low {
			low, f.Downhill = sides[s], s
		}
	}
	hasBasement := false
	for _, lv := range d.Levels {
		if lv.ElevationM < -0.01 {
			hasBasement = true
		}
	}
	switch {
	case strings.Contains(assessed, "pier") || strings.Contains(assessed, "helical"):
		f.Type = "piers"
	case assessed == "walkout_basement" && hasBasement:
		f.Type = "walkout"
	case strings.Contains(assessed, "basement") && hasBasement:
		f.Type = "basement"
	case assessed == "stepped_footing":
		f.Type = "stepped"
	case assessed == "crawlspace":
		f.Type = "crawlspace"
	default:
		f.Type = "slab"
	}
	// A slab or crawlspace can't sit on a real slope: past about a metre of fall it steps down.
	if (f.Type == "slab" || f.Type == "crawlspace" || f.Type == "basement") && f.DropM >= 1.0 {
		f.Type = "stepped"
		if hasBasement {
			f.Type = "walkout"
		}
	}
	if f.DropM < 0.3 {
		f.Downhill = ""
	}
	return f
}

// siteLine says, for the overview's siteResponse, how the building meets a slope; "" on level land.
func (f *XFoundation) siteLine() string {
	if f == nil || f.DropM < 0.4 {
		return ""
	}
	side := map[string]string{"front": "the front", "back": "the back", "left": "the left side", "right": "the right side"}[f.Downhill]
	switch f.Type {
	case "piers":
		return fmt.Sprintf("The ground falls %.1f m toward %s; the floor stands level on piers, highest on the downhill side.", f.DropM, side)
	case "walkout":
		return fmt.Sprintf("The ground falls %.1f m toward %s; the lower level opens out at ground level on that side (a walkout).", f.DropM, side)
	case "stepped":
		return fmt.Sprintf("The ground falls %.1f m toward %s; the footing steps down with it, so the floor stays level without a big cut.", f.DropM, side)
	}
	return ""
}
