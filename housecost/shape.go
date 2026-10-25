package main

// Footprint shapes other than a rectangle. The layout engine plans rooms as rectangles that tile a
// W × D rectangle; ApplyShape then reshapes the finished design:
//
//   - round: an ellipse through the rectangle's corners (a circle when W = D), so the building is
//     round with curved outer walls;
//   - land: the outline of the user's land, pulled in toward the building until it fits inside the
//     setback, so the building takes the land's shape.
//
// The space between the rectangle and the new outline is shared out along rays from the middle:
// every room on the rectangle's edge grows outward to the new outline, so it keeps its doors and
// gains its share of the curve. Its outside windows and doors move out with it. Stairs and
// elevators keep their rectangles (the space outside one becomes an alcove open to it).
// Interior rooms, stairs, furniture and doors inside don't change.

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

const (
	ShapeRect  = "rectangle"
	ShapeRound = "round"
	ShapeLand  = "land"
)

var shapeWords = []struct {
	re    *regexp.Regexp
	shape string
}{
	{regexp.MustCompile(`(?i)\b(circle|circular|round(ed)?|oval|elliptical|curved|cylinder|cylindrical|rotunda|dome|silo|yurt)\b`), ShapeRound},
	{regexp.MustCompile(`(?i)(shape|outline|form) of (the|my|our) (land|lot|site|plot|property)|follow(s|ing)? (the|my) (land|lot|site|plot|property|boundary|outline)|fill(s|ing)? (the|my) (land|lot|site|plot)|(land|lot|site)[- ]shaped`), ShapeLand},
}

// shapeFromPrompt reads a shape the user asked for in their own words; "" when they didn't.
func shapeFromPrompt(text string) string {
	for _, w := range shapeWords {
		if w.re.MatchString(text) {
			return w.shape
		}
	}
	return ""
}

// normalizeShape maps Gemma's wording onto a shape value.
func normalizeShape(s string) string {
	low := strings.ToLower(strings.TrimSpace(s))
	switch {
	case low == "":
		return ""
	case strings.Contains(low, "rect") || strings.Contains(low, "square") || strings.Contains(low, "box"):
		return ShapeRect
	case regexp.MustCompile(`round|circ|oval|ellip|curv|cylind|dome|rotunda`).MatchString(low):
		return ShapeRound
	case regexp.MustCompile(`land|lot|site|plot|follow|fill|boundary`).MatchString(low):
		return ShapeLand
	}
	return low
}

// shapedProgram is the program the layout engine plans for a shaped building: smaller, because the
// rooms on the edge grow when the shape is applied, and without the porch, deck and balconies, which
// would stick out through the curve.
func shapedProgram(p Program) Program {
	if p.Shape != ShapeRound && p.Shape != ShapeLand {
		return p
	}
	q := p
	grow := 2 / math.Pi // an ellipse through a rectangle's corners has π/2 times its area
	if p.Shape == ShapeLand {
		grow = 0.8
	}
	q.AreaM2 = p.AreaM2 * grow
	q.Extras = nil
	for _, x := range p.Extras {
		if x != "porch" && x != "deck" && x != "balconies" {
			q.Extras = append(q.Extras, x)
		}
	}
	return q
}

// roundMargins is how far the ellipse through a W × D rectangle's corners reaches past it.
func roundMargins(W, D float64) (float64, float64) {
	return W/math.Sqrt2 - W/2, D/math.Sqrt2 - D/2
}

// ---- targets: where the rays from the middle end ------------------------------------------------

type target interface {
	hit(c, p Pt) (Pt, bool)      // where the ray from c through p meets the outline
	path(a, b Pt) ([]Pt, []*Arc) // the outline from a to b counter-clockwise: points from a (b not included) and the curve of each piece
	same(a, b Pt) bool           // whether a and b are on one smooth piece (so walls between them may merge)
}

type ellipseTarget struct{ e Arc }

func (t ellipseTarget) hit(c, p Pt) (Pt, bool) {
	dx, dy := p[0]-c[0], p[1]-c[1]
	k := math.Sqrt((dx/t.e.RX)*(dx/t.e.RX) + (dy/t.e.RY)*(dy/t.e.RY))
	if k == 0 {
		return p, false
	}
	return Pt{c[0] + dx/k, c[1] + dy/k}, true
}

