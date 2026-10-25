package main

// Curved walls inside a building. When the description asks for them ("curved interior walls",
// "a curving wall in the living room"), one straight wall between a main room (living, family,
// dining, lobby, lounge) and its neighbour becomes a gentle curve bowing into the larger room: the
// wall carries the curve (arc), both rooms' outlines follow it, the doors on it stay where they are
// along it, and furniture it would cut slides back from it. One wall per floor that has a main room.

import (
	"fmt"
	"math"
	"regexp"
)

var curvedInsideRe = regexp.MustCompile(`(?i)\bcurv\w*\s+(interior|inside|internal|inner|feature|partition)\s+walls?\b|\b(interior|inside|internal|inner)\s+walls?\s+(that\s+)?(are\s+|is\s+)?curv\w*|\bcurv\w*\s+walls?\s+(inside|indoors|within)\b|\bcurv\w*\s+wall\s+in\s+the\s+(living|family|dining|lobby|lounge|entry|hall)`)

// curvedInsideFromPrompt is true when the user asks for curved walls inside.
func curvedInsideFromPrompt(text string) bool { return curvedInsideRe.MatchString(text) }

// withoutCurvedInside removes those phrases, so "curved interior walls" doesn't read as a round
// building.
func withoutCurvedInside(text string) string { return curvedInsideRe.ReplaceAllString(text, " ") }

var showRooms = map[string]int{"living": 3, "lobby": 3, "family": 2, "lounge": 2, "dining": 1}

// curveInteriorWalls bends one wall per level, in place. It returns how many it bent; on an error
// the design may be half changed, so callers work on a copy.
func curveInteriorWalls(d *Design) (int, error) {
	n := 0
	for li := range d.Levels {
		lv := &d.Levels[li]
		if lv.Roof {
			continue
		}
		ok, err := curveOneWall(lv)
		if err != nil {
			return n, err
		}
		if ok {
			n++
		}
	}
	if n > 0 {
		recountAreas(d)
	}
	return n, nil
}

func curveOneWall(lv *DLevel) (bool, error) {
	type cand struct {
		wall     int
		big, sml int // room indexes: the curve bows into big
		eBig     int // the edge of each room on the wall
		eSml     int
		score    float64
	}
	// The straight edge of a room's outline that runs exactly along the wall, or -1.
	edgeOn := func(r DRoom, a, b Pt) int {
		n := len(r.Polygon.Pts)
		for i := 0; i < n; i++ {
			p, q := r.Polygon.Pts[i], r.Polygon.Pts[(i+1)%n]
			if r.Polygon.arc(i) == nil && ((samePt(p, a) && samePt(q, b)) || (samePt(p, b) && samePt(q, a))) {
				return i
			}
		}
		return -1
	}
	var best *cand
	for wi, w := range lv.Walls {
		if w.Kind != "interior" || w.Arc != nil {
			continue
		}
		a, b := Pt{w.X1, w.Y1}, Pt{w.X2, w.Y2}
		L := math.Hypot(b[0]-a[0], b[1]-a[1])
		if L < 2.6 {
			continue
		}
		var on []int
		var edges []int
		for ri, r := range lv.Rooms {
			if e := edgeOn(r, a, b); e >= 0 {
				on, edges = append(on, ri), append(edges, e)
			}
		}
		if len(on) != 2 {
			continue
		}
		r0, r1 := lv.Rooms[on[0]], lv.Rooms[on[1]]
		s0, s1 := showRooms[r0.Type], showRooms[r1.Type]
		if s0 == 0 && s1 == 0 {
			continue
		}
		skip := false
		for _, r := range []DRoom{r0, r1} {
			if r.Type == "stair" || r.Type == "elevator" || r.Type == "garage" {
				skip = true
			}
		}
		if skip {
			continue
		}
		c := cand{wall: wi, big: on[0], sml: on[1], eBig: edges[0], eSml: edges[1]}
		if r1.AreaM2 > r0.AreaM2 {
			c.big, c.sml, c.eBig, c.eSml = on[1], on[0], edges[1], edges[0]
		}
		c.score = L * float64(1+max(s0, s1))
		if best == nil || c.score > best.score {
			cc := c
			best = &cc
		}
	}
	if best == nil {
		return false, nil
	}
	w := &lv.Walls[best.wall]
	big := &lv.Rooms[best.big]
	a, b := Pt{w.X1, w.Y1}, Pt{w.X2, w.Y2}
	// Which way the big room lies from the wall, and how deep it is that way.
	bb := boundsOf(big.Polygon.Flat())
	mid := Pt{(a[0] + b[0]) / 2, (a[1] + b[1]) / 2}
	var dir Pt
	var depth float64
	vertical := math.Abs(a[0]-b[0]) < 1e-6
	if vertical {
		dir = Pt{1, 0}
		if bb.X1 <= mid[0]+1e-6 {
			dir = Pt{-1, 0}
		}
		depth = bb.W()
	} else {
		dir = Pt{0, 1}
		if bb.Y1 <= mid[1]+1e-6 {
			dir = Pt{0, -1}
		}
		depth = bb.D()
	}
	bulge := math.Min(0.6, 0.16*depth)
	if bulge < 0.3 {
		return false, nil
	}
	half := math.Hypot(b[0]-a[0], b[1]-a[1]) / 2
	t := 2 * bulge // the centre sits this far behind the wall
	rAcross := t + bulge
	rAlong := half / math.Sqrt(1-math.Pow(t/rAcross, 2))
	arc := Arc{CX: mid[0] - dir[0]*t, CY: mid[1] - dir[1]*t}
	if vertical {
		arc.RX, arc.RY = rAcross, rAlong
	} else {
		arc.RX, arc.RY = rAlong, rAcross
	}
	arc.CX, arc.CY, arc.RX, arc.RY = rd(arc.CX), rd(arc.CY), rd(arc.RX), rd(arc.RY)
	w.Arc = &arc
	for _, ri := range []struct{ room, edge int }{{best.big, best.eBig}, {best.sml, best.eSml}} {
		r := &lv.Rooms[ri.room]
		arcs := make([]*Arc, len(r.Polygon.Pts))
		copy(arcs, r.Polygon.Arcs)
		ac := arc
		arcs[ri.edge] = &ac
		r.Polygon.Arcs = arcs
	}
	return true, clearOfCurve(lv, big.ID, dir, bulge)
}

