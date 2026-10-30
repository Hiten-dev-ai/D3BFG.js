"""Reproduce the captured -1/6 overflow with the actual BitMsg writer/reader."""
from pathlib import Path
import shutil
import subprocess
import tempfile

neo = Path('engine/chocolate-doom3-bfg/neo')
source = (neo/'idlib/BitMsg.cpp').read_text()

def block(signature):
    start=source.index(signature); opening=source.index('{',start); end=opening+1; depth=1
    while depth:
        depth+=(source[end]=='{')-(source[end]=='}');end+=1
    return source[start:end]

fixture=r'''
#include <cassert>
#include <cstdint>
#include <stdexcept>
#include <cstring>
using int64=int64_t; uint64_t maskForNumBits64[33];
struct idLib{static void FatalError(const char*,...){throw std::runtime_error("overflow");}};
struct idBitMsg{
 unsigned char bytes[512]={};unsigned char*writeData=bytes;const unsigned char*readData=bytes;
 int curSize=0,writeBit=0;uint64_t tempValue=0;mutable int readCount=0,readBit=0;
 bool CheckOverflow(int){return false;}int GetRemainingReadBits()const{return 4096-readCount*8-readBit;}
 void WriteBits(int,int);int ReadBits(int)const;
};
'''+block('void idBitMsg::WriteBits(')+block('int idBitMsg::ReadBits(')+r'''
int main(){for(int i=0;i<=32;++i)maskForNumBits64[i]=(uint64_t(1)<<i)-1;
 bool reproduced=false;try{idBitMsg old;old.WriteBits(-1,6);}catch(const std::runtime_error&){reproduced=true;}assert(reproduced);
 for(int weapon=-1;weapon<32;++weapon){idBitMsg msg;msg.WriteBits(weapon,-6);assert(msg.ReadBits(-6)==weapon);}
 bool rejects=false;try{idBitMsg msg;msg.WriteBits(32,-6);}catch(const std::runtime_error&){rejects=true;}assert(rejects);
}
'''
player=(neo/'d3xp/Player.cpp').read_text()
assert 'msg.WriteBits(idealWeapon.Get(), -idMath::BitsForInteger(MAX_WEAPONS));' in player
assert 'newIdealWeapon = msg.ReadBits(-idMath::BitsForInteger(MAX_WEAPONS));' in player
compiler=shutil.which('clang++')or shutil.which('g++');assert compiler
with tempfile.TemporaryDirectory(prefix='d3bfg-unarmed-snapshot-') as folder:
    cpp,exe=Path(folder)/'test.cpp',Path(folder)/'test.exe';cpp.write_text(fixture)
    subprocess.run([compiler,'-std=c++17',str(cpp),'-o',str(exe)],check=True,timeout=60)
    subprocess.run([str(exe)],check=True,timeout=20)
print('Captured -1/6 BitMsg overflow reproduced; actual signed writer/reader roundtrips unarmed -1 and every weapon slot 0..31.')
