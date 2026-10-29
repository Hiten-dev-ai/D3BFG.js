"""Extract the shared multiplayer HUD from the owner's installed retail archive."""
import argparse
import hashlib
import json
from pathlib import Path
import struct

ASSETS = (
    'generated/swf/mp_messages.bswf',
    'generated/images/generated/swf/mp_messages#__0200.bimage',
)


def read_assets(archive, names):
    size = archive.stat().st_size
    payloads = {}
    with archive.open('rb') as stream:
        magic, offset, length = struct.unpack('>III', stream.read(12))
        if magic != 0xD000000D or offset < 12 or not 4 <= length <= 1048576 or offset > size - length:
            raise ValueError('Invalid multiplayer resource table bounds')
        stream.seek(offset)
        table = stream.read(length)
        count = struct.unpack_from('>I', table)[0]
        if count > (length - 4) // 12:
            raise ValueError('Invalid multiplayer resource entry count')
        cursor = 4
        for _ in range(count):
            name_length = struct.unpack_from('<I', table, cursor)[0]
            cursor += 4
            if not 1 <= name_length <= 4096 or cursor > length - name_length - 8:
                raise ValueError('Invalid multiplayer resource name bounds')
            name = table[cursor:cursor + name_length].decode('utf-8')
            cursor += name_length
            start, amount = struct.unpack_from('>II', table, cursor)
            cursor += 8
            if start > size or amount > size - start:
                raise ValueError('Invalid multiplayer resource payload bounds')
            if name in names:
                if name in payloads or not 1 <= amount <= 1048576:
                    raise ValueError('Invalid shared multiplayer UI payload')
                stream.seek(start)
                payloads[name] = stream.read(amount)
    if set(payloads) != set(names):
        raise ValueError('Retail multiplayer HUD assets were not found')
    return payloads


def prepare(game_dir, previews=False):
    base = Path(game_dir).resolve(strict=True) / 'base'
    payloads = read_assets(base / 'maps/d3dm1.resources', ASSETS)
    if previews:
        # These are small menu thumbnails, not the map archives themselves.
        for archive in sorted((base / 'maps').glob('d3dm[0-9]*.resources')):
            name = f'generated/images/guis/assets/loadscreens/{archive.stem}#__0200.bimage'
            payloads.update(read_assets(archive, (name,)))
    # Never overwrite an installed modification with different contents.
    for name, data in payloads.items():
        target = base / name
        if target.is_symlink() or not target.resolve().is_relative_to(base.resolve()):
            raise ValueError('Shared UI target must remain inside the game directory')
        if target.exists() and target.read_bytes() != data:
            raise ValueError(f'Existing shared UI differs: {name}')
    for name, data in payloads.items():
        target = base / name
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                output.write(data)
    return {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in payloads.items()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir', type=Path, required=True)
    parser.add_argument('--previews', action='store_true', help='also prepare multiplayer map menu thumbnails')
    args = parser.parse_args()
    print(json.dumps(prepare(args.game_dir, args.previews)))
