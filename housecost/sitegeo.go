package main

// Site geometry: a local metre frame around the site, polygon helpers, and the
// search for where (and which way round) the building fits inside the setback.

import (
	"fmt"
	"math"
	"net/url"
	"sort"
)

// Frame converts between [lng, lat] and local metres (east, north) around a point.
type Frame struct{ Lat0, Lon0, kx, ky float64 }

func NewFrame(lat0, lon0 float64) Frame {
	return Frame{lat0, lon0, 111320 * math.Cos(lat0*math.Pi/180), 110574}
}

func (f Frame) ToLocal(p Pt) Pt  { return Pt{(p[0] - f.Lon0) * f.kx, (p[1] - f.Lat0) * f.ky} }
func (f Frame) ToLngLat(p Pt) Pt { return Pt{f.Lon0 + p[0]/f.kx, f.Lat0 + p[1]/f.ky} }

func PolyArea(p []Pt) float64 {
	a := 0.0
	for i := range p {
		j := (i + 1) % len(p)
		a += p[i][0]*p[j][1] - p[j][0]*p[i][1]
	}
	return math.Abs(a) / 2
}

func PolyPerimeter(p []Pt) float64 {
	s := 0.0
	for i := range p {
		j := (i + 1) % len(p)
		s += math.Hypot(p[j][0]-p[i][0], p[j][1]-p[i][1])
	}
	return s
}

func PolyCentroid(p []Pt) Pt {
	var cx, cy, a float64
	for i := range p {
		j := (i + 1) % len(p)
		c := p[i][0]*p[j][1] - p[j][0]*p[i][1]
		a += c
		cx += (p[i][0] + p[j][0]) * c
		cy += (p[i][1] + p[j][1]) * c
	}
	if math.Abs(a) < 1e-12 {
		return p[0]
	}
	return Pt{cx / (3 * a), cy / (3 * a)}
}

func PointInPoly(q Pt, p []Pt) bool {
	in := false
	for i, j := 0, len(p)-1; i < len(p); j, i = i, i+1 {
		if (p[i][1] > q[1]) != (p[j][1] > q[1]) &&
			q[0] < (p[j][0]-p[i][0])*(q[1]-p[i][1])/(p[j][1]-p[i][1])+p[i][0] {
			in = !in
		}
	}
	return in
}

func distToSeg(q, a, b Pt) float64 {
	dx, dy := b[0]-a[0], b[1]-a[1]
	l2 := dx*dx + dy*dy
	t := 0.0
	if l2 > 0 {
		t = math.Max(0, math.Min(1, ((q[0]-a[0])*dx+(q[1]-a[1])*dy)/l2))
	}
	return math.Hypot(q[0]-a[0]-t*dx, q[1]-a[1]-t*dy)
}

func distToPolyEdge(q Pt, p []Pt) float64 {
	d := math.Inf(1)
	for i := range p {
		d = math.Min(d, distToSeg(q, p[i], p[(i+1)%len(p)]))
	}
	return d
}

// Bearing helpers. Compass bearing b: 0 = north, 90 = east.
// Building x axis u = (sin b, cos b); y axis (front → back) v = (cos b, −sin b),
// so the front (y = 0 side) faces bearing b − 90.
func axes(b float64) (u, v Pt) {
	r := b * math.Pi / 180
	return Pt{math.Sin(r), math.Cos(r)}, Pt{math.Cos(r), -math.Sin(r)}
}

func dot(a, b Pt) float64 { return a[0]*b[0] + a[1]*b[1] }

func normBearing(b float64) float64 {
	b = math.Mod(b, 360)
	if b < 0 {
		b += 360
	}
	return b
}

// Needs is the space the building occupies in its own frame, relative to the
// main rectangle [0,W]×[0,D]: extensions in front (porch, balconies), behind
// (deck, balconies) and to the sides.
type Needs struct {
	W, D                     float64
	Front, Back, Left, Right float64
	ParkingSpaces            int
}

// SitePlan is where the building ends up.
type SitePlan struct {
	Bearing     float64
	OriginLocal Pt // local E,N of building (0,0)
	Parking     []XParkingLocal
	ParkingMsg  string
	Candidates  int
}

