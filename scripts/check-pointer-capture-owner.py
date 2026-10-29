"""Exercise the actual opt-in SDL capture backend without a browser or game."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source_root = root / '.tools/emsdk/upstream/emscripten/cache/ports/sdl2/SDL-release-2.32.10/src/video/emscripten'


def function(source, signature):
    start = source.index(signature)
    brace = source.index('{', start)
    depth, end = 1, brace + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


backend = function((source_root / 'SDL_emscriptenmouse.c').read_text(),
                   'static int Emscripten_SetRelativeMouseMode(')
button = function((source_root / 'SDL_emscriptenevents.c').read_text(),
                  'static EM_BOOL Emscripten_HandleMouseButton(')
# C permits this implicit void-pointer conversion; the fixture uses C++ asserts.
button = button.replace('SDL_WindowData *window_data = userData;',
                        'SDL_WindowData *window_data = static_cast<SDL_WindowData*>(userData);')
assert 'DOOM3_BROWSER_DOM_POINTERLOCK' in backend and 'DOOM3_BROWSER_DOM_POINTERLOCK' in button
harness = r'''
#include <cassert>
#include <cstdio>
using SDL_bool = int;
using EM_BOOL = int;
using Uint8 = unsigned char;
using SDL_EventType = int;
enum { SDL_FALSE, SDL_ENABLE, SDL_PRESSED, SDL_RELEASED, SDL_MOUSEBUTTONDOWN,
       SDL_MOUSEBUTTONUP, EMSCRIPTEN_EVENT_MOUSEDOWN, SDL_BUTTON_LEFT,
       SDL_BUTTON_MIDDLE, SDL_BUTTON_RIGHT };
constexpr int EMSCRIPTEN_RESULT_SUCCESS = 0;
struct SDL_Window { void* driverdata; } window;
struct SDL_WindowData { SDL_Window* window; bool has_pointer_lock; const char* canvas_id; } data = {&window, false, "#canvas"};
struct EmscriptenMouseEvent { int button = 0, targetX = 20, targetY = 20; } event;
struct Mouse { bool relative_mode = true; } mouse;
static bool domOwner = true;
static int requests = 0, releases = 0, buttonEvents = 0;
static SDL_bool SDL_GetHintBoolean(const char*, SDL_bool) { return domOwner; }
static SDL_Window* SDL_GetMouseFocus() { return &window; }
static Mouse* SDL_GetMouse() { return &mouse; }
static int emscripten_request_pointerlock(const char*, int) { ++requests; return 0; }
static int emscripten_exit_pointerlock() { ++releases; return 0; }
static int SDL_GetEventState(SDL_EventType) { return SDL_ENABLE; }
static void SDL_SendMouseButton(SDL_Window*, int, Uint8, Uint8) { ++buttonEvents; }
static void emscripten_get_element_css_size(const char*, double* w, double* h) { *w=640; *h=480; }
'''
harness += backend + '\n' + button + r'''
int main() {
    window.driverdata = &data;
    assert(Emscripten_SetRelativeMouseMode(1) == 0);
    assert(Emscripten_SetRelativeMouseMode(0) == 0);
    Emscripten_HandleMouseButton(EMSCRIPTEN_EVENT_MOUSEDOWN, &event, &data);
    assert(requests == 0 && releases == 0 && buttonEvents == 1);
    domOwner = false;
    assert(Emscripten_SetRelativeMouseMode(1) == 0 && requests == 1);
    Emscripten_HandleMouseButton(EMSCRIPTEN_EVENT_MOUSEDOWN, &event, &data);
    assert(requests == 2 && buttonEvents == 2);
    assert(Emscripten_SetRelativeMouseMode(0) == 0 && releases == 1);
    puts("SDL capture ownership: DOM opt-in avoids duplicate requests; legacy capture and button delivery remain intact.");
}
'''
compiler = shutil.which('g++') or shutil.which('clang++')
if not compiler:
    raise SystemExit('A C++ compiler is required.')
trace = root / '.runtime-trace'
trace.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='capture-owner-check-', dir=trace) as folder:
    temporary = Path(folder).resolve()
    assert temporary.is_relative_to(trace.resolve())
    cpp, exe = temporary / 'check.cpp', temporary / 'check.exe'
    cpp.write_text(harness, encoding='utf-8')
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
