const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const source = fs.readFileSync('web/src/browserPreferences.ts', 'utf8');
const code = source.slice(source.indexOf('async function nativeAccountAction('), source.indexOf('let refreshStoragePending'));
let user, deletes = 0, logouts = 0, redirected = '', responseError = '', release;
const requests = [];
const context = vm.createContext({ Error, JSON,
  notifySettingsChanged() {}, setCurrentAccount(value) { user = value; },
  async logoutAccount() { ++logouts; },
  window: { doom3AfterAccountDelete() { ++deletes; }, location: { replace(path) { redirected = path; } } },
  async fetch(path, options) {
    requests.push({ path, ...options, body: JSON.parse(options.body) });
    if (release) await new Promise(resolve => { release = resolve; });
    return { ok: !responseError, json: async () => responseError ? { error: responseError } : { user: { name: 'Updated' } } };
  },
});
vm.runInContext('let accountBusy = false, accountStatus = "";\n' + stripTypeScriptTypes(code) +
  '\nglobalThis.run = nativeAccountAction; globalThis.state = () => ({ busy: accountBusy, status: accountStatus });', context);

(async () => {
  await context.run('accountSave|' + JSON.stringify(['Player | "Two"', 'player@example.test']));
  assert.equal(requests[0].method, 'PATCH');
  assert.equal(requests[0].body.name, 'Player | "Two"');
  assert.equal(user.name, 'Updated');
  assert.equal(context.state().status, 'Profile saved.');
  await context.run('accountPassword|' + JSON.stringify(['fixture-old', 'fixture-new', 'different']));
  assert.equal(requests.length, 1);
  assert.equal(context.state().status, 'New passwords do not match.');
  responseError = 'Current password is incorrect.';
  await context.run('accountPassword|' + JSON.stringify(['fixture-old', 'fixture-new', 'fixture-new']));
  assert.equal(requests[1].path, '/__session/password');
  assert.equal(context.state().status, responseError);
  assert.equal(context.state().busy, false);
  responseError = '';
  release = true;
  const pending = context.run('accountSave|' + JSON.stringify(['Name', 'name@example.test']));
  await context.run('accountSave|' + JSON.stringify(['Double', 'double@example.test']));
  assert.equal(requests.length, 3, 'busy bridge rejects duplicate dispatch');
  release(); release = null; await pending;
  await context.run('accountDelete|' + JSON.stringify(['fixture-password']));
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(requests.at(-1).body.confirm, 'DELETE');
  assert.equal(deletes, 1); assert.equal(user, null); assert.equal(redirected, '/');
  await context.run('accountLogout'); assert.equal(logouts, 1);
  console.log('Native account bridge: profile/password requests, errors, duplicate guard, deletion and logout passed (fixture only).');
})().catch(error => { console.error(error); process.exitCode = 1; });
