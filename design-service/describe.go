package main

// The description, read by code. Gemma reads the user's description too, but a plain ask in it
// ("a metal roof", "brick walls", "a library", "a two-car garage") should not depend on Gemma
// noticing: code reads those asks and treats them as choices the user made in the form, so the
// program keeps them (keepUserChoices puts them back if Gemma changes them) and the design says
// which it took. The form wins where it already answers: the description only fills what's open.

import (
	"fmt"
	"regexp"
	"strings"
)

// descAsks is what the description plainly asks for.
type descAsks struct {
	RoofType string   // flat, gable or hip
	Roofing  string   // a roofing value
	Cladding string   // a cladding value
	Extras   []string // extra values
	Rooms    []string // room keys (descRooms)
	Garage   *int
}

type descWord struct {
	re    *regexp.Regexp
	value string
}

func words(pairs ...string) []descWord {
	var out []descWord
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, descWord{regexp.MustCompile(`(?i)` + pairs[i]), pairs[i+1]})
	}
	return out
}

var (
	descRoofTypes = words(
		`\bflat[- ]roof(ed)?\b|\broof (is |should be )?flat\b`, "flat",
		`\bgable(d)?\b|\bpitched roof\b|\bsteep roof\b|\bA-frame\b`, "gable",
		`\bhip(ped)?[- ]roof\b|\bhip roof\b`, "hip")
	descRoofings = words(
		`\b(standing[- ]seam|metal|tin|zinc|copper) roof(ing)?\b`, "metal",
		`\b(clay |terra ?cotta |spanish |tile(d)? )roof\b|\broof tiles?\b|\btile roof\b`, "tile",
		`\bslate\b`, "slate",
		`\bshingle(d)? roof\b|\b(asphalt|architectural) shingles?\b`, "asphalt-shingle")
	descCladdings = words(
		`\b(red |exposed |old |reclaimed )?brick (house|home|walls?|exterior|facade|façade|colonial|cottage|building|villa|mansion|farmhouse|bungalow|ranch|cabin|townhouse)\b|\b(built|clad|faced) (in|with|of) brick\b|\bbrick-clad\b|\ball[- ]brick\b`, "brick",
		`\bstone (house|home|walls?|exterior|facade|façade|cottage|building|villa|mansion|cladding|veneer|farmhouse|cabin)\b|\b(built|clad|faced) (in|with|of) stone\b|\bstone-clad\b|\bfieldstone\b`, "stone",
		`\b(white |smooth )?stucco\b|\brendered (walls?|exterior)\b`, "stucco",
		`\bboard[- ]and[- ]batten\b`, "board-batten",
		`\b(cedar|timber|wood(en)?) (cladding|siding|walls?|exterior|facade|façade)\b|\btimber-clad\b|\bwood-clad\b|\blog (cabin|house|home)\b`, "timber",
		`\bfib(er|re)[- ]cement\b`, "fiber-cement",
		`\b(corrugated|metal) (cladding|siding|walls?|panels?)\b`, "metal-panel",
		`\b(lap|clapboard|weatherboard) siding\b|\bclapboard\b`, "lap-siding")
	descExtras = words(
		`\b(home office|study|work ?from ?home|office)\b`, "office",
		`\b(front |wrap-?around |covered )?porch\b|\bveranda(h)?\b`, "porch",
		`\b(back |rear |garden |wood )?deck\b|\bterrace\b|\bpatio\b`, "deck",
		`\bbalcon(y|ies)\b`, "balconies",
		`\broof(top)? (terrace|deck|garden)\b`, "roof-terrace",
		`\bbasement\b|\blower level\b`, "basement")
	// Rooms the description may ask for, and what they become.
	descRooms = words(
		`\blibrar(y|ies)\b`, "library",
		`\b(home )?gym\b|\bfitness room\b|\bworkout room\b`, "gym",
		`\b(media room|home (theat(er|re)|cinema)|screening room)\b`, "media",
		`\bwine (cellar|room)\b`, "wine",
		`\b(sun ?room|conservatory|garden room)\b`, "sunroom",
		`\bplay ?room\b`, "playroom",
		`\bmud ?room\b`, "mudroom",
		`\b(walk-in |butler'?s )?pantry\b`, "pantry",
		`\b(art|painting|pottery|craft) studio\b|\bstudio space\b`, "studio",
		`\bmusic room\b`, "music",
		`\b(lounge|bar)\b`, "lounge")
	descNot   = regexp.MustCompile(`(?i)\b(no|not|without|skip|never|avoid|instead of)\s+(an?\s+|any\s+|the\s+)?$`)
	descGarag = regexp.MustCompile(`(?i)\b(one|two|three|four|1|2|3|4)[- ]car garage\b|\b(no|without an?) garage\b|\bgarage for (one|two|three|four|1|2|3|4) cars?\b`)
)

// asked finds which of the words the text asks for, skipping negated ones ("no basement").
func asked(text string, ws []descWord) []string {
	var out []string
	for _, w := range ws {
		for _, m := range w.re.FindAllStringIndex(text, -1) {
			start := m[0] - 20
			if start < 0 {
				start = 0
			}
			if descNot.MatchString(text[start:m[0]]) {
				continue
			}
			if !contains(out, w.value) {
				out = append(out, w.value)
			}
			break
		}
	}
	return out
}

