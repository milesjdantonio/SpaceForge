// failed.riv: shown when a design doesn't come back. In forge.riv's isometric style, it tells what
// happened, slowly enough to follow:
//   1. a survey line crosses the land (the service started),
//   2. the floor plates rise one by one (the building was being made),
//   3. a crack flashes red through the stack and it wobbles (something went wrong),
//   4. the top floors slide off and tumble to the ground with a puff of dust,
//   5. the land dims; a faint outline stays where the building should stand; a warning badge pops up,
//   6. a scan line passes over the outline (looking at what went wrong) while the fallen floors
//      slide back and fade,
//   7. a "Try again" button pops in (what to do next).
// Then it rests: the badge and outline breathe, and the button's arrow nudges round now and then.
//
// State machine "Failed": plays "fall" once (about 9 s), then loops "rest". Bool `hover` swells the
// button; trigger `retry` presses it and spins its arrow. The page puts a real button over it at
// BUTTON (artboard units), so it can be clicked and reached by keyboard.

import { RivFile, EASE } from '../riv.mjs';
import { COLORS, iso, mix, textContours } from '../helpers.mjs';

const W = 800, H = 520;
const N = 8, K = 42;
const B = [2.6, 5.4];          // footprint, both axes (grid units)
const STOREY = 0.62, FLOORS = 4;
const BAD = '#ff8f8f';
const L = 560;                 // the "fall" animation, in frames (60 a second)
// Where the Try again button is drawn, in artboard units: centre and size. (js/panels/send.js
// places the real button there.)
export const BUTTON = { x: 640, y: 300, w: 210, h: 64 };

