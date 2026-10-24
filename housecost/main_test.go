package main

// Offline tests. Every outside service is replaced by a local fake server, so
// the real HTTP, parsing and checking code runs.  go test ./...

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func init() { sleep = func(time.Duration) {} }

func sp(s string) *string { return &s }
func ip(n int) *int       { return &n }

// ------------------------------------------------------------------ fixtures

func testInterior() Interior {
	return Interior{Stories: 1, Quality: "budget", Rooms: []Room{
		{"Kitchen", "kitchen", 1, 12, 14, []string{"electric range"}},
		{"Living room", "living", 1, 15, 16, []string{}},
		{"Primary Bedroom", "bedroom", 1, 13, 14, []string{}},
		{"Bedroom B", "bedroom", 1, 12, 13, []string{}},
		{"Full bathroom", "bathroom", 1, 8, 6, []string{"tub/shower combo"}},
		{"Laundry room", "laundry", 1, 6, 6, []string{"washer"}},
	}}
}

func slopedGrid(rows, cols int, res, slopePct float64) Grid {
	z := make([]float64, rows*cols)
	for i := 0; i < rows; i++ {
		for j := 0; j < cols; j++ {
			z[i*cols+j] = 600 + float64(i)*res*slopePct/100
		}
	}
	return Grid{rows, cols, res, z}
}

func testSite(t *testing.T) (Site, Interior, Takeoff) {
	in := testInterior()
	take := ComputeTakeoff(in)
	soil := SummarizeSoil([]map[string]any{
		{"muname": "Urban land-Groseclose", "compname": "Urban land", "comppct_r": "60"},
		{"muname": "Urban land-Groseclose", "compname": "Groseclose", "comppct_r": "35", "brockdepmin": "152", "uscs": "CL", "lep_max": "4.5"},
	})
	sb := Setbacks{25, 20, 7}
	s := Site{
		Location: LocInfo{"24060", "Blacksburg", "Montgomery County", "Virginia", "VA"},
		Climate:  Climate{ClimateZone: 4, HDD65: 4800, CDD50: 3000, RecordLowF: -2, AnnualPrecipIn: 40, AnnualSnowfallIn: 20, MaxWindGustMph: 62, FrostDepthIn: 24},
		Flood:    Flood{"X", false}, Seismic: Seismic{SDC: "B"}, Soil: soil,
		Terrain: AnalyzeTerrain(slopedGrid(37, 21, 1, 3.7), take["footprint_side_ft"], sb),
		Labor:   Labor{WageFactor: 0.92}, Setbacks: sb, LotFt: [2]float64{70, 120},
	}
	return s, in, take
}

func goodAssessment(s Site) map[string]any {
	return map[string]any{"echo_climate_zone": 4, "echo_flood_zone": "X", "echo_seismic_design_category": "B",
		"echo_best_pad_slope_percent": *s.Terrain.BestPadSlope, "echo_governing_uscs_class": "CL",
		"presumptive_bearing_psf": 1500, "feasibility": "feasible", "risks": []string{"none significant"},
		"foundation_type": "slab_on_grade", "foundation_rationale": "3.7% slope, moderate shrink-swell",
		"retaining_wall_needed": false}
}

func goodMaterials(in Interior) map[string]any {
	var m []map[string]any
	P := func(id string, room any, count any) {
		m = append(m, map[string]any{"catalog_id": id, "room": room, "count": count, "reason": "zone 4"})
	}
	for _, id := range []string{"ready_mix_3000", "rebar_4", "vapor_barrier", "spf_2x6", "osb_716", "house_wrap",
		"synthetic_underlay", "shingle_arch", "vinyl_siding", "window_double", "door_steel", "int_door_hollow",
		"batt_r21", "blown_r60", "drywall", "paint_interior", "hvac_hp", "electrical", "plumbing_rough", "lighting"} {
		P(id, nil, nil)
	}
	P("water_heater_tank", nil, 1)
	for _, r := range in.Rooms {
		rt, _ := roomType(r.Type)
		if rt.Wet {
			P("lvp", r.Name, nil)
		} else {
			P("laminate", r.Name, nil)
		}
	}
	P("cab_stock", "Kitchen", nil)
	P("counter_laminate", "Kitchen", nil)
	P("kitchen_sink", "Kitchen", 1)
	P("electric_range", "Kitchen", 1)
	P("toilet", "Full bathroom", 1)
	P("vanity_single", "Full bathroom", 1)
	P("tub_shower_combo", "Full bathroom", 1)
	P("washer", "Laundry room", 1)
	return map[string]any{"materials": m, "assumptions": []string{"8 ft ceilings"}}
}

