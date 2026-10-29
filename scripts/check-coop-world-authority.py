from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path('engine/chocolate-doom3-bfg/neo/d3xp/WorldSpawn.cpp').read_text()
start = source.index('void idWorldspawn::Spawn()')
opening = source.index('{', start)
end, depth = opening + 1, 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
fixture = r'''
#include <cassert>
#include <string>
#include <stdexcept>
#define GAME_COOP 5
#define DEFAULT_GRAVITY 1066
const char* va(const char*,...) { return "1066"; }
struct idStr : std::string { using std::string::operator=; void SetFileExtension(const char*) {} operator const char*() const { return c_str(); } };
struct idKeyValue { idStr value; const idStr& GetValue() const { return value; } const idStr& GetKey() const { return value; } } key;
struct Dict {
 float GetFloat(const char*,const char*) { return 1066; }
 bool GetBool(const char*) { return false; }
 const idKeyValue* MatchPrefix(const char*,const idKeyValue* previous=nullptr) { return previous ? nullptr : &key; }
};
struct Cvar { void SetFloat(float) {} } g_gravity, pm_stamina;
bool client=false; int compiled=0, started=0;
struct Common { bool IsClient() { return client; } } instance, *common=&instance;
struct function_t {} func;
struct idThread { idThread(const function_t*) {} void DelayedStart(int) { ++started; } };
struct Program { void CompileFile(const char*) { ++compiled; } const function_t* FindFunction(const char*) { return &func; } };
struct Game { void* world=nullptr; int gameType=GAME_COOP; Program program;
 const char* GetMapName() { return "test"; }
 void Error(const char*,...) { throw std::runtime_error("unexpected script error"); }
} gameLocal;
struct FS { int ReadFile(const char*,void*,void*) { return 1; } } fs, *fileSystem=&fs;
struct idWorldspawn { Dict spawnArgs; void Spawn(); };
''' + source[start:end] + r'''
int main() {
 idWorldspawn world;
 client=true; world.Spawn(); assert(compiled==1 && started==0);
 gameLocal.world=nullptr; client=false; world.Spawn(); assert(compiled==2 && started==2);
 gameLocal.world=nullptr; client=true; gameLocal.gameType=0; world.Spawn(); assert(compiled==3 && started==4);
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
assert compiler
with tempfile.TemporaryDirectory(prefix='doom-world-authority-') as folder:
    cpp, exe = Path(folder) / 'test.cpp', Path(folder) / 'test.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Actual Worldspawn::Spawn: co-op guest compiles but never launches campaign main/call scripts; host and other modes unchanged.')
