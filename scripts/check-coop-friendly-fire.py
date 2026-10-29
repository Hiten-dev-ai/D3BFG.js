"""Execute the actual early damage-policy branch for both co-op directions."""
from pathlib import Path
import shutil
import subprocess
import tempfile

neo = Path('engine/chocolate-doom3-bfg/neo')
source = (neo/'d3xp/Player.cpp').read_text()
start = source.index('    if (gameLocal.gameType == GAME_COOP && attacker != this')
end = source.index('return;', start) + len('return;')
branch = source[start:end]
fixture = r'''
#include <cassert>
enum { GAME_COOP=5,GAME_DM=0 };
struct Entity{virtual bool IsType(int)const{return false;}};
struct Game{int gameType=GAME_COOP;struct Info{bool enabled=false;bool GetBool(const char*){return enabled;}}serverInfo;}gameLocal;
struct idPlayer:Entity{static const int Type=1;int health=100,armor=100,pushes=0;bool IsType(int t)const override{return t==Type;}
void hit(Entity* attacker){''' + branch + r''' --health;--armor;++pushes;}};
int main(){idPlayer host,guest;Entity monster;
host.hit(&guest);guest.hit(&host);assert(host.health==100&&guest.health==100&&host.armor==100&&guest.armor==100&&host.pushes==0&&guest.pushes==0);
gameLocal.serverInfo.enabled=true;host.hit(&guest);guest.hit(&host);assert(host.health==99&&guest.health==99);
gameLocal.serverInfo.enabled=false;host.hit(&monster);guest.hit(&guest);assert(host.health==98&&guest.health==98);
gameLocal.gameType=GAME_DM;host.hit(&guest);assert(host.health==97);
}
'''
compiler = shutil.which('clang++') or shutil.which('g++');assert compiler
with tempfile.TemporaryDirectory(prefix='d3bfg-friendly-fire-') as folder:
    cpp,exe=Path(folder)/'test.cpp',Path(folder)/'test.exe';cpp.write_text(fixture)
    subprocess.run([compiler,'-std=c++17',str(cpp),'-o',str(exe)],check=True,timeout=60)
    subprocess.run([str(exe)],check=True,timeout=20)
network=(neo/'d3xp/Game_network.cpp').read_text()
assert 'serverInfo.SetBool("si_teamDamage", msg.ReadBits(1) != 0)' in network
assert 'attackerNum != clientNum' in network
assert source.index(branch) < source.index('// determine knockback', source.index(branch))
print('Actual co-op policy branch: host->guest and guest->host, enabled/disabled, health/armor/push suppression, enemy/self damage and versus preservation passed.')