type XParkingLocal struct {
	Rect   Rect // building frame
	Spaces int
}

type siteGrid struct {
	poly       []Pt // in rotated frame (X along u, Y along v)
	minX, minY float64
	nx, ny     int
	cell       float64
	ok         []bool
	sat        []int
}

func newSiteGrid(local []Pt, b, setback, cell float64) *siteGrid {
	u, v := axes(b)
	g := &siteGrid{cell: cell}
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, p := range local {
		q := Pt{dot(p, u), dot(p, v)}
		g.poly = append(g.poly, q)
		minX, minY = math.Min(minX, q[0]), math.Min(minY, q[1])
		maxX, maxY = math.Max(maxX, q[0]), math.Max(maxY, q[1])
	}
	g.minX, g.minY = minX, minY
	g.nx, g.ny = int(math.Ceil((maxX-minX)/cell)), int(math.Ceil((maxY-minY)/cell))
	g.ok = make([]bool, g.nx*g.ny)
	tol := cell * 0.75 // a cell counts only if its whole square clears the setback
	for j := 0; j < g.ny; j++ {
		for i := 0; i < g.nx; i++ {
			c := Pt{minX + (float64(i)+0.5)*cell, minY + (float64(j)+0.5)*cell}
			g.ok[j*g.nx+i] = PointInPoly(c, g.poly) && distToPolyEdge(c, g.poly) >= setback+tol
		}
	}
	g.sat = make([]int, (g.nx+1)*(g.ny+1))
	w := g.nx + 1
	for j := 0; j < g.ny; j++ {
		for i := 0; i < g.nx; i++ {
			v := 0
			if g.ok[j*g.nx+i] {
				v = 1
			}
			g.sat[(j+1)*w+i+1] = v + g.sat[j*w+i+1] + g.sat[(j+1)*w+i] - g.sat[j*w+i]
		}
	}
	return g
}

func (g *siteGrid) allOK(i0, j0, ci, cj int) bool {
	if i0 < 0 || j0 < 0 || i0+ci > g.nx || j0+cj > g.ny {
		return false
	}
	w := g.nx + 1
	s := g.sat[(j0+cj)*w+i0+ci] - g.sat[j0*w+i0+ci] - g.sat[(j0+cj)*w+i0] + g.sat[j0*w+i0]
	return s == ci*cj
}

// exact check: rectangle (rotated frame) inside polygon with clearance ≥ setback
func rectClear(poly []Pt, x0, y0, x1, y1, setback float64) bool {
	n := func(a, b float64) int { return int(math.Max(1, math.Ceil((b-a)/0.4))) }
	edges := [][4]float64{{x0, y0, x1, y0}, {x1, y0, x1, y1}, {x1, y1, x0, y1}, {x0, y1, x0, y0}}
	for _, e := range edges {
		k := n(0, math.Hypot(e[2]-e[0], e[3]-e[1]))
		for s := 0; s <= k; s++ {
			t := float64(s) / float64(k)
			q := Pt{e[0] + t*(e[2]-e[0]), e[1] + t*(e[3]-e[1])}
			if !PointInPoly(q, poly) || distToPolyEdge(q, poly) < setback-0.01 {
				return false
			}
		}
	}
	return true
}

