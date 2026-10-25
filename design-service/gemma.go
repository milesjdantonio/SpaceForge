package main

// Gemma: response types, prompts, the streaming REST client, and the
// ask → check → reprompt loop. Two short calls: site assessment, then materials.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var Foundations = []string{"slab_on_grade", "crawlspace", "stepped_footing", "full_basement",
	"walkout_basement", "pier_and_beam", "helical_piles", "none"}
var Verdicts = []string{"feasible", "feasible_with_mitigation", "not_feasible"}

type Assessment struct {
	EchoClimateZone   int
	EchoFloodZone     string
	EchoSDC           string
	EchoBestPadSlope  *float64
	EchoUSCS          string
	BearingPsf        *int
	Feasibility       string
	Risks             []string
	FoundationType    string
	FoundationReason  string
	RetainingWallNeed bool
}

type Pick struct {
	CatalogID string
	Room      *string
	Count     *int
	Reason    string
}

type MaterialList struct {
	Materials   []Pick
	Assumptions []string
}

type Plan struct {
	Assessment
	Materials   []Pick
	Assumptions []string
}

// ------------------------------------------------------------------ parsing (lenient, like pydantic)

func extractJSON(text string) (map[string]any, error) {
	if strings.HasSuffix(strings.TrimSpace(text), "[TRUNCATED]") {
		return nil, errors.New("the reply was cut off at the length limit. Return a shorter answer: " +
			"reasons of 8 words or fewer, no extra fields")
	}
	i, j := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if i < 0 || j < i {
		return nil, fmt.Errorf("no JSON object found (reply started: %q). Reply with only the JSON object",
			truncate(strings.TrimSpace(text), 120))
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(text[i:j+1]), &m); err != nil {
		var se *json.SyntaxError
		if errors.As(err, &se) {
			return nil, fmt.Errorf("invalid JSON (%v at character %d)", se, se.Offset)
		}
		return nil, fmt.Errorf("invalid JSON (%v)", err)
	}
	return m, nil
}

type fieldErrs []string

func (f *fieldErrs) add(format string, a ...any) { *f = append(*f, fmt.Sprintf(format, a...)) }
func (f fieldErrs) err() error {
	if len(f) == 0 {
		return nil
	}
	return errors.New(strings.Join(f, "; "))
}

func asFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(x, "%")), 64)
		return f, err == nil
	}
	return 0, false
}

func asInt(v any) (int, bool) {
	f, ok := asFloat(v)
	if !ok || f != float64(int(f)) {
		return 0, false
	}
	return int(f), true
}

func asBool(v any) (bool, bool) {
	switch x := v.(type) {
	case bool:
		return x, true
	case string:
		b, err := strconv.ParseBool(strings.TrimSpace(x))
		return b, err == nil
	}
	return false, false
}

func asString(v any) (string, bool) {
	switch x := v.(type) {
	case string:
		return x, true
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64), true
	}
	return "", false
}