func (t ellipseTarget) path(a, b Pt) ([]Pt, []*Arc) {
	e := t.e
	_, d := e.sweep(a, b)
	if d <= 0 { // the long way round: split in the middle so each piece is the short way
		t0 := e.param(a)
		m := e.at(t0 + (d+2*math.Pi)/2)
		return []Pt{a, m}, []*Arc{&e, &e}
	}
	return []Pt{a}, []*Arc{&e}
}

func (t ellipseTarget) same(a, b Pt) bool { return true }

type polyTarget struct{ poly []Pt } // counter-clockwise

func (t polyTarget) edgeOf(p Pt) int {
	best, bd := 0, math.Inf(1)
	for i := range t.poly {
		if d := distToSeg(p, t.poly[i], t.poly[(i+1)%len(t.poly)]); d < bd {
			best, bd = i, d
		}
	}
	return best
}

func (t polyTarget) hit(c, p Pt) (Pt, bool) {
	dx, dy := p[0]-c[0], p[1]-c[1]
	best := math.Inf(1)
	n := len(t.poly)
	for i := 0; i < n; i++ {
		a, b := t.poly[i], t.poly[(i+1)%n]
		ex, ey := b[0]-a[0], b[1]-a[1]
		den := dx*ey - dy*ex
		if math.Abs(den) < 1e-12 {
			continue
		}
		s := ((a[0]-c[0])*ey - (a[1]-c[1])*ex) / den // along the ray
		u := ((a[0]-c[0])*dy - (a[1]-c[1])*dx) / den // along the edge
		if s > 1e-9 && u >= -1e-9 && u <= 1+1e-9 && s < best {
			best = s
		}
	}
	if math.IsInf(best, 1) {
		return p, false
	}
	return Pt{c[0] + dx*best, c[1] + dy*best}, true
}

func (t polyTarget) path(a, b Pt) ([]Pt, []*Arc) {
	i, j := t.edgeOf(a), t.edgeOf(b)
	out := []Pt{a}
	n := len(t.poly)
	for k := i; k != j; k = (k + 1) % n {
		v := t.poly[(k+1)%n]
		if !samePt(v, a) && !samePt(v, b) {
			out = append(out, v)
		}
	}
	return out, make([]*Arc, len(out))
}

func (t polyTarget) same(a, b Pt) bool { return t.edgeOf(a) == t.edgeOf(b) }

func samePt(a, b Pt) bool { return math.Abs(a[0]-b[0]) < 1e-3 && math.Abs(a[1]-b[1]) < 1e-3 }

// ---- the land target --------------------------------------------------------------------------

// landTarget is the land's outline in building metres, scaled toward the building's middle c so it
// contains the W × D rectangle and stays at least setback inside the land, and close to `want` m².
func landTarget(land []Pt, c Pt, W, D, setback, want float64) (polyTarget, error) {
	if PolyArea(land) < 1 {
		return polyTarget{}, fmt.Errorf("the land has no area")
	}
	if signedArea(land) < 0 {
		rev := make([]Pt, len(land))
		for i, p := range land {
			rev[len(land)-1-i] = p
		}
		land = rev
	}
	// Every ray from the middle must meet the land's edge once (a star shape), or the rooms can't
	// grow out to it cleanly.
	for _, v := range land {
		for i := range land {
			a, b := land[i], land[(i+1)%len(land)]
			if samePt(a, v) || samePt(b, v) {
				continue
			}
			if segCross(c, v, a, b) {
				return polyTarget{}, fmt.Errorf("the land's outline bends back on itself as seen from the building's middle")
			}
		}
	}
	scaled := func(s float64) []Pt {
		out := make([]Pt, len(land))
		for i, p := range land {
			out[i] = Pt{c[0] + (p[0]-c[0])*s, c[1] + (p[1]-c[1])*s}
		}
		return out
	}
	// Smallest scale that holds the rectangle (with a little room), largest that keeps the setback.
	sMin := 0.0
	full := polyTarget{land}
	for _, q := range []Pt{{0, 0}, {W, 0}, {W, D}, {0, D}} {
		h, ok := full.hit(c, q)
		if !ok {
			return polyTarget{}, fmt.Errorf("the building's corner isn't inside the land")
		}
		sMin = math.Max(sMin, (math.Hypot(q[0]-c[0], q[1]-c[1])+0.1)/math.Hypot(h[0]-c[0], h[1]-c[1]))
	}
	inside := func(s float64) bool {
		poly := scaled(s)
		for i := range poly {
			a, b := poly[i], poly[(i+1)%len(poly)]
			for k := 0; k <= 8; k++ {
				p := Pt{a[0] + (b[0]-a[0])*float64(k)/8, a[1] + (b[1]-a[1])*float64(k)/8}
				if distToPolyEdge(p, land) < setback-0.05 {
					return false
				}
			}
		}
		return true
	}
	lo, hi := 0.0, 1.0
	for i := 0; i < 30; i++ {
		m := (lo + hi) / 2
		if inside(m) {
			lo = m
		} else {
			hi = m
		}
	}
	sMax := lo
	if sMin > sMax {
		return polyTarget{}, fmt.Errorf("the land's shape is too narrow around the building to follow")
	}
	s := math.Sqrt(want / PolyArea(land)) // area grows with the square of the scale
	s = math.Max(sMin, math.Min(sMax, s))
	return polyTarget{scaled(s)}, nil
}

