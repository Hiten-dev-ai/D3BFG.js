"""Exercise the actual declaration reset with lightweight material/list fakes."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source = (root / 'engine/chocolate-doom3-bfg/neo/framework/DeclManager.cpp').read_text(encoding='utf-8')
start = source.index('void idDeclManagerLocal::BeginLevelLoad()')
brace = source.index('{', start)
depth, end = 1, brace + 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
method = source[start:end]
fixture = r'''
#include <algorithm>
#include <cassert>
#include <cctype>
#include <cstdio>
#include <string>
#include <vector>
enum { DECL_MATERIAL, DECL_OTHER, DECL_MAX_TYPES };
enum { DS_UNPARSED, DS_PARSED };
bool webLoadingGuiResourcesPinned = false;
struct Name : std::string {
    using std::string::string;
    int Find(const char* part, bool sensitive) const {
        std::string value = *this;
        if (!sensitive) std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return std::tolower(c); });
        auto at = value.find(part);
        return at == npos ? -1 : static_cast<int>(at);
    }
};
struct idDeclLocal {
    Name name;
    int declState = DS_PARSED;
    bool referencedThisLevel = false, purged = false;
    void Purge() { purged = true; referencedThisLevel = false; declState = DS_UNPARSED; }
};
struct List : std::vector<idDeclLocal*> { int Num() const { return static_cast<int>(size()); } };
struct idDeclManagerLocal { bool insideLevelLoad = false; List linearLists[DECL_MAX_TYPES]; void BeginLevelLoad(); };
''' + method + r'''
int main() {
    for (bool pin : {false, true}) {
        idDeclLocal font{{"newfonts/Arial/48"}}, swf{{"swf/loading/default"}}, backdrop{{"guis/assets/loadscreens/mars_city1"}};
        idDeclLocal world{{"textures/mars_city/wall"}}, unparsed{{"newfonts/Arial/24"}}, mapDef{{"game/mars_city1"}};
        unparsed.declState = DS_UNPARSED;
        idDeclManagerLocal manager;
        manager.linearLists[DECL_MATERIAL] = List{ { &font, &swf, &backdrop, &world, &unparsed } };
        manager.linearLists[DECL_OTHER] = List{ { &mapDef } };
        webLoadingGuiResourcesPinned = pin;
        manager.BeginLevelLoad();
#ifdef __EMSCRIPTEN__
        const bool retain = pin;
#else
        const bool retain = false;
#endif
        assert(font.purged == !retain && swf.purged == !retain && backdrop.purged == !retain);
        assert(font.referencedThisLevel == retain && swf.referencedThisLevel == retain);
        assert(world.purged && unparsed.purged && mapDef.purged);
        assert(manager.insideLevelLoad);
    }
    std::puts("Loading material lifetime: active surface retained, world/unparsed data reset, inactive/native behavior preserved.");
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('A C++ compiler is required for this focused check.')
with tempfile.TemporaryDirectory(prefix='doom-loading-material-') as folder:
    temp = Path(folder)
    cpp = temp / 'check.cpp'
    cpp.write_text(fixture, encoding='utf-8')
    for browser in (False, True):
        exe = temp / ('browser.exe' if browser else 'native.exe')
        subprocess.run([compiler, '-std=c++17', *(['-D__EMSCRIPTEN__'] if browser else []), str(cpp), '-o', str(exe)], check=True, timeout=60)
        subprocess.run([str(exe)], check=True, timeout=20)
