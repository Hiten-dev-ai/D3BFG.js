"""Create a fresh allowlisted publication tree without touching checkout history.

No engine binaries, game data, local deployment logs or credentials enter it.
The repo uses a pinned upstream submodule plus a complete browser patch. The
release source archive also contains the exact adapted engine source tree.
"""
from pathlib import Path
import hashlib
import argparse
import json
import re
import shutil
import subprocess
import tarfile

root = Path(__file__).resolve().parents[1]
destination = root / 'dist/public-source'
parser = argparse.ArgumentParser(); parser.add_argument('--refresh', action='store_true'); args = parser.parse_args()
if destination.exists() and not args.refresh: raise SystemExit('Publication tree already exists; review it or explicitly --refresh the allowlisted files.')
destination.mkdir(parents=True, exist_ok=True)

def copy(file, relative=None):
    relative = relative or file.relative_to(root)
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if file.suffix == '.ps1':
        # RTK is a local log wrapper, never a dependency of public build tools.
        target.write_bytes(file.read_bytes().replace(b'& rtk proxy ', b'& '))
    else:
        shutil.copyfile(file, target)

for name in ['README.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'COPYING.txt', '.gitignore', '.gitattributes', '.gitmodules', '.env.example', 'CMakeLists.txt', 'CMakePresets.json']:
    copy(root / name)
for name in ['SERVER_SETUP.md', 'COOP_INVENTORY.md', 'RELEASE_0.2.0.md']:
    copy(root / 'docs' / name)
for folder in ['wasm', 'third_party', 'patches', 'web/src']:
    for file in (root / folder).rglob('*'):
        if file.is_file() and '.git' not in file.parts: copy(file)
for file in (root / 'web').iterdir():
    if file.is_file() and file.suffix in {'.js', '.json', '.html', '.ts'}: copy(file)
for file in (root / 'web/scripts').glob('*.mjs'): copy(file)
for name in ['offline-sw.js', 'brand.svg', 'fonts/Rajdhani-SemiBold.ttf', 'fonts/OFL.txt']:
    copy(root / 'web/public' / name)
for file in (root / 'scripts').iterdir():
    if file.is_file() and not file.name.startswith(('.', 'deploy-')) and file.suffix in {'.py', '.ps1', '.cjs', '.mjs'}: copy(file)

denied = {'.resources', '.pk4', '.wad', '.bik', '.roq', '.bimage', '.save', '.wasm', '.exe', '.jpg', '.png'}
for file in destination.rglob('*'):
    if not file.is_file(): continue
    if file.suffix in denied or file.name in {'.env', 'accounts.json', 'snapshot.json'}: raise SystemExit(f'Forbidden file: {file}')
    if file.suffix not in {'.ttf'}:
        text = file.read_text(errors='replace')
        for pattern in [r'gh[opusr]_[A-Za-z0-9]{30,}', r'github_pat_[A-Za-z0-9_]{40,}', r'-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----\r?\n']:
            if re.search(pattern, text): raise SystemExit(f'Secret pattern in {file}')

engine = root / 'engine/chocolate-doom3-bfg'
revision = subprocess.check_output(['git', '-C', str(engine), 'rev-parse', 'HEAD'], text=True).strip()
subprocess.run(['git', 'init', '--initial-branch=main', str(destination)], check=True, capture_output=True)
subprocess.run(['git', '-C', str(destination), '-c', 'core.autocrlf=false', 'add', '.'], check=True, capture_output=True)
subprocess.run(['git', '-C', str(destination), 'update-index', '--add', '--cacheinfo', f'160000,{revision},engine/chocolate-doom3-bfg'], check=True)

out = root / 'dist/releases'; out.mkdir(parents=True, exist_ok=True)
archive = out / 'd3bfg-js-0.2.0-source.tar.gz'
with tarfile.open(archive, 'w:gz') as bundle:
    for file in destination.rglob('*'):
        if file.is_file() and '.git' not in file.relative_to(destination).parts:
            bundle.add(file, arcname='D3BFG.js/' + file.relative_to(destination).as_posix())
    names = subprocess.check_output(['git', '-C', str(engine), 'ls-files', '-z']).decode().split('\0')
    names += subprocess.check_output(['git', '-C', str(engine), 'ls-files', '--others', '--exclude-standard', '-z']).decode().split('\0')
    for name in sorted(set(filter(None, names))):
        file = engine / name
        if file.is_file():
            if file.suffix.lower() in (denied - {'.png', '.jpg'}) or file.name == '.env': raise SystemExit(f'Unexpected engine source asset: {name}')
            bundle.add(file, arcname='D3BFG.js/engine/chocolate-doom3-bfg/' + name)
print(json.dumps({'publication': str(destination), 'engineBase': revision, 'sourceArchive': str(archive),
    'sourceSha256': hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()}))
