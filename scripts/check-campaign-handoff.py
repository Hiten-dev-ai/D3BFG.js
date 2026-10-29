"""Compile actual intro handoff, fresh co-op intent, and native menu cycles."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
menus = root / 'engine/chocolate-doom3-bfg/neo/d3xp/menus'


def block(source, marker):
    start = source.index(marker)
    begin = source.index('{', start)
    depth, end = 1, begin + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


shell = (menus / 'MenuHandler_Shell.cpp').read_text()
load = (root / 'engine/chocolate-doom3-bfg/neo/framework/Common_load.cpp').read_text()
mp = (menus / 'MenuScreen_Shell_WebMultiplayer.cpp').read_text()
dialog = (root / 'engine/chocolate-doom3-bfg/neo/framework/Common_dialog.cpp').read_text()
indicator = block(dialog, 'void idCommonDialog::ShowSaveIndicator(')
browser_indicator = indicator.split('#ifdef __EMSCRIPTEN__', 1)[1].split('#endif', 1)[0]
assert 'AddDialog(' not in browser_indicator and 'saveIndicator->Activate(show)' in browser_indicator
assert 'return;' in browser_indicator
assert 'DrawSmallStringExt(296, 82, "Saving"' not in dialog
assert 'browserSavingAutomatically && browserSaveFont && browserAutosaveIndicator' in dialog
assert 'RenderNamedSprite(renderSystem, "pacifier"' in dialog
start = block(shell, 'void idMenuHandler_Shell::StartGame(')
fresh = block(block(load, 'void idCommonLocal::StartNewGame('), 'if (browserMPTrackedRoom && browserMPCoopRoom && browserMPHost &&')
assert 'stageMapResources' not in start and 'webIntroStageStatus' not in shell
cycles = '\n'.join(block(mp, signature) for signature in (
    'void idMenuScreen_Shell_WebMultiplayer::AdjustField(',
    'void idMenuScreen_Shell_WebMultiplayer::CycleMode(',
    'void idMenuScreen_Shell_WebMultiplayer::CycleMap(',
))
fixture = r'''
#include <cassert>
#include <cstdarg>
#include <cstdio>
#include <string>
#include <vector>
#define __EMSCRIPTEN__ 1
#define BIT(i) (1u << (i))
using uint32 = unsigned int;
template<class T> int Min(T a,T b) { return a<b?a:b; }
template<class T> struct idList : std::vector<T> { using std::vector<T>::vector; int Num() const { return (int)this->size(); } };
using idStrList = idList<std::string>;
struct mpMap_t { unsigned supportedModes; };
struct Common { idStrList modes {"dm","ctf"}; idList<mpMap_t> maps;
 const auto& GetModeList() { return modes; } const auto& GetMapList() { return maps; } } instance;
Common* common = &instance;
enum { MP_CMD_MODE, MP_CMD_MAP, MP_CMD_PLAYERS, MP_CMD_PRIVACY, MP_CMD_LIVES, MP_CMD_FRIENDLY_FIRE };
struct idMenuScreen_Shell_WebMultiplayer {
 int modeIndex=0, mapIndex=0, maxPlayers=8, coopLives=3; bool isPrivate=false, coopFlow=false, friendlyFire=false;
 void AdjustField(int,int); void CycleMode(int); void CycleMap(int);
};
''' + cycles + r'''
std::string va(const char* format, ...) { char text[256]; va_list args; va_start(args, format); vsnprintf(text,sizeof(text),format,args); va_end(args); return text; }
struct Commands { std::vector<std::string> values; void AppendCommandText(std::string text) { values.push_back(text); } } commands;
Commands* cmdSystem=&commands;
int picker=0, closes=0, pacifiers=0; std::string lastAction;
int BrowserBridge_GetNumber(const char*) { return picker; }
void BrowserBridge_Action(const char* action) { lastAction=action; ++closes; picker=0; }
constexpr int SHELL_AREA_MODE_SELECT=1, MENU_TRANSITION_SIMPLE=0;
bool webCoopIntroHandoff=false;
bool webIntroDispatching=false;
int webIntroPendingGame=-1, webIntroFadeStarted=0;
int Sys_Milliseconds() { return 1000; }
struct Intro { bool active=true, paused=false, soundStopped=false; bool IsActive() { return active; }
 void Pause() { paused=true; } void StopSound() { soundStopped=true; } void Activate(bool value) { active=value; } } intro;
struct idMenuHandler_Shell { int next=0; bool showingIntro=false; Intro* introGui=&intro;
 void StartGame(int); void SetNextScreen(int value,int) { next=value; } void ShowPacifier(const char*) { ++pacifiers; } };
''' + start + r'''
struct idSession { enum { PARTY_LOBBY=1 }; int state=PARTY_LOBBY; bool host=true;
 int GetState() { return state; } idSession& GetPartyLobbyBase() { return *this; } bool IsHost() { return host; } } session;
int ready=0; std::string preparedMap;
void SetBrowserCoopSaveState(int state,const char* map) { ready=state; preparedMap=map; }
struct Fresh {
 bool browserMPTrackedRoom=true, browserMPCoopRoom=true, browserMPHost=true;
 bool browserMPCoopFreshGame=false, browserMPCoopDevLevel=false;
 std::string browserMPCoopRestoreMap; idSession* session; int original=0;
 void CancelBrowserCoopSaveLoad() { browserMPCoopFreshGame=false; browserMPCoopDevLevel=false; }
 void Select(const std::string& mapNameClean,bool devmap) { ''' + fresh + r''' ++original; }
};
int main() {
 idMenuHandler_Shell shell;
 for(int index=0;index<3;++index) shell.StartGame(index);
 assert(commands.values.size()==3);
 assert(commands.values[0]=="map game/mars_city1 0\n");
 assert(commands.values[1]=="map game/erebus1 1\n");
 assert(commands.values[2]=="map game/le_enpro1 2\n");
 shell.StartGame(-1); shell.StartGame(3); assert(commands.values.size()==3);
  picker=1; shell.showingIntro=true; shell.StartGame(0);
  assert(webIntroPendingGame==0 && webIntroFadeStarted==1000 && closes==0);
   assert(!intro.paused && intro.soundStopped && commands.values.size()==3);
  webIntroDispatching=true; shell.StartGame(0); webIntroDispatching=false; webIntroPendingGame=-1;
   assert(closes==1 && shell.next==0 && pacifiers==1);
   assert(lastAction=="mpBeginCoopConnect");
   assert(!webCoopIntroHandoff && !intro.active && !intro.paused && intro.soundStopped && !shell.showingIntro);
 Fresh fresh; fresh.session=&session;
 fresh.Select("game/mars_city1",false); assert(ready==2 && fresh.browserMPCoopFreshGame && !fresh.browserMPCoopDevLevel && fresh.original==0);
 fresh.Select("game/alphalabs1",true); assert(fresh.browserMPCoopDevLevel && preparedMap=="game/alphalabs1");
 session.host=false; Fresh guest; guest.session=&session; guest.Select("game/alphalabs1",true); assert(!guest.browserMPCoopFreshGame && guest.original==1);
 instance.maps.push_back({1}); instance.maps.push_back({2}); instance.maps.push_back({3});
 idMenuScreen_Shell_WebMultiplayer menu;
 menu.AdjustField(MP_CMD_MODE,1); assert(menu.modeIndex==1 && menu.mapIndex==1);
 menu.AdjustField(MP_CMD_MAP,1); assert(menu.mapIndex==2);
 menu.AdjustField(MP_CMD_MAP,1); assert(menu.mapIndex==1);
 menu.AdjustField(MP_CMD_MAP,-1); assert(menu.mapIndex==2);
  menu.AdjustField(MP_CMD_PLAYERS,1); assert(menu.maxPlayers==2);
  menu.AdjustField(MP_CMD_PLAYERS,-1); assert(menu.maxPlayers==8);
  menu.AdjustField(MP_CMD_LIVES,1); assert(menu.coopLives==4);
  menu.AdjustField(MP_CMD_LIVES,-1); assert(menu.coopLives==3);
  assert(!menu.friendlyFire);
  menu.AdjustField(MP_CMD_FRIENDLY_FIRE,1); assert(menu.friendlyFire);
  menu.AdjustField(MP_CMD_FRIENDLY_FIRE,-1); assert(!menu.friendlyFire);
 menu.AdjustField(MP_CMD_PRIVACY,-1); assert(menu.isPrivate);
 menu.AdjustField(MP_CMD_PRIVACY,1); assert(!menu.isPrivate);
  puts("Campaign handoff/cycles: native map commands run without a download gate, co-op fresh intent requires its party host, and cycle directions/wrap/map compatibility/life values passed.");
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('A C++ compiler is required.')
with tempfile.TemporaryDirectory(prefix='doom-campaign-handoff-') as folder:
    cpp, exe = Path(folder) / 'check.cpp', Path(folder) / 'check.exe'
    cpp.write_text(fixture, encoding='utf-8')
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
