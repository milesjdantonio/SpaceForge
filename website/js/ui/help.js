// "How To": the question-mark button in the top bar opens a short guide, one step at a time, each
// with a looping Rive scene of the step being done and a line of text under it.

import { icon } from './icons.js';
import { mountRive } from '../rive.js';

const touch = () => matchMedia('(pointer: coarse)').matches;

// Each step's scene: guide.riv's artboards, plus the outline demo and the generation animation.
function steps() {
  const tap = touch() ? 'Tap' : 'Click';
  return [
    { title: 'Find Your Land', text: `Search for a place, or ${tap.toLowerCase()} anywhere on the globe to fly there.`, rive: { src: 'assets/rive/guide.riv', artboard: 'Find' } },
    { title: 'Outline It', text: `${tap} each corner of the land, then ${tap.toLowerCase()} the first corner again to close it.`, rive: { src: 'assets/rive/outline.riv', fit: 'cover' } },
    { title: 'Describe the Building', text: 'Pick a type and describe it. The bar shows whether it suits the land before you send it.', rive: { src: 'assets/rive/guide.riv', artboard: 'Describe' } },
    { title: 'Send It', text: 'The design service draws a building for your land. This may take a while.', rive: { src: 'assets/rive/forge.riv', stateMachine: 'Forge', inputs: { state: 1 } } },
    { title: 'Move or Turn It', text: `${tap} the building, choose Move, then drag the top grip to move it or the ring grip to turn it.`, rive: { src: 'assets/rive/guide.riv', artboard: 'Move' } },
    { title: 'Look Inside', text: `${tap} it again for plans and costs, then Walk through to explore the rooms.`, rive: { src: 'assets/rive/guide.riv', artboard: 'Inside' } },
    { title: 'Save and Share', text: 'Sign in to keep it in My Builds. Then choose Share to send it to a builder or landowner; your links stay under Share.', rive: { src: 'assets/rive/guide.riv', artboard: 'Save' } },
  ];
}

function mapControls() {
  if (touch()) return 'Map: drag to pan, pinch to zoom, twist or drag two fingers to turn and tilt.';
  return 'Map: drag to move it, scroll to zoom, hold Ctrl and drag to turn and tilt the view.';
}

export function mountHelp(button, dialog) {
  button.innerHTML = `${icon('help')}<span class="sr-only">How to Use TerraSim</span>`;
  button.title = 'How to Use TerraSim';
  let at = 0, scene = null, list = [];

  function show(i) {
    at = Math.max(0, Math.min(list.length - 1, i));
    const step = list[at];
    scene?.destroy();
    const stage = dialog.querySelector('[data-stage]');
    stage.replaceChildren();
    stage.setAttribute('aria-label', `${step.title}, shown as an animation`);
    const { inputs, ...opts } = step.rive;
    scene = mountRive(stage, { ...opts, onLoad: (h) => { for (const [k, v] of Object.entries(inputs ?? {})) h.set(k, v); } });
    dialog.querySelector('[data-step-count]').textContent = `Step ${at + 1} of ${list.length}`;
    dialog.querySelector('[data-step-title]').textContent = step.title;
    dialog.querySelector('[data-step-text]').textContent = step.text;
    dialog.querySelectorAll('[data-dot]').forEach((d, k) => d.setAttribute('aria-current', String(k === at)));
    dialog.querySelector('[data-back]').disabled = at === 0;
    const next = dialog.querySelector('[data-next]');
    next.textContent = at === list.length - 1 ? 'Done' : 'Next';
  }

  function open() {
    list = steps();
    dialog.innerHTML = `
      <div class="dialog-body help-body">
        <header class="help-head">
          <h2 class="dialog-title" id="help-title">How to Use TerraSim</h2>
          <button type="button" class="btn btn-quiet btn-icon" data-close aria-label="Close">${icon('close')}</button>
        </header>
        <div class="help-stage" data-stage role="img"></div>
        <div class="help-caption" aria-live="polite">
          <p class="help-count" data-step-count></p>
          <h3 class="help-step-title" data-step-title></h3>
          <p class="help-step-text" data-step-text></p>
        </div>
        <div class="help-nav">
          <div class="help-dots" role="group" aria-label="Steps">
            ${list.map((s, i) => `<button type="button" class="help-dot" data-dot="${i}" aria-label="Step ${i + 1}: ${s.title}"></button>`).join('')}
          </div>
          <button type="button" class="btn btn-small btn-quiet" data-back>Back</button>
          <button type="button" class="btn btn-small btn-primary" data-next>Next</button>
        </div>
        <p class="note">${mapControls()}</p>
      </div>`;
    dialog.setAttribute('aria-labelledby', 'help-title');
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.querySelector('[data-back]').onclick = () => show(at - 1);
    dialog.querySelector('[data-next]').onclick = () => (at === list.length - 1 ? dialog.close() : show(at + 1));
    dialog.querySelectorAll('[data-dot]').forEach((d) => { d.onclick = () => show(Number(d.dataset.dot)); });
    if (!dialog.open) dialog.showModal();
    show(0);
    dialog.querySelector('[data-next]').focus();
  }

  dialog.addEventListener('keydown', (e) => {
    if (!dialog.open) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
  });
  dialog.addEventListener('close', () => { scene?.destroy(); scene = null; dialog.replaceChildren(); });
  // A click on the backdrop closes it too.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  button.addEventListener('click', open);
  return { open };
}
