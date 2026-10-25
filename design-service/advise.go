package main

// When a design fails, one short Gemma call reads what went wrong and the brief, and writes the
// recommendation the website shows first: what happened in plain words, what to change, and the
// change itself as brief fields the website can apply with one click. Code checks every field, so
// a suggestion the brief can't hold is dropped rather than shown.

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// Advice is the recommendation for a failed design.
type Advice struct {
	Summary        string         `json:"summary"`        // what went wrong, in a sentence
	Recommendation string         `json:"recommendation"` // what to do about it
	Change         map[string]any `json:"change,omitempty"`
	ChangeLabel    string         `json:"changeLabel,omitempty"` // the button's words, e.g. "Use 3 floors"
}

// adviceFields are the brief answers a recommendation may change (the website's form names).
var adviceFields = []string{"floors", "areaM2", "unitCount", "bedrooms", "bathrooms", "residents", "budgetUSD",
	"noBudgetLimit", "areaByAI", "designPrompt"}

func BuildAdvicePrompt(r Request, failure string, logTail []string) string {
	ht := sv(r.HousingType)
	b, _ := json.MarshalIndent(r.Brief, "", "  ")
	fr := FloorRanges[ht]
	lo, hi := areaRange(ht)
	bedLo, bedHi, bathLo, bathHi := bedBathRange(ht)
	ring, _ := r.SiteRing()
	site := "unknown size"
	if len(ring) >= 3 {
		local, _ := localRing(ring)
		site = fmt.Sprintf("%.0f m², of which %.0f m² is at least %.0f m from every boundary (buildable)",
			PolyArea(local), buildableArea(local, r.Setback()), r.Setback())
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, `You help someone whose building design just failed to generate. They are not an engineer.
Read what went wrong and their brief, then reply with ONE JSON object:

{
  "summary": "one plain sentence: what went wrong (no jargon, no field names, no error codes)",
  "recommendation": "one or two plain sentences: the single change most likely to make the next try work",
  "change": { brief fields to change, or {} if the brief is fine and they should simply try again },
  "change_label": "2 to 5 words for the button that applies the change, e.g. \"Use 3 floors\"; empty if change is {}"
}

Fields "change" may hold, with their limits for a %s:
- floors: whole number %d to %d
- areaM2: living space per home in m², %.0f to %.0f (house, tiny home) or per home (other types)
- unitCount: number of homes (townhouse 2-12, apartment or condo 4-200), or a hotel's guest rooms (8-400)
- bedrooms: %d to %d; bathrooms: %g to %g in steps of 0.5; residents: dorm beds
- budgetUSD: whole dollars; noBudgetLimit: true to remove the budget
- areaByAI: true to let the design system choose the size
- designPrompt: a rewritten description, 15 to 300 characters, keeping what they asked for

Only change what the failure points to. Keep the user's own wishes where you can.

The land: %s.
Building type: %s.
Brief:
%s

What went wrong:
%s
`, ht, fr[0], fr[1], lo, hi, bedLo, bedHi, bathLo, bathHi, site, ht, b, truncate(failure, 1500))
	if len(logTail) > 0 {
		fmt.Fprintf(&sb, "\nThe last lines of the design log:\n%s\n", truncate(strings.Join(logTail, "\n"), 1500))
	}
	return sb.String()
}

// ParseAdvice reads Gemma's reply and keeps only changes the brief can hold.
func ParseAdvice(text string, r Request) (Advice, error) {
	m, err := extractJSON(text)
	if err != nil {
		return Advice{}, err
	}
	var a Advice
	a.Summary, _ = asString(m["summary"])
	a.Recommendation, _ = asString(m["recommendation"])
	a.ChangeLabel, _ = asString(m["change_label"])
	a.Summary, a.Recommendation = strings.TrimSpace(a.Summary), strings.TrimSpace(a.Recommendation)
	if a.Recommendation == "" {
		return Advice{}, fmt.Errorf("the reply has no recommendation")
	}
	ch, _ := m["change"].(map[string]any)
	a.Change = cleanChange(ch, r)
	if len(a.Change) == 0 {
		a.ChangeLabel = ""
	} else if strings.TrimSpace(a.ChangeLabel) == "" {
		a.ChangeLabel = "Apply this change"
	}
	return a, nil
}