func js(v any) string { b, _ := json.Marshal(v); return string(b) }

// ------------------------------------------------------------------ geometry + data

func TestUTM(t *testing.T) {
	z := UTMZone(-80.4139)
	e, n := ToUTM(37.2296, -80.4139, z)
	if z != 17 || e < 550000 || e > 554000 || n < 4118000 || n > 4124000 {
		t.Fatalf("Blacksburg UTM looks wrong: zone %d, %.0f E, %.0f N", z, e, n)
	}
	// on the central meridian, easting is exactly 500 km
	if e0, _ := ToUTM(37, -81, 17); math.Abs(e0-500000) > 0.01 {
		t.Fatalf("central meridian easting %.3f", e0)
	}
}

func TestTerrain(t *testing.T) {
	sb := Setbacks{25, 20, 7}
	tr := AnalyzeTerrain(slopedGrid(37, 21, 1, 8), 30.9, sb)
	if !tr.Fits || tr.EnvelopeFt != "56 x 75" || tr.FootprintFt != "31 x 31" {
		t.Fatalf("envelope: %+v", tr)
	}
	if math.Abs(*tr.BestPadSlope-8) > 0.05 || tr.PadCutCY < 10 || tr.PadCutCY > 16 || tr.PadMethod[:9] != "flattest " {
		t.Fatalf("pad: slope %v cut %d method %s", *tr.BestPadSlope, tr.PadCutCY, tr.PadMethod)
	}
	// the crash you hit: a grid far too coarse to slide the footprint across
	coarse := AnalyzeTerrain(slopedGrid(4, 2, 10, 8), 30.9, sb)
	if coarse.BestPadSlope == nil || !strings.HasPrefix(coarse.PadMethod, "estimated") {
		t.Fatalf("coarse fallback: %+v", coarse)
	}
	// tiny lot: footprint doesn't fit
	small := AnalyzeTerrain(slopedGrid(18, 12, 1, 3), 30.9, Setbacks{25, 20, 8})
	if small.Fits || small.BestPadSlope != nil {
		t.Fatalf("small lot should not fit: %+v", small)
	}
}

func TestSoilUrbanLand(t *testing.T) {
	s := SummarizeSoil([]map[string]any{
		{"muname": "U", "compname": "Urban land", "comppct_r": "60"},
		{"muname": "U", "compname": "Groseclose", "comppct_r": "30", "brockdepmin": "152", "uscs": "CH", "lep_max": "7.1"},
		{"muname": "U", "compname": "Minor sand", "comppct_r": "5", "uscs": "SM", "lep_max": "0.5"},
	})
	if s.GoverningUSCS != "CH" || *s.GoverningBearing != 1500 || s.ShrinkSwell != "high" || *s.MinBedrockIn != 60 ||
		!strings.Contains(s.Note, "Urban land") {
		t.Fatalf("soil: %+v", s)
	}
	if BearingFor("CL-ML") != 1500 || BearingFor("SM") != 2000 || BearingFor("GP") != 3000 || BearingFor("") != 0 {
		t.Fatal("bearing lookup")
	}
	empty := SummarizeSoil([]map[string]any{{"muname": "U", "compname": "Urban land", "comppct_r": "100"}})
	if empty.GoverningUSCS != "unknown" || empty.GoverningBearing != nil {
		t.Fatalf("no-data soil: %+v", empty)
	}
}

func TestClimateZone(t *testing.T) {
	mk := func(meanF float64) Daily {
		d := Daily{}
		for i := 0; i < 3653; i++ {
			v := meanF - 20*math.Cos(2*math.Pi*float64(i%365)/365)
			lo, p, g := v-10, 0.1, 40.0
			d.Time = append(d.Time, "x")
			d.TMean, d.TMin = append(d.TMean, &v), append(d.TMin, &lo)
			d.Precip, d.Snow, d.WindGusts = append(d.Precip, &p), append(d.Snow, &p), append(d.WindGusts, &g)
		}
		return d
	}
	if z := SummarizeClimate(mk(52)).ClimateZone; z != 4 {
		t.Fatalf("Blacksburg-like climate gave zone %d", z)
	}
	if z := SummarizeClimate(mk(38)).ClimateZone; z < 6 {
		t.Fatalf("cold climate gave zone %d", z)
	}
}

