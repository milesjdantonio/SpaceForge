package main

// Editing a design by prompt: the user writes a change ("add a fourth bedroom", "make it round",
// "brick instead of siding"); one short Gemma call turns it into an updated brief, and the building
// is designed again from that brief on the same land. The brief is the one the design was made
// from when the website still has it, or one read back from the design (its type, size, rooms,
// style and description).
//
//	POST /api/designs/edit   { design, request?, change }  ->  202 { jobId }

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

type EditRequest struct {
	Design  *Design          `json:"design"`
	Request *json.RawMessage `json:"request"`
	Change  string           `json:"change"`
}

// requestFromDesign rebuilds a design request from a finished design, for edits of designs whose
// original brief isn't at hand.
func requestFromDesign(d *Design) Request {
	r := Request{Schema: "terrasim.design-request/2"}
	ht := d.HousingType
	r.HousingType = &ht
	id := "REQ-edit-" + d.ID
	r.ID = &id
	r.Site.Type, r.Site.Geometry.Type = "Feature", "Polygon"
	var ring [][]*float64
	for _, p := range append(append([]Pt{}, d.Site.Outline...), d.Site.Outline[0]) {
		x, y := p[0], p[1]
		ring = append(ring, []*float64{&x, &y})
	}
	r.Site.Geometry.Coordinates = [][][]*float64{ring}
	t := d.Totals
	floors := t.Floors
	r.Brief.Floors = &floors
	switch ht {
	case "hotel":
		rooms := t.Bedrooms
		r.Brief.UnitCount = &rooms
		rt := "single"
		r.Brief.RoomType = &rt
	case "dorm":
		if t.Residents != nil {
			n := *t.Residents
			r.Brief.Residents = &n
		}
		rt := "double"
		r.Brief.RoomType = &rt
	default:
		units := max(1, t.UnitCount)
		area := math.Round(t.FinishedAreaM2 / float64(units))
		beds := t.Bedrooms / units
		baths := math.Round(t.Bathrooms/float64(units)*2) / 2
		r.Brief.AreaM2, r.Brief.Bedrooms, r.Brief.Bathrooms = &area, &beds, &baths
		if _, _, asks := unitCountRange(ht); asks {
			r.Brief.UnitCount = &units
		}
	}
	desc := strings.TrimSpace(strings.Join(append([]string{d.Overview.Summary}, d.Overview.Description...), " "))
	if len([]rune(desc)) > 900 {
		desc = string([]rune(desc)[:900])
	}
	r.Brief.DesignPrompt = &desc
	if d.Overview.Style != "" {
		st := closestChoice(d.Overview.Style, Styles)
		if contains(Styles, st) {
			r.Advanced.Style = &st
		}
	}
	return r
}

func BuildEditPrompt(r Request, change string) string {
	b, _ := json.MarshalIndent(map[string]any{"housingType": sv(r.HousingType), "brief": r.Brief, "advanced": r.Advanced}, "", "  ")
	ht := sv(r.HousingType)
	fr := FloorRanges[ht]
	lo, hi := areaRange(ht)
	bedLo, bedHi, bathLo, bathHi := bedBathRange(ht)
	return fmt.Sprintf(`A building has been designed from the brief below. The user wants it changed:

"%s"

Rewrite the brief so a new design makes that change and keeps everything else. Reply with ONE JSON
object with only the fields that change:

{
  "designPrompt": "the full description, rewritten to include the change (15 to 1000 characters)",
  "floors": %d to %d, "areaM2": %.0f to %.0f (living space per home), "bedrooms": %d to %d,
  "bathrooms": %g to %g in steps of 0.5, "unitCount": homes (townhouse 2-12, apartment or condo 4-200)
  or a hotel's guest rooms (8-400), "residents": dorm beds, "budgetUSD": dollars or null for no limit,
  "style": one of %v, "cladding": one of %v, "roofing": one of %v, "quality": one of %v,
  "garage": cars 0-%d, "extras": list from %v
}

Always include designPrompt. Leave out a field to keep it as it is.

Current brief (%s):
%s`, strings.TrimSpace(change), fr[0], fr[1], lo, hi, bedLo, bedHi, bathLo, bathHi, Styles, Claddings, Roofings, Qualities, garageMax(ht), ExtraValues, ht, b)
}

