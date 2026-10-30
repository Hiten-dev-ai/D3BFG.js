"""Build audited, self-contained server packages; never copy a game directory.

Run from a built checkout. Downloads unmodified Node releases over HTTPS and
checks them against nodejs.org's published SHA-256 manifest before extraction.
"""
from pathlib import Path
import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'web/package.json').read_text())['version']
NODE = '24.18.0'
OUT = ROOT / 'dist/releases'
CACHE = ROOT / '.tools/release-runtime'
RUNTIME_FILES = ['server.js', 'serverConfig.js', 'accountSession.js', 'assetCompression.js',
    'multiplayerServer.js', 'privateSession.js', 'runtimeDiagnostics.js', 'saveSyncServer.js', 'sessionLease.js']
DENIED = {'.resources', '.bimage', '.bik', '.roq', '.pk4', '.wad', '.save', '.map', '.proc', '.cm', '.dds', '.tga'}

def sha(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()

def copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)

def audit(folder):
    files = list(folder.rglob('*'))
    for file in files:
        if file.is_symlink(): raise RuntimeError(f'Symlink in release: {file}')
        if not file.is_file(): continue
        rel = file.relative_to(folder)
        if file.suffix.lower() in DENIED or file.name in {'.env', 'accounts.json', 'snapshot.json'} or any(
            name in {'.git', '.runtime-trace', 'data', 'game', 'DOOM 3 BFG Edition'} for name in rel.parts):
            raise RuntimeError(f'Private/game data in release: {rel}')
        if file.stat().st_size < 5_000_000 and file.suffix in {'.js', '.json', '.md', '.txt', '.ps1', '.py'}:
            text = file.read_text(errors='replace')
            for marker in ['gho_', 'github_pat_', '-----BEGIN OPENSSH PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----']:
                if marker in text: raise RuntimeError(f'Secret marker in {rel}')
    return len([file for file in files if file.is_file()])

def payload(folder):
    if folder.exists(): raise RuntimeError(f'Refusing to overwrite existing staging folder: {folder}')
    folder.mkdir(parents=True)
    site = ROOT / 'dist/site'
    manifest = json.loads((site / 'engine-worker/build-info.json').read_text(encoding='utf-8-sig'))
    version = manifest['version']
    engine = site / 'engine-worker' / version
    if sha(engine / 'doom3_bfg_web.js')[:12] + sha(engine / 'doom3_bfg_web.wasm')[:12] != version:
        raise RuntimeError('Engine manifest/hash mismatch')
    for name in RUNTIME_FILES: copy(ROOT / 'web' / name, folder / 'web' / name)
    package = {'name': 'd3bfg-js-server', 'version': VERSION, 'private': True, 'type': 'module',
        'license': 'GPL-3.0-or-later', 'engines': {'node': '>=24.0.0'}, 'scripts': {'start': 'node server.js'},
        'dependencies': {'ws': json.loads((ROOT / 'web/node_modules/ws/package.json').read_text())['version']}}
    (folder / 'web/package.json').write_text(json.dumps(package, indent=2) + '\n')
    ws = ROOT / 'web/node_modules/ws'
    for file in ws.rglob('*'):
        if file.is_file(): copy(file, folder / 'web/node_modules/ws' / file.relative_to(ws))
    for name in ['index.html', 'offline-sw.js', 'brand.svg', 'favicon.ico', 'app-icon-32.png', 'app-icon-192.png', 'app-icon-512.png', 'brand-banner.webp', 'brand-square.webp']:
        copy(site / name, folder / 'dist/site' / name)
    for dirname in ['assets', 'fonts']:
        for file in (site / dirname).rglob('*'):
            if file.is_file(): copy(file, folder / 'dist/site' / file.relative_to(site))
    copy(site / 'engine-worker/build-info.json', folder / 'dist/site/engine-worker/build-info.json')
    for name in ['doom3_bfg_web.js', 'doom3_bfg_web.wasm']:
        copy(engine / name, folder / 'dist/site/engine-worker' / version / name)
    shaders = ROOT / 'engine/chocolate-doom3-bfg/base/renderprogs'
    for file in shaders.rglob('*'):
        if file.is_file(): copy(file, folder / 'engine/chocolate-doom3-bfg/base/renderprogs' / file.relative_to(shaders))
    for name in ['README.md', 'COPYING.txt', 'THIRD_PARTY_NOTICES.md', '.env.example']:
        copy(ROOT / name, folder / name)
    for name in ['SERVER_SETUP.md', 'CONFIGURATION.md', 'COOP_INVENTORY.md', f'RELEASE_{VERSION}.md']:
        copy(ROOT / 'docs' / name, folder / 'docs' / name)
    for file in (ROOT / 'docs/screenshots').glob('*.webp'):
        copy(file, folder / 'docs/screenshots' / file.name)
    copy(ROOT / 'web/public/brand-banner.webp', folder / 'web/public/brand-banner.webp')
    copy(ROOT / 'scripts/prepare-multiplayer-ui.py', folder / 'scripts/prepare-multiplayer-ui.py')
    copy(ROOT / 'third_party/libbinkdec/COPYING', folder / 'third_party/libbinkdec/COPYING')
    (folder / 'SOURCE.txt').write_text(f'Corresponding source: https://github.com/Hiten-dev-ai/D3BFG.js/releases/tag/v{VERSION}\nUse the source archive accompanying this release. No commercial assets included.\n')
    return version

