"""Reproduce the identified unsupported diagnostic rendering entry safely."""
from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path('engine/chocolate-doom3-bfg/neo/renderer/tr_backend_rendertools.cpp').read_text()
start = source.index('void RB_RenderDebugTools(')
opening = source.index('{', start)
end, depth = opening + 1, 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
function = source[start:end]
assert '#if defined(__EMSCRIPTEN__)' in function
assert 'RB_ShowDebugLines();' in function and '#else' in function
# Deliberately provide no desktop GL API or backEnd implementation. A web
# diagnostic frame must not resolve/call glLoadMatrixf/glBegin even with lines.
fixture = '#define __EMSCRIPTEN__\nstruct drawSurf_t {};\n' + function + '\nint main(){ drawSurf_t surf; drawSurf_t* list[]={&surf}; RB_RenderDebugTools(list,1); }\n'
compiler = shutil.which('clang++') or shutil.which('g++')
assert compiler
with tempfile.TemporaryDirectory(prefix='doom-webgl-debug-') as folder:
    cpp, exe = Path(folder) / 'test.cpp', Path(folder) / 'test.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
captured = Path('web/public/engine-worker/dcc2fed17c793437449de1c4/doom3_bfg_web.wasm')
if captured.exists():
    assert captured.read_bytes()[0x43c600:0x43c603] == bytes([0x11, 0x01, 0x00]), 'captured null-function PC must match the indirect GL call'
print('Identified WebGL crash path: debug renderer executes without any compatibility GL calls; desktop branch retained. Captured old trap PC verified when available.')
