package main

// Neighborhoods and trailer parks: one site holding many homes, with roads, lots and shared spaces
// (terrasim.design/3, contracts/FIELDS.md "Sites").
//
// The land is laid out in a frame along its longest side. Streets run along that side, each with a
// row of lots on both sides, joined by a collector street that reaches the land's edge nearest the
// public street. The lots nearest the entrance hold the shared spaces (a park, a playground, a pool,
// a clubhouse); the rest hold homes, up to the number asked for.
//
// The homes come in one or two variants. Each variant is designed by the ordinary pipeline
// (RunRequest) on a lot of its own, so it gets Gemma's design, the site checks and a price like any
// building; it's then copied onto every other lot of its kind, facing that lot's street.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

func isSiteType(ht string) bool { return ht == "neighborhood" || ht == "trailer-park" }

const SiteSchema = "terrasim.design/3"

// SiteDesign is a whole site: terrasim.design/3.
type SiteDesign struct {
	Schema      string      `json:"schema"`
	ID          string      `json:"id"`
	RequestID   string      `json:"requestId"`
	CreatedAt   string      `json:"createdAt"`
	HousingType string      `json:"housingType"`
	Overview    Overview    `json:"overview"`
	Totals      SiteTotals  `json:"totals"`
	Site        DSite       `json:"site"`
	Placement   Placement   `json:"placement"`
	Size        Size        `json:"size"`
	Roads       []SRoad     `json:"roads"`
	Lots        []SLot      `json:"lots"`
	Amenities   []SAmenity  `json:"amenities"`
	Variants    []SVariant  `json:"variants"`
	Homes       []SHome     `json:"homes"`
	Cost        *DesignCost `json:"cost,omitempty"`
}

type SiteTotals struct {
	DesignTotals
	Lots        int     `json:"lots"`
	RoadLengthM float64 `json:"roadLengthM"`
	LandAreaM2  float64 `json:"landAreaM2"`
}

// SRoad is a street, as its centre line and the polygon it paves, in site metres.
type SRoad struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	WidthM  float64 `json:"widthM"`
	Line    []Pt    `json:"line"`
	Polygon []Pt    `json:"polygon"`
}

// SLot is one lot: its polygon, which way its street is, and what stands on it.
type SLot struct {
	ID      string `json:"id"`
	Number  int    `json:"number"`
	Polygon []Pt   `json:"polygon"`
	RoadID  string `json:"roadId"`
	Use     string `json:"use"` // home or amenity
	HomeID  string `json:"homeId,omitempty"`
}

// SAmenity is a shared space: park, playground, pool or clubhouse.
type SAmenity struct {
	ID      string  `json:"id"`
	Kind    string  `json:"kind"`
	Name    string  `json:"name"`
	Polygon []Pt    `json:"polygon"`
	HeightM float64 `json:"heightM,omitempty"`
}

// SVariant is one home design, used on Count lots.
type SVariant struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Count  int     `json:"count"`
	Design *Design `json:"design"`
}

// SHome is one home: its variant, placed at (x, y) in site metres and turned rotationDeg
// (counter-clockwise) from the site's x axis. A point (hx, hy) of the variant's building frame is at
// (x, y) + R(rotationDeg)·(hx, hy) on the site.
type SHome struct {
	ID          string  `json:"id"`
	Variant     string  `json:"variant"`
	LotID       string  `json:"lotId"`
	X           float64 `json:"x"`
	Y           float64 `json:"y"`
	RotationDeg float64 `json:"rotationDeg"`
}

// ---- the site frame ------------------------------------------------------------------------------

type siteFrame struct {
	f    Frame
	sp   SitePlan // Bearing and OriginLocal, as for a building
	u, v Pt
	L, D float64
	poly []Pt // the land in site metres
}

// newSiteFrame lays a frame along the land's longest side (the bounding box of least area), with the
// side nearest the public street at y = 0.
func newSiteFrame(f Frame, local []Pt, streets [][]Pt) siteFrame {
	best, bestArea := 0.0, math.Inf(1)
	for i := range local {
		a, b := local[i], local[(i+1)%len(local)]
		if math.Hypot(b[0]-a[0], b[1]-a[1]) < 1 {
			continue
		}
		bearing := math.Atan2(b[0]-a[0], b[1]-a[1]) * 180 / math.Pi
		u, v := axes(bearing)
		x0, y0, x1, y1 := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
		for _, p := range local {
			x0, x1 = math.Min(x0, dot(p, u)), math.Max(x1, dot(p, u))
			y0, y1 = math.Min(y0, dot(p, v)), math.Max(y1, dot(p, v))
		}
		area := (x1 - x0) * (y1 - y0)
		if x1-x0 < y1-y0 {
			bearing += 90 // the long side along x
		}
		if area < bestArea-1e-6 {
			best, bestArea = bearing, area
		}
	}
	build := func(bearing float64) siteFrame {
		u, v := axes(bearing)
		x0, y0, x1, y1 := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
		for _, p := range local {
			x0, x1 = math.Min(x0, dot(p, u)), math.Max(x1, dot(p, u))
			y0, y1 = math.Min(y0, dot(p, v)), math.Max(y1, dot(p, v))
		}
		o := Pt{x0*u[0] + y0*v[0], x0*u[1] + y0*v[1]}
		sf := siteFrame{f: f, sp: SitePlan{Bearing: math.Mod(bearing+360, 360), OriginLocal: o}, u: u, v: v, L: x1 - x0, D: y1 - y0}
		for _, p := range local {
			sf.poly = append(sf.poly, sf.toSite(p))
		}
		return sf
	}
	sf := build(best)
	// The public street, when the website sent one, goes to the y = 0 side.
	if s := nearestStreetPoint(f, local, streets); s != nil {
		if q := sf.toSite(*s); q[1] > sf.D/2 {
			sf = build(best + 180)
		}
	}
	return sf
}

