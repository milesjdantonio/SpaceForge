package main

// The renderer's rules (FIELDS.md "Rules the renderer checks") plus the
// furniture rules, checked on the finished design before it is written out.

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

func CheckDesign(d *Design, sitePolyLngLat []Pt, setback float64) []string {
	var e []string
	add := func(f string, v ...any) { e = append(e, fmt.Sprintf(f, v...)) }

	// 1. ids unique, references exist
	ids := map[string]string{}
	use := func(id, what string) {
		if id == "" {
			add("empty %s id", what)
			return
		}
		if prev, ok := ids[id]; ok {
			add("id %s used twice (%s and %s)", id, prev, what)
		}
		ids[id] = what
	}
	use(d.ID, "design")
	units := map[string]DUnit{}
	for _, u := range d.Units {
		use(u.ID, "unit")
		units[u.ID] = u
	}
	type roomRef struct {
		level int
		room  DRoom
	}
	rooms := map[string]roomRef{}
	walls := map[string]DWall{}
	openings := map[string]DOpening{}
	openingLevel := map[string]int{}
	for _, lv := range d.Levels {
		for _, r := range lv.Rooms {
			use(r.ID, "room")
			rooms[r.ID] = roomRef{lv.Index, r}
			if r.UnitID != nil {
				if _, ok := units[*r.UnitID]; !ok {
					add("room %s points to missing unit %s", r.ID, *r.UnitID)
				}
			}
		}
		for _, w := range lv.Walls {
			use(w.ID, "wall")
			walls[w.ID] = w
		}
		for _, o := range lv.Openings {
			use(o.ID, "opening")
			openings[o.ID] = o
			openingLevel[o.ID] = lv.Index
		}
		for _, b := range lv.Balconies {
			use(b.ID, "balcony")
		}
	}
	for _, s := range d.Stairs {
		use(s.ID, "stair")
	}
	for _, el := range d.Elevators {
		use(el.ID, "elevator")
	}
	for _, lv := range d.Levels {
		for _, o := range lv.Openings {
			if _, ok := walls[o.WallID]; !ok {
				add("opening %s is on missing wall %s", o.ID, o.WallID)
			}
			for _, c := range o.Connects {
				if c != "outside" {
					if rr, ok := rooms[c]; !ok || rr.level != lv.Index {
						add("opening %s connects missing room %s", o.ID, c)
					}
				}
			}
		}
		for _, f := range lv.Furnishings {
			if rr, ok := rooms[f.RoomID]; !ok || rr.level != lv.Index {
				add("furnishing %s points to missing room %s", f.Type, f.RoomID)
			}
		}
	}

	// 2. outlines inside size; rooms fill the outline without gaps or overlaps
	W, D := d.Size.WidthM, d.Size.DepthM
	for _, lv := range d.Levels {
		for _, p := range lv.Outline {
			if p[0] < -eps || p[1] < -eps || p[0] > W+eps || p[1] > D+eps {
				add("level %d outline point %v is outside size %.2f × %.2f", lv.Index, p, W, D)
			}
		}
		total := 0.0
		var rects []Rect
		for _, r := range lv.Rooms {
			rr, ok := polyRect(r.Polygon)
			if !ok {
				add("room %s is not a rectangle (checker only handles rectangles)", r.ID)
				continue
			}
			total += rr.Area()
			if math.Abs(rr.Area()-r.AreaM2) > 0.05 {
				add("room %s areaM2 %.2f doesn't match its polygon (%.2f)", r.ID, r.AreaM2, rr.Area())
			}
			rects = append(rects, rr)
		}
		if out := PolyArea(lv.Outline); math.Abs(total-out) > 0.05 {
			add("level %d: rooms cover %.2f m² of a %.2f m² outline (gap or overlap)", lv.Index, total, out)
		}
		for i := range rects {
			for j := i + 1; j < len(rects); j++ {
				if overlaps(rects[i], rects[j]) {
					add("level %d: rooms %s and %s overlap", lv.Index, lv.Rooms[i].ID, lv.Rooms[j].ID)
				}
			}
		}
	}

	// 3. openings fit their walls
	for id, o := range openings {
		w := walls[o.WallID]
		if o.OffsetM < -eps || o.OffsetM+o.WidthM > w.Length()+eps {
			add("opening %s (%.2f + %.2f) doesn't fit wall %s (%.2f m)", id, o.OffsetM, o.WidthM, w.ID, w.Length())
		}
	}

	// walls don't cross each other
	for _, lv := range d.Levels {
		for i, a := range lv.Walls {
			for _, b := range lv.Walls[i+1:] {
				if wallsCross(a, b) {
					add("walls %s and %s cross", a.ID, b.ID)
				}
			}
		}
	}

	// 4. every room reachable from a building entry
	adj := map[string][]string{}
	link := func(a, b string) { adj[a] = append(adj[a], b); adj[b] = append(adj[b], a) }
	var start []string
	for _, o := range openings {
		switch o.Kind {
		case "door", "passage", "cased", "entry", "patio":
			if o.Connects[0] != "outside" && o.Connects[1] != "outside" {
				link(o.Connects[0], o.Connects[1])
			} else if o.Kind == "entry" {
				for _, c := range o.Connects {
					if c != "outside" {
						start = append(start, c)
					}
				}
			}
		}
	}
	for _, lv := range d.Levels {
		for _, pr := range sharedOpenEdges(lv) {
			link(pr[0], pr[1])
		}
	}
	stairRoomAt := func(level int, x, y, w, dd float64) string {
		for id, rr := range rooms {
			if rr.level != level {
				continue
			}
			if r, ok := polyRect(rr.room.Polygon); ok && near(r.X0, x) && near(r.Y0, y) && near(r.W(), w) && near(r.D(), dd) {
				return id
			}
		}
		return ""
	}
	// 6. stairs and elevators line up
	for _, s := range d.Stairs {
		if s.ToLevel != s.FromLevel+1 {
			add("stair %s must go from level n to n+1", s.ID)
		}
		a, b := stairRoomAt(s.FromLevel, s.X, s.Y, s.WidthM, s.DepthM), stairRoomAt(s.ToLevel, s.X, s.Y, s.WidthM, s.DepthM)
		if a == "" || b == "" || rooms[a].room.Type != "stair" || rooms[b].room.Type != "stair" {
			add("stair %s needs a stair room of the same rectangle on levels %d and %d", s.ID, s.FromLevel, s.ToLevel)
			continue
		}
		link(a, b)
	}
	for _, el := range d.Elevators {
		var prev string
		for _, lvl := range el.Levels {
			id := stairRoomAt(lvl, el.X, el.Y, el.WidthM, el.DepthM)
			if id == "" || rooms[id].room.Type != "elevator" {
				add("elevator %s needs an elevator room on level %d", el.ID, lvl)
				continue
			}
			if prev != "" {
				link(prev, id)
			}
			prev = id
		}
	}
	seen := map[string]bool{}
	q := append([]string{}, start...)
	for _, s := range start {
		seen[s] = true
	}
	for len(q) > 0 {
		c := q[0]
		q = q[1:]
		for _, n := range adj[c] {
			if !seen[n] {
				seen[n] = true
				q = append(q, n)
			}
		}
	}
	var unreached []string
	for id := range rooms {
		if !seen[id] {
			unreached = append(unreached, id+" ("+rooms[id].room.Name+")")
		}
	}
	sort.Strings(unreached)
	if len(unreached) > 0 {
		add("rooms not reachable from a building entry: %s", strings.Join(unreached, ", "))
	}

	// 5. every home has exactly one entry
	for _, u := range d.Units {
		o, ok := openings[u.EntryOpeningID]
		if !ok || o.Kind != "entry" {
			add("unit %s entryOpeningId %q is not an entry opening", u.ID, u.EntryOpeningID)
			continue
		}
		inUnit := false
		for _, c := range o.Connects {
			if rr, ok := rooms[c]; ok && rr.room.UnitID != nil && *rr.room.UnitID == u.ID {
				inUnit = true
			}
		}
		if !inUnit {
			add("unit %s's entry %s doesn't open into the unit", u.ID, o.ID)
		}
	}

	// 7. totals match
	bed, bath, area := 0, 0.0, 0.0
	for _, u := range d.Units {
		bed += u.Bedrooms
		bath += u.Bathrooms
		area += u.AreaM2
	}
	if d.HousingType != "dorm" {
		if bed != d.Totals.Bedrooms || math.Abs(bath-d.Totals.Bathrooms) > 1e-9 || math.Abs(area-d.Totals.FinishedAreaM2) > 0.5 {
			add("totals don't match the units (bedrooms %d/%d, bathrooms %g/%g, area %.1f/%.1f)",
				d.Totals.Bedrooms, bed, d.Totals.Bathrooms, bath, d.Totals.FinishedAreaM2, area)
		}
		roomBeds := 0
		for _, rr := range rooms {
			if rr.room.Type == "bedroom" {
				roomBeds++
			}
		}
		if roomBeds != bed {
			add("units list %d bedrooms but there are %d bedroom rooms", bed, roomBeds)
		}
	}
	if d.Totals.UnitCount != len(d.Units) {
		add("totals.unitCount %d but %d units", d.Totals.UnitCount, len(d.Units))
	}

	// 8. footprint inside the site outline, with the setback
	if len(sitePolyLngLat) >= 3 && len(d.Placement.Footprint) == 4 {
		f := NewFrame(sitePolyLngLat[0][1], sitePolyLngLat[0][0])
		var site []Pt
		for _, p := range sitePolyLngLat {
			site = append(site, f.ToLocal(p))
		}
		for i, p := range d.Placement.Footprint {
			q := f.ToLocal(p)
			if !PointInPoly(q, site) || distToPolyEdge(q, site) < setback-0.1 {
				add("footprint corner %d is outside the site or inside the %.1f m setback", i, setback)
			}
		}
	}

	// furniture rules
	for _, lv := range d.Levels {
		byRoom := map[string][]DFurnishing{}
		for _, f := range lv.Furnishings {
			byRoom[f.RoomID] = append(byRoom[f.RoomID], f)
			rr, ok := polyRect(rooms[f.RoomID].room.Polygon)
			if !ok {
				continue
			}
			fw, fd := f.W, f.D
			if f.RotationDeg == 90 || f.RotationDeg == 270 {
				fw, fd = fd, fw
			}
			if f.X-fw/2 < rr.X0-eps || f.X+fw/2 > rr.X1+eps || f.Y-fd/2 < rr.Y0-eps || f.Y+fd/2 > rr.Y1+eps {
				add("%s in %s sticks out of the room", f.Type, f.RoomID)
			}
		}
		for _, r := range lv.Rooms {
			has := func(pred func(DFurnishing) bool) int {
				n := 0
				for _, f := range byRoom[r.ID] {
					if pred(f) {
						n++
					}
				}
				return n
			}
			typ := func(t string) func(DFurnishing) bool { return func(f DFurnishing) bool { return f.Type == t } }
			switch r.Type {
			case "kitchen":
				if has(func(f DFurnishing) bool { return f.Type == "counter" && f.Sink != nil }) == 0 ||
					has(func(f DFurnishing) bool { return f.Type == "counter" && f.Cooktop != nil }) == 0 || has(typ("fridge")) == 0 {
					add("kitchen %s needs a sink counter, a cooktop counter and a fridge", r.ID)
				}
			case "bath":
				if has(typ("toilet")) == 0 || has(typ("vanity")) == 0 || has(typ("shower"))+has(typ("bathtub")) == 0 {
					add("bath %s needs a toilet, a vanity and a shower or bathtub", r.ID)
				}
			case "powder":
				if has(typ("toilet")) == 0 || has(typ("vanity")) == 0 {
					add("powder room %s needs a toilet and a vanity", r.ID)
				}
			case "bedroom", "dorm-room":
				if has(typ("bed")) == 0 {
					add("%s %s needs a bed", r.Type, r.ID)
				}
			}
		}
	}
	return e
}

