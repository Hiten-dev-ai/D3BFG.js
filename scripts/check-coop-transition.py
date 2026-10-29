"""Compile actual browser co-op framework methods against small session fakes.

This checks source-level branching and call order only. It does not instantiate
the engine, SDL, relay, save-game serializer, or a second game process.
Temporary compiler output is removed on exit.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent
FRAMEWORK = ROOT / "engine/chocolate-doom3-bfg/neo/framework"


def extract_function(source: str, signature: str) -> str:
    start = source.index(signature)
    brace = source.index("{", start)
    depth = 1
    end = brace + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


def extract_block(source: str, marker: str) -> str:
    start = source.index(marker)
    brace = source.index("{", start)
    depth = 1
    end = brace + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


load_source = (FRAMEWORK / "Common_load.cpp").read_text(encoding="utf-8")
frame_source = (FRAMEWORK / "Common_frame.cpp").read_text(encoding="utf-8")
menu_source = (FRAMEWORK / "Common_menu.cpp").read_text(encoding="utf-8")
coop_host_parameters = extract_block(menu_source, "if (parms.gameMode == GAME_COOP) {")
methods = "\n".join(
    extract_function(load_source, signature)
    for signature in (
        "void idCommonLocal::CaptureBrowserCoopLevelTransitionInfo()",
        "void idCommonLocal::BeginBrowserCoopPeerLevelTransition()",
        "void idCommonLocal::ClearBrowserCoopLevelTransition()",
        "void idCommonLocal::MoveToNewMap(const char* mapName, bool devmap)",
        "bool idCommonLocal::BeginBrowserCoopSaveLoad(const char* saveName)",
        "void idCommonLocal::CancelBrowserCoopSaveLoad()",
    )
)
transition_pump = extract_block(frame_source, "if (browserMPCoopLevelTransitionActive) {")
guest_hold = extract_block(
    frame_source,
    "if (browserMPCoopLevelTransitionPending && session->GetState() == idSession::GAME_LOBBY) {",
)
load_complete = extract_block(frame_source, "if (browserCoopLevelTransition) {")
failed_save_tail = load_source[load_source.index("// If we got here then we didn't actually load the save game for some reason"):]
failed_save_cleanup = extract_block(failed_save_tail, "if (browserMPCoopRestoreRequested) {")
load_files_tail = load_source[load_source.index("void idCommonLocal::OnLoadFilesCompleted(idSaveLoadParms& parms)"):]
canceled_load_files = extract_block(load_files_tail, "if (browserMPCoopRestoreCanceled) {")

template = r'''
#include <cassert>
#include <cstdio>
#include <string>
#define __EMSCRIPTEN__ 1
static int leftRooms = 0;
#define MAIN_THREAD_EM_ASM(...) (++leftRooms)

struct idStr : std::string {
    using std::string::string;
    idStr& operator=(const char* value) { assign(value ? value : ""); return *this; }
    void Clear() { clear(); }
    int Length() const { return static_cast<int>(size()); }
    static int Icmp(const idStr& a, const char* b) { return a.compare(b); }
};
struct idDict : std::string {
    bool developerLevel = false;
    using std::string::string;
    void Clear() { clear(); }
    void Set(const char*, const char* value) { assign(value ? value : ""); }
    void Delete(const char*) { clear(); }
    void SetInt(const char*, int) {}
    bool GetBool(const char*) const { return developerLevel; }
};
struct idCVar {
    int value = 0;
    int GetInteger() const { return value; }
    void SetInteger(int next) { value = next; }
    void SetString(const char*) {}
};
static idCVar web_coop_save_state;
static void SetBrowserCoopSaveState(int state, const char* = "") { web_coop_save_state.SetInteger(state); }
static int nowMs = 0;
static int Sys_Milliseconds() { return nowMs; }
static int Max(int a, int b) { return a > b ? a : b; }
static int reportedErrors = 0;
static void WebMultiplayer_ReportNativeError() { ++reportedErrors; }
constexpr int GAME_COOP = 99;
constexpr int GAME_MODE_SINGLEPLAYER = 0;
constexpr int GAME_MAP_SINGLEPLAYER = -2;
constexpr int CVAR_SERVERINFO = 1;
constexpr int MAX_PLAYERS = 8;
constexpr int DefaultPartyFlags = 3;

struct idMatchParameters {
    int numSlots = 8, gameMode = 0, gameMap = 0;
    idStr mapName;
    idDict serverInfo;
};

class FakeCVarSystem {
public:
    void MoveCVarsToDict(int, idDict&) {}
};
static FakeCVarSystem fakeCvars;
static FakeCVarSystem* cvarSystem = &fakeCvars;

class idSession {
public:
    enum sessionState_t { IDLE, PARTY_LOBBY, GAME_LOBBY, LOADING, INGAME };
    struct Lobby {
        bool host = true;
        int users = 2;
        idMatchParameters parms;
        bool IsHost() const { return host; }
        int GetNumActiveLobbyUsers() const { return users; }
        const idMatchParameters& GetMatchParms() const { return parms; }
    } lobby, party;
    sessionState_t state = INGAME;
    int endCalls = 0, quitCalls = 0, startCalls = 0, updateCalls = 0;
    sessionState_t GetState() const { return state; }
    Lobby& GetGameLobbyBase() { return lobby; }
    Lobby& GetPartyLobbyBase() { return party; }
    void EndMatch() { ++endCalls; state = GAME_LOBBY; }
    void QuitMatchToTitle() { ++quitCalls; state = IDLE; }
    void CreatePartyLobby(const idMatchParameters&) { state = PARTY_LOBBY; }
    void CreateMatch(const idMatchParameters&) { state = GAME_LOBBY; }
    void StartMatch() { ++startCalls; state = LOADING; }
    void UpdateMatchParms(const idMatchParameters& p) { ++updateCalls; lobby.parms = p; }
};

class FakeGame {
public:
    idDict info[2] = {"host-inventory", "guest-inventory"};
    const idDict& GetPersistentPlayerInfo(int slot) { return info[slot]; }
};

class idCommonLocal {
public:
    struct MapSpawnData { void* savegameFile = nullptr; void* stringTableFile = nullptr; idDict persistentPlayerInfo; } mapSpawnData;
    bool browserMPCoopRoom = true, browserMPTrackedRoom = true, browserMPHost = true;
    bool browserMPCoopLevelTransitionActive = false;
    bool browserMPCoopLevelTransitionPending = false;
    bool browserMPCoopLevelTransitionHost = false;
    bool browserMPCoopLevelTransitionDevmap = false;
    int browserMPCoopLevelTransitionStartTime = 0;
    idStr browserMPCoopLevelTransitionMap;
    idDict browserMPCoopPersistentPlayerInfo[MAX_PLAYERS];
    bool browserMPCoopRestoreRequested = false, browserMPCoopRestoreCanceled = false;
    bool browserMPCoopFreshGame = false, browserMPCoopDevLevel = false, browserMPCoopAutosavePending = false;
    bool browserMPCoopRestoreReady = false, browserMPCoopRestoreActive = false;
    idStr browserMPCoopRestoreMap;
    bool mapSpawned = true, loadResult = true, gamePresent = true, flowFailed = false;
    bool browserMPFlowFailed = false;
    int leaveCalls = 0;
    idSession* session = nullptr;
    FakeGame* game = nullptr;
    bool IsBrowserCoopLevelTransition() const { return browserMPCoopLevelTransitionActive; }
    void CaptureBrowserCoopLevelTransitionInfo();
    void BeginBrowserCoopPeerLevelTransition();
    void ClearBrowserCoopLevelTransition();
    void MoveToNewMap(const char*, bool);
    bool BeginBrowserCoopSaveLoad(const char*);
    void CancelBrowserCoopSaveLoad();
    bool LoadGame(const char*) { return loadResult; }
    bool WaitForSessionState(idSession::sessionState_t desired) { return session->state == desired; }
    void LeaveGame() { ++leaveCalls; }
    void PumpCoopTransition(const struct Room& room);
    void HoldGuestDuringLobby();
    void CompleteTransitionAfterLoad();
    void FinishFailedSaveLoad();
    void FinishCanceledLoadFiles();
};

struct Room { int players = 2; };

void ApplyCoopHostParameters(idMatchParameters& parms) {
    ''' + coop_host_parameters + r'''
}

''' + methods + r'''
void idCommonLocal::PumpCoopTransition(const Room& room) {
    const idSession::sessionState_t currentState = session->GetState();
    ''' + transition_pump + r'''
}
void idCommonLocal::HoldGuestDuringLobby() {
    ''' + guest_hold + r'''
    LeaveGame();
}
void idCommonLocal::CompleteTransitionAfterLoad() {
    const bool browserCoopLevelTransition = browserMPCoopLevelTransitionActive;
    ''' + load_complete + r'''
}
void idCommonLocal::FinishFailedSaveLoad() {
    ''' + failed_save_cleanup + r'''
}
void idCommonLocal::FinishCanceledLoadFiles() {
    if (browserMPCoopRestoreRequested) {
        ''' + canceled_load_files + r'''
    }
}

int main() {
    idMatchParameters restored;
    restored.gameMode = GAME_COOP;
    restored.mapName = "game/alphalabs1";
    ApplyCoopHostParameters(restored);
    assert(restored.mapName == "game/alphalabs1");
    assert(restored.gameMap == -1 && restored.numSlots == 2);
    restored.mapName.Clear();
    ApplyCoopHostParameters(restored);
    assert(restored.mapName == "game/mars_city1");
    restored.gameMode = 7;
    restored.mapName = "game/mp/arena";
    ApplyCoopHostParameters(restored);
    assert(restored.mapName == "game/mp/arena");

    idSession session;
    FakeGame game;
    Room room;
    idCommonLocal host;
    host.session = &session; host.game = &game;
    session.lobby.parms.gameMode = GAME_COOP;
    host.MoveToNewMap("game/campaign/next", false);
    assert(session.endCalls == 1 && session.quitCalls == 0);
    assert(host.browserMPCoopLevelTransitionActive && host.browserMPCoopLevelTransitionPending);
    assert(host.browserMPCoopLevelTransitionHost);
    assert(host.browserMPCoopLevelTransitionMap == "game/campaign/next");
    assert(host.browserMPCoopPersistentPlayerInfo[0] == "host-inventory");
    assert(host.browserMPCoopPersistentPlayerInfo[1] == "guest-inventory");

    session.lobby.users = 1;
    host.PumpCoopTransition(room);
    assert(session.updateCalls == 0 && session.startCalls == 0);
    session.lobby.users = 2;
    host.PumpCoopTransition(room);
    assert(session.updateCalls == 1 && session.startCalls == 1);
    assert(session.lobby.parms.mapName == "game/campaign/next");
    assert(!host.browserMPCoopLevelTransitionPending && host.browserMPCoopLevelTransitionActive);
    assert(session.quitCalls == 0); // Transition reused the same game lobby.

    idCommonLocal solo;
    idSession soloSession;
    solo.session = &soloSession; solo.game = &game;
    soloSession.lobby.parms.gameMode = GAME_COOP;
    soloSession.lobby.users = 1;
    Room soloRoom; soloRoom.players = 1;
    solo.MoveToNewMap("game/campaign/solo-next", false);
    solo.PumpCoopTransition(soloRoom);
    assert(soloSession.updateCalls == 1 && soloSession.startCalls == 1);
    assert(soloSession.lobby.parms.mapName == "game/campaign/solo-next");

    idCommonLocal developer;
    idSession developerSession;
    developer.session = &developerSession; developer.game = &game;
    developerSession.lobby.parms.gameMode = GAME_COOP;
    developerSession.lobby.parms.serverInfo.developerLevel = true;
    developer.MoveToNewMap("game/campaign/should-not-progress", false);
    assert(developerSession.quitCalls == 1 && developerSession.endCalls == 0 && leftRooms == 1);
    assert(!developer.browserMPCoopLevelTransitionActive);

    idCommonLocal rejected;
    rejected.session = &session; rejected.game = &game;
    rejected.browserMPTrackedRoom = false;
    session.state = idSession::INGAME;
    rejected.MoveToNewMap("game/campaign/next", true);
    assert(session.endCalls == 1 && rejected.browserMPCoopLevelTransitionActive == false);
    rejected.browserMPTrackedRoom = true; rejected.browserMPCoopRoom = true;
    rejected.browserMPHost = false;
    rejected.MoveToNewMap("game/campaign/next", true);
    assert(session.endCalls == 1 && rejected.browserMPCoopLevelTransitionActive == false);
    rejected.browserMPHost = true; session.lobby.parms.gameMode = 7;
    rejected.MoveToNewMap("game/campaign/next", true);
    assert(session.endCalls == 1 && rejected.browserMPCoopLevelTransitionActive == false);

    idCommonLocal timedOut;
    timedOut.session = &session; timedOut.game = &game;
    timedOut.browserMPCoopLevelTransitionActive = true;
    timedOut.browserMPCoopLevelTransitionPending = true;
    timedOut.browserMPCoopLevelTransitionHost = true;
    timedOut.browserMPCoopLevelTransitionStartTime = 0;
    session.state = idSession::GAME_LOBBY; session.lobby.users = 1;
    nowMs = 30001; timedOut.PumpCoopTransition(room);
    assert(reportedErrors == 1 && timedOut.browserMPFlowFailed);
    assert(!timedOut.browserMPCoopLevelTransitionActive && session.quitCalls == 4);

    idCommonLocal guest;
    guest.session = &session; guest.game = &game;
    guest.browserMPHost = false;
    guest.browserMPCoopLevelTransitionActive = true;
    guest.browserMPCoopLevelTransitionPending = true;
    session.state = idSession::GAME_LOBBY;
    guest.HoldGuestDuringLobby();
    assert(guest.leaveCalls == 0); // The guest remains in the party/game lobby.
    guest.browserMPCoopLevelTransitionActive = true;
    guest.CompleteTransitionAfterLoad();
    assert(!guest.browserMPCoopLevelTransitionActive && !guest.browserMPCoopLevelTransitionPending);
    guest.browserMPCoopLevelTransitionActive = true;
    session.state = idSession::IDLE;
    guest.CompleteTransitionAfterLoad();
    assert(!guest.browserMPCoopLevelTransitionActive && guest.browserMPFlowFailed);

    idCommonLocal save;
    save.session = &session; save.game = &game;
    session.state = idSession::PARTY_LOBBY; session.party.host = true;
    save.browserMPTrackedRoom = true; save.browserMPCoopRoom = true; save.browserMPHost = true;
    save.loadResult = false;
    assert(!save.BeginBrowserCoopSaveLoad("slot1"));
    assert(!save.browserMPCoopRestoreRequested && !save.browserMPCoopRestoreReady);
    assert(web_coop_save_state.GetInteger() == -1);
    save.loadResult = true;
    assert(save.BeginBrowserCoopSaveLoad("slot1"));
    assert(save.browserMPCoopRestoreRequested && web_coop_save_state.GetInteger() == 1);
    save.CancelBrowserCoopSaveLoad();
    assert(save.browserMPCoopRestoreCanceled && save.browserMPCoopRestoreRequested);
    assert(!save.browserMPCoopRestoreActive && !save.browserMPCoopRestoreReady);
    save.FinishFailedSaveLoad();
    assert(!save.browserMPCoopRestoreRequested && !save.browserMPCoopRestoreCanceled);
    assert(!save.browserMPCoopRestoreReady && !save.browserMPCoopRestoreActive);
    assert(save.browserMPCoopRestoreMap.empty() && web_coop_save_state.GetInteger() == 0);
    assert(save.BeginBrowserCoopSaveLoad("slot2"));
    save.CancelBrowserCoopSaveLoad();
    save.FinishCanceledLoadFiles();
    assert(!save.browserMPCoopRestoreRequested && !save.browserMPCoopRestoreCanceled);
    assert(!save.browserMPCoopRestoreReady && !save.browserMPCoopRestoreActive);
    assert(save.browserMPCoopRestoreMap.empty() && web_coop_save_state.GetInteger() == 0);

    std::puts("Co-op transition source harness passed (faked session/game; not engine or two-peer validation).");
}
'''


compiler = shutil.which("g++") or shutil.which("clang++")
if not compiler:
    raise SystemExit("A C++ compiler (g++ or clang++) is required for this focused check.")
trace_dir = ROOT / ".runtime-trace"
trace_dir.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="coop-transition-check-", dir=trace_dir) as temp_name:
    temp = Path(temp_name).resolve()
    if not temp.is_relative_to(trace_dir.resolve()):
        raise RuntimeError("Temporary compile directory escaped .runtime-trace.")
    cpp = temp / "check.cpp"
    exe = temp / "check.exe"
    cpp.write_text(template, encoding="utf-8")
    subprocess.run([compiler, "-std=c++17", "-O0", str(cpp), "-o", str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
