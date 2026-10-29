"""Compile the real location lookup/handle code against entity deletion/reuse."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
neo = root / 'engine/chocolate-doom3-bfg/neo'
header = (neo / 'd3xp/Game_local.h').read_text()
source = (neo / 'd3xp/Game_local.cpp').read_text()
network = (neo / 'd3xp/Game_network.cpp').read_text()

def method(text, signature):
    start = text.index(signature)
    opening = text.index('{', start)
    depth, end = 1, opening + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]

lookup = method(source, 'idLocationEntity* idGameLocal::LocationForPoint(')
getter = method(header, 'ID_INLINE type* idEntityPtr<type>::GetEntity() const')
assign = method(header, 'ID_INLINE idEntityPtr<type>& idEntityPtr<type>::operator=(const type* ent)')
fixture = r'''
#include <cassert>
#include <new>
#include <stdexcept>
#define ID_INLINE inline
const int GENTITYNUM_BITS = 4;
struct idVec3 {};
struct idEntity { int entityNumber=1; bool location=true; bool IsType(int) const { return location; } };
struct idLocationEntity : idEntity { static const int Type=1; };
template<class type> struct idEntityPtr {
    int spawnId=0;
    type* GetEntity() const;
    idEntityPtr& operator=(const type*);
};
struct World { int area=0; int PointInArea(const idVec3&) { return area; } int NumAreas() { return 2; } } world;
struct idGameLocal {
    int spawnIds[16]{};
    idEntity* entities[16]{};
    idEntityPtr<idLocationEntity>* locationEntities=nullptr;
    World* gameRenderWorld=&world;
    void Error(const char*) { throw std::runtime_error("bad area"); }
    idLocationEntity* LocationForPoint(const idVec3&);
} gameLocal;
''' + '\ntemplate<class type>\n' + getter + '\ntemplate<class type>\n' + assign + '\n' + lookup + r'''
int main() {
    idVec3 point;
    assert(gameLocal.LocationForPoint(point)==nullptr);
    idEntityPtr<idLocationEntity> areas[2]; gameLocal.locationEntities=areas;
    alignas(idLocationEntity) unsigned char storage[sizeof(idLocationEntity)];
    auto* location=new(storage) idLocationEntity;
    gameLocal.entities[1]=location; gameLocal.spawnIds[1]=7;
    areas[0]=location; areas[1]=location;
    assert(gameLocal.LocationForPoint(point)==location);
    location->~idLocationEntity(); gameLocal.entities[1]=nullptr; gameLocal.spawnIds[1]=-1;
    assert(gameLocal.LocationForPoint(point)==nullptr);
    world.area=1; assert(gameLocal.LocationForPoint(point)==nullptr);
    // Allocator address and entity slot reuse must not resurrect the old handle.
    location=new(storage) idLocationEntity; gameLocal.entities[1]=location; gameLocal.spawnIds[1]=8;
    assert(gameLocal.LocationForPoint(point)==nullptr);
    areas[1]=location; assert(gameLocal.LocationForPoint(point)==location);
    // Even a reused matching spawn id must not expose an unrelated entity type.
    location->location=false; assert(gameLocal.LocationForPoint(point)==nullptr);
    world.area=-1; assert(gameLocal.LocationForPoint(point)==nullptr);
    location->~idLocationEntity();
}
'''
assert 'idEntityPtr<idLocationEntity>* locationEntities' in header
assert 'savegame.WriteObject(locationEntities[i].GetEntity())' in source
assert 'savegame.ReadObject(reinterpret_cast<idClass*&>(location))' in source
assert 'locationEntities[i] = location;' in source
assert 'ent->IsType(idLocationEntity::Type)' in network
assert 'if (rebuildLocations) {\n        SpreadLocations();' in network
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('C++ compiler required')
with tempfile.TemporaryDirectory(prefix='doom-location-lifetime-') as folder:
    cpp, exe = Path(folder) / 'check.cpp', Path(folder) / 'check.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Actual location lookup: deleted entities, area aliases, slot/address reuse and wrong-type reuse are safe; saved object-reference layout preserved.')
