package main

import (
	"fmt"
	"strings"
	"testing"
)

func ptr[T any](v T) *T { return &v }

// testRequest builds a request for a housing type on a 60 × 90 m site in Blacksburg.
func testRequest(ht string) Request {
	r := Request{Schema: "terrasim.design-request/2", ID: ptr("REQ-" + ht), HousingType: ptr(ht)}
	r.Site.Type, r.Site.Geometry.Type = "Feature", "Polygon"
	lat0, lon0 := 37.2296, -80.4139
	f := NewFrame(lat0, lon0)
	var ring [][]*float64
	for _, p := range []Pt{{-30, -45}, {30, -45}, {30, 45}, {-30, 45}, {-30, -45}} {
		ll := f.ToLngLat(p)
		ring = append(ring, []*float64{ptr(ll[0]), ptr(ll[1])})
	}
	r.Site.Geometry.Coordinates = [][][]*float64{ring}
	r.Site.Properties.SetbackM = ptr(3.0)
	r.Brief.BudgetUSD = ptr(900000.0)
	switch ht {
	case "house":
		r.Brief.Floors, r.Brief.AreaM2, r.Brief.Bedrooms, r.Brief.Bathrooms = ptr(2), ptr(180.0), ptr(3), ptr(2.5)
	case "tiny-home":
		r.Brief.Floors, r.Brief.AreaM2, r.Brief.Bedrooms, r.Brief.Bathrooms = ptr(1), ptr(32.0), ptr(1), ptr(1.0)
	case "townhouse":
		r.Brief.Floors, r.Brief.AreaM2, r.Brief.Bedrooms, r.Brief.Bathrooms, r.Brief.UnitCount = ptr(3), ptr(150.0), ptr(3), ptr(2.5), ptr(4)
	case "duplex":
		r.Brief.Floors, r.Brief.AreaM2, r.Brief.Bedrooms, r.Brief.Bathrooms = ptr(2), ptr(120.0), ptr(2), ptr(1.5)
	case "apartment", "condo":
		r.Brief.Floors, r.Brief.AreaM2, r.Brief.Bedrooms, r.Brief.Bathrooms, r.Brief.UnitCount = ptr(4), ptr(70.0), ptr(2), ptr(1.0), ptr(24)
	case "dorm":
		r.Brief.Floors, r.Brief.Residents, r.Brief.RoomType = ptr(3), ptr(60), ptr("double")
	}
	return r
}

func designFor(t *testing.T, p Program) *Design {
	t.Helper()
	l, err := BuildLayout(p, 0)
	if err != nil {
		t.Fatalf("%s layout: %v", p.HousingType, err)
	}
	d, err := BuildDesign(l, p)
	if err != nil {
		t.Fatalf("%s design: %v", p.HousingType, err)
	}
	d.ID = "D-test"
	return d
}

func TestEveryHousingTypeDraws(t *testing.T) {
	variants := []func(*Program){
		func(p *Program) {},
		func(p *Program) { p.Extras = []string{"porch", "deck", "balconies", "office"}; p.Accessible = true },
		func(p *Program) { p.GarageCars = 2; p.Extras = []string{"basement"}; p.Basement = true },
		func(p *Program) { p.BathroomSharing = "private" },
		func(p *Program) { p.BathroomSharing = "suite"; p.RoomType = "suite"; p.Floors = 5 },
	}
	for _, ht := range HousingTypes {
		for vi, v := range variants {
			name := fmt.Sprintf("%s/v%d", ht, vi)
			t.Run(name, func(t *testing.T) {
				p := DefaultProgram(testRequest(ht))
				v(&p)
				if isMulti(ht) {
					p.Basement = false
					p.GarageCars = 0
				}
				d := designFor(t, p)
				if e := CheckDesign(d, nil, 0); len(e) > 0 {
					t.Fatalf("%d rule failures:\n- %s", len(e), strings.Join(e, "\n- "))
				}
				rooms, walls, opens, furn := 0, 0, 0, 0
				for _, lv := range d.Levels {
					rooms += len(lv.Rooms)
					walls += len(lv.Walls)
					opens += len(lv.Openings)
					furn += len(lv.Furnishings)
				}
				t.Logf("%.1f × %.1f m, %d levels, %d units, %d rooms, %d walls, %d openings, %d furnishings, %d stairs, %d elevators",
					d.Size.WidthM, d.Size.DepthM, len(d.Levels), len(d.Units), rooms, walls, opens, furn, len(d.Stairs), len(d.Elevators))
			})
		}
	}
}
