from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen_Shell_WebMultiplayer.cpp').read_text()
start = source.index('if (event->evType == SE_KEY && event->evValue == K_ESCAPE)', source.index('bool idMenuScreen_Shell_WebMultiplayer::HandleBrowserInput('))
opening = source.index('{', start)
end, depth = opening + 1, 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
branch = source[start:end]
fixture = r'''
#include <cassert>
#include <vector>
enum { SE_KEY=1, K_ESCAPE=27 };
struct Event { int evType=SE_KEY,evValue=K_ESCAPE,evValue2=1; } key;
struct Keys : std::vector<int> { int FindIndex(int value) { for(int i=0;i<size();++i) if((*this)[i]==value) return i; return -1; } void RemoveIndex(int i) { erase(begin()+i); } } multiplayerEditConsumedKeys;
int backs=0; void Back() { ++backs; }
bool handle(Event* event) { ''' + branch + r''' return false; }
int main() {
 multiplayerEditConsumedKeys.push_back(K_ESCAPE); // release was routed to an old page/dialog
 assert(handle(&key) && backs==1 && multiplayerEditConsumedKeys.empty());
 key.evValue2=0; assert(handle(&key) && backs==1);
 key.evValue2=1; assert(handle(&key) && backs==2);
}
'''
assert 'multiplayerEditConsumedKeys.AddUnique(event->evValue);\n            Back();' not in source
compiler = shutil.which('clang++') or shutil.which('g++')
assert compiler
with tempfile.TemporaryDirectory(prefix='doom-mp-escape-') as folder:
    cpp, exe = Path(folder) / 'test.cpp', Path(folder) / 'test.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Actual multiplayer Escape branch: stale edit key cannot swallow Back; release consumed; next press works.')
