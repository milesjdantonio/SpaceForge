package main

// Manufactured homes, for trailer-park pads (sites.go). A double-wide (roomType "double", about
// 8 m deep) uses the house plan with shallower bands. A single-wide (roomType "single", about 4.3 m
// deep) is too narrow for a hall between two bands: its living room and kitchen run the full width
// in the middle, the primary bedroom (with its bath) at one end, and a hall along the back at the
// other end serves the bath, the other bedrooms and the laundry.

import (
	"fmt"
	"math"
)

func isManufactured(ht string) bool { return ht == "manufactured" }

// manufacturedArea is the usual floor area of a single- or double-wide home.
func manufacturedArea(roomType string, bedrooms int) float64 {
	if roomType == "double" {
		return 110 + 15*float64(bedrooms)
	}
	return 55 + 10*float64(bedrooms)
}

func layoutSingleWide(p Program, variant int) (*Layout, error) {
	depths := []float64{4.3, 4.6, 4.0}
	if variant >= len(depths) {
		return nil, ErrNoPreset
	}
	Dd := depths[variant]
	const hallW = 1.0
	B := max(1, p.Bedrooms)
	full := max(1, int(math.Floor(p.Bathrooms)))
	A := p.AreaM2
	// Widths along the home, end to end.
	type piece struct {
		name, typ string
		w         float64
	}
	var ends []piece
	if full >= 2 {
		ends = append(ends, piece{"Primary bath", "bath", 1.8})
	}
	ends = append(ends, piece{"Primary bedroom", "bedroom", math.Max(3.4, 0.14*A/Dd*4.3)})
	livW := math.Max(3.6, 0.22*A/Dd*4.3)
	kitW := math.Max(3.2, 0.16*A/Dd*4.3)
	var side []piece // the front band at the hall end
	side = append(side, piece{"Bath", "bath", 1.8})
	for i := 1; i < B; i++ {
		side = append(side, piece{fmt.Sprintf("Bedroom %d", i+1), "bedroom", 3.0})
	}
	side = append(side, piece{"Laundry", "laundry", 1.7})
	sideW := 0.0
	for _, s := range side {
		sideW += s.w
	}
	// Share any area left over between the living room and kitchen.
	used := Dd * (livW + kitW + sideW)
	for _, e := range ends {
		used += Dd * e.w
	}
	if spare := A - used; spare > 0 {
		livW += spare / Dd * 0.6
		kitW += spare / Dd * 0.4
	}
	livW, kitW = math.Ceil(livW*10)/10, math.Ceil(kitW*10)/10

	l := &Layout{Basement: false}
	l.Levels = append(l.Levels, &LLevel{Index: 0, Name: "Ground floor", Elev: 0, Height: 2.7})
	const u = "U-1"
	x := 0.0
	var primaryBath, primaryBed *LRoom
	for _, e := range ends {
		r := l.add(0, e.name, e.typ, u, Rect{x, 0, x + e.w, Dd})
		if e.typ == "bath" {
			primaryBath = r
		} else {
			primaryBed = r
			r.Beds, r.BedSize = 1, "queen"
		}
		x += e.w
	}
	liv := l.add(0, "Living room", "living", u, Rect{x, 0, x + livW, Dd})
	x += livW
	kit := l.add(0, "Kitchen", "kitchen", u, Rect{x, 0, x + kitW, Dd})
	kit.Open = append(kit.Open, liv.Key)
	x += kitW
	hall := l.add(0, "Hall", "hall", u, Rect{x, Dd - hallW, x + sideW, Dd})
	hall.Links = append(hall.Links, Link{To: kit.Key, Kind: "cased", Width: 0.9})
	for _, s := range side {
		r := l.add(0, s.name, s.typ, u, Rect{x, 0, x + s.w, Dd - hallW})
		r.Links = append(r.Links, Link{To: hall.Key, Kind: "door", Width: openingWidth("door", s.w, p.Accessible)})
		switch s.typ {
		case "bedroom":
			r.Beds, r.BedSize = 1, "full"
		case "bath":
			r.Tub = true
		case "laundry":
			r.Washers = 1
		}
		x += s.w
	}
	primaryBed.Links = append(primaryBed.Links, Link{To: liv.Key, Kind: "door", Width: 0.85})
	if primaryBath != nil {
		primaryBath.Links = append(primaryBath.Links, Link{To: primaryBed.Key, Kind: "door", Width: 0.75})
	}
	liv.Links = append(liv.Links, Link{Kind: "entry", Width: entryWidth(p.Accessible), UnitEntry: true, Side: 'S', At: -1})
	l.W, l.D = x, Dd
	// The last room reaches the end exactly.
	l.Units = append(l.Units, LUnit{u, "The home", "house", p.Bedrooms, p.Bathrooms})
	if contains(p.Extras, "porch") || contains(p.Extras, "deck") {
		// A small deck at the front door.
		cx := (liv.R.X0 + liv.R.X1) / 2
		l.Porch = &Rect{cx - 1.6, -1.8, cx + 1.6, 0}
	}
	return l, nil
}
