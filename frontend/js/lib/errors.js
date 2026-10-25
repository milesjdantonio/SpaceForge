// Every error explained the same way: what happened, what to try, and the actions that try it, so
// no one is left with an error and nothing to do. Actions are ids the caller wires up:
//   retry · edit · fix (apply `patch` to the brief) · preview (sample house) · outline (new land)
//   copy (the request) · wait (try again later)

const has = (s, re) => re.test(String(s ?? ''));

// Why a design didn't come back, and what to do about it. `request` is what was sent; `fit` is
// lib/fit.js's verdict for that brief on that land, used to suggest a concrete change.
export function explainDesignError(err, { request = null, fit = null } = {}) {
  const msg = err?.message ?? '';
  const brief = request?.brief ?? {};
  const keep = 'Your land and brief are saved in My Builds.';
  const fixes = suggestFixes(err, { brief, fit, type: request?.housingType });

  if (err?.reason === 'design-does-not-fit') {
    return {
      title: 'The building does not fit this land',
      text: msg,
      next: 'Reduce the building size or number of homes, or outline a larger lot. Setbacks need clear space around the footprint.',
      actions: ['edit', 'outline', 'preview'],
      fixes,
    };
  }

  if (err?.code === 'not-connected' || err?.code === 'not_connected') {
    return {
      title: 'The design service isn’t connected',
      text: `Nothing was sent. ${keep}`,
      next: 'Generation is unavailable right now. Try again later, or place the sample house on your land.',
      actions: ['preview', 'retry', 'edit'],
      fixes,
    };
  }
  if (err?.code === 'network') {
    return {
      title: 'Couldn’t reach the design service',
      text: `The request didn’t get through. ${keep}`,
      next: 'Check your internet connection and that the design service is running, then try again.',
      actions: ['retry', 'preview', 'edit'],
      fixes,
    };
  }
  if (err?.code === 'rate-limited' || err?.status === 429 || err?.status === 503 || has(msg, /busy|quota|rate limit|overloaded/i)) {
    return {
      title: 'The design service is busy',
      text: 'Gemma has too many requests right now.',
      next: 'Wait a minute and try again. Your brief is kept, so nothing needs re-entering.',
      actions: ['retry', 'preview'],
      fixes,
    };
  }
  if (err?.status === 422 || has(msg, /coverage|outside the (us|united states)|no site data/i)) {
    return {
      title: 'No site data for this land',
      text: msg || 'The design service has no site data here.',
      next: 'Try again: outside the US, TerraSim now estimates the site and labels the result. Or outline land somewhere else.',
      actions: ['retry', 'outline', 'preview'],
      fixes,
    };
  }
  if (err?.code === 'timeout') {
    return {
      title: 'This design is taking longer than usual',
      text: msg,
      next: 'Large buildings take longest. Try again, or make the brief smaller (fewer floors or homes).',
      actions: ['retry', 'edit'],
      fixes,
    };
  }
  if (err?.code === 'no-design' || err?.code === 'invalid-design') {
    return {
      title: 'The design came back incomplete',
      text: msg || 'Gemma answered, but the design couldn’t be drawn.',
      next: 'This is usually a one-off. Try again; if it repeats, a shorter, plainer description helps.',
      actions: ['retry', 'edit'],
      fixes,
    };
  }
  if (err?.status >= 400 && err?.status < 500) {
    return {
      title: 'The design service didn’t accept the brief',
      text: msg,
      next: 'Check the brief’s numbers and description, then send it again.',
      actions: ['edit', 'retry'],
      fixes,
    };
  }
  return {
    title: 'The design didn’t come back',
    text: msg || 'The design service couldn’t finish this design.',
    next: fixes.length ? 'Try one of the suggestions below, or try again as it is.' : 'Try again; most failures don’t repeat. If it does, simplify the brief.',
    actions: ['retry', 'edit', 'preview'],
    fixes,
  };
}

// Concrete changes to the brief that are likely to help, from the error and the land fit.
// Each is { label, why, patch } where patch is merged into the brief's answers.
export function suggestFixes(err, { brief = {}, fit = null, type = null } = {}) {
  const msg = err?.message ?? '';
  const out = [];
  if (fit?.level === 'over') {
    if (fit.floorsNeeded) out.push({ label: `Use ${fit.floorsNeeded} floors`, why: 'The building is too big for the land on fewer floors.', patch: { floors: fit.floorsNeeded } });
    if (brief.areaM2 && fit.share > 1) {
      const area = Math.max(10, Math.floor((brief.areaM2 / fit.share) * 0.9));
      out.push({ label: 'Make it smaller', why: 'A size that fits the buildable land.', patch: { areaM2: area } });
    }
    if (type !== 'dorm') out.push({ label: 'Let Gemma choose the size', why: 'Gemma sizes it to fit the land.', patch: { areaByAI: true } });
  }
  if (has(msg, /budget|cost|afford|too (low|small)/i) && brief.budgetUSD) {
    out.push({ label: 'Raise the budget 25%', why: 'The design may not be buildable for this budget.', patch: { budgetUSD: Math.round((brief.budgetUSD * 1.25) / 1000) * 1000 } });
    out.push({ label: 'No budget limit', why: 'Let the design set its own cost.', patch: { noBudgetLimit: true } });
  }
  if (has(msg, /json|parse|invalid|program|style|could not use|unusable/i) && (brief.designPrompt?.length ?? 0) > 220) {
    out.push({ label: 'Shorten the description', why: 'A shorter, plainer description is easier for Gemma to follow.', patch: { designPrompt: brief.designPrompt.slice(0, 200).replace(/\s+\S*$/, '') + '.' } });
  }
  return out.slice(0, 3);
}

// Saving to the account.
export function explainSaveError(err) {
  if (err?.code === 'sign-in-required') return { text: 'Sign in to save buildings to your account.', action: 'Sign in' };
  if (err?.status === 401) return { text: 'Your sign-in expired, so the building wasn’t saved.', action: 'Sign in again' };
  if (err?.status === 413) return { text: 'This building is too large to save (over 1 MB).', action: null };
  if (err?.code === 'account-changed' || err?.code === 'view-changed') return { text: 'The account or building changed while saving.', action: 'Try again' };
  if (err instanceof TypeError || /unavailable|fetch|network/i.test(err?.message ?? '')) {
    return { text: 'Saved buildings can’t be reached right now. It stays on the map in this tab.', action: 'Try again' };
  }
  return { text: err?.message || 'The building wasn’t saved.', action: 'Try again' };
}
