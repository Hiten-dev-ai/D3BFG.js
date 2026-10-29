"""Compile and exercise the actual patched SDL input and browser sizing code.

No game, browser profile, GPU, licensed assets, or running server is needed.
Temporary compiler outputs stay inside this workspace and are removed on exit.
"""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
sdk = root / '.tools/emsdk/upstream/emscripten'


def function(source: str, signature: str) -> str:
    start = source.index(signature)
    brace = source.index('{', start)
    depth = 1
    end = brace + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


sdl = sdk / 'cache/ports/sdl2/SDL-release-2.32.10/src/video/emscripten/SDL_emscriptenevents.c'
motion = function(sdl.read_text(), 'static EM_BOOL Emscripten_HandleMouseMove(')
assert 'stable_pointerlock' in motion, 'Build once to prepare the patched SDL port.'
surface = function((root / 'engine/chocolate-doom3-bfg/neo/sys/sdl/sdl_glimp.cpp').read_text(),
                   'bool GLimp_SyncBrowserDisplay()')
harness = r'''
#include <cassert>
#include <cstdio>
using SDL_bool = int;
using EM_BOOL = int;
constexpr int SDL_FALSE = 0;
struct SDL_Window { int w, h; } testWindow = {1920, 1080};
static SDL_Window* window = &testWindow;
struct SDL_WindowData { SDL_Window* window; bool has_pointer_lock; const char* canvas_id; };
struct EmscriptenMouseEvent { double movementX, movementY; int targetX, targetY; };
static double cssW = 1920, cssH = 1080;
static bool stable = true, relative = true;
static int sent = 0, deltaX = 0, deltaY = 0, sentRelative = 0;
static SDL_bool SDL_GetHintBoolean(const char*, SDL_bool) { return stable; }
static SDL_bool SDL_GetRelativeMouseMode() { return relative; }
static void emscripten_get_element_css_size(const char*, double* w, double* h) { *w = cssW; *h = cssH; }
static void SDL_SendMouseMotion(SDL_Window*, int, int rel, int x, int y) { ++sent; sentRelative = rel; deltaX = x; deltaY = y; }
static int desired[4] = {2, 1920, 1080, 1}, sizeCalls = 0;
static bool ReadBrowserDisplay(int (&s)[4]) { for (int i=0; i<4; ++i) s[i]=desired[i]; return true; }
static void SDL_GetWindowSize(SDL_Window* w, int* x, int* y) { *x=w->w; *y=w->h; }
static void SDL_SetWindowSize(SDL_Window* w, int x, int y) { ++sizeCalls; w->w=x; w->h=y; }
struct CVar { int value=0; int GetInteger() const { return value; } void SetInteger(int v) { value=v; } };
static CVar r_windowWidth, r_windowHeight, r_fullscreen;
static struct { int nativeScreenWidth=1920, nativeScreenHeight=1080, isFullscreen=0; } glConfig;
'''
harness += motion.replace('SDL_WindowData *window_data = userData;',
                          'SDL_WindowData *window_data = (SDL_WindowData*)userData;')
harness += '\n' + surface
harness += r'''
int main() {
    SDL_WindowData data = {window, true, "#canvas"};
    EmscriptenMouseEvent event = {16, -8, 9999, 9999};
    for (int width : {1920, 1280, 720}) {
        window->w = width; window->h = width * 9 / 16;
        cssW = 1000; cssH = 600;
        Emscripten_HandleMouseMove(0, &event, &data);
        assert(sentRelative && deltaX == 16 && deltaY == -8);
    }
    int before = sent;
    data.has_pointer_lock = false;
    Emscripten_HandleMouseMove(0, &event, &data);
    assert(sent == before); // Cursor relocation during lock loss cannot aim.
    relative = false; // Absolute native menus still receive scaled positions.
    window->w = 2000; window->h = 1200;
    event.targetX = 100; event.targetY = 50;
    Emscripten_HandleMouseMove(0, &event, &data);
    assert(!sentRelative && deltaX == 200 && deltaY == 100);
    relative = true; data.has_pointer_lock = true;
    event.movementX = 0.25; event.movementY = -0.25;
    int sumX=0, sumY=0;
    for (int i=0; i<4; ++i) {
        Emscripten_HandleMouseMove(0, &event, &data);
        sumX += deltaX; sumY += deltaY;
    }
    assert(sumX == 1 && sumY == -1);
    desired[1] = 1600; desired[2] = 900;
    assert(GLimp_SyncBrowserDisplay());
    assert(window->w == 1600 && window->h == 900 && r_fullscreen.value == 1);
    assert(glConfig.nativeScreenWidth == 1600 && glConfig.nativeScreenHeight == 900);
    int calls = sizeCalls;
    assert(!GLimp_SyncBrowserDisplay() && calls == sizeCalls);
    desired[3] = 0; // Same-sized window still updates mode without a resize.
    assert(!GLimp_SyncBrowserDisplay() && glConfig.isFullscreen == 0 && r_fullscreen.value == 0);
    window->w = 800; // Repair late foreign sizing even if publication did not change.
    GLimp_SyncBrowserDisplay();
    assert(window->w == 1600 && calls + 1 == sizeCalls);
    puts("Native display/input: resolution-independent aim, lock-loss quarantine, subpixel motion and coherent resizing passed.");
}
'''
harness = '#include <initializer_list>\n' + harness
trace = root / '.runtime-trace'
trace.mkdir(exist_ok=True)
env = os.environ.copy()
python = root / '.tools/emsdk/python/3.13.3_64bit/python.exe'
node = root / '.tools/emsdk/node/24.19.0_64bit/node.exe'
env.update(EMSDK_PYTHON=str(python), EMSDK_NODE=str(node))
with tempfile.TemporaryDirectory(prefix='native-display-check-', dir=trace) as folder:
    temporary = Path(folder).resolve()
    assert temporary.is_relative_to(trace.resolve())
    source = temporary / 'check.cpp'
    output = temporary / 'check.cjs'
    source.write_text(harness)
    subprocess.run([str(python), str(sdk / 'em++.py'), str(source), '-O1',
                    '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1', '-o', str(output)],
                   env=env, check=True, timeout=120)
    subprocess.run([str(node), str(output)], check=True, timeout=20)