export default function build() {
  const f = new RivFile();
  const ab = f.artboard({ name: 'Failed', width: W, height: H });
  const P = iso(W / 2 - 40, 105, K);
  const unit = P([0, 0, 0])[1] - P([0, 0, 1])[1];
  const bg = ab.shape(null);
  ab.rect(bg, { w: W, h: H });
  ab.fill(bg, '#141c28');

  const fall = ab.animation('fall', { duration: L });
  const rest = ab.animation('rest', { duration: 240, loop: 1 });
  // Every keyed property gets its final value held in "rest" too, unless rest has its own frames.
  const both = (target, prop, frames, restFrames) => {
    fall.key(target, prop, frames);
    rest.key(target, prop, restFrames ?? [[0, frames[frames.length - 1][1], 'hold']]);
  };

  // ---- 1. the land, and a survey line crossing it ----------------------------------------------
  const tileTop = mix('#202b39', '#ffffff', 0.16), tileDim = mix('#202b39', '#000000', 0.2);
  const SWEEP = [6, 70];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const g = 0.1, s = ab.shape(null);
      ab.path(s, [P([i + g, j + g]), P([i + 1 - g, j + g]), P([i + 1 - g, j + 1 - g]), P([i + g, j + 1 - g])]);
      const fill = ab.fill(s, tileTop);
      ab.stroke(s, COLORS.ink, 0.8, { alpha: 0.1 });
      const t = SWEEP[0] + ((j + 0.5) / N) * (SWEEP[1] - SWEEP[0]);
      const warm = mix(tileTop, COLORS.amber, 0.3);
      both(fill, 'colorValue', [[0, tileTop, 'hold'], [t - 4, tileTop, EASE.out], [t, warm, EASE.inOut], [t + 26, tileTop, 'hold'],
        [300, tileTop, EASE.inOut], [350, tileDim, 'hold'], [L, tileDim]]);
    }
  }
  const scan = ab.node(null, { name: 'scan', opacity: 0 });
  const line = ab.shape(scan);
  ab.path(line, [P([-0.4, 0]), P([N + 0.4, 0])], { closed: false });
  ab.stroke(line, COLORS.ember, 2, { alpha: 0.95 });
  const dy = P([0, 1])[1] - P([0, 0])[1], dx = P([0, 1])[0] - P([0, 0])[0];
  both(scan, 'x', [[0, 0, 'hold'], [SWEEP[0], 0, EASE.linear], [SWEEP[1], dx * N, 'hold'], [L, dx * N]]);
  both(scan, 'y', [[0, 0, 'hold'], [SWEEP[0], 0, EASE.linear], [SWEEP[1], dy * N, 'hold'], [L, dy * N]]);
  both(scan, 'opacity', [[0, 0, 'hold'], [SWEEP[0], 0], [SWEEP[0] + 8, 1, 'hold'], [SWEEP[1] - 8, 1], [SWEEP[1], 0, 'hold'], [L, 0]]);

  // ---- 5a. the outline of the building that should have stood there --------------------------------
  const [b0, b1] = B, top = FLOORS * STOREY;
  const ghost = ab.node(null, { name: 'ghost', opacity: 0 });
  const edges = [
    [[b0, b0, 0], [b1, b0, 0]], [[b1, b0, 0], [b1, b1, 0]], [[b1, b1, 0], [b0, b1, 0]], [[b0, b1, 0], [b0, b0, 0]],
    [[b0, b0, top], [b1, b0, top]], [[b1, b0, top], [b1, b1, top]], [[b1, b1, top], [b0, b1, top]], [[b0, b1, top], [b0, b0, top]],
    [[b1, b0, 0], [b1, b0, top]], [[b1, b1, 0], [b1, b1, top]], [[b0, b1, 0], [b0, b1, top]],
  ];
  for (const [a, b] of edges) {
    const s = ab.shape(ghost);
    ab.path(s, [P(a), P(b)], { closed: false });
    ab.stroke(s, COLORS.ember, 1.6, { alpha: 0.5 });
  }
  both(ghost, 'opacity', [[0, 0, 'hold'], [318, 0, EASE.out], [360, 0.8, 'hold'], [L, 0.8]],
    [[0, 0.8, EASE.inOut], [120, 0.35, EASE.inOut], [240, 0.8]]);

  // ---- 2-4. floor plates: rise, crack and wobble, fall -------------------------------------------
  const plateTop = '#33445a';
  const base = P([b1, b1, 0]);
  const rel = (p) => { const q = P(p); return [q[0] - base[0], q[1] - base[1]]; };
  // Where each plate ends up: [dx, dy, rotation] on screen, relative to where it stood.
  const LAND = [null, [6, 6, 0.05], [-160, 6, -0.42], [180, -6, 0.5]];
  const dust = [];
  const RISE0 = 80, GAP = 30, RISE = 40;
  const WOBBLE = [214, 262];
  const SEARCH = [388, 448];     // the scan line passes over the outline
  const TIDY = [430, 476];       // the fallen floors slide back and fade
  const BUTTON_IN = 486;         // the Try again button pops in
  for (let fl = 0; fl < FLOORS; fl++) {
    const z = fl * STOREY, lift = -z * unit;
    const node = ab.node(null, { name: `plate-${fl}`, x: base[0], y: base[1], opacity: 0 });
    const t = 0.12;
    const sideL = ab.shape(node);
    ab.path(sideL, [rel([b0, b1, -t]), rel([b1, b1, -t]), rel([b1, b1, 0]), rel([b0, b1, 0])]);
    ab.fill(sideL, mix(plateTop, '#000000', 0.25));
    const sideR = ab.shape(node);
    ab.path(sideR, [rel([b1, b0, -t]), rel([b1, b1, -t]), rel([b1, b1, 0]), rel([b1, b0, 0])]);
    ab.fill(sideR, mix(plateTop, '#000000', 0.12));
    const face = ab.shape(node);
    ab.path(face, [rel([b0, b0, 0]), rel([b1, b0, 0]), rel([b1, b1, 0]), rel([b0, b1, 0])]);
    ab.fill(face, plateTop, { alpha: 0.95 });
    const edge = ab.stroke(face, COLORS.amber, 1.6, { alpha: 0.95 });

    const rise = RISE0 + fl * GAP;
    const up = base[1] + lift;
    // The edges flash red when it cracks, and stay a dull red after.
    const red = mix(COLORS.amber, BAD, 0.75);
    both(edge, 'colorValue', [[0, COLORS.amber, 'hold'], [WOBBLE[0], COLORS.amber, EASE.out], [WOBBLE[0] + 6, BAD, EASE.inOut], [WOBBLE[0] + 26, red, 'hold'], [L, red]]);
    const land = LAND[fl];
    if (!land) {
      both(node, 'opacity', [[0, 0, 'hold'], [rise, 0, EASE.out], [rise + 12, 1, 'hold'], [TIDY[0], 1, EASE.inOut], [TIDY[1], 0.55, 'hold'], [L, 0.55]]);
      both(node, 'y', [[0, base[1], 'hold'], [rise, base[1], EASE.out], [rise + RISE, up, 'hold'], [L, up]]);
      both(node, 'x', [[0, base[0], 'hold']]);
      both(node, 'rotation', [[0, 0, 'hold']]);
      continue;
    }
    // Wobble harder the higher it is, then slide off and drop to the ground; once the scan has
    // looked, the fallen floors slide back toward the footprint and fade (cleared away for a retry).
    const wob = 0.022 * fl, drop = WOBBLE[1] + (FLOORS - fl) * 12, hit = drop + 32;
    const ground = base[1] + land[1];
    const back = [base[0] + land[0] * 0.3, ground];
    both(node, 'opacity', [[0, 0, 'hold'], [rise, 0, EASE.out], [rise + 12, 1, 'hold'], [TIDY[0], 1, EASE.inOut], [TIDY[1], 0.18, 'hold'], [L, 0.18]]);
    both(node, 'y', [[0, base[1], 'hold'], [rise, base[1], EASE.out], [rise + RISE, up, 'hold'], [drop, up, EASE.in], [hit, ground, EASE.out], [hit + 9, ground - 7, EASE.in], [hit + 16, ground, 'hold'], [TIDY[0], ground, EASE.inOut], [TIDY[1], back[1], 'hold'], [L, back[1]]]);
    both(node, 'x', [[0, base[0], 'hold'], [drop - 8, base[0], EASE.in], [hit, base[0] + land[0], 'hold'], [TIDY[0], base[0] + land[0], EASE.inOut], [TIDY[1], back[0], 'hold'], [L, back[0]]]);
    const w = WOBBLE[0];
    both(node, 'rotation', [[0, 0, 'hold'], [w, 0, EASE.inOut], [w + 10, wob, EASE.inOut], [w + 20, -wob, EASE.inOut], [w + 30, wob * 1.3, EASE.inOut], [w + 40, -wob * 1.4, EASE.inOut], [drop, 0, EASE.in], [hit, land[2], 'hold'], [TIDY[0], land[2], EASE.inOut], [TIDY[1], land[2] * 0.3, 'hold'], [L, land[2] * 0.3]]);
    dust.push({ x: base[0] + land[0], y: ground, at: hit });
  }

  // ---- 3. the crack: a jagged red line down the stack's face, with a flash -----------------------
  const crackAt = P([b1, (b0 + b1) / 2, 0]);
  const crack = ab.node(null, { name: 'crack', x: crackAt[0], y: crackAt[1], opacity: 0 });
  const cs = ab.shape(crack);
  const hgt = (FLOORS - 1) * STOREY * unit;
  ab.path(cs, [[0, -hgt - 6], [-7, -hgt * 0.78], [5, -hgt * 0.6], [-6, -hgt * 0.42], [4, -hgt * 0.25], [-3, -hgt * 0.1]], { closed: false });
  const crackStroke = ab.stroke(cs, BAD, 3.2, { cap: 1, join: 1 });
  const crackTrim = ab.trim(crackStroke, { end: 0 });
  const flash = ab.node(null, { name: 'flash', x: crackAt[0], y: crackAt[1] - hgt * 0.5, opacity: 0 });
  const fs = ab.shape(flash);
  ab.ellipse(fs, { w: 120, h: 120 });
  ab.fill(fs, BAD, { alpha: 0.3 });
  both(crackTrim, 'end', [[0, 0, 'hold'], [WOBBLE[0], 0, EASE.out], [WOBBLE[0] + 14, 1, 'hold'], [L, 1]]);
  both(crack, 'opacity', [[0, 0, 'hold'], [WOBBLE[0], 0], [WOBBLE[0] + 2, 1, 'hold'], [WOBBLE[1] + 12, 1, EASE.out], [WOBBLE[1] + 30, 0, 'hold'], [L, 0]]);
  both(flash, 'opacity', [[0, 0, 'hold'], [WOBBLE[0], 0, EASE.out], [WOBBLE[0] + 4, 1, EASE.out], [WOBBLE[0] + 40, 0, 'hold'], [L, 0]]);
  both(flash, 'scaleX', [[0, 0.4, 'hold'], [WOBBLE[0], 0.4, EASE.out], [WOBBLE[0] + 40, 1.4, 'hold'], [L, 1.4]]);
  both(flash, 'scaleY', [[0, 0.4, 'hold'], [WOBBLE[0], 0.4, EASE.out], [WOBBLE[0] + 40, 1.4, 'hold'], [L, 1.4]]);

  // ---- 4b. dust where they land --------------------------------------------------------------
  for (const [k, d] of dust.entries()) {
    for (const side of [-1, 1]) {
      const puff = ab.node(null, { name: `dust-${k}-${side}`, x: d.x + side * 30, y: d.y + 10, opacity: 0 });
      const s = ab.shape(puff);
      ab.ellipse(s, { w: 34, h: 14 });
      ab.fill(s, '#c9d2de', { alpha: 0.5 });
      both(puff, 'opacity', [[0, 0, 'hold'], [d.at, 0, EASE.out], [d.at + 6, 0.9, EASE.out], [d.at + 60, 0, 'hold'], [L, 0]]);
      both(puff, 'x', [[0, d.x + side * 30, 'hold'], [d.at, d.x + side * 30, EASE.out], [d.at + 60, d.x + side * 74, 'hold'], [L, d.x + side * 74]]);
      both(puff, 'scaleX', [[0, 0.4, 'hold'], [d.at, 0.4, EASE.out], [d.at + 60, 1.6, 'hold'], [L, 1.6]]);
      both(puff, 'scaleY', [[0, 0.4, 'hold'], [d.at, 0.4, EASE.out], [d.at + 60, 1.3, 'hold'], [L, 1.3]]);
    }
  }

  // ---- 5b. the badge ---------------------------------------------------------------------------
  const at = P([(b0 + b1) / 2, (b0 + b1) / 2, top + 1.3]);
  const BADGE = 340;
  const badge = ab.node(null, { name: 'badge', x: at[0], y: at[1], opacity: 0 });
  const halo = ab.shape(badge);
  ab.ellipse(halo, { w: 92, h: 92 });
  const haloFill = ab.fill(halo, BAD, { alpha: 0.16 });
  const disc = ab.shape(badge);
  ab.ellipse(disc, { w: 62, h: 62 });
  ab.fill(disc, BAD);
  ab.stroke(disc, '#ffffff', 2.4, { alpha: 0.9 });
  const bar = ab.shape(badge);
  ab.rect(bar, { x: 0, y: -6, w: 7, h: 26, r: 3.5, originX: 0.5, originY: 0.5 });
  ab.fill(bar, '#1b0e03');
  const dot = ab.shape(badge, { y: 16 });
  ab.ellipse(dot, { w: 8, h: 8 });
  ab.fill(dot, '#1b0e03');
  both(badge, 'opacity', [[0, 0, 'hold'], [BADGE, 0, EASE.out], [BADGE + 8, 1, 'hold'], [L, 1]]);
  both(badge, 'scaleX', [[0, 0.3, 'hold'], [BADGE, 0.3, EASE.back], [BADGE + 26, 1, 'hold'], [L, 1]],
    [[0, 1, EASE.inOut], [120, 1.06, EASE.inOut], [240, 1]]);
  both(badge, 'scaleY', [[0, 0.3, 'hold'], [BADGE, 0.3, EASE.back], [BADGE + 26, 1, 'hold'], [L, 1]],
    [[0, 1, EASE.inOut], [120, 1.06, EASE.inOut], [240, 1]]);
  both(haloFill, 'colorValue', [[0, `${BAD}29`, 'hold']], [[0, `${BAD}29`, EASE.inOut], [120, `${BAD}55`, EASE.inOut], [240, `${BAD}29`]]);

  // ---- 6. a second look: a scan line passes down over the outline ------------------------------
  const gp = edges.flat().map(P);
  const gx0 = Math.min(...gp.map((p) => p[0])), gx1 = Math.max(...gp.map((p) => p[0]));
  const gy0 = Math.min(...gp.map((p) => p[1])), gy1 = Math.max(...gp.map((p) => p[1]));
  const search = ab.node(null, { name: 'search', x: (gx0 + gx1) / 2, y: gy0, opacity: 0 });
  const sg = ab.shape(search);
  ab.rect(sg, { w: gx1 - gx0 + 40, h: 22, r: 11, originX: 0.5, originY: 0.5 });
  ab.fill(sg, COLORS.amber, { alpha: 0.14 });
  const sl = ab.shape(search);
  ab.path(sl, [[-(gx1 - gx0) / 2 - 20, 0], [(gx1 - gx0) / 2 + 20, 0]], { closed: false });
  ab.stroke(sl, COLORS.ember, 2.2, { cap: 1 });
  both(search, 'y', [[0, gy0, 'hold'], [SEARCH[0], gy0, EASE.inOut], [SEARCH[1], gy1, 'hold'], [L, gy1]]);
  both(search, 'opacity', [[0, 0, 'hold'], [SEARCH[0], 0, EASE.out], [SEARCH[0] + 8, 1, 'hold'], [SEARCH[1] - 10, 1, EASE.in], [SEARCH[1], 0, 'hold'], [L, 0]]);

  // ---- 7. the Try again button ---------------------------------------------------------------
  const { x: bx, y: by, w: bw, h: bh } = BUTTON;
  const button = ab.node(null, { name: 'button', x: bx, y: by + 16, opacity: 0 });
  const face = ab.node(button, { name: 'face' });
  const glow = ab.shape(face);
  ab.rect(glow, { w: bw + 26, h: bh + 26, r: (bh + 26) / 2, originX: 0.5, originY: 0.5 });
  const glowFill = ab.fill(glow, COLORS.amber, { alpha: 0.18 });
  const pill = ab.shape(face);
  ab.rect(pill, { w: bw, h: bh, r: bh / 2, originX: 0.5, originY: 0.5 });
  const pillFill = ab.fill(pill, COLORS.amber);
  ab.stroke(pill, '#ffffff', 2, { alpha: 0.55 });
  // The arrow: a nudge (in "rest") and a spin when pressed, on separate nodes so they don't clash.
  const R = 13;
  const arrow = ab.node(face, { name: 'arrow', x: -bw / 2 + 36 });
  const spin = ab.node(arrow, { name: 'spin' });
  const arcPts = [];
  for (let a = 40; a <= 330; a += 10) arcPts.push([Math.cos((a * Math.PI) / 180) * R, Math.sin((a * Math.PI) / 180) * R]);
  const arc = ab.shape(spin);
  ab.path(arc, arcPts, { closed: false });
  ab.stroke(arc, '#1b0e03', 3.6, { cap: 1 });
  const end = (330 * Math.PI) / 180;
  const head = ab.shape(spin);
  ab.path(head, [[Math.cos(end + 0.5) * R, Math.sin(end + 0.5) * R], [Math.cos(end) * (R + 6.5), Math.sin(end) * (R + 6.5)], [Math.cos(end) * (R - 6.5), Math.sin(end) * (R - 6.5)]]);
  ab.fill(head, '#1b0e03');
  const label = ab.shape(face, { name: 'label' });
  for (const c of textContours('Try again', { size: 24, cx: 18, baseline: 8.5, tracking: 0.02 })) ab.path(label, c);
  ab.fill(label, '#1b0e03');
  both(button, 'opacity', [[0, 0, 'hold'], [BUTTON_IN, 0, EASE.out], [BUTTON_IN + 14, 1, 'hold'], [L, 1]]);
  both(button, 'y', [[0, by + 16, 'hold'], [BUTTON_IN, by + 16, EASE.back], [BUTTON_IN + 26, by, 'hold'], [L, by]]);
  both(arrow, 'rotation', [[0, -1.2, 'hold'], [BUTTON_IN + 10, -1.2, EASE.inOut], [L - 4, Math.PI * 2 - 1.2, 'hold'], [L, Math.PI * 2 - 1.2]],
    [[0, -1.2, 'hold'], [170, -1.2, EASE.inOut], [232, Math.PI * 2 - 1.2, 'hold'], [240, Math.PI * 2 - 1.2]]);

  // The button's own states, on their own layer: idle (a soft glow pulse), hover, pressed.
  const idle = ab.animation('button-idle', { duration: 150, loop: 1 });
  idle.key(face, 'scaleX', [[0, 1, 'hold']]); idle.key(face, 'scaleY', [[0, 1, 'hold']]);
  idle.key(glowFill, 'colorValue', [[0, `${COLORS.amber}1f`, EASE.inOut], [75, `${COLORS.amber}55`, EASE.inOut], [150, `${COLORS.amber}1f`]]);
  idle.key(pillFill, 'colorValue', [[0, COLORS.amber, 'hold']]);
  idle.key(spin, 'rotation', [[0, 0, 'hold']]);
  const hover = ab.animation('button-hover', { duration: 12 });
  hover.key(face, 'scaleX', [[0, 1.07, 'hold']]); hover.key(face, 'scaleY', [[0, 1.07, 'hold']]);
  hover.key(glowFill, 'colorValue', [[0, `${COLORS.amber}66`, 'hold']]);
  hover.key(pillFill, 'colorValue', [[0, '#ff9d4c', 'hold']]);
  hover.key(spin, 'rotation', [[0, 0, 'hold']]);
  const press = ab.animation('button-press', { duration: 48 });
  press.key(face, 'scaleX', [[0, 1, EASE.out], [6, 0.9, EASE.back], [30, 1.04, EASE.inOut], [48, 1]]);
  press.key(face, 'scaleY', [[0, 1, EASE.out], [6, 0.9, EASE.back], [30, 1.04, EASE.inOut], [48, 1]]);
  press.key(glowFill, 'colorValue', [[0, `${COLORS.amber}99`, EASE.out], [48, `${COLORS.amber}33`]]);
  press.key(pillFill, 'colorValue', [[0, COLORS.ember, EASE.out], [48, COLORS.amber]]);
  press.key(spin, 'rotation', [[0, 0, EASE.inOut], [44, Math.PI * 4, 'hold'], [48, Math.PI * 4]]);

  const sm = ab.stateMachine('Failed');
  const isHover = sm.bool('hover', false);
  const retry = sm.trigger('retry');
  const layer = sm.layer('Main');
  const sFall = layer.state(fall), sRest = layer.state(rest);
  layer.transition(layer.entry, sFall);
  layer.transition(sFall, sRest, { exitTime: 100, percent: true });
  const bl = sm.layer('Button');
  const sIdle = bl.state(idle), sHover = bl.state(hover), sPress = bl.state(press);
  bl.transition(bl.entry, sIdle);
  bl.transition(sIdle, sHover, { conditions: [{ input: isHover, value: true }], duration: 120 });
  bl.transition(sHover, sIdle, { conditions: [{ input: isHover, value: false }], duration: 160 });
  bl.transition(sIdle, sPress, { conditions: [{ input: retry }] });
  bl.transition(sHover, sPress, { conditions: [{ input: retry }] });
  bl.transition(sPress, sHover, { exitTime: 100, percent: true, conditions: [{ input: isHover, value: true }] });
  bl.transition(sPress, sIdle, { exitTime: 100, percent: true, conditions: [{ input: isHover, value: false }] });
  return f;
}
