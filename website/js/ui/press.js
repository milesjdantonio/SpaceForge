// Every button answers a press: it sinks a little (CSS :active) and a ripple spreads from the point
// that was pressed. One listener for the whole page, so buttons drawn later get it too.

const PRESSABLE = 'button, .btn, [role="button"], .type-card, .chip';

export function enablePress(root = document) {
  root.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = e.target.closest(PRESSABLE);
    // Map grips have their own Rive press; disabled buttons don't answer.
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('.mover-grip, .maplibregl-ctrl')) return;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const r = el.getBoundingClientRect();
    const size = Math.hypot(r.width, r.height) * 2;
    const wrap = document.createElement('span');
    wrap.className = 'press';
    wrap.setAttribute('aria-hidden', 'true');
    const dot = document.createElement('span');
    dot.className = 'press-dot';
    Object.assign(dot.style, { width: `${size}px`, height: `${size}px`, left: `${e.clientX - r.left - size / 2}px`, top: `${e.clientY - r.top - size / 2}px` });
    wrap.append(dot);
    el.append(wrap);
    dot.addEventListener('animationend', () => wrap.remove(), { once: true });
    setTimeout(() => wrap.remove(), 1200); // in case the animation never runs (hidden tab)
  }, { passive: true });
}
