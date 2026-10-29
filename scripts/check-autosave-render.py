"""Exercise the actual autosave draw branch with a recording renderer, not pixels."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'engine/chocolate-doom3-bfg/neo/framework/Common_dialog.cpp').read_text()
start = source.index('    if (saveIndicator != NULL && saveIndicator->IsActive()) {')
opening = source.index('{', start)
depth, end = 1, opening + 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
draw = source[start:end]
fixture = r'''
#include <cassert>
#include <cmath>
#include <cstring>
#include <string>
#define __EMSCRIPTEN__
int colorWhite=1;
int Sys_Microseconds() { return 123456; }
struct scaledGlyphInfo_t { float left=0, top=10, width=5, height=12, s1=0, t1=0, s2=1, t2=1; int material=7; };
struct Font {
    std::string text;
    float GetGlyphWidth(float scale, char) { assert(scale==0.3f); return 5; }
    void GetScaledGlyph(float scale, char c, scaledGlyphInfo_t&) { assert(scale==0.3f); text+=c; }
} font;
struct Renderer {
    int glyphs=0;
    int GetVirtualWidth() { return 640; }
    void SetColor(int) {}
    void DrawStretchPic(float x,float y,float w,float h,float,float,float,float,int material) {
        assert(x>=0 && x+w<=640 && y==28 && h==12 && material==7); ++glyphs;
    }
} renderer, *renderSystem=&renderer;
struct SWF {
    bool active=true; int renders=0, animations=0;
    bool IsActive() { return active; }
    void Render(Renderer*,int) { ++renders; }
    void RenderNamedSprite(Renderer*, const char* name,float x,float y,float scale,int time) {
        assert(!strcmp(name,"pacifier") && std::fabs(x-270.3f)<0.05f && y==24 && scale==0.2f && time==123456); ++animations;
    }
} indicator, animation;
SWF* saveIndicator=&indicator;
SWF* browserAutosaveIndicator=&animation;
Font* browserSaveFont=&font;
bool browserSavingAutomatically=true;
void draw() {
''' + draw + r'''
}
int main() {
    draw(); assert(font.text=="AUTOSAVING..." && renderer.glyphs==13 && animation.animations==1 && indicator.renders==0);
    browserSavingAutomatically=false; draw(); assert(indicator.renders==1 && animation.animations==1);
    indicator.active=false; draw(); assert(indicator.renders==1);
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('C++ compiler required')
with tempfile.TemporaryDirectory(prefix='doom-autosave-render-') as folder:
    cpp, exe = Path(folder) / 'check.cpp', Path(folder) / 'check.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
print('Actual autosave draw calls: centered native-font glyphs, pacifier sprite, manual fallback and hidden state pass (recording renderer, not visual acceptance).')
