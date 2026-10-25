package main

// Turns a Layout into the drawable design: room ids, walls derived from the
// room tiling, doors/windows/entries on those walls, balconies, furniture,
// stairs, elevators, units and totals.

import (
	"fmt"
	"math"
	"sort"
)

const eps = 1e-4

func near(a, b float64) bool { return math.Abs(a-b) < eps }

// seg is a stretch of a wall line between two rooms (or a room and outside).
type seg struct {
	a, b  float64
	roomA string // below / left  ("" = outside)
	roomB string // above / right ("" = outside)
}

type wallLine struct {
	horiz bool
	c     float64 // y for horizontal, x for vertical
	a, b  float64
	kind  string
	segs  []seg
	id    string
	used  [][2]float64 // occupied by openings (along the wall, absolute coords)
}

func (w *wallLine) length() float64 { return w.b - w.a }

func (w *wallLine) toDWall() DWall {
	t := map[string]float64{"exterior": 0.3, "party": 0.25, "interior": 0.12}[w.kind]
	if w.horiz {
		return DWall{ID: w.id, Kind: w.kind, X1: rd(w.a), Y1: rd(w.c), X2: rd(w.b), Y2: rd(w.c), ThicknessM: t}
	}
	return DWall{ID: w.id, Kind: w.kind, X1: rd(w.c), Y1: rd(w.a), X2: rd(w.c), Y2: rd(w.b), ThicknessM: t}
}

// deriveWalls builds the walls of one level from its rooms. open says whether
// two rooms share no wall (open plan).
func deriveWalls(rooms []*LRoom, open func(a, b string) bool) []*wallLine {
	unitOf := map[string]string{}
	for _, r := range rooms {
		unitOf[r.Key] = r.Unit
	}
	type piece struct {
		horiz   bool
		c, a, b float64
		lo, hi  string // below/left, above/right
		kind    string
	}
	var pieces []piece
	collect := func(horiz bool) {
		var all []float64
		for _, r := range rooms {
			if horiz {
				all = append(all, r.R.Y0, r.R.Y1)
			} else {
				all = append(all, r.R.X0, r.R.X1)
			}
		}
		sort.Float64s(all)
		var lines []float64
		for _, c := range all {
			if len(lines) == 0 || !near(lines[len(lines)-1], c) {
				lines = append(lines, c)
			}
		}
		for _, c := range lines {
			var bps []float64
			var lo, hi []*LRoom
			for _, r := range rooms {
				r0, r1, s0, s1 := r.R.Y0, r.R.Y1, r.R.X0, r.R.X1
				if !horiz {
					r0, r1, s0, s1 = r.R.X0, r.R.X1, r.R.Y0, r.R.Y1
				}
				if near(r1, c) {
					lo = append(lo, r)
					bps = append(bps, s0, s1)
				}
				if near(r0, c) {
					hi = append(hi, r)
					bps = append(bps, s0, s1)
				}
			}
			sort.Float64s(bps)
			var u []float64
			for _, x := range bps {
				if len(u) == 0 || !near(u[len(u)-1], x) {
					u = append(u, x)
				}
			}
			cover := func(list []*LRoom, a, b float64) string {
				for _, r := range list {
					s0, s1 := r.R.X0, r.R.X1
					if !horiz {
						s0, s1 = r.R.Y0, r.R.Y1
					}
					if s0 <= a+eps && s1 >= b-eps {
						return r.Key
					}
				}
				return ""
			}
			for i := 0; i+1 < len(u); i++ {
				a, b := u[i], u[i+1]
				l, h := cover(lo, a, b), cover(hi, a, b)
				if l == "" && h == "" {
					continue
				}
				kind := "exterior"
				switch {
				case l == "" || h == "":
				case open(l, h):
					continue
				case unitOf[l] != unitOf[h]:
					kind = "party"
				default:
					kind = "interior"
				}
				pieces = append(pieces, piece{horiz, c, a, b, l, h, kind})
			}
		}
	}
	collect(true)
	collect(false)

	// endpoints of kept pieces, by orientation
	key := func(x, y float64) [2]float64 { return [2]float64{rd(x), rd(y)} }
	hEnds, vEnds := map[[2]float64]bool{}, map[[2]float64]bool{}
	for _, p := range pieces {
		if p.horiz {
			hEnds[key(p.a, p.c)], hEnds[key(p.b, p.c)] = true, true
		} else {
			vEnds[key(p.c, p.a)], vEnds[key(p.c, p.b)] = true, true
		}
	}
	sort.Slice(pieces, func(i, j int) bool {
		if pieces[i].horiz != pieces[j].horiz {
			return pieces[i].horiz
		}
		if !near(pieces[i].c, pieces[j].c) {
			return pieces[i].c < pieces[j].c
		}
		return pieces[i].a < pieces[j].a
	})
	var walls []*wallLine
	for _, p := range pieces {
		s := seg{p.a, p.b, p.lo, p.hi}
		if n := len(walls); n > 0 {
			w := walls[n-1]
			junction := key(p.a, p.c)
			blocked := vEnds[junction]
			if !p.horiz {
				junction = key(p.c, p.a)
				blocked = hEnds[junction]
			}
			if w.horiz == p.horiz && near(w.c, p.c) && near(w.b, p.a) && w.kind == p.kind && !blocked {
				w.b = p.b
				w.segs = append(w.segs, s)
				continue
			}
		}
		walls = append(walls, &wallLine{horiz: p.horiz, c: p.c, a: p.a, b: p.b, kind: p.kind, segs: []seg{s}})
	}
	return walls
}

