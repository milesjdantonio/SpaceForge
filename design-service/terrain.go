package main

// Elevation from the USGS 3DEP ImageServer, and the buildable-pad analysis.
//
// The server is asked for the lot as a 1 m grid in UTM metres. 3DEP returns the
// best data it has at that spot (1 m lidar where available, coarser elsewhere)
// resampled to the grid we ask for, so even a small lot has enough pixels.

import (
	"encoding/binary"
	"fmt"
	"math"
	"net/url"
)

type Grid struct {
	Rows, Cols int
	Res        float64   // metres per pixel
	Z          []float64 // row-major, row 0 = north edge; NaN = no data
}

func (g Grid) at(i, j int) float64 { return g.Z[i*g.Cols+j] }

// UTMZone returns the WGS84 UTM zone for a longitude.
func UTMZone(lon float64) int { return int(math.Floor((lon+180)/6)) + 1 }

// ToUTM projects WGS84 latitude/longitude to UTM easting/northing (metres) in the given zone.
func ToUTM(lat, lon float64, zone int) (east, north float64) {
	const a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
	e2 := f * (2 - f)
	ep2 := e2 / (1 - e2)
	rad := math.Pi / 180
	phi, lam := lat*rad, lon*rad
	lam0 := float64((zone-1)*6-180+3) * rad
	sinp, cosp, tanp := math.Sin(phi), math.Cos(phi), math.Tan(phi)
	n := a / math.Sqrt(1-e2*sinp*sinp)
	t := tanp * tanp
	c := ep2 * cosp * cosp
	A := cosp * (lam - lam0)
	m := a * ((1-e2/4-3*e2*e2/64-5*e2*e2*e2/256)*phi -
		(3*e2/8+3*e2*e2/32+45*e2*e2*e2/1024)*math.Sin(2*phi) +
		(15*e2*e2/256+45*e2*e2*e2/1024)*math.Sin(4*phi) -
		(35*e2*e2*e2/3072)*math.Sin(6*phi))
	east = k0*n*(A+(1-t+c)*math.Pow(A, 3)/6+(5-18*t+t*t+72*c-58*ep2)*math.Pow(A, 5)/120) + 500000
	north = k0 * (m + n*tanp*(A*A/2+(5-t+9*c+4*c*c)*math.Pow(A, 4)/24+(61-58*t+t*t+600*c-330*ep2)*math.Pow(A, 6)/720))
	if lat < 0 {
		north += 10000000
	}
	return
}

// FetchDEM gets the lot's elevation on a 1 m grid. Returns the grid and a description of the source.
func FetchDEM(lat, lon float64, lot [2]float64) (Grid, string, error) {
	zone := UTMZone(lon)
	epsg := 32600 + zone
	if lat < 0 {
		epsg = 32700 + zone
	}
	e, n := ToUTM(lat, lon, zone)
	w, d := lot[0]*MPerFt, lot[1]*MPerFt
	cols, rows := max(3, int(math.Round(w))), max(3, int(math.Round(d)))
	q := url.Values{
		"bbox":                 {fmt.Sprintf("%.2f,%.2f,%.2f,%.2f", e-w/2, n-d/2, e+w/2, n+d/2)},
		"bboxSR":               {fmt.Sprint(epsg)},
		"imageSR":              {fmt.Sprint(epsg)},
		"size":                 {fmt.Sprintf("%d,%d", cols, rows)},
		"pixelType":            {"F32"},
		"interpolation":        {"RSP_BilinearInterpolation"},
		"noDataInterpretation": {"esriNoDataMatchAny"},
		"f":                    {"image"},
	}
	src := "USGS 3DEP (best available resolution at this spot), sampled on a 1 m grid"

	// 1st choice: raw band-sequential floats. 2nd: uncompressed GeoTIFF.
	q.Set("format", "bsq")
	data, err := fetch("GET", DemURL+"?"+q.Encode(), nil, "")
	if err == nil && len(data) == rows*cols*4 {
		return Grid{rows, cols, w / float64(cols), decodeFloats(data)}, src, nil
	}
	firstErr := err
	if err == nil {
		firstErr = fmt.Errorf("unexpected bsq reply (%d bytes): %s", len(data), truncate(string(data), 120))
	}
	q.Set("format", "tiff")
	q.Set("compression", "None")
	data, err = fetch("GET", DemURL+"?"+q.Encode(), nil, "")
	if err != nil {
		return Grid{}, "", fmt.Errorf("3DEP elevation request failed (%v; %v)", firstErr, err)
	}
	tw, th, vals, err := ParseFloatTIFF(data)
	if err != nil {
		return Grid{}, "", fmt.Errorf("3DEP returned an unreadable image (%v; first try: %v)", err, firstErr)
	}
	for i, v := range vals {
		if v < -1000 || v > 9000 || math.IsNaN(v) {
			vals[i] = math.NaN()
		}
	}
	return Grid{th, tw, w / float64(tw), vals}, src, nil
}

