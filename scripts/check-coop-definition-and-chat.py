"""Compile the actual campaign-definition, timer and chat-input gates."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1] / 'engine/chocolate-doom3-bfg/neo'

def body(source, marker):
    start = source.index('{', source.index(marker))
    depth, end = 1, start + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start + 1:end - 1]

definition = body((root / 'd3xp/Game_local.cpp').read_text(), 'idGameLocal::FindEntityDef(')
timer = body((root / 'd3xp/MultiplayerGame.cpp').read_text(), 'idMultiplayerGame::TimeLimitHit(')
event = body((root / 'framework/Common.cpp').read_text(), 'idCommonLocal::ProcessEvent(')
chat = event[event.index('    static int chatOpeningKey'):event.index('    // A modal owns')]
binding = event[event.index('        const char* binding ='):event.index('        idKeyInput::ExecKeyBinding(')]
fixture = r'''
#include <cassert>
#include <cctype>
#include <cstring>
#include <string>
enum { GAME_DM, GAME_COOP=5, SE_KEY=1, SE_CHAR=2 };
using keyNum_t = int;
struct idDecl { std::string name; }; using idDeclEntityDef=idDecl;
enum { DECL_ENTITYDEF };
struct Common { bool mp=true; bool IsMultiplayer() const { return mp; } } commonInstance, *common=&commonInstance;
const char* va(const char*,const char* name) { static std::string s; s=std::string(name)+"_mp"; return s.c_str(); }
struct Decls { idDecl original{"player_doommarine"}, versus{"player_doommarine_mp"};
 const idDecl* FindType(int,const char* name,bool) { return std::string(name).find("_mp")!=std::string::npos?&versus:&original; }
} decls,*declManager=&decls;
struct idGameLocal { int gameType=GAME_COOP; const idDeclEntityDef* FindEntityDef(const char*,bool) const; };
const idDeclEntityDef* idGameLocal::FindEntityDef(const char* name,bool makeDefault) const { DEFINITION }
struct ServerInfo { int limit=10; int GetInt(const char*) { return limit; } };
struct Game { int serverTime=700000; ServerInfo serverInfo; } gameLocal;
struct idMultiplayerGame { bool coop=true; int matchStartedTime=0;
 bool IsGametypeCoopBased() { return coop; } bool TimeLimitHit(); };
bool idMultiplayerGame::TimeLimitHit() { TIMER }
struct sysEvent_t { int evType,evValue,evValue2; };
struct idStr { static int ToLower(int c) { return std::tolower(c); }
 static int Icmpn(const char*a,const char*b,int n) { for(int i=0;i<n;++i) { int x=ToLower(a[i]),y=ToLower(b[i]);if(x!=y)return x-y;if(!x)return 0;}return 0; } };
struct idKeyInput { static inline const char* binding="clientMessageMode"; static const char* GetBinding(int) { return binding; }
 static const char* KeyNumToString(int) { return "t"; } };
int Sys_Milliseconds() { return 100; }
bool IsMultiplayer() { return true; }
bool ChatGate(const sysEvent_t* event) { CHAT
 if(event->evType==SE_KEY && event->evValue2==1) { BINDING }
 return false;
}
int main() {
 idGameLocal game;
 assert(game.FindEntityDef("player_doommarine",true)->name=="player_doommarine");
 game.gameType=GAME_DM; assert(game.FindEntityDef("player_doommarine",true)->name=="player_doommarine_mp");
 common->mp=false; assert(game.FindEntityDef("player_doommarine",true)->name=="player_doommarine");
 idMultiplayerGame mp; assert(!mp.TimeLimitHit());mp.coop=false;assert(mp.TimeLimitHit());
 gameLocal.serverTime=10;assert(!mp.TimeLimitHit());
 sysEvent_t down{SE_KEY,20,1}, text{SE_CHAR,'t',0},up{SE_KEY,20,0}; // K_T scan code != character 't'.
 assert(!ChatGate(&down)); assert(ChatGate(&text)); assert(ChatGate(&up));
 assert(!ChatGate(&text)); // A subsequently typed T is still valid text.
 assert(!ChatGate(&down)); assert(ChatGate(&up)); assert(ChatGate(&text)); // SDL text may follow key release.
 idKeyInput::binding="clientMessageMode 1";
 assert(!ChatGate(&down));assert(ChatGate(&down));assert(ChatGate(&text));assert(ChatGate(&up));
 idKeyInput::binding="_attack";assert(!ChatGate(&down));assert(!ChatGate(&text));
}
'''.replace('DEFINITION', definition).replace('TIMER', timer).replace('CHAT', chat).replace('BINDING', binding)
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler: raise SystemExit('A C++ compiler is required')
with tempfile.TemporaryDirectory(prefix='doom-coop-definition-chat-') as folder:
    cpp, exe = Path(folder)/'check.cpp', Path(folder)/'check.exe'
    cpp.write_text(fixture, encoding='utf-8')
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Actual C++ gates: campaign player definitions, versus preservation, co-op timer immunity and chat-opening key consumption passed.')