func (sf siteFrame) toSite(p Pt) Pt {
	d := Pt{p[0] - sf.sp.OriginLocal[0], p[1] - sf.sp.OriginLocal[1]}
	return Pt{dot(d, sf.u), dot(d, sf.v)}
}

func (sf siteFrame) lngLat(p Pt) Pt { return BuildingToLngLat(sf.f, sf.sp, p) }

func (sf siteFrame) inside(p Pt, edge float64) bool {
	return PointInPoly(p, sf.poly) && distToPolyEdge(p, sf.poly) >= edge-1e-6
}

// nearestStreetPoint is the point of the website's streets nearest the land, in local metres.
func nearestStreetPoint(f Frame, local []Pt, streets [][]Pt) *Pt {
	c := PolyCentroid(local)
	var best *Pt
	bestD := math.Inf(1)
	for _, line := range streets {
		for i := 0; i+1 < len(line); i++ {
			a, b := f.ToLocal(line[i]), f.ToLocal(line[i+1])
			ab := Pt{b[0] - a[0], b[1] - a[1]}
			t := 0.0
			if l2 := dot(ab, ab); l2 > 0 {
				t = math.Max(0, math.Min(1, dot(Pt{c[0] - a[0], c[1] - a[1]}, ab)/l2))
			}
			q := Pt{a[0] + ab[0]*t, a[1] + ab[1]*t}
			if d := math.Hypot(q[0]-c[0], q[1]-c[1]); d < bestD && d < 250 {
				qq := q
				best, bestD = &qq, d
			}
		}
	}
	return best
}

// ---- the subdivision -----------------------------------------------------------------------------

type plotLot struct {
	r       Rect
	street  int     // index of its street
	origin  Pt      // the lot frame: at the street, x along it, y away from it
	rot     float64 // 0 (street below) or 180 (street above)
	dist    float64 // from the entrance
	use     string
	homeVar int
}

// plotStreet is a spine (centre line at y, from x0 to x1) or, for the collector, the same fields
// turned: its centre line at x = y, from y = x0 to y = x1.
type plotStreet struct {
	y, x0, x1 float64
	collector bool
}

type subdivision struct {
	streets []plotStreet
	lots    []*plotLot
	roadW   float64
}

// subdivide lays out streets and lots of lotW × lotD (frontage × depth) on the land, edge metres
// in from its boundary.
func subdivide(sf siteFrame, lotW, lotD, roadW, edge float64) subdivision {
	sd := subdivision{roadW: roadW}
	module := 2*lotD + roadW
	n := int(math.Floor((sf.D - 2*edge) / module))
	single := false
	if n < 1 {
		n, single = 1, true
		module = lotD + roadW
	}
	used := float64(n) * module
	off := edge + (sf.D-2*edge-used)/2
	// The collector runs across the spines near x = 0 (the end with more land), from y = 0.
	cx0 := edge
	for x := edge; x < sf.L/2; x += 0.5 {
		if sf.inside(Pt{x + roadW/2, sf.D / 2}, edge) {
			cx0 = x
			break
		}
	}
	lot0 := cx0 + roadW + 0.5
	for j := 0; j < n; j++ {
		var yc float64
		if single {
			yc = off + roadW/2
		} else {
			yc = off + float64(j)*module + lotD + roadW/2
		}
		sd.streets = append(sd.streets, plotStreet{y: yc, x0: cx0, x1: sf.L - edge})
		si := len(sd.streets) - 1
		for x := lot0; x+lotW <= sf.L-edge+1e-6; x += lotW {
			above := Rect{x, yc + roadW/2, x + lotW, yc + roadW/2 + lotD}
			below := Rect{x, yc - roadW/2 - lotD, x + lotW, yc - roadW/2}
			sides := []struct {
				r  Rect
				up bool
			}{{above, true}}
			if !single {
				sides = append(sides, struct {
					r  Rect
					up bool
				}{below, false})
			}
			for _, s := range sides {
				ok := true
				for _, q := range s.r.Poly() {
					if !sf.inside(q, edge) {
						ok = false
						break
					}
				}
				if !ok {
					continue
				}
				lt := &plotLot{r: s.r, street: si}
				if s.up {
					lt.origin, lt.rot = Pt{s.r.X0, s.r.Y0}, 0
				} else {
					lt.origin, lt.rot = Pt{s.r.X1, s.r.Y1}, 180
				}
				sd.lots = append(sd.lots, lt)
			}
		}
	}
	// The collector: from the land's edge at y = 0 to the last spine.
	cy0 := 0.0
	for y := 0.0; y < sf.D; y += 0.5 {
		if sf.inside(Pt{cx0 + roadW/2, y}, 0.2) {
			cy0 = y
			break
		}
	}
	sd.streets = append(sd.streets, plotStreet{y: cx0 + roadW/2, x0: cy0, x1: sd.streets[len(sd.streets)-1].y + roadW/2, collector: true})
	entrance := Pt{cx0 + roadW/2, cy0}
	for _, lt := range sd.lots {
		c := Pt{(lt.r.X0 + lt.r.X1) / 2, (lt.r.Y0 + lt.r.Y1) / 2}
		lt.dist = math.Abs(c[0]-entrance[0]) + math.Abs(c[1]-entrance[1])
	}
	sort.SliceStable(sd.lots, func(i, j int) bool { return sd.lots[i].dist < sd.lots[j].dist })
	return sd
}

