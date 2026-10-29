"""Exercise native event dispatch and deferred custom-menu rebuild boundaries."""
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

header = (menus / 'MenuScreen.h').read_text(encoding='utf-8')
mp = (menus / 'MenuScreen_Shell_WebMultiplayer.cpp').read_text(encoding='utf-8')
profile = (menus / 'MenuScreen_Shell_WebSettings.cpp').read_text(encoding='utf-8')
handler = (menus / 'MenuHandler_Shell.cpp').read_text(encoding='utf-8')
bridge = (menus / 'MenuScreen_Shell_BrowserBridge.h').read_text(encoding='utf-8')
subpage_transition = block(bridge, 'static void BrowserBridge_SubpageTransition(')
event = block((menus / 'MenuWidget.cpp').read_text(encoding='utf-8'), 'bool idMenuWidget::ExecuteEvent(')
request_mp = block(header, 'void BuildPage()')
request_profile = block(header, 'void BuildBrowserRows()')
flush_mp = block(mp, 'if (pageDirty) {')
flush_profile = block(profile, 'if (page == PAGE_BROWSER && browserRowsDirty) {')
poll = block(handler, 'if (activeScreen == nextScreen && (activeScreen == SHELL_AREA_BROWSER_SETTINGS || activeScreen == SHELL_AREA_MODE_SELECT)')
revision_refresh = block(handler, 'if ((browserRevision[0] != lastBrowserDisplay')
pending_coop = block(mp, 'if (pendingCoopSaveCommand && inRoom && BrowserBridge_GetNumber("mpIsHost")')
start_coop = block(mp, 'if (autoStartCoop && inRoom && coopSaveState == 2')
assert 'SHELL_AREA_BROWSER_SETTINGS' not in revision_refresh and 'SHELL_AREA_MODE_SELECT' not in revision_refresh
assert mp.count('RebuildPage();') == 1, 'destructive multiplayer rebuild has one update-phase caller'
assert profile.count('RebuildBrowserRows();') == 1, 'destructive profile rebuild has one update-phase caller'
fixture = r'''
#include <cassert>
#include <cstdio>
#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
constexpr int TAG_IDLIB_LIST_MENU = 0;
struct idWidgetEvent { int type = 0; };
struct idWidgetAction {};
template<typename T, int Tag> struct idList : std::vector<T> {
    bool* alive = nullptr;
    int Num() const { if (!*alive) throw std::runtime_error("event action list belongs to a retired widget"); return static_cast<int>(this->size()); }
};
struct idMenuWidget {
    bool alive = true;
    idList<idWidgetAction, TAG_IDLIB_LIST_MENU> actions;
    std::function<void()> action;
    idMenuWidget() { actions.alive = &alive; actions.push_back({}); }
    auto GetEventActions(int) { return &actions; }
    void HandleAction(idWidgetAction&, const idWidgetEvent&, idMenuWidget*) { action(); }
    void SendEventToObservers(const idWidgetEvent&) { if (!alive) throw std::runtime_error("observer dispatch used a retired widget"); }
    bool ExecuteEvent(const idWidgetEvent&);
};
''' + event + r'''
constexpr int GUI_SOUND_BUILD_ON = 1;
int fakeNow=1000;
int Sys_Milliseconds() { return fakeNow; }
struct MenuData { int stops = 0, sounds = 0; void ClearWidgetActionRepeater() { ++stops; } void PlaySound(int) { ++sounds; } };
using idMenuHandler = MenuData;
struct idSWFScriptVar { bool missing; int value; bool IsUndefined() const { return missing; } int ToInteger() const { return value; } };
struct idSWFSpriteInstance;
struct idSWFScriptObject {
    idSWFSpriteInstance* GetNestedSprite(const char*, const char*);
    std::map<std::string,int> values;
    idSWFScriptVar Get(const char* key) { auto it=values.find(key); return {it==values.end(), it==values.end()?0:it->second}; }
    void Set(const char* key,int value) { values[key]=value; }
};
struct idSWFSpriteInstance {
    idSWFScriptObject state; int frames=0; bool visible=false;
    idSWFScriptObject* GetScriptObject() { return &state; }
    void SetVisible(bool value) { visible=value; }
    void PlayFrame(const char* name) { assert(std::string(name)=="rollOn"); ++frames; }
    bool FrameExists(const char*) { return true; }
};
idSWFSpriteInstance listSprite;
idSWFSpriteInstance* idSWFScriptObject::GetNestedSprite(const char*, const char*) { return &listSprite; }
''' + subpage_transition + r'''
struct Screen {
    bool pageDirty = false, browserRowsDirty = false;
    enum { PAGE_BROWSER }; int page = PAGE_BROWSER;
    int renderedPage=-1, pageFadePhase=0, pageFadeStarted=0;
    MenuData data; MenuData* menuData = &data;
    idMenuWidget* active;
    int rebuilds = 0;
    bool profile = false;
    ''' + request_mp + '\n' + request_profile + r'''
    void RebuildPage() { active->alive = false; renderedPage=page; ++rebuilds; }
    void RebuildBrowserRows() { active->alive = false; ++rebuilds; }
    void UpdateMultiplayer() { ''' + flush_mp + r''' }
    void UpdateProfile() { ''' + flush_profile + r''' }
    void Update() { if (profile) UpdateProfile(); else UpdateMultiplayer(); }
};
enum { SHELL_AREA_BROWSER_SETTINGS, SHELL_AREA_MODE_SELECT, SHELL_AREA_ROOT };
struct Shell {
    int activeScreen, nextScreen;
    Screen* menuScreens[3];
    void Update() { ''' + poll + r''' }
};
constexpr int MP_CMD_CONTINUE = 1, MP_CMD_LOAD_SAVE = 2, SHELL_AREA_LOAD = 4, MENU_TRANSITION_SIMPLE = 0;
int starts = 0, prepared = 0, picker = 0;
bool mpStarted = false;
int BrowserBridge_GetNumber(const char* key) { return std::string(key) == "mpStarted" ? mpStarted : 1; }
void BrowserBridge_Action(const char* key) { if (std::string(key) == "mpStart") { ++starts; mpStarted = true; } else ++picker; }
bool StartNewestBrowserCoopSaveLoad() { ++prepared; return true; }
struct FakeSession { enum { PARTY_LOBBY = 1 }; int state = 0; int GetState() { return state; } };
using idSession = FakeSession;
struct CoopMenu { int next = 0; void SetNextScreen(int n, int) { next = n; } };
struct Coop {
    bool inRoom = true, saveBusy = false, autoStartCoop = true, dirty = false;
    int pendingCoopSaveCommand = MP_CMD_CONTINUE, coopSaveState = 0;
    FakeSession* session; CoopMenu* menuData;
    std::string localError;
    void BuildPage() { dirty = true; }
    void Update() { ''' + pending_coop + '\n' + start_coop + r''' }
};
int main() {
    idWidgetEvent event;
    for (bool profile : {false, true}) {
        idMenuWidget child; Screen screen; screen.active = &child;
        screen.profile = profile;
        const int area = profile ? SHELL_AREA_BROWSER_SETTINGS : SHELL_AREA_MODE_SELECT;
        Shell shell { area, area, {&screen, &screen, &screen} };
        child.action = [&] { if (profile) screen.BuildBrowserRows(); else screen.BuildPage(); };
        assert(child.ExecuteEvent(event));
        assert(child.alive && screen.rebuilds == 0);
        shell.nextScreen = SHELL_AREA_ROOT;
        shell.Update(); // Do not rebuild the page while it is leaving.
        assert(child.alive && screen.rebuilds == 0);
        shell.nextScreen = area;
        shell.Update(); // No browser revision or network publication is needed.
        assert(!child.alive && screen.rebuilds == 1 && screen.data.stops == 1);
        shell.Update();
        assert(screen.rebuilds == 1);
    }
    idMenuWidget unsafe; Screen old; old.active = &unsafe;
    idMenuWidget fadingChild; Screen fading; fading.active=&fadingChild;
    fading.renderedPage=1; fading.page=2; fading.BuildPage();
    fading.UpdateMultiplayer(); assert(!fadingChild.alive && fading.rebuilds==1 && fading.pageFadePhase==0);
    fakeNow+=99; fading.UpdateMultiplayer(); assert(fading.rebuilds==1);
    unsafe.action = [&] { old.RebuildPage(); };
    bool detected = false;
    try { unsafe.ExecuteEvent(event); } catch (const std::runtime_error&) { detected = true; }
    assert(detected); // Negative control: retiring the caller inside its action is unsafe.
    FakeSession session; CoopMenu menu; Coop coop; coop.session = &session; coop.menuData = &menu;
    coop.Update(); assert(prepared == 0 && starts == 0);
    session.state = idSession::PARTY_LOBBY;
    coop.saveBusy = true; coop.Update(); assert(prepared == 0);
    coop.saveBusy = false; coop.Update(); assert(prepared == 1 && starts == 0);
    coop.Update(); assert(prepared == 1);
    coop.coopSaveState = 2; coop.Update(); assert(starts == 1);
    coop.Update(); assert(starts == 1);
    Coop load; load.session = &session; load.menuData = &menu;
    load.pendingCoopSaveCommand = MP_CMD_LOAD_SAVE;
    load.Update(); assert(picker == 1 && menu.next == SHELL_AREA_LOAD);
    idSWFSpriteInstance sprite; MenuData sound;
    for (const char* key : {"_webProfilePage", "_webMultiplayerPage"}) {
        int before = listSprite.frames;
        BrowserBridge_SubpageTransition(&sprite, &sound, key, 0, true);
        BrowserBridge_SubpageTransition(&sprite, &sound, key, 0);
        assert(listSprite.frames == before && sprite.frames == 0);
        BrowserBridge_SubpageTransition(&sprite, &sound, key, 1);
        assert(listSprite.frames == before+1 && sprite.visible && sprite.frames == 0);
        BrowserBridge_SubpageTransition(&sprite, &sound, key, 1);
        assert(listSprite.frames == before+1);
        BrowserBridge_SubpageTransition(&sprite, &sound, key, 0);
        assert(listSprite.frames == before+2 && sprite.frames == 0);
    }
    assert(sound.sounds == 4);
    std::puts("Menu lifetime: event iterator survives; shell polls idle custom pages and rebuilds only after dispatch, clearing repeaters.");
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('A C++ compiler is required for this focused check.')
with tempfile.TemporaryDirectory(prefix='doom-menu-lifetime-') as folder:
    temp = Path(folder)
    cpp, exe = temp / 'check.cpp', temp / 'check.exe'
    cpp.write_text(fixture, encoding='utf-8')
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
