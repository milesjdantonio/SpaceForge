const host = () => document.getElementById('toasts');

export function toast(message, { ms = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  host().append(el);
  el.animate?.([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
  setTimeout(() => {
    const a = el.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
    if (a) a.onfinish = () => el.remove();
    else el.remove();
  }, ms);
}