def runtime(target, folder):
    CACHE.mkdir(parents=True, exist_ok=True)
    ext = 'zip' if target.startswith('win-') else 'tar.gz'
    name = f'node-v{NODE}-{target}.{ext}'
    base = f'https://nodejs.org/dist/v{NODE}/'
    sums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60).read().decode()
    expected = dict(line.split()[::-1] for line in sums.splitlines())[name]
    archive = CACHE / name
    if not archive.exists(): urllib.request.urlretrieve(base + name, archive)
    if sha(archive) != expected: raise RuntimeError(f'Node checksum mismatch: {name}')
    prefix = f'node-v{NODE}-{target}/'
    dest = folder / 'runtime'
    dest.mkdir()
    if ext == 'zip':
        with zipfile.ZipFile(archive) as bundle:
            for source, result in [('node.exe', 'node.exe'), ('LICENSE', 'LICENSE')]:
                (dest / result).write_bytes(bundle.read(prefix + source))
    else:
        with tarfile.open(archive) as bundle:
            for source, result in [('bin/node', 'node'), ('LICENSE', 'LICENSE')]:
                (dest / result).write_bytes(bundle.extractfile(prefix + source).read())
        (dest / 'node').chmod(0o755)
    return {'version': NODE, 'archive': name, 'sha256': expected}

def portable(target):
    name = f'd3bfg-js-{VERSION}-{target}'
    folder = OUT / name
    engine = payload(folder)
    node = runtime(target, folder)
    if target.startswith('win-'):
        (folder / 'start.cmd').write_bytes(b'@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0web\\server.js"\r\nif errorlevel 1 pause\r\n')
    else:
        (folder / 'start.sh').write_text('#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec ./runtime/node ./web/server.js\n', newline='\n')
        (folder / 'start.sh').chmod(0o755)
    count = audit(folder)
    (folder / 'BUILD.json').write_text(json.dumps({'project': 'D3BFG.js', 'version': VERSION, 'target': target,
        'engine': engine, 'node': node, 'filesAudited': count}, indent=2) + '\n')
    if target.startswith('win-'):
        archive = OUT / (name + '.zip')
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for file in folder.rglob('*'):
                if file.is_file(): bundle.write(file, name + '/' + file.relative_to(folder).as_posix())
    else:
        archive = OUT / (name + '.tar.gz')
        def unix_permissions(info):
            info.uid = info.gid = 0; info.uname = info.gname = 'root'
            info.mode = 0o755 if info.isdir() or info.name.endswith(('/runtime/node', '/start.sh')) else 0o644
            return info
        with tarfile.open(archive, 'w:gz') as bundle: bundle.add(folder, arcname=name, filter=unix_permissions)
    print(f'{archive.name}: {count} audited files; engine {engine}', flush=True)
    return folder

def tar_bytes(entries):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz', format=tarfile.PAX_FORMAT) as bundle:
        for name, content, mode in entries:
            item = tarfile.TarInfo(name); item.size = len(content); item.mode = mode; item.mtime = 0
            bundle.addfile(item, io.BytesIO(content))
    return data.getvalue()