// ApplyEdit reads Gemma's reply and applies the changes the brief can hold. It returns the new
// request and a line per change, for the log.
func ApplyEdit(text string, r Request) (Request, []string, error) {
	m, err := extractJSON(text)
	if err != nil {
		return r, nil, err
	}
	var notes []string
	ht := sv(r.HousingType)
	desc, _ := asString(m["designPrompt"])
	desc = strings.TrimSpace(desc)
	if n := len([]rune(desc)); n < 15 || n > 1000 {
		return r, nil, fmt.Errorf("designPrompt must be 15-1000 characters, with the change in it")
	}
	r.Brief.DesignPrompt = &desc
	notes = append(notes, "description rewritten with the change")
	intIn := func(k string, lo, hi int, dst **int) {
		if v, ok := asFloat(m[k]); ok && v == math.Trunc(v) && int(v) >= lo && int(v) <= hi {
			n := int(v)
			*dst = &n
			notes = append(notes, fmt.Sprintf("%s %d", k, n))
		}
	}
	fr := FloorRanges[ht]
	intIn("floors", fr[0], fr[1], &r.Brief.Floors)
	if ht == "dorm" {
		intIn("residents", 1, 2000, &r.Brief.Residents)
	} else if ht != "hotel" {
		lo, hi := areaRange(ht)
		if v, ok := asFloat(m["areaM2"]); ok && v >= lo && v <= hi {
			a := math.Round(v)
			r.Brief.AreaM2 = &a
			notes = append(notes, fmt.Sprintf("areaM2 %.0f", a))
		}
		bedLo, bedHi, bathLo, bathHi := bedBathRange(ht)
		intIn("bedrooms", bedLo, bedHi, &r.Brief.Bedrooms)
		if v, ok := asFloat(m["bathrooms"]); ok && v >= bathLo && v <= bathHi && math.Mod(v*2, 1) == 0 {
			r.Brief.Bathrooms = &v
			notes = append(notes, fmt.Sprintf("bathrooms %g", v))
		}
	}
	if lo, hi, ok := unitCountRange(ht); ok {
		intIn("unitCount", lo, hi, &r.Brief.UnitCount)
	}
	if v, ok := m["budgetUSD"]; ok {
		if v == nil {
			r.Brief.BudgetUSD = nil
			notes = append(notes, "no budget limit")
		} else if f, ok := asFloat(v); ok && f >= 10000 {
			r.Brief.BudgetUSD = &f
			notes = append(notes, fmt.Sprintf("budget $%.0f", f))
		}
	}
	choice := func(k string, allowed []string, dst **string) {
		if s, ok := asString(m[k]); ok {
			c := closestChoice(s, allowed)
			if contains(allowed, c) {
				*dst = &c
				notes = append(notes, fmt.Sprintf("%s %s", k, c))
			}
		}
	}
	choice("style", Styles, &r.Advanced.Style)
	choice("cladding", Claddings, &r.Advanced.Cladding)
	choice("roofing", Roofings, &r.Advanced.Roofing)
	choice("quality", Qualities, &r.Advanced.Quality)
	if !isMulti(ht) {
		intIn("garage", 0, garageMax(ht), &r.Advanced.Garage)
	}
	if v, ok := m["extras"]; ok {
		if list, ok := asStrings(v); ok {
			r.Advanced.Extras = onlyKnown(list, ExtraValues)
			notes = append(notes, "extras "+strings.Join(r.Advanced.Extras, ", "))
		}
	}
	nid := strings.TrimSuffix(sv(r.ID), "-edited") + "-edited"
	r.ID = &nid
	return r, notes, nil
}

// EditRequestFor turns an edit into the request to design: Gemma rewrites the brief (up to two
// tries), and code keeps only what the brief can hold.
func EditRequestFor(e EditRequest, ask AskFunc, log func(string)) (Request, error) {
	var r Request
	if e.Request != nil && len(*e.Request) > 2 {
		if err := json.Unmarshal(*e.Request, &r); err != nil {
			return r, fmt.Errorf("the original request isn't readable: %v", err)
		}
	} else if e.Design != nil && len(e.Design.Site.Outline) >= 3 {
		r = requestFromDesign(e.Design)
	} else {
		return r, fmt.Errorf("send the design (or its request) to change")
	}
	if strings.TrimSpace(e.Change) == "" {
		return r, fmt.Errorf("write the change to make")
	}
	log("Gemma: your change (attempt 1 of 2)")
	msgs := []Msg{{"user", BuildEditPrompt(r, e.Change)}}
	for attempt := 1; attempt <= 2; attempt++ {
		text, err := ask(msgs, 4096)
		if err != nil {
			return r, err
		}
		nr, notes, err := ApplyEdit(text, r)
		if err == nil {
			for _, n := range notes {
				log("  " + n)
			}
			return nr, nil
		}
		if attempt == 2 {
			return r, fmt.Errorf("Gemma couldn't turn the change into a brief: %v", err)
		}
		log("Gemma: your change (attempt 2 of 2)")
		msgs = append(msgs, Msg{"model", text}, Msg{"user", "That reply can't be used: " + err.Error() + ". Reply with the JSON object only."})
	}
	return r, nil
}
