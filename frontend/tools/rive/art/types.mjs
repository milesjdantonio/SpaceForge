// types.riv: one small isometric drawing per housing type, for the brief's type cards. Artboards:
// House, Tiny, Townhouse, Duplex, Mansion, Villa, Apartment, Condo, Dorm, Hotel, Neighborhood, Trailer. Each draws itself in, lifts on hover and
// lights its windows when selected.
//
// State machine "Type": bool `hover`, bool `selected`.

import { RivFile, EASE } from '../riv.mjs';
import { COLORS, iso, mix } from '../helpers.mjs';

const W = 160, H = 104;
const LINE = '#c9d6e8';
const FACE_L = '#1d2735', FACE_R = '#253244', FACE_T = '#2e3d52';
const WIN_OFF = '#3a4a60';
const AMBER = COLORS.amber, EMBER = COLORS.ember;

// A small builder for one artboard: boxes, gable roofs and windows in isometric space.
function drawing(f, name, k, center, compose) {
  const ab = f.artboard({ name, width: W, height: H });
  // Points are drawn about (0, 0) and remembered, so the finished drawing can be centred and
  // scaled to fit the artboard.
  const seen = [];
  const project = iso(0, 0, k);
  const P = (p) => { const q = project(p); seen.push(q); return q; };
  void center;
  const frame = ab.node(null, { name: 'frame' });
  const shadow = ab.shape(frame, { name: 'shadow' });
  const shadowEllipse = ab.ellipse(shadow, { w: 10, h: 10 });
  ab.fill(shadow, '#000000', { alpha: 0.3 });
  const body = ab.node(frame, { name: 'body' });
  const strokes = [], windows = [], roofs = [];
  const poly = (pts, fill, { line = true, kind } = {}) => {
    const s = ab.shape(body);
    ab.path(s, pts.map(P));
    const fl = ab.fill(s, fill);
    if (line) strokes.push(ab.stroke(s, LINE, 1.1, { alpha: 0.9 }));
    if (kind === 'roof') { fl.base = fill; roofs.push(fl); }
    return s;
  };
  const api = {
    box([x0, y0, z0], [x1, y1, z1], { top = true } = {}) {
      poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], FACE_L);   // front-left (y = y1)
      poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], FACE_R);   // front-right (x = x1)
      if (top) poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], FACE_T, { kind: 'roof' });
    },
    // Gable roof over a box, ridge along x, rising `h` above `z`.
    gable([x0, y0], [x1, y1], z, h, eave = 0.12) {
      const ym = (y0 + y1) / 2;
      poly([[x0 - eave, y0 - eave, z], [x1 + eave, y0 - eave, z], [x1 + eave, ym, z + h], [x0 - eave, ym, z + h]], mix(FACE_T, '#000000', 0.15), { kind: 'roof' });
      poly([[x1, y0, z], [x1, y1, z], [x1, ym, z + h]], FACE_R);
      poly([[x0 - eave, y1 + eave, z], [x1 + eave, y1 + eave, z], [x1 + eave, ym, z + h], [x0 - eave, ym, z + h]], FACE_T, { kind: 'roof' });
    },
    // Windows on the front-left face (y = y) or front-right face (x = x).
    windowsL(y, xs, zs, w = 0.32, h = 0.36) {
      for (const z of zs) for (const x of xs) {
        const s = ab.shape(body);
        ab.path(s, [[x, y, z], [x + w, y, z], [x + w, y, z + h], [x, y, z + h]].map(P));
        windows.push(ab.fill(s, WIN_OFF));
      }
    },
    windowsR(x, ys, zs, w = 0.32, h = 0.36) {
      for (const z of zs) for (const y of ys) {
        const s = ab.shape(body);
        ab.path(s, [[x, y, z], [x, y + w, z], [x, y + w, z + h], [x, y, z + h]].map(P));
        windows.push(ab.fill(s, WIN_OFF));
      }
    },
    door(y, x, w = 0.34, h = 0.62) {
      const s = ab.shape(body);
      ab.path(s, [[x, y, 0], [x + w, y, 0], [x + w, y, h], [x, y, h]].map(P));
      windows.push(ab.fill(s, mix(WIN_OFF, '#000000', 0.2)));
    },
    poly,
  };
  compose(api);

  // Fit: centre the drawing with a margin, and lay a soft shadow under its base.
  const xs = seen.map((p) => p[0]), ys = seen.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const scale = Math.min((W - 20) / (x1 - x0), (H - 22) / (y1 - y0), 1.8);
  frame.props.scaleX = scale;
  frame.props.scaleY = scale;
  frame.props.x = W / 2 - ((x0 + x1) / 2) * scale;
  frame.props.y = (H - 6) / 2 - ((y0 + y1) / 2) * scale + 2;
  Object.assign(shadowEllipse.props, { x: (x0 + x1) / 2, y: y1 - 1, width: (x1 - x0) * 0.86, height: 9 / scale });

  // Animations. Layer "Lift": rest / up. Layer "Light": intro (draws in), off, on.
  const trims = strokes.map((s) => ab.trim(s, { end: 1 }));
  const rest = ab.animation('rest', { duration: 18 });
  rest.key(body, 'y', [[0, -3, EASE.out], [18, 0]]);
  const up = ab.animation('up', { duration: 22 });
  up.key(body, 'y', [[0, 0, EASE.back], [22, -4]]);
  const intro = ab.animation('intro', { duration: 46 });
  trims.forEach((t, i) => intro.key(t, 'end', [[0, 0, 'hold'], [Math.min(14, i), 0, EASE.inOut], [Math.min(14, i) + 30, 1]]));
  windows.forEach((w) => intro.key(w, 'colorValue', [[0, WIN_OFF, 'hold']]));
  roofs.forEach((r) => intro.key(r, 'colorValue', [[0, r.base, 'hold']]));
  const off = ab.animation('off', { duration: 20 });
  const on = ab.animation('on', { duration: 30 });
  trims.forEach((t) => { off.key(t, 'end', [[0, 1, 'hold']]); on.key(t, 'end', [[0, 1, 'hold']]); });
  windows.forEach((w, i) => {
    off.key(w, 'colorValue', [[0, EMBER, EASE.inOut], [16, WIN_OFF]]);
    const d = (i * 3) % 14;
    on.key(w, 'colorValue', [[0, WIN_OFF, 'hold'], [d, WIN_OFF, EASE.out], [d + 12, i % 3 === 1 ? AMBER : EMBER]]);
  });
  roofs.forEach((r) => {
    off.key(r, 'colorValue', [[0, mix(r.base, AMBER, 0.35), EASE.inOut], [16, r.base]]);
    on.key(r, 'colorValue', [[0, r.base, EASE.out], [20, mix(r.base, AMBER, 0.35)]]);
  });

  const sm = ab.stateMachine('Type');
  const hover = sm.bool('hover', false);
  const selected = sm.bool('selected', false);
  const lift = sm.layer('Lift');
  const sRest = lift.state(rest), sUp = lift.state(up);
  lift.transition(lift.entry, sRest);
  lift.transition(sRest, sUp, { conditions: [{ input: hover, value: true }] });
  lift.transition(sUp, sRest, { conditions: [{ input: hover, value: false }] });
  const light = sm.layer('Light');
  const sIntro = light.state(intro), sOff = light.state(off), sOn = light.state(on);
  light.transition(light.entry, sIntro);
  light.transition(sIntro, sOn, { conditions: [{ input: selected, value: true }], exitTime: 100, percent: true });
  light.transition(sIntro, sOff, { exitTime: 100, percent: true });
  light.transition(sOff, sOn, { conditions: [{ input: selected, value: true }] });
  light.transition(sOn, sOff, { conditions: [{ input: selected, value: false }] });
  return ab;
}

