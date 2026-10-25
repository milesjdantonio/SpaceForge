package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestCurvedInsideWords(t *testing.T) {
	for text, want := range map[string]bool{
		"Soft, curved interior walls and lots of light": true,
		"inside walls that curve":                       true,
		"a curving wall in the living room":             true,
		"A modern box with straight lines":              false,
		"A round house":                                 false,
	} {
		if got := curvedInsideFromPrompt(text); got != want {
			t.Errorf("%q: got %v", text, got)
		}
	}
	if s := shapeFromPrompt("A brick farmhouse with curved interior walls"); s != "" {
		t.Errorf("curved interior walls read as shape %q", s)
	}
}

func TestCurvedInsideWalls(t *testing.T) {
	for _, c := range []struct{ ht, prompt string }{
		{"house", "A calm house with curved interior walls."},
		{"mansion", "An L-shaped mansion with curving interior walls."},
		{"apartment", "Apartments with a curved feature wall in the lobby."},
		{"house", "A round house with curved inside walls too."},
	} {
		t.Run(c.ht+"/"+c.prompt[:12], func(t *testing.T) {
			r := testRequest(c.ht)
			r.Brief.DesignPrompt = ptr(c.prompt)
			raw, _ := json.Marshal(r)
			var log bytes.Buffer
			res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &log, Now: time.Now})
			if err != nil {
				t.Fatalf("%v\n%s\n%v", err, log.String(), res.Report.Problems)
			}
			d := res.Design
			curved := 0
			for _, lv := range d.Levels {
				for _, w := range lv.Walls {
					if w.Arc != nil && w.Kind == "interior" {
						curved++
					}
				}
			}
			if curved == 0 {
				t.Fatalf("no curved inside wall; cautions %v\n%s", d.Overview.Cautions, log.String())
			}
			for _, cc := range d.Overview.Cautions {
				if strings.Contains(cc, "inside are drawn straight") {
					t.Fatalf("caution: %s", cc)
				}
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
