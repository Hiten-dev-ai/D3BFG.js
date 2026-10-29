"""Audit distributable archives and regenerate checksums after the source export."""
from pathlib import Path, PurePosixPath
import hashlib
import io
import json
import tarfile
import zipfile

root = Path(__file__).resolve().parents[1] / 'dist/releases'
files = ['d3bfg-js-0.2.0-win-x64.zip', 'd3bfg-js-0.2.0-win-arm64.zip',
         'd3bfg-js-0.2.0-linux-x64.tar.gz', 'd3bfg-js_0.2.0_amd64.deb', 'd3bfg-js-0.2.0-source.tar.gz']
if not all((root / name).is_file() for name in files):
    print('SKIP release archive checks: build all server packages and export source first.'); raise SystemExit(0)
denied = {'.resources', '.bimage', '.bik', '.roq', '.pk4', '.wad', '.save', '.dds', '.tga'}
versions = set()

def check_names(names, binary=True):
    for name in names:
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts, name
        assert path.suffix.lower() not in denied, name
        assert path.name not in {'.env', 'accounts.json', 'snapshot.json'}, name
        assert not any(part in {'.git', '.runtime-trace', 'DOOM 3 BFG Edition'} for part in path.parts), name
        if binary: assert path.suffix.lower() not in {'.png', '.jpg', '.map', '.proc', '.cm'}, name

def check_worker(names, read):
    manifest_name = next(name for name in names if name.endswith('/dist/site/engine-worker/build-info.json'))
    parent = manifest_name.rsplit('/', 1)[0]
    manifest = json.loads(read(manifest_name).decode('utf-8-sig'))
    version = manifest['version']; versions.add(version)
    pair = [hashlib.sha256(read(parent + '/' + manifest[key])).hexdigest()[:12] for key in ['modulePath', 'wasmPath']]
    assert ''.join(pair) == version
    assert any(name.endswith('/runtime/LICENSE') for name in names)
    assert any(name.endswith('/web/node_modules/ws/LICENSE') for name in names)
    assert any(name.endswith('/COPYING.txt') for name in names)
    assert any(name.endswith('/fonts/OFL.txt') for name in names)

for name in files:
    file = root / name
    if name.endswith('.zip'):
        with zipfile.ZipFile(file) as archive:
            assert archive.testzip() is None
            names = archive.namelist(); check_names(names); check_worker(names, archive.read)
    elif name.endswith('.deb'):
        with file.open('rb') as stream:
            assert stream.read(8) == b'!<arch>\n'; members = {}
            while header := stream.read(60):
                size = int(header[48:58]); member = header[:16].decode().strip().rstrip('/')
                members[member] = stream.read(size)
                if size % 2: stream.read(1)
        assert members['debian-binary'] == b'2.0\n'
        with tarfile.open(fileobj=io.BytesIO(members['data.tar.gz'])) as archive:
            names = archive.getnames(); check_names(names)
            check_worker(names, lambda name: archive.extractfile(name).read())
            env = archive.extractfile('./etc/d3bfg-js/server.env').read().decode()
            assert '\nFIRST_PASSWORD=\n' in env
            assert archive.getmember('./opt/d3bfg-js/runtime/node').mode & 0o111
    else:
        with tarfile.open(file) as archive:
            names = archive.getnames(); source = name.endswith('-source.tar.gz'); check_names(names, not source)
            if source:
                assert any(name.endswith('/engine/chocolate-doom3-bfg/neo/d3xp/Game_local.cpp') for name in names)
                assert any(name.endswith('/third_party/libbinkdec/src/BinkDecoder.cpp') for name in names)
            else:
                check_worker(names, lambda name: archive.extractfile(name).read())
                for member in archive.getmembers():
                    if member.name.endswith(('/runtime/node', '/start.sh')): assert member.mode & 0o111
    print(f'PASS {name}')
assert len(versions) == 1, versions
(root / 'SHA256SUMS.txt').write_text(''.join(f'{hashlib.file_digest((root/name).open("rb"), "sha256").hexdigest()}  {name}\n' for name in files))
print('All payloads use engine', versions.pop(), '; no commercial resources, real credentials or save/account data; license/source/executable checks passed.')