// clearOfCurve slides the big room's furniture that the curve now cuts back from it (along dir, the
// way the curve bows), and drops what can't be moved unless the room needs it.
func clearOfCurve(lv *DLevel, roomID string, dir Pt, bulge float64) error {
	var poly []Pt
	for _, r := range lv.Rooms {
		if r.ID == roomID {
			poly = r.Polygon.Flat()
		}
	}
	inside := func(f DFurnishing) bool {
		w, dd := f.W, f.D
		if f.RotationDeg == 90 || f.RotationDeg == 270 {
			w, dd = dd, w
		}
		for i := 0; i <= 4; i++ {
			for j := 0; j <= 4; j++ {
				if i != 0 && i != 4 && j != 0 && j != 4 {
					continue // the box's edges are enough
				}
				q := Pt{f.X - w/2 + w*float64(i)/4, f.Y - dd/2 + dd*float64(j)/4}
				if !PointInPoly(q, poly) && distToPolyEdge(q, poly) > 0.03 {
					return false
				}
			}
		}
		return true
	}
	essential := map[string]bool{"bed": true, "toilet": true, "vanity": true, "shower": true, "bathtub": true, "fridge": true}
	var keep []DFurnishing
	for _, f := range lv.Furnishings {
		if f.RoomID != roomID || inside(f) {
			keep = append(keep, f)
			continue
		}
		moved := false
		for step := 0.05; step <= bulge+0.25; step += 0.05 {
			g := f
			g.X, g.Y = rd(f.X+dir[0]*step), rd(f.Y+dir[1]*step)
			if inside(g) {
				keep, moved = append(keep, g), true
				break
			}
		}
		if !moved && (essential[f.Type] || (f.Type == "counter" && (f.Sink != nil || f.Cooktop != nil))) {
			return fmt.Errorf("the %s would be cut by the curved wall", f.Type)
		}
	}
	lv.Furnishings = keep
	return nil
}

func boundsOf(pts []Pt) Rect {
	r := Rect{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	for _, p := range pts {
		r.X0, r.Y0 = math.Min(r.X0, p[0]), math.Min(r.Y0, p[1])
		r.X1, r.Y1 = math.Max(r.X1, p[0]), math.Max(r.Y1, p[1])
	}
	return r
}