// ---- the request ---------------------------------------------------------------------------------

// sitePrefixWriter writes a variant's log lines with its name in front.
type sitePrefixWriter struct {
	mu     *sync.Mutex
	w      io.Writer
	prefix string
	buf    bytes.Buffer
}

func (p *sitePrefixWriter) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.buf.Write(b)
	for {
		line, err := p.buf.ReadString('\n')
		if err != nil {
			p.buf.Reset()
			p.buf.WriteString(line)
			break
		}
		fmt.Fprint(p.w, p.prefix+line)
	}
	return len(b), nil
}

// variantRequest is the request for one home variant: a lot as the land, its street as the street.
func variantRequest(r Request, ht string, bedrooms int, area float64, lot []Pt, street []Pt, setback float64) Request {
	v := Request{Schema: r.Schema, HousingType: &ht, Mode: r.Mode, Client: r.Client}
	id := sv(r.ID) + "-home"
	v.ID = &id
	v.Site.Type, v.Site.Geometry.Type = "Feature", "Polygon"
	var ring [][]*float64
	for _, p := range append(append([]Pt{}, lot...), lot[0]) {
		x, y := p[0], p[1]
		ring = append(ring, []*float64{&x, &y})
	}
	v.Site.Geometry.Coordinates = [][][]*float64{ring}
	v.Site.Properties.SetbackM = &setback
	v.Site.Properties.Streets = [][]Pt{street}
	b := r.Brief
	floors := max(1, iv(b.Floors))
	baths := fv(b.Bathrooms)
	v.Brief = Brief{DesignPrompt: b.DesignPrompt, Floors: &floors, AreaM2: &area, Bedrooms: &bedrooms, Bathrooms: &baths, RoomType: b.RoomType}
	a := r.Advanced
	v.Advanced = Advanced{Style: a.Style, Quality: a.Quality, Garage: a.Garage, Structure: a.Structure, Cladding: a.Cladding,
		Roofing: a.Roofing, Priorities: a.Priorities, Extras: a.Extras}
	return v
}