func asStrings(v any) ([]string, bool) {
	arr, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := []string{}
	for _, x := range arr {
		s, ok := asString(x)
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

func ParseAssessment(text string) (Assessment, error) {
	m, err := extractJSON(text)
	if err != nil {
		return Assessment{}, err
	}
	var a Assessment
	var fe fieldErrs
	req := func(k string) (any, bool) {
		v, ok := m[k]
		if !ok {
			fe.add("%s: field required", k)
		}
		return v, ok
	}
	if v, ok := req("echo_climate_zone"); ok {
		if a.EchoClimateZone, ok = asInt(v); !ok {
			fe.add("echo_climate_zone: must be an integer")
		}
	}
	for _, f := range []struct {
		k   string
		dst *string
	}{{"echo_flood_zone", &a.EchoFloodZone}, {"echo_seismic_design_category", &a.EchoSDC},
		{"echo_governing_uscs_class", &a.EchoUSCS}, {"foundation_rationale", &a.FoundationReason}} {
		if v, ok := req(f.k); ok {
			if *f.dst, ok = asString(v); !ok {
				fe.add("%s: must be a string", f.k)
			}
		}
	}
	if v, ok := req("echo_best_pad_slope_percent"); ok && v != nil {
		if f, ok := asFloat(v); ok {
			a.EchoBestPadSlope = &f
		} else {
			fe.add("echo_best_pad_slope_percent: must be a number or null")
		}
	}
	if v, ok := req("presumptive_bearing_psf"); ok && v != nil {
		if n, ok := asInt(v); ok {
			a.BearingPsf = &n
		} else {
			fe.add("presumptive_bearing_psf: must be an integer or null")
		}
	}
	if v, ok := req("feasibility"); ok {
		a.Feasibility, _ = asString(v)
		if !contains(Verdicts, a.Feasibility) {
			fe.add("feasibility: must be one of %v", Verdicts)
		}
	}
	if v, ok := req("risks"); ok {
		if a.Risks, ok = asStrings(v); !ok {
			fe.add("risks: must be a list of strings")
		}
	}
	if v, ok := req("foundation_type"); ok {
		a.FoundationType, _ = asString(v)
		if !contains(Foundations, a.FoundationType) {
			fe.add("foundation_type: must be one of %v", Foundations)
		}
	}
	if v, ok := req("retaining_wall_needed"); ok {
		if a.RetainingWallNeed, ok = asBool(v); !ok {
			fe.add("retaining_wall_needed: must be true or false")
		}
	}
	return a, fe.err()
}

func ParseMaterials(text string) (MaterialList, error) {
	m, err := extractJSON(text)
	if err != nil {
		return MaterialList{}, err
	}
	var ml MaterialList
	var fe fieldErrs
	arr, ok := m["materials"].([]any)
	if !ok {
		return ml, errors.New("materials: field required (a list)")
	}
	for i, x := range arr {
		o, ok := x.(map[string]any)
		if !ok {
			fe.add("materials[%d]: must be an object", i)
			continue
		}
		var p Pick
		if p.CatalogID, ok = asString(o["catalog_id"]); !ok || p.CatalogID == "" {
			fe.add("materials[%d].catalog_id: field required", i)
		}
		if r, ok := o["room"]; ok && r != nil {
			s, ok := asString(r)
			if !ok {
				fe.add("materials[%d].room: must be a string or null", i)
			}
			p.Room = &s
		}
		if c, ok := o["count"]; ok && c != nil {
			n, ok := asInt(c)
			if !ok {
				fe.add("materials[%d].count: must be an integer or null", i)
			}
			p.Count = &n
		}
		p.Reason, _ = asString(o["reason"])
		ml.Materials = append(ml.Materials, p)
	}
	if v, ok := m["assumptions"]; ok && v != nil {
		ml.Assumptions, _ = asStrings(v)
	}
	return ml, fe.err()
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// ------------------------------------------------------------------ prompts

func catalogTable() string {
	var b strings.Builder
	b.WriteString("id | category | name | bought per | notes\n")
	for _, c := range CatalogList {
		scope := "whole house"
		switch {
		case c.Key == "count" && c.ShellCount:
			scope = "count, whole house"
		case c.Key == "count":
			scope = "count, per room"
		case RoomKeys[c.Key]:
			scope = "per room"
		}
		var notes []string
		if c.Installed {
			notes = append(notes, "installed=True")
		}
		if c.R > 0 {
			notes = append(notes, fmt.Sprintf("r=%g", c.R))
		}
		if c.U > 0 {
			notes = append(notes, fmt.Sprintf("u=%g", c.U))
		}
		if c.WindMph > 0 {
			notes = append(notes, fmt.Sprintf("wind_mph=%d", c.WindMph))
		}
		if c.Category == "flooring" {
			notes = append(notes, fmt.Sprintf("wet_ok=%s", pyBool(c.WetOK)))
		}
		if c.Category == "hvac" {
			notes = append(notes, fmt.Sprintf("cold_ok=%s", pyBool(c.ColdOK)))
		}
		if c.Ice {
			notes = append(notes, "ice=True")
		}
		if c.Role != "" {
			notes = append(notes, "role="+c.Role)
		}
		fmt.Fprintf(&b, "%s | %s | %s | %s | %s\n", c.ID, c.Category, c.Name, scope, strings.Join(notes, " "))
	}
	return b.String()
}

func pyBool(b bool) string {
	if b {
		return "True"
	}
	return "False"
}

func siteForPrompt(s Site) string {
	raw, _ := json.Marshal(s)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	delete(m, "labor")
	delete(m, "warnings")
	if soil, ok := m["soil"].(map[string]any); ok {
		var short []map[string]any
		for i, c := range s.Soil.Components {
			if i == 3 {
				break
			}
			short = append(short, map[string]any{"component": c.Component, "pct": c.Pct, "uscs": c.USCS, "lep": c.LEP})
		}
		soil["components"] = short
	}
	out, _ := json.MarshalIndent(m, "", " ")
	return string(out)
}

const foundationRules = `- pad slope over 15%: no slab_on_grade; over 30%: only pier_and_beam or helical_piles
- on slopes over 15% the building follows the land rather than a levelled pad: prefer stepped_footing,
  walkout_basement (where basements are allowed) or pier_and_beam
- high or very high shrink-swell: no slab_on_grade
- basements need bedrock AND water table deeper than 96 in; no basement in FEMA A or V zones
- FEMA V zones: only pier_and_beam or helical_piles
- footings go below the frost depth
- retaining_wall_needed = true only if pad_max_cut_ft or pad_max_fill_ft is over 4`

const assessExample = `{
 "echo_climate_zone": "<copy climate.climate_zone>",
 "echo_flood_zone": "<copy flood.flood_zone>",
 "echo_seismic_design_category": "<copy seismic.seismic_design_category>",
 "echo_best_pad_slope_percent": "<copy terrain.best_pad_slope_percent>",
 "echo_governing_uscs_class": "<copy soil.governing_uscs_class>",
 "presumptive_bearing_psf": "<int per IRC Table R401.4.1, or null if soil unknown>",
 "feasibility": "<feasible | feasible_with_mitigation | not_feasible>",
 "risks": ["<each risk with its measured value>"],
 "foundation_type": "<one of: slab_on_grade crawlspace stepped_footing full_basement walkout_basement pier_and_beam helical_piles none>",
 "foundation_rationale": "<one sentence>",
 "retaining_wall_needed": "<true | false>"
}`

func BuildAssessmentPrompt(s Site, in Interior) string {
	return BuildAssessmentPromptFor(s, fmt.Sprintf("%d stories, %d rooms", in.Stories, len(in.Rooms)))
}

// BuildAssessmentPromptFor asks for the site verdict for a described building.
func BuildAssessmentPromptFor(s Site, house string) string {
	t := s.Terrain
	fits := "DOES NOT FIT inside"
	if t.Fits {
		fits = "FITS inside"
	}
	return fmt.Sprintf(`You are a residential site-feasibility engineer. Judge whether this house can be
built on this lot, using ONLY the measured data below. Do not choose materials yet.

SITE DATA:
%s

HOUSE: %s. Footprint
%s ft. Buildable area inside the setbacks: %s ft.
So the footprint %s the buildable area (already checked by code).

Verdict:
- not_feasible ONLY if the footprint does not fit, or a measured hazard cannot
  reasonably be engineered around.
- feasible_with_mitigation if any hazard needs engineering (steep slope,
  shrink-swell, shallow bedrock or water table, cut/fill over 4 ft, flood zone,
  seismic D+, high wind, or unknown soil needing a geotechnical test).
- feasible only if none apply.
List every risk with its measured value. foundation_type "none" only if not_feasible.

Foundation rules:
%s

Reply with ONLY this JSON object (same keys, real values), no markdown, no prose:
%s`, siteForPrompt(s), house, t.FootprintFt, t.EnvelopeFt, fits, foundationRules, assessExample)
}

const materialsExample = `{"materials": [{"catalog_id": "batt_r21", "room": null, "count": null, "reason": "zone 4 needs R-20 walls"}, {"catalog_id": "lvp", "room": "<exact room name>", "count": null, "reason": "wet room"}, {"catalog_id": "toilet", "room": "<exact room name>", "count": 1, "reason": "bathroom fixture"}], "assumptions": ["<short>"]}`

func BuildMaterialsPrompt(s Site, in Interior, a Assessment) string {
	zone := s.Climate.ClimateZone
	var hzList []string
	for _, h := range hazardsOrdered(s) {
		hzList = append(hzList, h.desc)
	}
	hz := "none"
	if len(hzList) > 0 {
		hz = "[" + strings.Join(hzList, "; ") + "]"
	}
	rooms, _ := json.MarshalIndent(in.Rooms, "", " ")
	foundationItem := "a foundation_concrete item"
	if a.FoundationType == "helical_piles" {
		foundationItem = "helical_pile"
	}
	return fmt.Sprintf(`You are a residential construction estimator. The site assessment is done:
foundation = %s; hazards = %s.
Climate zone %d; flood zone %s; seismic %s;
max wind gust %d mph; soil %s (%s shrink-swell). Finish quality: %s.

ROOMS (use these exact names):
%s

CATALOG — choose only these ids. Code computes all quantities and prices.
%s
Rules:
- At least one item from each category: %s.
- Foundation: %s.
  Crawlspace or pier_and_beam: add insulation_floor and vapor_barrier. Basements: add
  waterproofing and foundation_drainage. Crawlspace in a FEMA A zone: add flood_vent.
- Wall insulation r values add up (cavity + continuous) to at least R-%g;
  attic insulation at least R-%g; window u at most %g.
- Climate zone 5+: ice_water_shield. Zone 6+: hvac with cold_ok=True.
- Wind gusts over 90 mph: roofing wind_mph 110+ and connectors. Seismic D+: connectors.
- Every room gets flooring with "room" set to its name. Kitchen, bathroom, half_bath and
  laundry need wet_ok=True flooring.
- Kitchen: per-room cabinets, countertops, kitchen_sink. Bathroom: toilet, a sink/vanity, a
  shower or tub. Half bath: toilet and a sink. Add an item for every listed feature in that room.
- "per room" and "count, per room" items need "room"; "whole house" items have room null.
  Set "count" (1-10) only on count items.
- Budget → cheaper options; high-end → premium ones.
- Keep each reason to 8 words or fewer.

Reply with ONLY one JSON object in this shape, no markdown, no prose:
%s`, a.FoundationType, hz, zone, s.Flood.FloodZone, s.Seismic.SDC, s.Climate.MaxWindGustMph,
		s.Soil.GoverningUSCS, s.Soil.ShrinkSwell, in.Quality, rooms, catalogTable(),
		strings.Join(ShellRequired, ", "), foundationItem, MinRWall[zone], MinRCeiling[zone], MaxWindowU[zone],
		materialsExample)
}

func Reprompt(errs []string) string {
	var b strings.Builder
	b.WriteString("Your previous JSON failed these checks against the measured data and building rules:\n")
	for i, e := range errs {
		fmt.Fprintf(&b, "%d. %s\n", i+1, e)
	}
	b.WriteString("\nFix ONLY these problems. Keep everything else the same unless a fix forces a\n" +
		"change. Do not explain. Return the complete corrected JSON object only.")
	return b.String()
}

// ------------------------------------------------------------------ streaming client

type Msg struct{ Role, Text string }

// AskFunc sends a conversation and returns the model's reply text.
type AskFunc func(msgs []Msg, maxTokens int) (string, error)

// EmptyReplyError means Gemma answered with no visible text (e.g. only hidden reasoning).
// HitLimit is true when it ran out of output tokens before writing the answer.
type EmptyReplyError struct {
	Detail   string
	HitLimit bool
}

func (e EmptyReplyError) Error() string { return "empty (" + e.Detail + ")" }

type Gemma struct {
	Key, Model string
	Timeout    time.Duration
	LogDir     string
	Out        io.Writer
	// Thinking is sent as generationConfig.thinkingConfig.thinkingLevel ("MINIMAL",
	// "LOW", "MEDIUM", "HIGH"); "" sends nothing and lets the model decide. Gemma 4
	// reasons by default and can spend its whole output allowance doing so.
	Thinking string
	// Ctx stops a call when the design is cancelled; nil means it runs to the end.
	Ctx      context.Context
	// NoRetry gives up on the first busy or slow answer instead of waiting to try again.
	NoRetry  bool
	jsonMode bool
	n        int
}

// ErrCancelled means the user stopped the design.
var ErrCancelled = errors.New("the design was cancelled")

func (g *Gemma) cancelled() bool { return g.Ctx != nil && g.Ctx.Err() != nil }

func NewGemma(key, model string, out io.Writer) *Gemma {
	return &Gemma{Key: key, Model: model, Timeout: 240 * time.Second, LogDir: "gemma_log", Out: out,
		Thinking: "MINIMAL", jsonMode: true}
}

// reply is one streamed answer.
type reply struct {
	text, thoughts, finish string
	thoughtTokens          int
}

var retryable = []string{"429", "500", "502", "503", "504", "UNAVAILABLE", "RESOURCE_EXHAUSTED", "DEADLINE",
	"timed out", "timeout", "Timeout", "overloaded", "deadline exceeded", "connection reset", "EOF"}

func (g *Gemma) Ask(msgs []Msg, maxTokens int) (string, error) {
	var r reply
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		if g.cancelled() {
			return "", ErrCancelled
		}
		r, err = g.streamOnce(msgs, maxTokens)
		if err == nil {
			break
		}
		if g.cancelled() {
			return "", ErrCancelled
		}
		msg := err.Error()
		low := strings.ToLower(msg)
		switch {
		case g.jsonMode && (strings.Contains(low, "mime") || strings.Contains(low, "json mode") ||
			strings.Contains(low, "responseschema")):
			g.jsonMode = false
			fmt.Fprintln(g.Out, "  (this model doesn't support JSON mode; asking for plain JSON text instead)")
			attempt--
			continue
		case g.Thinking != "" && strings.Contains(low, "think") && strings.Contains(msg, "400"):
			fmt.Fprintf(g.Out, "  (this model doesn't accept thinkingLevel %s; letting it decide)\n", g.Thinking)
			g.Thinking = ""
			attempt--
			continue
		case maxTokens > 1024 && strings.Contains(msg, "400") &&
			(strings.Contains(low, "max_output_tokens") || strings.Contains(low, "maxoutputtokens")):
			maxTokens /= 2
			fmt.Fprintf(g.Out, "  (output limit too high for this model; trying %d)\n", maxTokens)
			attempt--
			continue
		}
		if attempt < 3 && !g.NoRetry && containsAny(msg, retryable) {
			wait := time.Duration(15<<attempt) * time.Second
			fmt.Fprintf(g.Out, "  Gemma API busy/slow (%s). Retrying in %s...\n", truncate(msg, 90), wait)
			if g.Ctx != nil {
				select {
				case <-g.Ctx.Done():
					return "", ErrCancelled
				case <-time.After(wait):
				}
			} else {
				sleep(wait)
			}
			continue
		}
		return "", err
	}
	if err != nil {
		return "", err
	}
	g.n++
	logFile := filepath.Join(g.LogDir, fmt.Sprintf("reply_%d.txt", g.n))
	if g.LogDir != "" {
		_ = os.MkdirAll(g.LogDir, 0o755)
		_ = os.WriteFile(logFile, []byte(fmt.Sprintf("finish_reason: %s\nmax_output_tokens: %d\nreasoning_tokens: %d\n\n"+
			"=== answer ===\n%s\n\n=== hidden reasoning ===\n%s\n", r.finish, maxTokens, r.thoughtTokens, r.text, r.thoughts)), 0o644)
	}
	hitLimit := strings.Contains(r.finish, "MAX_TOKENS")
	if strings.TrimSpace(r.text) == "" {
		if g.LogDir == "" {
			return "", EmptyReplyError{fmt.Sprintf("finish_reason=%s after %d reasoning tokens", r.finish, r.thoughtTokens), hitLimit}
		}
		return "", EmptyReplyError{fmt.Sprintf("finish_reason=%s after %d reasoning tokens; saved to %s",
			r.finish, r.thoughtTokens, logFile), hitLimit}
	}
	if hitLimit {
		return r.text + "\n[TRUNCATED]", nil
	}
	return r.text, nil
}

func containsAny(s string, subs []string) bool {
	for _, x := range subs {
		if strings.Contains(s, x) {
			return true
		}
	}
	return false
}

func (g *Gemma) streamOnce(msgs []Msg, maxTokens int) (reply, error) {
	type part struct {
		Text string `json:"text"`
	}
	type content struct {
		Role  string `json:"role"`
		Parts []part `json:"parts"`
	}
	cfg := map[string]any{"temperature": 0.2, "maxOutputTokens": maxTokens}
	if g.jsonMode {
		cfg["responseMimeType"] = "application/json"
	}
	if g.Thinking != "" {
		cfg["thinkingConfig"] = map[string]any{"thinkingLevel": g.Thinking}
	}
	var contents []content
	for _, m := range msgs {
		contents = append(contents, content{m.Role, []part{{m.Text}}})
	}
	body, _ := json.Marshal(map[string]any{"contents": contents, "generationConfig": cfg})

	parent := g.Ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, g.Timeout)
	defer cancel()
	u := GeminiURL + "/v1beta/models/" + url.PathEscape(g.Model) + ":streamGenerateContent?alt=sse"
	req, _ := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", g.Key)

	var r reply
	start := time.Now()
	fmt.Fprint(g.Out, "  waiting")
	defer func() {
		extra := ""
		if r.thoughtTokens > 0 {
			extra = fmt.Sprintf(" (%d reasoning tokens)", r.thoughtTokens)
		}
		fmt.Fprintf(g.Out, " %.0fs%s\n", time.Since(start).Seconds(), extra)
	}()

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return r, fmt.Errorf("Gemma timed out after %s", g.Timeout)
		}
		return r, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return r, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(b), 300))
	}
	var text, thoughts strings.Builder
	rd := bufio.NewReader(resp.Body)
	for {
		line, err := rd.ReadString('\n')
		if strings.HasPrefix(line, "data:") {
			var ev struct {
				Candidates []struct {
					Content struct {
						Parts []struct {
							Text    string `json:"text"`
							Thought bool   `json:"thought"`
						} `json:"parts"`
					} `json:"content"`
					FinishReason string `json:"finishReason"`
				} `json:"candidates"`
				PromptFeedback struct {
					BlockReason string `json:"blockReason"`
				} `json:"promptFeedback"`
				Usage struct {
					ThoughtsTokenCount int `json:"thoughtsTokenCount"`
				} `json:"usageMetadata"`
				Error *struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
					Status  string `json:"status"`
				} `json:"error"`
			}
			if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &ev) == nil {
				if ev.Error != nil {
					return r, fmt.Errorf("HTTP %d %s: %s", ev.Error.Code, ev.Error.Status, ev.Error.Message)
				}
				if ev.PromptFeedback.BlockReason != "" {
					r.finish = "BLOCKED:" + ev.PromptFeedback.BlockReason
				}
				if ev.Usage.ThoughtsTokenCount > 0 {
					r.thoughtTokens = ev.Usage.ThoughtsTokenCount
				}
				for _, c := range ev.Candidates {
					if c.FinishReason != "" {
						r.finish = c.FinishReason
					}
					for _, p := range c.Content.Parts {
						if p.Thought { // hidden reasoning: logged, not parsed
							thoughts.WriteString(p.Text)
						} else {
							text.WriteString(p.Text)
						}
					}
				}
				fmt.Fprint(g.Out, ".")
			}
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			if ctx.Err() != nil {
				return r, fmt.Errorf("Gemma timed out after %s", g.Timeout)
			}
			return r, err
		}
	}
	r.text, r.thoughts = text.String(), thoughts.String()
	return r, nil
}