func readDescription(text string) descAsks {
	var d descAsks
	first := func(ws []descWord) string {
		if v := asked(text, ws); len(v) > 0 {
			return v[0]
		}
		return ""
	}
	d.RoofType, d.Roofing, d.Cladding = first(descRoofTypes), first(descRoofings), first(descCladdings)
	d.Extras = asked(text, descExtras)
	d.Rooms = asked(text, descRooms)
	if m := descGarag.FindStringSubmatch(text); m != nil {
		n := 0
		for _, s := range []string{m[1], m[3]} {
			switch strings.ToLower(s) {
			case "one", "1":
				n = 1
			case "two", "2":
				n = 2
			case "three", "3":
				n = 3
			case "four", "4":
				n = 4
			}
		}
		d.Garage = &n
	}
	// A roof terrace isn't also a ground-floor deck.
	if contains(d.Extras, "roof-terrace") {
		var ex []string
		for _, x := range d.Extras {
			if x != "deck" {
				ex = append(ex, x)
			}
		}
		d.Extras = ex
	}
	// A pantry or study asked for as a room is that room, not the office extra twice.
	return d
}

// applyDescription fills the request's open choices from the description and returns the request
// and the lines saying what it took ("a metal roof", "a library").
func applyDescription(r Request) (Request, descAsks, []string) {
	d := readDescription(sv(r.Brief.DesignPrompt))
	ht := sv(r.HousingType)
	var took []string
	a := r.Advanced
	if d.Roofing != "" && a.Roofing == nil {
		v := d.Roofing
		a.Roofing = &v
		took = append(took, fmt.Sprintf("a %s roof", humanValue(v)))
	}
	if d.Cladding != "" && a.Cladding == nil {
		v := d.Cladding
		a.Cladding = &v
		took = append(took, fmt.Sprintf("%s outside walls", humanValue(v)))
	}
	if d.Garage != nil && a.Garage == nil && !isMulti(ht) {
		g := min(*d.Garage, garageMax(ht))
		a.Garage = &g
		if g == 0 {
			took = append(took, "no garage")
		} else {
			took = append(took, fmt.Sprintf("a %d-car garage", g))
		}
	}
	extras := append([]string{}, a.Extras...)
	for _, x := range d.Extras {
		if !contains(extras, x) {
			extras = append(extras, x)
			took = append(took, humanExtra(x))
		}
	}
	a.Extras = extras
	if isMulti(ht) {
		// In a shared building the rooms asked for are its common spaces.
		common := append([]string{}, a.CommonSpaces...)
		for _, room := range d.Rooms {
			c := map[string]string{"gym": "gym", "library": "study", "lounge": "lounge", "media": "lounge"}[room]
			if c != "" && !contains(common, c) {
				common = append(common, c)
				took = append(took, humanCommon(c))
			}
		}
		a.CommonSpaces = common
		d.Rooms = nil
	} else {
		for _, room := range d.Rooms {
			if room != "lounge" {
				took = append(took, humanRoom(room))
			}
		}
	}
	if d.RoofType != "" {
		took = append(took, fmt.Sprintf("a %s roof", d.RoofType))
	}
	r.Advanced = a
	return r, d, took
}

func humanValue(v string) string { return strings.ReplaceAll(strings.ReplaceAll(v, "-", " "), "fiber", "fibre") }

func humanExtra(x string) string {
	return map[string]string{"office": "a home office", "porch": "a porch", "deck": "a deck or terrace", "balconies": "balconies",
		"roof-terrace": "a roof terrace", "basement": "a basement"}[x]
}

func humanCommon(c string) string {
	return map[string]string{"gym": "a gym", "study": "a study room", "lounge": "a lounge"}[c]
}

func humanRoom(k string) string {
	return map[string]string{"library": "a library", "gym": "a home gym", "media": "a media room", "wine": "a wine cellar",
		"sunroom": "a sunroom", "playroom": "a playroom", "mudroom": "a mudroom", "pantry": "a pantry", "studio": "a studio",
		"music": "a music room"}[k]
}

// descRoomSlot is the room a description asks for, as a slot in a home's plan.
func descRoomSlot(k string, A float64) slot {
	mx := func(a, b float64) float64 {
		if a > b {
			return a
		}
		return b
	}
	switch k {
	case "library":
		return slot{name: "Library", typ: "office", area: mx(12, 0.04*A), minW: 3.0, link: "door", share: 0.8}
	case "gym":
		return slot{name: "Gym", typ: "gym", area: mx(12, 0.03*A), minW: 3.0, link: "door", share: 0.6}
	case "media":
		return slot{name: "Media room", typ: "family", area: mx(16, 0.035*A), minW: 3.4, link: "door", share: 0.8}
	case "wine":
		return slot{name: "Wine cellar", typ: "storage", area: 6, minW: 2.0, link: "door", share: 0.3}
	case "sunroom":
		return slot{name: "Sunroom", typ: "family", area: mx(12, 0.04*A), minW: 3.0, link: "cased", share: 0.8}
	case "playroom":
		return slot{name: "Playroom", typ: "family", area: mx(12, 0.04*A), minW: 3.0, link: "door", share: 0.8}
	case "mudroom":
		return slot{name: "Mudroom", typ: "mudroom", area: 5, minW: 2.0, link: "door", share: 0.4}
	case "pantry":
		return slot{name: "Pantry", typ: "pantry", area: 4, minW: 1.6, link: "door", share: 0.3}
	case "studio":
		return slot{name: "Studio", typ: "office", area: mx(12, 0.035*A), minW: 3.0, link: "door", share: 0.8}
	case "music":
		return slot{name: "Music room", typ: "family", area: mx(12, 0.03*A), minW: 3.0, link: "door", share: 0.7}
	}
	return slot{}
}
