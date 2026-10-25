// House feasibility, material selection and local cost — interactive.
//
// Run:  go run .                    (asks for everything)
//
//	go run . -inputs my.json    (reuse saved answers)
//	go build -o design-service .     (make a standalone program)
//
// Only free services, no payment or signup except the free Gemini API key:
//
//	soil       USDA Soil Data Access
//	elevation  USGS 3DEP ImageServer
//	climate    Open-Meteo historical weather
//	flood      FEMA National Flood Hazard Layer
//	seismic    USGS design maps
//	geocoding  OpenStreetMap Nominatim
//	suppliers  OpenStreetMap Overpass
//	wages      BLS public API v1 (no key, 25 requests/day)
//	AI         Gemma 4 on the Gemini API free tier
//
// No free API returns live retail prices, so materials come from the catalog in
// catalog.go (national baseline prices — edit them, or override any line with
// your own quotes in prices.csv). Labor and installed work are scaled by local
// construction wages from BLS. Uses only the Go standard library.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// loadKey reads the Gemini API key from a file (default APIKey.txt), looking in the
// current folder and then each parent folder. GEMINI_API_KEY is used only if no
// file is found. It says which source it used, showing just the key's ends.
func loadKey(name string) (string, string, error) {
	dir, _ := os.Getwd()
	candidates := []string{name}
	if !filepath.IsAbs(name) {
		candidates = nil
		for d := dir; ; d = filepath.Dir(d) {
			candidates = append(candidates, filepath.Join(d, name))
			if filepath.Dir(d) == d {
				break
			}
		}
	}
	for _, p := range candidates {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		key := cleanKey(b)
		if key == "" {
			return "", "", fmt.Errorf("%s is empty", p)
		}
		return key, p, nil
	}
	if k := cleanKey([]byte(os.Getenv("GEMINI_API_KEY"))); k != "" {
		return k, "the GEMINI_API_KEY environment variable", nil
	}
	return "", "", fmt.Errorf("no %s found in %s or its parent folders, and GEMINI_API_KEY isn't set "+
		"(free key: https://aistudio.google.com/apikey)", name, dir)
}

// cleanKey strips what Windows editors add: a UTF-8 byte-order mark, UTF-16 text
// (PowerShell's `echo key > file`), quotes, and whitespace or newlines.
func cleanKey(b []byte) string {
	if len(b) >= 2 && (b[0] == 0xFF && b[1] == 0xFE || b[0] == 0xFE && b[1] == 0xFF) {
		le := b[0] == 0xFF
		var r []rune
		for i := 2; i+1 < len(b); i += 2 {
			if le {
				r = append(r, rune(b[i])|rune(b[i+1])<<8)
			} else {
				r = append(r, rune(b[i])<<8|rune(b[i+1]))
			}
		}
		b = []byte(string(r))
	}
	s := strings.TrimPrefix(string(b), "\xef\xbb\xbf")
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "\"'")
	return strings.TrimSpace(s)
}

func maskKey(k string) string {
	if len(k) <= 10 {
		return strings.Repeat("*", len(k))
	}
	return k[:4] + "…" + k[len(k)-4:] + fmt.Sprintf(" (%d characters)", len(k))
}

func loadConfig(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	for i := range c.Interior.Rooms {
		if c.Interior.Rooms[i].Features == nil {
			c.Interior.Rooms[i].Features = []string{}
		}
	}
	return c, nil
}