// ------------------------------------------------------------------ design assembly

type genCtx struct {
	l        *Layout
	p        Program
	ids      map[string]string // room key → id
	rooms    map[string]*LRoom
	levels   []DLevel
	walls    [][]*wallLine
	openings [][]DOpening
	entryOf  map[string]string // unit id → entry opening id
	nOpen    []int
}

var habitable = map[string]bool{"living": true, "kitchen": true, "dining": true, "family": true, "bedroom": true,
	"office": true, "bath": true, "powder": true, "dorm-room": true, "suite-common": true, "lounge": true,
	"study": true, "gym": true, "common": true, "lobby": true, "corridor": true, "hall": true, "entry": true,
	"stair": true, "laundry": true, "shared-kitchen": true, "shared-bath": true, "shared-laundry": true, "mudroom": true}

func BuildDesign(l *Layout, p Program) (*Design, error) {
	g := &genCtx{l: l, p: p, ids: map[string]string{}, rooms: map[string]*LRoom{}, entryOf: map[string]string{}}
	d := &Design{Schema: "terrasim.design/2", HousingType: p.HousingType}
	for _, lv := range l.Levels {
		for i, r := range lv.Rooms {
			g.ids[r.Key] = fmt.Sprintf("L%d-R%d", lv.Index, i+1)
			g.rooms[r.Key] = r
		}
	}
	openPair := func(a, b string) bool {
		for _, k := range g.rooms[a].Open {
			if k == b {
				return true
			}
		}
		for _, k := range g.rooms[b].Open {
			if k == a {
				return true
			}
		}
		return false
	}
	for li, lv := range l.Levels {
		walls := deriveWalls(lv.Rooms, openPair)
		for i, w := range walls {
			w.id = fmt.Sprintf("L%d-W%d", li, i+1)
		}
		g.walls = append(g.walls, walls)
		g.openings = append(g.openings, nil)
		g.nOpen = append(g.nOpen, 0)
		dl := DLevel{Index: lv.Index, Name: lv.Name, ElevationM: r2(lv.Elev), HeightM: r2(lv.Height),
			CeilingHeightM: r2(lv.Height - 0.3), Outline: RingOf(Rect{0, 0, l.W, l.D}.Poly()),
			Balconies: []DBalcony{}, Furnishings: []DFurnishing{}}
		for _, r := range lv.Rooms {
			var unit *string
			if r.Unit != "" {
				u := r.Unit
				unit = &u
			}
			dl.Rooms = append(dl.Rooms, DRoom{ID: g.ids[r.Key], Name: r.Name, Type: r.Type, UnitID: unit,
				Polygon: RingOf(r.R.Poly()), AreaM2: r2(r.R.Area()), FloorFinish: defaultFinish(r.Type)})
		}
		g.levels = append(g.levels, dl)
	}
	// doors and openings between rooms, and to the outside
	for li, lv := range l.Levels {
		for _, r := range lv.Rooms {
			for _, ln := range r.Links {
				if err := g.placeLink(li, r, ln); err != nil {
					return nil, err
				}
			}
		}
	}
	for li := range l.Levels {
		g.placeWindows(li)
	}
	for li := range l.Levels {
		for _, w := range g.walls[li] {
			g.levels[li].Walls = append(g.levels[li].Walls, w.toDWall())
		}
		g.levels[li].Openings = g.openings[li]
		if g.levels[li].Openings == nil {
			g.levels[li].Openings = []DOpening{}
		}
	}
	// balconies
	for i, b := range l.Balconies {
		var unit *string
		if b.Unit != "" {
			u := b.Unit
			unit = &u
		}
		g.levels[b.Level].Balconies = append(g.levels[b.Level].Balconies, DBalcony{
			ID: fmt.Sprintf("L%d-B%d", b.Level, i+1), UnitID: unit, Polygon: b.R.Poly(), Railing: b.Railing})
	}
	// furniture
	for li, lv := range l.Levels {
		for _, r := range lv.Rooms {
			fs, err := furnish(r, g.ids[r.Key], g.clearances(li, r))
			if err != nil {
				return nil, err
			}
			g.levels[li].Furnishings = append(g.levels[li].Furnishings, fs...)
		}
	}
	d.Levels = g.levels

	// stairs and elevators
	letters := map[string]int{}
	for _, s := range l.Stairs {
		k := fmt.Sprintf("%.2f,%.2f", s.R.X0, s.R.Y0)
		if _, ok := letters[k]; !ok {
			letters[k] = len(letters)
		}
		d.Stairs = append(d.Stairs, DStair{ID: fmt.Sprintf("S-%c-%d", 'A'+letters[k], s.From), Shape: s.Shape,
			FromLevel: s.From, ToLevel: s.To, X: rd(s.R.X0), Y: rd(s.R.Y0), WidthM: rd(s.R.W()), DepthM: rd(s.R.D()),
			AccessSide: s.Access})
	}
	for i, e := range l.Elevators {
		d.Elevators = append(d.Elevators, DElevator{ID: fmt.Sprintf("E-%d", i+1), X: rd(e.R.X0), Y: rd(e.R.Y0),
			WidthM: rd(e.R.W()), DepthM: rd(e.R.D()), Levels: e.Levels, DoorSide: e.DoorSide})
	}
	if d.Stairs == nil {
		d.Stairs = []DStair{}
	}
	if d.Elevators == nil {
		d.Elevators = []DElevator{}
	}

	// units and totals
	unitArea := map[string]float64{}
	unitLevels := map[string]map[int]bool{}
	for _, lv := range l.Levels {
		for _, r := range lv.Rooms {
			if r.Unit == "" {
				continue
			}
			if r.Type != "garage" {
				unitArea[r.Unit] += r.R.Area()
			}
			if unitLevels[r.Unit] == nil {
				unitLevels[r.Unit] = map[int]bool{}
			}
			unitLevels[r.Unit][lv.Index] = true
		}
	}
	d.Units = []DUnit{}
	t := DesignTotals{}
	for _, u := range l.Units {
		var lv []int
		for i := range unitLevels[u.ID] {
			lv = append(lv, i)
		}
		sort.Ints(lv)
		entry := g.entryOf[u.ID]
		if entry == "" {
			return nil, fmt.Errorf("unit %s has no entry door", u.ID)
		}
		d.Units = append(d.Units, DUnit{ID: u.ID, Name: u.Name, Kind: u.Kind, Levels: lv, EntryOpeningID: entry,
			Bedrooms: u.Bedrooms, Bathrooms: u.Bathrooms, AreaM2: r1(unitArea[u.ID])})
		t.Bedrooms += u.Bedrooms
		t.Bathrooms += u.Bathrooms
		t.FinishedAreaM2 += unitArea[u.ID]
	}
	t.UnitCount = len(l.Units)
	if l.Basement {
		t.LevelsBelowGround = 1
	}
	t.Floors = len(l.Levels) - t.LevelsBelowGround
	t.GrossAreaM2 = r1(l.W * l.D * float64(len(l.Levels)))
	if p.HousingType == "hotel" {
		// A hotel's totals count its guest rooms and their baths.
		for _, lv := range l.Levels {
			for _, r := range lv.Rooms {
				switch {
				case r.Type == "bedroom":
					t.Bedrooms++
					t.FinishedAreaM2 += r.R.Area()
				case r.Type == "bath":
					t.Bathrooms++
					t.FinishedAreaM2 += r.R.Area()
				case r.Type == "living" || (r.Type == "entry" && r.Unit == ""):
					t.FinishedAreaM2 += r.R.Area()
				}
			}
		}
	}
	if p.HousingType == "dorm" {
		res := l.Residents
		t.Residents = &res
		for _, lv := range l.Levels {
			for _, r := range lv.Rooms {
				switch r.Type {
				case "dorm-room":
					t.Bedrooms++
					t.FinishedAreaM2 += r.R.Area()
				case "suite-common":
					t.FinishedAreaM2 += r.R.Area()
				case "bath", "shared-bath":
					t.Bathrooms++
					if r.Name == "Suite bath" || r.Type == "bath" {
						t.FinishedAreaM2 += r.R.Area()
					}
				}
			}
		}
	}
	t.FinishedAreaM2 = r1(t.FinishedAreaM2)
	t.ParkingSpaces = l.GarageCars
	d.Totals = t
	d.Size = Size{WidthM: rd(l.W), DepthM: rd(l.D)}
	return d, nil
}

