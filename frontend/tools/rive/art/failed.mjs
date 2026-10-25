// failed.riv: shown when a design doesn't come back. In forge.riv's isometric style: the floor plates
// start to rise over the land, wobble, and the top ones slide off and tumble to the ground with a
// puff of dust; a faint outline of the building stays where it should have stood, and a warning
// badge pops up over it. Then it rests: the badge and the outline breathe gently.
//
// State machine "Failed": plays "fall" once, then loops "rest".

import { RivFile, EASE } from '../riv.mjs';
import { COLORS, iso, mix } from '../helpers.mjs';

const W = 800, H = 520;
const N = 8, K = 42;
const B = [2.7, 5.3];          // footprint, both axes (grid units)
const STOREY = 0.62, FLOORS = 4;
const BAD = '#ff8f8f';

export default function build() {
  const f = new RivFile();
  const ab = f.artboard({ name: 'Failed', width: W, height: H });
  const P = iso(W / 2, 105, K);
  const unit = P([0, 0, 0])[1] - P([0, 0, 1])[1];
  const bg = ab.shape(null);
  ab.rect(bg, { w: W, h: H });
  ab.fill(bg, '#141c28');

  const fall = ab.animation('fall', { duration: 230 });
  const rest = ab.animation('rest', { duration: 150, loop: 1 });
  // Every keyed property gets its final value held in "rest" too.
  const both = (target, prop, frames, restFrames) => {
    fall.key(target, prop, frames);
    rest.key(target, prop, restFrames ?? [[0, frames[frames.length - 1][1], 'hold']]);
  };

  // ---- the land: a dim grid --------------------------------------------------------------------
  const tileTop = mix('#202b39', '#ffffff', 0.16), tileDim = mix('#202b39', '#000000', 0.2);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const g = 0.1, s = ab.shape(null);
      ab.path(s, [P([i + g, j + g]), P([i + 1 - g, j + g]), P([i + 1 - g, j + 1 - g]), P([i + g, j + 1 - g])]);
      const fill = ab.fill(s, tileTop);
      ab.stroke(s, COLORS.ink, 0.8, { alpha: 0.1 });
      both(fill, 'colorValue', [[0, tileTop, EASE.inOut], [150, tileTop, EASE.inOut], [200, tileDim]]);
    }
  }

  // ---- the ghost of the building that should have stood there ------------------------------------
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
  both(ghost, 'opacity', [[0, 0, 'hold'], [168, 0, EASE.out], [200, 0.8, 'hold'], [230, 0.8]],
    [[0, 0.8, EASE.inOut], [75, 0.35, EASE.inOut], [150, 0.8]]);

  // ---- floor plates: rise, wobble, and the top ones fall -------------------------------------------
  const plateTop = '#33445a';
  const base = P([b1, b1, 0]);
  const rel = (p) => { const q = P(p); return [q[0] - base[0], q[1] - base[1]]; };
  // Where each plate ends up: [dx, dy, rotation] on screen, relative to where it stood.
  const LAND = [null, [4, 6, 0.04], [-150, 4, -0.42], [170, -8, 0.5]];
  const dust = [];
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

    const rise = 10 + fl * 16;
    const up = base[1] + lift;
    both(node, 'opacity', [[0, 0, 'hold'], [rise, 0, EASE.out], [rise + 10, 1, 'hold'], [230, 1]]);
    both(edge, 'colorValue', [[0, COLORS.amber, 'hold'], [110, COLORS.amber, EASE.out], [150, mix(COLORS.amber, BAD, 0.7), 'hold'], [230, mix(COLORS.amber, BAD, 0.7)]]);
    const land = LAND[fl];
    if (!land) {
      both(node, 'y', [[0, base[1], 'hold'], [rise, base[1], EASE.out], [rise + 28, up, 'hold'], [230, up]]);
      both(node, 'x', [[0, base[0], 'hold']]);
      both(node, 'rotation', [[0, 0, 'hold']]);
      continue;
    }
    // Rise, wobble harder the higher it is, then slide off and drop to the ground.
    const wob = 0.025 * fl, drop = 112 + (FLOORS - fl) * 7, hit = drop + 26;
    const ground = base[1] + land[1];
    both(node, 'y', [[0, base[1], 'hold'], [rise, base[1], EASE.out], [rise + 28, up, 'hold'], [drop, up, EASE.in], [hit, ground, EASE.out], [hit + 8, ground - 6, EASE.in], [hit + 14, ground, 'hold'], [230, ground]]);
    both(node, 'x', [[0, base[0], 'hold'], [drop - 6, base[0], EASE.in], [hit, base[0] + land[0], 'hold'], [230, base[0] + land[0]]]);
    both(node, 'rotation', [[0, 0, 'hold'], [78, 0, EASE.inOut], [86, wob, EASE.inOut], [94, -wob, EASE.inOut], [102, wob * 1.4, EASE.inOut], [drop, 0, EASE.in], [hit, land[2], 'hold'], [230, land[2]]]);
    dust.push({ x: base[0] + land[0], y: ground, at: hit });
  }

  // ---- dust where they land -------------------------------------------------------------------
  for (const [k, d] of dust.entries()) {
    for (const side of [-1, 1]) {
      const puff = ab.node(null, { name: `dust-${k}-${side}`, x: d.x + side * 30, y: d.y + 10, opacity: 0 });
      const s = ab.shape(puff);
      ab.ellipse(s, { w: 34, h: 14 });
      ab.fill(s, '#c9d2de', { alpha: 0.5 });
      both(puff, 'opacity', [[0, 0, 'hold'], [d.at, 0, EASE.out], [d.at + 6, 0.9, EASE.out], [d.at + 50, 0, 'hold'], [230, 0]]);
      both(puff, 'x', [[0, d.x + side * 30, 'hold'], [d.at, d.x + side * 30, EASE.out], [d.at + 50, d.x + side * 70, 'hold'], [230, d.x + side * 70]]);
      both(puff, 'scaleX', [[0, 0.4, 'hold'], [d.at, 0.4, EASE.out], [d.at + 50, 1.6, 'hold'], [230, 1.6]]);
      both(puff, 'scaleY', [[0, 0.4, 'hold'], [d.at, 0.4, EASE.out], [d.at + 50, 1.3, 'hold'], [230, 1.3]]);
    }
  }

  // ---- the badge ---------------------------------------------------------------------------------
  const at = P([(b0 + b1) / 2, (b0 + b1) / 2, top + 1.3]);
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
  both(badge, 'opacity', [[0, 0, 'hold'], [176, 0, EASE.out], [184, 1, 'hold'], [230, 1]]);
  both(badge, 'scaleX', [[0, 0.3, 'hold'], [176, 0.3, EASE.back], [200, 1, 'hold'], [230, 1]],
    [[0, 1, EASE.inOut], [75, 1.06, EASE.inOut], [150, 1]]);
  both(badge, 'scaleY', [[0, 0.3, 'hold'], [176, 0.3, EASE.back], [200, 1, 'hold'], [230, 1]],
    [[0, 1, EASE.inOut], [75, 1.06, EASE.inOut], [150, 1]]);
  both(haloFill, 'colorValue', [[0, `${BAD}29`, 'hold']], [[0, `${BAD}29`, EASE.inOut], [75, `${BAD}55`, EASE.inOut], [150, `${BAD}29`]]);
  both(badge, 'y', [[0, at[1], 'hold']], [[0, at[1], EASE.inOut], [75, at[1] - 4, EASE.inOut], [150, at[1]]]);

  const sm = ab.stateMachine('Failed');
  const layer = sm.layer('Main');
  const sFall = layer.state(fall), sRest = layer.state(rest);
  layer.transition(layer.entry, sFall);
  layer.transition(sFall, sRest, { exitTime: 100, percent: true });
  return f;
}
