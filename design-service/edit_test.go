package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestEditRebuildsTheBrief(t *testing.T) {
	r := testRequest("house")
	r.Brief.DesignPrompt = ptr("A bright family house with a porch.")
	raw, _ := json.Marshal(r)
	res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &bytes.Buffer{}, Now: time.Now,
		Suppliers: func(float64, float64) ([]Supplier, error) { return nil, nil }})
	if err != nil {
		t.Fatal(err)
	}
	// From the design alone (no original request): the type, size and rooms come back.
	back := requestFromDesign(res.Design)
	if sv(back.HousingType) != "house" || back.Brief.Bedrooms == nil || *back.Brief.Bedrooms != 3 || len(ValidateRequest(back)) > 0 {
		t.Fatalf("request from design: %+v %v", back.Brief, ValidateRequest(back))
	}
	var lines []string
	got, err := EditRequestFor(EditRequest{Design: res.Design, Change: "add a fourth bedroom and make it round"},
		(&fakeGemma{t: t, r: r}).ask, func(l string) { lines = append(lines, l) })
	if err != nil {
		t.Fatal(err)
	}
	if *got.Brief.Bedrooms != 4 || !strings.Contains(*got.Brief.DesignPrompt, "round") || !strings.HasSuffix(sv(got.ID), "-edited") {
		t.Fatalf("edited brief: %+v id %s", got.Brief, sv(got.ID))
	}
	if shapeFromPrompt(*got.Brief.DesignPrompt) != ShapeRound {
		t.Fatal("the change should carry through to the shape")
	}
	if _, _, err := ApplyEdit(`{"bedrooms": 5}`, back); err == nil {
		t.Fatal("an edit without the description is refused")
	}
	if !strings.Contains(strings.Join(lines, "\n"), "Gemma: your change (attempt 1 of 2)") {
		t.Fatalf("log: %v", lines)
	}
}
