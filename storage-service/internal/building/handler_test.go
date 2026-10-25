package building

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildingInputValidation(t *testing.T) {
	for _, tt := range []struct {
		name, contentType, body string
		want                    int
	}{
		{"renderer object", "application/json", `{"name":"House","data":{"meshes":[],"camera":{"x":1},"schemaVersion":1}}`, 200},
		{"media type parameters", "application/json; charset=utf-8", `{"name":"House","data":{}}`, 200},
		{"wrong media type", "text/plain", `{"name":"House","data":{}}`, 415},
		{"malformed JSON", "application/json", `{"name":`, 400},
		{"missing data", "application/json", `{"name":"House"}`, 400},
		{"null data", "application/json", `{"name":"House","data":null}`, 400},
		{"array data", "application/json", `{"name":"House","data":[]}`, 400},
		{"string data", "application/json", `{"name":"House","data":"scene"}`, 400},
		{"empty name", "application/json", `{"name":"  ","data":{}}`, 400},
		{"long name", "application/json", `{"name":"` + strings.Repeat("x", 121) + `","data":{}}`, 400},
		{"null in name", "application/json", `{"name":"a\u0000b","data":{}}`, 400},
		{"owner injection", "application/json", `{"name":"House","data":{},"owner_id":"another-user"}`, 400},
		{"role injection", "application/json", `{"name":"House","data":{},"role":"admin"}`, 400},
		{"multiple documents", "application/json", `{"name":"House","data":{}} {}`, 400},
		{"trailing garbage", "application/json", `{"name":"House","data":{}} x`, 400},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/buildings", strings.NewReader(tt.body))
			r.Header.Set("Content-Type", tt.contentType)
			w := httptest.NewRecorder()
			_, ok := decodeInput(w, r)
			if w.Code != tt.want || ok != (tt.want == 200) {
				t.Fatalf("ok=%v status=%d body=%s", ok, w.Code, w.Body)
			}
		})
	}
}
