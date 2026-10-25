package main

// L, U and courtyard plans for one home (house, mansion, villa). The straight plan is one bar: a
// front band of rooms, a hall, and a back band. These plans join several bars ("wings"):
//
//   - L: the main wing along the street, and a side wing running back from its right end;
//   - U: side wings at both ends, with the yard between them;
//   - courtyard: a fourth wing across the back closes the ring round an open court.
//
// The main wing's front band and hall run its full width. Each side wing starts where the main
// hall ends, so its hall opens straight off the main hall, and its rooms sit either side of it. The
// back wing of a courtyard plan mirrors the main wing, its hall joining the side halls. Every band
// is filled with rooms the way the straight plan fills its bands, and every level has the same
// outline, so walls, stairs and windows work as they do for a rectangle.

import (
	"fmt"
	"math"
	"sort"
)

const (
	ShapeL     = "l"
	ShapeU     = "u"
	ShapeCourt = "courtyard"
)

func isWingShape(s string) bool { return s == ShapeL || s == ShapeU || s == ShapeCourt }

// wingHomeTypes are the types the winged plans are for: one home on its own.
func wingHomeTypes(ht string) bool { return ht == "house" || ht == "mansion" || ht == "villa" }

// shapeForType keeps a wing plan to the types that have one; others are drawn rectangular.
func shapeForType(ht, shape string) string {
	if isWingShape(shape) && !wingHomeTypes(ht) {
		return ShapeRect
	}
	return shape
}

// RoofWing is one pitched roof over one wing (exterior.roof.wings).
type RoofWing struct {
	X0        float64 `json:"x0"`
	Y0        float64 `json:"y0"`
	X1        float64 `json:"x1"`
	Y1        float64 `json:"y1"`
	RidgeAxis string  `json:"ridgeAxis"`
}

type wingBand struct {
	r      Rect
	alongX bool // rooms follow one another along x (else along y)
	hall   int
	pin    int // 1: the street band, 2: the main back band (stairs), 0: anywhere
	slots  []slot
	used   float64
}

func (b *wingBand) length() float64 {
	if b.alongX {
		return b.r.W()
	}
	return b.r.D()
}

type wingPlan struct {
	halls   []Rect
	open    [][2]int // halls with no wall between them
	bands   []*wingBand
	outline []Pt
	roofs   []RoofWing
	W, D    float64 // the bounding rectangle
	wingD   float64 // the depth of one wing
}