func signedArea(p []Pt) float64 {
	a := 0.0
	for i := range p {
		j := (i + 1) % len(p)
		a += p[i][0]*p[j][1] - p[j][0]*p[i][1]
	}
	return a / 2
}

// segCross: do segments pq and ab cross at a point inside both?
func segCross(p, q, a, b Pt) bool {
	d := func(o, s, t Pt) float64 { return (s[0]-o[0])*(t[1]-o[1]) - (s[1]-o[1])*(t[0]-o[0]) }
	d1, d2, d3, d4 := d(a, b, p), d(a, b, q), d(p, q, a), d(p, q, b)
	return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
}

// ---- applying the shape ---------------------------------------------------------------------------

// ApplyShape reshapes a finished rectangular design (its rooms tiling [0, W] × [0, D] on every level)
// to the program's shape. land is the land in building metres (only used for ShapeLand). It
// returns the shift added to every coordinate, so the building's (0, 0) corner can be moved too.
func ApplyShape(d *Design, shape string, land []Pt, setback float64) (Pt, error) {
	W, D := d.Size.WidthM, d.Size.DepthM
	c := Pt{W / 2, D / 2}
	var tg target
	switch shape {
	case ShapeRound:
		tg = ellipseTarget{Arc{CX: c[0], CY: c[1], RX: W / math.Sqrt2, RY: D / math.Sqrt2}}
	case ShapeLand:
		pt, err := landTarget(land, c, W, D, setback, W*D*1.3)
		if err != nil {
			return Pt{}, err
		}
		tg = pt
	default:
		return Pt{}, fmt.Errorf("unknown shape %q", shape)
	}
	for li := range d.Levels {
		if err := shapeLevel(&d.Levels[li], W, D, c, tg); err != nil {
			return Pt{}, fmt.Errorf("level %d: %w", li, err)
		}
	}
	// Move everything so the shape's box starts at (0, 0).
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, lv := range d.Levels {
		for _, p := range lv.Outline.Flat() {
			minX, minY = math.Min(minX, p[0]), math.Min(minY, p[1])
			maxX, maxY = math.Max(maxX, p[0]), math.Max(maxY, p[1])
		}
	}
	shift := Pt{-minX, -minY}
	translateDesign(d, shift)
	d.Size.WidthM, d.Size.DepthM = rd(maxX-minX), rd(maxY-minY)
	recountAreas(d)
	return shift, nil
}

type bpt struct {
	p, q  Pt      // on the rectangle; where its ray meets the new outline
	angle float64 // around the middle
}

