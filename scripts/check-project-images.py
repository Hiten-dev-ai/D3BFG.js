from pathlib import Path
from PIL import Image, ImageChops

root=Path(__file__).resolve().parents[1]
for size in [32,192,512]:
    image=Image.open(root/f'web/public/app-icon-{size}.png');assert image.size==(size,size)
assert Image.open(root/'web/public/brand-square.webp').size==(1024,1024)
assert Image.open(root/'web/public/brand-banner.webp').size==(1024,572)
inputs=root/'.runtime-trace/user-artwork-20261030'
for index,name,rectangle in [(1,'settings.webp',(188,61,398,97)),(2,'main-menu.webp',None),(3,'multiplayer.webp',(188,61,398,97)),(6,'game-selector.webp',(188,10,398,47)),(7,'mars-city.webp',(188,61,398,97))]:
    output=Image.open(root/'docs/screenshots'/name).convert('RGB')
    if rectangle:assert output.crop(rectangle).getbbox() is None,'URL redaction must be solid black'
    if inputs.exists():
        original=Image.open(inputs/f'attachment-{index}.jpg').convert('RGB');assert output.size==original.size
        difference=ImageChops.difference(original,output)
        if rectangle:
            from PIL import ImageDraw
            ImageDraw.Draw(difference).rectangle((rectangle[0],rectangle[1],rectangle[2]-1,rectangle[3]-1),fill='black')
        assert difference.getbbox() is None,'Screenshots must be unchanged outside address redaction'
print('Supplied favicon/background aspect ratios verified; screenshots preserve original pixels/dimensions except solid-black address-bar redaction.')