// planWings lays out the bands and halls of a winged plan: a is the main wing's length, b the side
// wings' length. The main wing has rooms both sides of its hall. An L's side wing does too; the
// side wings of a U and the four wings of a courtyard plan have one row of rooms on the outside and
// the hall along the yard or court, as a gallery.
func planWings(shape string, ps homePreset, a, b float64) wingPlan {
	df, h, db := ps.df, ps.hall, ps.db
	D := df + h + db
	y0 := df + h
	y1 := y0 + b
	dO := math.Max(df, db) // a single-loaded wing's row of rooms
	S := h + dO            // a single-loaded wing's depth
	wp := wingPlan{wingD: D, W: a}
	wp.halls = append(wp.halls, Rect{0, df, a, y0})
	wp.roofs = append(wp.roofs, RoofWing{0, 0, a, D, "x"})
	front := &wingBand{r: Rect{0, 0, a, df}, alongX: true, hall: 0, pin: 1}
	switch shape {
	case ShapeL:
		wp.D = y1
		wp.halls = append(wp.halls, Rect{a - D + db, y0, a - df, y1})
		wp.open = append(wp.open, [2]int{0, 1})
		wp.bands = append(wp.bands, front,
			&wingBand{r: Rect{0, y0, a - D, D}, alongX: true, hall: 0, pin: 2},
			&wingBand{r: Rect{a - D, y0, a - D + db, y1}, hall: 1},
			&wingBand{r: Rect{a - df, y0, a, y1}, hall: 1})
		wp.outline = []Pt{{0, 0}, {a, 0}, {a, y1}, {a - D, y1}, {a - D, D}, {0, D}}
		wp.roofs = append(wp.roofs, RoofWing{a - D, D / 2, a, y1, "y"})
	case ShapeU, ShapeCourt:
		// Side wings: the hall on the inside, the rooms on the outside.
		wp.halls = append(wp.halls, Rect{a - S, y0, a - dO, y1}, Rect{dO, y0, S, y1})
		wp.open = append(wp.open, [2]int{0, 1}, [2]int{0, 2})
		wp.bands = append(wp.bands, front,
			&wingBand{r: Rect{S, y0, a - S, D}, alongX: true, hall: 0, pin: 2},
			&wingBand{r: Rect{a - dO, y0, a, y1}, hall: 1},
			&wingBand{r: Rect{0, y0, dO, y1}, hall: 2})
		if shape == ShapeU {
			wp.D = y1
			wp.outline = []Pt{{0, 0}, {a, 0}, {a, y1}, {a - S, y1}, {a - S, D}, {S, D}, {S, y1}, {0, y1}}
			wp.roofs = append(wp.roofs, RoofWing{a - S, D / 2, a, y1, "y"}, RoofWing{0, D / 2, S, y1, "y"})
			break
		}
		// The back wing closes the court: its hall joins both side halls.
		top := y1 + S
		wp.D = top
		wp.halls = append(wp.halls, Rect{0, y1, a, y1 + h})
		wp.open = append(wp.open, [2]int{1, 3}, [2]int{2, 3})
		wp.bands = append(wp.bands, &wingBand{r: Rect{0, y1 + h, a, top}, alongX: true, hall: 3})
		// One ring: round the outside, then along a slit (x = S, from the street side) round the
		// court the other way. The slit's two edges cancel, so the area and inside tests are exact.
		wp.outline = []Pt{{S, 0}, {a, 0}, {a, top}, {0, top}, {0, 0}, {S, 0}, {S, D}, {S, y1}, {a - S, y1}, {a - S, D}, {S, D}}
		mid := y1 + S/2 // the back wing's ridge line
		wp.roofs = append(wp.roofs, RoofWing{0, y1, a, top, "x"},
			RoofWing{a - S, D / 2, a, mid, "y"}, RoofWing{0, D / 2, S, mid, "y"})
	}
	return wp
}

// wingLengths gives the side wings' length for a main wing of length a.
func wingLengths(shape string, ps homePreset, a float64) float64 {
	switch shape {
	case ShapeL:
		return math.Max(4, 0.65*a-ps.hall)
	case ShapeU:
		return math.Max(5, 0.45*a)
	default:
		// The court is at least 4 m deep; the plan is roughly square.
		D := ps.df + ps.hall + ps.db
		return math.Max(ps.db+4, 0.7*a-D)
	}
}

// minMainLength is the shortest main wing that leaves a usable back band (and yard or court).
func minMainLength(shape string, ps homePreset) float64 {
	D := ps.df + ps.hall + ps.db
	S := ps.hall + math.Max(ps.df, ps.db)
	if shape == ShapeL {
		return D + 4
	}
	return 2*S + 4
}

// errWingTooBig: the home is too small for the plan asked for.
var errWingTooBig = fmt.Errorf("too small for this plan")

