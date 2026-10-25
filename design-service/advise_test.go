package main

import (
	"strings"
	"testing"
)

func TestAdviceKeepsOnlyChangesTheBriefCanHold(t *testing.T) {
	r := lotRequest(t, [][2]float64{{0, 0}, {20, 0}, {20, 25}, {0, 25}}, `{"floors":1,"areaM2":400,"bedrooms":4,"bathrooms":3,"designPrompt":"A long low ranch house with a big porch."}`, "house")
	reply := `{"summary": "The house is too long for the land.",
		"recommendation": "Build it on two floors so it takes up less ground.",
		"change": {"floors": 2, "bathrooms": 2.25, "areaM2": 5000, "colour": "red", "bedrooms": 4},
		"change_label": "Use 2 floors"}`
	a, err := ParseAdvice(reply, r)
	if err != nil {
		t.Fatal(err)
	}
	if a.Change["floors"] != 2 || len(a.Change) != 1 {
		t.Fatalf("only the floors change is usable (bathrooms off-step, area out of range, colour unknown, bedrooms unchanged): %+v", a.Change)
	}
	if a.ChangeLabel != "Use 2 floors" || !strings.Contains(a.Recommendation, "two floors") {
		t.Fatalf("advice: %+v", a)
	}

	none, err := ParseAdvice(`{"summary":"Gemma was busy.","recommendation":"Try again in a minute.","change":{},"change_label":"Retry"}`, r)
	if err != nil || len(none.Change) != 0 || none.ChangeLabel != "" {
		t.Fatalf("no change means no button: %+v %v", none, err)
	}
	if _, err := ParseAdvice(`{"summary":"x"}`, r); err == nil {
		t.Fatal("a reply without a recommendation isn't advice")
	}
	if p := BuildAdvicePrompt(r, "a 30 × 14 m building doesn't fit", nil); !strings.Contains(p, "buildable") || !strings.Contains(p, "doesn't fit") {
		t.Fatal("the prompt should carry the land and the failure")
	}
}
