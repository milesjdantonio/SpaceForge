package main

// Furniture: places items inside each room, against walls where possible,
// keeping door clearances free and items from overlapping.

import (
	"fmt"
	"math"
	"sort"
)

type fitem struct {
	typ           string
	w, d          float64
	h             float64
	size          string
	sink, cooktop bool
	double, wide  bool
}

type placer struct {
	room   Rect
	id     string
	items  []DFurnishing
	occ    []Rect
	margin float64
}

func overlaps(a, b Rect) bool {
	return a.X0 < b.X1-1e-6 && b.X0 < a.X1-1e-6 && a.Y0 < b.Y1-1e-6 && b.Y0 < a.Y1-1e-6
}

func (pl *placer) free(r Rect) bool {
	m := pl.margin - 1e-6
	if r.X0 < pl.room.X0+m || r.Y0 < pl.room.Y0+m || r.X1 > pl.room.X1-m || r.Y1 > pl.room.Y1-m {
		return false
	}
	for _, o := range pl.occ {
		if overlaps(r, o) {
			return false
		}
	}
	return true
}

func (pl *placer) put(it fitem, r Rect, rot float64) Rect {
	f := DFurnishing{Type: it.typ, RoomID: pl.id, X: rd((r.X0 + r.X1) / 2), Y: rd((r.Y0 + r.Y1) / 2),
		W: it.w, D: it.d, RotationDeg: rot}
	t := true
	if it.h > 0 {
		h := it.h
		f.H = &h
	}
	if it.size != "" {
		s := it.size
		f.Size = &s
	}
	if it.sink {
		f.Sink = &t
	}
	if it.cooktop {
		f.Cooktop = &t
	}
	if it.double {
		f.Double = &t
	}
	if it.wide {
		f.Wide = &t
	}
	pl.items = append(pl.items, f)
	pl.occ = append(pl.occ, r)
	return r
}

// sides ordered longest first
func (pl *placer) sides() []byte {
	s := []byte{'S', 'N', 'W', 'E'}
	sort.SliceStable(s, func(i, j int) bool { return sideLen(pl.room, s[i]) > sideLen(pl.room, s[j]) })
	return s
}

func sideLen(r Rect, s byte) float64 {
	if s == 'S' || s == 'N' {
		return r.W()
	}
	return r.D()
}

// wallRect is the footprint of an item with its back against side s, at
// position t along the side; rot is the way its front faces (into the room).
func (pl *placer) wallRect(it fitem, s byte, t float64) (Rect, float64) {
	R, m := pl.room, pl.margin
	switch s {
	case 'S':
		return Rect{t, R.Y0 + m, t + it.w, R.Y0 + m + it.d}, 180
	case 'N':
		return Rect{t, R.Y1 - m - it.d, t + it.w, R.Y1 - m}, 0
	case 'W':
		return Rect{R.X0 + m, t, R.X0 + m + it.d, t + it.w}, 90
	default:
		return Rect{R.X1 - m - it.d, t, R.X1 - m, t + it.w}, 270
	}
}

// againstWall tries each side; centred items start from the middle of the side.
func (pl *placer) againstWall(it fitem, centred bool, sides ...byte) (Rect, byte, bool) {
	if len(sides) == 0 {
		sides = pl.sides()
	}
	for _, s := range sides {
		lo, hi := pl.room.X0+pl.margin, pl.room.X1-pl.margin-it.w
		if s == 'W' || s == 'E' {
			lo, hi = pl.room.Y0+pl.margin, pl.room.Y1-pl.margin-it.w
		}
		if hi < lo-1e-9 {
			continue
		}
		var ts []float64
		if centred {
			mid := (lo + hi) / 2
			for k := 0.0; mid-k >= lo-1e-9 || mid+k <= hi+1e-9; k += 0.1 {
				if mid-k >= lo-1e-9 {
					ts = append(ts, mid-k)
				}
				if k > 0 && mid+k <= hi+1e-9 {
					ts = append(ts, mid+k)
				}
			}
		} else {
			for t := lo; t <= hi+1e-9; t += 0.1 {
				ts = append(ts, t)
			}
			ts = append(ts, hi)
		}
		for _, t := range ts {
			r, rot := pl.wallRect(it, s, t)
			if pl.free(r) {
				pl.put(it, r, rot)
				return r, s, true
			}
		}
	}
	return Rect{}, 0, false
}

// at places a free-standing item centred on (cx, cy).
func (pl *placer) at(it fitem, cx, cy, rot float64) bool {
	w, d := it.w, it.d
	if rot == 90 || rot == 270 {
		w, d = d, w
	}
	r := Rect{cx - w/2, cy - d/2, cx + w/2, cy + d/2}
	if !pl.free(r) {
		return false
	}
	pl.put(it, r, rot)
	return true
}

