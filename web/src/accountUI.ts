import './accountUI.css';

export type AccountUser = {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'op' | 'player';
  owner: boolean;
};

type AccountRow = AccountUser & { createdAt?: string };
type SessionStatus = { authenticated: boolean; required: boolean; user?: AccountUser };
let currentAccount: AccountUser | null = null;
let initialized = false;
let cancelPendingConfirmation: (() => void) | null = null;
const dialog = () => document.querySelector<HTMLDialogElement>('#account-dialog')!;
const content = () => document.querySelector<HTMLElement>('#account-dialog-content')!;
const confirmation = () => document.querySelector<HTMLDialogElement>('#account-confirm')!;
const confirmContent = () => document.querySelector<HTMLElement>('#account-confirm-content')!;

function escaped(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let result: any = {};
  try { result = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Request failed (${response.status}).`);
  return result as T;
}

function setCurrentAccount(user: AccountUser | null): void {
  currentAccount = user;
  const trigger = document.querySelector<HTMLButtonElement>('#account-trigger');
  const name = document.querySelector<HTMLElement>('#account-trigger-name');
  if (trigger) trigger.hidden = !user;
  if (name) name.textContent = user?.name || 'Account';
  document.dispatchEvent(new CustomEvent('doom3-account-changed', { detail: { user } }));
}
export { setCurrentAccount };
export function getCurrentAccount(): AccountUser | null { return currentAccount; }

function leaving(): Promise<void> {
  document.dispatchEvent(new CustomEvent('doom3-account-leaving'));
  const callback = (window as Window & { doom3BeforeAccountLeave?: () => Promise<void> }).doom3BeforeAccountLeave;
  return callback ? callback() : Promise.resolve();
}

export async function logoutAccount(): Promise<void> {
  await leaving();
  await request('/__session/logout', 'POST', {});
  setCurrentAccount(null);
  window.location.reload();
}

function showError(target: HTMLElement, error: unknown): void {
  let node = target.querySelector<HTMLElement>('[data-error]');
  if (!node) {
    node = document.createElement('p'); node.className = 'account-error';
    node.dataset.error = ''; node.setAttribute('role', 'alert'); target.append(node);
  }
  node.textContent = error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

function shell(title: string, subtitle: string, back = false): string {
  return `<header class="account-head"><div><h2 id="account-dialog-title">${escaped(title)}</h2><p>${escaped(subtitle)}</p></div><button class="account-close" type="button" data-close aria-label="Close">×</button></header>${back ? '<button class="account-back" type="button" data-profile>‹ Profile</button>' : ''}<div class="account-body">`;
}
function end(): string { return '</div>'; }
function open(html: string): void {
  dialog().classList.remove('account-quick');
  content().innerHTML = html;
  if (!dialog().open) dialog().showModal();
}

function openAccountMenu(): void {
  const user = currentAccount;
  if (!user) return;
  const admin = user.role === 'owner' || user.role === 'op';
  open(shell('Account', `${user.name} · ${user.email}`) + `<nav class="account-menu-actions" aria-label="Account actions">
    <button class="account-menu-action" type="button" data-menu-profile><span>Manage profile</span><span aria-hidden="true">›</span></button>
    ${admin ? '<button class="account-menu-action" type="button" data-admin><span>Manage accounts</span><span aria-hidden="true">›</span></button>' : ''}
    <button class="account-menu-action account-menu-logout" type="button" data-logout><span>Logout</span><span aria-hidden="true">↗</span></button>
  </nav>` + end());
  dialog().classList.add('account-quick');
}

export function openProfile(): void {
  const user = currentAccount;
  if (!user) return;
  const controls = `<section class="account-section"><h3>Profile details</h3><form data-form="profile" class="account-form">
    <label>Display name<input name="name" value="${escaped(user.name)}" maxlength="80" required autocomplete="name"></label>
    <label>Email address<input name="email" type="email" value="${escaped(user.email)}" maxlength="254" required autocomplete="email"></label>
    <button class="account-primary" type="submit">Save profile</button><p class="account-error" data-error role="alert"></p>
  </form></section>
  <section class="account-section"><h3>Password</h3><button class="account-secondary" type="button" data-password-panel>Change password</button></section>
  <section class="account-section account-danger"><h3>Delete account</h3><p>Deleting your account permanently removes its profile and all saves stored for it.</p><button class="account-danger-button" type="button" data-delete-profile>Delete my account</button></section>
  <footer class="account-footer"><span>${escaped(user.role === 'owner' ? 'Owner' : user.role === 'op' ? 'Operator' : 'Player')}</span></footer>`;
  open(shell('Manage profile', `${user.name} · ${user.email}`) + controls + end());
}

function openPasswordPanel(): void {
  if (!currentAccount) return;
  open(shell('Change password', 'Choose a new password for this account.', true) + `<form data-form="password" class="account-form">
    <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="256"></label>
    <label>New password<input name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="256"></label>
    <label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" required maxlength="256"></label>
    <p class="account-error" data-error role="alert"></p><div class="account-actions"><button class="account-secondary" type="button" data-profile>Cancel</button><button class="account-primary" type="submit">Save new password</button></div>
  </form>` + end());
  content().querySelector<HTMLInputElement>('[name="currentPassword"]')?.focus();
}

async function confirmDialog(title: string, description: string, submitLabel: string, input?: { label: string; name: string; type?: string; value?: string }): Promise<string | null> {
  cancelPendingConfirmation?.();
  confirmContent().innerHTML = `<header class="account-head"><div><h2 id="account-confirm-title">${escaped(title)}</h2><p>${escaped(description)}</p></div><button class="account-close" type="button" data-cancel aria-label="Close">×</button></header><form data-form="confirm" class="account-form">${input ? `<label>${escaped(input.label)}<input name="${escaped(input.name)}" type="${escaped(input.type || 'text')}" value="${escaped(input.value || '')}" required autocomplete="off"></label>` : ''}<p class="account-error" data-error role="alert"></p><div class="account-actions"><button class="account-secondary" type="button" data-cancel>Cancel</button><button class="account-danger-button" type="submit">${escaped(submitLabel)}</button></div></form>`;
  const modal = confirmation();
  return new Promise(resolve => {
    let settled = false;
    const form = confirmContent().querySelector<HTMLFormElement>('[data-form="confirm"]')!;
    const cancelButtons = [...confirmContent().querySelectorAll<HTMLButtonElement>('[data-cancel]')];
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      const data = new FormData(form);
      finish(String(input ? data.get(input.name) || '' : 'confirmed'));
    };
    const onCancelButton = () => finish(null);
    const onCancel = (event: Event) => { event.preventDefault(); finish(null); };
    const onBackdrop = (event: MouseEvent) => { if (event.target === modal) finish(null); };
    const onClose = () => { if (!modal.open) finish(null); };
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      for (const button of cancelButtons) button.removeEventListener('click', onCancelButton);
      modal.removeEventListener('cancel', onCancel);
      modal.removeEventListener('click', onBackdrop);
      modal.removeEventListener('close', onClose);
      if (cancelPendingConfirmation === cancelCurrent) cancelPendingConfirmation = null;
    };
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (modal.open) modal.close();
      resolve(value);
    };
    const cancelCurrent = () => finish(null);
    cancelPendingConfirmation = cancelCurrent;
    form.addEventListener('submit', onSubmit);
    for (const button of cancelButtons) button.addEventListener('click', onCancelButton);
    modal.addEventListener('cancel', onCancel);
    modal.addEventListener('click', onBackdrop);
    modal.addEventListener('close', onClose);
    if (!modal.open) modal.showModal();
    form.querySelector('input')?.focus();
  });
}

export async function openDeleteAccount(): Promise<void> {
  if (!currentAccount) return;
  const password = await confirmDialog('Delete your account?', 'This permanently deletes your account and every save attached to it. This cannot be undone.', 'Continue', { label: 'Enter your password to continue', name: 'password', type: 'password' });
  if (password === null) return;
  const proof = await confirmDialog('Last check', 'All game saves for this account will be lost.', 'Delete account', { label: 'Type DELETE to confirm', name: 'confirm' });
  if (proof !== 'DELETE') return;
  try {
    await leaving();
    await request('/__session/profile', 'DELETE', { password, confirm: 'DELETE' });
    (window as Window & { doom3AfterAccountDelete?: () => void }).doom3AfterAccountDelete?.();
    setCurrentAccount(null);
    window.location.reload();
  } catch (error) {
    openProfile();
    showError(content(), error);
  }
}

async function manageAccounts(): Promise<void> {
  if (!currentAccount || (currentAccount.role !== 'owner' && currentAccount.role !== 'op')) return;
  const actor = currentAccount;
  let rows: AccountRow[] = [];
  try { rows = (await request<{ accounts: AccountRow[] }>('/__session/accounts')).accounts; }
  catch (error) { open(shell('Manage accounts', 'Account administration', true) + `<p class="account-error">${escaped(error instanceof Error ? error.message : 'Could not load accounts.')}</p>` + end()); return; }
  const rowHtml = (a: AccountRow) => {
    const canEdit = actor.role === 'owner' || a.role === 'player';
    return `<tr data-account-row="${escaped(a.id)}"><td><input type="checkbox" aria-label="Select ${escaped(a.name)}" value="${escaped(a.id)}" data-select-account></td><td>${canEdit ? `<button class="account-link" type="button" data-edit="${escaped(a.id)}">${escaped(a.name)}</button>` : escaped(a.name)}<small>${escaped(a.email)}</small></td><td><span class="role-tag">${escaped(a.role)}</span></td><td><button class="table-action" type="button" data-saves="${escaped(a.id)}">Saves</button><button class="table-action" type="button" data-revoke="${escaped(a.id)}">Sign out</button></td></tr>`;
  };
  const html = `<section class="account-section"><div class="admin-toolbar"><label class="search-label">Find account<input type="search" data-search placeholder="Name or email"></label><button class="account-primary" type="button" data-new-account>Add account</button><button class="account-danger-button" type="button" data-delete-selected disabled>Delete selected</button></div>
    <div class="account-table-wrap"><table class="account-table"><thead><tr><th></th><th>Account</th><th>Access</th><th>Actions</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table></div><p class="account-empty" ${rows.length ? 'hidden' : ''}>No accounts yet. Add a player or operator to begin.</p><p class="account-error" data-error role="alert"></p></section>`;
  open(shell('Manage accounts', `${rows.length} ${rows.length === 1 ? 'account' : 'accounts'}`, true) + html + end());
}

function accountForm(isNew: boolean, account?: AccountRow): void {
  const user = currentAccount;
  if (!user || (user.role !== 'owner' && user.role !== 'op')) return;
  const roles = user.role === 'owner' ? (account?.role === 'owner' ? ['owner'] : ['player', 'op']) : ['player'];
  open(shell(isNew ? 'Add account' : 'Edit account', isNew ? 'Create a sign-in for this game.' : account?.email || '', true) + `<form data-form="account" class="account-form">
    <label>Display name<input name="name" value="${escaped(account?.name)}" maxlength="80" required autocomplete="name"></label>
    <label>Email address<input name="email" type="email" value="${escaped(account?.email)}" maxlength="254" required autocomplete="email"></label>
    <label>Access level<select name="role" ${roles.length === 1 ? 'disabled' : ''}>${roles.map(role => `<option value="${role}" ${account?.role === role || (!account && role === 'player') ? 'selected' : ''}>${role === 'owner' ? 'Owner' : role === 'op' ? 'Operator' : 'Player'}</option>`).join('')}</select></label>
    <label>${isNew ? 'Temporary password' : 'New password (optional)'}<input name="password" type="password" ${isNew ? 'required minlength="12"' : ''} autocomplete="new-password" minlength="12" maxlength="256"></label>
    <p class="account-error" data-error role="alert"></p><div class="account-actions"><button class="account-secondary" type="button" data-admin>Cancel</button><button class="account-primary" type="submit">${isNew ? 'Create account' : 'Save changes'}</button></div>
  </form>` + end());
  const form = content().querySelector<HTMLFormElement>('[data-form="account"]')!;
  form.onsubmit = async event => {
    event.preventDefault(); const data = new FormData(form);
    const body: Record<string, string> = { name: String(data.get('name')), email: String(data.get('email')), role: roles.length === 1 ? roles[0] : String(data.get('role')) };
    const password = String(data.get('password') || ''); if (password) body.password = password;
    try {
      await request(isNew ? '/__session/accounts' : `/__session/accounts/${encodeURIComponent(account!.id)}`, isNew ? 'POST' : 'PATCH', body);
      await manageAccounts();
    } catch (error) { showError(form, error); }
  };
}

function bindEvents(): void {
  if (initialized) return;
  initialized = true;
  document.querySelector<HTMLButtonElement>('#account-trigger')?.addEventListener('click', openAccountMenu);
  document.addEventListener('click', async event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-close], [data-profile], [data-menu-profile], [data-password-panel], [data-admin], [data-logout], [data-delete-profile], [data-new-account], [data-edit], [data-saves], [data-revoke], [data-delete-selected]');
    if (!target) return;
    if (target.hasAttribute('data-close')) dialog().close();
    else if (target.hasAttribute('data-profile')) openProfile();
    else if (target.hasAttribute('data-menu-profile')) openProfile();
    else if (target.hasAttribute('data-password-panel')) openPasswordPanel();
    else if (target.hasAttribute('data-admin')) await manageAccounts();
    else if (target.hasAttribute('data-logout')) { try { await logoutAccount(); } catch (error) { showError(content(), error); } }
    else if (target.hasAttribute('data-delete-profile')) await openDeleteAccount();
    else if (target.hasAttribute('data-new-account')) accountForm(true);
    else if (target.hasAttribute('data-edit')) {
      const id = target.getAttribute('data-edit')!;
      const item = await request<{ accounts: AccountRow[] }>('/__session/accounts');
      const account = item.accounts.find(row => row.id === id); if (account) accountForm(false, account);
    } else if (target.hasAttribute('data-revoke')) {
      const id = target.getAttribute('data-revoke')!;
      try {
        if (id === currentAccount?.id) await leaving();
        await request(`/__session/accounts/${encodeURIComponent(id)}/logout`, 'POST', {});
        if (id === currentAccount?.id) { setCurrentAccount(null); window.location.reload(); }
        else target.textContent = 'Signed out';
      }
      catch (error) { showError(content(), error); }
    } else if (target.hasAttribute('data-saves')) {
      const id = target.getAttribute('data-saves')!;
      try {
        const saves = await request<{ files: Array<{ path: string; size: number; mtimeMs: number }> }>(`/__session/accounts/${encodeURIComponent(id)}/saves`);
        const section = content().querySelector<HTMLElement>('[data-error]')?.parentElement;
        if (section) {
          let listing = section.querySelector<HTMLElement>('.save-list');
          if (!listing) { listing = document.createElement('div'); listing.className = 'save-list'; section.append(listing); }
          listing.innerHTML = saves.files.length ? `<h3>Stored saves</h3><ul>${saves.files.map(file => `<li><a href="/__session/accounts/${encodeURIComponent(id)}/saves/file?path=${encodeURIComponent(file.path)}" download>${escaped(file.path)}</a><span>${(file.size / 1024).toFixed(1)} KB</span></li>`).join('')}</ul>` : '<p class="account-empty">No saves stored for this account.</p>';
        }
      } catch (error) { showError(content(), error); }
    } else if (target.hasAttribute('data-delete-selected')) {
      const ids = [...content().querySelectorAll<HTMLInputElement>('[data-select-account]:checked')].map(input => input.value);
      if (!ids.length) return;
      const answer = await confirmDialog('Delete selected accounts?', `${ids.length} account${ids.length === 1 ? '' : 's'} and their saves will be permanently deleted.`, 'Delete accounts', { label: 'Type DELETE to confirm', name: 'confirm' });
      if (answer !== 'DELETE') return;
      try {
        const deletingSelf = ids.includes(currentAccount?.id || '');
        if (deletingSelf) await leaving();
        await request('/__session/accounts', 'DELETE', { ids, confirm: 'DELETE' });
        if (deletingSelf) { setCurrentAccount(null); window.location.reload(); }
        else await manageAccounts();
      }
      catch (error) { showError(content(), error); }
    }
  });
  document.addEventListener('input', event => {
    const target = event.target as HTMLInputElement;
    if (!target.matches('[data-search]')) return;
    const query = target.value.trim().toLocaleLowerCase();
    content().querySelectorAll<HTMLElement>('[data-account-row]').forEach(row => { row.hidden = !row.textContent!.toLocaleLowerCase().includes(query); });
  });
  document.addEventListener('change', event => {
    if (!(event.target as HTMLElement).matches('[data-select-account]')) return;
    const button = content().querySelector<HTMLButtonElement>('[data-delete-selected]');
    if (button) button.disabled = !content().querySelector('[data-select-account]:checked');
  });
  document.addEventListener('submit', async event => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('form[data-form="profile"], form[data-form="password"]');
    if (!form) return;
    event.preventDefault(); const data = new FormData(form);
    try {
      if (form.dataset.form === 'profile') {
        const name = String(data.get('name')).trim(); const email = String(data.get('email')).trim();
        const answer = await confirmDialog('Save profile changes?', `Change your profile to ${name} · ${email}?`, 'Save changes');
        if (!answer) return;
        const result = await request<{ user: AccountUser }>('/__session/profile', 'PATCH', { name, email });
        setCurrentAccount(result.user); openProfile();
      } else {
        const currentPassword = String(data.get('currentPassword')); const newPassword = String(data.get('newPassword')); const confirmPassword = String(data.get('confirmPassword'));
        if (newPassword !== confirmPassword) throw new Error('The new passwords do not match.');
        await request('/__session/password', 'POST', { currentPassword, newPassword }); openProfile();
      }
    } catch (error) { showError(form, error); }
  });
  dialog().addEventListener('click', event => { if (event.target === dialog()) dialog().close(); });
}

export function initializeAccountUI(status: SessionStatus): void {
  bindEvents();
  setCurrentAccount(status.authenticated ? status.user || null : null);
}

export async function showAccountLogin(): Promise<AccountUser | null> {
  bindEvents();
  const form = document.querySelector<HTMLFormElement>('#access-form')!;
  const input = document.querySelector<HTMLInputElement>('#access-password')!;
  const login = document.querySelector<HTMLInputElement>('#access-login')!;
  const error = document.querySelector<HTMLElement>('#access-error')!;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const track = document.querySelector<HTMLElement>('.progress-track')!;
  const detail = document.querySelector<HTMLElement>('#loading-detail')!;
  const label = document.querySelector<HTMLElement>('#loading-status')!;
  label.textContent = 'Sign in to continue';
  detail.textContent = 'Use the account provided by your game host.';
  track.hidden = true; form.hidden = false;
  login.focus({ preventScroll: true });
  return new Promise(resolve => {
    form.onsubmit = async event => {
      event.preventDefault(); if (button.disabled) return;
      button.disabled = true; error.textContent = '';
      label.textContent = 'Signing in…';
      detail.textContent = 'Checking your account';
      button.textContent = 'Signing in…';
      form.setAttribute('aria-busy', 'true');
      label.classList.add('signing-in');
      try {
        await request('/__session/login', 'POST', { login: login.value.trim(), password: input.value });
        const state = await request<SessionStatus>('/__session/status');
        if (!state.authenticated || !state.user) throw new Error('The sign-in cookie was not accepted. Allow site data, then try again.');
        input.value = ''; form.hidden = true; track.hidden = false; form.onsubmit = null;
        initializeAccountUI(state); resolve(state.user);
      } catch (reason) {
        label.textContent = 'Sign in to continue';
        detail.textContent = 'Use the account provided by your game host.';
        error.textContent = reason instanceof Error ? reason.message : 'Could not sign in.'; input.select();
      }
      finally {
        button.disabled = false; button.textContent = 'Sign in';
        form.removeAttribute('aria-busy'); label.classList.remove('signing-in');
      }
    };
  });
}
