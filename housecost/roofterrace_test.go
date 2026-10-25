package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"testing"
	"time"
)

// A roof terrace adds a stair house on a flat roof and a railed terrace off its landing, for a
// one-floor house as well as for bigger buildings, and passes both sets of checks.
func TestRoofTerrace(t *testing.T) {
	for _, ht := range []string{"house", "tiny-home", "apartment", "hotel", "mansion"} {
		t.Run(ht, func(t *testing.T) {
			r := testRequest(ht)
			r.Advanced.Extras = []string{"roof-terrace"}
			if ht == "house" {
				r.Brief.Floors = ptr(1)
			}
			raw, _ := json.Marshal(r)
			var log bytes.Buffer
			res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &log, Now: time.Now})
			if err != nil {
				t.Fatalf("%v\n%s\n%v", err, log.String(), res.Report.Problems)
			}
			d := res.Design
			ring, _ := r.SiteRing()
			if probs := CheckDesign(d, ring, r.Setback()); len(probs) > 0 {
				t.Fatalf("checks: %v", probs)
			}
			roof := d.Levels[len(d.Levels)-1]
			if !roof.Roof || roof.Name != "Roof" || len(roof.Balconies) != 1 {
				t.Fatalf("no roof level with a terrace: %+v cautions %v", roof.Name, d.Overview.Cautions)
			}
			if d.Exterior.Roof.Type != "flat" {
				t.Fatalf("roof is %s, want flat", d.Exterior.Roof.Type)
			}
			if d.Totals.Floors != iv(r.Brief.Floors) {
				t.Fatalf("totals.floors %d, want %d (the roof level isn't a floor)", d.Totals.Floors, iv(r.Brief.Floors))
			}
			last := d.Stairs[len(d.Stairs)-1]
			if last.ToLevel != roof.Index {
				t.Fatalf("no stair reaches the roof: %+v", d.Stairs)
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
