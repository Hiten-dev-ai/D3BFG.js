"""Exercise the browser server's actual initial-player and warmup gates."""
from pathlib import Path
import shutil
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] /
          'engine/chocolate-doom3-bfg/neo/d3xp/MultiplayerGame.cpp').read_text()

def function(signature):
    start = source.index(signature)
    opening = source.index('{', start)
    depth, end = 1, opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]

spawn = function('void idMultiplayerGame::SpawnPlayer(')
can_play = function('bool idMultiplayerGame::CanPlay(')
want_respawn = function('bool idMultiplayerGame::WantRespawn(')
enough = function('bool idMultiplayerGame::EnoughClientsToPlay(')
fixture = r'''
#include <cassert>
#include <cstring>
#define __EMSCRIPTEN__ 1
enum { GAME_DM, GAME_LASTMAN, GAME_TOURNEY, GAMEON, LASTMAN_NOLIVES };
struct idPlayer { bool wantSpectate=true, forceRespawn=true; int spawnedTime=0, team=0, tourneyRank=0; };
struct PlayerState { int fragCount; };
using lobbyUserID_t = int;
struct idLobbyBase { const char* GetLobbyUserName(int) { return "Marine"; } } lobby;
struct Session { idLobbyBase& GetActingGameStateLobbyBase() { return lobby; } } sess, *session=&sess;
struct Common { bool client=false, multiplayer=true; bool IsClient() { return client; } bool IsMultiplayer() { return multiplayer; } } c, *common=&c;
struct idLocalization { static const char* GetString(const char*) { return "join"; } };
struct Game { int gameType=GAME_DM, serverTime=42, lobbyUserIDs[2]={}; idPlayer* entities[2]={}; } gameLocal;
struct idMultiplayerGame {
 enum msg_evt_t { MSG_JOINEDGAME };
  PlayerState playerState[2]{}; int gameState=0; bool teamBased=false; int count=0, teams[2]={};
  int joinEvents=0, chatLines=0;
  void AddChatLine(const char*,const char*) { ++chatLines; }
  void PrintMessageEvent(msg_evt_t, int) { ++joinEvents; }
 void SpawnPlayer(int); bool CanPlay(idPlayer*); bool WantRespawn(idPlayer*); bool EnoughClientsToPlay();
 bool IsGametypeTeamBased() { return teamBased; }
 int NumActualClients(bool, int* out) { out[0]=teams[0]; out[1]=teams[1]; return count; }
};
''' + spawn + '\n' + can_play + '\n' + want_respawn + '\n' + enough + r'''
int main() {
 idMultiplayerGame game; idPlayer player; gameLocal.entities[0]=&player;
 game.SpawnPlayer(0); assert(game.joinEvents==1 && game.chatLines==0);
 assert(!player.wantSpectate && game.CanPlay(&player) && game.WantRespawn(&player));
 player.wantSpectate=true; assert(!game.CanPlay(&player) && !game.WantRespawn(&player));
 c.client=true; game.SpawnPlayer(0); assert(player.wantSpectate && game.joinEvents==1);
 c.client=false; c.multiplayer=false; game.SpawnPlayer(0); assert(game.joinEvents==1 && game.chatLines==1);
 c.multiplayer=true;
 game.count=1; assert(!game.EnoughClientsToPlay()); game.count=2; assert(game.EnoughClientsToPlay());
 game.teamBased=true; game.teams[0]=2; assert(!game.EnoughClientsToPlay());
 game.teams[0]=game.teams[1]=1; assert(game.EnoughClientsToPlay());
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('A C++ compiler is required')
with tempfile.TemporaryDirectory(prefix='doom-mp-spawn-') as folder:
    cpp, exe = Path(folder) / 'check.cpp', Path(folder) / 'check.exe'
    cpp.write_text(fixture, encoding='utf-8')
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Initial browser spawn, spectator choice and native warmup gates passed.')
