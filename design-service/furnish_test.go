package main

import "testing"

// Storage rooms are lined with shelves, as many as fit.
func TestStorageRoomsGetShelves(t *testing.T) {
	for _, c := range []struct {
		typ  string
		r    Rect
		want int
	}{{"storage", Rect{0, 0, 3, 2.6}, 2}, {"closet", Rect{0, 0, 1.6, 1.2}, 1}, {"pantry", Rect{0, 0, 2, 1.6}, 1}} {
		fs, err := furnish(&LRoom{Key: "k1", Type: c.typ, R: c.r}, "R1", nil)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, f := range fs {
			if f.Type == "shelves" {
				n++
			}
		}
		if n < c.want {
			t.Errorf("%s %.1f × %.1f m: %d shelves, want at least %d", c.typ, c.r.W(), c.r.D(), n, c.want)
		}
	}
}