// layoutWings lays out one home as an L, U or courtyard plan.
func layoutWings(p Program, variant int) (*Layout, error) {
	presets := homePresets(p)
	if variant >= len(presets) {
		return nil, ErrNoPreset
	}
	ps := presets[variant]
	levels, names := homeLevels(p)
	perFloor := p.AreaM2 / float64(p.Floors)
	garageArea := 0.0
	for _, lv := range levels {
		for _, s := range lv {
			if s.typ == "garage" {
				garageArea = s.fixedW * ps.df
			}
		}
	}
	want := perFloor + garageArea
	area := func(a float64) float64 {
		return PolyArea(planWings(p.Shape, ps, a, wingLengths(p.Shape, ps, a)).outline)
	}
	// The main wing's length for the floor area asked for, then longer until every room fits.
	lo, hi := minMainLength(p.Shape, ps), 300.0
	if area(lo) < want {
		for i := 0; i < 40; i++ {
			m := (lo + hi) / 2
			if area(m) < want {
				lo = m
			} else {
				hi = m
			}
		}
		lo = hi
	}
	a := math.Ceil(lo*10) / 10
	var wp wingPlan
	var assigned [][]*wingBand
	for tries := 0; ; tries++ {
		if tries > 60 {
			return nil, fmt.Errorf("couldn't fit the rooms into a %s plan", p.Shape)
		}
		wp = planWings(p.Shape, ps, a, wingLengths(p.Shape, ps, a))
		assigned = nil
		ok := true
		for _, lv := range levels {
			bands, fits := assignWingBands(lv, wp.bands)
			if !fits {
				ok = false
				break
			}
			assigned = append(assigned, bands)
		}
		if ok {
			break
		}
		a = math.Ceil(a*1.06*10) / 10
	}

	D := wp.wingD
	l := &Layout{W: wp.W, D: wp.D, GarageCars: p.GarageCars, Basement: p.Basement, Outline: wp.outline, RoofWings: wp.roofs}
	got := PolyArea(wp.outline)*float64(p.Floors) - garageArea
	if got > p.AreaM2*1.35 {
		return nil, errWingTooBig
	}
	if got > p.AreaM2*1.15 {
		l.Cautions = append(l.Cautions, fmt.Sprintf("The %s plan makes the home about %.0f m², more than the %.0f m² asked for.",
			shapeName(p.Shape), got, p.AreaM2))
	}
	base := 0
	if p.Basement {
		base = 1
	}
	for i, name := range names {
		h, elev := 3.0, float64(i-base)*3.0
		if p.Basement && i == 0 {
			h, elev = 2.9, -2.9
		}
		l.Levels = append(l.Levels, &LLevel{Index: i, Name: name, Elev: elev, Height: h})
	}
	const unitID = "U-1"
	var stairRooms, elevRooms []*LRoom
	entryDone := false
	publicLvl := base
	if p.Floors >= 3 {
		publicLvl = base + 1
	}
	for li := range levels {
		var halls []*LRoom
		for hi, hr := range wp.halls {
			name := "Hall"
			switch {
			case li < base:
				name = "Basement hall"
			case li > base:
				name = "Upper hall"
			}
			if hi > 0 {
				name += fmt.Sprintf(" %d", hi+1)
			}
			halls = append(halls, l.add(li, name, "hall", unitID, hr))
		}
		for _, o := range wp.open {
			halls[o[1]].Open = append(halls[o[1]].Open, halls[o[0]].Key)
		}
		byTag := map[string]*LRoom{}
		mainBack := map[*LRoom]bool{}
		for bi, b := range assigned[li] {
			ws := bandWidths(b.slots, b.length())
			at := 0.0
			var prev *LRoom
			var prevGroup string
			for i, s := range b.slots {
				var r Rect
				if b.alongX {
					r = Rect{b.r.X0 + at, b.r.Y0, b.r.X0 + at + ws[i], b.r.Y1}
					if i == len(b.slots)-1 {
						r.X1 = b.r.X1
					}
				} else {
					r = Rect{b.r.X0, b.r.Y0 + at, b.r.X1, b.r.Y0 + at + ws[i]}
					if i == len(b.slots)-1 {
						r.Y1 = b.r.Y1
					}
				}
				at += ws[i]
				rm := l.add(li, s.name, s.typ, unitID, r)
				rm.Beds, rm.BedSize, rm.Tub, rm.DoubleVanity, rm.Washers = s.beds, s.bedSize, s.tub, s.double, s.washers
				if s.tag != "" {
					byTag[s.tag] = rm
				}
				if bi == 1 {
					mainBack[rm] = true
				}
				switch s.typ {
				case "stair":
					stairRooms = append(stairRooms, rm)
				case "elevator":
					elevRooms = append(elevRooms, rm)
				}
				if s.group != "" && s.group == prevGroup && prev != nil {
					rm.Open = append(rm.Open, prev.Key)
				}
				if s.link != "" {
					w := r.W()
					if !b.alongX {
						w = r.D()
					}
					rm.Links = append(rm.Links, Link{To: halls[b.hall].Key, Kind: s.link, Width: openingWidth(s.link, w, p.Accessible)})
				}
				prev, prevGroup = rm, s.group
			}
		}
		if li == publicLvl && contains(p.Extras, "deck") {
			// The deck goes off the main wing's back, into the yard (or the court).
			var target *LRoom
			for _, t := range []string{"living", "family", "dining", "kitchen", "bedroom", "office"} {
				for _, rm := range l.Levels[li].Rooms {
					if target == nil && mainBack[rm] && rm.Type == t && near(rm.R.Y1, D) && rm.R.W() >= 2.4 {
						target = rm
					}
				}
			}
			if target != nil {
				w := math.Min(4.0, target.R.W()-0.4)
				dd := 3.0
				if p.Shape == ShapeCourt {
					dd = math.Min(3.0, wp.halls[len(wp.halls)-1].Y0-D-0.5)
				}
				cx := (target.R.X0 + target.R.X1) / 2
				l.Balconies = append(l.Balconies, LBalcony{Level: li, R: Rect{cx - w/2, D, cx + w/2, D + dd}, Unit: unitID, Room: target.Key, Railing: "metal"})
				target.Links = append(target.Links, Link{Kind: "patio", Width: math.Min(1.8, w-0.2), Side: 'N', At: cx})
			} else {
				l.Cautions = append(l.Cautions, "The deck was left off: no room on the living floor backs onto the yard.")
			}
		}
		if li == base {
			door := byTag["entry"]
			if door == nil {
				door = byTag["living"]
			}
			if door != nil && door.R.Y0 == 0 {
				door.Links = append(door.Links, Link{Kind: "entry", Width: entryWidth(p.Accessible), UnitEntry: true, Side: 'S', At: -1})
				entryDone = true
			}
			if g := byTag["garage"]; g != nil {
				g.Links = append(g.Links, Link{Kind: "garage", Width: 2.5 * float64(p.GarageCars), Side: 'S', At: -1})
			}
			if contains(p.Extras, "porch") {
				l.Porch = &Rect{0, -2.2, math.Min(wp.W, 8.0), 0}
			}
		}
	}
	if !entryDone {
		return nil, fmt.Errorf("no front room for the entry door")
	}
	for i := 0; i+1 < len(stairRooms); i++ {
		l.Stairs = append(l.Stairs, LStair{R: stairRooms[i].R, From: stairRooms[i].Level, To: stairRooms[i+1].Level,
			Access: "front", Shape: "switchback", Unit: unitID})
	}
	if len(elevRooms) > 1 {
		var lv []int
		for _, e := range elevRooms {
			lv = append(lv, e.Level)
		}
		l.Elevators = append(l.Elevators, LElevator{R: elevRooms[0].R, Levels: lv, DoorSide: "front"})
	}
	l.Units = append(l.Units, LUnit{unitID, "The house", "house", p.Bedrooms, p.Bathrooms})
	return l, nil
}

