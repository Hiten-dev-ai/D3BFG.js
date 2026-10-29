const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');

const source = stripTypeScriptTypes(fs.readFileSync('web/src/saveSync.ts', 'utf8')).replace(/^export /gm, '');
const prefix = '/doom3_save_data/accounts/' + 'a'.repeat(32);

async function check(existing, serverEmpty = false, corrupt = false) {
  const files = new Map(existing);
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const db = {
    close() {},
    transaction() {
      const working = new Map(files);
      const tx = { objectStore() { return store; } };
      const store = {
        put(value, key) { working.set(key, value); },
        openCursor() {
          const keys = [...working.keys()];
          let index = 0, pending = true, value;
          const request = { get result() {
            if (pending) throw new DOMException('The request has not finished.', 'InvalidStateError');
            return value;
          } };
          const emit = () => {
            pending = false;
            const key = keys[index++];
            value = key === undefined ? null : { key, value: working.get(key), delete() { working.delete(key); },
              continue() { pending = true; queueMicrotask(emit); } };
            try { request.onsuccess?.({ target: request }); }
            catch (error) { tx.error = error; tx.onabort?.(); return; }
            if (!pending) queueMicrotask(() => {
              files.clear(); for (const entry of working) files.set(...entry);
              tx.oncomplete?.();
            });
          };
          queueMicrotask(emit);
          return request;
        },
      };
      return tx;
    },
  };
  const storage = new Map([['doom3-save-sync-ledger-v1:' + 'a'.repeat(32), JSON.stringify({ revision: 'stale', fingerprint: 'also-dirty' })]]);
  const remote = { revision: 'fixture', files: serverEmpty ? [] : [{ path: 'base/savegame/new.save', size: 3, mtimeMs: 100, sha256 }] };
  const context = vm.createContext({ Uint8Array, Date, crypto: webcrypto, AbortSignal,
    indexedDB: { open() { const request = { result: db }; queueMicrotask(() => request.onsuccess()); return request; } },
    fetch: async (url, options) => {
      assert.notEqual(options?.method, 'POST', 'startup must never upload stale local saves');
      return { ok: true, json: async () => remote, arrayBuffer: async () => corrupt ? new Uint8Array([8]).buffer : bytes.buffer };
    },
    document: { addEventListener() {} }, localStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, window: {},
  });
  vm.runInContext(source + '\nglobalThis.prepareUnderTest = prepareSaveSync;', context);
  if (corrupt) {
    await assert.rejects(context.prepareUnderTest(true, 'a'.repeat(32), true), /integrity check/);
    for (const [key, value] of existing) assert.equal(files.get(key), value, 'invalid online bytes cannot displace local recovery data');
    return;
  }
  await context.prepareUnderTest(true, 'a'.repeat(32), true);
  if (!serverEmpty) assert.deepEqual([...files.get(prefix + '/base/savegame/new.save').contents], [1, 2, 3]);
  assert.equal(files.has(prefix + '/base/savegame/old.save'), false);
  for (const [key, value] of existing) if (!key.startsWith(prefix + '/')) assert.equal(files.get(key), value);
  for (const [key, value] of existing) if (key.startsWith(prefix + '/')) {
    assert.ok([...files.entries()].some(([path, saved]) => path.startsWith('/doom3_save_recovery/') && saved === value), 'displaced local files have a recovery copy');
  }
}

(async () => {
  await check([]);
  const dirty = [[prefix + '/base/savegame/old.save', { mode: 0x81b6, timestamp: new Date(), contents: new Uint8Array([9]) }],
    ['/doom3_save_data/accounts/other/base/savegame/keep.save', { contents: new Uint8Array([7]) }]];
  await check(dirty);
  await check(dirty, true);
  await check(dirty, false, true);
  console.log('Save restore: empty/populated cursor, pending-result rules, replacement and account isolation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
