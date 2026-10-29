"""Compile the actual snapshot guard and guest AI dispatch; source contracts for player UI."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
neo = root / 'engine/chocolate-doom3-bfg/neo'
physics = (neo / 'd3xp/physics/Physics_RigidBody.cpp').read_text()
ai = (neo / 'd3xp/ai/AI.cpp').read_text()
player = (neo / 'd3xp/Player.cpp').read_text()

def function(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    end, depth = opening + 1, 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]

fixture = r'''
#include <cassert>
#include <limits>
struct idVec3 { float v[3]; float operator[](int i) const { return v[i]; } };
struct idCQuat { float x,y,z; };
struct Matrix { float m[3][3]={{1,0,0},{0,1,0},{0,0,1}}; const float* operator[](int i) const { return m[i]; } };
struct rigidBodyPState_t { struct { idVec3 position={{0,0,0}}; Matrix orientation; } i; };
struct MP { bool coop=true; bool IsGametypeCoopBased() { return coop; } };
struct Game { MP mpGame; } gameLocal;
int sim=0, interpolation=0, animation=0, presents=0;
struct idAnimatedEntity { void ClientThink(int,float,bool) { ++sim; } };
struct idAI : idAnimatedEntity {
 void InterpolatePhysicsOnly(float) { ++interpolation; }
 void UpdateAnimation() { ++animation; }
 void Present() { ++presents; }
 void ClientThink(int,float,bool);
};
''' + function(physics, 'static bool SnapshotMotionIsSane(') + '\n' + function(physics, 'static bool RigidBodyStepIsSane(') + '\n' + function(ai, 'void idAI::ClientThink(') + r'''
int main() {
 idVec3 zero={{0,0,0}}, good={{100,200,300}}, bad={{1e30f,0,0}};
 idCQuat identity={0,0,0};
 assert(SnapshotMotionIsSane(good,identity,zero));
 assert(!SnapshotMotionIsSane(bad,identity,zero));
 bad.v[0]=std::numeric_limits<float>::quiet_NaN();
 assert(!SnapshotMotionIsSane(bad,identity,zero));
 idCQuat corrupt={std::numeric_limits<float>::infinity(),0,0};
 assert(!SnapshotMotionIsSane(good,corrupt,zero));
 corrupt={2,0,0}; assert(!SnapshotMotionIsSane(good,corrupt,zero));
 rigidBodyPState_t from, to;
 to.i.position=good; assert(RigidBodyStepIsSane(from,to));
 to.i.position.v[0]=5000; assert(!RigidBodyStepIsSane(from,to));
 to.i.position=zero; to.i.orientation.m[0][0]=std::numeric_limits<float>::infinity();
 assert(!RigidBodyStepIsSane(from,to));
 idAI actor; actor.ClientThink(0,0.5f,false);
 assert(sim==0 && interpolation==1 && animation==1 && presents==1);
 gameLocal.mpGame.coop=false; actor.ClientThink(0,0.5f,false); assert(sim==1);
}
'''
assert 'common->IsMultiplayer() && !gameLocal.mpGame.IsGametypeCoopBased()' in function(player, 'void idPlayer::UpdateFocus(')
assert 'gameLocal.mpGame.IsGametypeCoopBased()' in function(player, 'void idPlayer::UpdateSkinSetup(')
assert 'animator.ModelDef()->GetDefaultSkin()' in function(player, 'void idPlayer::Init(')
assert 'command != NULL && strcmp' in function(player, 'void idPlayer::Weapon_GUI(')
assert 'damage = 0;\n        armorSave = 0;' in player
assert 'previous = current;\n    next = current;' in function(physics, 'idPhysics_RigidBody::idPhysics_RigidBody()')
evaluate = function(physics, 'bool idPhysics_RigidBody::Evaluate(')
assert evaluate.index('timeStepMSec <= 0') < evaluate.index('if (hasMaster)')
assert evaluate.index('RigidBodyStepIsSane(current, next_step)') < evaluate.index('collided = CheckForCollisions')
game = (neo / 'd3xp/Game_local.cpp').read_text()
assert 'gameType == GAME_COOP && common->IsClient()' in function(game, 'void idGameLocal::LoadMap(')
assert 'delete aasList[i]' in function(game, 'void idGameLocal::LoadMap(')
framework = (neo / 'framework/common_frame.cpp').read_text()
assert 'SetBool("si_teamDamage", room.friendlyFire != 0)' in framework
assert 'activeMatch.serverInfo.GetBool("si_teamDamage", "0")' in game
menu = (neo / 'd3xp/menus/MenuScreen_Shell_WebMultiplayer.cpp').read_text()
assert 'AddCycleRow("Friendly Fire", MP_CMD_FRIENDLY_FIRE)' in menu
compiler = shutil.which('clang++') or shutil.which('g++')
assert compiler, 'A C++ compiler is required'
with tempfile.TemporaryDirectory(prefix='doom-coop-peer-safety-') as folder:
    cpp, exe = Path(folder) / 'test.cpp', Path(folder) / 'test.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Guest AI dispatch and invalid snapshot guard executed; co-op focus, skin and friendly-fire source contracts passed (not gameplay acceptance).')