func defaultFinish(t string) string {
	switch t {
	case "garage", "stair", "elevator", "mechanical", "trash", "bike-storage", "storage":
		return "concrete"
	case "bath", "powder", "laundry", "shared-bath", "shared-laundry", "mudroom":
		return "tile"
	case "lobby", "corridor", "entry":
		return "tile"
	}
	return "wood"
}

func (g *genCtx) newOpening(li int, kind string, w *wallLine, center, width float64, a, b string) (string, error) {
	half := width / 2
	lo, hi := center-half, center+half
	if lo < w.a+0.05 || hi > w.b-0.05 {
		return "", fmt.Errorf("opening doesn't fit on wall %s", w.id)
	}
	for _, u := range w.used {
		if lo < u[1]+0.15 && hi > u[0]-0.15 {
			return "", fmt.Errorf("opening overlaps another on wall %s", w.id)
		}
	}
	w.used = append(w.used, [2]float64{lo, hi})
	g.nOpen[li]++
	id := fmt.Sprintf("L%d-O%d", li, g.nOpen[li])
	o := DOpening{ID: id, Kind: kind, WallID: w.id, OffsetM: rd(lo - w.a), WidthM: rd(width), HeadM: 2.1,
		Connects: [2]string{a, b}}
	switch kind {
	case "window":
		sill, head := 0.8, 2.2
		o.SillM, o.HeadM = &sill, head
	case "garage":
		o.HeadM = 2.4
	case "entry":
		if width >= 1.5 {
			o.HeadM = 2.4
		}
	}
	g.openings[li] = append(g.openings[li], o)
	return id, nil
}