func shapeLevel(lv *DLevel, W, D float64, c Pt, tg target) error {
	onEdge := func(p Pt) bool { return near(p[0], 0) || near(p[0], W) || near(p[1], 0) || near(p[1], D) }
	sameSide := func(a, b Pt) bool {
		return (near(a[0], 0) && near(b[0], 0)) || (near(a[0], W) && near(b[0], W)) ||
			(near(a[1], 0) && near(b[1], 0)) || (near(a[1], D) && near(b[1], D))
	}
	// Points on the rectangle's edge where something meets it, in order round the middle.
	var bs []bpt
	addB := func(p Pt) {
		for _, b := range bs {
			if samePt(b.p, p) {
				return
			}
		}
		q, ok := tg.hit(c, p)
		if !ok {
			q = p
		}
		bs = append(bs, bpt{p: p, q: q, angle: math.Atan2(p[1]-c[1], p[0]-c[0])})
	}
	for _, corner := range []Pt{{0, 0}, {W, 0}, {W, D}, {0, D}} {
		addB(corner)
	}
	for _, r := range lv.Rooms {
		for _, p := range r.Polygon.Pts {
			if onEdge(p) {
				addB(p)
			}
		}
	}
	for _, w := range lv.Walls {
		for _, p := range []Pt{{w.X1, w.Y1}, {w.X2, w.Y2}} {
			if onEdge(p) {
				addB(p)
			}
		}
	}
	sort.Slice(bs, func(i, j int) bool { return bs[i].angle < bs[j].angle })
	n := len(bs)
	idx := func(p Pt) int {
		for i, b := range bs {
			if samePt(b.p, p) {
				return i
			}
		}
		return -1
	}
	// The new outline between boundary points k and k+1.
	piece := func(k int) ([]Pt, []*Arc) { return tg.path(bs[k].q, bs[(k+1)%n].q) }

	// Which room owns each edge piece (k → k+1) of the rectangle.
	owner := make([]int, n)
	for k := range bs {
		a, b := bs[k].p, bs[(k+1)%n].p
		m := Pt{(a[0] + b[0]) / 2, (a[1] + b[1]) / 2}
		owner[k] = -1
		for ri, r := range lv.Rooms {
			pts := r.Polygon.Pts
			for i := range pts {
				if sameSide(pts[i], pts[(i+1)%len(pts)]) && sameSide(pts[i], m) && distToSeg(m, pts[i], pts[(i+1)%len(pts)]) < 1e-3 {
					owner[k] = ri
				}
			}
		}
		if owner[k] < 0 {
			return fmt.Errorf("no room along the outside at %.2f, %.2f", m[0], m[1])
		}
	}

	// ring builder: points with the curve of the edge after each, merging repeats.
	type ringB struct {
		pts  []Pt
		arcs []*Arc
	}
	add := func(r *ringB, p Pt, a *Arc) {
		if len(r.pts) > 0 && samePt(r.pts[len(r.pts)-1], p) {
			r.arcs[len(r.arcs)-1] = a
			return
		}
		r.pts, r.arcs = append(r.pts, p), append(r.arcs, a)
	}
	finish := func(r *ringB) Ring {
		for len(r.pts) > 1 && samePt(r.pts[0], r.pts[len(r.pts)-1]) {
			r.pts, r.arcs = r.pts[:len(r.pts)-1], r.arcs[:len(r.arcs)-1]
		}
		out := Ring{Pts: make([]Pt, len(r.pts)), Arcs: r.arcs}
		for i, p := range r.pts {
			out.Pts[i] = Pt{rd(p[0]), rd(p[1])}
		}
		if !out.Curved() {
			out.Arcs = nil
		}
		return out
	}
	// The new outline from boundary point i to j, counter-clockwise (both included).
	along := func(r *ringB, i, j int) {
		for k := i; k != j; k = (k + 1) % n {
			pts, arcs := piece(k)
			for x := range pts {
				add(r, pts[x], arcs[x])
			}
		}
		add(r, bs[j].q, nil)
	}

	// The level's outline: all the way round.
	{
		var r ringB
		for k := 0; k < n; k++ {
			pts, arcs := piece(k)
			for x := range pts {
				add(&r, pts[x], arcs[x])
			}
		}
		lv.Outline = finish(&r)
	}

	// Rooms: each edge on the rectangle is replaced by the ray out, the new outline, and the ray back.
	var alcoves []DRoom
	for ri := range lv.Rooms {
		rm := &lv.Rooms[ri]
		pts := rm.Polygon.Pts
		m := len(pts)
		edge := make([]bool, m)
		any := false
		for i := range pts {
			edge[i] = sameSide(pts[i], pts[(i+1)%m])
			any = any || edge[i]
		}
		if !any {
			continue
		}
		fixed := rm.Type == "stair" || rm.Type == "elevator"
		start := -1
		for i := range pts {
			if !edge[i] {
				start = i
				break
			}
		}
		if start < 0 { // a room that is the whole level
			rm.Polygon = lv.Outline
			continue
		}
		var r ringB
		for k := 0; k < m; k++ {
			i := (start + k) % m
			if !edge[i] {
				add(&r, pts[i], nil)
				continue
			}
			if edge[(i-1+m)%m] {
				continue // inside a run already handled
			}
			j := i
			for edge[j%m] {
				j++
			}
			a, b := idx(pts[i]), idx(pts[j%m])
			if a < 0 || b < 0 {
				return fmt.Errorf("room %s's corner isn't on the edge list", rm.ID)
			}
			if fixed {
				// The stair keeps its rectangle; the space outside it is an alcove open to it.
				add(&r, pts[i], nil)
				var al ringB
				add(&al, pts[i], nil)
				along(&al, a, b)
				add(&al, pts[j%m], nil)
				alcoves = append(alcoves, DRoom{ID: rm.ID + "a", Name: "Alcove", Type: "hall", UnitID: rm.UnitID,
					Polygon: finish(&al), FloorFinish: rm.FloorFinish})
				continue
			}
			add(&r, pts[i], nil)
			along(&r, a, b)
		}
		rm.Polygon = finish(&r)
	}
	lv.Rooms = append(lv.Rooms, alcoves...)

	// Walls: the old outer walls go; new outer walls follow the new outline, one per room (curved
	// pieces of one room merge), and walls between rooms reach out to it.
	var kept []DWall
	old := map[string]DWall{}
	for _, w := range lv.Walls {
		if w.Kind == "exterior" && sameSide(Pt{w.X1, w.Y1}, Pt{w.X2, w.Y2}) {
			old[w.ID] = w
			continue
		}
		kept = append(kept, w)
	}
	type extWall struct {
		DWall
		room int
		ks   []int
	}
	var ext []extWall
	nextID := 0
	for _, w := range lv.Walls {
		var k int
		fmt.Sscanf(w.ID[strings.LastIndex(w.ID, "W")+1:], "%d", &k)
		nextID = max(nextID, k)
	}
	prefix := fmt.Sprintf("L%d-W", lv.Index)
	newID := func() string { nextID++; return fmt.Sprintf("%s%d", prefix, nextID) }
	for k := 0; k < n; k++ {
		pts, arcs := piece(k)
		pts = append(pts, bs[(k+1)%n].q)
		for x := 0; x+1 < len(pts); x++ {
			a, b := pts[x], pts[x+1]
			if samePt(a, b) {
				continue
			}
			w := DWall{Kind: "exterior", X1: rd(a[0]), Y1: rd(a[1]), X2: rd(b[0]), Y2: rd(b[1]), Arc: arcs[x], ThicknessM: 0.3}
			// Merge into the previous piece when it's the same room on the same smooth curve.
			if len(ext) > 0 {
				prev := &ext[len(ext)-1]
				if prev.room == owner[k] && arcs[x] != nil && prev.Arc != nil && tg.same(Pt{prev.X1, prev.Y1}, b) && samePt(Pt{prev.X2, prev.Y2}, a) {
					if _, sw := prev.Arc.sweep(Pt{prev.X1, prev.Y1}, b); sw > 0 && sw < math.Pi*0.9 {
						prev.X2, prev.Y2 = rd(b[0]), rd(b[1])
						prev.ks = append(prev.ks, k)
						continue
					}
				}
			}
			ext = append(ext, extWall{DWall: w, room: owner[k], ks: []int{k}})
		}
	}
	for i := range ext {
		ext[i].ID = newID()
	}
	// Walls between rooms that met the old outer wall now run out to the new one.
	for k, b := range bs {
		if owner[k] == owner[(k-1+n)%n] || samePt(b.p, b.q) {
			continue
		}
		var from *DWall
		for i := range kept {
			w := &kept[i]
			if samePt(Pt{w.X1, w.Y1}, b.p) || samePt(Pt{w.X2, w.Y2}, b.p) {
				from = w
				break
			}
		}
		if from == nil {
			continue // open plan: no wall between them
		}
		kept = append(kept, DWall{ID: newID(), Kind: from.Kind, X1: rd(b.p[0]), Y1: rd(b.p[1]), X2: rd(b.q[0]), Y2: rd(b.q[1]), ThicknessM: from.ThicknessM})
	}

	// Openings in the old outer walls move out to the new ones, straight out from the middle.
	roomID := func(ri int) string { return lv.Rooms[ri].ID }
	var ops []DOpening
	used := map[string][][2]float64{}
	fits := func(wid string, lo, hi float64) bool {
		for _, u := range used[wid] {
			if lo < u[1]+0.15 && hi > u[0]-0.15 {
				return false
			}
		}
		return true
	}
	for _, o := range lv.Openings {
		w, moved := old[o.WallID]
		if !moved {
			ops = append(ops, o)
			continue
		}
		p := w.pointAlong(o.OffsetM + o.WidthM/2)
		q, ok := tg.hit(c, p)
		if !ok {
			q = p
		}
		// The room this opening served on the rectangle.
		inner := ""
		for _, cn := range o.Connects {
			if cn != "outside" {
				inner = cn
			}
		}
		best, bd := -1, math.Inf(1)
		for i, e := range ext {
			if roomID(e.room) != inner {
				continue
			}
			dd := math.Inf(1)
			path := e.wallPath()
			for x := 0; x+1 < len(path); x++ {
				dd = math.Min(dd, distToSeg(q, path[x], path[x+1]))
			}
			if dd < bd {
				best, bd = i, dd
			}
		}
		place := func(i int, s float64) bool {
			L := ext[i].Length()
			if L < o.WidthM+0.3 {
				return false
			}
			off := math.Max(0.15, math.Min(L-o.WidthM-0.15, s-o.WidthM/2))
			if !fits(ext[i].ID, off, off+o.WidthM) {
				return false
			}
			o.WallID, o.OffsetM = ext[i].ID, rd(off)
			used[ext[i].ID] = append(used[ext[i].ID], [2]float64{off, off + o.WidthM})
			return true
		}
		done := best >= 0 && place(best, ext[best].distanceAlong(q))
		if !done && o.Kind != "window" {
			// Doors must stay: put it in the middle of this room's longest outer wall.
			order := []int{}
			for i, e := range ext {
				if roomID(e.room) == inner {
					order = append(order, i)
				}
			}
			sort.Slice(order, func(a, b int) bool { return ext[order[a]].Length() > ext[order[b]].Length() })
			for _, i := range order {
				if place(i, ext[i].Length()/2) {
					done = true
					break
				}
			}
			if !done {
				return fmt.Errorf("no room on the new outer wall for %s %s", o.Kind, o.ID)
			}
		}
		if done {
			ops = append(ops, o)
		}
	}
	// A stair's windows face its alcove now; give them to the alcove.
	alcoveOf := map[string]string{}
	for _, a := range alcoves {
		alcoveOf[strings.TrimSuffix(a.ID, "a")] = a.ID
	}
	for i := range ext {
		if a, ok := alcoveOf[roomID(ext[i].room)]; ok {
			for x := range ops {
				if ops[x].WallID == ext[i].ID {
					for y, cn := range ops[x].Connects {
						if cn == roomID(ext[i].room) {
							ops[x].Connects[y] = a
						}
					}
				}
			}
		}
	}
	lv.Openings = ops
	for _, e := range ext {
		kept = append(kept, e.DWall)
	}
	lv.Walls = kept
	return nil
}

