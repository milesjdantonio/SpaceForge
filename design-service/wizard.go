package main

// Interactive terminal questions and the saved inputs format (inputs.json,
// compatible with the Python version).

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

type Location struct {
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Label string  `json:"label"`
}

type Setbacks struct {
	Front float64 `json:"front"`
	Rear  float64 `json:"rear"`
	Side  float64 `json:"side"`
}

type Room struct {
	Name     string   `json:"name"`
	Type     string   `json:"type"`
	Floor    int      `json:"floor"`
	LengthFt float64  `json:"length_ft"`
	WidthFt  float64  `json:"width_ft"`
	Features []string `json:"features"`
}

type Interior struct {
	Stories int    `json:"stories"`
	Quality string `json:"quality"`
	Rooms   []Room `json:"rooms"`
}

type Config struct {
	Location   Location   `json:"location"`
	LotFt      [2]float64 `json:"lot_ft"` // width (east-west), depth (north-south)
	SetbacksFt Setbacks   `json:"setbacks_ft"`
	Interior   Interior   `json:"interior"`
}

// ErrInputEnded is raised (via panic) when stdin closes mid-wizard.
var ErrInputEnded = errors.New("input ended")

type Wizard struct {
	in  *bufio.Reader
	out io.Writer
}

func NewWizard(r io.Reader, w io.Writer) *Wizard { return &Wizard{bufio.NewReader(r), w} }

func (w *Wizard) say(format string, a ...any) { fmt.Fprintf(w.out, format+"\n", a...) }

func (w *Wizard) line(prompt string) string {
	fmt.Fprint(w.out, prompt)
	s, err := w.in.ReadString('\n')
	if err != nil && s == "" {
		panic(ErrInputEnded)
	}
	return strings.TrimSpace(s)
}

// Text asks with an optional default ("" = no default, answer required).
func (w *Wizard) Text(prompt, def string) string {
	for {
		sfx := ""
		if def != "" {
			sfx = " [" + def + "]"
		}
		v := w.line(prompt + sfx + ": ")
		switch strings.ToLower(v) {
		case "enter", "default", "<enter>":
			v = "" // typed the word instead of pressing Enter
		}
		if v != "" {
			return v
		}
		if def != "" {
			return def
		}
	}
}

func (w *Wizard) Number(prompt, def string, lo, hi float64, integer bool) float64 {
	for {
		v := w.Text(prompt, def)
		n, err := strconv.ParseFloat(v, 64)
		if err != nil || (integer && n != float64(int(n))) {
			if integer {
				w.say("  Please enter a whole number.")
			} else {
				w.say("  Please enter a number.")
			}
			continue
		}
		if n < lo || n > hi {
			w.say("  Enter a value between %g and %g.", lo, hi)
			continue
		}
		return n
	}
}

func (w *Wizard) Yes(prompt string, def bool) bool {
	hint := "y/N"
	if def {
		hint = "Y/n"
	}
	v := strings.ToLower(w.line(fmt.Sprintf("%s [%s]: ", prompt, hint)))
	if v == "" {
		return def
	}
	return strings.HasPrefix(v, "y")
}

// Choose prints a numbered menu and returns the 0-based index.
func (w *Wizard) Choose(prompt string, options []string, def int) int {
	w.say("%s", prompt)
	for i, o := range options {
		w.say("  %d) %s", i+1, o)
	}
	return int(w.Number("Choose", strconv.Itoa(def), 1, float64(len(options)), true)) - 1
}

// ChooseMany takes comma-separated numbers; blank means none.
func (w *Wizard) ChooseMany(prompt string, options []string) []string {
	if len(options) == 0 {
		return []string{}
	}
	w.say("%s", prompt)
	for i, o := range options {
		w.say("  %d) %s", i+1, o)
	}
	for {
		v := w.line("Numbers separated by commas (blank for none): ")
		if v == "" {
			return []string{}
		}
		var out []string
		seen := map[int]bool{}
		ok := true
		for _, f := range regexp.MustCompile(`[,\s]+`).Split(v, -1) {
			if f == "" {
				continue
			}
			n, err := strconv.Atoi(f)
			if err != nil || n < 1 || n > len(options) {
				ok = false
				break
			}
			if !seen[n] {
				seen[n] = true
				out = append(out, options[n-1])
			}
		}
		if ok {
			return out
		}
		w.say("  Use numbers from the list, like 1,3.")
	}
}

// Geocoder turns an address into coordinates.
type Geocoder func(query string) (lat, lon float64, label string, found bool, err error)

func InUS(lat, lon float64) bool { return lat >= 18 && lat <= 72 && lon >= -180 && lon <= -65 }

var coordRe = regexp.MustCompile(`^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$`)

func askLocation(w *Wizard, geo Geocoder) Location {
	for {
		v := w.Text("Site address, or 'latitude, longitude'", "")
		var lat, lon float64
		label := ""
		if m := coordRe.FindStringSubmatch(v); m != nil {
			lat, _ = strconv.ParseFloat(m[1], 64)
			lon, _ = strconv.ParseFloat(m[2], 64)
		} else {
			la, lo, lb, found, err := geo(v)
			if err != nil {
				w.say("  Address lookup failed (%v). Try 'latitude, longitude' instead.", err)
				continue
			}
			if !found {
				w.say("  Couldn't find that address. Try again or enter coordinates.")
				continue
			}
			lat, lon, label = la, lo, lb
			w.say("  Found: %s (%.5f, %.5f)", label, lat, lon)
			if !w.Yes("  Is that right?", true) {
				continue
			}
		}
		if !InUS(lat, lon) {
			w.say("  The soil, flood and seismic data cover the US only. Enter a US location.")
			continue
		}
		return Location{lat, lon, label}
	}
}

