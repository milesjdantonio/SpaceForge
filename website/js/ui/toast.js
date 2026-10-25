const host = () => document.getElementById('toasts');

// A short message at the bottom of the screen. Errors can carry an action, a backup the person can
// take right there ({ label, run }); those stay up longer and can be closed.
export function toast(message, { ms, kind = '', action = null } = {}) {
  const el = document.createElement('div');
  el.className = `toast${kind ? ` toast-${kind}` : ''}`;
  if (kind === 'error') el.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  let timer = 0;
  const remove = () => {
    clearTimeout(timer);
    const a = el.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
    if (a) a.onfinish = () => el.remove();
    else el.remove();
  };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { remove(); action.run(); };
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-close';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.onclick = remove;
    el.append(b, x);
  }
  host().append(el);
  el.animate?.([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
  timer = setTimeout(remove, ms ?? (action ? 9000 : kind === 'error' ? 6500 : 4200));
  return { close: remove };
}