// translateDesign adds shift to every building-metre coordinate.
func translateDesign(d *Design, s Pt) {
	mv := func(p Pt) Pt { return Pt{rd(p[0] + s[0]), rd(p[1] + s[1])} }
	mvList := func(ps []Pt) {
		for i := range ps {
			ps[i] = mv(ps[i])
		}
	}
	// Arcs are shared between pieces of the outline, rooms and walls; move each one once.
	movedArc := map[*Arc]bool{}
	mvArc := func(a *Arc) {
		if a != nil && !movedArc[a] {
			movedArc[a] = true
			a.CX, a.CY = rd(a.CX+s[0]), rd(a.CY+s[1])
		}
	}
	for li := range d.Levels {
		lv := &d.Levels[li]
		for i := range lv.Outline.Pts {
			lv.Outline.Pts[i] = mv(lv.Outline.Pts[i])
		}
		for _, a := range lv.Outline.Arcs {
			mvArc(a)
		}
		for ri := range lv.Rooms {
			r := &lv.Rooms[ri].Polygon
			for i := range r.Pts {
				r.Pts[i] = mv(r.Pts[i])
			}
			for _, a := range r.Arcs {
				mvArc(a)
			}
		}
		for wi := range lv.Walls {
			w := &lv.Walls[wi]
			w.X1, w.Y1, w.X2, w.Y2 = rd(w.X1+s[0]), rd(w.Y1+s[1]), rd(w.X2+s[0]), rd(w.Y2+s[1])
			mvArc(w.Arc)
		}
		for bi := range lv.Balconies {
			mvList(lv.Balconies[bi].Polygon)
		}
		for fi := range lv.Furnishings {
			f := &lv.Furnishings[fi]
			f.X, f.Y = rd(f.X+s[0]), rd(f.Y+s[1])
		}
	}
	for i := range d.Stairs {
		d.Stairs[i].X, d.Stairs[i].Y = rd(d.Stairs[i].X+s[0]), rd(d.Stairs[i].Y+s[1])
	}
	for i := range d.Elevators {
		d.Elevators[i].X, d.Elevators[i].Y = rd(d.Elevators[i].X+s[0]), rd(d.Elevators[i].Y+s[1])
	}
	if g := d.Exterior.Garage; g != nil {
		mvList(g.Polygon)
	}
	if p := d.Exterior.Porch; p != nil {
		mvList(p.Polygon)
	}
	for i := range d.Exterior.Parking {
		mvList(d.Exterior.Parking[i].Polygon)
	}
}

