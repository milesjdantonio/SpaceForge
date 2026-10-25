package main

// Quantities from the rooms (computed in code, never by Gemma).

import (
	"math"
	"slices"
)

type Takeoff map[string]float64

func ComputeTakeoff(in Interior) Takeoff {
	floors := map[int]float64{}
	for _, r := range in.Rooms {
		floors[r.Floor] += r.LengthFt * r.WidthFt
	}
	maxFloor, total := 0.0, 0.0
	for _, a := range floors {
		maxFloor = math.Max(maxFloor, a)
		total += a
	}
	footprint := maxFloor * Circulation
	side := math.Sqrt(footprint)
	perim := 4 * side
	gross := total * Circulation
	extWall := perim * 9 * float64(in.Stories)
	drywall, doors := 0.0, 0
	for _, r := range in.Rooms {
		drywall += 2*(r.LengthFt+r.WidthFt)*8 + r.LengthFt*r.WidthFt
		if slices.Contains([]string{"bedroom", "bathroom", "half_bath", "laundry", "office"}, r.Type) {
			doors++
		}
		if r.Type == "bedroom" {
			doors++ // closet
		}
	}
	t := Takeoff{
		"footprint_sqft": math.Round(footprint), "footprint_side_ft": math.Round(side*10) / 10,
		"gross_floor_sqft": math.Round(gross), "foundation_perimeter_lf": math.Round(perim),
		"ext_wall_sqft": math.Round(extWall * 0.85), "roof_sqft": math.Round(footprint * 1.2),
		"roof_eave_sqft": math.Round(perim * 6), "ceiling_sqft": math.Round(footprint),
		"floor_framing_sqft": math.Round(footprint), "framing_bf": math.Round(gross * 6.5),
		"drywall_sqft": math.Round(drywall), "windows_count": math.Max(4, math.Round(extWall*0.15/15)),
		"exterior_doors_count": 2, "interior_doors_count": float64(doors),
	}
	for _, r := range in.Rooms {
		k, per := "room:"+r.Name, 2*(r.LengthFt+r.WidthFt)
		t[k+":floor"] = r.LengthFt * r.WidthFt
		t[k+":wall"] = per * 8
		if r.Type == "kitchen" {
			cab := math.Round(per * 0.45)
			island := 0.0
			if slices.Contains(r.Features, "island") {
				island = 24
			}
			t[k+":cabinet_lf"] = cab
			t[k+":countertop_sqft"] = math.Round(cab*2.1 + island)
		}
	}
	return t
}

// FoundationTakeoff adds the quantities that depend on the chosen foundation.
func FoundationTakeoff(foundation string, t Takeoff) Takeoff {
	perim, fp := t["foundation_perimeter_lf"], t["footprint_sqft"]
	footing := perim * 2.0 * 1.0 / 27 // 24 x 12 in perimeter footing
	piers := math.Ceil(perim/8) + math.Ceil(fp/100)
	wallHt := map[string]float64{"slab_on_grade": 1.5, "crawlspace": 3, "stepped_footing": 4,
		"full_basement": 8, "walkout_basement": 8}[foundation]
	cy := map[string]float64{
		"slab_on_grade":    footing + fp*(4.0/12)/27,
		"crawlspace":       footing + perim*(8.0/12)*3/27,
		"stepped_footing":  footing + perim*(8.0/12)*4/27,
		"full_basement":    footing + perim*(8.0/12)*8/27 + fp*(4.0/12)/27,
		"walkout_basement": footing + perim*(8.0/12)*8/27 + fp*(4.0/12)/27,
		"pier_and_beam":    piers * (2*2*1 + math.Pi*0.25*4) / 27,
	}[foundation]
	piles := 0.0
	if foundation == "helical_piles" {
		piles = piers
	}
	return Takeoff{"concrete_cy": math.Round(cy*10) / 10, "foundation_wall_sqft": math.Round(perim * wallHt), "pile_count": piles}
}