export default function build() {
  const f = new RivFile();

  drawing(f, 'House', 17, [72, 40], (d) => {
    d.box([0, 0, 0], [2.6, 1.8, 1.25], { top: false });
    d.windowsL(1.8, [0.3, 1.7], [0.45]);
    d.door(1.8, 1.05);
    d.windowsR(2.6, [0.4, 1.1], [0.45]);
    d.gable([0, 0], [2.6, 1.8], 1.25, 1.0);
  });

  drawing(f, 'Tiny', 20, [78, 44], (d) => {
    d.box([0, 0, 0], [1.6, 1.2, 1.0], { top: false });
    d.door(1.2, 0.95, 0.3, 0.6);
    d.windowsL(1.2, [0.25], [0.45], 0.4, 0.3);
    d.windowsR(1.6, [0.35], [0.4]);
    d.gable([0, 0], [1.6, 1.2], 1.0, 1.05, 0.1);
  });

  drawing(f, 'Townhouse', 15, [64, 36], (d) => {
    for (let k = 0; k < 3; k++) {
      const x0 = k * 1.15;
      d.box([x0, 0, 0], [x0 + 1.15, 1.7, 1.9], { top: false });
      d.windowsL(1.7, [x0 + 0.2], [1.1], 0.3, 0.38);
      d.door(1.7, x0 + 0.62, 0.3, 0.6);
      d.gable([x0, 0], [x0 + 1.15, 1.7], 1.9, 0.7, 0.05);
    }
    d.windowsR(3.45, [0.4, 1.0], [0.4, 1.1], 0.3, 0.38);
  });

  drawing(f, 'Duplex', 16, [70, 40], (d) => {
    d.box([0, 0, 0], [3.0, 1.8, 1.3], { top: false });
    d.poly([[1.5, 1.8, 0], [1.5, 1.8, 1.3]], FACE_L);
    d.door(1.8, 0.95, 0.32, 0.62);
    d.door(1.8, 1.73, 0.32, 0.62);
    d.windowsL(1.8, [0.25, 2.45], [0.45], 0.32, 0.36);
    d.windowsR(3.0, [0.45, 1.05], [0.45]);
    d.gable([0, 0], [3.0, 1.8], 1.3, 0.95);
  });

  drawing(f, 'Apartment', 13, [80, 24], (d) => {
    d.box([0, 0, 0], [2.4, 2.0, 4.2]);
    d.windowsL(2.0, [0.25, 0.95, 1.65], [0.35, 1.15, 1.95, 2.75, 3.55], 0.42, 0.42);
    d.windowsR(2.4, [0.25, 0.95, 1.55], [0.35, 1.15, 1.95, 2.75, 3.55], 0.38, 0.42);
    d.box([0.9, 0.7, 4.2], [1.6, 1.3, 4.6]);
  });

  drawing(f, 'Condo', 13, [76, 24], (d) => {
    d.box([0, 0, 0], [2.6, 2.2, 2.6]);
    d.windowsL(2.2, [0.25, 1.0, 1.75], [0.35, 1.25], 0.55, 0.55);
    d.windowsR(2.6, [0.3, 1.2], [0.35, 1.25], 0.55, 0.55);
    d.box([0, 0, 2.6], [1.8, 1.6, 4.4]);
    d.windowsL(1.6, [0.2, 1.0], [2.9, 3.6], 0.55, 0.45);
    d.windowsR(1.8, [0.25, 0.9], [2.9, 3.6], 0.45, 0.45);
    // Balcony rails along the lower block's front.
    for (const z of [1.0, 1.9]) d.poly([[0, 2.35, z], [2.6, 2.35, z], [2.6, 2.35, z + 0.08], [0, 2.35, z + 0.08]], mix(LINE, FACE_L, 0.6), { line: false });
  });

  drawing(f, 'Dorm', 12, [62, 34], (d) => {
    d.box([0, 0, 0], [4.4, 1.8, 2.6]);
    d.windowsL(1.8, [0.25, 0.85, 1.45, 2.65, 3.25, 3.85], [0.3, 1.05, 1.8], 0.36, 0.42);
    d.door(1.8, 1.95, 0.5, 0.6);
    d.windowsR(4.4, [0.3, 1.0], [0.3, 1.05, 1.8], 0.36, 0.42);
    d.box([1.75, 1.8, 0.75], [2.85, 2.2, 0.85]);
  });

  // A tall middle block between two lower wings, every block under its own gable.
  drawing(f, 'Mansion', 12, [70, 36], (d) => {
    d.box([-1.1, 0.25, 0], [0, 1.65, 1.3], { top: false });
    d.windowsL(1.65, [-0.85, -0.4], [0.45], 0.3, 0.38);
    d.gable([-1.1, 0.25], [0, 1.65], 1.3, 0.55, 0.06);
    d.box([0, 0, 0], [2.4, 1.9, 2.1], { top: false });
    d.windowsL(1.9, [0.25, 0.75, 1.45, 1.95], [0.4, 1.3], 0.28, 0.42);
    d.door(1.9, 1.04, 0.34, 0.66);
    d.windowsR(2.4, [0.3, 1.2], [0.4, 1.3], 0.32, 0.42);
    d.gable([0, 0], [2.4, 1.9], 2.1, 0.85, 0.1);
    d.box([2.4, 0.25, 0], [3.5, 1.65, 1.3], { top: false });
    d.windowsL(1.65, [2.65, 3.1], [0.45], 0.3, 0.38);
    d.windowsR(3.5, [0.55, 1.05], [0.45], 0.3, 0.38);
    d.gable([2.4, 0.25], [3.5, 1.65], 1.3, 0.55, 0.06);
  });

  // Long and low under a shallow tile roof, a wing behind, and a pergola over the terrace.
  drawing(f, 'Villa', 15, [66, 42], (d) => {
    d.box([0, -1.1, 0], [1.2, 0, 0.95], { top: false });
    d.gable([0, -1.1], [1.2, 0], 0.95, 0.35, 0.08);
    d.box([0, 0, 0], [3.0, 1.7, 1.0], { top: false });
    d.windowsL(1.7, [0.3, 0.9, 2.2], [0.3], 0.34, 0.5);
    d.door(1.7, 1.45, 0.4, 0.66);
    d.windowsR(3.0, [0.35, 1.0], [0.3], 0.34, 0.5);
    d.gable([0, 0], [3.0, 1.7], 1.0, 0.42, 0.14);
    // Terrace and pergola beside it.
    d.poly([[3.0, 0.2, 0.04], [4.1, 0.2, 0.04], [4.1, 1.7, 0.04], [3.0, 1.7, 0.04]], FACE_T, { line: false });
    for (const [x, y] of [[4.0, 0.3], [4.0, 1.6]]) d.poly([[x, y, 0], [x + 0.08, y, 0], [x + 0.08, y, 0.85], [x, y, 0.85]], mix(LINE, FACE_R, 0.4), { line: false });
    for (const y of [0.3, 0.75, 1.2, 1.6]) d.poly([[3.0, y, 0.85], [4.1, y, 0.85], [4.1, y + 0.06, 0.9], [3.0, y + 0.06, 0.9]], mix(LINE, FACE_T, 0.5), { line: false });
  });

  // A tall block with a glazed ground floor, a canopy over the entrance and a sign on the roof.
  drawing(f, 'Hotel', 12, [76, 22], (d) => {
    d.box([0, 0, 0], [2.8, 2.0, 4.8]);
    d.windowsL(2.0, [0.2, 0.75, 1.3, 1.85, 2.4], [1.25, 2.0, 2.75, 3.5, 4.2], 0.26, 0.38);
    d.windowsR(2.8, [0.25, 0.8, 1.35], [1.25, 2.0, 2.75, 3.5, 4.2], 0.3, 0.38);
    d.windowsL(2.0, [0.15, 0.85, 1.95], [0.2], 0.6, 0.65);
    d.door(2.0, 1.2, 0.55, 0.75);
    d.box([0.95, 2.0, 0.85], [2.0, 2.45, 0.95]);
    d.box([0.8, 0.9, 4.8], [2.0, 1.05, 5.25]);
  });

  // Small houses along a street, two on each side.
  drawing(f, 'Neighborhood', 11, [70, 40], (d) => {
    d.poly([[-0.3, 1.9, 0.01], [5.3, 1.9, 0.01], [5.3, 2.7, 0.01], [-0.3, 2.7, 0.01]], mix(FACE_T, '#000000', 0.35), { line: false });
    for (const [x, y] of [[0, 0], [2.8, 0], [0, 3.1], [2.8, 3.1]]) {
      d.box([x, y, 0], [x + 1.6, y + 1.4, 0.9], { top: false });
      d.windowsL(y + 1.4, [x + 0.25], [0.3], 0.3, 0.3);
      d.door(y + 1.4, x + 1.0, 0.26, 0.5);
      d.gable([x, y], [x + 1.6, y + 1.4], 0.9, 0.6, 0.06);
    }
  });

  // Long, low manufactured homes side by side on their pads.
  drawing(f, 'Trailer', 13, [72, 44], (d) => {
    for (const y of [0, 1.9]) {
      d.poly([[-0.2, y - 0.15, 0.01], [4.4, y - 0.15, 0.01], [4.4, y + 1.35, 0.01], [-0.2, y + 1.35, 0.01]], mix(FACE_T, '#000000', 0.3), { line: false });
      d.box([0, y, 0.15], [4.2, y + 1.2, 0.95], { top: false });
      d.windowsL(y + 1.2, [0.35, 1.2, 2.6, 3.4], [0.45], 0.36, 0.3);
      d.door(y + 1.2, 1.9, 0.3, 0.62);
      d.gable([0, y], [4.2, y + 1.2], 0.95, 0.25, 0.05);
    }
  });

  return f;
}