// RunSiteRequest designs a neighborhood or trailer park.
func RunSiteRequest(r Request, raw []byte, dp Deps, out *Output) (*Output, error) {
	log := dp.Log
	ht := sv(r.HousingType)
	trailer := ht == "trailer-park"
	homeType := "house"
	if trailer {
		homeType = "manufactured"
	}
	ring, _ := r.SiteRing()
	var cLng, cLat float64
	for _, p := range ring {
		cLng, cLat = cLng+p[0], cLat+p[1]
	}
	cLng, cLat = cLng/float64(len(ring)), cLat/float64(len(ring))
	frame := NewFrame(cLat, cLng)
	var local []Pt
	for _, p := range ring {
		local = append(local, frame.ToLocal(p))
	}
	siteArea := PolyArea(local)
	sf := newSiteFrame(frame, local, r.Site.Properties.Streets)
	want := iv(r.Brief.UnitCount)
	var cautions []string

	// The home variants: the brief's home, and for six homes or more a second, a bedroom larger.
	bedrooms := iv(r.Brief.Bedrooms)
	area := fv(r.Brief.AreaM2)
	if area <= 0 {
		if trailer {
			area = manufacturedArea(sv(r.Brief.RoomType), bedrooms)
		} else {
			area = defaultArea("house", bedrooms, fv(r.Brief.Bathrooms))
		}
	}
	type variant struct {
		id       string
		bedrooms int
		area     float64
	}
	variants := []variant{{"A", bedrooms, area}}
	bedHi := 6
	if trailer {
		bedHi = 4
	}
	if want >= 6 && bedrooms < bedHi {
		variants = append(variants, variant{"B", bedrooms + 1, math.Round(area * 1.15)})
	}

	// Lot size: room for the largest variant, its garage, porch and deck, and a yard.
	lotSetback, roadW, edge := 1.5, 8.0, 2.0
	if trailer {
		lotSetback, roadW = 1.2, 6.5
	}
	lotW, lotD := 0.0, 0.0
	for _, v := range variants {
		probe := variantRequest(r, homeType, v.bedrooms, v.area, ring, nil, lotSetback)
		probe, probe.asks, _ = applyDescription(probe)
		p := DefaultProgram(probe)
		l, err := BuildLayout(p, 0)
		if err != nil {
			out.Report.Verdict, out.Report.Problems = "error", []string{"The homes couldn't be planned: " + err.Error()}
			return out, err
		}
		nd := l.Needs(0)
		lotW = math.Max(lotW, nd.Left+nd.W+nd.Right+2*lotSetback+2)
		lotD = math.Max(lotD, nd.Front+nd.D+nd.Back+2*lotSetback+(map[bool]float64{true: 4, false: 7}[trailer]))
	}
	lotW, lotD = math.Ceil(lotW), math.Ceil(lotD)
	fmt.Fprintf(log, "Laying out streets and %.0f × %.0f m lots on the %.0f m² site...\n", lotW, lotD, siteArea)
	sub := subdivide(sf, lotW, lotD, roadW, edge)

	// Shared spaces on the lots nearest the entrance.
	common := append([]string{}, r.Advanced.CommonSpaces...)
	if len(common) == 0 {
		common = []string{"park"}
		if trailer {
			common = []string{"clubhouse", "playground"}
		}
	}
	var kinds []string
	for _, c := range common {
		if c == "park" || c == "playground" || c == "pool" || c == "clubhouse" {
			kinds = append(kinds, c)
		} else if (c == "laundry" || c == "mail" || c == "lounge" || c == "gym") && !contains(kinds, "clubhouse") {
			kinds = append(kinds, "clubhouse")
		}
	}
	need := want + len(kinds)
	if len(sub.lots) < len(kinds)+1 {
		out.Report.Verdict = "not_feasible"
		out.Report.Problems = []string{fmt.Sprintf("The land is too small for streets and %.0f × %.0f m lots: not even one home fits.", lotW, lotD)}
		return out, nil
	}
	if len(sub.lots) < need {
		cautions = append(cautions, fmt.Sprintf("Only %d of the %d homes fit on the land with its streets and shared spaces.", len(sub.lots)-len(kinds), want))
		need = len(sub.lots)
	}
	usedLots := sub.lots[:need]
	for i, lt := range usedLots {
		if i < len(kinds) {
			lt.use = kinds[i]
		} else {
			lt.use = "home"
			lt.homeVar = (i - len(kinds)) % len(variants)
		}
	}

	// Design each variant on its first lot, in parallel.
	if dp.stopped() {
		return out, ErrCancelled
	}
	type result struct {
		res *Output
		err error
		lot *plotLot
	}
	results := make([]result, len(variants))
	var wg sync.WaitGroup
	var mu sync.Mutex
	for vi, v := range variants {
		var lot *plotLot
		for _, lt := range usedLots {
			if lt.use == "home" && lt.homeVar == vi {
				lot = lt
				break
			}
		}
		if lot == nil {
			continue
		}
		st := sub.streets[lot.street]
		street := []Pt{sf.lngLat(Pt{st.x0, st.y}), sf.lngLat(Pt{st.x1, st.y})}
		var lotLL []Pt
		for _, q := range lot.r.Poly() {
			lotLL = append(lotLL, sf.lngLat(q))
		}
		vr := variantRequest(r, homeType, v.bedrooms, v.area, lotLL, street, lotSetback)
		vraw, _ := json.Marshal(vr)
		vdp := dp
		vdp.Log = &sitePrefixWriter{mu: &mu, w: log, prefix: "Home " + v.id + ": "}
		vdp.Advise = nil
		wg.Add(1)
		go func(vi int, lot *plotLot) {
			defer wg.Done()
			res, err := RunRequest(vraw, vdp)
			results[vi] = result{res, err, lot}
		}(vi, lot)
	}
	wg.Wait()
	if dp.stopped() {
		return out, ErrCancelled
	}
	var good []int
	for vi, res := range results {
		if res.res != nil && res.res.Design != nil && res.res.Design.Cost != nil && res.err == nil {
			good = append(good, vi)
		}
	}
	if len(good) == 0 {
		probs := []string{"The homes couldn't be designed."}
		for _, res := range results {
			if res.res != nil && len(res.res.Report.Problems) > 0 {
				probs = res.res.Report.Problems
				out.Report.Verdict = res.res.Report.Verdict
				break
			}
			if res.err != nil {
				probs = []string{res.err.Error()}
			}
		}
		if out.Report.Verdict == "" {
			out.Report.Verdict = "error"
		}
		out.Report.Problems = probs
		return out, fmt.Errorf("%s", probs[0])
	}
	if len(good) < len(variants) {
		cautions = append(cautions, "One of the two home designs didn't work out, so every lot has the same home.")
		for _, lt := range usedLots {
			if lt.use == "home" {
				lt.homeVar = good[0]
			}
		}
	}

	// The site: streets, lots, shared spaces, homes.
	now := dp.Now()
	sd := &SiteDesign{Schema: SiteSchema, HousingType: ht, RequestID: or(sv(r.ID), "REQ-local"), CreatedAt: now.UTC().Format(time.RFC3339)}
	h := fmt.Sprintf("%x", now.UnixNano())
	sd.ID = "S-" + h[len(h)-10:]
	for _, q := range ring {
		sd.Site.Outline = append(sd.Site.Outline, Pt{math.Round(q[0]*1e7) / 1e7, math.Round(q[1]*1e7) / 1e7})
	}
	sd.Site.AreaM2 = r1(siteArea)
	sd.Placement = Placement{Origin: sf.lngLat(Pt{0, 0}), XAxisBearingDeg: r2(sf.sp.Bearing), Footprint: sd.Site.Outline}
	// Streets, trimmed to the lots they serve.
	names := []string{"Maple", "Cedar", "Willow", "Aspen", "Birch", "Laurel", "Juniper", "Hazel", "Linden", "Alder"}
	last := map[int]float64{}
	for _, lt := range usedLots {
		last[lt.street] = math.Max(last[lt.street], lt.r.X1)
	}
	roadLen := 0.0
	coll := sub.streets[len(sub.streets)-1]
	maxY := 0.0
	for si, st := range sub.streets[:len(sub.streets)-1] {
		end, ok := last[si]
		if !ok {
			continue
		}
		maxY = math.Max(maxY, st.y+roadW/2)
		x1 := math.Min(st.x1, end+2)
		rr := Rect{st.x0, st.y - roadW/2, x1, st.y + roadW/2}
		suffix := " Lane"
		if !trailer {
			suffix = " Street"
		}
		sd.Roads = append(sd.Roads, SRoad{ID: fmt.Sprintf("R%d", si+1), Name: names[si%len(names)] + suffix, WidthM: roadW,
			Line: []Pt{{rd(st.x0), rd(st.y)}, {rd(x1), rd(st.y)}}, Polygon: rr.Poly()})
		roadLen += x1 - st.x0
	}
	cr := Rect{coll.y - roadW/2, coll.x0, coll.y + roadW/2, maxY}
	sd.Roads = append(sd.Roads, SRoad{ID: "R0", Name: "Entrance Drive", WidthM: roadW,
		Line: []Pt{{rd(coll.y), rd(coll.x0)}, {rd(coll.y), rd(maxY)}}, Polygon: cr.Poly()})
	roadLen += maxY - coll.x0
	amenityName := map[string]string{"park": "Park", "playground": "Playground", "pool": "Pool", "clubhouse": "Clubhouse"}
	var homesOut []SHome
	counts := make([]int, len(variants))
	for i, lt := range usedLots {
		lot := SLot{ID: fmt.Sprintf("L%d", i+1), Number: i + 1, Polygon: lt.r.Poly(), RoadID: fmt.Sprintf("R%d", lt.street+1), Use: "home"}
		if lt.use != "home" {
			lot.Use = "amenity"
			inset := 1.0
			heightM := 0.0
			if lt.use == "clubhouse" {
				inset, heightM = 3.0, 4.5
			}
			if lt.use == "pool" {
				inset = 2.5
			}
			ar := Rect{lt.r.X0 + inset, lt.r.Y0 + inset, lt.r.X1 - inset, lt.r.Y1 - inset}
			name := amenityName[lt.use]
			if lt.use == "clubhouse" && contains(common, "laundry") {
				name = "Clubhouse and laundry"
			}
			sd.Amenities = append(sd.Amenities, SAmenity{ID: fmt.Sprintf("A%d", len(sd.Amenities)+1), Kind: lt.use, Name: name, Polygon: ar.Poly(), HeightM: heightM})
			sd.Lots = append(sd.Lots, lot)
			continue
		}
		rep := results[lt.homeVar]
		d := rep.res.Design
		x, y, rot := homeOnLot(sf, d, rep.lot, lt)
		hid := fmt.Sprintf("H%d", len(homesOut)+1)
		homesOut = append(homesOut, SHome{ID: hid, Variant: variants[lt.homeVar].id, LotID: lot.ID, X: rd(x), Y: rd(y), RotationDeg: r2(rot)})
		lot.HomeID = hid
		counts[lt.homeVar]++
		sd.Lots = append(sd.Lots, lot)
	}
	sd.Homes = homesOut
	if sd.Amenities == nil {
		sd.Amenities = []SAmenity{}
	}

	// Totals and cost.
	t := &sd.Totals
	t.LandAreaM2, t.Lots, t.RoadLengthM = r1(siteArea), len(homesOut), r1(roadLen)
	var homeCost, homeLow, homeHigh float64
	var lines []CostLine
	var cs CostSummary
	matIdx := map[string]int{}
	var mats []EMaterial
	var ot OverTime
	for vi, v := range variants {
		if counts[vi] == 0 || results[vi].res == nil || results[vi].res.Design == nil {
			continue
		}
		d := results[vi].res.Design
		n := float64(counts[vi])
		label := fmt.Sprintf("Home %s: %d bed, %.0f m²", v.id, d.Totals.Bedrooms, d.Totals.FinishedAreaM2)
		if trailer {
			label = fmt.Sprintf("Home %s: %s, %d bed", v.id, map[string]string{"single": "single-wide", "double": "double-wide"}[sv(r.Brief.RoomType)], d.Totals.Bedrooms)
		}
		sd.Variants = append(sd.Variants, SVariant{ID: v.id, Name: label, Count: counts[vi], Design: d})
		t.UnitCount += counts[vi]
		t.Floors = max(t.Floors, d.Totals.Floors)
		t.Bedrooms += counts[vi] * d.Totals.Bedrooms
		t.Bathrooms += n * d.Totals.Bathrooms
		t.FinishedAreaM2 += n * d.Totals.FinishedAreaM2
		t.GrossAreaM2 += n * d.Totals.GrossAreaM2
		t.ParkingSpaces += counts[vi] * max(2, d.Totals.ParkingSpaces)
		bc := d.Cost.BuildCost
		homeCost += n * bc.Expected
		homeLow += n * bc.Low
		homeHigh += n * bc.High
		lines = append(lines, CostLine{ID: "homes-" + strings.ToLower(v.id), Name: fmt.Sprintf("%d × home %s", counts[vi], v.id), Amount: math.Round(n * bc.Expected)})
		if b := d.Cost.Breakdown; b != nil {
			cs.Materials += n * b.Materials
			cs.InstalledWork += n * b.InstalledWork
			cs.Labor += n * b.Labor
			cs.SiteWork += n * b.SiteWork
			cs.Overhead += n * b.Overhead
			cs.Permits += n * b.Permits
			cs.WageFactor = b.WageFactor
		}
		for _, m := range d.Cost.Materials {
			if i, ok := matIdx[m.ID]; ok {
				mats[i].Quantity = r2(mats[i].Quantity + n*m.Quantity)
				mats[i].Cost = r2(mats[i].Cost + n*m.Cost)
			} else {
				matIdx[m.ID] = len(mats)
				mm := m
				mm.Quantity, mm.Cost = r2(n*m.Quantity), r2(n*m.Cost)
				mats = append(mats, mm)
			}
		}
		o := d.Cost.OverTime
		if len(ot.Rows) == 0 {
			ot = OverTime{Years: o.Years, Assumptions: o.Assumptions, Rows: make([]OTRow, len(o.Rows)), Events: []OTEvent{}}
			for i := range o.Rows {
				ot.Rows[i].Year = o.Rows[i].Year
			}
		}
		for i := range o.Rows {
			if i < len(ot.Rows) {
				ot.Rows[i].Maintenance += n * o.Rows[i].Maintenance
				ot.Rows[i].Energy += n * o.Rows[i].Energy
				ot.Rows[i].Replacements += n * o.Rows[i].Replacements
				ot.Rows[i].Value += n * o.Rows[i].Value
			}
		}
		for _, e := range o.Events {
			ot.Events = append(ot.Events, OTEvent{Year: e.Year, Name: fmt.Sprintf("%s (%d homes)", e.Name, counts[vi]), Amount: n * e.Amount})
		}
	}
	t.FinishedAreaM2, t.GrossAreaM2, t.Bathrooms = r1(t.FinishedAreaM2), r1(t.GrossAreaM2), r1(t.Bathrooms)
	wage := cs.WageFactor
	if wage <= 0 {
		wage = 1
	}
	roadArea := 0.0
	for _, road := range sd.Roads {
		roadArea += PolyArea(road.Polygon)
	}
	site := []CostLine{
		{ID: "site-prep", Name: "Clearing, grading and erosion control", Amount: math.Round(siteArea * 6 * wage)},
		{ID: "roads", Name: fmt.Sprintf("Streets: %.0f m² paved, with curbs and drainage", roadArea), Amount: math.Round(roadArea * 95 * wage)},
		{ID: "utilities", Name: fmt.Sprintf("Water, sewer and power to %d lots", len(homesOut)), Amount: math.Round(float64(len(homesOut)) * 14000 * wage)},
	}
	for _, am := range sd.Amenities {
		a := PolyArea(am.Polygon)
		cost := map[string]float64{"park": 25 * a, "playground": 45000, "pool": 160000, "clubhouse": 2400 * a}[am.Kind]
		site = append(site, CostLine{ID: "amenity-" + strings.ToLower(am.ID), Name: am.Name, Amount: math.Round(cost * wage)})
	}
	siteSum := 0.0
	for _, l := range site {
		siteSum += l.Amount
	}
	eng := math.Round(siteSum * 0.06)
	site = append(site, CostLine{ID: "engineering", Name: "Survey, civil engineering and subdivision approval", Amount: eng})
	siteSum += eng
	lines = append(lines, site...)
	cs.SiteWork += siteSum
	total := homeCost + siteSum
	cs.Total = math.Round(total)
	if t.FinishedAreaM2 > 0 {
		cs.PerM2 = r2(total / t.FinishedAreaM2)
		cs.PerSqFt = r2(total / (t.FinishedAreaM2 / (MPerFt * MPerFt)))
	}
	cs.BudgetUSD = r.Brief.BudgetUSD
	if b := r.Brief.BudgetUSD; b != nil && total > *b {
		over := math.Round(total - *b)
		cs.OverBudgetBy = &over
		cautions = append(cautions, fmt.Sprintf("Expected cost $%s is $%s over the $%s budget.", commas(int(total)), commas(int(over)), commas(int(*b))))
	}
	a0 := results[good[0]].res.Design
	sd.Cost = &DesignCost{Currency: a0.Cost.Currency, AsOf: a0.Cost.AsOf, Breakdown: &cs, Materials: mats, OverTime: ot, Suppliers: a0.Cost.Suppliers,
		BuildCost: BuildCost{Expected: math.Round(total), Low: math.Round(homeLow + siteSum*0.85), High: math.Round(homeHigh + siteSum*1.3),
			PerSqFt: cs.PerSqFt, Confidence: a0.Cost.BuildCost.Confidence, Lines: lines,
			Assumptions: append(append([]string{}, a0.Cost.BuildCost.Assumptions...),
				"Site work is priced per square metre of land and street and per lot, adjusted for local wages.")}}
	maxH := 0.0
	for _, v := range sd.Variants {
		maxH = math.Max(maxH, v.Design.Size.HeightM)
	}
	sd.Size = Size{WidthM: r2(sf.L), DepthM: r2(sf.D), HeightM: maxH}
	sd.Site.Soil, sd.Site.Estimated = a0.Site.Soil, a0.Site.Estimated

	// The words: from Gemma when it answers, else from code.
	sd.Overview = siteWords(r, sd, a0, dp, log)
	sd.Overview.Cautions = dedupe(append(append(append(sd.Overview.Cautions, cautions...), a0.Overview.Cautions...),
		"Subdividing land and building streets needs approval: a plat, street and utility plans, and the local zoning for this many homes."))

	out.SiteDesign = sd
	rep := results[good[0]].res.Report
	out.Report = rep
	out.Report.CostSummary = &cs
	out.Report.Warnings = dedupe(append(rep.Warnings, cautions...))
	fmt.Fprintf(log, "Site ready: %d homes on %d lots, %.0f m of streets.\n", t.UnitCount, len(sd.Lots), roadLen)
	return out, nil
}

