import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { prepareEncodedAsset, findEncodedAsset } from './assetCompression.js';

test('private precompression preserves decoded bytes and rejects stale source identities', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'doom3-encoded-test-'));
  try {
    const game = path.join(root, 'game');
    const cache = path.join(root, 'encoded');
    await fs.promises.mkdir(path.join(game, 'base'), { recursive: true });
    const relative = 'base/_sound_pc.resources';
    const source = path.join(game, relative);
    const bytes = Buffer.from('native game resource\n'.repeat(50000));
    await fs.promises.writeFile(source, bytes);
    const prepared = await prepareEncodedAsset(cache, game, relative);
    assert.equal(prepared.cached, false);
    assert.ok(prepared.encodedBytes < prepared.sourceBytes);
    const stat = await fs.promises.stat(source);
    const encoded = findEncodedAsset(cache, relative, stat);
    assert.deepEqual(gunzipSync(await fs.promises.readFile(encoded.path)), bytes);
    assert.equal((await prepareEncodedAsset(cache, game, relative)).cached, true);
    await fs.promises.appendFile(source, 'changed');
    assert.equal(findEncodedAsset(cache, relative, await fs.promises.stat(source)), null);
    await assert.rejects(prepareEncodedAsset(cache, game, '../encoded/no-file'), /ENOENT|inside/);
    assert.equal((await fs.promises.readdir(cache)).some(name => name.endsWith('.tmp')), false);
  } finally {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'doom3-encoded-test-')));
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
