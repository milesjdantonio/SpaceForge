package main

// Curved edges (contracts/FIELDS.md, "Curved walls"). An edge of an outline or room polygon, or a
// wall, may follow an ellipse { cx, cy, rx, ry } (rx = ry for a circle, axes along building x and
// y) from one end to the other, the short way round. In JSON a curved polygon edge is written as a
// third item on the vertex it starts from: [x, y, {"cx":…, "cy":…, "rx":…, "ry":…}].

import (
	"encoding/json"
	"fmt"
	"math"
)

type Arc struct {
	CX float64 `json:"cx"`
	CY float64 `json:"cy"`
	RX float64 `json:"rx"`
	RY float64 `json:"ry"`
}

// arcStep is the longest straight piece used when a curve is drawn or measured.
const arcStep = 0.25

// param is the ellipse angle of a point on it.
func (a Arc) param(p Pt) float64 { return math.Atan2((p[1]-a.CY)/a.RY, (p[0]-a.CX)/a.RX) }
func (a Arc) at(t float64) Pt    { return Pt{a.CX + a.RX*math.Cos(t), a.CY + a.RY*math.Sin(t)} }

// sweep is the signed angle from p to q along the ellipse, the short way (|sweep| < π).
func (a Arc) sweep(p, q Pt) (float64, float64) {
	t0 := a.param(p)
	d := a.param(q) - t0
	for d > math.Pi {
		d -= 2 * math.Pi
	}
	for d < -math.Pi {
		d += 2 * math.Pi
	}
	return t0, d
}

// Points samples the curve from p to q, both ends included and exact.
func (a Arc) Points(p, q Pt) []Pt {
	t0, d := a.sweep(p, q)
	n := int(math.Max(2, math.Ceil(math.Abs(d)*math.Max(a.RX, a.RY)/arcStep)))
	out := make([]Pt, 0, n+1)
	out = append(out, p)
	for i := 1; i < n; i++ {
		out = append(out, a.at(t0+d*float64(i)/float64(n)))
	}
	return append(out, q)
}

// Ring is a closed polygon whose edges may be curved: Arcs[i], when set, curves the edge from
// Pts[i] to Pts[i+1] (the last one back to Pts[0]).
type Ring struct {
	Pts  []Pt
	Arcs []*Arc
}

func RingOf(pts []Pt) Ring { return Ring{Pts: pts} }

func (r Ring) arc(i int) *Arc {
	if i < len(r.Arcs) {
		return r.Arcs[i]
	}
	return nil
}

func (r Ring) Curved() bool {
	for _, a := range r.Arcs {
		if a != nil {
			return true
		}
	}
	return false
}

// Flat is the ring with every curve sampled into short straight pieces.
func (r Ring) Flat() []Pt {
	if !r.Curved() {
		return r.Pts
	}
	var out []Pt
	n := len(r.Pts)
	for i, p := range r.Pts {
		out = append(out, p)
		if a := r.arc(i); a != nil {
			pts := a.Points(p, r.Pts[(i+1)%n])
			out = append(out, pts[1:len(pts)-1]...)
		}
	}
	return out
}

func (r Ring) Area() float64      { return PolyArea(r.Flat()) }
func (r Ring) Perimeter() float64 { return PolyPerimeter(r.Flat()) }

func (r Ring) MarshalJSON() ([]byte, error) {
	out := make([]any, len(r.Pts))
	for i, p := range r.Pts {
		if a := r.arc(i); a != nil {
			out[i] = []any{p[0], p[1], a}
		} else {
			out[i] = p
		}
	}
	return json.Marshal(out)
}

func (r *Ring) UnmarshalJSON(b []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	r.Pts, r.Arcs = make([]Pt, len(raw)), nil
	for i, v := range raw {
		var parts []json.RawMessage
		if err := json.Unmarshal(v, &parts); err != nil || len(parts) < 2 {
			return fmt.Errorf("polygon point %d is not [x, y]", i)
		}
		if err := json.Unmarshal(parts[0], &r.Pts[i][0]); err != nil {
			return err
		}
		if err := json.Unmarshal(parts[1], &r.Pts[i][1]); err != nil {
			return err
		}
		if len(parts) > 2 {
			var a Arc
			if err := json.Unmarshal(parts[2], &a); err != nil {
				return fmt.Errorf("polygon point %d: the curve must be {cx, cy, rx, ry}: %v", i, err)
			}
			for len(r.Arcs) < i {
				r.Arcs = append(r.Arcs, nil)
			}
			r.Arcs = append(r.Arcs, &a)
		}
	}
	return nil
}

// wallPath is the wall's centre line as points: its two ends, or its curve sampled.
func (w DWall) wallPath() []Pt {
	a, b := Pt{w.X1, w.Y1}, Pt{w.X2, w.Y2}
	if w.Arc != nil {
		return w.Arc.Points(a, b)
	}
	return []Pt{a, b}
}

// pointAlong is the point s metres along the wall from its (x1, y1) end.
func (w DWall) pointAlong(s float64) Pt {
	pts := w.wallPath()
	for i := 1; i < len(pts); i++ {
		l := math.Hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1])
		if s <= l || i == len(pts)-1 {
			t := 0.0
			if l > 0 {
				t = math.Min(1, math.Max(0, s/l))
			}
			return Pt{pts[i-1][0] + (pts[i][0]-pts[i-1][0])*t, pts[i-1][1] + (pts[i][1]-pts[i-1][1])*t}
		}
		s -= l
	}
	return pts[len(pts)-1]
}

// distanceAlong is how far along the wall the point on it nearest to p lies.
func (w DWall) distanceAlong(p Pt) float64 {
	pts := w.wallPath()
	best, bestD, run := 0.0, math.Inf(1), 0.0
	for i := 1; i < len(pts); i++ {
		a, b := pts[i-1], pts[i]
		l := math.Hypot(b[0]-a[0], b[1]-a[1])
		t := 0.0
		if l > 0 {
			t = math.Max(0, math.Min(1, ((p[0]-a[0])*(b[0]-a[0])+(p[1]-a[1])*(b[1]-a[1]))/(l*l)))
		}
		q := Pt{a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t}
		if d := math.Hypot(p[0]-q[0], p[1]-q[1]); d < bestD {
			best, bestD = run+t*l, d
		}
		run += l
	}
	return best
}
