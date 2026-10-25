package main

// The brief's "does it fit" check, answered by the same code that places the real building
// (fitLayout: the layout presets, then FitBuilding on the site with its setback). The website asks
// before sending, so its warning and the design that comes back can't disagree. No Gemma call and
// no site data: it takes well under a second.
//
//	POST /api/fit   a terrasim.design-request/2 (the description may still be empty)  ->  FitReply

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
)

type FitReply struct {
	// ok: fits with room to spare · tight: fits, with little left over (or only once extras
	// are dropped) · over: no placement works.
	Level        string   `json:"level"`
	WidthM       float64  `json:"widthM,omitempty"`
	DepthM       float64  `json:"depthM,omitempty"`
	Floors       int      `json:"floors"`
	FootprintM2  float64  `json:"footprintM2,omitempty"`
	BuildableM2  float64  `json:"buildableM2"`
	Share        float64  `json:"share,omitempty"`
	Dropped      []string `json:"dropped,omitempty"`      // extras left out so it fits
	FloorsNeeded int      `json:"floorsNeeded,omitempty"` // fewest floors that fit, when more would help
	MaxAreaM2    float64  `json:"maxAreaM2,omitempty"`    // the largest size per home that fits on these floors
	Reason       string   `json:"reason,omitempty"`       // why nothing fits
}

var floorRanges = map[string][2]int{"house": {1, 3}, "tiny-home": {1, 2}, "townhouse": {2, 4}, "duplex": {1, 3},
	"apartment": {2, 12}, "condo": {2, 12}, "dorm": {2, 12}}

// FitCheck sizes a first version of the building and tries to place it on the land.
func FitCheck(r Request) (FitReply, error) {
	ht := sv(r.HousingType)
	if !contains(HousingTypes, ht) {
		return FitReply{}, fmt.Errorf("housingType must be one of %v", HousingTypes)
	}
	ring, err := r.SiteRing()
	if err != nil {
		return FitReply{}, err
	}
	if r.Brief.Floors == nil || *r.Brief.Floors < 1 {
		return FitReply{}, fmt.Errorf("brief.floors is needed to check the fit")
	}
	local, _ := localRing(ring)
	setback := r.Setback()
	out := FitReply{Floors: *r.Brief.Floors, BuildableM2: math.Round(buildableArea(local, setback))}

	p := DefaultProgram(r)
	if f, err := fitLayout(p, local, setback, nil); err == nil {
		out.describe(f, p)
		return out, nil
	}
	// The pipeline's own fallback: fewer extras and one garage bay.
	q := lean(p)
	if f, err := fitLayout(q, local, setback, nil); err == nil {
		out.describe(f, q)
		out.Level = "tight"
		out.Dropped = droppedExtras(p, q)
		return out, nil
	} else {
		out.Level, out.Reason = "over", err.Error()
	}
	// What would make it fit: more floors (within the type's range), or a smaller size.
	rng := floorRanges[ht]
	for n := out.Floors + 1; n <= rng[1]; n++ {
		m := q
		m.Floors = n
		if _, err := fitLayout(m, local, setback, nil); err == nil {
			out.FloorsNeeded = n
			break
		}
	}
	if ht != "dorm" && p.AreaM2 > 0 && !p.AreaFromGemma {
		lo, hi := areaMin(ht), p.AreaM2
		m := q
		m.AreaM2 = lo
		if _, err := fitLayout(m, local, setback, nil); err == nil {
			for i := 0; i < 7 && hi-lo > 2; i++ {
				m.AreaM2 = (lo + hi) / 2
				if _, err := fitLayout(m, local, setback, nil); err == nil {
					lo = m.AreaM2
				} else {
					hi = m.AreaM2
				}
			}
			out.MaxAreaM2 = math.Floor(lo)
		}
	}
	return out, nil
}

func (out *FitReply) describe(f fitted, p Program) {
	nd := f.l.Needs(p.ParkingSpaces)
	out.WidthM, out.DepthM = r1(f.l.W), r1(f.l.D)
	out.FootprintM2 = math.Round((nd.Left + nd.W + nd.Right) * (nd.Front + nd.D + nd.Back))
	out.Level = "ok"
	if out.BuildableM2 > 0 {
		out.Share = math.Round(out.FootprintM2/out.BuildableM2*1000) / 1000
		if out.Share > 0.8 {
			out.Level = "tight"
		}
	}
	if f.sp.ParkingMsg != "" {
		out.Level = "tight"
		out.Dropped = append(out.Dropped, "some parking")
	}
}

// lean is the program with only the extras that sit inside the building, and one garage bay.
func lean(p Program) Program {
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
	return q
}

func droppedExtras(p, q Program) []string {
	var out []string
	for _, x := range p.Extras {
		if !contains(q.Extras, x) {
			out = append(out, humanize(x))
		}
	}
	if p.GarageCars > q.GarageCars {
		out = append(out, fmt.Sprintf("%d garage bays", p.GarageCars-q.GarageCars))
	}
	return out
}

func areaMin(ht string) float64 {
	lo, _ := areaRange(ht)
	if lo <= 0 {
		return 12
	}
	return lo
}

// localRing puts a [lng, lat] ring into local metres around its average point.
func localRing(ring []Pt) ([]Pt, Frame) {
	var lng, lat float64
	for _, p := range ring {
		lng, lat = lng+p[0], lat+p[1]
	}
	f := NewFrame(lat/float64(len(ring)), lng/float64(len(ring)))
	local := make([]Pt, len(ring))
	for i, p := range ring {
		local[i] = f.ToLocal(p)
	}
	return local, f
}

// buildableArea is the part of the land at least `setback` from every boundary, measured on a
// fine grid, so it's right for any shape (the browser's inset polygon is only exact for simple ones).
func buildableArea(local []Pt, setback float64) float64 {
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, p := range local {
		minX, minY = math.Min(minX, p[0]), math.Min(minY, p[1])
		maxX, maxY = math.Max(maxX, p[0]), math.Max(maxY, p[1])
	}
	cell := math.Max(0.25, math.Sqrt(PolyArea(local))/300)
	n := 0
	for y := minY + cell/2; y < maxY; y += cell {
		for x := minX + cell/2; x < maxX; x += cell {
			q := Pt{x, y}
			if PointInPoly(q, local) && distToPolyEdge(q, local) >= setback {
				n++
			}
		}
	}
	return float64(n) * cell * cell
}

func (s *server) fit(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var req Request
	if err != nil || json.Unmarshal(raw, &req) != nil {
		writeJSON(w, 400, map[string]string{"message": "The request isn't valid JSON."})
		return
	}
	res, err := FitCheck(req)
	if err != nil {
		writeJSON(w, 422, map[string]string{"message": err.Error()})
		return
	}
	writeJSON(w, 200, res)
}
