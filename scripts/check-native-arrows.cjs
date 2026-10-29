// Keep slider arrows on the upstream Chocolate Doom path, not accumulating transforms.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const repo = 'engine/chocolate-doom3-bfg';
const file = 'neo/d3xp/menus/MenuWidget_Button.cpp';
const current = fs.readFileSync(`${repo}/${file}`, 'utf8');
const original = execFileSync('git', ['-C', repo, 'show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
function arrows(source) {
  const start = source.indexOf('idSWFScriptObject* const btnLess =', source.indexOf('void idMenuWidget_ControlButton::Update()'));
  const end = source.indexOf('// events', start);
  assert(start > 0 && end > start);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}
assert.equal(arrows(current), arrows(original), 'native arrow layout/visibility/events must match upstream, without additive repositioning or alpha overrides');
console.log('Slider arrow layout, visibility and input handlers match upstream Chocolate Doom native code.');
