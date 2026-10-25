package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestBridgeWords(t *testing.T) {
	for text, want := range map[string]bool{
		"a glass bridge between the wings":    true,
		"with a skybridge":                    true,
		"a covered walkway linking the wings": true,
		"near the old bridge in town":         false,
		"Bridgeport colonial":                 false,
	} {
		if got := bridgeRe.MatchString(text); got != want {
			t.Errorf("%q: got %v", text, got)
		}
	}
}

func TestBridge(t *testing.T) {
	for _, c := range []struct {
		ht, prompt string
		floors     int
		area       float64
		want       bool
	}{
		{"mansion", "A U-shaped stone mansion with a glass bridge between the wings.", 2, 900, true},
		{"house", "A modern house with a skybridge.", 2, 560, true},
		{"villa", "A villa with a glass bridge across the garden.", 1, 450, false},
	} {
		t.Run(c.ht, func(t *testing.T) {
			r := testRequest(c.ht)
			r.Brief.DesignPrompt = ptr(c.prompt)
			r.Brief.Floors, r.Brief.AreaM2 = ptr(c.floors), ptr(c.area)
			raw, _ := json.Marshal(r)
			var log bytes.Buffer
			res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &log, Now: time.Now})
			if err != nil {
				t.Fatalf("%v\n%s\n%v", err, log.String(), res.Report.Problems)
			}
			d := res.Design
			found := false
			for _, rm := range d.Levels[len(d.Levels)-1].Rooms {
				if rm.Name == "Bridge" {
					found = true
				}
			}
			if found != c.want {
				t.Fatalf("bridge %v, want %v; cautions %v", found, c.want, d.Overview.Cautions)
			}
			if !c.want {
				if !strings.Contains(strings.Join(d.Overview.Cautions, " "), "bridge was left out") {
					t.Fatalf("no caution saying why: %v", d.Overview.Cautions)
				}
				return
			}
			node, err := exec.LookPath("node")
			if err != nil {
				t.Skip("Node.js is needed for the website's checks")
			}
			body, _ := json.Marshal(res)
			cmd := exec.Command(node, "--input-type=module", "-e", `
import { readFileSync } from 'node:fs';
import { checkDesign } from './frontend/js/lib/design.js';
const result = checkDesign(JSON.parse(readFileSync(0, 'utf8')).design);
if (!result.ok) throw new Error(JSON.stringify(result.errors));
`)
			cmd.Dir = ".."
			cmd.Stdin = bytes.NewReader(body)
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("website rejected it: %v\n%s", err, output)
			}
		})
	}
}
