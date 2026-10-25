package main

// Layout engine: turns the program (what Gemma and the user chose) into room
// rectangles that exactly tile each level, plus the links between rooms (doors,
// openings), stairs, elevators, balconies, porch and units.
//
// Homes (house, tiny-home, townhouse, duplex, mansion, villa) use a hall spine: a front band of
// rooms, a hall, and a back band, so every room touches the hall.
// Apartments, condos, dorms and hotels use a double-loaded corridor with stair/elevator
// cores, and units laid out as entry/kitchen/baths → unit hall → living/bedrooms.

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

type Rect struct{ X0, Y0, X1, Y1 float64 }

func (r Rect) W() float64    { return r.X1 - r.X0 }
func (r Rect) D() float64    { return r.Y1 - r.Y0 }
func (r Rect) Area() float64 { return r.W() * r.D() }
func (r Rect) Poly() []Pt {
	return []Pt{{rd(r.X0), rd(r.Y0)}, {rd(r.X1), rd(r.Y0)}, {rd(r.X1), rd(r.Y1)}, {rd(r.X0), rd(r.Y1)}}
}

func rd(x float64) float64 { return math.Round(x*1000) / 1000 }

type Link struct {
	To        string // room key, or "" for outside
	Kind      string // door, passage, cased, entry, patio, garage
	Width     float64
	UnitEntry bool
	Side      byte    // for outside links: 'S','N','W','E'
	At        float64 // for outside links: centre along the wall (x or y), <0 = centre of the room side
}

type LRoom struct {
	Key, Name, Type, Unit string
	Level                 int
	R                     Rect
	Links                 []Link
	Open                  []string // rooms with no wall between
	Beds                  int
	BedSize               string
	DoubleVanity, Tub     bool
	Washers               int
}

type LLevel struct {
	Index        int
	Name         string
	Elev, Height float64
	Rooms        []*LRoom
	// Outline, when set, is this level's own outline (the stair house on a roof); Roof marks that
	// level, which isn't a floor of the building.
	Outline []Pt
	Roof    bool
}

type LStair struct {
	R             Rect
	From, To      int
	Access, Shape string
	Unit          string
}

type LElevator struct {
	R        Rect
	Levels   []int
	DoorSide string
}

type LBalcony struct {
	Level   int
	R       Rect
	Unit    string
	Room    string
	Railing string
}

type LUnit struct {
	ID, Name, Kind string
	Bedrooms       int
	Bathrooms      float64
}

type Layout struct {
	W, D       float64
	Levels     []*LLevel
	Stairs     []LStair
	Elevators  []LElevator
	Balconies  []LBalcony
	Units      []LUnit
	Porch      *Rect
	GarageCars int
	Basement   bool
	Residents  int
	Cautions   []string
	// Outline is the floor outline when it isn't the W × D rectangle (wings.go); RoofWings the
	// pitched roofs over its wings.
	Outline   []Pt
	RoofWings []RoofWing
	RoofLevel bool // the top level is the stair house of a roof terrace (roofterrace.go)
	nextKey   int
}

func (l *Layout) key() string { l.nextKey++; return fmt.Sprintf("k%d", l.nextKey) }

func (l *Layout) add(level int, name, typ, unit string, r Rect) *LRoom {
	rm := &LRoom{Key: l.key(), Name: name, Type: typ, Unit: unit, Level: level, R: r}
	l.Levels[level].Rooms = append(l.Levels[level].Rooms, rm)
	return rm
}

// Needs returns the space the layout occupies around its main rectangle.
func (l *Layout) Needs(parking int) Needs {
	nd := Needs{W: l.W, D: l.D, ParkingSpaces: parking}
	for _, b := range l.Balconies {
		nd.Front = math.Max(nd.Front, -b.R.Y0)
		nd.Back = math.Max(nd.Back, b.R.Y1-l.D)
	}
	if l.Porch != nil {
		nd.Front = math.Max(nd.Front, -l.Porch.Y0)
	}
	return nd
}

var ErrNoPreset = errors.New("no more layout variants")

// BuildLayout makes layout variant `variant` (0, 1, 2 …) for the program.
func BuildLayout(p Program, variant int) (*Layout, error) {
	if isMulti(p.HousingType) {
		return layoutCorridor(p, variant)
	}
	if isWingShape(p.Shape) && wingHomeTypes(p.HousingType) {
		l, err := layoutWings(p, variant)
		if err != errWingTooBig {
			return l, err
		}
		// Too small for the plan: a straight plan instead, and say so.
		if l, err = layoutHomes(p, variant); err == nil {
			l.Cautions = append(l.Cautions, fmt.Sprintf("At %.0f m² the home is too small for a %s plan, so it's drawn as one straight wing.", p.AreaM2, shapeName(p.Shape)))
		}
		return l, err
	}
	return layoutHomes(p, variant)
}

// ======================================================================= homes

type slot struct {
	name, typ   string
	area, minW  float64
	fixedW      float64
	pin         int     // 0 flexible, 1 front band, 2 back band
	share       float64 // multiplier on area when sharing spare width
	link        string  // opening to the hall: door, cased, passage ("" = reached through its open-plan group)
	group       string  // rooms in a group stay side by side with no wall between
	tag         string
	beds        int
	bedSize     string
	tub, double bool
	washers     int
}

func (s slot) minWidth() float64 {
	if s.fixedW > 0 {
		return s.fixedW
	}
	return s.minW
}

type homePreset struct{ df, hall, db float64 }

func homePresets(p Program) []homePreset {
	var ps []homePreset
	switch p.HousingType {
	case "tiny-home":
		ps = []homePreset{{3.6, 1.0, 3.4}, {3.2, 1.0, 3.0}, {4.2, 1.0, 3.8}}
	case "mansion":
		ps = []homePreset{{6.0, 1.6, 5.6}, {5.4, 1.6, 5.0}, {7.0, 1.8, 6.4}}
	case "villa":
		ps = []homePreset{{5.6, 1.4, 5.2}, {5.0, 1.4, 4.6}, {6.4, 1.4, 5.8}}
	default:
		ps = []homePreset{{5.0, 1.2, 4.6}, {4.4, 1.2, 4.0}, {6.0, 1.2, 5.4}}
	}
	for i := range ps {
		if p.GarageCars > 0 {
			ps[i].df = math.Max(ps[i].df, 6.4)
		}
		if p.Floors > 1 || p.Basement {
			ps[i].db = math.Max(ps[i].db, 3.4)
		}
		if p.Accessible {
			ps[i].hall = 1.5
		}
	}
	return ps
}

