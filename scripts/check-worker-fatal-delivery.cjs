const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const patch = fs.readFileSync('scripts/apply-emsdk-patches.ps1', 'utf8');
const source = patch.split("$directTrace = @'\n")[1]?.split("\n'@")[0];
assert.ok(source, 'worker exception delivery source exists');
const sent = [], output = [], Module = {};
const context = vm.createContext({ Module, ex: { stack: 'RuntimeError: original\n  at game::Think' },
  fetch(url, options) { sent.push({ url, ...options }); return Promise.resolve(); },
  err(text) { output.push(text); throw new Error('proxy queue already dead'); },
});
assert.throws(() => vm.runInContext(source, context), /proxy queue already dead/);
assert.equal(sent.length, 1);
assert.equal(sent[0].url, '/__local_game/trace');
assert.equal(sent[0].credentials, 'same-origin');
assert.equal(sent[0].keepalive, true);
assert.match(sent[0].body, /RuntimeError: original \|   at game::Think/);
assert.throws(() => vm.runInContext(source, context), /proxy queue already dead/);
assert.equal(sent.length, 1, 'one direct fatal per worker');
context.ex = 'unwind';
vm.runInContext(source, context);
assert.equal(output.length, 2, 'normal Asyncify unwind is not an error');
console.log('Original worker trap is sent directly before a failing proxy logger; duplicate delivery and normal unwind are suppressed.');
const asyncSource = patch.split("$asyncWorkerFatal = @'\n")[1]?.split("\n'@")[0];
assert.ok(asyncSource);
let listener;
const asyncSent = [];
vm.runInNewContext(asyncSource, {
  Module: { webGuestThinkEntity: 1788, webGuestThinkType: 42 },
  self: { addEventListener(name, callback) { assert.equal(name, 'error'); listener = callback; } },
  fetch(url, options) { asyncSent.push({ url, ...options }); return Promise.resolve(); },
});
listener({ error: { stack: 'RuntimeError: null function\n at ActualGuestThink' } });
listener({ message: 'secondary proxy failure' });
assert.equal(asyncSent.length, 1);
assert.match(asyncSent[0].body, /ActualGuestThink.*guestEntity=1788 type=42/);
assert.equal(asyncSent[0].credentials, 'same-origin');
console.log('Async worker traps preserve their original stack plus last guest entity without using the dying proxy queue.');
