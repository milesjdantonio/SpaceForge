package main

// Site data outside the United States. The US sources (USGS 3DEP elevation, USDA soil, FEMA flood
// zones, USGS seismic maps, BLS wages) stop at the border, so elsewhere the design is made from
// worldwide sources where they exist and stated assumptions where they don't, and it's labelled
// estimated:
//
//	elevation  Terrarium tiles (AWS open data; SRTM and others, about 5 m per pixel at zoom 15)
//	soil       ISRIC SoilGrids (250 m estimates of clay, sand and silt), or a typical soil
//	climate    Open-Meteo (already worldwide)
//	flood      unknown: assumed outside a mapped flood zone; check locally
//	seismic    unknown: assumed moderate; check the local building code
//	wages      US national average prices, in US dollars

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"math"
)

var (
	TerrariumURL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
	SoilGridsURL = "https://rest.isric.org/soilgrids/v2.0/properties/query"
)

// usBoxes are where the US sources have data; covered() in server.go uses the same boxes.
func inUSData(lng, lat float64) bool { return covered(lng, lat) }

// FetchTerrariumDEM samples worldwide elevation tiles over the lot on a 1 m grid (bilinear between
// the tiles' pixels, about 5 m apart at zoom 15).
func FetchTerrariumDEM(lat, lon float64, lot [2]float64) (Grid, string, error) {
	const z = 15
	w, d := lot[0]*MPerFt, lot[1]*MPerFt
	cols, rows := max(3, int(math.Round(w))), max(3, int(math.Round(d)))
	n := math.Exp2(z)
	// Pixel coordinates (in the whole zoom-15 world image) of a lat/lon.
	px := func(la, lo float64) (float64, float64) {
		x := (lo + 180) / 360 * n * 256
		s := math.Sin(la * math.Pi / 180)
		y := (0.5 - math.Log((1+s)/(1-s))/(4*math.Pi)) * n * 256
		return x, y
	}
	tiles := map[[2]int]image.Image{}
	tile := func(tx, ty int) (image.Image, error) {
		k := [2]int{tx, ty}
		if im, ok := tiles[k]; ok {
			return im, nil
		}
		data, err := fetch("GET", fmt.Sprintf("%s/%d/%d/%d.png", TerrariumURL, z, tx, ty), nil, "")
		if err != nil {
			return nil, err
		}
		im, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("elevation tile %d/%d: %v", tx, ty, err)
		}
		tiles[k] = im
		return im, nil
	}
	height := func(x, y float64) (float64, error) {
		tx, ty := int(math.Floor(x/256)), int(math.Floor(y/256))
		im, err := tile(tx, ty)
		if err != nil {
			return math.NaN(), err
		}
		r, g, b, _ := im.At(int(x)-tx*256, int(y)-ty*256).RGBA()
		return float64(r>>8)*256 + float64(g>>8) + float64(b>>8)/256 - 32768, nil
	}
	mLat := 110574.0
	mLon := 111320 * math.Cos(lat*math.Pi/180)
	g := Grid{Rows: rows, Cols: cols, Res: w / float64(cols), Z: make([]float64, rows*cols)}
	for i := 0; i < rows; i++ {
		for j := 0; j < cols; j++ {
			// Row 0 is the north edge.
			dy := d/2 - (float64(i)+0.5)*d/float64(rows)
			dx := -w/2 + (float64(j)+0.5)*w/float64(cols)
			x, y := px(lat+dy/mLat, lon+dx/mLon)
			x0, y0 := math.Floor(x-0.5)+0.5, math.Floor(y-0.5)+0.5
			fx, fy := x-x0, y-y0
			var v [4]float64
			for k, o := range [4][2]float64{{0, 0}, {1, 0}, {0, 1}, {1, 1}} {
				h, err := height(x0+o[0], y0+o[1])
				if err != nil {
					return Grid{}, "", err
				}
				v[k] = h
			}
			g.Z[i*cols+j] = v[0]*(1-fx)*(1-fy) + v[1]*fx*(1-fy) + v[2]*(1-fx)*fy + v[3]*fx*fy
		}
	}
	return g, "Terrarium worldwide elevation tiles (about 5 m per pixel), sampled on a 1 m grid; estimated", nil
}

