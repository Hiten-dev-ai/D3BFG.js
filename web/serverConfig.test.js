import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readServerConfig } from './serverConfig.js';
import { createAccountSession } from './accountSession.js';

test('server defaults validate types and expose no bootstrap credentials', () => {
  const config = readServerConfig({ FIRST_PASSWORD: 'never-send-this', MULTIPLAYER_ENABLED: 'false', BROWSER_CACHE_MODE: '2' });
  assert.equal(config.multiplayer, false);
  assert.equal(config.offlinePlaybackAllowed, true);
  assert.equal(config.browserDefaults.pauseAudioUnfocused, 1);
  assert.equal(readServerConfig({ OFFLINE_PLAYBACK_ALLOWED: 'false' }).offlinePlaybackAllowed, false);
  assert.equal(config.browserDefaults.cacheMode, 2);
  assert(!JSON.stringify(config).includes('never-send-this'));
  assert.throws(() => readServerConfig({ PORT: '0' }));
  assert.throws(() => readServerConfig({ MULTIPLAYER_ENABLED: 'perhaps' }));
  assert.throws(() => readServerConfig({ BROWSER_CACHE_MODE: '99' }));
});

test('first-owner setup hashes a strong password once and never replaces existing accounts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd3bfg-owner-test-'));
  try {
    assert.throws(() => createAccountSession({ directory, initialOwner: { name: 'Admin', email: 'admin@example.test', password: 'short' } }));
    const initialOwner = { name: 'Admin', email: 'admin@example.test', password: 'test-only-unique-password-42' };
    createAccountSession({ directory, initialOwner });
    const original = fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8');
    assert(!original.includes(initialOwner.password));
    const account = JSON.parse(original).accounts[0];
    assert.equal(account.name, 'Admin'); assert.equal(account.role, 'owner'); assert.equal(account.passwordHash.length, 128);
    createAccountSession({ directory, initialOwner: { name: 'Other', email: 'other@example.test', password: 'another-test-password' } });
    assert.equal(fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8'), original);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