// ------------------------------------------------------------------ wizard

func TestWizard(t *testing.T) {
	answers := strings.Join([]string{
		"Paris, France", "y", // found, but outside the US → asked again
		"100 Main St, Blacksburg", "y",
		"Enter", "", "abc", "25", "", "7", // literal "Enter" and a non-number are handled
		"1", "1", // 1 story, budget
		"1",                            // empty list
		"1", "4", "12", "", "13", "14", // bedroom: numeric name rejected, default kept
		"1", "1", "Kitchen", "12", "14", "3,6", // kitchen with electric range + dishwasher
		"2", "1", // remove room 1 (the bedroom)
		"3",
	}, "\n") + "\n"
	var out bytes.Buffer
	w := NewWizard(strings.NewReader(answers), &out)
	geo := func(q string) (float64, float64, string, bool, error) {
		if strings.Contains(q, "Paris") {
			return 48.85, 2.35, "Paris", true, nil
		}
		return 37.2296, -80.4139, "Main St, Blacksburg, VA", true, nil
	}
	c := CollectInputs(w, geo)
	if c.Location.Lat != 37.2296 || c.LotFt != [2]float64{80, 150} || c.SetbacksFt != (Setbacks{25, 20, 7}) {
		t.Fatalf("site answers: %+v", c)
	}
	if c.Interior.Stories != 1 || c.Interior.Quality != "budget" || len(c.Interior.Rooms) != 1 {
		t.Fatalf("house answers: %+v", c.Interior)
	}
	k := c.Interior.Rooms[0]
	if k.Name != "Kitchen" || k.LengthFt != 12 || strings.Join(k.Features, ",") != "electric range,dishwasher" {
		t.Fatalf("kitchen: %+v", k)
	}
	o := out.String()
	for _, want := range []string{"US only", "Please enter a number", "can't be just a number"} {
		if !strings.Contains(o, want) {
			t.Errorf("wizard output missing %q", want)
		}
	}
	if p := CheckInputs(c); len(p) != 0 {
		t.Fatalf("valid config flagged: %v", p)
	}
}

func TestLoadPythonInputs(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "inputs.json")
	os.WriteFile(f, []byte(`{"location": {"lat": 37.2296, "lon": -80.4139, "label": ""},
	 "lot_ft": [70.0, 120.0], "setbacks_ft": {"front": 25.0, "rear": 20.0, "side": 7.0},
	 "interior": {"stories": 1, "quality": "budget", "rooms": [
	   {"name": "Kitchen", "type": "kitchen", "floor": 1, "length_ft": 12.0, "width_ft": 14.0, "features": ["electric range"]}]}}`), 0o644)
	c, err := loadConfig(f)
	if err != nil || c.LotFt[1] != 120 || c.Interior.Rooms[0].Features[0] != "electric range" {
		t.Fatalf("python inputs.json: %v %+v", err, c)
	}
	c.Interior.Rooms[0].Floor = 3
	if p := CheckInputs(c); len(p) != 1 || !strings.Contains(p[0], "floor") {
		t.Fatalf("bad floor not caught: %v", p)
	}
}

// ------------------------------------------------------------------ checks

func TestRejectsWrongNotFeasible(t *testing.T) {
	s, _, _ := testSite(t)
	a := goodAssessment(s)
	a["feasibility"], a["foundation_type"] = "not_feasible", "none"
	a["risks"] = []string{"Footprint 62x79 exceeds buildable area 56x75 based on setbacks"}
	got, err := ParseAssessment(js(a))
	if err != nil {
		t.Fatal(err)
	}
	e := ValidateAssessment(got, s)
	if len(e) != 1 || !strings.Contains(e[0], "31 x 31 ft footprint FITS the 56 x 75") {
		t.Fatalf("expected the fits/not_feasible error, got %v", e)
	}
}

