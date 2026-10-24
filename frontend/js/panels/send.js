// Sending a site to the design service. While it works: the generation animation, a progress bar
// driven by the service's own steps (each Gemma call shown, with its try number), and a terminal
// with the service's log. Without a connected service this ends in a clear "not connected" state.

import { mountRive } from '../rive.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { config } from '../config.js';
import { typeName } from '../lib/housing.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`);

export function renderSending(el, { request, run, onDone, onFailed, onRetry, onEdit, onPreview }) {
  el.innerHTML = `
    <header class="panel-head">
      <div>
        <h2 class="panel-title">Designing for your land</h2>
        <p class="panel-sub">${request.mode === 'build' ? 'As a listing' : 'Privately'} · ${typeName(request.housingType)} · ${request.brief.floors} ${request.brief.floors === 1 ? 'floor' : 'floors'}</p>
      </div>
    </header>
    <div class="forge" data-rive-slot>
      <div class="forge-fallback" aria-hidden="true"></div>
    </div>
    <section class="progress" aria-label="Progress">
      <div class="progress-head">
        <p class="progress-label" data-label aria-live="polite">Preparing the request…</p>
        <p class="progress-figures num"><span data-pct>0%</span><span data-elapsed></span></p>
      </div>
      <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-bar>
        <span class="progress-fill" data-fill></span>
      </div>
      <ol class="steps" data-steps hidden></ol>
    </section>
    <section class="terminal" aria-label="Design service log">
      <div class="terminal-head"><span>Log</span><button type="button" class="terminal-copy" data-copy-log>${icon('copy')}<span>Copy</span></button></div>
      <pre class="terminal-body" data-term tabindex="0"></pre>
    </section>
    <div class="send-result"></div>`;

  const slot = el.querySelector('[data-rive-slot]');
  const term = el.querySelector('[data-term]');
  const result = el.querySelector('.send-result');
  const labelEl = el.querySelector('[data-label]');
  const pctEl = el.querySelector('[data-pct]');
  const elapsedEl = el.querySelector('[data-elapsed]');
  const bar = el.querySelector('[data-bar]');
  const fill = el.querySelector('[data-fill]');
  const stepsEl = el.querySelector('[data-steps]');
  const rive = mountRive(slot, { src: 'assets/rive/forge.riv', stateMachine: 'Forge', onLoad: (h) => h.set('state', 1) });

  // ---- terminal ------------------------------------------------------------------------------
  const lines = [];
  let partial = '';
  const t0 = performance.now();
  const stick = () => term.scrollHeight - term.scrollTop - term.clientHeight < 40;
  function print(text, { t, kind = '' } = {}) {
    const at = t ?? (performance.now() - t0) / 1000;
    lines.push(`[${at.toFixed(1).padStart(5)}s] ${text}`);
    const follow = stick();
    const row = document.createElement('span');
    row.className = `term-line ${kind || classify(text)}`;
    row.textContent = `${`[${at.toFixed(1).padStart(5)}s]`} ${text}\n`;
    term.querySelector('.term-partial')?.remove();
    term.append(row);
    if (partial) appendPartial();
    if (follow) term.scrollTop = term.scrollHeight;
  }
  function appendPartial() {
    term.querySelector('.term-partial')?.remove();
    const p = document.createElement('span');
    p.className = 'term-partial';
    p.textContent = partial.trimStart();
    term.append(p);
  }
  el.querySelector('[data-copy-log]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lines.join('\n')); toast('Log copied.'); } catch { toast('Couldn’t copy. Select the text instead.'); }
  });

  // ---- progress ------------------------------------------------------------------------------
  let shown = 0;
  function setProgress(p, label) {
    shown = Math.max(shown, Math.min(1, p));
    fill.style.transform = `scaleX(${shown})`;
    pctEl.textContent = `${Math.round(shown * 100)}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
    if (label) labelEl.textContent = label;
  }
  function renderSteps(steps) {
    stepsEl.hidden = false;
    stepsEl.innerHTML = steps.map((s) => `
      <li class="step step-${s.status}${s.gemma ? ' step-gemma' : ''}">
        <span class="step-dot" aria-hidden="true"></span>
        <span class="step-label">${esc(s.gemma ? s.label.replace(/^Gemma /, '') : s.label)}${s.attempts && s.attempt > 1 ? ` <span class="step-try">try ${s.attempt} of ${s.attempts}</span>` : ''}</span>
        <span class="step-time num">${s.status === 'pending' ? '' : clock(s.seconds || 0)}</span>
      </li>`).join('');
  }
  let lastElapsed = 0, elapsedAt = performance.now();
  const ticker = setInterval(() => {
    if (!lastElapsed) return;
    elapsedEl.textContent = clock(lastElapsed + (performance.now() - elapsedAt) / 1000);
  }, 500);

  (async () => {
    const corners = request.site.geometry.coordinates[0].length - 1;
    print(`Packing the outline: ${corners} corners, ${Math.round(request.site.properties.areaM2).toLocaleString('en-US')} m².`, { kind: 'term-local' });
    await wait(300);
    print(`Brief: ${typeName(request.housingType).toLowerCase()}, ${request.aiDecides.length ? `${request.aiDecides.length} choices left to the design system` : 'every choice made by you'}.`, { kind: 'term-local' });
    print(`Description: “${request.brief.designPrompt}”`, { kind: 'term-local' });
    print(config.apiBaseUrl ? `Sending to ${config.apiBaseUrl}…` : 'Sending to the design service…', { kind: 'term-local' });
    setProgress(0.01, 'Sending the request…');
    try {
      const res = await run((job) => {
        for (const l of job.log || []) print(l.text, { t: l.t });
        partial = job.logPartial || '';
        if (partial) appendPartial(); else term.querySelector('.term-partial')?.remove();
        if (job.steps) renderSteps(job.steps);
        if (typeof job.elapsed === 'number') { lastElapsed = job.elapsed; elapsedAt = performance.now(); }
        if (!job.log && job.message) print(job.message);
        const p = typeof job.progress === 'number' ? job.progress : shown;
        setProgress(p, job.status === 'queued' ? job.message : job.message || labelEl.textContent);
      });
      clearInterval(ticker);
      setProgress(1, 'Design received');
      print(`Design received: ${res.design.overview?.title ?? res.design.id}.`, { kind: 'term-ok' });
      rive?.set('state', 2);
      el.querySelector('.progress').classList.add('is-done');
      result.innerHTML = '<p class="ok-msg">Checking the design and raising it on your land…</p>';
      await wait(1800);
      onDone(res);
    } catch (err) {
      clearInterval(ticker);
      rive?.set('state', 3);
      slot.classList.add('is-failed');
      el.querySelector('.progress').classList.add('is-failed');
      const notConnected = err.code === 'not-connected';
      labelEl.textContent = notConnected ? 'No design service is connected' : 'The design didn’t come back';
      print(notConnected ? 'No design service is connected yet.' : err.message, { kind: 'term-fail' });
      onFailed(err);
      result.innerHTML = `
        <div class="fail-card">
          <h3 class="fail-title">${notConnected ? 'Not sent: the design service isn’t connected yet' : 'The design didn’t come back'}</h3>
          <p>${notConnected
            ? 'Run the design service (cd housecost, then go run . -serve) and open the site it serves, or open this page with ?api=http://your-server. Your outline and brief are saved under My sites.'
            : `${esc(err.message)} Your outline and brief are saved under My sites.`}</p>
          <div class="fail-actions">
            ${config.showSample ? `<button type="button" class="btn btn-primary" data-a="preview">${icon('house')}<span>Preview with the sample house</span></button>` : ''}
            <button type="button" class="btn" data-a="retry">${icon('retry')}<span>Try again</span></button>
            <button type="button" class="btn btn-quiet" data-a="edit">Edit the brief</button>
          </div>
          <details class="request">
            <summary>The request${notConnected ? ' that would be sent' : ''}</summary>
            <pre class="code">${esc(JSON.stringify(request, null, 2))}</pre>
            <button type="button" class="btn btn-small" data-a="copy">${icon('copy')}<span>Copy JSON</span></button>
          </details>
        </div>`;
      result.addEventListener('click', async (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'preview') onPreview();
        if (a === 'retry') onRetry();
        if (a === 'edit') onEdit();
        if (a === 'copy') {
          try { await navigator.clipboard.writeText(JSON.stringify(request, null, 2)); toast('Request copied.'); } catch { toast('Couldn’t copy. Select the text instead.'); }
        }
      });
    }
  })();
}

// Colours for the terminal: Gemma's own lines, problems its answers had, and notes.
function classify(text) {
  const t = text.trim();
  if (/^Gemma:/.test(t)) return 'term-gemma';
  if (/problem\(s\)|^- |fails|failed|error/i.test(t)) return 'term-warn';
  if (/busy|Retrying|ran out of room|unavailable/i.test(t)) return 'term-note';
  if (/^verdict:|Design ready/.test(t)) return 'term-ok';
  return '';
}