// recountAreas sets room, home and building areas from the new polygons.
func recountAreas(d *Design) {
	unitArea := map[string]float64{}
	gross, dormFinished := 0.0, 0.0
	for li := range d.Levels {
		lv := &d.Levels[li]
		gross += lv.Outline.Area()
		for ri := range lv.Rooms {
			r := &lv.Rooms[ri]
			r.AreaM2 = r2(r.Polygon.Area())
			if r.UnitID != nil && r.Type != "garage" {
				unitArea[*r.UnitID] += r.AreaM2
			}
			if r.Type == "dorm-room" || r.Type == "suite-common" || (r.Type == "bath" && d.HousingType == "dorm") {
				dormFinished += r.AreaM2
			}
			if r.Type == "garage" && d.Exterior.Garage != nil {
				d.Exterior.Garage.Polygon = r.Polygon.Flat()
			}
		}
	}
	total := 0.0
	for i := range d.Units {
		d.Units[i].AreaM2 = r1(unitArea[d.Units[i].ID])
		total += unitArea[d.Units[i].ID]
	}
	if d.HousingType == "dorm" {
		total = dormFinished
	}
	d.Totals.FinishedAreaM2 = r1(total)
	d.Totals.GrossAreaM2 = r1(gross)
}

// cloneDesign is a deep copy, so a shape that doesn't work out can be dropped.
func cloneDesign(d *Design) *Design {
	b, _ := json.Marshal(d)
	var c Design
	_ = json.Unmarshal(b, &c)
	return &c
}