// sideOf tells which side of room r a wall seg is on.
func sideOf(w *wallLine, r Rect) byte {
	if w.horiz {
		if near(w.c, r.Y0) {
			return 'S'
		}
		return 'N'
	}
	if near(w.c, r.X0) {
		return 'W'
	}
	return 'E'
}

func (g *genCtx) placeLink(li int, r *LRoom, ln Link) error {
	type cand struct {
		w *wallLine
		s seg
	}
	var cands []cand
	for _, w := range g.walls[li] {
		for _, s := range w.segs {
			if ln.To != "" {
				if (s.roomA == r.Key && s.roomB == ln.To) || (s.roomB == r.Key && s.roomA == ln.To) {
					cands = append(cands, cand{w, s})
				}
			} else if w.kind == "exterior" && (s.roomA == r.Key || s.roomB == r.Key) && sideOf(w, r.R) == ln.Side {
				cands = append(cands, cand{w, s})
			}
		}
	}
	if len(cands) == 0 {
		to := "outside"
		if ln.To != "" {
			to = g.rooms[ln.To].Name
		}
		return fmt.Errorf("no wall between %s and %s for a %s (level %d)", r.Name, to, ln.Kind, li)
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].s.b-cands[i].s.a > cands[j].s.b-cands[j].s.a })
	other := "outside"
	if ln.To != "" {
		other = g.ids[ln.To]
	}
	var lastErr error
	for _, c := range cands {
		length := c.s.b - c.s.a
		width := math.Min(ln.Width, length-0.3)
		if width < 0.7 {
			lastErr = fmt.Errorf("wall between %s and %s too short for a %s", r.Name, other, ln.Kind)
			continue
		}
		center := (c.s.a + c.s.b) / 2
		if ln.At >= 0 && ln.To == "" && ln.At > c.s.a && ln.At < c.s.b {
			center = math.Max(c.s.a+width/2+0.15, math.Min(c.s.b-width/2-0.15, ln.At))
		}
		id, err := g.newOpening(li, ln.Kind, c.w, center, width, g.ids[r.Key], other)
		if err != nil {
			lastErr = err
			continue
		}
		if ln.UnitEntry {
			g.entryOf[r.Unit] = id
		}
		return nil
	}
	return lastErr
}

