from pathlib import Path
import shutil
import subprocess
import tempfile

neo=Path('engine/chocolate-doom3-bfg/neo')
source=(neo/'swf/SWF_Render.cpp').read_text()
start=source.index('            idSWFScriptObject* menuState =', source.index('// Apply menu fades AFTER'))
body=source[start:source.index('#endif',start)]
fixture=r'''
#include <cassert>
#include <algorithm>
#include <map>
#include <string>
int now=0;int Sys_Milliseconds(){return now;}template<class T>T Max(T a,T b){return std::max(a,b);}
struct idMath{static float ClampFloat(float a,float b,float v){return std::clamp(v,a,b);}};
struct idSWFScriptVar{int value=0;bool numeric=false;bool IsNumeric()const{return numeric;}int ToInteger()const{return value;}bool ToBool()const{return value!=0;}};
struct idSWFScriptObject{std::map<std::string,idSWFScriptVar>fields;idSWFScriptVar Get(const char*k){return fields[k];}};
struct Sprite{idSWFScriptObject state;idSWFScriptObject*GetScriptObject(){return &state;}}sprite;
struct{Sprite*spriteInstance=&sprite;}display;
struct{struct{struct{float w=1;}mul,add;}cxf;}renderState2;
void drawAfterTimeline(){renderState2.cxf.mul.w=1;renderState2.cxf.add.w=0;'''+body+r'''}
int main(){sprite.state.fields["_webFadeStart"]={0,true};sprite.state.fields["_webFadeDuration"]={160,true};
now=0;drawAfterTimeline();assert(renderState2.cxf.mul.w==0);
now=80;drawAfterTimeline();assert(renderState2.cxf.mul.w==0.5f);
now=160;drawAfterTimeline();assert(renderState2.cxf.mul.w==1);
sprite.state.fields["_webFadeOut"]={1,true};now=80;drawAfterTimeline();assert(renderState2.cxf.mul.w==0.5f);
now=160;drawAfterTimeline();assert(renderState2.cxf.mul.w==0);
}
'''
compiler=shutil.which('clang++')or shutil.which('g++');assert compiler
with tempfile.TemporaryDirectory(prefix='d3bfg-render-fade-')as folder:
    cpp,exe=Path(folder)/'test.cpp',Path(folder)/'test.exe';cpp.write_text(fixture)
    subprocess.run([compiler,'-std=c++17',str(cpp),'-o',str(exe)],check=True,timeout=60)
    subprocess.run([str(exe)],check=True,timeout=20)
print('Actual post-timeline SWF render fade: entrance/exit alpha survives authored alpha resets, including midpoint and endpoints.')