// FitBuilding finds a bearing and position for the building inside the site,
// at least setback from every boundary. frontBearings are preferred bearings
// (e.g. facing the street); if none fit, every site-edge direction is tried.
func FitBuilding(local []Pt, setback float64, nd Needs, preferred []float64) (SitePlan, error) {
	type cand struct {
		b      float64
		x0, y0 float64 // rotated-frame position of building (0,0)
		count  int
		pref   bool
	}
	var tries []float64
	tries = append(tries, preferred...)
	for i := range local {
		a, c := local[i], local[(i+1)%len(local)]
		if math.Hypot(c[0]-a[0], c[1]-a[1]) < 2 {
			continue
		}
		th := normBearing(math.Atan2(c[0]-a[0], c[1]-a[1]) * 180 / math.Pi)
		tries = append(tries, th, normBearing(th+180))
	}
	cent := PolyCentroid(local)
	var best *cand
	totalW, totalD := nd.Left+nd.W+nd.Right, nd.Front+nd.D+nd.Back
	cell := math.Max(0.5, math.Sqrt(PolyArea(local))/250)
	for k, b := range tries {
		g := newSiteGrid(local, b, setback, cell)
		ci, cj := int(math.Ceil(totalW/cell)), int(math.Ceil(totalD/cell))
		if ci > g.nx || cj > g.ny {
			continue
		}
		var fits [][2]int
		for j := 0; j+cj <= g.ny; j++ {
			for i := 0; i+ci <= g.nx; i++ {
				if g.allOK(i, j, ci, cj) {
					fits = append(fits, [2]int{i, j})
				}
			}
		}
		if len(fits) == 0 {
			continue
		}
		// For edge-derived bearings, only keep the one whose front faces outward
		// from the centre toward that edge (handled by trying both and preferring
		// positions near the front); pick the front-most row, then the middle.
		sort.Slice(fits, func(a, c int) bool {
			if fits[a][1] != fits[c][1] {
				return fits[a][1] < fits[c][1]
			}
			return fits[a][0] < fits[c][0]
		})
		row := fits[0][1]
		var rowFits [][2]int
		for _, f := range fits {
			if f[1] == row {
				rowFits = append(rowFits, f)
			}
		}
		_ = cent
		var chosen *cand
		mid := rowFits[len(rowFits)/2]
		for _, f := range append([][2]int{mid}, rowFits...) {
			x := g.minX + float64(f[0])*g.cell
			y := g.minY + float64(f[1])*g.cell
			if rectClear(g.poly, x, y, x+totalW, y+totalD, setback) {
				chosen = &cand{b, x + nd.Left, y + nd.Front, len(fits), k < len(preferred)}
				break
			}
		}
		if chosen == nil {
			continue
		}
		if best == nil || (chosen.pref && !best.pref) ||
			(chosen.pref == best.pref && !chosen.pref && chosen.count > best.count) {
			best = chosen
		}
		if chosen.pref {
			break // first preferred bearing that fits wins
		}
	}
	if best == nil {
		return SitePlan{}, fmt.Errorf("a %.1f × %.1f m building doesn't fit inside the site with a %.1f m setback",
			totalW, totalD, setback)
	}
	u, v := axes(best.b)
	o := Pt{best.x0*u[0] + best.y0*v[0], best.x0*u[1] + best.y0*v[1]}
	sp := SitePlan{Bearing: best.b, OriginLocal: o, Candidates: best.count}
	if nd.ParkingSpaces > 0 {
		sp.Parking, sp.ParkingMsg = fitParking(local, setback, best.b, best.x0, best.y0, nd)
	}
	return sp, nil
}

// fitParking puts a surface lot behind (or beside) the building.
func fitParking(local []Pt, setback, b, bx, by float64, nd Needs) ([]XParkingLocal, string) {
	g := newSiteGrid(local, b, setback, 0.5)
	want := nd.ParkingSpaces
	placed := 0
	var lots []XParkingLocal
	// candidate strips: behind the building, then in front
	for _, layout := range []struct {
		depth float64
		rows  int
	}{{18.5, 2}, {12.5, 1}} {
		if placed >= want {
			break
		}
		for _, zoneY := range []float64{by + nd.D + nd.Back + 1.5} {
			maxW := g.minX + float64(g.nx)*0.5 - (g.minX)
			_ = maxW
			// scan x positions for the widest clear strip at this y
			bestX, bestW := 0.0, 0.0
			for x := g.minX; x < g.minX+float64(g.nx)*0.5; x += 0.5 {
				w := 0.0
				for ww := 2.6; x+ww <= g.minX+float64(g.nx)*0.5; ww += 2.6 {
					if !rectClear(g.poly, x, zoneY, x+ww, zoneY+layout.depth, setback) {
						break
					}
					w = ww
				}
				if w > bestW {
					bestX, bestW = x, w
				}
			}
			if bestW < 2.6 {
				continue
			}
			spaces := int(bestW/2.6) * layout.rows
			if spaces > want-placed {
				spaces = want - placed
				bestW = math.Ceil(float64(spaces)/float64(layout.rows)) * 2.6
			}
			lots = append(lots, XParkingLocal{Rect{bestX - bx, zoneY - by, bestX - bx + bestW, zoneY - by + layout.depth}, spaces})
			placed += spaces
		}
		if len(lots) > 0 {
			break
		}
	}
	msg := ""
	if placed < want {
		msg = fmt.Sprintf("Only %d of the %d parking spaces fit on the site behind the building; check local parking minimums.", placed, want)
	}
	return lots, msg
}