func TestMaterialChecks(t *testing.T) {
	s, in, _ := testSite(t)
	a, _ := ParseAssessment(js(goodAssessment(s)))
	good, _ := ParseMaterials(js(goodMaterials(in)))
	if e := ValidateMaterials(a, good.Materials, s, in); len(e) != 0 {
		t.Fatalf("good materials rejected: %v", e)
	}
	bad := goodMaterials(in)
	var keep []map[string]any
	for _, m := range bad["materials"].([]map[string]any) {
		switch m["catalog_id"] {
		case "hvac_hp", "washer":
			continue
		case "batt_r21":
			m["catalog_id"] = "batt_r13"
		case "lvp":
			if m["room"] == "Full bathroom" {
				m["catalog_id"] = "carpet"
			}
		case "electrical":
			m["room"] = "Kitchen"
		}
		keep = append(keep, m)
	}
	keep = append(keep, map[string]any{"catalog_id": "granite_slab_xl", "room": "Kitchen"})
	bad["materials"] = keep
	ml, _ := ParseMaterials(js(bad))
	e := strings.Join(ValidateMaterials(a, ml.Materials, s, in), "\n")
	for _, want := range []string{"'granite_slab_xl' is not a catalog id", "electrical: whole-house item",
		"Missing required category 'hvac'", "R-13; climate zone 4 needs R-20", "carpet is not suitable",
		"feature 'washer'"} {
		if !strings.Contains(e, want) {
			t.Errorf("missing check %q in:\n%s", want, e)
		}
	}
}

func TestLenientParsing(t *testing.T) {
	s, _, _ := testSite(t)
	a := goodAssessment(s)
	a["echo_climate_zone"], a["retaining_wall_needed"], a["presumptive_bearing_psf"] = "4", "false", "1500"
	got, err := ParseAssessment("Sure! Here it is:\n```json\n" + js(a) + "\n```")
	if err != nil || got.EchoClimateZone != 4 || *got.BearingPsf != 1500 || got.RetainingWallNeed {
		t.Fatalf("lenient parse: %v %+v", err, got)
	}
	delete(a, "feasibility")
	if _, err := ParseAssessment(js(a)); err == nil || !strings.Contains(err.Error(), "feasibility: field required") {
		t.Fatalf("missing field: %v", err)
	}
	if _, err := ParseAssessment("I can't do that."); err == nil || !strings.Contains(err.Error(), "no JSON object") {
		t.Fatalf("no JSON: %v", err)
	}
}

// ------------------------------------------------------------------ Gemma over HTTP (fake server)

type step struct {
	status int
	events []string // SSE data payloads
}

func ev(text string, thought bool, finish string) string {
	return js(map[string]any{"candidates": []any{map[string]any{
		"content":      map[string]any{"role": "model", "parts": []any{map[string]any{"text": text, "thought": thought}}},
		"finishReason": finish}}})
}

func fakeGemini(t *testing.T, steps []step) (*httptest.Server, *[]map[string]any) {
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-goog-api-key") != "test-key" || !strings.Contains(r.URL.Path, ":streamGenerateContent") {
			t.Errorf("bad request %s key=%q", r.URL.Path, r.Header.Get("x-goog-api-key"))
		}
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		bodies = append(bodies, b)
		if len(steps) == 0 {
			t.Error("more Gemma calls than scripted")
			w.WriteHeader(500)
			return
		}
		st := steps[0]
		steps = steps[1:]
		if st.status != 200 {
			w.WriteHeader(st.status)
			io.WriteString(w, st.events[0])
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, e := range st.events {
			fmt.Fprintf(w, "data: %s\r\n\r\n", e)
			w.(http.Flusher).Flush()
		}
	}))
	return srv, &bodies
}

func newTestGemma(t *testing.T, srv *httptest.Server, out io.Writer) *Gemma {
	GeminiURL = srv.URL
	g := NewGemma("test-key", "gemma-test", out)
	g.LogDir = t.TempDir()
	return g
}