def deb(folder):
    control = f'Package: d3bfg-js\nVersion: {VERSION}\nArchitecture: amd64\nMaintainer: Hiten-dev-ai <203151739+Hiten-dev-ai@users.noreply.github.com>\nSection: games\nPriority: optional\nDepends: libc6 (>= 2.28), libstdc++6, ca-certificates, adduser\nHomepage: https://github.com/Hiten-dev-ai/D3BFG.js\nDescription: Self-hosted D3BFG.js browser source-port server\n Includes Node runtime and engine; requires your own commercial game data.\n'
    postinst = '#!/bin/sh\nset -e\nif ! id d3bfg-js >/dev/null 2>&1; then adduser --system --group --home /var/lib/d3bfg-js --no-create-home d3bfg-js; fi\ninstall -d -m 750 -o d3bfg-js -g d3bfg-js /var/lib/d3bfg-js\nchown d3bfg-js:d3bfg-js /etc/d3bfg-js/server.env\nchmod 600 /etc/d3bfg-js/server.env\nif command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi\nprintf "%s\\n" "Configure /etc/d3bfg-js/server.env before enabling d3bfg-js.service."\n'
    prerm = '#!/bin/sh\nset -e\nif command -v systemctl >/dev/null 2>&1; then systemctl stop d3bfg-js.service || true; fi\n'
    controls = tar_bytes([('./control', control.encode(), 0o644), ('./conffiles', b'/etc/d3bfg-js/server.env\n', 0o644),
        ('./postinst', postinst.encode(), 0o755), ('./prerm', prerm.encode(), 0o755)])
    entries = []
    for file in folder.rglob('*'):
        if file.is_file(): entries.append(('./opt/d3bfg-js/' + file.relative_to(folder).as_posix(), file.read_bytes(),
            0o755 if file.name in {'node', 'start.sh'} else 0o644))
    env = (ROOT / '.env.example').read_text().replace('DOOM3BFG_ACCOUNTS_DIR=./data/accounts', 'DOOM3BFG_ACCOUNTS_DIR=/var/lib/d3bfg-js/accounts').replace('DOOM3BFG_SYNC_DIR=./data/saves', 'DOOM3BFG_SYNC_DIR=/var/lib/d3bfg-js/saves').replace('DOOM3BFG_ENCODED_DIR=./data/encoded-assets', 'DOOM3BFG_ENCODED_DIR=/var/lib/d3bfg-js/encoded-assets').replace('DOOM3BFG_GAME_DIR=./game', 'DOOM3BFG_GAME_DIR=/srv/d3bfg-game')
    unit = '[Unit]\nDescription=D3BFG.js server\nAfter=network.target\n[Service]\nType=simple\nUser=d3bfg-js\nGroup=d3bfg-js\nWorkingDirectory=/opt/d3bfg-js\nEnvironment=D3BFG_ENV_FILE=/etc/d3bfg-js/server.env\nExecStart=/opt/d3bfg-js/runtime/node /opt/d3bfg-js/web/server.js\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=/var/lib/d3bfg-js\n[Install]\nWantedBy=multi-user.target\n'
    entries.extend([('./etc/d3bfg-js/server.env', env.encode(), 0o600), ('./lib/systemd/system/d3bfg-js.service', unit.encode(), 0o644)])
    data = tar_bytes(entries)
    destination = OUT / f'd3bfg-js_{VERSION}_amd64.deb'
    with destination.open('wb') as file:
        file.write(b'!<arch>\n')
        for name, content in [('debian-binary', b'2.0\n'), ('control.tar.gz', controls), ('data.tar.gz', data)]:
            file.write(f'{name + "/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(content):<10}`\n'.encode('ascii'))
            file.write(content)
            if len(content) % 2: file.write(b'\n')
    print(destination.name, flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--target', choices=['all', 'win-x64', 'win-arm64', 'linux-x64'], default='all')
    parser.add_argument('--download-only', action='store_true')
    args = parser.parse_args(); OUT.mkdir(parents=True, exist_ok=True)
    targets = ['win-x64', 'win-arm64', 'linux-x64'] if args.target == 'all' else [args.target]
    for target in targets:
        if args.download_only:
            folder = CACHE / ('probe-' + target); folder.mkdir(parents=True, exist_ok=True)
            if not (folder / 'runtime').exists(): print(runtime(target, folder), flush=True)
            continue
        folder = portable(target)
        if target == 'linux-x64': deb(folder)
    archives = sorted(file for file in OUT.iterdir() if file.suffix in {'.zip', '.gz', '.deb'})
    (OUT / 'SHA256SUMS.txt').write_text(''.join(f'{sha(file)}  {file.name}\n' for file in archives))