// BuildingToLngLat converts a building-frame point to [lng, lat].
func BuildingToLngLat(f Frame, sp SitePlan, p Pt) Pt {
	u, v := axes(sp.Bearing)
	e := sp.OriginLocal[0] + p[0]*u[0] + p[1]*v[0]
	n := sp.OriginLocal[1] + p[0]*u[1] + p[1]*v[1]
	q := f.ToLngLat(Pt{e, n})
	return Pt{math.Round(q[0]*1e7) / 1e7, math.Round(q[1]*1e7) / 1e7}
}

// FootprintClear re-checks (exactly) that building-frame rectangles are inside the site setback.
func FootprintClear(local []Pt, setback float64, sp SitePlan, rects []Rect) bool {
	u, v := axes(sp.Bearing)
	var poly []Pt
	for _, p := range local {
		poly = append(poly, Pt{dot(p, u), dot(p, v)})
	}
	ox, oy := dot(sp.OriginLocal, u), dot(sp.OriginLocal, v)
	for _, r := range rects {
		if !rectClear(poly, ox+r.X0, oy+r.Y0, ox+r.X1, oy+r.Y1, setback) {
			return false
		}
	}
	return true
}

// FetchRoadBearings returns building bearings that put the front toward the
// nearest street (OpenStreetMap). Empty if no street is mapped nearby.
func FetchRoadBearings(f Frame, centre Pt, radiusM int) ([]float64, error) {
	ll := f.ToLngLat(centre)
	q := fmt.Sprintf(`[out:json][timeout:20];way["highway"~"^(residential|primary|secondary|tertiary|unclassified|living_street|service|trunk)$"](around:%d,%v,%v);out geom;`,
		radiusM, ll[1], ll[0])
	var res struct {
		Elements []struct {
			Geometry []struct{ Lat, Lon float64 } `json:"geometry"`
		}
	}
	if err := postJSON(OverpassURL, []byte(url.Values{"data": {q}}.Encode()), "application/x-www-form-urlencoded", &res); err != nil {
		return nil, err
	}
	bestD := math.Inf(1)
	var bestA, bestB Pt
	for _, el := range res.Elements {
		for i := 0; i+1 < len(el.Geometry); i++ {
			a := f.ToLocal(Pt{el.Geometry[i].Lon, el.Geometry[i].Lat})
			b := f.ToLocal(Pt{el.Geometry[i+1].Lon, el.Geometry[i+1].Lat})
			if d := distToSeg(centre, a, b); d < bestD {
				bestD, bestA, bestB = d, a, b
			}
		}
	}
	if math.IsInf(bestD, 1) {
		return nil, nil
	}
	return roadFacingBearings(centre, bestA, bestB), nil
}

// roadFacingBearings: x axis parallel to the road, front (−v) toward it.
func roadFacingBearings(centre, a, b Pt) []float64 {
	th := normBearing(math.Atan2(b[0]-a[0], b[1]-a[1]) * 180 / math.Pi)
	// nearest point on the road
	dx, dy := b[0]-a[0], b[1]-a[1]
	t := math.Max(0, math.Min(1, ((centre[0]-a[0])*dx+(centre[1]-a[1])*dy)/(dx*dx+dy*dy)))
	toRoad := Pt{a[0] + t*dx - centre[0], a[1] + t*dy - centre[1]}
	for _, cand := range []float64{th, normBearing(th + 180)} {
		_, v := axes(cand)
		if dot(Pt{-v[0], -v[1]}, toRoad) > 0 {
			return []float64{cand}
		}
	}
	return []float64{th}
}
