// The sky behind the globe: stars in their real colours and brightness spread, a Milky Way band
// with dust lanes, faint nebulae and a slow twinkle. It stays still while the globe turns.

const STAR_COLORS = ['#9bb0ff', '#aabfff', '#cad7ff', '#f8f7ff', '#fff4ea', '#ffd2a1', '#ffcc6f'];
const STAR_WEIGHTS = [0.03, 0.08, 0.15, 0.3, 0.24, 0.13, 0.07];

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickColor(r) {
  let x = r();
  for (let i = 0; i < STAR_COLORS.length; i++) {
    x -= STAR_WEIGHTS[i];
    if (x <= 0) return STAR_COLORS[i];
  }
  return STAR_COLORS[3];
}

function gauss(r) {
  return (r() + r() + r() + r() - 2) / 2;
}

// Paints the still sky into a canvas `scale` times the viewport so it can drift.
function paintSky(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const r = seeded(20261024);
  g.fillStyle = '#03060b';
  g.fillRect(0, 0, w, h);

  // The band runs corner to corner on a gentle curve.
  const bandY = (x) => h * 0.62 - x * 0.42 * (h / w) + Math.sin((x / w) * Math.PI * 1.4) * h * 0.06;

  // Soft glow of the band and a few nebulae.
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 70; i++) {
    const x = r() * w;
    const y = bandY(x) + gauss(r) * h * 0.07;
    const rad = (0.05 + r() * 0.12) * Math.max(w, h);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const tint = r() < 0.75 ? '120,140,190' : r() < 0.5 ? '190,120,150' : '120,170,180';
    grad.addColorStop(0, `rgba(${tint},0.05)`);
    grad.addColorStop(1, `rgba(${tint},0)`);
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (const [cx, cy, tint, size] of [[0.18, 0.22, '150,80,140', 0.22], [0.82, 0.78, '60,110,150', 0.26], [0.7, 0.15, '120,90,160', 0.16]]) {
    const rad = size * Math.max(w, h);
    const grad = g.createRadialGradient(cx * w, cy * h, 0, cx * w, cy * h, rad);
    grad.addColorStop(0, `rgba(${tint},0.07)`);
    grad.addColorStop(1, `rgba(${tint},0)`);
    g.fillStyle = grad;
    g.fillRect(cx * w - rad, cy * h - rad, rad * 2, rad * 2);
  }

  // Dense faint stars inside the band, sparse everywhere else.
  const dot = (x, y, size, color, alpha) => {
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, size, 0, Math.PI * 2);
    g.fill();
  };
  const area = (w * h) / (1280 * 800);
  for (let i = 0; i < 9000 * area; i++) {
    const x = r() * w;
    const y = bandY(x) + gauss(r) * h * 0.06;
    dot(x, y, 0.35 + r() * 0.5, pickColor(r), 0.15 + r() * 0.35);
  }
  for (let i = 0; i < 2600 * area; i++) {
    const m = Math.pow(r(), 3.2); // most stars faint, a few bright
    dot(r() * w, r() * h, 0.35 + m * 1.5, pickColor(r), 0.25 + m * 0.75);
  }

  // Dust lanes darken the band's centre.
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  for (let i = 0; i < 40; i++) {
    const x = r() * w;
    const y = bandY(x) + gauss(r) * h * 0.02;
    const rad = (0.02 + r() * 0.05) * Math.max(w, h);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(3,6,11,0.35)');
    grad.addColorStop(1, 'rgba(3,6,11,0)');
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return c;
}

export function createStarfield(canvas, map) {
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SCALE = 1;
  let sky = null;
  let twinklers = [];
  let dpr = 1;

  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    sky = paintSky(Math.round(canvas.width * SCALE), Math.round(canvas.height * SCALE));
    const r = seeded(77);
    twinklers = Array.from({ length: 70 }, () => ({
      x: r() * sky.width, y: r() * sky.height,
      size: (0.8 + r() * 1.3) * dpr, color: pickColor(r),
      speed: 0.4 + r() * 1.4, phase: r() * Math.PI * 2,
    }));
    draw(performance.now());
  };

  function draw(t) {
    if (!sky) return;
    // The sky is fixed: it doesn't move when the globe does. Only the twinkle changes.
    const dx = 0, dy = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(sky, dx, dy);
    if (!reduced) {
      for (const s of twinklers) {
        const a = 0.45 + 0.55 * Math.sin(t / 1000 * s.speed + s.phase);
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  let raf = 0;
  const visible = () => ['globe', 'flying'].includes(document.body.dataset.mode);
  const loop = (t) => {
    raf = requestAnimationFrame(loop);
    if (visible()) draw(t);
  };
  addEventListener('resize', resize);
  resize();
  if (!reduced) raf = requestAnimationFrame(loop);
  void map;
  return { destroy() { cancelAnimationFrame(raf); removeEventListener('resize', resize); } };
}
