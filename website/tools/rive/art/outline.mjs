// outline.riv: how to outline land, as a short loop for the drawing hint. Over an aerial-looking
// patch of ground, a pointer clicks four corners; each edge follows it; clicking the first corner
// again closes the outline and it fills. Then it fades and starts again.
//
// One looping animation, "demo" (autoplays).

import { RivFile, EASE } from '../riv.mjs';
import { COLORS, mix } from '../helpers.mjs';

const W = 320, H = 180;

export default function build() {
  const f = new RivFile();
  const ab = f.artboard({ name: 'Outline', width: W, height: H });

  // Ground: an aerial patchwork with a road and a few roofs.
  const ground = ab.shape(null, { name: 'ground' });
  ab.rect(ground, { w: W, h: H, r: 10 });
  ab.fill(ground, '#25301f');
  const patch = (pts, c, a = 1) => { const s = ab.shape(null); ab.path(s, pts); ab.fill(s, c, { alpha: a }); };
  patch([[0, 0], [130, 0], [110, 70], [0, 88]], '#2f3b26');
  patch([[150, 0], [320, 0], [320, 60], [190, 84]], '#3a3a2a');
  patch([[0, 120], [120, 104], [150, 180], [0, 180]], '#2b3624');
  patch([[210, 120], [320, 96], [320, 180], [230, 180]], '#34402a');
  const road = ab.shape(null, { name: 'road' });
  ab.path(road, [[-10, 98], [60, 92], [140, 90], [200, 86], [260, 76], [330, 64]], { closed: false });
  ab.stroke(road, '#8d8a80', 7, { alpha: 0.85 });
  const roof = (x, y, w, h) => { const s = ab.shape(null); ab.rect(s, { x, y, w, h, r: 1 }); ab.fill(s, '#d9d3c7'); };
  roof(20, 30, 26, 18); roof(270, 22, 22, 16); roof(282, 120, 20, 24); roof(24, 140, 24, 16);

  // The outline, in the order it's drawn.
  const C = [[104, 116], [196, 104], [216, 156], [116, 168]].map(([x, y]) => [x - 20, y - 70]);
  const drawn = ab.node(null, { name: 'drawn' });
  const fillS = ab.shape(drawn, { name: 'area', opacity: 0 });
  ab.path(fillS, C);
  ab.fill(fillS, COLORS.amber, { alpha: 0.26 });
  const edges = C.map((a, i) => {
    const b = C[(i + 1) % C.length];
    const s = ab.shape(drawn, { name: `edge-${i}` });
    ab.path(s, [a, b], { closed: false });
    const st = ab.stroke(s, COLORS.ember, 2.2);
    return ab.trim(st, { end: 0 });
  });
  const dots = C.map(([x, y], i) => {
    const s = ab.shape(drawn, { name: `corner-${i}`, x, y, opacity: 0 });
    ab.ellipse(s, { w: i === 0 ? 11 : 9, h: i === 0 ? 11 : 9 });
    ab.fill(s, '#ffffff');
    ab.stroke(s, COLORS.amber, 2);
    return s;
  });

  // The pointer and its click ripple.
  const ripple = ab.node(null, { name: 'ripple', opacity: 0 });
  const rs = ab.shape(ripple);
  ab.ellipse(rs, { w: 26, h: 26 });
  ab.stroke(rs, '#ffffff', 1.6);
  const cursor = ab.node(null, { name: 'cursor', x: 40, y: 168 });
  const arrow = ab.shape(cursor);
  ab.path(arrow, [[0, 0], [0, 17], [4.5, 13], [8, 20.5], [11, 19], [7.6, 11.8], [13, 11.6]]);
  ab.fill(arrow, '#ffffff');
  ab.stroke(arrow, '#111418', 1.2);

  const L = 420;
  const anim = ab.animation('demo', { duration: L, loop: 1 });
  const start = [40, 168];
  // Pointer path: to each corner, then back to the first to close.
  const stops = [...C, C[0]];
  const moves = [[0, 40], [50, 100], [110, 160], [170, 220], [230, 280]];
  const xs = [[0, start[0], EASE.inOut]], ys = [[0, start[1], EASE.inOut]];
  moves.forEach(([t0, t1], i) => {
    if (t0 > 0) { xs.push([t0, (i ? stops[i - 1] : start)[0], EASE.inOut]); ys.push([t0, (i ? stops[i - 1] : start)[1], EASE.inOut]); }
    xs.push([t1, stops[i][0], 'hold']); ys.push([t1, stops[i][1], 'hold']);
  });
  xs.push([380, C[0][0], EASE.inOut], [415, start[0], 'hold'], [L, start[0]]);
  ys.push([380, C[0][1], EASE.inOut], [415, start[1], 'hold'], [L, start[1]]);
  anim.key(cursor, 'x', xs);
  anim.key(cursor, 'y', ys);

  // Clicks: a ripple where the pointer is, and the corner appears.
  const clicks = [45, 105, 165, 225, 285];
  const rx = [], ry = [], rsc = [], rop = [];
  clicks.forEach((t, i) => {
    const p = stops[i];
    rx.push([t, p[0], 'hold']); ry.push([t, p[1], 'hold']);
    rsc.push([t, 0.3, EASE.out], [t + 22, 1.4, 'hold']);
    rop.push([t, 0.9, EASE.out], [t + 22, 0, 'hold']);
  });
  anim.key(ripple, 'x', [[0, clicks.length ? stops[0][0] : 0, 'hold'], ...rx]);
  anim.key(ripple, 'y', [[0, stops[0][1], 'hold'], ...ry]);
  anim.key(ripple, 'scaleX', [[0, 0.3, 'hold'], ...rsc]);
  anim.key(ripple, 'scaleY', [[0, 0.3, 'hold'], ...rsc]);
  anim.key(ripple, 'opacity', [[0, 0, 'hold'], ...rop]);
  dots.forEach((d, i) => anim.key(d, 'opacity', [[0, 0, 'hold'], [clicks[i], 0, EASE.out], [clicks[i] + 6, 1, 'hold'], [L, 1]]));
  // The first corner swells when the pointer comes back to close the outline.
  anim.key(dots[0], 'scaleX', [[0, 1, 'hold'], [262, 1, EASE.out], [280, 1.5, EASE.inOut], [300, 1, 'hold'], [L, 1]]);
  anim.key(dots[0], 'scaleY', [[0, 1, 'hold'], [262, 1, EASE.out], [280, 1.5, EASE.inOut], [300, 1, 'hold'], [L, 1]]);
  // Each edge follows the pointer from its corner to the next.
  edges.forEach((e, i) => {
    const [t0, t1] = moves[i + 1];
    anim.key(e, 'end', [[0, 0, 'hold'], [t0, 0, EASE.inOut], [t1, 1, 'hold'], [L, 1]]);
  });
  anim.key(fillS, 'opacity', [[0, 0, 'hold'], [288, 0, EASE.out], [320, 1, 'hold'], [L, 1]]);
  anim.key(drawn, 'opacity', [[0, 1, 'hold'], [380, 1, EASE.inOut], [408, 0, 'hold'], [L, 0]]);
  void mix;
  return f;
}
