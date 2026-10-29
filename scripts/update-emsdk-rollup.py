"""Record the local SDK adaptation against the official pinned Emscripten tag.

The PowerShell patch installer remains the executable source of the adaptation.
This review diff includes all touched SDK files, including audio and display.
"""
from concurrent.futures import ThreadPoolExecutor
import difflib
from pathlib import Path
from urllib.request import urlopen

root = Path(__file__).resolve().parent.parent
sdk = root / '.tools/emsdk/upstream/emscripten'
version = (sdk / 'emscripten-version.txt').read_text().strip().strip('"')
if version != '6.0.13':
    raise SystemExit(f'Unsupported SDK version: {version}')
paths = ['src/runtime_pthread.js', 'tools/ports/sdl2.py'] + [f'src/lib/{name}.js' for name in (
    'libpthread', 'libworkerfs', 'libsyscall', 'libwasi', 'libidbfs',
    'libegl', 'libwebgl', 'libopenal')]


def diff(path: str) -> str:
    url = f'https://raw.githubusercontent.com/emscripten-core/emscripten/{version}/{path}'
    with urlopen(url, timeout=30) as response:
        original = response.read().decode('utf-8').splitlines(keepends=True)
    current = (sdk / path).read_text(encoding='utf-8-sig').splitlines(keepends=True)
    return ''.join(difflib.unified_diff(original, current,
        fromfile=f'a/{path}', tofile=f'b/{path}'))


with ThreadPoolExecutor(max_workers=4) as pool:
    patch = ''.join(pool.map(diff, paths))
destination = root / 'patches/emsdk/workerfs-pthread-staged-files.patch'
destination.write_text(patch, encoding='utf-8', newline='\n')
print(f'Updated {destination.name}: {len(patch.encode()):,} bytes, official SDK {version}')