// FetchSoilGrids estimates the soil at the footing depth from ISRIC SoilGrids' clay, sand and silt.
// Built-up areas often have no estimate; then a typical lean clay is assumed and said so.
func FetchSoilGrids(lat, lon float64) (Soil, error) {
	u := fmt.Sprintf("%s?lon=%v&lat=%v&property=clay&property=sand&property=silt&depth=30-60cm&value=mean", SoilGridsURL, lon, lat)
	var res struct {
		Properties struct {
			Layers []struct {
				Name   string `json:"name"`
				Depths []struct {
					Values struct {
						Mean *float64 `json:"mean"`
					} `json:"values"`
				} `json:"depths"`
			} `json:"layers"`
		} `json:"properties"`
	}
	if err := getJSON(u, &res); err != nil {
		return Soil{}, err
	}
	pct := map[string]float64{}
	for _, l := range res.Properties.Layers {
		if len(l.Depths) > 0 && l.Depths[0].Values.Mean != nil {
			pct[l.Name] = *l.Depths[0].Values.Mean / 10 // g/kg → %
		}
	}
	clay, sand, okC := pct["clay"], pct["sand"], len(pct) == 3
	if !okC {
		return typicalSoil("SoilGrids has no estimate here (common in towns); a typical lean clay is assumed. Have the soil tested."), nil
	}
	uscs := "CL"
	switch {
	case clay >= 40:
		uscs = "CH"
	case clay >= 25:
		uscs = "CL"
	case sand >= 65 && clay < 15:
		uscs = "SM"
	case sand >= 50:
		uscs = "SC"
	default:
		uscs = "ML"
	}
	shrink := "low"
	switch {
	case clay >= 45:
		shrink = "high"
	case clay >= 30:
		shrink = "moderate"
	}
	b := BearingFor(uscs)
	return Soil{GoverningUSCS: uscs, GoverningBearing: &b, ShrinkSwell: shrink,
		Note: fmt.Sprintf("Estimated from ISRIC SoilGrids (250 m grid): %.0f%% clay, %.0f%% sand, %.0f%% silt at 30-60 cm. Have the soil tested.", clay, sand, pct["silt"]),
		Components: []SoilComp{{MapUnit: "SoilGrids estimate", Component: "estimated soil", Pct: 100, USCS: uscs, Bearing: b}}}, nil
}

func typicalSoil(note string) Soil {
	b := BearingFor("CL")
	return Soil{GoverningUSCS: "CL", GoverningBearing: &b, ShrinkSwell: "moderate", Note: note,
		Components: []SoilComp{{MapUnit: "assumed", Component: "typical lean clay (assumed)", Pct: 100, USCS: "CL", Bearing: b}}}
}

// worldAssumptions are the values used where no worldwide source exists, and the lines that say so.
func worldAssumptions(s *Site) {
	s.Flood = Flood{FloodZone: "unknown", InSFHA: false}
	s.Seismic = Seismic{SDC: "unknown"}
	s.Labor = Labor{WageFactor: 1, Note: "outside the US: US national average prices, in US dollars"}
	s.Estimated = true
	s.Warnings = append(s.Warnings,
		"Outside the US, TerraSim's site data is estimated: elevation from worldwide tiles and soil from SoilGrids or a typical soil.",
		"No flood map was checked: the design assumes the land is outside a flood zone. Check with the local authority.",
		"No seismic map was checked: the design assumes moderate earthquake risk. Follow the local building code.",
		"Prices are US national averages in US dollars; local costs may differ a lot.")
}

// fetchWorldSite gathers what's known about land outside the US, all sources at once.
func fetchWorldSite(q SiteQuery, s Site) (Site, error) {
	lat, lon := q.Footprint[1], q.Footprint[0]
	var demErr, climateErr error
	done := make(chan struct{}, 4)
	go func() {
		s.Location, _ = FetchLocation(q.Centroid[1], q.Centroid[0])
		done <- struct{}{}
	}()
	go func() {
		grid, src, err := FetchTerrariumDEM(lat, lon, q.FootprintFt)
		if err == nil {
			s.Terrain = AnalyzeFootprint(grid)
			s.Terrain.ElevationSource = src
			s.ground = fitGround(grid, lat, lon)
		}
		demErr = err
		done <- struct{}{}
	}()
	go func() { s.Climate, climateErr = FetchClimate(lat, lon); done <- struct{}{} }()
	var soil Soil
	var soilErr error
	go func() { soil, soilErr = FetchSoilGrids(lat, lon); done <- struct{}{} }()
	for i := 0; i < 4; i++ {
		<-done
	}
	if demErr != nil {
		return s, fmt.Errorf("elevation: %w", demErr)
	}
	if climateErr != nil {
		return s, fmt.Errorf("climate: %w", climateErr)
	}
	if soilErr != nil {
		soil = typicalSoil(fmt.Sprintf("SoilGrids couldn't be reached (%v); a typical lean clay is assumed. Have the soil tested.", soilErr))
	}
	s.Soil = soil
	worldAssumptions(&s)
	return s, nil
}