// homeOnLot copies the variant's place on its own lot onto another lot of the same size.
func homeOnLot(sf siteFrame, d *Design, repLot, lot *plotLot) (x, y, rot float64) {
	o := sf.toSite(sf.f.ToLocal(d.Placement.Origin))
	uH, _ := axes(d.Placement.XAxisBearingDeg)
	hx := Pt{dot(uH, sf.u), dot(uH, sf.v)}
	rotH := math.Atan2(hx[1], hx[0]) * 180 / math.Pi
	rotate := func(p Pt, deg float64) Pt {
		a := deg * math.Pi / 180
		return Pt{p[0]*math.Cos(a) - p[1]*math.Sin(a), p[0]*math.Sin(a) + p[1]*math.Cos(a)}
	}
	rel := rotate(Pt{o[0] - repLot.origin[0], o[1] - repLot.origin[1]}, -repLot.rot)
	relRot := rotH - repLot.rot
	s := rotate(rel, lot.rot)
	rot = math.Mod(lot.rot+relRot+720, 360)
	return lot.origin[0] + s[0], lot.origin[1] + s[1], rot
}

// siteWords asks Gemma for the site's title, summary and description; code writes them if it can't.
func siteWords(r Request, sd *SiteDesign, home *Design, dp Deps, log io.Writer) Overview {
	ht := sv(r.HousingType)
	kind := map[string]string{"neighborhood": "neighborhood", "trailer-park": "manufactured-home community"}[ht]
	var am []string
	for _, a := range sd.Amenities {
		am = append(am, strings.ToLower(a.Name))
	}
	facts := fmt.Sprintf("%d homes on %.1f acres, %.0f m of new streets, shared spaces: %s. Each home: %s",
		sd.Totals.UnitCount, sd.Site.AreaM2/4046.86, sd.Totals.RoadLengthM, or(joinAnd(am), "none"), home.Overview.Summary)
	ov := Overview{Style: home.Overview.Style, SiteResponse: home.Overview.SiteResponse}
	ov.Features = []string{fmt.Sprintf("%d homes on lots along %d streets", sd.Totals.UnitCount, len(sd.Roads))}
	for _, v := range sd.Variants {
		ov.Features = append(ov.Features, fmt.Sprintf("%s (%d)", v.Name, v.Count))
	}
	for _, a := range sd.Amenities {
		ov.Features = append(ov.Features, a.Name)
	}
	ov.Features = append(ov.Features, home.Overview.Features...)
	prompt := fmt.Sprintf(`You are the site planner naming a new %s. The user described it as:
"%s"
Facts: %s
Reply with ONE JSON object: {"title": "a short name for the place (2 to 4 words)", "summary": "one sentence",
"description": ["one or two short paragraphs on the streets, the homes and the shared spaces, following the user's description"]}`,
		kind, sv(r.Brief.DesignPrompt), facts)
	type words struct {
		Title, Summary string
		Description    []string
	}
	parse := func(text string) (words, error) {
		m, err := extractJSON(text)
		if err != nil {
			return words{}, err
		}
		var w words
		w.Title, _ = asString(m["title"])
		w.Summary, _ = asString(m["summary"])
		w.Description, _ = asStrings(m["description"])
		return w, nil
	}
	check := func(w words) []string {
		if strings.TrimSpace(w.Title) == "" || strings.TrimSpace(w.Summary) == "" || len(w.Description) == 0 {
			return []string{"title, summary and description are all required"}
		}
		return nil
	}
	if dp.Ask != nil && !dp.stopped() {
		if w, err := AskUntilValid(prompt, parse, check, dp.Ask, "site words", 2048, 2, log); err == nil {
			ov.Title, ov.Summary, ov.Description = w.Title, w.Summary, w.Description
			return ov
		}
	}
	ov.Title = title(home.Overview.Style) + " " + map[string]string{"neighborhood": "Neighborhood", "trailer-park": "Park"}[ht]
	ov.Summary = fmt.Sprintf("A %s of %d homes with %s.", kind, sd.Totals.UnitCount, or(joinAnd(am), "its own streets"))
	ov.Description = []string{facts}
	return ov
}