var numericName = regexp.MustCompile(`^[\d.\s]+$`)

func askRoom(w *Wizard, stories int, existing map[string]bool) Room {
	labels := make([]string, len(RoomTypes))
	for i, t := range RoomTypes {
		labels[i] = t.Label
	}
	t := RoomTypes[w.Choose("Room type:", labels, 1)]
	def := t.Label
	for n := 2; existing[def]; n++ {
		def = fmt.Sprintf("%s %d", t.Label, n)
	}
	name := w.Text("  Name", def)
	for existing[name] || numericName.MatchString(name) {
		if existing[name] {
			w.say("  That name is already used.")
		} else {
			w.say("  A room name can't be just a number (press Enter to keep the suggested name).")
		}
		name = w.Text("  Name", def)
	}
	floor := 1
	if stories > 1 {
		floor = int(w.Number("  Floor", "1", 1, float64(stories), true))
	}
	length := w.Number("  Length (ft)", fmt.Sprintf("%g", t.L), 3, 60, false)
	width := w.Number("  Width (ft)", fmt.Sprintf("%g", t.W), 3, 60, false)
	var opts []string
	for _, f := range Features[t.Key] {
		opts = append(opts, f.Name)
	}
	feats := w.ChooseMany("  Features:", opts)
	return Room{name, t.Key, floor, length, width, feats}
}

func CollectInputs(w *Wizard, geo Geocoder) Config {
	w.say("\n=== Site ===")
	loc := askLocation(w, geo)
	lotW := w.Number("Lot width, east-west (ft)", "80", 20, 2000, false)
	lotD := w.Number("Lot depth, north-south (ft)", "150", 20, 2000, false)
	sb := Setbacks{
		Front: w.Number("Front setback, south side (ft)", "25", 0, 200, false),
		Rear:  w.Number("Rear setback, north side (ft)", "20", 0, 200, false),
		Side:  w.Number("Side setbacks (ft)", "8", 0, 200, false),
	}

	w.say("\n=== House ===")
	stories := int(w.Number("Stories", "2", 1, 3, true))
	quality := []string{"budget", "mid-range", "high-end"}[w.Choose("Finish quality:", []string{"Budget", "Mid-range", "High-end"}, 2)]

	w.say("\n=== Rooms ===")
	var rooms []Room
	if w.Choose("Start from:", []string{"Empty list", "3-bed / 2.5-bath template (edit after)"}, 1) == 1 {
		for _, r := range template3BR() {
			if r.Floor > stories {
				r.Floor = stories
			}
			rooms = append(rooms, r)
		}
	}
	for {
		if len(rooms) == 0 {
			w.say("\nNo rooms yet.")
		} else {
			w.say("\nCurrent rooms:")
		}
		for i, r := range rooms {
			f := strings.Join(r.Features, ", ")
			if f == "" {
				f = "—"
			}
			t, _ := roomType(r.Type)
			w.say("  %d. %s (%s), floor %d, %gx%g ft, features: %s", i+1, r.Name, t.Label, r.Floor, r.LengthFt, r.WidthFt, f)
		}
		def := 3
		if len(rooms) == 0 {
			def = 1
		}
		switch w.Choose("What next?", []string{"Add a room", "Remove a room", "Done"}, def) {
		case 0:
			existing := map[string]bool{}
			for _, r := range rooms {
				existing[r.Name] = true
			}
			rooms = append(rooms, askRoom(w, stories, existing))
		case 1:
			if len(rooms) > 0 {
				i := int(w.Number("Room number to remove", "", 1, float64(len(rooms)), true)) - 1
				rooms = append(rooms[:i], rooms[i+1:]...)
			}
		case 2:
			hasFloor1 := false
			for _, r := range rooms {
				hasFloor1 = hasFloor1 || r.Floor == 1
			}
			switch {
			case len(rooms) == 0:
				w.say("  Add at least one room.")
			case !hasFloor1:
				w.say("  Floor 1 needs at least one room.")
			default:
				return Config{loc, [2]float64{lotW, lotD}, sb, Interior{stories, quality, rooms}}
			}
		}
	}
}

// CheckInputs validates a loaded inputs file.
func CheckInputs(c Config) []string {
	var e []string
	if !InUS(c.Location.Lat, c.Location.Lon) {
		e = append(e, "location must be a US latitude/longitude.")
	}
	st := c.Interior.Stories
	if st < 1 || st > 3 {
		e = append(e, "stories must be 1, 2 or 3.")
	}
	if len(c.Interior.Rooms) == 0 {
		e = append(e, "at least one room is required.")
	}
	if c.LotFt[0] <= 0 || c.LotFt[1] <= 0 {
		e = append(e, "lot_ft must be two positive numbers.")
	}
	seen := map[string]bool{}
	for _, r := range c.Interior.Rooms {
		if seen[r.Name] {
			e = append(e, "room names must be unique.")
		}
		seen[r.Name] = true
		if _, ok := roomType(r.Type); !ok {
			e = append(e, fmt.Sprintf("%s: unknown room type %q.", r.Name, r.Type))
		}
		if r.Floor < 1 || r.Floor > st {
			e = append(e, fmt.Sprintf("%s: floor must be 1–%d.", r.Name, st))
		}
		if r.LengthFt <= 0 || r.WidthFt <= 0 {
			e = append(e, fmt.Sprintf("%s: length and width must be positive.", r.Name))
		}
	}
	return e
}