// assignWingBands shares one level's rooms out among the bands: the street band takes the rooms
// pinned to the front (entry, garage), the main back band the stairs; the rest go, largest first,
// to the band with the most room left. Bands left empty get a sitting room or a store. fits is false
// when some band can't hold its rooms.
func assignWingBands(lv []slot, tmpl []*wingBand) ([]*wingBand, bool) {
	bands := make([]*wingBand, len(tmpl))
	for i, b := range tmpl {
		c := *b
		c.slots, c.used = nil, 0
		bands[i] = &c
	}
	type grp struct {
		slots []slot
		w     float64
		pin   int
	}
	var groups []*grp
	byName := map[string]*grp{}
	for _, s := range lv {
		if s.group != "" {
			if g := byName[s.group]; g != nil {
				g.slots, g.w = append(g.slots, s), g.w+s.minWidth()
				if s.pin != 0 {
					g.pin = s.pin
				}
				continue
			}
		}
		g := &grp{slots: []slot{s}, w: s.minWidth(), pin: s.pin}
		groups = append(groups, g)
		if s.group != "" {
			byName[s.group] = g
		}
	}
	rank := func(g *grp) int {
		switch g.slots[0].typ {
		case "entry", "stair":
			return 0
		case "elevator":
			return 1
		case "living":
			return 2
		case "garage":
			return 9
		}
		return 5
	}
	put := func(b *wingBand, g *grp) {
		b.slots = append(b.slots, g.slots...)
		b.used += g.w
	}
	var pinned, flex []*grp
	for _, g := range groups {
		if g.pin != 0 {
			pinned = append(pinned, g)
		} else {
			flex = append(flex, g)
		}
	}
	sort.SliceStable(pinned, func(i, j int) bool { return rank(pinned[i]) < rank(pinned[j]) })
	for _, g := range pinned {
		put(bands[g.pin-1], g)
	}
	sort.SliceStable(flex, func(i, j int) bool { return flex[i].w > flex[j].w })
	for _, g := range flex {
		var best *wingBand
		bestFree := -1.0
		for _, b := range bands {
			free := (b.length() - b.used - g.w) / b.length()
			if b.used+g.w <= b.length()+1e-9 && free > bestFree {
				best, bestFree = b, free
			}
		}
		if best == nil {
			return nil, false
		}
		put(best, g)
	}
	for _, b := range bands {
		if b.used > b.length()+1e-9 {
			return nil, false
		}
		// Rooms grow only so far: past that, the spare length is a sitting room or a store.
		for spare := b.length() - b.used - growRoom(b.slots); spare > 1.5; spare = b.length() - b.used - growRoom(b.slots) {
			f := slot{name: "Storage", typ: "storage", area: 4, minW: 1.6, link: "door", share: 0.5}
			if spare >= 3.2 {
				f = slot{name: "Sitting room", typ: "family", area: 12, minW: math.Min(spare, 4.5), link: "cased", share: 1}
			}
			b.slots = append(b.slots, f)
			b.used += f.minWidth()
		}
		// Keep the order the straight plan uses: entry and stairs first, garage last.
		sort.SliceStable(b.slots, func(i, j int) bool { return slotRank(b.slots[i]) < slotRank(b.slots[j]) })
		hasFlex := false
		for _, s := range b.slots {
			if s.fixedW == 0 && s.share > 0 {
				hasFlex = true
			}
		}
		if !hasFlex {
			f := slot{name: "Storage", typ: "storage", area: 4, minW: 1.6, link: "door", share: 1}
			if b.length()-b.used >= 6 {
				f = slot{name: "Sitting room", typ: "family", area: 12, minW: 3.0, link: "cased", share: 1}
			}
			b.slots = append(b.slots, f)
			b.used += f.minWidth()
			if b.used > b.length()+1e-9 {
				return nil, false
			}
		}
	}
	return bands, true
}

// growRoom is how much longer than their minimum a band's rooms can sensibly get: small rooms
// (baths, laundries, entries, closets) up to about half again, living rooms and bedrooms up to
// about double.
func growRoom(ss []slot) float64 {
	g := 0.0
	for _, s := range ss {
		if s.fixedW > 0 {
			continue
		}
		switch s.typ {
		case "bath", "powder", "laundry", "entry", "pantry", "closet", "linen", "storage", "mudroom", "mechanical":
			g += 0.6 * s.minW
		default:
			g += math.Max(1.2*s.minW, 3)
		}
	}
	return g
}

// slotRank orders a band's rooms; rooms of one open-plan group keep their order.
func slotRank(s slot) int {
	switch s.typ {
	case "entry", "stair":
		return 0
	case "elevator":
		return 1
	case "garage":
		return 9
	}
	return 5
}

func shapeName(s string) string {
	switch s {
	case ShapeL:
		return "L-shaped"
	case ShapeU:
		return "U-shaped"
	case ShapeCourt:
		return "courtyard"
	}
	return s
}