// ------------------------------------------------------------------ ask → check → reprompt

func AskUntilValid[T any](prompt string, parse func(string) (T, error), check func(T) []string,
	ask AskFunc, label string, maxTokens, maxAttempts int, out io.Writer) (T, error) {
	msgs := []Msg{{"user", prompt}}
	var errs []string
	var zero T
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		fmt.Fprintf(out, "Gemma: %s (attempt %d of %d)\n", label, attempt, maxAttempts)
		text, err := ask(msgs, maxTokens)
		var empty EmptyReplyError
		if errors.As(err, &empty) {
			errs = []string{"Your reply was " + empty.Error() + "."}
			fmt.Fprintf(out, "  reply was %s\n", empty.Error())
			if empty.HitLimit && maxTokens < 32768 {
				maxTokens *= 2
				fmt.Fprintf(out, "  (it ran out of room while reasoning; raising the output limit to %d)\n", maxTokens)
			}
			msgs = []Msg{{"user", prompt + "\n\nIMPORTANT: think briefly, then answer with the JSON object only."}}
			continue
		}
		if err != nil {
			return zero, err
		}
		obj, perr := parse(text)
		if perr != nil {
			errs = []string{"Output was not valid JSON in the requested shape: " + truncate(perr.Error(), 500)}
		} else {
			errs = check(obj)
		}
		if len(errs) == 0 {
			return obj, nil
		}
		fmt.Fprintf(out, "  %d problem(s):\n    - %s\n", len(errs), strings.Join(errs, "\n    - "))
		msgs = append(msgs, Msg{"model", text}, Msg{"user", Reprompt(errs)})
	}
	return zero, fmt.Errorf("Gemma's %s still fails after %d tries (raw replies are in gemma_log/). Problems:\n- %s",
		label, maxAttempts, strings.Join(errs, "\n- "))
}

func PlanHouse(s Site, in Interior, ask AskFunc, out io.Writer) (Plan, error) {
	a, err := AskUntilValid(BuildAssessmentPrompt(s, in), ParseAssessment,
		func(a Assessment) []string { return ValidateAssessment(a, s) }, ask, "site assessment", 8192, 3, out)
	if err != nil {
		return Plan{}, err
	}
	fmt.Fprintf(out, "  verdict: %s, foundation: %s\n", humanize(a.Feasibility), humanize(a.FoundationType))
	if a.Feasibility == "not_feasible" {
		return Plan{Assessment: a}, nil
	}
	ml, err := AskUntilValid(BuildMaterialsPrompt(s, in, a), ParseMaterials,
		func(ml MaterialList) []string { return ValidateMaterials(a, ml.Materials, s, in) }, ask,
		"material selection", 16384, 3, out)
	if err != nil {
		return Plan{}, err
	}
	return Plan{a, ml.Materials, ml.Assumptions}, nil
}

func humanize(s string) string { return strings.ReplaceAll(s, "_", " ") }
