package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// lotRequest builds a request for a lot given in local metres around a US spot.
func lotRequest(t *testing.T, pts [][2]float64, brief string, ht string) Request {
	t.Helper()
	f := NewFrame(39.0, -77.0)
	var ring [][2]float64
	for _, p := range pts {
		q := f.ToLngLat(Pt{p[0], p[1]})
		ring = append(ring, [2]float64{q[0], q[1]})
	}
	ring = append(ring, ring[0])
	b, _ := json.Marshal(ring)
	raw := fmt.Sprintf(`{"schema":"terrasim.design-request/2","housingType":%q,
		"site":{"type":"Feature","geometry":{"type":"Polygon","coordinates":[%s]},"properties":{"setbackM":3}},
		"brief":%s,"advanced":{}}`, ht, b, brief)
	var r Request
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestFitCheck(t *testing.T) {
	rect := [][2]float64{{0, 0}, {30, 0}, {30, 40}, {0, 40}}
	house := `{"floors":2,"areaM2":220,"bedrooms":3,"bathrooms":2}`
	start := time.Now()
	ok, err := FitCheck(lotRequest(t, rect, house, "house"))
	if err != nil || ok.Level != "ok" || ok.WidthM == 0 {
		t.Fatalf("a 220 m² two-storey house on a 30 × 40 m lot should fit: %+v %v", ok, err)
	}
	if ok.BuildableM2 < 750 || ok.BuildableM2 > 880 {
		t.Fatalf("buildable area of a 30 × 40 m lot with 3 m setback is 816 m², got %v", ok.BuildableM2)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("fit check took %s", d)
	}

	// A spike from a slip of the mouse must not make a lot that easily fits look full.
	spike := [][2]float64{{0, 0}, {30, 0}, {30, 40}, {15, 40}, {15.2, 80}, {14.8, 40}, {0, 40}}
	sp, err := FitCheck(lotRequest(t, spike, house, "house"))
	if err != nil || sp.Level != "ok" {
		t.Fatalf("a spike in the outline shouldn't stop the fit: %+v %v", sp, err)
	}

	big := `{"floors":1,"areaM2":800,"bedrooms":5,"bathrooms":4}`
	over, err := FitCheck(lotRequest(t, [][2]float64{{0, 0}, {28, 0}, {28, 36}, {0, 36}}, big, "house"))
	if err != nil || over.Level != "over" {
		t.Fatalf("an 800 m² bungalow on a 20 × 25 m lot shouldn't fit: %+v %v", over, err)
	}
	if over.FloorsNeeded == 0 || over.MaxAreaM2 == 0 || over.MaxAreaM2 >= 800 {
		t.Fatalf("expected more floors and a smaller size that fit, got %+v", over)
	}
	t.Logf("over: %+v", over)
}