// homeLevels lists the rooms of one home, level by level (basement first).
func homeLevels(p Program) ([][]slot, []string) {
	A, F, B := p.AreaM2, p.Floors, p.Bedrooms
	tiny := p.HousingType == "tiny-home"
	mansion, villa := p.HousingType == "mansion", p.HousingType == "villa"
	full := int(math.Floor(p.Bathrooms))
	half := int(math.Round((p.Bathrooms - float64(full)) * 2))
	mx := math.Max
	deck := contains(p.Extras, "deck")

	liv := slot{name: "Living room", typ: "living", area: mx(14, 0.2*A), minW: 3.4, link: "cased", share: 1, tag: "living"}
	din := slot{name: "Dining room", typ: "dining", area: mx(8, 0.09*A), minW: 2.8, link: "cased", share: 1, group: "kd", tag: "dining"}
	kit := slot{name: "Kitchen", typ: "kitchen", area: mx(8, 0.11*A), minW: 2.6, share: 1, group: "kd", tag: "kitchen"}
	ent := slot{name: "Entry", typ: "entry", area: 4, minW: 1.8, link: "cased", share: 0.3, pin: 1, tag: "entry"}
	if tiny {
		liv.area, liv.minW, liv.group, liv.pin = mx(10, 0.3*A), 3.0, "lk", 1
		kit.area, kit.minW, kit.group = mx(5, 0.15*A), 2.2, "lk"
	}
	if F == 1 && deck && !tiny {
		liv.pin = 2 // the deck goes behind the living room
	}
	if villa {
		// A villa lives round one big living room that opens onto the terrace behind it.
		liv.area, liv.pin = mx(20, 0.24*A), 2
	}
	bedroom := func(i int) slot {
		s := slot{name: fmt.Sprintf("Bedroom %d", i+1), typ: "bedroom", area: mx(9, 0.10*A), minW: 2.8, link: "door",
			share: 1, beds: 1, bedSize: "queen"}
		if i == 0 {
			s.name, s.area, s.minW, s.bedSize = "Primary bedroom", mx(11, 0.14*A), 3.2, "king"
			if B == 1 {
				s.name = "Bedroom"
			}
			if tiny {
				s.area, s.minW, s.bedSize = mx(7, 0.2*A), 2.6, "full"
			}
		}
		return s
	}
	bath := func(n int, primary bool) slot {
		s := slot{name: "Bath", typ: "bath", area: 5, minW: 1.8, link: "door", share: 0.4, tub: !primary}
		if n > 1 {
			s.name = fmt.Sprintf("Bath %d", n)
		}
		if primary {
			s.name, s.area, s.double = "Primary bath", 6.5, p.Quality != "essential"
		}
		if tiny {
			s.area, s.minW, s.tub = 3.5, 1.6, false
		}
		return s
	}
	powder := func(n int) slot {
		s := slot{name: "Powder room", typ: "powder", area: 2.6, minW: 1.3, link: "door", share: 0.2}
		if n > 1 {
			s.name = fmt.Sprintf("Powder room %d", n)
		}
		return s
	}
	laundry := slot{name: "Laundry", typ: "laundry", area: 4.5, minW: 1.8, link: "door", share: 0.4, washers: 1}
	office := slot{name: "Office", typ: "office", area: 8, minW: 2.4, link: "door", share: 1}
	stair := slot{name: "Stair", typ: "stair", fixedW: 2.6, link: "passage", pin: 2, tag: "stair"}
	elev := slot{name: "Elevator", typ: "elevator", fixedW: 2.1, link: "door", pin: 2, tag: "elevator"}
	garage := slot{name: "Garage", typ: "garage", fixedW: 3.2 * float64(p.GarageCars), link: "door", pin: 1, tag: "garage"}
	if p.GarageCars == 1 {
		garage.fixedW = 3.6
	}

	var levels [][]slot
	var names []string

	multi := F > 1 || p.Basement || contains(p.Extras, "roof-terrace") // a roof terrace needs a stair up
	elevator := (p.Accessible || mansion) && F >= 3

	// The rooms that make a mansion or villa what it is, by level: the public floor, the ground
	// floor, the basement, and the top floor (or wherever there's room).
	var extraPublic, extraGround, extraBasement, extraUpper []slot
	if mansion {
		extraGround = append(extraGround, slot{name: "Mudroom", typ: "mudroom", area: mx(5, 0.008*A), minW: 2.0, link: "door", share: 0.4, pin: 1})
		extraPublic = append(extraPublic,
			slot{name: "Formal living room", typ: "living", area: mx(20, 0.06*A), minW: 3.8, link: "cased", share: 1},
			slot{name: "Family room", typ: "family", area: mx(20, 0.07*A), minW: 3.8, link: "cased", share: 1},
			slot{name: "Library", typ: "office", area: mx(14, 0.04*A), minW: 3.2, link: "door", share: 0.8},
			slot{name: "Pantry", typ: "pantry", area: 5, minW: 1.8, link: "door", share: 0.3})
		big := []slot{
			{name: "Media room", typ: "family", area: mx(20, 0.035*A), minW: 3.8, link: "door", share: 0.8},
			{name: "Gym", typ: "gym", area: mx(16, 0.03*A), minW: 3.4, link: "door", share: 0.6}}
		if A >= 550 {
			switch {
			case p.Basement:
				extraBasement = append(extraBasement, big...)
			case F > 1:
				extraUpper = append(extraUpper, big...)
			default:
				extraPublic = append(extraPublic, big...)
			}
		}
		if p.Basement {
			extraBasement = append(extraBasement, slot{name: "Wine cellar", typ: "storage", area: 8, minW: 2.2, link: "door", share: 0.3})
		}
	}
	if villa {
		extraPublic = append(extraPublic, slot{name: "Pantry", typ: "pantry", area: 4, minW: 1.6, link: "door", share: 0.3})
		if !contains(p.Extras, "office") {
			extraPublic = append(extraPublic, slot{name: "Study", typ: "office", area: mx(9, 0.04*A), minW: 2.8, link: "door", share: 0.6})
		}
		if A >= 250 {
			extraPublic = append(extraPublic, slot{name: "Family room", typ: "family", area: mx(16, 0.06*A), minW: 3.4, link: "cased", share: 1})
		}
	}
	if p.Basement {
		lv := []slot{
			{name: "Family room", typ: "family", area: mx(16, 0.15*A), minW: 3.0, link: "cased", share: 1, tag: "family"},
			{name: "Storage", typ: "storage", area: 8, minW: 1.8, link: "door", share: 0.5},
			stair,
			{name: "Mechanical", typ: "mechanical", area: 6, minW: 1.8, link: "door", share: 0.5}}
		if elevator {
			lv = append(lv, elev)
		}
		lv = append(lv, extraBasement...)
		levels = append(levels, lv)
		names = append(names, "Basement")
	}

	// Which level holds the living spaces, and which hold bedrooms. Homes of 3+
	// floors put garage/entry on the ground, living on floor 2, bedrooms above.
	publicLvl := 0
	if F >= 3 && !tiny {
		publicLvl = 1
	}
	var bedLevels []int
	switch {
	case F == 1:
		bedLevels = []int{0}
	case publicLvl == 1:
		for lvl := 2; lvl < F; lvl++ {
			bedLevels = append(bedLevels, lvl)
		}
	default:
		for lvl := 1; lvl < F; lvl++ {
			bedLevels = append(bedLevels, lvl)
		}
	}
	bedsAt := make([][]slot, F)
	for i := 0; i < B; i++ {
		lvl := bedLevels[i%len(bedLevels)]
		bedsAt[lvl] = append(bedsAt[lvl], bedroom(i))
	}
	bathsAt := make([][]slot, F)
	remaining, n := full, 0
	nextBath := func(primary bool) slot { n++; return bath(n, primary) }
	if F == 1 {
		for remaining > 0 {
			bathsAt[0] = append(bathsAt[0], nextBath(remaining == full && full > 1))
			remaining--
		}
	} else {
		for _, lvl := range bedLevels {
			if remaining > 0 {
				bathsAt[lvl] = append(bathsAt[lvl], nextBath(false))
				remaining--
			}
		}
		if remaining > 0 {
			bathsAt[bedLevels[0]] = append([]slot{nextBath(true)}, bathsAt[bedLevels[0]]...)
			remaining--
		}
		// A mansion or villa gives its bedrooms their own baths before the public floor gets more.
		for (mansion || villa) && remaining > 0 {
			placed := false
			for _, lvl := range bedLevels {
				if remaining > 0 && len(bathsAt[lvl]) < len(bedsAt[lvl]) {
					bathsAt[lvl] = append(bathsAt[lvl], nextBath(false))
					remaining--
					placed = true
				}
			}
			if !placed {
				break
			}
		}
		for remaining > 0 {
			bathsAt[publicLvl] = append(bathsAt[publicLvl], nextBath(false))
			remaining--
		}
	}

	for lvl := 0; lvl < F; lvl++ {
		var lv []slot
		if lvl > 0 || multi {
			if multi {
				lv = append(lv, stair)
				if elevator {
					lv = append(lv, elev)
				}
			}
		}
		if lvl == 0 {
			if !tiny {
				lv = append(lv, ent)
			}
			if p.GarageCars > 0 {
				lv = append(lv, garage)
			}
			if !tiny {
				lv = append(lv, laundry)
			}
			if contains(p.Extras, "office") {
				lv = append(lv, office)
			}
			lv = append(lv, extraGround...)
		}
		if lvl == F-1 && lvl != publicLvl {
			lv = append(lv, extraUpper...)
		} else if lvl == publicLvl && F == 1 {
			lv = append(lv, extraUpper...)
		}
		if lvl == publicLvl {
			if tiny {
				lv = append(lv, liv, kit)
			} else {
				lv = append(lv, liv, din, kit)
			}
			for i := 0; i < half; i++ {
				lv = append(lv, powder(i+1))
			}
			lv = append(lv, extraPublic...)
		}
		if lvl != 0 && lvl != publicLvl && len(bedsAt[lvl]) == 0 {
			name := "Family room"
			if tiny {
				name = "Loft"
			}
			lv = append(lv, slot{name: name, typ: "family", area: mx(10, 0.1*A), minW: 3.0, link: "cased", share: 1})
		}
		lv = append(lv, bedsAt[lvl]...)
		lv = append(lv, bathsAt[lvl]...)
		levels = append(levels, lv)
		if lvl == 0 {
			names = append(names, "Ground floor")
		} else {
			names = append(names, fmt.Sprintf("Floor %d", lvl+1))
		}
	}
	return levels, names
}

