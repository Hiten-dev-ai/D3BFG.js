"""Compile the actual co-op campaign Back branch with a recording menu bridge."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
menus = root / 'engine/chocolate-doom3-bfg/neo/d3xp/menus'
source = (menus / 'MenuScreen_Shell_Singleplayer.cpp').read_text()
start = source.index('case WIDGET_ACTION_GO_BACK: {')
opening = source.index('{', start)
depth, end = 1, opening + 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
branch = source[opening:end]
mp = (menus / 'MenuScreen_Shell_WebMultiplayer.cpp').read_text()
assert '516, 40, 264, 148, previewMaterial' in mp
assert 'pageFadePhase = 1;' not in mp and 'pageFadePhase = 2;' not in mp
assert 'BrowserBridge_SubpageTransition(GetSprite(), menuData, "_webMultiplayerPage", page)' in mp
assert 'Scanning rooms...' in mp and 'BrowserBridge_GetNumber("mpScanning")' in mp
fixture = r'''
#include <cassert>
#include <string>
#include <vector>
enum { SHELL_AREA_ROOT, SHELL_AREA_MODE_SELECT, MENU_TRANSITION_SIMPLE };
int picker=1;
std::vector<std::string> actions;
int BrowserBridge_GetNumber(const char*) { return picker; }
void BrowserBridge_Action(const char* action) { actions.push_back(action); }
struct Menu { int screen=-1; void SetNextScreen(int next,int) { screen=next; } } menu, *menuData=&menu;
bool back() ''' + branch + r'''
int main() {
    assert(back() && menu.screen==SHELL_AREA_MODE_SELECT);
    assert(actions.size()==1 && actions[0]=="mpCloseCoopCampaignPicker");
    picker=0; assert(back() && menu.screen==SHELL_AREA_ROOT);
    assert(actions.size()==1);
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('C++ compiler required')
with tempfile.TemporaryDirectory(prefix='doom-mp-back-') as folder:
    cpp, exe = Path(folder) / 'check.cpp', Path(folder) / 'check.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Campaign Back returns to multiplayer without leaving the room; normal campaign Back unchanged. Native-only subpage transition and scanning guards pass; pixels unverified.')
