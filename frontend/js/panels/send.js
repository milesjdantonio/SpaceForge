// Sending a site to the design service: the general grid animation while it works, then the
// result. Without a connected service this ends in a clear "not connected" state.

import { mountRive } from '../rive.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { config } from '../config.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function renderSending(el, { request, run, onFailed, onRetry, onEdit, onPreview }) {
  el.innerHTML = `
    <header class="panel-head">
      <div>
        <h2 class="panel-title">Sending your land</h2>
        <p class="panel-sub">${request.mode === 'build' ? 'As a listing' : 'Privately'} · ${request.brief.bedrooms} bed · ${request.brief.style}</p>
      </div>
    </header>
    <div class="forge" data-rive-slot>
      <div class="forge-fallback" aria-hidden="true"></div>
    </div>
    <ol class="log" aria-live="polite"></ol>
    <div class="send-result"></div>`;

  const slot = el.querySelector('[data-rive-slot]');
  const log = el.querySelector('.log');
  const result = el.querySelector('.send-result');
  const rive = mountRive(slot, {
    src: 'assets/rive/forge.riv',
    stateMachine: 'Forge',
    onLoad: (h) => h.set('state', 1),
  });
  const line = (text, kind = '') => {
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = text;
    log.append(li);
  };

  (async () => {
    const corners = request.site.geometry.coordinates[0].length - 1;
    line(`Packing the outline: ${corners} corners.`);
    await wait(700);
    line('Adding the brief and your units.');
    await wait(650);
    line('Contacting the design service…');
    await wait(900);
    try {
      const res = await run();
      line('The service accepted the request.', 'ok');
      rive?.set('state', 2);
      result.innerHTML = `<p class="ok-msg">Request ${res?.jobId ?? ''} is in the queue. The design will appear on your land when it’s ready.</p>`;
    } catch (err) {
      rive?.set('state', 3);
      slot.classList.add('is-failed');
      const notConnected = err.code === 'not-connected';
      line(notConnected ? 'No design service is connected yet.' : err.message, 'fail');
      onFailed(err);
      result.innerHTML = `
        <div class="fail-card">
          <h3 class="fail-title">${notConnected ? 'Not sent: the design service isn’t connected yet' : 'Not sent'}</h3>
          <p>${notConnected
            ? 'TerraSim’s design system (Gemma) will draw a house for this land once its API is connected. Your outline and brief are saved under My sites, ready to send.'
            : 'Your outline and brief are saved under My sites. Try again in a moment.'}</p>
          <div class="fail-actions">
            ${config.showSample ? `<button type="button" class="btn btn-primary" data-a="preview">${icon('house')}<span>Preview with the sample house</span></button>` : ''}
            <button type="button" class="btn" data-a="retry">${icon('retry')}<span>Try again</span></button>
            <button type="button" class="btn btn-quiet" data-a="edit">Edit the brief</button>
          </div>
          <details class="request">
            <summary>The request that would be sent</summary>
            <pre class="code">${escapeHtml(JSON.stringify(request, null, 2))}</pre>
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

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
