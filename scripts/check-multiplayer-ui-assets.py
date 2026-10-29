"""Verify the shared retail HUD extraction and native preload boundary."""
import importlib.util
from pathlib import Path
import struct
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('prepare_ui', root / 'scripts/prepare-multiplayer-ui.py')
module = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='doom-shared-ui-') as folder:
    game = Path(folder)
    archive = game / 'base/maps/d3dm1.resources'
    archive.parent.mkdir(parents=True)
    payload = b'first-second'
    table = struct.pack('>I', 2)
    for name, offset, length in [(module.ASSETS[0], 12, 5), (module.ASSETS[1], 18, 6)]:
        encoded = name.encode()
        table += struct.pack('<I', len(encoded)) + encoded + struct.pack('>II', offset, length)
    archive.write_bytes(struct.pack('>III', 0xD000000D, 12 + len(payload), len(table)) + payload + table)
    first = module.prepare(game)
    assert sum(entry['bytes'] for entry in first.values()) == 11
    assert module.prepare(game) == first
    existing = game / 'base' / module.ASSETS[0]
    existing.write_bytes(b'owner modification')
    try:
        module.prepare(game)
        raise AssertionError('A modified asset was overwritten')
    except ValueError as error:
        assert 'differs' in str(error)
    assert existing.read_bytes() == b'owner modification'
    archive.write_bytes(struct.pack('>III', 0xD000000D, 9999999, 40))
    try:
        module.prepare(game)
        raise AssertionError('Invalid archive bounds accepted')
    except ValueError as error:
        assert 'bounds' in str(error)
with tempfile.TemporaryDirectory(prefix='doom-map-previews-') as folder:
    game = Path(folder)
    maps = game / 'base/maps'
    maps.mkdir(parents=True)
    previews = []
    for number in (1, 2):
        name = f'generated/images/guis/assets/loadscreens/d3dm{number}#__0200.bimage'
        previews.append(name)
        entries = list(module.ASSETS) + [name] if number == 1 else [name]
        payload = b''.join(bytes([65 + i]) * (i + 1) for i in range(len(entries)))
        table, offset = struct.pack('>I', len(entries)), 12
        for i, entry in enumerate(entries):
            encoded = entry.encode()
            table += struct.pack('<I', len(encoded)) + encoded + struct.pack('>II', offset, i + 1)
            offset += i + 1
        (maps / f'd3dm{number}.resources').write_bytes(
            struct.pack('>III', 0xD000000D, 12 + len(payload), len(table)) + payload + table)
    result = module.prepare(game, previews=True)
    assert set(previews).issubset(result)
    assert module.prepare(game, previews=True) == result
    original = (game / 'base' / previews[0]).read_bytes()
    (game / 'base' / previews[0]).write_bytes(b'custom image')
    try:
        module.prepare(game, previews=True)
        raise AssertionError('A modified thumbnail was overwritten')
    except ValueError as error:
        assert 'differs' in str(error)
    assert (game / 'base' / previews[0]).read_bytes() == b'custom image'
    assert original != b'custom image'
source = (root / 'engine/chocolate-doom3-bfg/neo/framework/Common_load.cpp').read_text()
preload = source.index('idSWF multiplayerMessagesPreload("mp_messages", soundWorld);')
assert source.index('renderSystem->BeginLevelLoad();') < preload < source.index('game->InitFromSaveGame(')
assert preload < source.index('game->InitFromNewMap(') < source.index('renderSystem->EndLevelLoad();')
print('Shared multiplayer HUD: bounded extraction, idempotence, modification preservation and preload-before-spawn order passed.')
