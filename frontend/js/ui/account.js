import { auth } from '../auth.js';

export function mountAccount(button, dialog) {
  let pending = null, mode = 'signin', busy = false;
  function paintButton() {
    button.textContent = auth.user ? 'Account' : 'Sign In';
    button.title = auth.user ? `Signed in as ${auth.user.email}` : 'Sign in to Save Buildings';
  }
  function finish(value = null) { pending?.(value); pending = null; }
  dialog.addEventListener('close', () => { dialog.replaceChildren(); finish(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  function render() {
    if (auth.user) {
      dialog.innerHTML = `<div class="dialog-body"><h2 class="dialog-title" id="account-title">Your Account</h2><p data-email></p><p class="note">Your saved buildings are private to this account.</p><button class="btn" type="button" data-signout>Sign Out</button><button class="btn btn-quiet" type="button" data-cancel>Close</button></div>`;
      dialog.querySelector('[data-email]').textContent = auth.user.email;
      dialog.querySelector('[data-signout]').onclick = () => { auth.signOut(); dialog.close(); };
    } else {
      const signup = mode === 'signup';
      dialog.innerHTML = `<form class="dialog-body" data-auth-form>
        <h2 class="dialog-title" id="account-title">${signup ? 'Create an Account' : 'Sign In'}</h2>
        <p class="note">Save your buildings and open them again on your next visit.</p>
        <div class="field"><label for="account-email">Email</label><input class="input" id="account-email" name="email" type="email" autocomplete="email" required autofocus></div>
        <div class="field"><label for="account-password">Password</label><input class="input" id="account-password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="${signup ? 6 : 1}" required></div>
        <p class="account-error" data-auth-error role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">${signup ? 'Create Account' : 'Sign In'}</button>
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
          // The service itself can't be reached (or isn't set up): say so, and offer to carry on.
          const down = err instanceof TypeError || err.status >= 500 || /not configured|unavailable/i.test(err.message ?? '');
          error.textContent = down
            ? 'Sign-in can’t be reached right now. You can keep designing without an account; your work stays in this browser.'
            : err.message || 'Sign-in didn’t work. Check your email and password and try again.';
          error.hidden = false;
          if (down && !form.querySelector('[data-continue]')) {
            const go = document.createElement('button');
            go.type = 'button';
            go.className = 'btn';
            go.dataset.continue = '';
            go.textContent = 'Continue Without Signing In';
            go.onclick = () => dialog.close();
            error.after(go);
          }
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