// decodeFloats reads raw float32s, picking the byte order that gives plausible elevations.
func decodeFloats(data []byte) []float64 {
	decode := func(order binary.ByteOrder) ([]float64, int) {
		out := make([]float64, len(data)/4)
		good := 0
		for i := range out {
			v := float64(math.Float32frombits(order.Uint32(data[i*4:])))
			if v < -1000 || v > 9000 || math.IsNaN(v) {
				v = math.NaN() // no data
			} else {
				good++
			}
			out[i] = v
		}
		return out, good
	}
	le, gl := decode(binary.LittleEndian)
	be, gb := decode(binary.BigEndian)
	if gb > gl {
		return be
	}
	return le
}

// ParseFloatTIFF reads an uncompressed single-band float32 TIFF (strips or tiles).
func ParseFloatTIFF(b []byte) (width, height int, vals []float64, err error) {
	if len(b) < 8 {
		return 0, 0, nil, fmt.Errorf("too short to be a TIFF")
	}
	var bo binary.ByteOrder
	switch string(b[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 0, 0, nil, fmt.Errorf("not a TIFF (starts %q)", truncate(string(b[:min(len(b), 40)]), 40))
	}
	if bo.Uint16(b[2:]) != 42 {
		return 0, 0, nil, fmt.Errorf("unsupported TIFF variant (BigTIFF?)")
	}
	off := int(bo.Uint32(b[4:]))
	if off+2 > len(b) {
		return 0, 0, nil, fmt.Errorf("bad TIFF header")
	}
	tags := map[uint16][]uint32{}
	nEntries := int(bo.Uint16(b[off:]))
	for k := 0; k < nEntries; k++ {
		p := off + 2 + k*12
		if p+12 > len(b) {
			return 0, 0, nil, fmt.Errorf("truncated TIFF directory")
		}
		tag, typ, count := bo.Uint16(b[p:]), bo.Uint16(b[p+2:]), int(bo.Uint32(b[p+4:]))
		size := map[uint16]int{3: 2, 4: 4}[typ]
		if size == 0 {
			continue // only SHORT and LONG values are needed
		}
		valOff := p + 8
		if size*count > 4 {
			valOff = int(bo.Uint32(b[p+8:]))
		}
		if valOff+size*count > len(b) {
			return 0, 0, nil, fmt.Errorf("truncated TIFF tag %d", tag)
		}
		vs := make([]uint32, count)
		for i := range vs {
			if size == 2 {
				vs[i] = uint32(bo.Uint16(b[valOff+i*2:]))
			} else {
				vs[i] = bo.Uint32(b[valOff+i*4:])
			}
		}
		tags[tag] = vs
	}
	get := func(t uint16, def uint32) uint32 {
		if v, ok := tags[t]; ok && len(v) > 0 {
			return v[0]
		}
		return def
	}
	width, height = int(get(256, 0)), int(get(257, 0))
	if width == 0 || height == 0 {
		return 0, 0, nil, fmt.Errorf("TIFF has no size")
	}
	if get(259, 1) != 1 {
		return 0, 0, nil, fmt.Errorf("TIFF is compressed (method %d)", get(259, 1))
	}
	if get(258, 32) != 32 || get(339, 3) != 3 || get(277, 1) != 1 {
		return 0, 0, nil, fmt.Errorf("TIFF is not single-band float32")
	}
	vals = make([]float64, width*height)
	for i := range vals {
		vals[i] = math.NaN()
	}
	put := func(chunk []byte, x0, y0, cw, ch int) {
		for y := 0; y < ch; y++ {
			for x := 0; x < cw; x++ {
				p := (y*cw + x) * 4
				if p+4 > len(chunk) || y0+y >= height || x0+x >= width {
					continue
				}
				vals[(y0+y)*width+x0+x] = float64(math.Float32frombits(bo.Uint32(chunk[p:])))
			}
		}
	}
	slice := func(o, n uint32) []byte {
		if int(o) >= len(b) {
			return nil
		}
		return b[o:min(len(b), int(o+n))]
	}
	if offs, ok := tags[324]; ok { // tiles
		tw, th := int(get(322, 0)), int(get(323, 0))
		counts := tags[325]
		across := (width + tw - 1) / tw
		for t, o := range offs {
			if t < len(counts) {
				put(slice(o, counts[t]), (t%across)*tw, (t/across)*th, tw, th)
			}
		}
	} else { // strips
		rps := int(get(278, uint32(height)))
		counts := tags[279]
		for s, o := range tags[273] {
			if s < len(counts) {
				put(slice(o, counts[s]), 0, s*rps, width, rps)
			}
		}
	}
	return width, height, vals, nil
}

type Terrain struct {
	DemResolutionM  float64  `json:"dem_resolution_m"`
	EnvelopeFt      string   `json:"envelope_ft"`
	FootprintFt     string   `json:"footprint_ft"`
	Fits            bool     `json:"footprint_fits_envelope"`
	SlopeMean       *float64 `json:"slope_mean_percent"`
	SlopeMax        *float64 `json:"slope_max_percent"`
	BestPadSlope    *float64 `json:"best_pad_slope_percent"`
	PadCutCY        int      `json:"pad_cut_cy"`
	PadFillCY       int      `json:"pad_fill_cy"`
	PadMaxCutFt     float64  `json:"pad_max_cut_ft"`
	PadMaxFillFt    float64  `json:"pad_max_fill_ft"`
	PadMethod       string   `json:"pad_method"`
	ElevationSource string   `json:"elevation_source,omitempty"`
}

func fptr(v float64) *float64 { return &v }

// AnalyzeTerrain finds the flattest footprint-sized spot inside the setbacks
// and the cut/fill to level it.
func AnalyzeTerrain(g Grid, footprintSideFt float64, sb Setbacks) Terrain {
	R, C, res := g.Rows, g.Cols, g.Res
	slope := make([]float64, R*C)
	for i := 0; i < R; i++ {
		for j := 0; j < C; j++ {
			slope[i*C+j] = math.Hypot(grad(g, i, j, false), grad(g, i, j, true)) * 100
		}
	}
	sp := int(math.Round(sb.Side * MPerFt / res))
	rp := int(math.Round(sb.Rear * MPerFt / res))  // north edge
	fp := int(math.Round(sb.Front * MPerFt / res)) // south edge
	env := make([]bool, R*C)
	var envSlopes []float64
	for i := rp; i < R-fp; i++ {
		for j := sp; j < C-sp; j++ {
			if !math.IsNaN(g.at(i, j)) {
				env[i*C+j] = true
				if !math.IsNaN(slope[i*C+j]) {
					envSlopes = append(envSlopes, slope[i*C+j])
				}
			}
		}
	}
	sideM := footprintSideFt * MPerFt
	win := max(3, int(math.Ceil(sideM/res)))
	envW, envD := float64(C-2*sp)*res, float64(R-rp-fp)*res
	t := Terrain{DemResolutionM: res,
		EnvelopeFt:  fmt.Sprintf("%.0f x %.0f", math.Max(0, envW)/MPerFt, math.Max(0, envD)/MPerFt),
		FootprintFt: fmt.Sprintf("%.0f x %.0f", footprintSideFt, footprintSideFt),
		Fits:        envW >= sideM && envD >= sideM}
	if len(envSlopes) > 0 {
		t.SlopeMean = fptr(round1(sum(envSlopes) / float64(len(envSlopes))))
		t.SlopeMax = fptr(round1(maxOf(envSlopes)))
	}
	if !t.Fits {
		t.PadMethod = "footprint does not fit inside the setbacks"
		return t
	}

	// Summed-area tables: mean slope of every window, and whether it lies fully in the envelope.
	sat := func(v func(k int) float64) []float64 {
		s := make([]float64, (R+1)*(C+1))
		for i := 0; i < R; i++ {
			for j := 0; j < C; j++ {
				s[(i+1)*(C+1)+j+1] = v(i*C+j) + s[i*(C+1)+j+1] + s[(i+1)*(C+1)+j] - s[i*(C+1)+j]
			}
		}
		return s
	}
	boxSum := func(s []float64, i, j int) float64 {
		w := C + 1
		return s[(i+win)*w+j+win] - s[i*w+j+win] - s[(i+win)*w+j] + s[i*w+j]
	}
	sSat := sat(func(k int) float64 {
		if math.IsNaN(slope[k]) {
			return 1e3
		}
		return slope[k]
	})
	eSat := sat(func(k int) float64 {
		if env[k] {
			return 1
		}
		return 0
	})
	best, bi, bj := math.Inf(1), -1, -1
	full := float64(win * win)
	for i := 0; i+win <= R; i++ {
		for j := 0; j+win <= C; j++ {
			if boxSum(eSat, i, j) == full {
				if m := boxSum(sSat, i, j) / full; m < best {
					best, bi, bj = m, i, j
				}
			}
		}
	}
	if bi < 0 {
		// Grid too small to slide the footprint across: treat the ground as a tilted
		// plane at the average slope, leveled at mid-height.
		s := 0.0
		if t.SlopeMean != nil {
			s = *t.SlopeMean
		}
		rise := s / 100 * sideM
		vol := s / 100 * math.Pow(sideM, 3) / 8
		t.BestPadSlope = fptr(s)
		t.PadCutCY, t.PadFillCY = int(math.Round(vol*CYPerM3)), int(math.Round(vol*CYPerM3))
		t.PadMaxCutFt, t.PadMaxFillFt = round1(rise/2/MPerFt), round1(rise/2/MPerFt)
		t.PadMethod = "estimated from average slope (elevation grid too coarse)"
		return t
	}
	var zs []float64
	for i := bi; i < bi+win; i++ {
		for j := bj; j < bj+win; j++ {
			if v := g.at(i, j); !math.IsNaN(v) {
				zs = append(zs, v)
			}
		}
	}
	mean := sum(zs) / float64(len(zs))
	var cut, fill, maxCut, maxFill float64
	for _, v := range zs {
		d := v - mean
		if d > 0 {
			cut += d
			maxCut = math.Max(maxCut, d)
		} else {
			fill -= d
			maxFill = math.Max(maxFill, -d)
		}
	}
	px := res * res
	t.BestPadSlope = fptr(round1(best))
	t.PadCutCY, t.PadFillCY = int(math.Round(cut*px*CYPerM3)), int(math.Round(fill*px*CYPerM3))
	t.PadMaxCutFt, t.PadMaxFillFt = round1(maxCut/MPerFt), round1(maxFill/MPerFt)
	t.PadMethod = "flattest footprint-sized spot inside the setbacks"
	return t
}

// grad is the elevation change per metre (like numpy.gradient: central inside, one-sided at edges).
func grad(g Grid, i, j int, alongRows bool) float64 {
	n, k := g.Cols, j
	val := func(x int) float64 { return g.at(i, x) }
	if alongRows {
		n, k = g.Rows, i
		val = func(x int) float64 { return g.at(x, j) }
	}
	switch {
	case n < 2:
		return 0
	case k == 0:
		return (val(1) - val(0)) / g.Res
	case k == n-1:
		return (val(n-1) - val(n-2)) / g.Res
	default:
		return (val(k+1) - val(k-1)) / (2 * g.Res)
	}
}