func polyRect(p []Pt) (Rect, bool) {
	if len(p) != 4 {
		return Rect{}, false
	}
	r := Rect{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	for _, q := range p {
		r.X0, r.Y0 = math.Min(r.X0, q[0]), math.Min(r.Y0, q[1])
		r.X1, r.Y1 = math.Max(r.X1, q[0]), math.Max(r.Y1, q[1])
	}
	for _, q := range p {
		if !(near(q[0], r.X0) || near(q[0], r.X1)) || !(near(q[1], r.Y0) || near(q[1], r.Y1)) {
			return Rect{}, false
		}
	}
	return r, true
}

func wallsCross(a, b DWall) bool {
	ah, bh := near(a.Y1, a.Y2), near(b.Y1, b.Y2)
	if ah == bh {
		return false // parallel (collinear overlap is caught by the area checks)
	}
	h, v := a, b
	if !ah {
		h, v = b, a
	}
	x0, x1 := math.Min(h.X1, h.X2), math.Max(h.X1, h.X2)
	y0, y1 := math.Min(v.Y1, v.Y2), math.Max(v.Y1, v.Y2)
	// crossing = v's x strictly inside h, and h's y strictly inside v
	return v.X1 > x0+eps && v.X1 < x1-eps && h.Y1 > y0+eps && h.Y1 < y1-eps
}

// sharedOpenEdges lists room pairs that share an edge with no wall on it (open plan).
func sharedOpenEdges(lv DLevel) [][2]string {
	var rects []Rect
	for _, r := range lv.Rooms {
		rr, _ := polyRect(r.Polygon)
		rects = append(rects, rr)
	}
	covered := func(horiz bool, c, a, b float64) float64 {
		// length of [a,b] on line c covered by walls
		var iv [][2]float64
		for _, w := range lv.Walls {
			if horiz && near(w.Y1, w.Y2) && near(w.Y1, c) {
				iv = append(iv, [2]float64{math.Min(w.X1, w.X2), math.Max(w.X1, w.X2)})
			}
			if !horiz && near(w.X1, w.X2) && near(w.X1, c) {
				iv = append(iv, [2]float64{math.Min(w.Y1, w.Y2), math.Max(w.Y1, w.Y2)})
			}
		}
		sum := 0.0
		for _, x := range iv {
			lo, hi := math.Max(a, x[0]), math.Min(b, x[1])
			if hi > lo {
				sum += hi - lo
			}
		}
		return sum
	}
	var out [][2]string
	for i := range rects {
		for j := range rects {
			if i == j {
				continue
			}
			a, b := rects[i], rects[j]
			if near(a.Y1, b.Y0) { // a below b
				lo, hi := math.Max(a.X0, b.X0), math.Min(a.X1, b.X1)
				if hi-lo > 0.5 && covered(true, a.Y1, lo, hi) < hi-lo-0.5 {
					out = append(out, [2]string{lv.Rooms[i].ID, lv.Rooms[j].ID})
				}
			}
			if near(a.X1, b.X0) { // a left of b
				lo, hi := math.Max(a.Y0, b.Y0), math.Min(a.Y1, b.Y1)
				if hi-lo > 0.5 && covered(false, a.X1, lo, hi) < hi-lo-0.5 {
					out = append(out, [2]string{lv.Rooms[i].ID, lv.Rooms[j].ID})
				}
			}
		}
	}
	return out
}