func TestGemmaTwoStageFlow(t *testing.T) {
	s, in, take := testSite(t)
	wrong := goodAssessment(s)
	wrong["feasibility"], wrong["foundation_type"] = "not_feasible", "none"
	badM := goodMaterials(in)
	badM["materials"] = badM["materials"].([]map[string]any)[1:] // drop the concrete
	full := js(wrong)
	srv, bodies := fakeGemini(t, []step{
		{503, []string{`{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}`}},
		{200, []string{ev("Let me think about the soil...", true, ""), ev("", false, "STOP")}}, // hidden reasoning only
		{200, []string{ev(full[:60], false, ""), ev(full[60:], false, "STOP")}},                // wrong verdict, streamed in pieces
		{200, []string{ev(js(goodAssessment(s)), false, "STOP")}},
		{200, []string{ev(js(badM), false, "STOP")}},
		{200, []string{ev(js(goodMaterials(in)), false, "STOP")}},
	})
	defer srv.Close()
	var out bytes.Buffer
	g := newTestGemma(t, srv, &out)
	plan, err := PlanHouse(s, in, g.Ask, &out)
	if err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	o := out.String()
	for _, want := range []string{"busy/slow", "reply was empty", "FITS the 56 x 75", "slab_on_grade needs a foundation_concrete item",
		"verdict: feasible, foundation: slab on grade"} {
		if !strings.Contains(o, want) {
			t.Errorf("log missing %q:\n%s", want, o)
		}
	}
	if plan.Feasibility != "feasible" || len(plan.Materials) != len(goodMaterials(in)["materials"].([]map[string]any)) {
		t.Fatalf("plan: %+v", plan.Assessment)
	}
	b := *bodies
	if len(b) != 6 {
		t.Fatalf("expected 6 calls, got %d", len(b))
	}
	gc := b[0]["generationConfig"].(map[string]any)
	if gc["responseMimeType"] != "application/json" || gc["maxOutputTokens"].(float64) != 8192 ||
		gc["thinkingConfig"].(map[string]any)["thinkingLevel"] != "MINIMAL" {
		t.Fatalf("assessment config: %v", gc)
	}
	if n := len(b[3]["contents"].([]any)); n != 3 { // prompt, wrong answer, reprompt
		t.Fatalf("reprompt should carry the conversation, got %d messages", n)
	}
	if b[4]["generationConfig"].(map[string]any)["maxOutputTokens"].(float64) != 16384 {
		t.Fatal("materials call should allow 16384 tokens")
	}

	rows := LineItems(plan, take, s, []Supplier{{Name: "Lowe's", Type: "doityourself", Miles: 6.1}}, nil)
	tot := ComputeTotals(rows, s, plan, take)
	if tot.PerSqft < 60 || tot.PerSqft > 200 {
		t.Fatalf("cost per sq ft %d looks wrong (total %d)", tot.PerSqft, tot.Total)
	}
	var rep bytes.Buffer
	csvPath := filepath.Join(t.TempDir(), "cost_report.csv")
	if err := PrintReport(&rep, Config{}, s, plan, rows, &tot, nil, csvPath, "prices.csv"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rep.String(), "TOTAL") || !strings.Contains(rep.String(), "local contractor (quote)") {
		t.Fatalf("report:\n%s", rep.String())
	}
	if b, _ := os.ReadFile(csvPath); !bytes.Contains(b, []byte("ready_mix_3000")) {
		t.Fatal("CSV missing line items")
	}
	t.Logf("total $%s ($%d/sq ft)", commas(tot.Total), tot.PerSqft)
}

func TestJSONModeFallbackAndTruncation(t *testing.T) {
	s, in, _ := testSite(t)
	a := js(goodAssessment(s))
	srv, bodies := fakeGemini(t, []step{
		{400, []string{`{"error":{"code":400,"message":"JSON mode is not enabled for models/gemma-test","status":"INVALID_ARGUMENT"}}`}},
		{200, []string{ev(a[:150], false, "MAX_TOKENS")}},
		{200, []string{ev("Here you go:\n```json\n"+a+"\n```", false, "STOP")}},
	})
	defer srv.Close()
	var out bytes.Buffer
	g := newTestGemma(t, srv, &out)
	got, err := AskUntilValid(BuildAssessmentPrompt(s, in), ParseAssessment,
		func(x Assessment) []string { return ValidateAssessment(x, s) }, g.Ask, "site assessment", 8192, 3, &out)
	if err != nil || got.Feasibility != "feasible" {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "doesn't support JSON mode") || !strings.Contains(out.String(), "cut off at the length limit") {
		t.Fatalf("log:\n%s", out.String())
	}
	if _, ok := (*bodies)[1]["generationConfig"].(map[string]any)["responseMimeType"]; ok {
		t.Fatal("JSON mode should be off after the 400")
	}
}

