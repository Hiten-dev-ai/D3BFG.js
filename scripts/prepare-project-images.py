"""Prepare explicitly supplied project artwork and redact screenshot address bars.

Input is the seven attachments from the project owner, in their supplied order.
Screenshots retain their full original dimensions; only address text is blacked
out. This script never reads a browser profile or any commercial game archive.
Requires Pillow. Output branding/screenshots are explicitly allowlisted by the
public source exporter and release audit, separately from forbidden game data.
"""
from pathlib import Path
import argparse
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument('--attachments-dir', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
public = root / 'web/public'
screens = root / 'docs/screenshots'
screens.mkdir(parents=True, exist_ok=True)

wide = Image.open(args.attachments_dir / 'attachment-4.jpg').convert('RGB')
wide.save(public / 'brand-banner.webp', quality=92, method=6)
square = Image.open(args.attachments_dir / 'attachment-5.jpg').convert('RGB')
assert square.width == square.height
square.save(public / 'brand-square.webp', quality=92, method=6)
for size in [32, 192, 512]:
    square.resize((size, size), Image.Resampling.LANCZOS).save(public / f'app-icon-{size}.png', optimize=True)
square.save(public / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])

# Rectangles cover only address text. No cropping, rescaling or account-name edits.
for index, name, rectangle in [
    (1, 'settings.webp', (188, 61, 397, 96)),
    (2, 'main-menu.webp', None),
    (3, 'multiplayer.webp', (188, 61, 397, 96)),
    (6, 'game-selector.webp', (188, 10, 397, 46)),
    (7, 'mars-city.webp', (188, 61, 397, 96)),
]:
    image = Image.open(args.attachments_dir / f'attachment-{index}.jpg').convert('RGB')
    if rectangle: ImageDraw.Draw(image).rectangle(rectangle, fill='black')
    image.save(screens / name, lossless=True, method=6)
    print(f'{name}: {image.width}x{image.height}; address redacted={rectangle is not None}')
