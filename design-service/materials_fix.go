package main

// Small, certain fixes to Gemma's materials plan, made by code instead of asking Gemma again (a
// retry costs a whole materials call, about 30 s). Only mechanical slips are fixed: an item in the
// wrong list, a count out of range, an id that isn't in the catalog, a room type the design doesn't
// have, and a room type left without flooring (it gets the flooring Gemma chose for a similar
// room). Real choices, like a missing roofing or insulation level, still go back to Gemma.

import (
	"fmt"
	"sort"
)

// fixMaterialPlan repairs mp in place and returns what it changed, for the log.
func fixMaterialPlan(mp *MaterialPlan, d *Design) []string {
	var notes []string
	note := func(f string, v ...any) { notes = append(notes, fmt.Sprintf(f, v...)) }
	rts := roomTypes(d)
	clamp := func(c *int) *int {
		if c == nil {
			one := 1
			return &one
		}
		n := max(1, min(10, *c))
		return &n
	}

	// Shell: drop unknown and automatic items, move per-room items to the rooms they'd suit.
	var shell []Pick
	for _, m := range mp.Shell {
		c, ok := Catalog[m.CatalogID]
		switch {
		case !ok:
			note("dropped unknown item %q", m.CatalogID)
			continue
		case c.Auto:
			note("dropped %s (added from the design)", m.CatalogID)
			continue
		case c.PerRoom():
			note("%s is per room; left out of the shell", m.CatalogID)
			continue
		}
		if c.Key == "count" && (m.Count == nil || *m.Count < 1 || *m.Count > 10) {
			m.Count = clamp(m.Count)
		}
		shell = append(shell, m)
	}
	mp.Shell = shell

	// Rooms: drop unknown items and room types; move whole-building items to the shell.
	var rooms []RoomPick
	for _, m := range mp.Rooms {
		c, ok := Catalog[m.CatalogID]
		switch {
		case !ok:
			note("dropped unknown item %q", m.CatalogID)
			continue
		case rts[m.RoomType].Count == 0:
			note("dropped %s for room type %q, which the design doesn't have", m.CatalogID, m.RoomType)
			continue
		case !c.PerRoom():
			if !c.Auto {
				mp.Shell = append(mp.Shell, Pick{CatalogID: m.CatalogID, Count: m.Count, Reason: m.Reason})
				note("moved %s to the shell", m.CatalogID)
			}
			continue
		}
		if c.Key == "count" && (m.Count == nil || *m.Count < 1 || *m.Count > 10) {
			m.Count = clamp(m.Count)
		}
		rooms = append(rooms, m)
	}
	mp.Rooms = rooms

	// Flooring: every room type that needs it gets the flooring of the most similar room type
	// Gemma floored, wet rooms only from wet-safe choices.
	floor := map[string]string{}
	for _, m := range mp.Rooms {
		if Catalog[m.CatalogID].Category == "flooring" {
			floor[m.RoomType] = m.CatalogID
		}
	}
	var types []string
	for t := range rts {
		types = append(types, t)
	}
	sort.Strings(types)
	for _, t := range types {
		if concreteFloorTypes[t] {
			continue
		}
		id, ok := floor[t]
		if ok && (!wetTypes[t] || Catalog[id].WetOK) {
			continue
		}
		pick := similarFlooring(t, floor)
		if pick == "" {
			continue // nothing suitable chosen anywhere: Gemma is asked
		}
		if ok { // a wet room with flooring that isn't wet-safe
			for i := range mp.Rooms {
				if mp.Rooms[i].RoomType == t && mp.Rooms[i].CatalogID == id {
					mp.Rooms[i].CatalogID = pick
				}
			}
			note("%s gets %s (wet-safe) instead of %s", t, pick, id)
		} else {
			mp.Rooms = append(mp.Rooms, RoomPick{RoomType: t, CatalogID: pick, Reason: "same as a similar room"})
			note("%s gets %s, like a similar room", t, pick)
		}
		floor[t] = pick
	}
	return notes
}

// similarRooms lists, for each room type, the room types whose flooring suits it best first.
var similarRooms = map[string][]string{
	"hall": {"entry", "corridor", "living", "family", "dining"}, "entry": {"hall", "corridor", "mudroom", "living"},
	"corridor": {"hall", "lobby", "entry"}, "lobby": {"corridor", "entry", "hall", "common"},
	"closet": {"bedroom", "hall"}, "linen": {"hall", "bedroom"}, "storage": {"hall", "laundry", "closet"},
	"pantry": {"kitchen", "dining"}, "office": {"bedroom", "living", "family"}, "study": {"lounge", "common", "office"},
	"family": {"living", "dining"}, "dining": {"living", "kitchen", "family"}, "living": {"family", "dining"},
	"bedroom": {"office", "living"}, "dorm-room": {"bedroom", "suite-common"}, "suite-common": {"lounge", "common", "living"},
	"lounge": {"common", "suite-common", "living"}, "common": {"lounge", "lobby"}, "gym": {"common", "lounge"},
	"mail": {"lobby", "corridor"}, "trash": {"corridor"}, "bike-storage": {"corridor", "lobby"},
	"powder": {"bath", "shared-bath", "laundry"}, "bath": {"shared-bath", "powder", "laundry"},
	"shared-bath": {"bath", "powder"}, "laundry": {"bath", "mudroom", "kitchen"}, "shared-laundry": {"laundry", "shared-bath"},
	"mudroom": {"laundry", "entry", "bath"}, "kitchen": {"dining", "laundry", "bath"}, "shared-kitchen": {"kitchen", "common"},
}

func similarFlooring(t string, floor map[string]string) string {
	ok := func(id string) bool { return id != "" && (!wetTypes[t] || Catalog[id].WetOK) }
	for _, o := range similarRooms[t] {
		if ok(floor[o]) {
			return floor[o]
		}
	}
	// Any suitable flooring Gemma chose, in a stable order.
	var ids []string
	for _, id := range floor {
		if ok(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	if len(ids) > 0 {
		return ids[0]
	}
	return ""
}
