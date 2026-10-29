from pathlib import Path
import shutil
import subprocess
import tempfile

neo = Path('engine/chocolate-doom3-bfg/neo')
shell = (neo / 'd3xp/menus/MenuHandler_Shell.cpp').read_text()
game = (neo / 'd3xp/Game_local.cpp').read_text()

def block(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    end, depth = opening + 1, 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]

functions = ''
for name in ['ShowDoomIntro', 'ShowROEIntro', 'ShowLEIntro']:
    function = block(shell, f'void idMenuHandler_Shell::{name}(')
    opening = function.index('{')
    # Compile the actual early bypass; the sentinel represents movie creation.
    early = function[opening + 1:function.index('#endif', opening)] + '#endif\n'
    assert function.index('StartGame(') < function.index('new idSWF(')
    functions += f'void {name}() {{ {early} ++movies; }}\n'

fixture = r'''
#include <cassert>
#include <vector>
#define __EMSCRIPTEN__
bool skip=true; int movies=0, webIntroAutoStartAt=123;
std::vector<int> starts;
int BrowserBridge_GetNumber(const char*, int) { return skip ? 1 : 0; }
void StartGame(int index) { starts.push_back(index); }
enum { SND_CHANNEL_VOICE=1, SND_CHANNEL_VOICE2=2 };
struct idEntity {
 struct Node { idEntity* next=nullptr; idEntity* Next() { return next; } } spawnNode;
 int voices=0, voices2=0;
 void StopSound(int channel,bool network) { assert(!network); if(channel==1) ++voices; else if(channel==2) ++voices2; else assert(false); }
};
''' + functions + block(game, 'static void StopSkippedCinematicVoices(') + r'''
int main() {
 ShowDoomIntro(); ShowROEIntro(); ShowLEIntro();
 assert(movies==0 && webIntroAutoStartAt==0 && starts.size()==3 && starts[0]==0 && starts[1]==1 && starts[2]==2);
 skip=false; ShowDoomIntro(); ShowROEIntro(); ShowLEIntro(); assert(movies==3 && starts.size()==3);
 idEntity one,two; one.spawnNode.next=&two; StopSkippedCinematicVoices(&one);
 assert(one.voices==1 && one.voices2==1 && two.voices==1 && two.voices2==1);
}
'''
assert 'StopSkippedCinematicVoices(spawnedEntities.Next())' in block(game, 'bool idGameLocal::SkipCinematic(')
assert block(game, 'void idGameLocal::RunFrame(').count('StopSkippedCinematicVoices') >= 2
compiler = shutil.which('clang++') or shutil.which('g++')
assert compiler
with tempfile.TemporaryDirectory(prefix='doom-intro-skip-audio-') as folder:
    cpp, exe = Path(folder) / 'test.cpp', Path(folder) / 'test.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Actual intro bypass skips movie creation for all campaigns; non-Skip path retained; skipped voice-channel cleanup runs without stopping ambient channels.')