func cleanChange(ch map[string]any, r Request) map[string]any {
	ht := sv(r.HousingType)
	out := map[string]any{}
	intIn := func(k string, lo, hi int) {
		if v, ok := asFloat(ch[k]); ok && v == math.Trunc(v) && int(v) >= lo && int(v) <= hi {
			out[k] = int(v)
		}
	}
	fr := FloorRanges[ht]
	intIn("floors", fr[0], fr[1])
	lo, hi := areaRange(ht)
	if v, ok := asFloat(ch["areaM2"]); ok && v >= lo && v <= hi && !roomsNotHomes(ht) {
		out["areaM2"] = math.Round(v)
	}
	if ulo, uhi, ok := unitCountRange(ht); ok {
		intIn("unitCount", ulo, uhi)
	}
	if ht == "dorm" {
		intIn("residents", 1, 2000)
	} else if ht != "hotel" {
		bedLo, bedHi, bathLo, bathHi := bedBathRange(ht)
		intIn("bedrooms", bedLo, bedHi)
		if v, ok := asFloat(ch["bathrooms"]); ok && v >= bathLo && v <= bathHi && math.Mod(v*2, 1) == 0 {
			out["bathrooms"] = v
		}
	}
	if v, ok := asFloat(ch["budgetUSD"]); ok && v >= 10000 {
		out["budgetUSD"] = math.Round(v)
	}
	for _, k := range []string{"noBudgetLimit", "areaByAI"} {
		if v, ok := asBool(ch[k]); ok && v {
			out[k] = true
		}
	}
	if roomsNotHomes(ht) {
		delete(out, "areaByAI")
	}
	if v, ok := asString(ch["designPrompt"]); ok {
		v = strings.TrimSpace(v)
		if n := len([]rune(v)); n >= 15 && n <= 300 {
			out["designPrompt"] = v
		}
	}
	// A "change" that changes nothing isn't one.
	for k, v := range out {
		if same(r, k, v) {
			delete(out, k)
		}
	}
	return out
}

// same reports whether the brief already holds this value.
func same(r Request, k string, v any) bool {
	b := r.Brief
	f, _ := asFloat(v)
	if n, ok := v.(int); ok {
		f = float64(n)
	}
	switch k {
	case "floors":
		return b.Floors != nil && float64(*b.Floors) == f
	case "areaM2":
		return b.AreaM2 != nil && *b.AreaM2 == f
	case "unitCount":
		return b.UnitCount != nil && float64(*b.UnitCount) == f
	case "bedrooms":
		return b.Bedrooms != nil && float64(*b.Bedrooms) == f
	case "bathrooms":
		return b.Bathrooms != nil && *b.Bathrooms == f
	case "residents":
		return b.Residents != nil && float64(*b.Residents) == f
	case "budgetUSD":
		return b.BudgetUSD != nil && *b.BudgetUSD == f
	case "designPrompt":
		s, _ := v.(string)
		return b.DesignPrompt != nil && strings.TrimSpace(*b.DesignPrompt) == s
	}
	return false
}

// AdviseFailure asks once; a reply that can't be used means no advice (the website then shows its
// own suggestions), never a second wait.
func AdviseFailure(r Request, failure string, logTail []string, ask AskFunc) (Advice, error) {
	text, err := ask([]Msg{{"user", BuildAdvicePrompt(r, failure, logTail)}}, 2048)
	if err != nil {
		return Advice{}, err
	}
	return ParseAdvice(text, r)
}
