from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path('engine/chocolate-doom3-bfg/neo/framework/Console.cpp').read_text()
start = source.index('static int SampleWebFPS(')
opening = source.index('{', start)
end, depth = opening + 1, 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
fixture = '#include <cassert>\n' + source[start:end] + r'''
int main() {
 assert(SampleWebFPS(0)==-1);
 for (int t=10;t<500;t+=10) assert(SampleWebFPS(t)==-1);
 assert(SampleWebFPS(500)==100);
 for (int t=520;t<1000;t+=20) assert(SampleWebFPS(t)==100);
 assert(SampleWebFPS(1000)==50);
 assert(SampleWebFPS(4000)==-1); // background/resume starts a fresh window
 for (int t=4010;t<4500;t+=10) assert(SampleWebFPS(t)==-1);
 assert(SampleWebFPS(4500)==100);
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
assert compiler
with tempfile.TemporaryDirectory(prefix='doom-readable-fps-') as folder:
    cpp, exe = Path(folder) / 'test.cpp', Path(folder) / 'test.exe'
    cpp.write_text(fixture)
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
assert 'digitWidth' in source and '"%3d FPS"' in source
print('Actual FPS sampler: half-second measurements, stable display between updates, resume reset and fixed digit spacing passed.')