// ------------------------------------------------------------------ elevation + other APIs over HTTP

func floatTIFF(w, h int, v func(i, j int) float32) []byte {
	var b bytes.Buffer
	le := binary.LittleEndian
	data := make([]byte, w*h*4)
	for i := 0; i < h; i++ {
		for j := 0; j < w; j++ {
			le.PutUint32(data[(i*w+j)*4:], math.Float32bits(v(i, j)))
		}
	}
	b.WriteString("II")
	binary.Write(&b, le, uint16(42))
	binary.Write(&b, le, uint32(8))
	tags := [][3]uint32{{256, 4, uint32(w)}, {257, 4, uint32(h)}, {258, 3, 32}, {259, 3, 1}, {273, 4, 0},
		{277, 3, 1}, {278, 4, uint32(h)}, {279, 4, uint32(len(data))}, {339, 3, 3}}
	dataOff := uint32(8 + 2 + len(tags)*12 + 4)
	binary.Write(&b, le, uint16(len(tags)))
	for _, tg := range tags {
		val := tg[2]
		if tg[0] == 273 {
			val = dataOff
		}
		binary.Write(&b, le, uint16(tg[0]))
		binary.Write(&b, le, uint16(tg[1]))
		binary.Write(&b, le, uint32(1))
		if tg[1] == 3 {
			binary.Write(&b, le, uint16(val))
			binary.Write(&b, le, uint16(0))
		} else {
			binary.Write(&b, le, val)
		}
	}
	binary.Write(&b, le, uint32(0))
	b.Write(data)
	return b.Bytes()
}

func TestFetchDEM(t *testing.T) {
	var formats []string
	bsqWorks := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		formats = append(formats, q.Get("format"))
		var cols, rows int
		fmt.Sscanf(q.Get("size"), "%d,%d", &cols, &rows)
		if q.Get("bboxSR") != "32617" || q.Get("pixelType") != "F32" {
			t.Errorf("bad DEM query: %v", q)
		}
		elev := func(i, j int) float32 { return float32(600 + 0.05*float64(i)) }
		switch q.Get("format") {
		case "bsq":
			if !bsqWorks {
				io.WriteString(w, `{"error":{"code":400,"message":"Invalid format"}}`)
				return
			}
			buf := make([]byte, rows*cols*4)
			for i := 0; i < rows; i++ {
				for j := 0; j < cols; j++ {
					v := elev(i, j)
					if i == 0 && j == 0 {
						v = -3.4e38 // nodata
					}
					binary.LittleEndian.PutUint32(buf[(i*cols+j)*4:], math.Float32bits(v))
				}
			}
			w.Write(buf)
		case "tiff":
			w.Write(floatTIFF(cols, rows, elev))
		}
	}))
	defer srv.Close()
	DemURL = srv.URL
	g, src, err := FetchDEM(37.2296, -80.4139, [2]float64{70, 120})
	if err != nil || g.Rows != 37 || g.Cols != 21 || !math.IsNaN(g.Z[0]) || math.Abs(g.Z[g.Cols]-600.05) > 1e-3 {
		t.Fatalf("bsq: %v rows=%d cols=%d z0=%v z1=%v", err, g.Rows, g.Cols, g.Z[0], g.Z[g.Cols])
	}
	if !strings.Contains(src, "3DEP") {
		t.Fatal(src)
	}
	bsqWorks = false
	g, _, err = FetchDEM(37.2296, -80.4139, [2]float64{70, 120})
	if err != nil || g.Rows != 37 || math.Abs(g.Z[5*g.Cols]-600.25) > 1e-3 {
		t.Fatalf("tiff fallback: %v %+v", err, g.Rows)
	}
	if strings.Join(formats, ",") != "bsq,bsq,tiff" {
		t.Fatalf("formats tried: %v", formats)
	}
	tr := AnalyzeTerrain(g, 30.9, Setbacks{25, 20, 7})
	if math.Abs(*tr.BestPadSlope-5) > 0.1 {
		t.Fatalf("slope from fetched DEM: %v", *tr.BestPadSlope)
	}
}

