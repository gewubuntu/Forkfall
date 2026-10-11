"""
Web copies of the generated Poncho artwork: packages/art/assets/poncho/<id>.jpg|png -> apps/web/src/assets/poncho/<id>.webp,
384x384 (sharp up to the 260 px zoom view at 1.5x; cards on the board are far smaller). The web app loads these as
separate, lazily fetched files instead of the base64 copies in ponchoImages.ts, which stay for metadata and token images.
  pnpm art:poncho-web   (needs Python 3 with Pillow)
"""
import pathlib, re
from PIL import Image

root = pathlib.Path(__file__).resolve().parents[3]
src = root / 'packages/art/assets/poncho'
out = root / 'apps/web/src/assets/poncho'
out.mkdir(parents=True, exist_ok=True)
n = 0
for f in sorted(src.iterdir()):
    if not re.fullmatch(r'\d+\.(jpe?g|png)', f.name, re.I):
        continue
    im = Image.open(f).convert('RGB').resize((384, 384), Image.LANCZOS)
    im.save(out / f'{f.stem}.webp', 'WEBP', quality=80, method=6)
    n += 1
print(f'wrote {n} webp image(s) to {out.relative_to(root)}')
