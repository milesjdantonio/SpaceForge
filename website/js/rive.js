// Mounts a Rive file into an element with a canvas sized to it. If Rive or the file fails to load,
// the element keeps its fallback content and nothing else breaks.

const R = window.rive;
if (R) {
  R.RuntimeLoader.setWasmUrl(new URL('../vendor/rive/rive.wasm', import.meta.url).href);
  R.Rive.suppressDeprecationWarnings = ['default-state-machine', 'state-machine-inputs', 'state-machines-param'];
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountRive(el, { src, stateMachine, artboard, hoverInput, hoverTarget, onLoad, fit = 'contain' } = {}) {
  if (!R) return null;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const handle = { inputs: {}, ready: false, rive: null, set, fire, destroy };
  let instance;
  try {
    instance = new R.Rive({
      src: new URL(`../${src}`, import.meta.url).href,
      canvas,
      artboard,
      stateMachines: stateMachine,
      autoplay: true,
      layout: new R.Layout({ fit: fit === 'cover' ? R.Fit.Cover : R.Fit.Contain, alignment: R.Alignment.Center }),
      onLoad: () => {
        el.classList.add('has-rive');
        el.prepend(canvas);
        instance.resizeDrawingSurfaceToCanvas();
        for (const i of instance.stateMachineInputs(stateMachine) || []) handle.inputs[i.name] = i;
        handle.ready = true;
        if (reduced()) instance.pause();
        onLoad?.(handle);
      },
      onLoadError: () => el.classList.add('rive-failed'),
    });
  } catch {
    el.classList.add('rive-failed');
    return null;
  }
  handle.rive = instance;
  function set(name, value) {
    const i = handle.inputs[name];
    if (i) i.value = value;
    if (reduced() && instance) { instance.play(); setTimeout(() => instance.pause(), 1600); }
  }
  function fire(name) {
    handle.inputs[name]?.fire();
    if (reduced() && instance) { instance.play(); setTimeout(() => instance.pause(), 1600); }
  }
  const ro = new ResizeObserver(() => { try { instance.resizeDrawingSurfaceToCanvas(); } catch {} });
  ro.observe(el);
  if (hoverInput && hoverTarget) {
    hoverTarget.addEventListener('pointerenter', () => set(hoverInput, true));
    hoverTarget.addEventListener('pointerleave', () => set(hoverInput, false));
    hoverTarget.addEventListener('focus', () => set(hoverInput, true));
    hoverTarget.addEventListener('blur', () => set(hoverInput, false));
  }
  function destroy() {
    ro.disconnect();
    try { instance.cleanup(); } catch {}
    canvas.remove();
  }
  return handle;
}