// balance splits a level's rooms into the front and back bands, keeping each
// open-plan group together and the two bands about the same width.
func balance(lv []slot) (front, back []slot) {
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
				g.slots = append(g.slots, s)
				g.w += s.minWidth()
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
	fw, bw := 0.0, 0.0
	var fg, bg []*grp
	for _, g := range groups {
		switch g.pin {
		case 1:
			fg, fw = append(fg, g), fw+g.w
		case 2:
			bg, bw = append(bg, g), bw+g.w
		}
	}
	var flex []*grp
	for _, g := range groups {
		if g.pin == 0 {
			flex = append(flex, g)
		}
	}
	sort.SliceStable(flex, func(i, j int) bool { return flex[i].w > flex[j].w })
	for _, g := range flex {
		if fw <= bw {
			fg, fw = append(fg, g), fw+g.w
		} else {
			bg, bw = append(bg, g), bw+g.w
		}
	}
	// order: entry first in front, garage last; stair/elevator first at the back
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
	sort.SliceStable(fg, func(i, j int) bool { return rank(fg[i]) < rank(fg[j]) })
	sort.SliceStable(bg, func(i, j int) bool { return rank(bg[i]) < rank(bg[j]) })
	for _, g := range fg {
		front = append(front, g.slots...)
	}
	for _, g := range bg {
		back = append(back, g.slots...)
	}
	return
}

