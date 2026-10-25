// failed.riv: shown in the generating panel when a design doesn't come back. It picks up where
// forge.riv's building left off and tells what happened, large and plain enough to read at panel size:
//   1. the building stands on its land, windows lit (the design was being made),
//   2. its windows go dark floor by floor from the top and its edges flash red (something failed),
//   3. a crack runs down its face, it shudders, and the upper floors shear off and fall to the
//      ground, one after another, with a puff of dust each,
//   4. the land under it flashes red and dims; the fallen floors and the cracked base fade away,
//   5. the outline of the building draws itself on the empty land in red and a warning badge rises,
//   6. the outline turns amber and a wave of light passes over the land: ready to try again.
// Then it rests: the outline breathes and a soft wave passes now and then.
//
// State machine "Failed": plays "fall" once (about 6.5 s), then loops "rest". There is no button in
// the art: the panel's own buttons (Gemma's recommendation first) are what to press.

import { RivFile, EASE } from '../riv.mjs';
import { COLORS, iso, mix } from '../helpers.mjs';

const W = 800, H = 520;
const N = 7, K = 46;                // land tiles per side; pixels per grid unit
const X = [2.3, 4.7], Y = [2.0, 5.0]; // the building's footprint, grid units
const FLOORS = 4, STOREY = 0.78;
const BAD = '#ff6b5e', BAD_SOFT = '#ff8f8f';
const L = 400;                      // the "fall" animation, in frames (60 a second)

const T = {
  dark: 34,        // windows start going dark (top floor first)
  red: 64,         // edges flash red
  crack: 70,       // the crack runs down the face
  shake: [74, 104],
  fall: 104,       // the top floor goes first; each lower one 13 frames later
  dim: 190,        // the land dims
  fade: [214, 262],
  outline: [236, 276],
  badge: 262,
  amber: [300, 330],
  scan: [316, 372],
};