func (g *genCtx) placeWindows(li int) {
	for _, w := range g.walls[li] {
		if w.kind != "exterior" {
			continue
		}
		for _, s := range w.segs {
			rk := s.roomA
			if rk == "" {
				rk = s.roomB
			}
			r := g.rooms[rk]
			if r == nil || !habitable[r.Type] {
				continue
			}
			small := r.Type == "bath" || r.Type == "powder" || r.Type == "shared-bath" || r.Type == "stair" ||
				r.Type == "laundry" || r.Type == "hall" || r.Type == "corridor" || r.Type == "entry"
			// free intervals inside this seg
			lo, hi := s.a+0.3, s.b-0.3
			free := [][2]float64{{lo, hi}}
			for _, u := range w.used {
				var next [][2]float64
				for _, f := range free {
					a, b := u[0]-0.3, u[1]+0.3
					if b <= f[0] || a >= f[1] {
						next = append(next, f)
						continue
					}
					if a > f[0] {
						next = append(next, [2]float64{f[0], a})
					}
					if b < f[1] {
						next = append(next, [2]float64{b, f[1]})
					}
				}
				free = next
			}
			for _, f := range free {
				L := f[1] - f[0]
				if L < 0.7 {
					continue
				}
				if small {
					width := math.Min(0.8, L)
					g.addWindow(li, w, (f[0]+f[1])/2, width, rk, r.Type)
					continue
				}
				n := int(math.Max(1, math.Floor(L/3.0)))
				slot := L / float64(n)
				width := math.Min(1.6, slot-0.5)
				if width < 0.7 {
					n, slot = 1, L
					width = math.Min(1.6, L)
				}
				for k := 0; k < n; k++ {
					g.addWindow(li, w, f[0]+slot*(float64(k)+0.5), width, rk, r.Type)
				}
			}
		}
	}
}

func (g *genCtx) addWindow(li int, w *wallLine, center, width float64, rk, typ string) {
	id, err := g.newOpening(li, "window", w, center, width, g.ids[rk], "outside")
	if err != nil {
		return
	}
	o := &g.openings[li][len(g.openings[li])-1]
	if o.ID == id && (typ == "bath" || typ == "powder" || typ == "shared-bath") {
		sill := 1.5
		o.SillM, o.HeadM = &sill, 2.1
	}
	if o.ID == id && typ == "lobby" {
		sill := 0.3
		o.SillM, o.HeadM = &sill, 2.6
	}
}

// clearances returns the floor areas in front of this room's doors and openings
// that furniture must keep clear.
func (g *genCtx) clearances(li int, r *LRoom) []Rect {
	var out []Rect
	byID := map[string]*wallLine{}
	for _, w := range g.walls[li] {
		byID[w.id] = w
	}
	id := g.ids[r.Key]
	for _, o := range g.openings[li] {
		if o.Kind == "window" || (o.Connects[0] != id && o.Connects[1] != id) {
			continue
		}
		w := byID[o.WallID]
		a, b := w.a+o.OffsetM-0.1, w.a+o.OffsetM+o.WidthM+0.1
		const depth = 0.9
		switch sideOf(w, r.R) {
		case 'S':
			out = append(out, Rect{a, r.R.Y0, b, r.R.Y0 + depth})
		case 'N':
			out = append(out, Rect{a, r.R.Y1 - depth, b, r.R.Y1})
		case 'W':
			out = append(out, Rect{r.R.X0, a, r.R.X0 + depth, b})
		case 'E':
			out = append(out, Rect{r.R.X1 - depth, a, r.R.X1, b})
		}
	}
	return out
}
