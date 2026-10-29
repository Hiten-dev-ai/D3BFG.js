"""Source-derived checks for snapshot spawn metadata and post-save visibility.

Uses fake transport/storage, not two engines or visual acceptance.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
neo = root / 'engine/chocolate-doom3-bfg/neo'
network = (neo / 'd3xp/Game_network.cpp').read_text(encoding='utf-8')
write_start = network.index('        if (gameType == GAME_COOP) {', network.index('msg.WriteBits(ent->GetPredictedKey(), 32);'))
write = network[write_start:network.index('#endif', write_start)]
read_start = network.index('        idDict replicatedSpawnArgs;')
read = network[read_start:network.index('\n        idTypeInfo*', read_start)]
assert 'idDict args = replicatedSpawnArgs;' in network
assert network.index('idDict args = replicatedSpawnArgs;') < network.index('SpawnEntityDef(args, &ent)')
assert 'ASYNC_PROTOCOL_MAJOR 5' in (neo / 'framework/Licensee.h').read_text()

dialog = (neo / 'framework/Common_dialog.cpp').read_text(encoding='utf-8')
start = dialog.index('void idCommonDialog::ShowSaveIndicator(')
show = dialog[start:dialog.index('#endif', start)] + '\n#endif\n}\n'
player = (neo / 'd3xp/Player.cpp').read_text(encoding='utf-8')
killed = player[player.index('void idPlayer::Killed('):]
condition = killed[killed.index('if (') + 4:killed.index(') {')]
capture = condition.replace('common->IsServer()', 'server').replace('gameLocal.gameType', 'gameType')
assert 'if (gameLocal.gameType != GAME_COOP) DropWeapon(true);' in killed
fixture = r'''
#include <cassert>
#include <map>
#include <string>
#include <vector>
#include <cstdio>
using idDict = std::map<std::string, std::string>;
struct idMoveable { static const int Type = 1; };
struct idMoveableItem { static const int Type = 2; };
struct idCameraAnim { static const int Type = 4; };
struct idLocationEntity { static const int Type = 5; };
struct idLight { static const int Type = 6; };
struct idStaticEntity { static const int Type = 7; };
struct Entity { int type; idDict spawnArgs; bool IsType(int t) const { return t == type; } };
enum { GAME_COOP = 5, GAME_DM = 0 };
struct Message {
  int flag = 0; idDict payload;
  void WriteBits(int v, int) { flag = v; }
  int ReadBits(int) { return flag; }
  void WriteDeltaDict(const idDict& d, void*) { payload = d; }
  void ReadDeltaDict(idDict& d, void*) { d = payload; }
};
idDict roundtrip(int gameType, Entity* ent) {
  Message msg;
''' + write + read + r'''
  return replicatedSpawnArgs;
}
int now = 1000, webAutosaveVisibleUntil = 0;
int Sys_Milliseconds() { return now; }
struct idSWFSpriteInstance { int entrances = 0; void PlayFrame(const char*) { ++entrances; } void SetYPos(float) {} };
struct Root { idSWFSpriteInstance sprite; idSWFSpriteInstance* GetNestedSprite(const char*) { return &sprite; } idSWFSpriteInstance* GetSprite() { return &sprite; } };
struct SWF { bool active = false; Root root; Root& GetRootObject() { return root; } void Activate(bool v) { active = v; } };
struct idCommonDialog {
  bool dialogShowingSaveIndicatorRequested = false, browserSavingAutomatically = false;
  SWF save, animation; SWF* saveIndicator = &save; SWF* browserAutosaveIndicator = &animation;
  void ShowSaveIndicator(bool show, bool autosave = false);
};
''' + show + '\nbool capturesInventory(bool server, int gameType, bool AI_DEAD) { return ' + capture + '; }\n' + r'''
int main() {
  assert(capturesInventory(true, GAME_COOP, false));
  assert(!capturesInventory(true, GAME_COOP, true));
  assert(!capturesInventory(false, GAME_COOP, false));
  assert(!capturesInventory(true, GAME_DM, false));
  Entity prop{1, {{"model", "models/props/box.lwo"}, {"clipmodel", "models/props/box.cm"}, {"mass", "40"}, {"origin", "1 2 3"}}};
  assert(roundtrip(GAME_COOP, &prop) == prop.spawnArgs);
  prop.type = 2;
  assert(roundtrip(GAME_COOP, &prop) == prop.spawnArgs);
  prop.type = 4;
  prop.spawnArgs = {{"anim", "intro"}, {"anim intro", "cameras/mars_city_intro"}};
  assert(roundtrip(GAME_COOP, &prop) == prop.spawnArgs);
  assert(roundtrip(GAME_DM, &prop).empty());
  prop.type = 5;
  prop.spawnArgs = {{"location", "Mars City Hangar"}, {"origin", "1 2 3"}};
  assert(roundtrip(GAME_COOP, &prop) == prop.spawnArgs);
  prop.type = 3;
  assert(roundtrip(GAME_COOP, &prop).empty());
  prop.type = 6;
  prop.spawnArgs = {{"texture", "lights/hell"}, {"light_target", "0 0 -64"}, {"light_right", "64 0 0"}, {"light_up", "0 64 0"}, {"origin", "1 2 3"}};
  assert(roundtrip(GAME_COOP, &prop) == prop.spawnArgs);
  prop.type = 7;
  prop.spawnArgs = {{"model", "models/props/panel.lwo"}, {"shaderParm3", "1"}};
  assert(roundtrip(GAME_COOP, &prop) == prop.spawnArgs);
  idCommonDialog dialog;
  dialog.ShowSaveIndicator(true, true);
  now = 6000; dialog.ShowSaveIndicator(false);
  assert(dialog.save.active && dialog.browserSavingAutomatically);
  now = 6100; dialog.ShowSaveIndicator(false);
  assert(dialog.save.active);
  now = 7201; dialog.ShowSaveIndicator(false);
  assert(!dialog.save.active && !dialog.browserSavingAutomatically);
  assert(dialog.animation.root.sprite.entrances == 1);
  dialog.ShowSaveIndicator(true, true);
  assert(dialog.animation.root.sprite.entrances == 2);
  std::puts("Co-op moveable spawn metadata and autosave completion lifetime passed (fake transport/storage).");
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('C++ compiler required')
with tempfile.TemporaryDirectory(prefix='doom-coop-regression-') as folder:
    path = Path(folder)
    source = path / 'check.cpp'
    source.write_text(fixture, encoding='utf-8')
    executable = path / 'check.exe'
    subprocess.run([compiler, '-std=c++17', '-D__EMSCRIPTEN__', str(source), '-o', str(executable)], check=True)
    subprocess.run([str(executable)], check=True)

dynamic = (neo / 'd3xp/menus/MenuWidget_DynamicList.cpp').read_text()
assert 'child.GetState() != state || previousSprite != child.GetSprite()' in dynamic
preview = (neo / 'd3xp/menus/MenuScreen_Shell_WebMultiplayer.cpp').read_text()
assert 'DrawMaterialOnSprite(options->GetSprite()' in preview
assert '+ (visible ? 340.0f' not in preview
frame = (neo / 'framework/common_frame.cpp').read_text()
assert '(browserMPCoopFreshGame || browserMPCoopAutosavePending)' in frame
assert 'browserMPCoopAutosavePending = !mapSpawnData.savegameFile' in (neo / 'framework/Common_load.cpp').read_text()
print('Menu animation refresh, SWF-relative preview and host map-entry autosave source guards passed.')
