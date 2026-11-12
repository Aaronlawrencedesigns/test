"""Crisp head-tracking frames: real video frames only, never blended.

usage: python3 tools/build_look_frames.py

Input:  assets/sweep/{row}_{i}.webp   (full frames from tools/build_sweeps.py)
Output: assets/look/{row}_{i}.webp    the same frames cropped to the area the dog
                                     ever covers (saves memory), plus meta.json

The app shows exactly one of these at a time (head and body from the same video
frame), so there is never a blended or ghosted in-between.
"""
import glob, json, os, re
import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..')
files = sorted(glob.glob(f'{ROOT}/assets/sweep/*_*.webp'))
idx = [tuple(map(int, re.findall(r'(\d+)_(\d+)\.webp$', f)[0])) for f in files]
rows, cols = max(r for r, _ in idx) + 1, max(i for _, i in idx) + 1
ims = {k: np.asarray(Image.open(f).convert('RGBA')) for k, f in zip(idx, files)}
H, W = next(iter(ims.values())).shape[:2]
mask = np.zeros((H, W), bool)
for a in ims.values():
    mask |= a[..., 3] > 2
ys, xs = np.nonzero(mask)
x0, y0 = max(0, xs.min() - 2), max(0, ys.min() - 2)
x1, y1 = min(W, xs.max() + 3), min(H, ys.max() + 3)
os.makedirs(f'{ROOT}/assets/look', exist_ok=True)
for (r, i), a in ims.items():
    Image.fromarray(a[y0:y1, x0:x1]).save(f'{ROOT}/assets/look/{r}_{i}.webp', quality=90, method=6)
meta = {'rows': rows, 'cols': cols, 'x': int(x0), 'y': int(y0), 'w': int(x1 - x0), 'h': int(y1 - y0), 'frame': W}
json.dump(meta, open(f'{ROOT}/assets/look/meta.json', 'w'))
print(meta, f'{len(ims)} frames')