// bandWidths gives each room its minimum width and shares the rest by area.
func bandWidths(slots []slot, w float64) []float64 {
	ws := make([]float64, len(slots))
	sum, wsum := 0.0, 0.0
	for i, s := range slots {
		ws[i] = s.minWidth()
		sum += ws[i]
		if s.fixedW == 0 {
			wsum += s.area * s.share
		}
	}
	spare := w - sum
	if spare > 0 && wsum > 0 {
		for i, s := range slots {
			if s.fixedW == 0 {
				ws[i] += spare * s.area * s.share / wsum
			}
		}
	}
	return ws
}

func withFiller(band []slot, front bool) []slot {
	for _, s := range band {
		if s.fixedW == 0 && s.share > 0 {
			return band
		}
	}
	f := slot{name: "Storage", typ: "storage", area: 4, minW: 1.6, link: "door", share: 1}
	if front {
		f.pin = 1
	}
	return append(band, f)
}

func layoutHomes(p Program, variant int) (*Layout, error) {
	presets := homePresets(p)
	if variant >= len(presets) {
		return nil, ErrNoPreset
	}
	ps := presets[variant]
	levels, names := homeLevels(p)
	D := ps.df + ps.hall + ps.db

	type bands struct{ front, back []slot }
	split := make([]bands, len(levels))
	need := 0.0
	garageArea := 0.0
	for i, lv := range levels {
		f, b := balance(lv)
		f, b = withFiller(f, true), withFiller(b, false)
		split[i] = bands{f, b}
		fw, bw := 0.0, 0.0
		for _, s := range f {
			fw += s.minWidth()
			if s.typ == "garage" {
				garageArea = s.fixedW * ps.df
			}
		}
		for _, s := range b {
			bw += s.minWidth()
		}
		need = math.Max(need, math.Max(fw, bw))
	}
	perFloor := p.AreaM2 / float64(p.Floors)
	wu := math.Max(need, (perFloor+garageArea)/D)
	wu = math.Ceil(wu*10) / 10

	n := 1
	switch p.HousingType {
	case "townhouse":
		n = p.UnitCount
	case "duplex":
		n = 2
	}
	l := &Layout{W: wu * float64(n), D: D, GarageCars: p.GarageCars * n, Basement: p.Basement}
	if need > (perFloor+garageArea)/D*1.15 {
		l.Cautions = append(l.Cautions, fmt.Sprintf("Minimum room sizes make each home about %.0f m², more than the %.0f m² asked for.",
			wu*D*float64(p.Floors)-garageArea, p.AreaM2))
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

	for u := 0; u < n; u++ {
		unitID, unitName, kind := "U-1", "The house", "house"
		switch p.HousingType {
		case "townhouse":
			unitID, unitName, kind = fmt.Sprintf("U-%d", u+1), fmt.Sprintf("Townhome %d", u+1), "townhome"
		case "duplex":
			letter := string(rune('A' + u))
			unitID, unitName, kind = "U-"+letter, "Home "+letter, bedKind(p.Bedrooms)
		}
		x0 := float64(u) * wu
		var stairRooms, elevRooms []*LRoom
		entryDone := false
		for li := range levels {
			hall := l.add(li, "Hall", "hall", unitID, Rect{x0, ps.df, x0 + wu, ps.df + ps.hall})
			switch {
			case li < base:
				hall.Name = "Basement hall"
			case li > base:
				hall.Name = "Upper hall"
			}
			byTag := map[string]*LRoom{}
			place := func(ss []slot, y0, y1 float64) {
				ws := bandWidths(ss, wu)
				x := x0
				var prev *LRoom
				var prevGroup string
				for i, s := range ss {
					r := Rect{x, y0, x + ws[i], y1}
					if i == len(ss)-1 {
						r.X1 = x0 + wu
					}
					x += ws[i]
					rm := l.add(li, s.name, s.typ, unitID, r)
					rm.Beds, rm.BedSize, rm.Tub, rm.DoubleVanity, rm.Washers = s.beds, s.bedSize, s.tub, s.double, s.washers
					if s.tag != "" {
						byTag[s.tag] = rm
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
						rm.Links = append(rm.Links, Link{To: hall.Key, Kind: s.link, Width: openingWidth(s.link, r.W(), p.Accessible)})
					}
					prev, prevGroup = rm, s.group
				}
			}
			place(split[li].front, 0, ps.df)
			place(split[li].back, ps.df+ps.hall, D)

			publicLvl := base
			if p.Floors >= 3 && p.HousingType != "tiny-home" {
				publicLvl = base + 1
			}
			if li == publicLvl && contains(p.Extras, "deck") {
				var target *LRoom
				for _, t := range []string{"living", "family", "dining", "kitchen", "bedroom", "office"} {
					for _, rm := range l.Levels[li].Rooms {
						if target == nil && rm.Unit == unitID && rm.Type == t && near(rm.R.Y1, D) && rm.R.W() >= 2.4 {
							target = rm
						}
					}
				}
				if target != nil {
					w := math.Min(4.0, target.R.W()-0.4)
					cx := (target.R.X0 + target.R.X1) / 2
					l.Balconies = append(l.Balconies, LBalcony{Level: li, R: Rect{cx - w/2, D, cx + w/2, D + 3.0},
						Unit: unitID, Room: target.Key, Railing: "metal"})
					target.Links = append(target.Links, Link{Kind: "patio", Width: math.Min(1.8, w-0.2), Side: 'N', At: cx})
				} else if u == 0 {
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
				if contains(p.Extras, "porch") && u == 0 {
					l.Porch = &Rect{0, -2.2, math.Min(wu, 8.0), 0}
				}
			}
			if li > base && contains(p.Extras, "balconies") {
				for _, rm := range l.Levels[li].Rooms {
					if rm.Unit == unitID && rm.Type == "bedroom" && rm.R.W() >= 2.4 && (rm.R.Y0 == 0 || near(rm.R.Y1, D)) {
						w := math.Min(3.0, rm.R.W()-0.4)
						cx := (rm.R.X0 + rm.R.X1) / 2
						side, r := byte('S'), Rect{cx - w/2, -1.5, cx + w/2, 0}
						if near(rm.R.Y1, D) {
							side, r = 'N', Rect{cx - w/2, D, cx + w/2, D + 1.5}
						}
						l.Balconies = append(l.Balconies, LBalcony{Level: li, R: r, Unit: unitID, Room: rm.Key, Railing: "glass"})
						rm.Links = append(rm.Links, Link{Kind: "patio", Width: math.Min(1.6, w-0.2), Side: side, At: cx})
						break
					}
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
		l.Units = append(l.Units, LUnit{unitID, unitName, kind, p.Bedrooms, p.Bathrooms})
	}
	if l.Porch != nil && (p.HousingType == "townhouse" || p.HousingType == "duplex") {
		l.Porch.X1 = l.W
	}
	return l, nil
}

func bedKind(b int) string {
	switch {
	case b <= 0:
		return "studio"
	case b >= 4:
		return "4-bed"
	}
	return fmt.Sprintf("%d-bed", b)
}

func openingWidth(kind string, roomW float64, accessible bool) float64 {
	w := 0.85
	switch kind {
	case "cased":
		w = 1.4
	case "passage":
		w = 1.0
	}
	if accessible && kind == "door" {
		w = 0.9
	}
	return math.Min(w, roomW-0.3)
}

func entryWidth(accessible bool) float64 {
	if accessible {
		return 1.0
	}
	return 0.95
}

// ======================================================================= corridor buildings

type module struct {
	kind    string // unit, dorm, suite, sharedbath, lobby, common, stairA, stairB, elevator
	width   float64
	minW    float64
	unit    *aptUnit
	name    string
	typ     string
	stretch bool
}

type aptUnit struct {
	kind  string // studio, 1-bed, 2-bed, 3-bed
	beds  int
	baths int
	area  float64
}

func corridorDepths(p Program) []float64 {
	switch {
	case p.HousingType == "hotel":
		return []float64{8.0, 8.8, 7.4}
	case p.HousingType != "dorm":
		return []float64{8.4, 9.4, 7.8}
	case p.BathroomSharing == "suite":
		return []float64{6.6, 7.4}
	default:
		return []float64{4.8, 5.6}
	}
}

func layoutCorridor(p Program, variant int) (*Layout, error) {
	depths := corridorDepths(p)
	if variant >= len(depths) {
		return nil, ErrNoPreset
	}
	du := depths[variant]
	cw := 1.8
	if p.Accessible {
		cw = 2.0
	}
	D := 2*du + cw
	F := p.Floors
	elevator := F >= 4 || (F >= 3 && p.Accessible)

	// ---- modules to place
	var mods []module
	switch p.HousingType {
	case "dorm":
		mods = dormModules(p, du)
	case "hotel":
		mods = hotelModules(p)
	default:
		mods = aptModules(p, du)
	}
	var commons []module
	commons = append(commons, module{kind: "lobby", width: 6.5, name: "Lobby", typ: "lobby", stretch: true})
	cmap := map[string]module{
		"lounge":       {kind: "common", width: 6, name: "Lounge", typ: "lounge"},
		"study":        {kind: "common", width: 5, name: "Study room", typ: "study"},
		"gym":          {kind: "common", width: 6, name: "Gym", typ: "gym"},
		"laundry":      {kind: "common", width: 4, name: "Laundry room", typ: "shared-laundry"},
		"kitchen":      {kind: "common", width: 6, name: "Shared kitchen", typ: "shared-kitchen"},
		"bike-storage": {kind: "common", width: 4, name: "Bike storage", typ: "bike-storage"},
		"mail":         {kind: "common", width: 2.6, name: "Mail room", typ: "mail"},
		"restaurant":   {kind: "common", width: 9, name: "Restaurant", typ: "dining"},
	}
	if p.HousingType == "hotel" {
		cmap["laundry"] = module{kind: "common", width: 4, name: "Housekeeping", typ: "shared-laundry"}
		cmap["kitchen"] = module{kind: "common", width: 6, name: "Kitchen", typ: "shared-kitchen"}
		commons[0].name = "Lobby and front desk"
	}
	for _, c := range p.CommonSpaces {
		if m, ok := cmap[c]; ok {
			m.stretch = true
			commons = append(commons, m)
			// A hotel restaurant has its own kitchen beside it.
			if c == "restaurant" && p.HousingType == "hotel" && !contains(p.CommonSpaces, "kitchen") {
				k := cmap["kitchen"]
				k.stretch = true
				commons = append(commons, k)
			}
		}
	}
	coreW := 2.8
	if elevator {
		coreW += 2.6
	}
	stairB := F >= 4 || roomsNotHomes(p.HousingType) || len(mods)/F > 8
	endW := 0.0
	if stairB {
		endW = 2.8
	}
	groundFront := 0.0
	for _, c := range commons {
		groundFront += c.width
	}
	total := groundFront
	maxMod := 0.0
	for _, m := range mods {
		total += m.width
		maxMod = math.Max(maxMod, m.width)
	}
	total += float64(F) * (coreW + endW)
	W := math.Max(total/float64(2*F), math.Max(coreW+endW+maxMod, maxMod))
	W = math.Max(W, groundFront/2)

	type band struct {
		mods      []module
		used, cap float64
	}
	var floors [][2]*band
	for tries := 0; ; tries++ {
		if tries > 200 {
			return nil, fmt.Errorf("couldn't arrange %d units on %d floors", len(mods), F)
		}
		floors = make([][2]*band, F)
		for f := 0; f < F; f++ {
			floors[f] = [2]*band{{cap: W}, {cap: W - coreW - endW}}
		}
		// ground floor: lobby and common rooms in front, spilling to the back
		for _, c := range commons {
			b := floors[0][0]
			if b.used+c.width > b.cap {
				b = floors[0][1]
			}
			b.mods = append(b.mods, c)
			b.used += c.width
		}
		if floors[0][0].used > W || floors[0][1].used > floors[0][1].cap {
			W *= 1.05
			continue
		}
		ok := true
		f := 0
		for _, m := range mods {
			for {
				if f >= F {
					ok = false
					break
				}
				fb, bb := floors[f][0], floors[f][1]
				target := fb
				if bb.cap-bb.used > fb.cap-fb.used {
					target = bb
				}
				if target.used+m.width <= target.cap+1e-9 {
					target.mods = append(target.mods, m)
					target.used += m.width
					break
				}
				f++
			}
			if !ok {
				break
			}
		}
		if ok {
			break
		}
		W *= 1.04
	}
	// spread modules across floors more evenly: if the top floors are empty, the
	// building is wider than it needs to be; shrink W while it still works
	W = math.Ceil(W*10) / 10

	l := &Layout{W: W, D: D}
	for f := 0; f < F; f++ {
		h := 3.1
		elev := 0.0
		if f > 0 {
			elev = 4.0 + float64(f-1)*3.1
		} else {
			h = 4.0
		}
		name := "Ground floor"
		if f > 0 {
			name = fmt.Sprintf("Floor %d", f+1)
		}
		l.Levels = append(l.Levels, &LLevel{Index: f, Name: name, Elev: elev, Height: h})
	}
	var stairA, stairBk [][]*LRoom
	var elevRooms []*LRoom
	unitN := map[int]int{}
	for f := 0; f < F; f++ {
		corr := l.add(f, "Corridor", "corridor", "", Rect{0, du, W, du + cw})
		// back band: core at the left, optional second stair at the right
		x := 0.0
		y0 := du + cw
		st := l.add(f, "Stair A", "stair", "", Rect{0, y0, 2.8, y0 + 3.4})
		st.Links = append(st.Links, Link{To: corr.Key, Kind: "passage", Width: 1.2})
		trash := l.add(f, "Trash room", "trash", "", Rect{0, y0 + 3.4, 2.8, D})
		trash.Links = append(trash.Links, Link{To: st.Key, Kind: "door", Width: 0.85})
		stairA = append(stairA, []*LRoom{st})
		x = 2.8
		if elevator {
			el := l.add(f, "Elevator", "elevator", "", Rect{x, y0, x + 2.6, y0 + 2.2})
			el.Links = append(el.Links, Link{To: corr.Key, Kind: "door", Width: 1.0})
			mech := l.add(f, "Mechanical", "mechanical", "", Rect{x, y0 + 2.2, x + 2.6, D})
			mech.Links = append(mech.Links, Link{To: trash.Key, Kind: "door", Width: 0.85})
			elevRooms = append(elevRooms, el)
			x += 2.6
		}
		bands := floors[f]
		// stretch modules to fill each band exactly
		for bi, b := range bands {
			avail := W
			start := 0.0
			if bi == 1 {
				avail = W - x - endW
				start = x
			}
			fillBandMods(b.mods, &b.mods, avail)
			var yA, yB float64
			if bi == 0 {
				yA, yB = 0, du
			} else {
				yA, yB = du+cw, D
			}
			cx := start
			for _, m := range b.mods {
				r := Rect{cx, yA, cx + m.width, yB}
				cx += m.width
				placeModule(l, p, f, m, r, bi == 0, corr, unitN)
			}
		}
		if stairB {
			sb := l.add(f, "Stair B", "stair", "", Rect{W - 2.8, y0, W, y0 + 3.4})
			sb.Links = append(sb.Links, Link{To: corr.Key, Kind: "passage", Width: 1.2})
			m := l.add(f, "Mechanical", "mechanical", "", Rect{W - 2.8, y0 + 3.4, W, D})
			m.Links = append(m.Links, Link{To: sb.Key, Kind: "door", Width: 0.85})
			stairBk = append(stairBk, []*LRoom{sb})
		}
	}
	for _, list := range [][][]*LRoom{stairA, stairBk} {
		for f := 0; f+1 < len(list); f++ {
			l.Stairs = append(l.Stairs, LStair{R: list[f][0].R, From: f, To: f + 1, Access: "front", Shape: "switchback"})
		}
	}
	if elevator {
		var lv []int
		for i := range elevRooms {
			lv = append(lv, i)
		}
		l.Elevators = append(l.Elevators, LElevator{R: elevRooms[0].R, Levels: lv, DoorSide: "front"})
	}
	if p.HousingType == "dorm" {
		l.Residents = p.Residents
	}
	return l, nil
}

// fillBandMods stretches the band's modules to exactly fill avail, adding a
// shared common room if there's too much spare width.
func fillBandMods(mods []module, out *[]module, avail float64) {
	used := 0.0
	stretchW := 0.0
	for _, m := range mods {
		used += m.width
		if m.stretch {
			stretchW += m.width
		}
	}
	spare := avail - used
	if spare <= 1e-6 {
		return
	}
	if stretchW > 0 && spare <= stretchW*0.35 {
		for i := range mods {
			if mods[i].stretch {
				mods[i].width += spare * mods[i].width / stretchW
			}
		}
		*out = mods
		return
	}
	if spare < 2.4 && len(mods) > 0 {
		// too narrow for its own room: give it to the last module
		mods[len(mods)-1].width += spare
		*out = mods
		return
	}
	*out = append(mods, module{kind: "common", width: spare, name: "Common room", typ: "common"})
}

func aptModules(p Program, du float64) []module {
	base := map[string]float64{"studio": 40, "1-bed": 60, "2-bed": 85, "3-bed": 110}
	order := []struct {
		key, kind string
		beds      int
	}{{"threeBed", "3-bed", 3}, {"twoBed", "2-bed", 2},
		{"oneBed", "1-bed", 1}, {"studio", "studio", 0}}
	total, n := 0.0, 0
	for _, o := range order {
		total += base[o.kind] * float64(p.UnitMix[o.key])
		n += p.UnitMix[o.key]
	}
	scale := 1.0
	if n > 0 && total > 0 && p.AreaM2 > 0 {
		scale = p.AreaM2 / (total / float64(n))
	}
	var mods []module
	// interleave kinds so floors get a mix
	counts := map[string]int{}
	for _, o := range order {
		counts[o.key] = p.UnitMix[o.key]
	}
	for len(mods) < n {
		for _, o := range order {
			if counts[o.key] == 0 {
				continue
			}
			counts[o.key]--
			baths := 1
			if o.beds >= 2 && (p.Bathrooms >= 2 || o.beds >= 3) {
				baths = 2
			}
			u := &aptUnit{kind: o.kind, beds: o.beds, baths: baths, area: base[o.kind] * scale}
			minW := aptMinWidth(u)
			w := math.Max(minW, u.area/du)
			mods = append(mods, module{kind: "unit", width: math.Ceil(w*10) / 10, minW: minW, unit: u, stretch: true})
		}
	}
	return mods
}

func aptMinWidth(u *aptUnit) float64 {
	segA := 1.6 + 2.6 + 1.8*float64(u.baths)
	segC := 3.4 + 2.8*float64(u.beds)
	return math.Max(segA, segC)
}

// hotelModules is one module per guest room: a king room, a two-queen room or a suite.
func hotelModules(p Program) []module {
	w := map[string]float64{"single": 3.8, "double": 4.2, "suite": 7.0}[p.RoomType]
	if w == 0 {
		w = 3.8
	}
	var mods []module
	for i := 0; i < p.UnitCount; i++ {
		mods = append(mods, module{kind: "guest", width: w, stretch: true})
	}
	return mods
}

func dormModules(p Program, du float64) []module {
	var mods []module
	r := p.Residents
	switch p.BathroomSharing {
	case "suite":
		suites := int(math.Ceil(float64(r) / 4))
		for i := 0; i < suites; i++ {
			mods = append(mods, module{kind: "suite", width: 4*2.8 + 2.4, stretch: true})
		}
	default:
		per := 1
		w := 2.8
		if p.RoomType == "double" {
			per, w = 2, 3.8
		}
		rooms := int(math.Ceil(float64(r) / float64(per)))
		if p.BathroomSharing == "private" {
			w += 1.8
		}
		for i := 0; i < rooms; i++ {
			mods = append(mods, module{kind: "dorm", width: w, stretch: true})
			if p.BathroomSharing == "hall" && (i+1)%(8/per) == 0 {
				mods = append(mods, module{kind: "sharedbath", width: 3.2})
			}
		}
		if p.BathroomSharing == "hall" && rooms%(8/per) != 0 {
			mods = append(mods, module{kind: "sharedbath", width: 3.2})
		}
	}
	return mods
}

// placeModule draws one module's rooms inside rectangle r. front: the module is
// in the front band (corridor at its high-y side).
func placeModule(l *Layout, p Program, f int, m module, r Rect, front bool, corr *LRoom, unitN map[int]int) {
	// segments measured from the corridor side outward
	seg := func(from, to float64) Rect {
		if front {
			return Rect{r.X0, r.Y1 - to, r.X1, r.Y1 - from}
		}
		return Rect{r.X0, r.Y0 + from, r.X1, r.Y0 + to}
	}
	split := func(band Rect, widths []float64) []Rect {
		var out []Rect
		x := band.X0
		for i, w := range widths {
			rr := Rect{x, band.Y0, x + w, band.Y1}
			if i == len(widths)-1 {
				rr.X1 = band.X1
			}
			out = append(out, rr)
			x += w
		}
		return out
	}
	share := func(total float64, mins []float64, weights []float64) []float64 {
		ws := append([]float64{}, mins...)
		spare := total
		ws2 := 0.0
		for i := range mins {
			spare -= mins[i]
			ws2 += weights[i]
		}
		for i := range ws {
			ws[i] += spare * weights[i] / ws2
		}
		return ws
	}
	d := r.D()
	switch m.kind {
	case "lobby", "common":
		rm := l.add(f, m.name, m.typ, "", r)
		kind := "door"
		w := 0.9
		if m.typ == "lobby" {
			kind, w = "cased", 1.8
			rm.Links = append(rm.Links, Link{Kind: "entry", Width: 1.8, Side: 'S', At: -1})
		}
		rm.Links = append(rm.Links, Link{To: corr.Key, Kind: kind, Width: math.Min(w, r.W()-0.4)})
		if m.typ == "shared-laundry" {
			rm.Washers = 2
		}
	case "guest":
		// A hotel room: an entry with the bath beside it on the corridor side, then the bedroom
		// (with a sitting room beside it in a suite). Numbered by floor: 101, 102...
		unitN[f]++
		num := fmt.Sprintf("%d%02d", f+1, unitN[f])
		segA, segC := seg(0, 2.6), seg(2.6, d)
		bw := math.Min(2.4, segA.W()-1.2)
		as := split(segA, []float64{segA.W() - bw, bw})
		ent := l.add(f, "Room "+num+" entry", "entry", "", as[0])
		ent.Links = append(ent.Links, Link{To: corr.Key, Kind: "door", Width: math.Min(entryWidth(p.Accessible), as[0].W()-0.3)})
		b := l.add(f, "Room "+num+" bath", "bath", "", as[1])
		b.Tub = p.RoomType != "single"
		b.Links = append(b.Links, Link{To: ent.Key, Kind: "door", Width: openingWidth("door", as[1].W(), p.Accessible)})
		bedR := segC
		var sit *LRoom
		if p.RoomType == "suite" {
			cs := split(segC, share(segC.W(), []float64{3.0, 3.4}, []float64{1, 1}))
			sit = l.add(f, "Suite "+num+" sitting room", "living", "", cs[0])
			sit.Links = append(sit.Links, Link{To: ent.Key, Kind: "cased", Width: math.Min(1.2, cs[0].W()-0.4)})
			bedR = cs[1]
		}
		name := "Room " + num
		if p.RoomType == "suite" {
			name = "Suite " + num
		}
		room := l.add(f, name, "bedroom", "", bedR)
		room.Beds, room.BedSize = 1, "king"
		if p.RoomType == "double" {
			room.Beds, room.BedSize = 2, "queen"
		}
		room.Links = append(room.Links, Link{To: ent.Key, Kind: "cased", Width: math.Min(1.0, bedR.W()-0.4)})
		if sit != nil {
			// The bedroom also opens from the sitting room.
			room.Links = append(room.Links, Link{To: sit.Key, Kind: "door", Width: 0.9})
		}
	case "sharedbath":
		rm := l.add(f, "Shared bath", "shared-bath", "", r)
		rm.Links = append(rm.Links, Link{To: corr.Key, Kind: "door", Width: 0.9})
	case "dorm":
		beds := 1
		if p.RoomType == "double" {
			beds = 2
		}
		if p.BathroomSharing == "private" {
			rw := r.W() - 1.8
			room := l.add(f, "Dorm room", "dorm-room", "", Rect{r.X0, r.Y0, r.X0 + rw, r.Y1})
			room.Beds, room.BedSize = beds, "twin"
			room.Links = append(room.Links, Link{To: corr.Key, Kind: "door", Width: 0.9})
			b := l.add(f, "Bath", "bath", "", Rect{r.X0 + rw, r.Y0, r.X1, r.Y1})
			b.Links = append(b.Links, Link{To: room.Key, Kind: "door", Width: 0.8})
		} else {
			room := l.add(f, "Dorm room", "dorm-room", "", r)
			room.Beds, room.BedSize = beds, "twin"
			room.Links = append(room.Links, Link{To: corr.Key, Kind: "door", Width: 0.9})
		}
	case "suite":
		common := l.add(f, "Suite common room", "suite-common", "", seg(0, 2.4))
		common.Links = append(common.Links, Link{To: corr.Key, Kind: "door", Width: 0.9})
		back := seg(2.4, d)
		ws := share(back.W(), []float64{2.8, 2.8, 2.4, 2.8, 2.8}, []float64{1, 1, 0.3, 1, 1})
		rs := split(back, ws)
		for i, rr := range rs {
			if i == 2 {
				b := l.add(f, "Suite bath", "shared-bath", "", rr)
				b.Links = append(b.Links, Link{To: common.Key, Kind: "door", Width: 0.8})
				continue
			}
			room := l.add(f, "Dorm room", "dorm-room", "", rr)
			room.Beds, room.BedSize = 1, "twin"
			room.Links = append(room.Links, Link{To: common.Key, Kind: "door", Width: 0.85})
		}
	case "unit":
		u := m.unit
		unitN[f]++
		id := fmt.Sprintf("U-%d%s", f+1, string(rune('A'+unitN[f]-1)))
		if unitN[f] > 26 {
			id = fmt.Sprintf("U-%d-%d", f+1, unitN[f])
		}
		name := "Apartment " + id[2:]
		if p.HousingType == "condo" {
			name = "Condo " + id[2:]
		}
		l.Units = append(l.Units, LUnit{ID: id, Name: name, Kind: u.kind, Bedrooms: u.beds, Bathrooms: float64(u.baths)})
		segA, segB, segC := seg(0, 2.6), seg(2.6, 3.7), seg(3.7, d)
		hall := l.add(f, "Hall", "hall", id, segB)
		// A: entry, kitchen, bath(s)
		mins := []float64{1.6, 2.6}
		wts := []float64{0.1, 1}
		for i := 0; i < u.baths; i++ {
			mins, wts = append(mins, 1.8), append(wts, 0.3)
		}
		as := split(segA, share(segA.W(), mins, wts))
		ent := l.add(f, "Entry", "entry", id, as[0])
		ent.Links = append(ent.Links, Link{To: corr.Key, Kind: "entry", Width: entryWidth(p.Accessible), UnitEntry: true},
			Link{To: hall.Key, Kind: "cased", Width: 1.2})
		kit := l.add(f, "Kitchen", "kitchen", id, as[1])
		kit.Links = append(kit.Links, Link{To: hall.Key, Kind: "cased", Width: math.Min(1.4, as[1].W()-0.4)})
		for i := 0; i < u.baths; i++ {
			name := "Bath"
			if u.baths > 1 {
				name = fmt.Sprintf("Bath %d", i+1)
			}
			b := l.add(f, name, "bath", id, as[2+i])
			b.Tub = i == 0
			b.Links = append(b.Links, Link{To: hall.Key, Kind: "door", Width: openingWidth("door", as[2+i].W(), p.Accessible)})
		}
		// C: living, bedrooms
		mins, wts = []float64{3.4}, []float64{1.2}
		for i := 0; i < u.beds; i++ {
			mins, wts = append(mins, 2.8), append(wts, 1)
		}
		cs := split(segC, share(segC.W(), mins, wts))
		liv := l.add(f, "Living room", "living", id, cs[0])
		liv.Links = append(liv.Links, Link{To: hall.Key, Kind: "cased", Width: math.Min(1.6, cs[0].W()-0.4)})
		if u.beds == 0 {
			liv.Beds, liv.BedSize = 1, "queen" // studio: sleeping area in the living room
		}
		for i := 0; i < u.beds; i++ {
			name := fmt.Sprintf("Bedroom %d", i+1)
			if u.beds == 1 {
				name = "Bedroom"
			}
			b := l.add(f, name, "bedroom", id, cs[1+i])
			b.Beds, b.BedSize = 1, map[bool]string{true: "queen", false: "full"}[i == 0]
			b.Links = append(b.Links, Link{To: hall.Key, Kind: "door", Width: openingWidth("door", cs[1+i].W(), p.Accessible)})
		}
		if f > 0 && contains(p.Extras, "balconies") && cs[0].W() >= 2.8 {
			w := math.Min(3.2, cs[0].W()-0.4)
			cx := (cs[0].X0 + cs[0].X1) / 2
			side, br := byte('S'), Rect{cx - w/2, -1.6, cx + w/2, 0}
			if !front {
				side, br = 'N', Rect{cx - w/2, l.D, cx + w/2, l.D + 1.6}
			}
			l.Balconies = append(l.Balconies, LBalcony{Level: f, R: br, Unit: id, Room: liv.Key, Railing: "glass"})
			liv.Links = append(liv.Links, Link{Kind: "patio", Width: math.Min(1.6, w-0.2), Side: side, At: cx})
		}
	}
}