// siteFit is the brief's fit check for a site: how many homes fit with the streets and shared
// spaces, on lots sized for the brief's home.
func siteFit(r Request, out FitReply) (FitReply, error) {
	ht := sv(r.HousingType)
	trailer := ht == "trailer-park"
	homeType := "house"
	lotSetback, roadW := 1.5, 8.0
	if trailer {
		homeType, lotSetback, roadW = "manufactured", 1.2, 6.5
	}
	ring, err := r.SiteRing()
	if err != nil {
		return out, err
	}
	var cLng, cLat float64
	for _, p := range ring {
		cLng, cLat = cLng+p[0], cLat+p[1]
	}
	frame := NewFrame(cLat/float64(len(ring)), cLng/float64(len(ring)))
	var local []Pt
	for _, p := range ring {
		local = append(local, frame.ToLocal(p))
	}
	area := fv(r.Brief.AreaM2)
	if area <= 0 {
		if trailer {
			area = manufacturedArea(sv(r.Brief.RoomType), iv(r.Brief.Bedrooms))
		} else {
			area = defaultArea("house", iv(r.Brief.Bedrooms), fv(r.Brief.Bathrooms))
		}
	}
	probe := variantRequest(r, homeType, max(1, iv(r.Brief.Bedrooms)), area, ring, nil, lotSetback)
	probe, probe.asks, _ = applyDescription(probe)
	p := DefaultProgram(probe)
	l, err := BuildLayout(p, 0)
	if err != nil {
		return out, err
	}
	nd := l.Needs(0)
	lotW := math.Ceil(nd.Left + nd.W + nd.Right + 2*lotSetback + 2)
	lotD := math.Ceil(nd.Front + nd.D + nd.Back + 2*lotSetback + map[bool]float64{true: 4, false: 7}[trailer])
	sub := subdivide(newSiteFrame(frame, local, r.Site.Properties.Streets), lotW, lotD, roadW, 2)
	shared := max(1, len(r.Advanced.CommonSpaces))
	fit := len(sub.lots) - shared
	want := iv(r.Brief.UnitCount)
	out.Floors = max(1, iv(r.Brief.Floors))
	out.WidthM, out.DepthM = lotW, lotD
	out.FootprintM2 = math.Round(float64(want) * lotW * lotD)
	if out.BuildableM2 > 0 {
		out.Share = r2(out.FootprintM2 / out.BuildableM2)
	}
	switch {
	case fit >= want:
		out.Level = "ok"
		if float64(fit) < float64(want)*1.1 {
			out.Level = "tight"
		}
	default:
		out.Level = "over"
		out.Reason = fmt.Sprintf("Room for %d of the %d homes on %.0f × %.0f m lots with the streets and shared spaces.", max(0, fit), want, lotW, lotD)
	}
	return out, nil
}