func TestOtherAPIs(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/reverse"):
			io.WriteString(w, `{"address":{"town":"Blacksburg","county":"Montgomery County","state":"Virginia","postcode":"24060","ISO3166-2-lvl4":"US-VA"}}`)
		case strings.HasPrefix(r.URL.Path, "/search"):
			io.WriteString(w, `[{"lat":"37.2296","lon":"-80.4139","display_name":"Blacksburg, VA"}]`)
		case r.URL.Path == "/fema":
			io.WriteString(w, `{"features":[{"attributes":{"FLD_ZONE":"AE","SFHA_TF":"T"}}]}`)
		case r.URL.Path == "/seismic":
			io.WriteString(w, `{"response":{"data":{"sdc":"B","sds":0.21}}}`)
		case r.URL.Path == "/sda":
			body, _ := io.ReadAll(r.Body)
			if !bytes.Contains(body, []byte("SDA_Get_Mukey_from_intersection_with_WktWgs84")) {
				t.Error("SDA query missing intersection function")
			}
			io.WriteString(w, `{"Table":[["muname","compname","comppct_r","majcompflag","brockdepmin","wtdepannmin","uscs","lep_max"],
				["Groseclose silt loam","Groseclose","85","Yes","152",null,"CL","4.5"]]}`)
		case r.URL.Path == "/bls":
			io.WriteString(w, `{"Results":{"series":[{"seriesID":"OEUS510000000000047203103","data":[{"value":"26.10"}]},
				{"seriesID":"OEUN000000000000047203103","data":[{"value":"29.00"}]}]}}`)
		case r.URL.Path == "/overpass":
			io.WriteString(w, `{"elements":[{"type":"node","lat":37.16,"lon":-80.42,"tags":{"name":"Lowe's","shop":"doityourself"}},
				{"type":"way","center":{"lat":37.23,"lon":-80.41},"tags":{"name":"Floor Store","shop":"flooring"}},
				{"type":"node","lat":37.3,"lon":-80.4,"tags":{"shop":"hardware"}}]}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	NominatimURL, FemaURL, SeismicURL, SdaURL, BlsURL, OverpassURL =
		srv.URL, srv.URL+"/fema", srv.URL+"/seismic", srv.URL+"/sda", srv.URL+"/bls", srv.URL+"/overpass"

	if l, err := FetchLocation(37.2296, -80.4139); err != nil || l.City != "Blacksburg" || l.StateCode != "VA" {
		t.Fatalf("location: %v %+v", err, l)
	}
	if lat, _, _, ok, err := Geocode("Blacksburg"); err != nil || !ok || lat != 37.2296 {
		t.Fatalf("geocode: %v", err)
	}
	if f, err := FetchFlood(37, -80); err != nil || f.FloodZone != "AE" || !f.InSFHA {
		t.Fatalf("flood: %v %+v", err, f)
	}
	if s, err := FetchSeismic(37, -80); err != nil || s.SDC != "B" || *s.SDS != 0.21 {
		t.Fatalf("seismic: %v %+v", err, s)
	}
	if s, err := FetchSoil(LotBBox(37.2296, -80.4139, [2]float64{70, 120})); err != nil || s.GoverningUSCS != "CL" || s.ShrinkSwell != "moderate" {
		t.Fatalf("soil: %v %+v", err, s)
	}
	if l, err := FetchWageFactor("VA"); err != nil || l.WageFactor != 0.9 {
		t.Fatalf("wages: %v %+v", err, l)
	}
	sups, err := FetchSuppliers(37.2296, -80.4139, 25)
	if err != nil || len(sups) != 2 || sups[0].Name != "Floor Store" {
		t.Fatalf("suppliers: %v %+v", err, sups)
	}
	if s := NearestSupplier("flooring", sups); s == nil || s.Name != "Floor Store" {
		t.Fatal("flooring should go to the flooring store")
	}
	if NearestSupplier("hvac", sups) != nil {
		t.Fatal("trades shouldn't fall back to a hardware store")
	}
}

func TestPriceOverrides(t *testing.T) {
	f := filepath.Join(t.TempDir(), "prices.csv")
	os.WriteFile(f, []byte("catalog_id,unit_price,supplier\nready_mix_3000,172,Roanoke Ready Mix\n"), 0o644)
	ov, err := LoadOverrides(f)
	if err != nil || ov["ready_mix_3000"].Price != 172 {
		t.Fatalf("%v %v", err, ov)
	}
	if ov, err := LoadOverrides(filepath.Join(t.TempDir(), "missing.csv")); err != nil || len(ov) != 0 {
		t.Fatal("missing prices.csv should be fine")
	}
	// count items get no waste; area items do
	take := Takeoff{"roof_sqft": 1000}
	if q := Quantity(Catalog["toilet"], Pick{Count: ip(1)}, take, nil); q != 1 {
		t.Fatalf("toilet qty %d", q)
	}
	if q := Quantity(Catalog["shingle_arch"], Pick{}, take, nil); q != 34 {
		t.Fatalf("shingle bundles %d", q)
	}
	_ = sp
}

func TestLoadKey(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "SpaceForge", "housecost")
	os.MkdirAll(sub, 0o755)
	// PowerShell 5 `echo key > APIKey.txt` writes UTF-16 with a byte-order mark
	utf16 := []byte{0xFF, 0xFE}
	for _, r := range "AQ.test-key-123\r\n" {
		utf16 = append(utf16, byte(r), 0)
	}
	os.WriteFile(filepath.Join(root, "APIKey.txt"), utf16, 0o644)
	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	os.Chdir(sub)
	t.Setenv("GEMINI_API_KEY", "env-key-should-lose")
	key, src, err := loadKey("APIKey.txt")
	if err != nil || key != "AQ.test-key-123" || !strings.HasSuffix(src, filepath.Join(filepath.Base(root), "APIKey.txt")) {
		t.Fatalf("parent-folder UTF-16 key: %q from %s (%v)", key, src, err)
	}
	// UTF-8 with BOM and quotes, in the current folder
	os.WriteFile(filepath.Join(sub, "APIKey.txt"), []byte("\xef\xbb\xbf\"AQ.local-key\"\n"), 0o644)
	if key, _, _ := loadKey("APIKey.txt"); key != "AQ.local-key" {
		t.Fatalf("BOM/quotes: %q", key)
	}
	if m := maskKey("AQ.Ab8RN6LOdZB3Mj"); m != "AQ.A…B3Mj (17 characters)" {
		t.Fatalf("mask: %s", m)
	}
}

// Your run: Gemma spends the whole allowance reasoning and returns no answer.
func TestReasoningEatsAllTokens(t *testing.T) {
	s, in, _ := testSite(t)
	usage := func(n int) string {
		return js(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{}},
			"finishReason": "MAX_TOKENS"}}, "usageMetadata": map[string]any{"thoughtsTokenCount": n}})
	}
	srv, bodies := fakeGemini(t, []step{
		{400, []string{`{"error":{"code":400,"message":"Thinking level is not supported for this model.","status":"INVALID_ARGUMENT"}}`}},
		{200, []string{ev("Considering the soil class CL and the 3.7% slope...", true, ""), usage(8190)}},
		{200, []string{ev(js(goodAssessment(s)), false, "STOP")}},
	})
	defer srv.Close()
	var out bytes.Buffer
	g := newTestGemma(t, srv, &out)
	a, err := AskUntilValid(BuildAssessmentPrompt(s, in), ParseAssessment,
		func(x Assessment) []string { return ValidateAssessment(x, s) }, g.Ask, "site assessment", 8192, 3, &out)
	if err != nil || a.Feasibility != "feasible" {
		t.Fatalf("%v\n%s", err, out.String())
	}
	o := out.String()
	for _, want := range []string{"doesn't accept thinkingLevel MINIMAL", "8190 reasoning tokens",
		"raising the output limit to 16384"} {
		if !strings.Contains(o, want) {
			t.Errorf("log missing %q:\n%s", want, o)
		}
	}
	b := *bodies
	if _, ok := b[1]["generationConfig"].(map[string]any)["thinkingConfig"]; ok {
		t.Fatal("thinkingConfig should be dropped after the 400")
	}
	if b[2]["generationConfig"].(map[string]any)["maxOutputTokens"].(float64) != 16384 {
		t.Fatal("limit should double after an empty MAX_TOKENS reply")
	}
	logged, _ := os.ReadFile(filepath.Join(g.LogDir, "reply_1.txt"))
	if !bytes.Contains(logged, []byte("Considering the soil class")) {
		t.Fatalf("reasoning should be saved in the log:\n%s", logged)
	}
}