export default function build() {
  const f = new RivFile();
  const ab = f.artboard({ name: 'Failed', width: W, height: H });
  const P = iso(W / 2, 140, K);
  const unit = K;
  const bg = ab.shape(null);
  ab.rect(bg, { w: W, h: H });
  ab.fill(bg, '#121a26');

  const fall = ab.animation('fall', { duration: L });
  const rest = ab.animation('rest', { duration: 300, loop: 1 });
  // Every keyed property also gets its final value held in "rest", unless rest has its own frames.
  const both = (target, prop, frames, restFrames) => {
    fall.key(target, prop, frames);
    rest.key(target, prop, restFrames ?? [[0, frames[frames.length - 1][1], 'hold']]);
  };

  // ---- the land ----------------------------------------------------------------------------------
  const tile = mix('#223044', '#ffffff', 0.14), tileDim = mix('#223044', '#000000', 0.25);
  const under = (i, j) => i + 1 > X[0] - 0.6 && i < X[1] + 0.6 && j + 1 > Y[0] - 0.6 && j < Y[1] + 0.6;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const g = 0.08, s = ab.shape(null);
      ab.path(s, [P([i + g, j + g]), P([i + 1 - g, j + g]), P([i + 1 - g, j + 1 - g]), P([i + g, j + 1 - g])]);
      const fill = ab.fill(s, tile);
      const d = Math.hypot(i + 0.5 - (X[0] + X[1]) / 2, j + 0.5 - (Y[0] + Y[1]) / 2);
      const at = T.fall + 40 + Math.round(d * 5);
      const hot = mix(tile, BAD, under(i, j) ? 0.55 : 0.22);
      const scanAt = T.scan[0] + ((i + j) / (2 * N)) * (T.scan[1] - T.scan[0]);
      const warm = mix(tileDim, COLORS.amber, 0.25);
      both(fill, 'colorValue', [[0, tile, 'hold'], [at, tile, EASE.out], [at + 6, hot, EASE.inOut], [T.dim + 20, tileDim, 'hold'],
        [scanAt - 6, tileDim, EASE.out], [scanAt, warm, EASE.inOut], [scanAt + 24, tileDim, 'hold'], [L, tileDim]],
      // At rest the scan passes again, gently.
      [[0, tileDim, 'hold'], [150 + (i + j) * 4, tileDim, EASE.out], [156 + (i + j) * 4, mix(tileDim, COLORS.amber, 0.14), EASE.inOut], [180 + (i + j) * 4, tileDim, 'hold'], [300, tileDim]]);
    }
  }

  // ---- the floors --------------------------------------------------------------------------------
  const base = P([X[1], Y[1], 0]);
  const rel = (p) => { const q = P(p); return [q[0] - base[0], q[1] - base[1]]; };
  const faceL = '#2c3c52', faceR = '#3a4c66', faceTop = '#4a5f7d';
  const lit = '#ffd08a', dark = '#1a2230';
  // Where each falling floor lands: [dx, dy, rotation], relative to where it stood (screen px).
  const LAND = [null, [-190, 34, -0.3], [196, 22, 0.34], [-14, 74, 0.1]];
  const dust = [];
  const floors = [];
  for (let fl = 0; fl < FLOORS; fl++) {
    const lift = -fl * STOREY * unit;
    const node = ab.node(null, { name: `floor-${fl}`, x: base[0], y: base[1] + lift });
    const z1 = STOREY - 0.04;
    // Front-left face (y = Y1), front-right face (x = X1), top.
    const sl = ab.shape(node);
    ab.path(sl, [rel([X[0], Y[1], 0]), rel([X[1], Y[1], 0]), rel([X[1], Y[1], z1]), rel([X[0], Y[1], z1])]);
    ab.fill(sl, faceL);
    ab.stroke(sl, '#0b111a', 1, { alpha: 0.5 });
    const sr = ab.shape(node);
    ab.path(sr, [rel([X[1], Y[0], 0]), rel([X[1], Y[1], 0]), rel([X[1], Y[1], z1]), rel([X[1], Y[0], z1])]);
    ab.fill(sr, faceR);
    ab.stroke(sr, '#0b111a', 1, { alpha: 0.5 });
    const top = ab.shape(node);
    ab.path(top, [rel([X[0], Y[0], z1]), rel([X[1], Y[0], z1]), rel([X[1], Y[1], z1]), rel([X[0], Y[1], z1])]);
    ab.fill(top, faceTop);
    const edge = ab.stroke(top, COLORS.amber, 2, { alpha: 0.95 });

    // Windows: lit, then dark from the top floor down, with a red flicker as they go.
    const offAt = T.dark + (FLOORS - 1 - fl) * 7;
    const windows = [];
    const wz0 = z1 * 0.3, wz1 = z1 * 0.72;
    const nL = 4, nR = 3;
    for (let k = 0; k < nL; k++) {
      const a = X[0] + ((k + 0.25) / nL) * (X[1] - X[0]), b = X[0] + ((k + 0.75) / nL) * (X[1] - X[0]);
      const s = ab.shape(node);
      ab.path(s, [rel([a, Y[1], wz0]), rel([b, Y[1], wz0]), rel([b, Y[1], wz1]), rel([a, Y[1], wz1])]);
      windows.push(ab.fill(s, lit));
    }
    for (let k = 0; k < nR; k++) {
      const a = Y[0] + ((k + 0.25) / nR) * (Y[1] - Y[0]), b = Y[0] + ((k + 0.75) / nR) * (Y[1] - Y[0]);
      const s = ab.shape(node);
      ab.path(s, [rel([X[1], a, wz0]), rel([X[1], b, wz0]), rel([X[1], b, wz1]), rel([X[1], a, wz1])]);
      windows.push(ab.fill(s, mix(lit, '#ffffff', 0.15)));
    }
    windows.forEach((w, k) => {
      const t = offAt + (k % 3);
      both(w, 'colorValue', [[0, lit, 'hold'], [t, lit, EASE.out], [t + 3, BAD_SOFT, EASE.out], [t + 6, mix(lit, dark, 0.5), EASE.out], [t + 9, BAD_SOFT, EASE.in], [t + 14, dark, 'hold'], [L, dark]]);
    });
    // Edges flash red and stay a dull red.
    const red = mix(COLORS.amber, BAD, 0.7);
    both(edge, 'colorValue', [[0, COLORS.amber, 'hold'], [T.red, COLORS.amber, EASE.out], [T.red + 5, BAD, EASE.inOut], [T.red + 30, red, 'hold'], [L, red]]);
    floors.push(node);

    const sy = base[1] + lift;
    // Everything fades away once it has fallen.
    const fadeTo = (y) => [[0, 1, 'hold'], [T.fade[0] + fl * 4, 1, EASE.inOut], [T.fade[1] + fl * 4, 0, 'hold'], [L, 0]];
    const land = LAND[fl];
    if (!land) {
      // The base stays where it is, cracked, then sinks a little as it fades.
      both(node, 'opacity', fadeTo());
      both(node, 'y', [[0, sy, 'hold'], [T.fade[0], sy, EASE.in], [T.fade[1], sy + 18, 'hold'], [L, sy + 18]]);
      both(node, 'x', [[0, base[0], 'hold'], [T.shake[0], base[0], EASE.inOut], [T.shake[0] + 6, base[0] + 3, EASE.inOut], [T.shake[0] + 12, base[0] - 3, EASE.inOut], [T.shake[0] + 18, base[0] + 2, EASE.inOut], [T.shake[1], base[0], 'hold'], [L, base[0]]]);
      continue;
    }
    // Shudder harder the higher it is, then shear off and fall, bounce once, and lie there.
    const wob = 0.018 * fl, go = T.fall + (FLOORS - 1 - fl) * 13, hit = go + 30 - fl * 2;
    const gy = base[1] + land[1] - 4, gx = base[0] + land[0];
    const s0 = T.shake[0];
    both(node, 'rotation', [[0, 0, 'hold'], [s0, 0, EASE.inOut], [s0 + 8, wob, EASE.inOut], [s0 + 16, -wob, EASE.inOut], [s0 + 24, wob * 1.4, EASE.inOut], [go, -wob * 0.5, EASE.in], [hit, land[2], EASE.out], [hit + 10, land[2] * 0.85, EASE.inOut], [hit + 18, land[2], 'hold'], [L, land[2]]]);
    both(node, 'x', [[0, base[0], 'hold'], [go, base[0], EASE.in], [hit, gx, EASE.out], [hit + 18, gx + Math.sign(land[0]) * 6, 'hold'], [L, gx + Math.sign(land[0]) * 6]]);
    both(node, 'y', [[0, sy, 'hold'], [go, sy, EASE.slam], [hit, gy, EASE.out], [hit + 8, gy - 10, EASE.in], [hit + 16, gy, 'hold'], [T.fade[0], gy, EASE.in], [T.fade[1], gy + 14, 'hold'], [L, gy + 14]]);
    both(node, 'opacity', fadeTo());
    dust.push({ x: gx, y: gy + 8, at: hit });
  }

  // ---- the crack ---------------------------------------------------------------------------------
  const cA = P([(X[0] + X[1]) * 0.5, Y[1], (FLOORS - 0.2) * STOREY]);
  const cB = P([(X[0] + X[1]) * 0.5, Y[1], 0.15]);
  const crack = ab.node(null, { name: 'crack', x: cA[0], y: cA[1], opacity: 0 });
  const cs = ab.shape(crack);
  const len = cB[1] - cA[1];
  const zig = [[0, 0], [-9, len * 0.14], [8, len * 0.3], [-7, len * 0.47], [10, len * 0.63], [-6, len * 0.8], [4, len * 0.95]];
  ab.path(cs, zig, { closed: false });
  const crackStroke = ab.stroke(cs, BAD, 4, { cap: 1, join: 1 });
  const crackTrim = ab.trim(crackStroke, { end: 0 });
  // A bright core to the crack, so it reads as light coming through.
  const cc = ab.shape(crack);
  ab.path(cc, zig, { closed: false });
  const coreTrim = ab.trim(ab.stroke(cc, '#ffe1d6', 1.4, { cap: 1, join: 1 }), { end: 0 });
  both(crackTrim, 'end', [[0, 0, 'hold'], [T.crack, 0, EASE.out], [T.crack + 16, 1, 'hold'], [L, 1]]);
  both(coreTrim, 'end', [[0, 0, 'hold'], [T.crack + 2, 0, EASE.out], [T.crack + 18, 1, 'hold'], [L, 1]]);
  both(crack, 'opacity', [[0, 0, 'hold'], [T.crack, 0], [T.crack + 1, 1, 'hold'], [T.fall + 6, 1, EASE.out], [T.fall + 24, 0, 'hold'], [L, 0]]);

  // A red flash behind the building when it fails.
  const mid = P([(X[0] + X[1]) / 2, (Y[0] + Y[1]) / 2, FLOORS * STOREY * 0.5]);
  const flash = ab.node(null, { name: 'flash', x: mid[0], y: mid[1], opacity: 0 });
  const fsh = ab.shape(flash);
  ab.ellipse(fsh, { w: 300, h: 300 });
  ab.fill(fsh, BAD, { alpha: 0.3 });
  both(flash, 'opacity', [[0, 0, 'hold'], [T.red, 0, EASE.out], [T.red + 5, 1, EASE.out], [T.red + 50, 0, 'hold'], [L, 0]]);
  both(flash, 'scaleX', [[0, 0.5, 'hold'], [T.red, 0.5, EASE.out], [T.red + 50, 1.5, 'hold'], [L, 1.5]]);
  both(flash, 'scaleY', [[0, 0.5, 'hold'], [T.red, 0.5, EASE.out], [T.red + 50, 1.5, 'hold'], [L, 1.5]]);

  // ---- dust where they land ----------------------------------------------------------------------
  for (const [k, d] of dust.entries()) {
    for (const side of [-1, 0, 1]) {
      const x0 = d.x + side * 34;
      const puff = ab.node(null, { name: `dust-${k}-${side}`, x: x0, y: d.y, opacity: 0 });
      const s = ab.shape(puff);
      ab.ellipse(s, { w: side ? 46 : 64, h: side ? 18 : 24 });
      ab.fill(s, '#c9d2de', { alpha: 0.55 });
      both(puff, 'opacity', [[0, 0, 'hold'], [d.at, 0, EASE.out], [d.at + 5, 1, EASE.out], [d.at + 56, 0, 'hold'], [L, 0]]);
      both(puff, 'x', [[0, x0, 'hold'], [d.at, x0, EASE.out], [d.at + 56, d.x + side * 90, 'hold'], [L, d.x + side * 90]]);
      both(puff, 'y', [[0, d.y, 'hold'], [d.at, d.y, EASE.out], [d.at + 56, d.y - (side ? 10 : 22), 'hold'], [L, d.y - (side ? 10 : 22)]]);
      both(puff, 'scaleX', [[0, 0.4, 'hold'], [d.at, 0.4, EASE.out], [d.at + 56, 1.7, 'hold'], [L, 1.7]]);
      both(puff, 'scaleY', [[0, 0.4, 'hold'], [d.at, 0.4, EASE.out], [d.at + 56, 1.4, 'hold'], [L, 1.4]]);
    }
  }

  // ---- the outline on the empty land --------------------------------------------------------------
  const ring = [P([X[0], Y[0]]), P([X[1], Y[0]]), P([X[1], Y[1]]), P([X[0], Y[1]])];
  const outlineNode = ab.node(null, { name: 'outline', opacity: 0 });
  const os = ab.shape(outlineNode);
  ab.path(os, ring);
  const ofill = ab.fill(os, BAD, { alpha: 0.1 });
  const ostroke = ab.stroke(os, BAD, 3, { cap: 1, join: 1 });
  const otrim = ab.trim(ostroke, { end: 0 });
  // Corner marks, like survey pins.
  const pins = ring.map((p, k) => {
    const s = ab.shape(outlineNode, { x: p[0], y: p[1] });
    ab.ellipse(s, { w: 11, h: 11 });
    return { fill: ab.fill(s, BAD), k };
  });
  both(outlineNode, 'opacity', [[0, 0, 'hold'], [T.outline[0], 0, EASE.out], [T.outline[0] + 4, 1, 'hold'], [L, 1]],
    [[0, 1, EASE.inOut], [150, 0.55, EASE.inOut], [300, 1]]);
  both(otrim, 'end', [[0, 0, 'hold'], [T.outline[0], 0, EASE.inOut], [T.outline[1], 1, 'hold'], [L, 1]]);
  const amberSoft = `${COLORS.amber}1f`;
  both(ostroke, 'colorValue', [[0, BAD, 'hold'], [T.amber[0], BAD, EASE.inOut], [T.amber[1], COLORS.amber, 'hold'], [L, COLORS.amber]]);
  both(ofill, 'colorValue', [[0, `${BAD}1a`, 'hold'], [T.amber[0], `${BAD}1a`, EASE.inOut], [T.amber[1], amberSoft, 'hold'], [L, amberSoft]]);
  for (const p of pins) {
    both(p.fill, 'colorValue', [[0, BAD, 'hold'], [T.amber[0], BAD, EASE.inOut], [T.amber[1], COLORS.amber, 'hold'], [L, COLORS.amber]]);
  }

  // ---- the badge ---------------------------------------------------------------------------------
  const at = P([(X[0] + X[1]) / 2, (Y[0] + Y[1]) / 2, 2.6]);
  const badge = ab.node(null, { name: 'badge', x: at[0], y: at[1], opacity: 0 });
  const halo = ab.shape(badge);
  ab.ellipse(halo, { w: 128, h: 128 });
  const haloFill = ab.fill(halo, BAD, { alpha: 0.16 });
  const disc = ab.shape(badge);
  ab.ellipse(disc, { w: 84, h: 84 });
  const discFill = ab.fill(disc, BAD);
  ab.stroke(disc, '#ffffff', 3, { alpha: 0.9 });
  const bar = ab.shape(badge);
  ab.rect(bar, { x: 0, y: -8, w: 9, h: 34, r: 4.5, originX: 0.5, originY: 0.5 });
  ab.fill(bar, '#1b0e03');
  const dot = ab.shape(badge, { y: 21 });
  ab.ellipse(dot, { w: 11, h: 11 });
  ab.fill(dot, '#1b0e03');
  // A thin stem down to the land, so the badge reads as marking the spot.
  const stem = ab.shape(badge);
  const ground = P([(X[0] + X[1]) / 2, (Y[0] + Y[1]) / 2, 0]);
  ab.path(stem, [[0, 44], [0, ground[1] - at[1]]], { closed: false });
  const stemStroke = ab.stroke(stem, BAD, 2, { alpha: 0.6, cap: 1 });
  both(badge, 'opacity', [[0, 0, 'hold'], [T.badge, 0, EASE.out], [T.badge + 8, 1, 'hold'], [L, 1]]);
  both(badge, 'y', [[0, at[1] + 30, 'hold'], [T.badge, at[1] + 30, EASE.back], [T.badge + 28, at[1], 'hold'], [L, at[1]]],
    [[0, at[1], EASE.inOut], [150, at[1] - 6, EASE.inOut], [300, at[1]]]);
  both(badge, 'scaleX', [[0, 0.4, 'hold'], [T.badge, 0.4, EASE.back], [T.badge + 28, 1, 'hold'], [L, 1]]);
  both(badge, 'scaleY', [[0, 0.4, 'hold'], [T.badge, 0.4, EASE.back], [T.badge + 28, 1, 'hold'], [L, 1]]);
  both(haloFill, 'colorValue', [[0, `${BAD}29`, 'hold']], [[0, `${BAD}29`, EASE.inOut], [150, `${BAD}5c`, EASE.inOut], [300, `${BAD}29`]]);
  both(discFill, 'colorValue', [[0, BAD, 'hold']]);
  both(stemStroke, 'colorValue', [[0, `${BAD}99`, 'hold']]);

  const sm = ab.stateMachine('Failed');
  const layer = sm.layer('Main');
  const sFall = layer.state(fall), sRest = layer.state(rest);
  layer.transition(layer.entry, sFall);
  layer.transition(sFall, sRest, { exitTime: 100, percent: true });
  return f;
}
