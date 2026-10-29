const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const renderPath = path.join(root, 'engine/chocolate-doom3-bfg/neo/swf/SWF_Render.cpp');
const source = fs.readFileSync(renderPath, 'utf8');
const marker = 'const bool browserProgressLabel =';
const start = source.indexOf(marker);
assert.notEqual(start, -1, 'RenderEditText identifies the browser-owned progress label');
const end = source.indexOf('if (idStr::Icmp(filename.c_str()', start);
assert.notEqual(end, -1, 'text selection branch ends before the loading-movie post-processing');
const cppBranch = source.slice(start, end);
assert.match(cppBranch,
  /if \(browserProgressLabel\)\s*\{\s*text = idLocalization::GetString\(textInstance->text\);\s*\} else\s*#endif\s*if \(textInstance->variable\.IsEmpty\(\)\)/,
  'progress label takes its native-owned text before ordinary bindings and animation modes');

// Translate only the C++ syntax used by this extracted branch so the actual
// source selection logic can be exercised with small SWF fakes.
const executableBranch = cppBranch
  .replace(/^\s*#(?:ifdef|endif).*$/gm, '')
  .replace(/\bconst bool\b/g, 'const')
  .replace(/idSWFScriptVar\s+var\s*=\s*globals->Get\(/g, 'const swfVar = globals.Get(')
  .replaceAll('var.IsUndefined()', 'swfVar.IsUndefined()')
  .replaceAll('var.ToString()', 'swfVar.ToString()')
  .replaceAll('->', '.')
  .replaceAll('idLocalization::', 'idLocalization.')
  .replaceAll('SWF_TEXT_RENDER_PARAGRAPH', '"paragraph"')
  .replaceAll('SWF_TEXT_RENDER_RANDOM_APPEAR_CAPS', '"random-caps"')
  .replaceAll('SWF_TEXT_RENDER_RANDOM_APPEAR', '"random"');

const selectText = new Function(
  'GetRootObject', 'textInstance', 'globals', 'idLocalization', 'Sys_Milliseconds',
  `let text = '';\n${executableBranch}\nreturn { text, browserProgressLabel };`
);

function makeTextInstance({ text, variable = '', renderMode = 'normal', trigger = false }) {
  const calls = { paragraphStart: 0, paragraphGet: 0, randomStart: 0, randomGet: 0 };
  return {
    text,
    variable: { IsEmpty: () => variable.length === 0, value: variable },
    renderMode,
    NeedsGenerateRandomText: () => trigger,
    StartParagraphText() { calls.paragraphStart++; },
    GetParagraphText() { calls.paragraphGet++; return ' '; },
    StartRandomText() { calls.randomStart++; },
    GetRandomText() { calls.randomGet++; return ' '; },
    calls,
  };
}

function runSelection({ label, instance, percent = 48, values = {} }) {
  const rootObject = {
    Get: name => name === '_browserLoadingPercent'
      ? { IsNumeric: () => typeof percent === 'number', ToInteger: () => percent }
      : { IsNumeric: () => false },
    GetNestedText: name => name === 'txtRegLoad' ? label : null,
  };
  const globals = {
    Get: name => {
      const key = typeof name === 'object' ? name.value : name;
      return Object.prototype.hasOwnProperty.call(values, key)
        ? { IsUndefined: () => false, ToString: () => values[key] }
        : { IsUndefined: () => true, ToString: () => '' };
    },
  };
  return selectText(() => rootObject, instance, globals,
    { GetString: value => String(value) }, () => 1000);
}

const label = makeTextInstance({
  text: 'LOADING 48%', variable: '', renderMode: 'paragraph', trigger: true,
});
const loadingResult = runSelection({ label, instance: label });
assert.equal(loadingResult.browserProgressLabel, true);
assert.equal(loadingResult.text, 'LOADING 48%',
  'the browser progress string bypasses empty-variable paragraph animation');
assert.deepEqual(label.calls, { paragraphStart: 0, paragraphGet: 0, randomStart: 0, randomGet: 0 },
  'the native progress label does not start or advance SWF text animation');

const staleBindingLabel = makeTextInstance({
  text: 'LOADING 73%', variable: 'status', renderMode: 'random', trigger: true,
});
const staleBindingResult = runSelection({ label: staleBindingLabel, instance: staleBindingLabel, percent: 73,
  values: { status: 'stale SWF value' } });
assert.equal(staleBindingResult.text, 'LOADING 73%',
  'the native progress label remains C++-owned if the SWF carries a variable binding');
assert.deepEqual(staleBindingLabel.calls, { paragraphStart: 0, paragraphGet: 0, randomStart: 0, randomGet: 0 });

const ordinaryBinding = makeTextInstance({
  text: 'fallback', variable: 'objective', renderMode: 'paragraph', trigger: true,
});
const ordinaryResult = runSelection({
  label: makeTextInstance({ text: 'LOADING 48%' }),
  instance: ordinaryBinding,
  values: { objective: 'Find the tram station' },
});
assert.equal(ordinaryResult.browserProgressLabel, false);
assert.equal(ordinaryResult.text, 'Find the tram station',
  'ordinary SWF variable bindings remain unchanged in a loading movie');
assert.equal(ordinaryBinding.calls.paragraphGet, 0,
  'ordinary bound text retains the existing variable-binding precedence');

const ordinaryAnimated = makeTextInstance({
  text: 'typing text', variable: '', renderMode: 'random', trigger: true,
});
const animatedResult = runSelection({
  label: makeTextInstance({ text: 'LOADING 48%' }),
  instance: ordinaryAnimated,
});
assert.equal(animatedResult.text, ' ',
  'ordinary unbound SWF text keeps its original random-animation output');
assert.equal(ordinaryAnimated.calls.randomStart, 1);
assert.equal(ordinaryAnimated.calls.randomGet, 1);

console.log('Loading label ownership and SWF text compatibility checks passed.');
