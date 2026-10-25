package main

// Prices, nearest suppliers and the cost total (all arithmetic in code).

import (
	"encoding/csv"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
)

type Override struct {
	Price    float64
	Supplier string
}

// LoadOverrides reads prices.csv: catalog_id,unit_price,supplier.
func LoadOverrides(path string) (map[string]Override, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return map[string]Override{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	recs, err := csv.NewReader(f).ReadAll()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	out := map[string]Override{}
	if len(recs) == 0 {
		return out, nil
	}
	col := map[string]int{}
	for i, h := range recs[0] {
		col[strings.TrimSpace(h)] = i
	}
	ci, okID := col["catalog_id"]
	pi, okP := col["unit_price"]
	if !okID || !okP {
		return nil, fmt.Errorf("%s needs a header row: catalog_id,unit_price,supplier", path)
	}
	for _, r := range recs[1:] {
		if ci >= len(r) || pi >= len(r) {
			continue
		}
		p, err := strconv.ParseFloat(strings.TrimSpace(r[pi]), 64)
		if err != nil {
			return nil, fmt.Errorf("%s: bad price %q for %s", path, r[pi], r[ci])
		}
		sup := "your quote"
		if si, ok := col["supplier"]; ok && si < len(r) && strings.TrimSpace(r[si]) != "" {
			sup = strings.TrimSpace(r[si])
		}
		out[strings.TrimSpace(r[ci])] = Override{p, sup}
	}
	return out, nil
}

var supplierTypes = map[string][]string{
	"foundation_concrete": {"concrete_plant", "concrete", "building_materials", "trade"},
	"foundation_piles":    {"builder"}, "flooring": {"flooring", "tiles", "doityourself"},
	"cabinets": {"kitchen", "doityourself"}, "countertops": {"kitchen", "doityourself"},
	"appliance":        {"appliance", "electronics", "doityourself"},
	"plumbing_fixture": {"bathroom_furnishing", "doityourself", "hardware"},
	"paint":            {"paint", "doityourself", "hardware"}, "roofing": {"roofer", "trade", "doityourself"},
	"hvac": {"hvac"}, "electrical": {"electrician"}, "plumbing_rough_in": {"plumber"},
	"water_heater": {"plumber", "doityourself"},
}
var generalSuppliers = []string{"trade", "building_materials", "doityourself", "hardware"}
var trades = []string{"hvac", "electrical", "plumbing_rough_in", "foundation_piles"}

func NearestSupplier(category string, sups []Supplier) *Supplier {
	kinds := supplierTypes[category]
	if !contains(trades, category) {
		kinds = append(append([]string{}, kinds...), generalSuppliers...)
	}
	for _, k := range kinds {
		for i := range sups { // sups are sorted nearest first
			if sups[i].Type == k {
				return &sups[i]
			}
		}
	}
	return nil
}

// Quantity is how many purchase units to buy.
func Quantity(c Item, p Pick, take, ftake Takeoff) int {
	if c.Key == "count" {
		if p.Count != nil {
			return *p.Count
		}
		return 1
	}
	var base float64
	if RoomKeys[c.Key] {
		base = take["room:"+deref(p.Room)+":"+strings.TrimPrefix(c.Key, "room_")]
	} else if v, ok := ftake[c.Key]; ok {
		base = v
	} else {
		base = take[c.Key]
	}
	waste := 0.1 // cut-offs and breakage
	if strings.HasSuffix(c.Key, "_count") || c.Key == "gross_floor_sqft" || c.Installed {
		waste = 0
	}
	return int(math.Ceil(math.Round(base*(1+waste)/c.Cov*1e6) / 1e6))
}

type LineItem struct {
	CatalogID, Category, Room, Item string
	Qty                             int
	Unit                            string
	UnitPrice, LineTotal            float64
	Installed                       bool
	PriceSource, BuyAt, Reason      string
}

func LineItems(p Plan, take Takeoff, s Site, sups []Supplier, ov map[string]Override) []LineItem {
	ftake := FoundationTakeoff(p.FoundationType, take)
	wf := s.Labor.WageFactor
	if wf == 0 {
		wf = 1
	}
	var rows []LineItem
	for _, m := range p.Materials {
		c := Catalog[m.CatalogID]
		qty := Quantity(c, m, take, ftake)
		var price float64
		var source string
		if o, ok := ov[m.CatalogID]; ok {
			price, source = o.Price, o.Supplier
		} else {
			price, source = c.Price, "baseline"
			if c.Installed {
				price = math.Round(c.Price*wf*100) / 100
				source = "baseline × local wages"
			}
		}
		buy := "—"
		if sp := NearestSupplier(c.Category, sups); sp != nil {
			buy = fmt.Sprintf("%s (%g mi)", sp.Name, sp.Miles)
		} else if contains(trades, c.Category) {
			buy = "local contractor (quote)"
		}
		rows = append(rows, LineItem{m.CatalogID, c.Category, deref(m.Room), c.Name, qty, c.Unit, price,
			math.Round(float64(qty)*price*100) / 100, c.Installed, source, buy, m.Reason})
	}
	return rows
}

type Totals struct {
	Materials, Installed, Labor, Earthwork, Wall, Total, PerSqft int
	WageFactor                                                   float64
}

func ComputeTotals(rows []LineItem, s Site, p Plan, take Takeoff) Totals {
	t, wf := s.Terrain, s.Labor.WageFactor
	if wf == 0 {
		wf = 1
	}
	var uninst, inst float64
	for _, r := range rows {
		if r.Installed {
			inst += r.LineTotal
		} else {
			uninst += r.LineTotal
		}
	}
	labor := uninst * LaborFactor * wf
	earth := (float64(t.PadCutCY)*12 + float64(t.PadFillCY)*30) * wf // $/cy placeholders
	wall := 0.0
	if p.RetainingWallNeed {
		wall = math.Max(t.PadMaxCutFt, t.PadMaxFillFt) * take["footprint_side_ft"] * 45 * wf
	}
	total := uninst + inst + labor + earth + wall
	r := func(x float64) int { return int(math.Round(x)) }
	return Totals{r(uninst), r(inst), r(labor), r(earth), r(wall), r(total), r(total / take["gross_floor_sqft"]), wf}
}
