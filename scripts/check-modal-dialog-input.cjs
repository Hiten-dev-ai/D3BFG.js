const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const commonPath = path.join(root, 'engine/chocolate-doom3-bfg/neo/framework/Common.cpp');
const dialogPath = path.join(root, 'engine/chocolate-doom3-bfg/neo/framework/Common_dialog.cpp');
const commonSource = fs.readFileSync(commonPath, 'utf8');
const dialogSource = fs.readFileSync(dialogPath, 'utf8');

function extractBracedBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing source marker: ${marker}`);
  const open = source.indexOf('{', markerIndex);
  assert.notEqual(open, -1, `missing block after: ${marker}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(markerIndex, i + 1);
  }
  assert.fail(`unterminated block after: ${marker}`);
}

const processStart = commonSource.indexOf('bool idCommonLocal::ProcessEvent(const sysEvent_t* event)');
assert.notEqual(processStart, -1, 'ProcessEvent implementation exists');
const processBody = extractBracedBlock(commonSource.slice(processStart), 'bool idCommonLocal::ProcessEvent');
const modalBlock = extractBracedBlock(processBody, 'if (Dialog().IsDialogActive())');
const cinematicIndex = processBody.indexOf('// Consume both halves of a cinematic skip key');
const shellIndex = processBody.indexOf('if (game && game->IsInGame())');
const modalIndex = processBody.indexOf('if (Dialog().IsDialogActive())');
assert.ok(modalIndex < cinematicIndex, 'modal branch precedes cinematic skip handling');
assert.ok(modalIndex < shellIndex, 'modal branch precedes Escape shell handling');
assert.match(modalBlock, /Dialog\(\)\.HandleDialogEvent\(event\);[\s\S]*?return true;/,
  'active modal consumes input even when its handler reports false');

// Execute the active-dialog block extracted from ProcessEvent against fakes.
const executableBlock = modalBlock.replaceAll('Dialog()', 'dialog').replaceAll('usercmdGen', 'usercmd')
  .replaceAll('->', '.')
  .replace(/\bconst int\b/g, 'const');
const executeModalBlock = new Function('dialog', 'event', 'SE_KEY', 'consumedCinematicSkipKeys', 'usercmd', 'INHIBIT_SESSION',
  `${executableBlock}\nreturn false;`);
const cases = [
  ['Escape down', { evType: 1, evValue: 27, evValue2: 1 }],
  ['Escape up', { evType: 1, evValue: 27, evValue2: 0 }],
  ['WASD down', { evType: 1, evValue: 87, evValue2: 1 }],
  ['WASD up', { evType: 1, evValue: 87, evValue2: 0 }],
  ['Enter down', { evType: 1, evValue: 13, evValue2: 1 }],
  ['Enter up', { evType: 1, evValue: 13, evValue2: 0 }],
];

for (const [name, event] of cases) {
  let handled = 0;
  let inhibited = 0;
  let cinematicSkip = 0;
  let shellEscape = 0;
  const dialog = {
    IsDialogActive: () => true,
    HandleDialogEvent: () => { handled++; return false; },
  };
  const usercmdGen = { InhibitUsercmd: () => { inhibited++; } };
  const consumedKeys = { FindIndex: () => -1, RemoveIndex: () => {} };
  const modalConsumed = executeModalBlock(dialog, event, 1, consumedKeys, usercmdGen, 0);
  if (!modalConsumed && event.evType === 1 && event.evValue2 && event.evValue === 27) shellEscape++;
  if (!modalConsumed && event.evType === 1 && event.evValue2 && event.evValue === 13) cinematicSkip++;
  assert.equal(modalConsumed, true, `${name} is consumed by the extracted modal branch`);
  assert.equal(handled, 1, `${name} reaches the dialog handler`);
  assert.equal(inhibited, 1, `${name} keeps usercmd generation inhibited`);
  assert.equal(shellEscape, 0, `${name} does not reach shell Escape handling`);
  assert.equal(cinematicSkip, 0, `${name} does not reach cinematic skip handling`);
}

const activationBlock = extractBracedBlock(dialogSource, 'void idCommonDialog::ActivateDialog(bool activate)');
assert.match(activationBlock, /if \(wasActive != activate\)[\s\S]*idKeyInput::ClearStates\(\);\s*Sys_EndKeyboardInputEvents\(\);/,
  'opening and closing the modal clears held key and polled usercmd state');

// The key that dismisses a dialog must stay consumed even after its callback
// deactivates the movie; otherwise Enter/Escape reaches the underlying game.
let active = true;
const closingDialog = {
  IsDialogActive: () => active,
  HandleDialogEvent: () => { active = false; return true; },
};
assert.equal(executeModalBlock(closingDialog, cases[4][1], 1,
  { FindIndex: () => -1 }, { InhibitUsercmd: () => assert.fail('closed dialog must not retain inhibition') }, 0), true);

let released = -1;
assert.equal(executeModalBlock({ IsDialogActive: () => true, HandleDialogEvent: () => false },
  cases[1][1], 1, { FindIndex: () => 2, RemoveIndex: index => { released = index; } },
  { InhibitUsercmd() {} }, 0), true);
assert.equal(released, 2, 'a modal key-up must release old cinematic-skip bookkeeping');

console.log('Modal dialog input routing checks passed.');