// CheckShaped checks what reshaping can break: rooms still fill each level, openings fit their
// walls, every room keeps a way in, and the building stays inside the land.
func CheckShaped(d *Design, sitePolyLngLat []Pt, setback float64) []string {
	var e []string
	add := func(f string, v ...any) { e = append(e, fmt.Sprintf(f, v...)) }
	for _, lv := range d.Levels {
		total := 0.0
		for _, r := range lv.Rooms {
			total += r.Polygon.Area()
		}
		if out := lv.Outline.Area(); math.Abs(total-out) > math.Max(0.5, out*0.005) {
			add("level %d: rooms cover %.2f m² of a %.2f m² outline", lv.Index, total, out)
		}
		walls := map[string]DWall{}
		for _, w := range lv.Walls {
			walls[w.ID] = w
		}
		for _, o := range lv.Openings {
			w, ok := walls[o.WallID]
			if !ok {
				add("opening %s is on missing wall %s", o.ID, o.WallID)
				continue
			}
			if o.OffsetM < -eps || o.OffsetM+o.WidthM > w.Length()+0.02 {
				add("opening %s doesn't fit wall %s", o.ID, w.ID)
			}
		}
	}
	ids := map[string]bool{}
	for _, lv := range d.Levels {
		for _, o := range lv.Openings {
			ids[o.ID] = true
		}
	}
	for _, u := range d.Units {
		if !ids[u.EntryOpeningID] {
			add("unit %s lost its entry %s", u.ID, u.EntryOpeningID)
		}
	}
	if len(sitePolyLngLat) >= 3 {
		f := NewFrame(sitePolyLngLat[0][1], sitePolyLngLat[0][0])
		var site []Pt
		for _, p := range sitePolyLngLat {
			site = append(site, f.ToLocal(p))
		}
		for _, p := range d.Placement.Footprint {
			q := f.ToLocal(p)
			if !PointInPoly(q, site) || distToPolyEdge(q, site) < setback-0.15 {
				add("the shaped building reaches into the %.1f m setback", setback)
				break
			}
		}
	}
	return e
}

