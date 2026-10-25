package main

import (
	"bytes"
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestSites(t *testing.T) {
	for _, ht := range []string{"neighborhood", "trailer-park"} {
		t.Run(ht, func(t *testing.T) {
			r := testRequest(ht)
			raw, _ := json.Marshal(r)
			var log bytes.Buffer
			res, err := RunRequest(raw, Deps{FetchSite: fakeSite, Ask: (&fakeGemma{t: t, r: r}).ask, Log: &log, Now: time.Now})
			if err != nil || res.SiteDesign == nil {
				t.Fatalf("%v\n%s\n%v", err, log.String(), res.Report.Problems)
			}
			sd := res.SiteDesign
			if sd.Totals.UnitCount != 16 || len(sd.Homes) != 16 || len(sd.Roads) < 2 || len(sd.Amenities) == 0 || sd.Cost == nil {
				t.Fatalf("homes %d roads %d amenities %d cautions %v\n%s", len(sd.Homes), len(sd.Roads), len(sd.Amenities), sd.Overview.Cautions, log.String())
			}
			// Every home stands inside its lot.
			lots := map[string]SLot{}
			for _, l := range sd.Lots {
				lots[l.ID] = l
			}
			vars := map[string]*Design{}
			for _, v := range sd.Variants {
				vars[v.ID] = v.Design
			}
			for _, h := range sd.Homes {
				d := vars[h.Variant]
				lot := lots[h.LotID]
				a := h.RotationDeg * math.Pi / 180
				for _, c := range []Pt{{0, 0}, {d.Size.WidthM, 0}, {d.Size.WidthM, d.Size.DepthM}, {0, d.Size.DepthM}} {
					q := Pt{h.X + c[0]*math.Cos(a) - c[1]*math.Sin(a), h.Y + c[0]*math.Sin(a) + c[1]*math.Cos(a)}
					if !PointInPoly(q, lot.Polygon) && distToPolyEdge(q, lot.Polygon) > 0.05 {
						t.Fatalf("home %s corner %v is outside lot %s %v", h.ID, q, lot.ID, lot.Polygon)
					}
				}
			}
		})
	}
}
