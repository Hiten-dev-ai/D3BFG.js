import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRuntimeDiagnostics } from './runtimeDiagnostics.js';

test('diagnostics require same-origin authentication, bound input and filter lines', async () => {
  const logged = [];
  const handle = createRuntimeDiagnostics({ identity: req => req.headers.cookie === 'session=test' ? { id: 'a'.repeat(32) } : null,
    log: (...args) => logged.push(args.join(' ')) });
  const server = createServer((req, res) => { void handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (body, origin = base, cookie = 'session=test') => fetch(base, { method: 'POST',
    headers: { origin, cookie, 'content-type': 'text/plain' }, body });
  try {
    assert.equal((await send('[web-port map] started', base, '')).status, 403);
    assert.equal((await send('[web-port map] started', 'https://elsewhere.example')).status, 403);
    assert.equal((await send('x'.repeat(4097))).status, 413);
    assert.equal((await send('[web-port map] LoadMap begin\nchat message\n[BFG Engine Abort] token=secret')).status, 204);
    assert.equal(logged.length, 2);
    assert.match(logged[0], /LoadMap begin/);
    assert.match(logged[1], /token=\[redacted\]/);
    assert.doesNotMatch(logged.join(' '), /chat message|secret/);
    const crash = '[BFG Engine Error] first crash ' + 'x'.repeat(1500) + ' LAST_FRAME';
    assert.equal((await send(crash)).status, 204);
    assert.match(logged.at(-1), /LAST_FRAME/);
    const asyncTrap = '[BFG Worker Async Fatal] RuntimeError: null function | at ActualWasmCallback ' + 'x'.repeat(1500) + ' ORIGINAL_STACK_END';
    assert.equal((await send(asyncTrap)).status, 204);
    assert.match(logged.at(-1), /ORIGINAL_STACK_END/);
    assert.match(logged.at(-1), /ActualWasmCallback/);
    assert.equal((await send('[physics] invalid step\n[snapshot] rejected state\n[web-port menu] main menu ready')).status, 204);
    assert.match(logged.at(-1), /main menu ready/);
  } finally { server.close(); await once(server, 'close'); }
});

test('original asynchronous trap retains a bounded reserve after startup diagnostics exhaust the normal budget', async () => {
  const logged = [];
  const handle = createRuntimeDiagnostics({ identity: () => ({ id: 'b'.repeat(32) }), log: (...args) => logged.push(args.join(' ')) });
  const server = createServer((req, res) => { void handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = body => fetch(base, { method: 'POST', headers: { origin: base, 'content-type': 'text/plain' }, body });
  try {
    for (let i = 0; i < 60; ++i) assert.equal((await send('[web-port map] loading')).status, 204);
    assert.equal((await send('[web-port map] excess')).status, 429);
    assert.equal((await send('[BFG Worker Async Fatal] original stack | actual_game_callback')).status, 204);
    assert.match(logged.at(-1), /actual_game_callback/);
    for (let i = 1; i < 8; ++i) assert.equal((await send('[BFG Engine Error] fatal')).status, 204);
    assert.equal((await send('[BFG Engine Error] excess fatal')).status, 429);
  } finally { server.close(); await once(server, 'close'); }
});