// shapeDesign applies the program's shape to a finished design in place, or leaves it as it is and
// says why. sp, f and local place the building on the land; ring is the land as [lng, lat].
func shapeDesign(d *Design, p Program, sp SitePlan, f Frame, local []Pt, setback float64, ring []Pt) error {
	c := cloneDesign(d)
	u, v := axes(sp.Bearing)
	if p.Shape == ShapeLand && len(sp.Parking) == 0 {
		// The placement puts a building near the front of its land; to take the land's shape it
		// stands in the middle instead, when it fits there.
		mid := PolyCentroid(local)
		W, D := c.Size.WidthM, c.Size.DepthM
		o := Pt{mid[0] - (W/2)*u[0] - (D/2)*v[0], mid[1] - (W/2)*u[1] - (D/2)*v[1]}
		ok := true
		for _, q := range []Pt{{0, 0}, {W, 0}, {W, D}, {0, D}, {W / 2, 0}, {W, D / 2}, {W / 2, D}, {0, D / 2}} {
			e := Pt{o[0] + q[0]*u[0] + q[1]*v[0], o[1] + q[0]*u[1] + q[1]*v[1]}
			if !PointInPoly(e, local) || distToPolyEdge(e, local) < setback+0.5 {
				ok = false
			}
		}
		if ok {
			sp.OriginLocal = o
		}
	}
	// The land in building metres.
	land := make([]Pt, len(local))
	for i, e := range local {
		q := Pt{e[0] - sp.OriginLocal[0], e[1] - sp.OriginLocal[1]}
		land[i] = Pt{dot(q, u), dot(q, v)}
	}
	shift, err := ApplyShape(c, p.Shape, land, setback)
	if err != nil {
		return err
	}
	at := func(q Pt) Pt { return BuildingToLngLat(f, sp, Pt{q[0] - shift[0], q[1] - shift[1]}) }
	c.Placement.Origin = at(Pt{0, 0})
	// The footprint is the ground floor's outline, thinned to at most 96 points.
	var ground []Pt
	for _, lv := range c.Levels {
		if lv.ElevationM >= -0.01 {
			ground = lv.Outline.Flat()
			break
		}
	}
	step := max(1, (len(ground)+95)/96)
	c.Placement.Footprint = nil
	for i := 0; i < len(ground); i += step {
		c.Placement.Footprint = append(c.Placement.Footprint, at(ground[i]))
	}
	// A pitched roof over a curved or angled plan becomes a cone rising to one point.
	if c.Exterior.Roof.Type != "flat" {
		above := 0.0
		for _, lv := range c.Levels {
			if lv.ElevationM >= -0.01 {
				above += lv.HeightM
			}
		}
		top := c.Levels[len(c.Levels)-1].Outline.Flat()
		ctr := PolyCentroid(top)
		reach := 0.0
		for _, q := range top {
			reach += math.Hypot(q[0]-ctr[0], q[1]-ctr[1])
		}
		reach /= float64(len(top))
		pitch := p.RoofPitch
		if pitch <= 0 {
			pitch = 0.5
		}
		c.Exterior.Roof = Roof{Type: "cone", Pitch: pitch, EaveM: c.Exterior.Roof.EaveM,
			RidgeHeightM: r2(above + pitch*(reach+c.Exterior.Roof.EaveM))}
		c.Size.HeightM = c.Exterior.Roof.RidgeHeightM
	}
	if probs := CheckShaped(c, ring, setback); len(probs) > 0 {
		return fmt.Errorf("%s", probs[0])
	}
	word := map[string]string{ShapeRound: "Round plan: the outer rooms follow its curved walls.",
		ShapeLand: "The plan takes the shape of the land."}[p.Shape]
	c.Overview.Features = append([]string{word}, c.Overview.Features...)
	if before, after := d.Totals.FinishedAreaM2, c.Totals.FinishedAreaM2; after > before*1.1 {
		c.Overview.Cautions = append(c.Overview.Cautions, fmt.Sprintf(
			"The %s plan has %.0f m² of finished space, more than the %.0f m² a rectangular plan of the same rooms needs: the outer rooms grow out to the %s. The cost covers the larger building.",
			map[string]string{ShapeRound: "round", ShapeLand: "land-shaped"}[p.Shape], after, before,
			map[string]string{ShapeRound: "curve", ShapeLand: "land's outline"}[p.Shape]))
	}
	*d = *c
	return nil
}
