package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestReadDescription(t *testing.T) {
	d := readDescription("A red brick farmhouse with a standing-seam metal roof, a library, a home gym, a two-car garage, no basement and a wrap-around porch.")
	if d.Cladding != "brick" || d.Roofing != "metal" || d.Garage == nil || *d.Garage != 2 {
		t.Fatalf("%+v", d)
	}
	if !contains(d.Extras, "porch") || contains(d.Extras, "basement") {
		t.Fatalf("extras %v", d.Extras)
	}
	if !contains(d.Rooms, "library") || !contains(d.Rooms, "gym") {
		t.Fatalf("rooms %v", d.Rooms)
	}
	if d := readDescription("A modern home with a flat roof and a roof terrace, stone fireplace inside."); d.RoofType != "flat" || d.Cladding != "" || !contains(d.Extras, "roof-terrace") || contains(d.Extras, "deck") {
		t.Fatalf("%+v", d)
	}
	if d := readDescription("No garage please, and without a porch."); d.Garage == nil || *d.Garage != 0 || contains(d.Extras, "porch") {
		t.Fatalf("%+v", d)
	}
}

func TestDescriptionShapesDesign(t *testing.T) {
	r := testRequest("house")
	r.Brief.DesignPrompt = ptr("A stone cottage with a slate gable roof, a library, a mudroom and a two-car garage.")
	raw, _ := json.Marshal(r)
	var log bytes.Buffer
	res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &log, Now: time.Now})
	if err != nil {
		t.Fatalf("%v\n%s", err, log.String())
	}
	d := res.Design
	m := d.Exterior.Materials
	if m.Cladding != "stone" || m.Roofing != "slate" || d.Exterior.Roof.Type != "gable" || d.Exterior.Roof.Pitch < 0.33 {
		t.Fatalf("materials %+v roof %+v", m, d.Exterior.Roof)
	}
	if d.Exterior.Garage == nil || d.Exterior.Garage.Cars != 2 {
		t.Fatalf("garage %+v", d.Exterior.Garage)
	}
	names := map[string]bool{}
	for _, lv := range d.Levels {
		for _, rm := range lv.Rooms {
			names[rm.Name] = true
		}
	}
	if !names["Library"] || !names["Mudroom"] {
		t.Fatalf("rooms %v", names)
	}
	if !strings.Contains(strings.Join(d.Overview.Features, " "), "stone outside walls") {
		t.Fatalf("features %v", d.Overview.Features)
	}
}
