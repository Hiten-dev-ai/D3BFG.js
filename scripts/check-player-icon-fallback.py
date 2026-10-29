"""Exercise actual campaign-player icon selection without a fallback sprite."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'engine/chocolate-doom3-bfg/neo/d3xp/PlayerIcon.cpp').read_text()
signature = 'bool idPlayerIcon::CreateIcon(idPlayer* player, playerIconType_t type, const idVec3& origin, const idMat3& axis)'
start = source.index(signature)
opening = source.index('{', start)
depth, end = 1, opening + 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
method = source[start:end]
assert source.count('&& iconHandle != -1') >= 2
fixture = r'''
#include <cassert>
#include <cstring>
enum playerIconType_t { ICON_LAG, ICON_NONE };
struct idVec3 {}; struct idMat3 {};
const char* iconKeys[]={"mtr_icon_lag"};
struct Dict { const char* material=nullptr; const char* GetString(const char*,const char* fallback) { return material?material:fallback; } };
struct idPlayer { Dict spawnArgs; };
struct idPlayerIcon {
    int iconHandle=9, creations=0;
    void FreeIcon() { iconHandle=-1; }
    bool CreateIcon(idPlayer*,playerIconType_t,const idVec3&,const idMat3&);
    bool CreateIcon(idPlayer*,playerIconType_t,const char* mtr,const idVec3&,const idMat3&) {
        assert(!strcmp(mtr,"guis/assets/lag")); ++creations; iconHandle=10; return true;
    }
};
''' + method + r'''
int main() {
    idPlayer player; idPlayerIcon icon;
    assert(!icon.CreateIcon(&player,ICON_LAG,{},{}));
    assert(icon.creations==0 && icon.iconHandle==-1);
    player.spawnArgs.material="guis/assets/lag";
    assert(icon.CreateIcon(&player,ICON_LAG,{},{})); assert(icon.creations==1);
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('C++ compiler required')
with tempfile.TemporaryDirectory(prefix='doom-player-icon-') as folder:
    cpp, exe = Path(folder) / 'check.cpp', Path(folder) / 'check.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Campaign marine without an icon material does not draw the opaque _default box; configured versus icon selection remains enabled.')
