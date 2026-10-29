"""Exercise the source-derived skip budget and completion gates across frames."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'engine/chocolate-doom3-bfg/neo/d3xp/Game_local.cpp').read_text()
signature = 'if (skipCinematic && Sys_Milliseconds() - webCinematicBatchStart >= 8)'
start = source.index(signature)
budget = source[start:source.index('#endif', start)]
start = source.index('if (skipCinematic\n#ifdef __EMSCRIPTEN__')
completion = source[start:source.index(') {', start) + 1]
fixture = r'''
#include <cassert>
int wall=0, time=0, cinematicStopTime=100;
bool skipCinematic=true, inCinematic=true, muted=true;
struct { char sessionCommand[4]={}; } ret;
int Sys_Milliseconds() { return wall; }
void frame() {
    const int webCinematicBatchStart=Sys_Milliseconds();
    do {
        wall+=3; ++time;
        if (time==100) inCinematic=false;
''' + budget + r'''
    } while ((inCinematic || time < cinematicStopTime) && skipCinematic);
''' + completion + r''' { muted=false; skipCinematic=false; }
}
int main() {
    frame(); assert(time==3 && skipCinematic && muted);
    int rendered=1;
    while (skipCinematic && rendered<100) { frame(); ++rendered; }
    assert(!skipCinematic && !muted && !inCinematic && rendered>1 && time==100);
    // Map handoffs must also release the skip/mute state immediately.
    skipCinematic=true; inCinematic=true; time=0; ret.sessionCommand[0]='m';
    frame(); assert(!skipCinematic && !muted);
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('C++ compiler required')
with tempfile.TemporaryDirectory(prefix='doom-cinematic-budget-') as folder:
    cpp, exe = Path(folder) / 'check.cpp', Path(folder) / 'check.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', '-D__EMSCRIPTEN__', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Cinematic skip: bounded batches preserve pending state, permit intervening renders, and finish/unmute on scene completion or map handoff.')
