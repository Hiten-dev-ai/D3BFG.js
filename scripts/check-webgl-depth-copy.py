"""Exercise the actual WebGL depth-copy method against a GL state recorder."""
from pathlib import Path
import shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[1]
source = (root/'engine/chocolate-doom3-bfg/neo/renderer/Image_load.cpp').read_text()
start = source.index('void idImage::CopyDepthbuffer(')
end = source.index('\n/*', start)
method = source[start:end]
constants = ['READ_FRAMEBUFFER_BINDING','DRAW_FRAMEBUFFER_BINDING','DEPTH_BITS','STENCIL_BITS',
 'DEPTH32F_STENCIL8','DEPTH24_STENCIL8','DEPTH_COMPONENT32F','DEPTH_COMPONENT24','DEPTH_COMPONENT16',
 'DEPTH_STENCIL','DEPTH_COMPONENT','FLOAT_32_UNSIGNED_INT_24_8_REV','UNSIGNED_INT_24_8','FLOAT','UNSIGNED_INT',
 'UNSIGNED_SHORT','TEXTURE_2D','TEXTURE_CUBE_MAP_EXT','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER','NEAREST',
 'TEXTURE_WRAP_S','TEXTURE_WRAP_T','CLAMP_TO_EDGE','DRAW_FRAMEBUFFER','READ_FRAMEBUFFER','DEPTH_ATTACHMENT',
 'STENCIL_ATTACHMENT','DEPTH_STENCIL_ATTACHMENT','NONE','SCISSOR_TEST','FRAMEBUFFER_COMPLETE','DEPTH_BUFFER_BIT']
harness = '#define __EMSCRIPTEN__ 1\n#include <cassert>\n#include <cstdio>\n'
harness += 'using GLenum=unsigned; using GLint=int; using GLuint=unsigned;\n'
harness += 'enum { '+','.join('GL_'+value for value in constants)+' };\n'
harness += r'''
enum { TT_CUBIC, TT_2D };
static int readBinding=3,drawBinding=4,allocations=0,copies=0,copyWidth=0,copyHeight=0;
static int depthBits=24,stencilBits=8; static bool scissor=true;
static GLenum allocatedFormat=0,allocatedType=0;
struct { struct { int c_copyFrameBuffer=0; } pc; } backEnd;
struct idImage { struct { int textureType=TT_2D,width=0,height=0; } opts;
 unsigned texnum=17; GLenum internalFormat=0; void CopyDepthbuffer(int,int,int,int); };
static void GL_BindTextureToCurrentUnit(GLenum,unsigned) {}
static void glGetIntegerv(GLenum name,GLint* value) {
 *value=name==GL_READ_FRAMEBUFFER_BINDING?readBinding:name==GL_DRAW_FRAMEBUFFER_BINDING?drawBinding:name==GL_DEPTH_BITS?depthBits:stencilBits;
}
static void glTexImage2D(GLenum,int,GLenum format,int,int,int,GLenum,GLenum type,const void*) {
 ++allocations; allocatedFormat=format; allocatedType=type;
}
static void glTexParameteri(GLenum,GLenum,GLenum) {}
static void glGenFramebuffers(int,GLuint* id) { *id=99; }
static void glBindFramebuffer(GLenum target,GLuint id) { (target==GL_READ_FRAMEBUFFER?readBinding:drawBinding)=id; }
static void glFramebufferTexture2D(GLenum,GLenum,GLenum,unsigned,int) {}
static void glDrawBuffers(int,const GLenum*) {}
static bool glIsEnabled(GLenum) { return scissor; }
static void glDisable(GLenum) { scissor=false; }
static void glEnable(GLenum) { scissor=true; }
static GLenum glCheckFramebufferStatus(GLenum) { return GL_FRAMEBUFFER_COMPLETE; }
static void glBlitFramebuffer(int x,int y,int x2,int y2,int,int,int w,int h,GLenum mask,GLenum filter) {
 assert(!scissor && readBinding==3 && drawBinding==99);
 assert(x2-x==w && y2-y==h && mask==GL_DEPTH_BUFFER_BIT && filter==GL_NEAREST);
 ++copies; copyWidth=w; copyHeight=h;
}
'''
harness += method
harness += r'''
int main() {
 idImage image; image.CopyDepthbuffer(5,7,640,480);
 assert(allocations==1 && copies==1 && copyWidth==640 && copyHeight==480);
 assert(allocatedFormat==GL_DEPTH24_STENCIL8 && allocatedType==GL_UNSIGNED_INT_24_8);
 assert(readBinding==3 && drawBinding==4 && scissor);
 image.CopyDepthbuffer(0,0,640,480); assert(allocations==1 && copies==2);
 scissor=false; depthBits=16; stencilBits=0; image.CopyDepthbuffer(0,0,320,240);
 assert(allocatedFormat==GL_DEPTH_COMPONENT16 && allocatedType==GL_UNSIGNED_SHORT);
 assert(readBinding==3 && drawBinding==4 && !scissor);
 assert(image.opts.width==320 && image.opts.height==240 && backEnd.pc.c_copyFrameBuffer==3);
 puts("WebGL depth copy: source format, stable allocation, full rectangle and GL state restoration passed.");
}
'''
with tempfile.TemporaryDirectory(prefix='doom-depth-copy-') as temporary:
 folder=Path(temporary); cpp=folder/'check.cpp'; executable=folder/'check.exe'
 cpp.write_text(harness)
 subprocess.run([shutil.which('g++') or 'g++','-std=c++17',str(cpp),'-o',str(executable)],check=True)
 subprocess.run([str(executable)],check=True)
