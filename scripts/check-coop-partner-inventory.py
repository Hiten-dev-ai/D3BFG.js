"""Compile actual save-envelope/seed code with synthetic inventories (no game data)."""
from pathlib import Path
import shutil
import subprocess
import tempfile

neo = Path('engine/chocolate-doom3-bfg/neo')
player = (neo / 'd3xp/Player.cpp').read_text()
network = (neo / 'd3xp/Game_network.cpp').read_text()
local = (neo / 'd3xp/Game_local.cpp').read_text()

def block(source, signature):
    start = source.index(signature); opening = source.index('{', start); end = opening + 1; depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}'); end += 1
    return source[start:end]

save = block(player, 'void idPlayer::SavePersistantInfo()')
seed = block(network, 'if (gameType == GAME_COOP && freePlayerDataIndex == 1 &&')
decode_start = local.index('        const idKeyValue* key = NULL;', local.index('// Restore the save-owned partner slot'))
decode_end = local.index('        for (i = 1;', decode_start)
decode = local[decode_start:decode_end]
fixture = r'''
#include <cassert>
#include <string>
#include <vector>
#include <cstdarg>
#include <cstdio>
#include <cstring>
enum { GAME_COOP=5, GAME_SP=0 };
struct idStr : std::string { using std::string::string; idStr(std::string s):std::string(s){} static int Icmpn(const std::string&a,const char*b,int n){return a.compare(0,n,b,n);} };
const char* va(const char* format, ...) { static char text[4096]; va_list args; va_start(args,format); vsnprintf(text,sizeof(text),format,args); va_end(args); return text; }
struct idKeyValue { idStr key,value; const idStr& GetKey()const{return key;} const idStr& GetValue()const{return value;} };
struct idDict {
 std::vector<idKeyValue> fields;
 void Clear(){fields.clear();} int GetNumKeyVals()const{return fields.size();}
 const idKeyValue* GetKeyVal(int i)const{return &fields[i];}
 void Set(std::string key,std::string value){for(auto& f:fields)if(f.key==key){f.value=value;return;} fields.push_back({key,value});}
 void SetInt(std::string key,int value){Set(key,std::to_string(value));} void SetBool(std::string key,bool value){SetInt(key,value);}
 std::string Get(std::string key)const{for(auto&f:fields)if(f.key==key)return f.value;return "";}
 bool GetBool(std::string key)const{return Get(key)=="1";}
 void Copy(const idDict& other){for(auto&f:other.fields)Set(f.key,f.value);}
 void Delete(std::string key){for(auto i=fields.begin();i!=fields.end();++i)if(i->key==key){fields.erase(i);return;}}
 const idKeyValue* MatchPrefix(const char* prefix,const idKeyValue* previous=nullptr)const{bool ready=previous==nullptr;for(auto& f:fields){if(ready&&f.key.starts_with(prefix))return &f;if(&f==previous)ready=true;}return nullptr;}
};
struct idEntity { virtual ~idEntity(){} virtual bool IsType(int)const{return false;} };
struct Inventory { idDict data; void GetPersistantData(idDict& target){target.Copy(data);} };
struct idPlayer : idEntity {
 static const int Type=1; bool IsType(int t)const override{return t==Type;}
 int entityNumber=0,health=100,currentWeapon=2,playedTimeSecs=0,coopLivesRemaining=3;
 Inventory inventory; int GetCurrentWeaponSlot(){return currentWeapon;}
 struct Achievements { void SavePersistentData(idDict& data){data.Set("achievements","own-only");} } achievementManager;
 void SavePersistantInfo();
};
struct Game { int gameType=GAME_COOP; idDict persistentPlayerInfo[8]; idEntity* entities[8]={}; } gameLocal;
''' + save + '\nvoid seed(int freePlayerDataIndex){int gameType=gameLocal.gameType;auto& persistentPlayerInfo=gameLocal.persistentPlayerInfo;auto& entities=gameLocal.entities;' + seed + '}\nvoid decode(){auto& persistentPlayerInfo=gameLocal.persistentPlayerInfo;' + decode + r'''}
int main(){
 idPlayer host,guest; guest.entityNumber=1;gameLocal.entities[0]=&host;
 host.inventory.data.Set("weapon_bits","51");host.inventory.data.Set("ammo_shells","37");host.inventory.data.Set("pda_0","security");host.inventory.data.Set("armor","75");
 seed(1);assert(gameLocal.persistentPlayerInfo[1].GetBool("web_coop_inventory_seeded"));
 assert(gameLocal.persistentPlayerInfo[1].Get("ammo_shells")=="37");
 assert(gameLocal.persistentPlayerInfo[1].Get("pda_0")=="security");
 assert(gameLocal.persistentPlayerInfo[1].Get("achievements").empty());
 guest.inventory.data.Copy(gameLocal.persistentPlayerInfo[1]);guest.inventory.data.Set("ammo_shells","9");gameLocal.entities[1]=&guest;
 host.SavePersistantInfo();assert(gameLocal.persistentPlayerInfo[0].Get("web_partner_ammo_shells")=="9");
 guest.SavePersistantInfo();gameLocal.entities[1]=nullptr;host.inventory.data.Set("ammo_shells","999");seed(1);
 assert(gameLocal.persistentPlayerInfo[1].Get("ammo_shells")=="9"); // reconnect never re-clones host
 gameLocal.persistentPlayerInfo[1].Clear();decode();assert(gameLocal.persistentPlayerInfo[1].Get("ammo_shells")=="9");
 gameLocal.gameType=GAME_SP;host.SavePersistantInfo();gameLocal.persistentPlayerInfo[1].Clear();decode();
 assert(gameLocal.persistentPlayerInfo[1].Get("ammo_shells")=="9"); // solo saves carry partner envelope
 gameLocal.gameType=GAME_COOP;gameLocal.entities[1]=&guest;guest.inventory.data.Delete("pda_0");guest.inventory.data.Set("ammo_shells","4");host.SavePersistantInfo();
 assert(gameLocal.persistentPlayerInfo[0].Get("web_partner_ammo_shells")=="4");
 assert(gameLocal.persistentPlayerInfo[0].Get("web_partner_pda_0").empty()); // removed items don't reappear
}
'''
compiler = shutil.which('clang++') or shutil.which('g++'); assert compiler
with tempfile.TemporaryDirectory(prefix='d3bfg-partner-inventory-') as folder:
    cpp, exe = Path(folder)/'test.cpp', Path(folder)/'test.exe';cpp.write_text(fixture)
    subprocess.run([compiler,'-std=c++20',str(cpp),'-o',str(exe)],check=True,timeout=60)
    subprocess.run([str(exe)],check=True,timeout=20)
assert 'GAME_RELIABLE_MESSAGE_COOP_INVENTORY' in network
assert 'player->inventory.RestoreInventory(player, persistentPlayerInfo[slot]);' in network
print('Actual partner seed/save envelope: one-time host clone, independent progress, disconnect/reconnect, save reload, solo carry-forward and removed-item replacement passed.')