func run() error {
	inputs := flag.String("inputs", "", "load answers from a JSON file instead of asking")
	model := flag.String("model", firstNonEmpty(os.Getenv("GEMMA_MODEL"), DefaultModel), "Gemma model name")
	keyFile := flag.String("keyfile", "APIKey.txt", "file holding your Gemini API key")
	thinking := flag.String("thinking", "minimal", "how much Gemma reasons before answering: minimal, low, medium, high, or default")
	request := flag.String("request", "", "TerraSim design request JSON (website format); writes design + estimate + report")
	outPath := flag.String("out", "", "where to write the result JSON (default: <request>.result.json)")
	serveMode := flag.Bool("serve", false, "run the TerraSim website and design API (see server.go)")
	defaultAddr := ":8000"
	if port := os.Getenv("PORT"); port != "" {
		defaultAddr = ":" + port // hosts like Render say which port to listen on
	}
	addr := flag.String("addr", defaultAddr, "address for -serve (default :8000, or :$PORT when PORT is set)")
	siteDir := flag.String("site", filepath.Join("..", "website"), "the website folder for -serve")
	fake := flag.Bool("fake", false, "with -serve: answer every Gemma step at once with a stand-in (no API key, no wait), for testing the website")
	flag.Parse()

	newGemma := func() (*Gemma, error) {
		key, src, err := loadKey(*keyFile)
		if err != nil {
			return nil, err
		}
		fmt.Printf("Using the API key from %s\n", src)
		g := NewGemma(key, *model, os.Stdout)
		if t := strings.ToUpper(strings.TrimSpace(*thinking)); t == "DEFAULT" || t == "" {
			g.Thinking = ""
		} else {
			g.Thinking = t
		}
		return g, nil
	}
	if *serveMode {
		return serve(*addr, *siteDir, *model, *keyFile, newGemma, *fake)
	}
	if *request != "" {
		return runRequestFile(*request, *outPath, newGemma)
	}

	w := NewWizard(os.Stdin, os.Stdout)
	var cfg Config
	var err error
	switch {
	case *inputs != "":
		cfg, err = loadConfig(*inputs)
	case fileExists("inputs.json") && w.Yes("Use the saved answers in inputs.json?", false):
		cfg, err = loadConfig("inputs.json")
	default:
		cfg = CollectInputs(w, Geocode)
		if w.Yes("Save these answers to inputs.json for next time?", true) {
			b, _ := json.MarshalIndent(cfg, "", "  ")
			if err := os.WriteFile("inputs.json", b, 0o644); err != nil {
				fmt.Println("Couldn't save inputs.json:", err)
			}
		}
	}
	if err != nil {
		return err
	}
	if probs := CheckInputs(cfg); len(probs) > 0 {
		return errors.New("input problems:\n- " + strings.Join(probs, "\n- "))
	}
	g, err := newGemma()
	if err != nil {
		return err
	}
	site, err := GatherSite(cfg, os.Stdout)
	if err != nil {
		return err
	}
	plan, err := PlanHouse(site, cfg.Interior, g.Ask, os.Stdout)
	if err != nil {
		return err
	}
	sups, err := FetchSuppliers(cfg.Location.Lat, cfg.Location.Lon, SearchRadiusKm)
	if err != nil {
		fmt.Printf("Supplier search unavailable (%v).\n", err)
	}
	take := ComputeTakeoff(cfg.Interior)
	var rows []LineItem
	var tot *Totals
	if plan.Feasibility != "not_feasible" {
		ov, err := LoadOverrides("prices.csv")
		if err != nil {
			return err
		}
		rows = LineItems(plan, take, site, sups, ov)
		t := ComputeTotals(rows, site, plan, take)
		tot = &t
	}
	return PrintReport(os.Stdout, cfg, site, plan, rows, tot, sups, "cost_report.csv", "prices.csv")
}

// runRequestFile runs the TerraSim pipeline on a request file and writes the result JSON.
func runRequestFile(path, outPath string, newGemma func() (*Gemma, error)) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if outPath == "" {
		outPath = strings.TrimSuffix(path, filepath.Ext(path)) + ".result.json"
	}
	g, err := newGemma()
	if err != nil {
		return err
	}
	ov, err := LoadOverrides("prices.csv")
	if err != nil {
		return err
	}
	res, runErr := RunRequest(raw, LiveDeps(g.Ask, os.Stdout, ov))
	if res != nil {
		b, _ := json.MarshalIndent(res, "", "  ")
		if err := os.WriteFile(outPath, b, 0o644); err != nil {
			return err
		}
		summarize(os.Stdout, res, outPath)
	}
	return runErr
}

func summarize(w io.Writer, res *Output, outPath string) {
	rep := res.Report
	fmt.Fprintf(w, "\nVerdict: %s\n", humanize(rep.Verdict))
	for _, p := range rep.Problems {
		fmt.Fprintf(w, "  problem: %s\n", p)
	}
	if res.Design != nil {
		d := res.Design
		fmt.Fprintf(w, "%s — %s\n", d.Overview.Title, d.Overview.Summary)
		fmt.Fprintf(w, "%.1f × %.1f m, %.1f m tall, %d floors, %d homes, %d bedrooms, %g baths, %.0f m² finished, %.0f m² gross\n",
			d.Size.WidthM, d.Size.DepthM, d.Size.HeightM, d.Totals.Floors, d.Totals.UnitCount, d.Totals.Bedrooms,
			d.Totals.Bathrooms, d.Totals.FinishedAreaM2, d.Totals.GrossAreaM2)
	}
	if cs := rep.CostSummary; cs != nil && res.Estimate != nil {
		bc := res.Estimate.BuildCost
		fmt.Fprintf(w, "Build cost: $%s expected ($%s – $%s, %s confidence), $%.0f/sq ft\n",
			commas(int(bc.Expected)), commas(int(bc.Low)), commas(int(bc.High)), bc.Confidence, bc.PerSqFt)
		for _, l := range bc.Lines {
			fmt.Fprintf(w, "  %-48s $%12s\n", l.Name, commas(int(l.Amount)))
		}
		fmt.Fprintf(w, "%d material lines, %d nearby suppliers.\n", len(rep.LineItems), len(rep.Suppliers))
	}
	for _, c := range rep.Warnings {
		fmt.Fprintf(w, "  note: %s\n", c)
	}
	fmt.Fprintf(w, "Full result written to %s\n", outPath)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func main() {
	defer func() {
		if r := recover(); r != nil {
			if r == ErrInputEnded {
				fmt.Println("\nInput ended; nothing was run.")
				os.Exit(1)
			}
			panic(r)
		}
	}()
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
