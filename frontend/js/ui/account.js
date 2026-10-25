import { auth } from '../auth.js';

export function mountAccount(button, dialog) {
  let pending = null, mode = 'signin', busy = false;
  function paintButton() {
    button.textContent = auth.user ? 'Account' : 'Sign in';
    button.title = auth.user ? `Signed in as ${auth.user.email}` : 'Sign in to save buildings';
  }
  function finish(value = null) { pending?.(value); pending = null; }
  dialog.addEventListener('close', () => { dialog.replaceChildren(); finish(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  function render() {
    if (auth.user) {
      dialog.innerHTML = `<div class="dialog-body"><h2 class="dialog-title" id="account-title">Your account</h2><p data-email></p><p class="note">Your saved buildings are private to this account.</p><button class="btn" type="button" data-signout>Sign out</button><button class="btn btn-quiet" type="button" data-cancel>Close</button></div>`;
      dialog.querySelector('[data-email]').textContent = auth.user.email;
      dialog.querySelector('[data-signout]').onclick = () => { auth.signOut(); dialog.close(); };
    } else {
      const signup = mode === 'signup';
      dialog.innerHTML = `<form class="dialog-body" data-auth-form>
        <h2 class="dialog-title" id="account-title">${signup ? 'Create an account' : 'Sign in'}</h2>
        <p class="note">Save your buildings and open them again on your next visit.</p>
        <div class="field"><label for="account-email">Email</label><input class="input" id="account-email" name="email" type="email" autocomplete="email" required autofocus></div>
        <div class="field"><label for="account-password">Password</label><input class="input" id="account-password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="${signup ? 6 : 1}" required></div>
        <p class="account-error" data-auth-error role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
        <button class="text-link" type="button" data-toggle>${signup ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
        <button class="btn btn-quiet" type="button" data-cancel>Cancel</button>
      </form>`;
      dialog.querySelector('[data-toggle]').onclick = () => { mode = signup ? 'signin' : 'signup'; render(); };
      dialog.querySelector('form').onsubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = event.currentTarget;
        const email = form.elements.email.value, password = form.elements.password.value;
        const error = dialog.querySelector('[data-auth-error]');
        busy = true; error.hidden = true;
        form.querySelectorAll('button').forEach((el) => { el.disabled = true; });
        try {
          const user = await auth[signup ? 'signUp' : 'signIn'](email, password);
          form.elements.password.value = '';
          finish(user); dialog.close();
        } catch (err) {
          error.textContent = err.message || 'Sign-in is unavailable. Please try again.';
          error.hidden = false;
        } finally {
          busy = false;
          form.querySelectorAll('button').forEach((el) => { el.disabled = false; });
        }
      };
    }
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.setAttribute('aria-labelledby', 'account-title');
  }
  async function open() { await auth.ready; mode = 'signin'; render(); if (!dialog.open) dialog.showModal(); }
  button.addEventListener('click', open);
  auth.onChange(paintButton);
  auth.ready.then(paintButton);
  paintButton();
  return {
    open,
    async require() {
      await auth.ready;
      if (auth.user) return auth.user;
      if (pending) return null;
      return new Promise((resolve) => { pending = resolve; open(); });
    },
  };
}
