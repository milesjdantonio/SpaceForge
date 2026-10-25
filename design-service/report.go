package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

func commas(n int) string {
	s := strconv.Itoa(n)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

func money(x float64) string {
	whole := int(x)
	cents := int((x-float64(whole))*100 + 0.5)
	if cents == 100 {
		whole, cents = whole+1, 0
	}
	return fmt.Sprintf("%s.%02d", commas(whole), cents)
}

func pad(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s + strings.Repeat(" ", n-len(r))
}

func optF(p *float64) string {
	if p == nil {
		return "None"
	}
	return strconv.FormatFloat(*p, 'f', -1, 64)
}

func PrintReport(out io.Writer, cfg Config, s Site, p Plan, rows []LineItem, tot *Totals, sups []Supplier, csvPath, priceCSV string) error {
	l := s.Location
	fmt.Fprintf(out, "\n=== %s %s, %s %s ===\n", cfg.Location.Label, l.City, l.State, l.Zip)
	for _, w := range s.Warnings {
		fmt.Fprintf(out, "  note: %s\n", w)
	}
	fmt.Fprintf(out, "Climate zone %d · flood zone %s · seismic %s · soil %s (%s shrink-swell) · pad slope %s%%\n",
		s.Climate.ClimateZone, s.Flood.FloodZone, s.Seismic.SDC, s.Soil.GoverningUSCS, s.Soil.ShrinkSwell, optF(s.Terrain.BestPadSlope))
	if s.Soil.Note != "" {
		fmt.Fprintf(out, "Soil: %s\n", s.Soil.Note)
	}
	fmt.Fprintf(out, "Elevation: %s; pad: %s\n", s.Terrain.ElevationSource, s.Terrain.PadMethod)
	fmt.Fprintf(out, "Footprint %s ft · buildable area %s ft\n", s.Terrain.FootprintFt, s.Terrain.EnvelopeFt)
	fmt.Fprintf(out, "Verdict: %s   Foundation: %s\n", humanize(p.Feasibility), humanize(p.FoundationType))
	for _, r := range p.Risks {
		fmt.Fprintf(out, "  risk: %s\n", r)
	}
	if len(rows) == 0 || tot == nil {
		return nil
	}
	fmt.Fprintf(out, "\n%s %s %6s %s %9s %10s  Buy at\n", pad("Item", 44), pad("Room", 15), "Qty", pad("Unit", 7), "Unit $", "Total $")
	for _, r := range rows {
		fmt.Fprintf(out, "%s %s %6d %s %9s %10s  %s\n", pad(r.Item, 44), pad(r.Room, 15), r.Qty, pad(r.Unit, 7),
			money(r.UnitPrice), commas(int(r.LineTotal+0.5)), r.BuyAt)
	}
	fmt.Fprintf(out, "\nMaterials      $%10s\n", commas(tot.Materials))
	fmt.Fprintf(out, "Installed work $%10s   (HVAC, electrical, plumbing, etc.)\n", commas(tot.Installed))
	fmt.Fprintf(out, "Labor          $%10s   (local wage factor %g)\n", commas(tot.Labor), tot.WageFactor)
	fmt.Fprintf(out, "Earthwork      $%10s\n", commas(tot.Earthwork))
	if tot.Wall > 0 {
		fmt.Fprintf(out, "Retaining wall $%10s\n", commas(tot.Wall))
	}
	fmt.Fprintf(out, "TOTAL          $%10s   ($%d/sq ft)\n", commas(tot.Total), tot.PerSqft)
	if len(sups) > 0 {
		fmt.Fprintf(out, "\nNearby suppliers within %d km:\n", SearchRadiusKm)
		for i, sp := range sups {
			if i == 15 {
				break
			}
			fmt.Fprintf(out, "  %5.1f mi  %s [%s]  %s  %s  %s\n", sp.Miles, sp.Name, sp.Type, sp.Address, sp.Phone, sp.Website)
		}
	} else {
		fmt.Fprintln(out, "\nNo suppliers found nearby in OpenStreetMap.")
	}
	if err := writeCSV(csvPath, rows); err != nil {
		return err
	}
	fmt.Fprintf(out, "\nLine items saved to %s. Baseline prices are national estimates — put your local quotes "+
		"in %s (catalog_id,unit_price,supplier) to replace them.\n", csvPath, priceCSV)
	return nil
}

func writeCSV(path string, rows []LineItem) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	_ = w.Write([]string{"catalog_id", "category", "room", "item", "qty", "unit", "unit_price", "line_total",
		"installed", "price_source", "buy_at", "reason"})
	for _, r := range rows {
		_ = w.Write([]string{r.CatalogID, r.Category, r.Room, r.Item, strconv.Itoa(r.Qty), r.Unit,
			strconv.FormatFloat(r.UnitPrice, 'f', 2, 64), strconv.FormatFloat(r.LineTotal, 'f', 2, 64),
			pyBool(r.Installed), r.PriceSource, r.BuyAt, r.Reason})
	}
	w.Flush()
	return w.Error()
}
