const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const source = fs.readFileSync(path.join(__dirname, '../web/src/opfsCache.ts'), 'utf8');
const start = source.indexOf('export async function streamFileToOpfs(');
const end = source.indexOf('/**', start);
const actual = stripTypeScriptTypes(source.slice(start, end).replace('export async', 'async'));
async function run(bytes, expectedSize, existing = false) {
  let offset = 0, closed = false, aborted = false, deleted = false;
  const writes = [], progress = [];
  const file = { getFile: async () => ({}), createWritable: async () => ({
    write: async data => writes.push(Buffer.from(data)),
    close: async () => { closed = true; }, abort: async () => { aborted = true; },
  }) };
  const directory = { getFileHandle: async (_name, options) => {
    if (!options && !existing) throw new Error('Not found'); return file;
  } };
  const context = vm.createContext({ Uint8Array,
    fetch: async () => ({ ok: true, body: { getReader: () => ({
      read: async () => {
        if (offset === bytes.length) return { done: true };
        const value = bytes.subarray(offset, Math.min(offset + 16384, bytes.length));
        offset += value.length; return { done: false, value };
      }, cancel: async () => {},
    }) } }),
    ensureOpfsParentDirectories: async () => ({ dirHandle: directory, filename: 'archive.resources' }),
    deleteOpfsFile: async () => { deleted = true; },
  });
  vm.runInContext(actual + ';this.stream = streamFileToOpfs;', context);
  let error;
  try { await context.stream({}, 'base/archive.resources', '/file', count => progress.push(count), undefined, expectedSize); }
  catch (reason) { error = reason; }
  return { writes, progress, closed, aborted, deleted, error };
}
(async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 123);
  for (let i = 0; i < bytes.length; ++i) bytes[i] = i % 251;
  const success = await run(bytes, bytes.length);
  assert.equal(success.error, undefined); assert.equal(success.closed, true);
  assert.equal(success.writes.length, 4, '193 small network chunks require only four disk writes');
  assert.deepEqual(Buffer.concat(success.writes), bytes);
  assert.equal(success.progress.reduce((a,b) => a+b,0), bytes.length);
  for (const expected of [bytes.length - 1, bytes.length + 1]) {
    const failure = await run(bytes, expected, true);
    assert.match(failure.error.message, /expected size|size mismatch/);
    assert.equal(failure.closed, false); assert.equal(failure.aborted, true);
    assert.equal(failure.deleted, false, 'a failed replacement retains the previous cache entry');
  }
  const failure = await run(Buffer.alloc(1), 2);
  assert.equal(failure.deleted, true, 'a failed new entry is cleaned up');
  console.log('Actual OPFS downloader: identical bytes with 4 writes instead of 193; progress, bounds and failed-replacement preservation pass.');
})().catch(error => { console.error(error); process.exitCode = 1; });
