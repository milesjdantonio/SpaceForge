package main

// Roof terraces. The building's stairs carry on up to a small stair house on the roof: one more
// level, named "Roof", holding the stair and a landing. A door from the landing opens onto the
// terrace, which is that level's balcony: a slab on the flat roof below with a guard rail round its
// open edges. The roof under it is flat.

import "math"

// addRoofTerrace adds the roof level and its terrace to a finished layout. It returns a caution
// when the terrace can't be drawn, or "".
func addRoofTerrace(l *Layout, p Program) string {
	if len(l.Levels) == 0 {
		return ""
	}
	top := l.Levels[len(l.Levels)-1]
	var stair *LRoom
	for _, r := range top.Rooms {
		if r.Type == "stair" && (stair == nil || r.R.X0 < stair.R.X0) {
			stair = r
		}
	}
	if stair == nil {
		return "The roof terrace was left off: there's no stair to reach the roof."
	}
	// The part of the roof the terrace can use: the main wing (the whole roof on a straight plan).
	roofR := Rect{0, 0, l.W, l.D}
	if len(l.RoofWings) > 0 {
		w := l.RoofWings[0]
		roofR = Rect{w.X0, w.Y0, w.X1, w.Y1}
	}
	const edge = 0.3    // the terrace stops short of the roof's edge (the parapet)
	const landing = 1.4 // the landing beside the stair
	s := stair.R
	// The terrace goes on whichever side of the stair house has the most roof.
	type side struct {
		land, terrace Rect
		door          byte
	}
	var sides []side
	if r := (Rect{s.X1 + landing, roofR.Y0 + edge, roofR.X1 - edge, roofR.Y1 - edge}); r.W() > 0 {
		sides = append(sides, side{Rect{s.X1, s.Y0, s.X1 + landing, s.Y1}, r, 'E'})
	}
	if r := (Rect{roofR.X0 + edge, roofR.Y0 + edge, s.X0 - landing, roofR.Y1 - edge}); r.W() > 0 {
		sides = append(sides, side{Rect{s.X0 - landing, s.Y0, s.X0, s.Y1}, r, 'W'})
	}
	best := -1
	for i, sd := range sides {
		if best < 0 || sd.terrace.Area() > sides[best].terrace.Area() {
			best = i
		}
	}
	if best < 0 || sides[best].terrace.W() < 2.5 || sides[best].terrace.D() < 2.5 || !inRect(sides[best].land, roofR) {
		return "The roof terrace was left off: the roof has no room for it beside the stair."
	}
	sd := sides[best]
	// The landing and terrace must lie over the floor below, not over a yard or court.
	if l.Outline != nil {
		for _, q := range append(sd.land.Poly(), sd.terrace.Poly()...) {
			if !PointInPoly(q, l.Outline) {
				return "The roof terrace was left off: the roof has no room for it beside the stair."
			}
		}
	}
	idx := len(l.Levels)
	house := Rect{math.Min(s.X0, sd.land.X0), s.Y0, math.Max(s.X1, sd.land.X1), s.Y1}
	lv := &LLevel{Index: idx, Name: "Roof", Elev: top.Elev + top.Height, Height: 2.6, Outline: house.Poly(), Roof: true}
	l.Levels = append(l.Levels, lv)
	l.RoofLevel = true
	st := l.add(idx, "Roof stair", "stair", stair.Unit, s)
	land := l.add(idx, "Roof landing", "hall", stair.Unit, sd.land)
	st.Links = append(st.Links, Link{To: land.Key, Kind: "passage", Width: math.Min(1.0, s.D()-0.4)})
	cy := (sd.land.Y0 + sd.land.Y1) / 2
	land.Links = append(land.Links, Link{Kind: "patio", Width: math.Min(1.6, sd.land.D()-0.4), Side: sd.door, At: cy})
	l.Balconies = append(l.Balconies, LBalcony{Level: idx, R: sd.terrace, Unit: stair.Unit, Room: land.Key, Railing: "glass"})
	l.Stairs = append(l.Stairs, LStair{R: s, From: top.Index, To: idx, Access: "front", Shape: "switchback", Unit: stair.Unit})
	return ""
}

func inRect(r, outer Rect) bool {
	return r.X0 >= outer.X0-1e-6 && r.Y0 >= outer.Y0-1e-6 && r.X1 <= outer.X1+1e-6 && r.Y1 <= outer.Y1+1e-6
}
