package main

// Free data sources: location, climate, flood, seismic, soil, wages, suppliers.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Endpoints are variables so tests can point them at local fake servers.
var (
	NominatimURL = "https://nominatim.openstreetmap.org"
	OpenMeteoURL = "https://archive-api.open-meteo.com/v1/archive"
	FemaURL      = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
	SeismicURL   = "https://earthquake.usgs.gov/ws/designmaps/asce7-22.json"
	SdaURL       = "https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest"
	BlsURL       = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
	OverpassURL  = "https://overpass-api.de/api/interpreter"
	DemURL       = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
	GeminiURL    = "https://generativelanguage.googleapis.com"

	httpClient = &http.Client{Timeout: 90 * time.Second}
	sleep      = time.Sleep // replaced in tests
)

func fetch(method, u string, body []byte, contentType string) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, u, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", UserAgent)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(data), 160))
	}
	return data, nil
}

func getJSON(u string, out any) error {
	data, err := fetch("GET", u, nil, "")
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func postJSON(u string, body []byte, contentType string, out any) error {
	data, err := fetch("POST", u, body, contentType)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// ---------------------------------------------------------------- location

type LocInfo struct {
	Zip       string `json:"zip"`
	City      string `json:"city"`
	County    string `json:"county"`
	State     string `json:"state"`
	StateCode string `json:"state_code"`
}

func Geocode(q string) (float64, float64, string, bool, error) {
	var res []struct {
		Lat, Lon    string
		DisplayName string `json:"display_name"`
	}
	u := NominatimURL + "/search?" + url.Values{"q": {q}, "format": {"jsonv2"}, "countrycodes": {"us"}, "limit": {"1"}}.Encode()
	if err := getJSON(u, &res); err != nil {
		return 0, 0, "", false, err
	}
	if len(res) == 0 {
		return 0, 0, "", false, nil
	}
	lat, _ := strconv.ParseFloat(res[0].Lat, 64)
	lon, _ := strconv.ParseFloat(res[0].Lon, 64)
	return lat, lon, res[0].DisplayName, true, nil
}

func FetchLocation(lat, lon float64) (LocInfo, error) {
	var res struct {
		Address map[string]string `json:"address"`
	}
	u := NominatimURL + "/reverse?" + url.Values{"lat": {ftoa(lat)}, "lon": {ftoa(lon)}, "format": {"jsonv2"}, "zoom": {"18"}}.Encode()
	if err := getJSON(u, &res); err != nil {
		return LocInfo{}, err
	}
	a := res.Address
	city := firstNonEmpty(a["city"], a["town"], a["village"])
	code := ""
	if iso := a["ISO3166-2-lvl4"]; strings.HasPrefix(iso, "US-") {
		code = strings.TrimPrefix(iso, "US-")
	}
	return LocInfo{a["postcode"], city, a["county"], a["state"], code}, nil
}

func firstNonEmpty(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

func ftoa(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// ---------------------------------------------------------------- climate

type Climate struct {
	ClimateZone      int     `json:"climate_zone"`
	HDD65            int     `json:"hdd65"`
	CDD50            int     `json:"cdd50"`
	RecordLowF       int     `json:"record_low_f"`
	AnnualPrecipIn   float64 `json:"annual_precip_in"`
	AnnualSnowfallIn float64 `json:"annual_snowfall_in"`
	MaxWindGustMph   int     `json:"max_wind_gust_mph"`
	FrostDepthIn     int     `json:"frost_depth_in"`
}

type Daily struct {
	Time      []string   `json:"time"`
	TMean     []*float64 `json:"temperature_2m_mean"`
	TMin      []*float64 `json:"temperature_2m_min"`
	Precip    []*float64 `json:"precipitation_sum"`
	Snow      []*float64 `json:"snowfall_sum"`
	WindGusts []*float64 `json:"wind_gusts_10m_max"`
}

func FetchClimate(lat, lon float64) (Climate, error) {
	end := time.Now().Year() - 1
	q := url.Values{"latitude": {ftoa(lat)}, "longitude": {ftoa(lon)},
		"start_date": {fmt.Sprintf("%d-01-01", end-9)}, "end_date": {fmt.Sprintf("%d-12-31", end)},
		"temperature_unit": {"fahrenheit"}, "precipitation_unit": {"inch"}, "wind_speed_unit": {"mph"},
		"timezone": {"auto"},
		"daily":    {"temperature_2m_mean,temperature_2m_min,precipitation_sum,snowfall_sum,wind_gusts_10m_max"}}
	var res struct{ Daily Daily }
	if err := getJSON(OpenMeteoURL+"?"+q.Encode(), &res); err != nil {
		return Climate{}, err
	}
	if len(res.Daily.Time) == 0 {
		return Climate{}, fmt.Errorf("no weather history for this location")
	}
	return SummarizeClimate(res.Daily), nil
}

func clean(v []*float64) []float64 {
	var out []float64
	for _, x := range v {
		if x != nil {
			out = append(out, *x)
		}
	}
	return out
}

func SummarizeClimate(d Daily) Climate {
	years := float64(len(d.Time)) / 365.25
	var hdd, cdd float64
	for _, t := range clean(d.TMean) {
		hdd += math.Max(0, 65-t)
		cdd += math.Max(0, t-50)
	}
	hdd /= years
	cdd /= years
	zone := 8
	switch {
	case cdd > 9000:
		zone = 1
	case cdd > 6300:
		zone = 2
	default:
		for _, z := range []struct {
			z   int
			lim float64
		}{{3, 3600}, {4, 5400}, {5, 7200}, {6, 9000}, {7, 12600}} {
			if hdd <= z.lim {
				zone = z.z
				break
			}
		}
	}
	return Climate{
		ClimateZone: zone, HDD65: int(math.Round(hdd)), CDD50: int(math.Round(cdd)),
		RecordLowF:       int(math.Round(minOf(clean(d.TMin)))),
		AnnualPrecipIn:   round1(sum(clean(d.Precip)) / years),
		AnnualSnowfallIn: round1(sum(clean(d.Snow)) / years),
		MaxWindGustMph:   int(math.Round(maxOf(clean(d.WindGusts)))),
		FrostDepthIn:     FrostIn[zone],
	}
}

func sum(v []float64) (s float64) {
	for _, x := range v {
		s += x
	}
	return
}
func minOf(v []float64) float64 {
	m := math.Inf(1)
	for _, x := range v {
		m = math.Min(m, x)
	}
	if math.IsInf(m, 1) {
		return 0
	}
	return m
}
func maxOf(v []float64) float64 {
	m := math.Inf(-1)
	for _, x := range v {
		m = math.Max(m, x)
	}
	if math.IsInf(m, -1) {
		return 0
	}
	return m
}
func round1(x float64) float64 { return math.Round(x*10) / 10 }

// ---------------------------------------------------------------- flood + seismic

type Flood struct {
	FloodZone string `json:"flood_zone"`
	InSFHA    bool   `json:"in_sfha"`
}

func FetchFlood(lat, lon float64) (Flood, error) {
	q := url.Values{"geometry": {ftoa(lon) + "," + ftoa(lat)}, "geometryType": {"esriGeometryPoint"},
		"inSR": {"4326"}, "spatialRel": {"esriSpatialRelIntersects"}, "outFields": {"FLD_ZONE,SFHA_TF"},
		"returnGeometry": {"false"}, "f": {"json"}}
	var res struct {
		Features []struct {
			Attributes struct {
				FldZone string `json:"FLD_ZONE"`
				Sfha    string `json:"SFHA_TF"`
			} `json:"attributes"`
		} `json:"features"`
	}
	if err := getJSON(FemaURL+"?"+q.Encode(), &res); err != nil {
		return Flood{}, err
	}
	if len(res.Features) == 0 {
		return Flood{"unmapped", false}, nil
	}
	a := res.Features[0].Attributes
	return Flood{firstNonEmpty(a.FldZone, "unmapped"), a.Sfha == "T"}, nil
}

type Seismic struct {
	SDC string   `json:"seismic_design_category"`
	SDS *float64 `json:"sds_g"`
}

func FetchSeismic(lat, lon float64) (Seismic, error) {
	q := url.Values{"latitude": {ftoa(lat)}, "longitude": {ftoa(lon)}, "riskCategory": {"II"},
		"siteClass": {"Default"}, "title": {"house"}}
	var res struct {
		Response struct {
			Data struct {
				SDC any      `json:"sdc"`
				SDS *float64 `json:"sds"`
			} `json:"data"`
		} `json:"response"`
	}
	if err := getJSON(SeismicURL+"?"+q.Encode(), &res); err != nil {
		return Seismic{}, err
	}
	sdc := "unknown"
	if s, ok := res.Response.Data.SDC.(string); ok && s != "" {
		sdc = s
	}
	return Seismic{sdc, res.Response.Data.SDS}, nil
}

// ---------------------------------------------------------------- soil

type SoilComp struct {
	MapUnit   string   `json:"map_unit"`
	Component string   `json:"component"`
	Pct       float64  `json:"pct"`
	USCS      string   `json:"uscs"`
	Bearing   int      `json:"bearing_psf"`
	LEP       *float64 `json:"lep"`
	BedrockCm *float64 `json:"bedrock_cm"`
	WaterCm   *float64 `json:"water_cm"`
}

type Soil struct {
	GoverningUSCS    string     `json:"governing_uscs_class"`
	GoverningBearing *int       `json:"governing_bearing_psf"`
	MaxLEP           *float64   `json:"max_lep_percent"`
	ShrinkSwell      string     `json:"shrink_swell"`
	MinBedrockIn     *int       `json:"min_depth_to_bedrock_in"`
	MinWaterIn       *int       `json:"min_depth_to_water_table_in"`
	Note             string     `json:"note"`
	Components       []SoilComp `json:"components"`
}

type BBox struct{ W, S, E, N float64 }

func LotBBox(lat, lon float64, lot [2]float64) BBox {
	dlon := lot[0] * MPerFt / 2 / (111320 * math.Cos(lat*math.Pi/180))
	dlat := lot[1] * MPerFt / 2 / 110574
	return BBox{lon - dlon, lat - dlat, lon + dlon, lat + dlat}
}

func (b BBox) WKT() string {
	return fmt.Sprintf("POLYGON((%v %v, %v %v, %v %v, %v %v, %v %v))", b.W, b.S, b.W, b.N, b.E, b.N, b.E, b.S, b.W, b.S)
}

func FetchSoil(b BBox) (Soil, error) {
	// Every component (not just the major one): map units in towns are often "Urban land"
	// with no lab data, so the next component supplies the values. Soil class: prefer the
	// representative value, at the horizon nearest footing depth (60 cm).
	sql := fmt.Sprintf(`
SELECT mu.muname, c.compname, c.comppct_r, c.majcompflag, ma.brockdepmin, ma.wtdepannmin,
       (SELECT TOP 1 cu.unifiedcl FROM chorizon ch INNER JOIN chunified cu ON cu.chkey = ch.chkey
          WHERE ch.cokey = c.cokey AND cu.unifiedcl IS NOT NULL
          ORDER BY CASE WHEN cu.rvindicator = 'Yes' THEN 0 ELSE 1 END, ABS(ch.hzdept_r - 60)) AS uscs,
       (SELECT MAX(ch.lep_r) FROM chorizon ch WHERE ch.cokey = c.cokey AND ch.hzdept_r < 150) AS lep_max
FROM mapunit mu
INNER JOIN component c ON c.mukey = mu.mukey
INNER JOIN muaggatt ma ON ma.mukey = mu.mukey
WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('%s'))`, b.WKT())
	body, _ := json.Marshal(map[string]string{"query": sql, "format": "JSON+COLUMNNAME"})
	var res struct{ Table [][]any }
	if err := postJSON(SdaURL, body, "application/json", &res); err != nil {
		return Soil{}, err
	}
	if len(res.Table) < 2 {
		return Soil{}, fmt.Errorf("no SSURGO soil data for this location")
	}
	var rows []map[string]any
	for _, r := range res.Table[1:] {
		m := map[string]any{}
		for i, col := range res.Table[0] {
			if i < len(r) {
				m[fmt.Sprint(col)] = r[i]
			}
		}
		rows = append(rows, m)
	}
	return SummarizeSoil(rows), nil
}

func num(v any) *float64 {
	switch x := v.(type) {
	case float64:
		return &x
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(x), 64); err == nil {
			return &f
		}
	}
	return nil
}

func str(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

var uscsSplit = regexp.MustCompile(`[-/ ,]+`)

// BearingFor returns the presumptive bearing for a soil class; dual classes use the weaker.
func BearingFor(uscs string) int {
	best := 0
	for _, p := range uscsSplit.Split(uscs, -1) {
		if v, ok := Bearing[p]; ok && (best == 0 || v < best) {
			best = v
		}
	}
	return best
}

func SummarizeSoil(rows []map[string]any) Soil {
	var comps []SoilComp
	for _, r := range rows {
		pct := 0.0
		if p := num(r["comppct_r"]); p != nil {
			pct = *p
		}
		u := str(r["uscs"])
		comps = append(comps, SoilComp{str(r["muname"]), str(r["compname"]), pct, u, BearingFor(u),
			num(r["lep_max"]), num(r["brockdepmin"]), num(r["wtdepannmin"])})
	}
	sort.SliceStable(comps, func(i, j int) bool { return comps[i].Pct > comps[j].Pct })

	// Governing values come from components making up at least 10% of the lot when any
	// have data, so a 2% inclusion doesn't drive the design.
	var withClass, pool []SoilComp
	for _, c := range comps {
		if c.Bearing > 0 {
			withClass = append(withClass, c)
			if c.Pct >= 10 {
				pool = append(pool, c)
			}
		}
	}
	if len(pool) == 0 {
		pool = withClass
	}
	var weak *SoilComp
	for i := range pool {
		if weak == nil || pool[i].Bearing < weak.Bearing {
			weak = &pool[i]
		}
	}
	var lep, rock, water *float64
	for _, c := range comps {
		if c.LEP != nil && (c.Pct >= 10 || len(pool) == 0) && (lep == nil || *c.LEP > *lep) {
			lep = c.LEP
		}
		if c.BedrockCm != nil && (rock == nil || *c.BedrockCm < *rock) {
			rock = c.BedrockCm
		}
		if c.WaterCm != nil && (water == nil || *c.WaterCm < *water) {
			water = c.WaterCm
		}
	}
	s := Soil{GoverningUSCS: "unknown", ShrinkSwell: "unknown", MaxLEP: lep}
	if weak != nil {
		s.GoverningUSCS = weak.USCS
		b := weak.Bearing
		s.GoverningBearing = &b
	}
	if lep != nil {
		switch {
		case *lep < 3:
			s.ShrinkSwell = "low"
		case *lep < 6:
			s.ShrinkSwell = "moderate"
		case *lep < 9:
			s.ShrinkSwell = "high"
		default:
			s.ShrinkSwell = "very high"
		}
	}
	if rock != nil {
		v := int(math.Round(*rock / 2.54))
		s.MinBedrockIn = &v
	}
	if water != nil {
		v := int(math.Round(*water / 2.54))
		s.MinWaterIn = &v
	}
	if len(comps) > 0 && comps[0].Bearing == 0 {
		src := "no component has data."
		if weak != nil {
			src = fmt.Sprintf("values come from '%s'.", weak.Component)
		}
		s.Note = fmt.Sprintf("Largest component '%s' (%.0f%%) has no engineering data (common for urban land or fill); %s",
			comps[0].Component, comps[0].Pct, src)
	}
	if len(comps) > 6 {
		comps = comps[:6]
	}
	s.Components = comps
	return s
}

// ---------------------------------------------------------------- wages (BLS)

type Labor struct {
	WageFactor float64 `json:"wage_factor"`
	StateWage  float64 `json:"state_carpenter_wage,omitempty"`
	NatWage    float64 `json:"national_carpenter_wage,omitempty"`
	Note       string  `json:"note,omitempty"`
}

var StateFIPS = map[string]string{"AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08", "CT": "09",
	"DE": "10", "DC": "11", "FL": "12", "GA": "13", "HI": "15", "ID": "16", "IL": "17", "IN": "18", "IA": "19",
	"KS": "20", "KY": "21", "LA": "22", "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27", "MS": "28",
	"MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33", "NJ": "34", "NM": "35", "NY": "36", "NC": "37",
	"ND": "38", "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46", "TN": "47",
	"TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53", "WV": "54", "WI": "55", "WY": "56"}

// FetchWageFactor compares the state and national mean hourly wage for carpenters
// (BLS OEWS, SOC 47-2031).
func FetchWageFactor(stateCode string) (Labor, error) {
	fips, ok := StateFIPS[stateCode]
	if !ok {
		return Labor{WageFactor: 1, Note: "state unknown; using national prices"}, nil
	}
	// OEWS series id = OE + U + area type + area (7) + industry (6) + occupation (6) + data type (2)
	const industry, occupation, hourlyMean = "000000", "472031", "03"
	stateID := "OEUS" + fips + "00000" + industry + occupation + hourlyMean
	natID := "OEUN" + "0000000" + industry + occupation + hourlyMean
	body, _ := json.Marshal(map[string][]string{"seriesid": {stateID, natID}})
	var res struct {
		Results struct {
			Series []struct {
				SeriesID string                   `json:"seriesID"`
				Data     []struct{ Value string } `json:"data"`
			} `json:"series"`
		}
	}
	var err error
	for attempt := 0; attempt < 3; attempt++ { // BLS often answers 503 when busy
		if err = postJSON(BlsURL, body, "application/json", &res); err == nil {
			break
		}
		if attempt < 2 {
			sleep(time.Duration(3*(attempt+1)) * time.Second)
		}
	}
	if err != nil {
		return Labor{}, err
	}
	vals := map[string]float64{}
	for _, s := range res.Results.Series {
		if len(s.Data) > 0 {
			if v, e := strconv.ParseFloat(s.Data[0].Value, 64); e == nil {
				vals[s.SeriesID] = v
			}
		}
	}
	if vals[stateID] > 0 && vals[natID] > 0 {
		return Labor{WageFactor: math.Round(vals[stateID]/vals[natID]*1000) / 1000,
			StateWage: vals[stateID], NatWage: vals[natID]}, nil
	}
	return Labor{WageFactor: 1, Note: "BLS wage data unavailable; using national prices"}, nil
}

// ---------------------------------------------------------------- suppliers (OpenStreetMap)

type Supplier struct {
	Name, Type, Address, Phone, Website string
	Miles                               float64
}

func FetchSuppliers(lat, lon float64, radiusKm int) ([]Supplier, error) {
	a := fmt.Sprintf("(around:%d,%v,%v)", radiusKm*1000, lat, lon)
	q := fmt.Sprintf(`[out:json][timeout:30];
(nwr["shop"~"^(doityourself|hardware|trade|building_materials|flooring|tiles|kitchen|bathroom_furnishing|paint|appliance|electronics)$"]%s;
 nwr["craft"~"^(builder|roofer|hvac|electrician|plumber)$"]%s;
 nwr["industrial"="concrete_plant"]%s;
 nwr["man_made"="works"]["product"~"concrete"]%s;);
out center tags;`, a, a, a, a)
	var res struct {
		Elements []struct {
			Lat, Lon *float64
			Center   *struct{ Lat, Lon float64 }
			Tags     map[string]string
		}
	}
	if err := postJSON(OverpassURL, []byte(url.Values{"data": {q}}.Encode()), "application/x-www-form-urlencoded", &res); err != nil {
		return nil, err
	}
	var out []Supplier
	for _, el := range res.Elements {
		tg := el.Tags
		if tg["name"] == "" {
			continue
		}
		var la, lo float64
		switch {
		case el.Lat != nil && el.Lon != nil:
			la, lo = *el.Lat, *el.Lon
		case el.Center != nil:
			la, lo = el.Center.Lat, el.Center.Lon
		default:
			continue
		}
		kind := firstNonEmpty(tg["shop"], tg["craft"], tg["industrial"], "concrete")
		addr := strings.TrimSpace(strings.Join(nonEmpty(tg["addr:housenumber"], tg["addr:street"], tg["addr:city"]), " "))
		out = append(out, Supplier{tg["name"], kind, addr, tg["phone"], tg["website"], math.Round(haversineKm(lat, lon, la, lo)*0.621*10) / 10})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Miles < out[j].Miles })
	return out, nil
}

func nonEmpty(s ...string) []string {
	var out []string
	for _, v := range s {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

func haversineKm(lat1, lon1, lat2, lon2 float64) float64 {
	r := math.Pi / 180
	dlat, dlon := (lat2-lat1)*r, (lon2-lon1)*r
	a := math.Sin(dlat/2)*math.Sin(dlat/2) + math.Cos(lat1*r)*math.Cos(lat2*r)*math.Sin(dlon/2)*math.Sin(dlon/2)
	return 6371 * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

// ---------------------------------------------------------------- everything for one site

type Site struct {
	Location LocInfo    `json:"location"`
	Climate  Climate    `json:"climate"`
	Flood    Flood      `json:"flood"`
	Seismic  Seismic    `json:"seismic"`
	Soil     Soil       `json:"soil"`
	Terrain  Terrain    `json:"terrain"`
	Labor    Labor      `json:"labor"`
	Setbacks Setbacks   `json:"setbacks_ft"`
	LotFt    [2]float64 `json:"lot_ft"`
	Warnings []string   `json:"warnings"`
	// Estimated is set outside the US, where worldwide sources and assumptions stand in (world.go).
	Estimated bool `json:"estimated,omitempty"`
	// ground is the plane fitted to the elevation under the building (foundation.go).
	ground groundPlane
}

func GatherSite(cfg Config, log io.Writer) (Site, error) {
	lat, lon := cfg.Location.Lat, cfg.Location.Lon
	take := ComputeTakeoff(cfg.Interior)
	fmt.Fprintln(log, "Fetching soil, elevation, climate, flood, seismic and location data...")
	s := Site{Setbacks: cfg.SetbacksFt, LotFt: cfg.LotFt}
	warn := func(label string, err error) {
		s.Warnings = append(s.Warnings, fmt.Sprintf("%s unavailable (%v); used a default.", label, err))
	}

	var err error
	if s.Location, err = FetchLocation(lat, lon); err != nil {
		warn("Location", err)
	}
	grid, src, err := FetchDEM(lat, lon, cfg.LotFt)
	if err != nil {
		return s, fmt.Errorf("elevation: %w", err)
	}
	s.Terrain = AnalyzeTerrain(grid, take["footprint_side_ft"], cfg.SetbacksFt)
	s.Terrain.ElevationSource = src
	if s.Climate, err = FetchClimate(lat, lon); err != nil {
		return s, fmt.Errorf("climate: %w", err)
	}
	if s.Flood, err = FetchFlood(lat, lon); err != nil {
		warn("FEMA flood zone", err)
		s.Flood = Flood{"unknown", false}
	}
	if s.Seismic, err = FetchSeismic(lat, lon); err != nil {
		warn("USGS seismic", err)
		s.Seismic = Seismic{SDC: "unknown"}
	}
	if s.Soil, err = FetchSoil(LotBBox(lat, lon, cfg.LotFt)); err != nil {
		return s, fmt.Errorf("soil: %w", err)
	}
	if s.Labor, err = FetchWageFactor(s.Location.StateCode); err != nil {
		warn("BLS wages", err)
		s.Labor = Labor{WageFactor: 1}
	}
	return s, nil
}