// inFront returns a point dist metres in front of an item placed against side s.
func inFront(r Rect, s byte, dist float64) (float64, float64) {
	cx, cy := (r.X0+r.X1)/2, (r.Y0+r.Y1)/2
	switch s {
	case 'S':
		return cx, r.Y1 + dist
	case 'N':
		return cx, r.Y0 - dist
	case 'W':
		return r.X1 + dist, cy
	default:
		return r.X0 - dist, cy
	}
}

func opposite(s byte) byte {
	return map[byte]byte{'S': 'N', 'N': 'S', 'W': 'E', 'E': 'W'}[s]
}

var bedDims = map[string][2]float64{"twin": {1.0, 2.0}, "full": {1.4, 1.95}, "queen": {1.6, 2.1}, "king": {1.95, 2.1}}
var bedOrder = []string{"king", "queen", "full", "twin"}

func furnish(r *LRoom, id string, clear []Rect) ([]DFurnishing, error) {
	pl := &placer{room: r.R, id: id, margin: 0.05, occ: append([]Rect{}, clear...)}
	need := func(ok bool, what string) error {
		if !ok {
			return fmt.Errorf("%s (%s, %.1f × %.1f m): no room for the required %s", r.Name, id, r.R.W(), r.R.D(), what)
		}
		return nil
	}
	wallFirst := func(it fitem, sizes ...float64) bool {
		for _, w := range append([]float64{it.w}, sizes...) {
			it.w = w
			if _, _, ok := pl.againstWall(it, false); ok {
				return true
			}
		}
		return false
	}
	bed := func(size string) bool {
		start := 0
		for i, s := range bedOrder {
			if s == size {
				start = i
			}
		}
		for _, s := range bedOrder[start:] {
			d := bedDims[s]
			if br, side, ok := pl.againstWall(fitem{typ: "bed", w: d[0], d: d[1], size: s}, true); ok {
				// nightstands either side (optional)
				ns := fitem{typ: "nightstand", w: 0.5, d: 0.45}
				switch side {
				case 'S', 'N':
					rr, _ := pl.wallRect(ns, side, br.X0-0.55)
					if pl.free(rr) {
						pl.put(ns, rr, map[byte]float64{'S': 180, 'N': 0}[side])
					}
					rr, _ = pl.wallRect(ns, side, br.X1+0.05)
					if pl.free(rr) {
						pl.put(ns, rr, map[byte]float64{'S': 180, 'N': 0}[side])
					}
				}
				return true
			}
		}
		return false
	}
	switch r.Type {
	case "kitchen", "shared-kitchen":
		if err := need(wallFirst(fitem{typ: "counter", w: 1.8, d: 0.6, sink: true}, 1.4, 1.0), "sink counter"); err != nil {
			return nil, err
		}
		if err := need(wallFirst(fitem{typ: "counter", w: 1.8, d: 0.6, cooktop: true}, 1.4, 1.0), "cooktop counter"); err != nil {
			return nil, err
		}
		if err := need(wallFirst(fitem{typ: "fridge", w: 0.8, d: 0.75}, 0.7), "fridge"); err != nil {
			return nil, err
		}
		wallFirst(fitem{typ: "counter", w: 1.2, d: 0.6})
		if r.Type == "shared-kitchen" {
			pl.at(fitem{typ: "dining-table", w: 1.8, d: 0.9}, (r.R.X0+r.R.X1)/2, (r.R.Y0+r.R.Y1)/2, 0)
		}
	case "bath", "shared-bath":
		if err := need(wallFirst(fitem{typ: "toilet", w: 0.5, d: 0.7}), "toilet"); err != nil {
			return nil, err
		}
		v := fitem{typ: "vanity", w: 0.9, d: 0.55}
		if r.DoubleVanity {
			v.w, v.double = 1.5, true
		}
		if !wallFirst(v) {
			v.w, v.double = 0.6, false
			if err := need(wallFirst(v), "vanity"); err != nil {
				return nil, err
			}
		}
		ok := false
		if r.Tub {
			ok = wallFirst(fitem{typ: "bathtub", w: 1.7, d: 0.75}, 1.5)
		}
		if !ok {
			ok = wallFirst(fitem{typ: "shower", w: 0.9, d: 0.9}, 0.8)
		}
		if err := need(ok, "shower or bathtub"); err != nil {
			return nil, err
		}
	case "powder":
		if err := need(wallFirst(fitem{typ: "toilet", w: 0.5, d: 0.7}), "toilet"); err != nil {
			return nil, err
		}
		if err := need(wallFirst(fitem{typ: "vanity", w: 0.6, d: 0.45}, 0.5), "vanity"); err != nil {
			return nil, err
		}
	case "bedroom", "dorm-room":
		n := int(math.Max(1, float64(r.Beds)))
		for i := 0; i < n; i++ {
			size := r.BedSize
			if size == "" {
				size = "queen"
			}
			if err := need(bed(size), fmt.Sprintf("bed %d", i+1)); err != nil {
				return nil, err
			}
		}
		if r.Type == "dorm-room" {
			for i := 0; i < n; i++ {
				if dr, s, ok := pl.againstWall(fitem{typ: "desk", w: 1.0, d: 0.6}, false); ok {
					cx, cy := inFront(dr, s, 0.3)
					pl.at(fitem{typ: "office-chair", w: 0.5, d: 0.5}, cx, cy, map[byte]float64{'S': 0, 'N': 180, 'W': 270, 'E': 90}[s])
				}
			}
		} else {
			wallFirst(fitem{typ: "dresser", w: 1.2, d: 0.5})
		}
		wallFirst(fitem{typ: "wardrobe", w: 1.0, d: 0.6})
	case "living", "family", "lounge", "suite-common", "common":
		if r.Beds > 0 { // studio
			if err := need(bed(r.BedSize), "bed"); err != nil {
				return nil, err
			}
		}
		for _, w := range []float64{2.2, 1.8, 1.5} {
			if sr, s, ok := pl.againstWall(fitem{typ: "sofa", w: w, d: 0.9}, true); ok {
				cx, cy := inFront(sr, s, 0.75)
				pl.at(fitem{typ: "coffee-table", w: 1.0, d: 0.55}, cx, cy, map[byte]float64{'S': 180, 'N': 0, 'W': 90, 'E': 270}[s])
				pl.againstWall(fitem{typ: "media-unit", w: 1.6, d: 0.45}, true, opposite(s))
				break
			}
		}
		wallFirst(fitem{typ: "armchair", w: 0.85, d: 0.85})
		wallFirst(fitem{typ: "floor-lamp", w: 0.4, d: 0.4})
	case "dining":
		cx, cy := (r.R.X0+r.R.X1)/2, (r.R.Y0+r.R.Y1)/2
		rot := 0.0
		w, d := 1.6, 0.9
		if r.R.D() > r.R.W() {
			rot = 90
		}
		if pl.at(fitem{typ: "dining-table", w: w, d: d}, cx, cy, rot) {
			ch := fitem{typ: "chair", w: 0.45, d: 0.45}
			if rot == 0 {
				pl.at(ch, cx-0.4, cy-d/2-0.35, 0)
				pl.at(ch, cx+0.4, cy-d/2-0.35, 0)
				pl.at(ch, cx-0.4, cy+d/2+0.35, 180)
				pl.at(ch, cx+0.4, cy+d/2+0.35, 180)
			} else {
				pl.at(ch, cx-d/2-0.35, cy-0.4, 270)
				pl.at(ch, cx-d/2-0.35, cy+0.4, 270)
				pl.at(ch, cx+d/2+0.35, cy-0.4, 90)
				pl.at(ch, cx+d/2+0.35, cy+0.4, 90)
			}
			pl.at(fitem{typ: "pendant", w: 0.5, d: 0.5, wide: true}, cx, cy, 0)
		}
	case "office", "study":
		if dr, s, ok := pl.againstWall(fitem{typ: "desk", w: 1.4, d: 0.7}, true); ok {
			cx, cy := inFront(dr, s, 0.35)
			pl.at(fitem{typ: "office-chair", w: 0.6, d: 0.6}, cx, cy, map[byte]float64{'S': 0, 'N': 180, 'W': 270, 'E': 90}[s])
		}
		wallFirst(fitem{typ: "bookshelf", w: 0.9, d: 0.35, h: 2.0})
	case "laundry", "shared-laundry":
		n := int(math.Max(1, float64(r.Washers)))
		for i := 0; i < n; i++ {
			wallFirst(fitem{typ: "washer", w: 0.65, d: 0.65})
			wallFirst(fitem{typ: "dryer", w: 0.65, d: 0.65})
		}
	case "entry", "mudroom":
		wallFirst(fitem{typ: "bench", w: 1.0, d: 0.4})
	case "lobby":
		wallFirst(fitem{typ: "bench", w: 1.6, d: 0.5})
		wallFirst(fitem{typ: "plant", w: 0.5, d: 0.5})
	case "mail":
		wallFirst(fitem{typ: "cabinet", w: 1.6, d: 0.4, h: 1.8}, 1.2)
	case "gym":
		wallFirst(fitem{typ: "bench", w: 1.2, d: 0.4})
	case "bike-storage", "storage", "garage":
		wallFirst(fitem{typ: "shelves", w: 1.2, d: 0.45})
	}
	return pl.items, nil
}
