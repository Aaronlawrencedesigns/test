"""Head tiles for continuous head-tracking (both directions), built from the sweeps.

usage: python3 tools/build_head_tiles.py [UP_IN_BETWEEN=3] [DOWN_IN_BETWEEN=0]

Input:  assets/sweep/{row}_{i}.webp  (3 head heights x 33 left->right frames)
Output: assets/head/body.webp        shared sitting body (head faded out)
        assets/head/{R}_{i}.webp     head tiles, R = 0..(rows-1) top->bottom
        assets/head/meta.json        tile position/size and grid size

Between each pair of real head heights, extra heights are made with optical
flow: each pixel is moved part-way towards where it goes in the next height,
from both sides, then blended, so looking up/down is as smooth as looking
left/right. By default this is only done between "up" and "level": the "down"
sweep's head turn doesn't line up well enough and flow leaves ghost ears.
Tiles hold only the head region, so memory stays low; the app adds them onto
the shared body with additive blending (weights sum to 1).
"""
import json, os, sys
import numpy as np
import cv2
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from key import bbox

ROOT = os.path.join(os.path.dirname(__file__), '..')
KS = [int(sys.argv[1]) if len(sys.argv) > 1 else 3, int(sys.argv[2]) if len(sys.argv) > 2 else 0]
COLS = 33
OUT = f'{ROOT}/assets/head'
os.makedirs(OUT, exist_ok=True)


def load(p):
    return np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)


body_src = load(f'{ROOT}/assets/stills/sit.webp')
H, W = body_src.shape[:2]
bx0, by0, bx1, by1 = bbox(body_src.astype(np.uint8))
seam = by0 + int(0.6 * (by1 - by0))
feather = 45
w_head = np.clip((seam - np.arange(H, dtype=np.float32)[:, None]) / feather + 0.5, 0, 1)[..., None]

pm = lambda a: np.concatenate([a[..., :3] * a[..., 3:] / 255, a[..., 3:]], -1)


def unpm(o):
    a = o[..., 3:]
    return np.concatenate([np.where(a > 0.5, o[..., :3] * 255 / np.maximum(a, 1e-3), 0), a], -1)


def gray(p):  # premultiplied RGBA over mid grey -> 8-bit grey for flow
    g = p[..., :3].mean(-1) + (255 - p[..., 3]) * 0.5
    return np.clip(g, 0, 255).astype(np.uint8)


def flow(a, b):
    return cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 4, 21, 5, 7, 1.5, 0)


gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))


def warp(img, f, t):
    return cv2.remap(img, gx - t * f[..., 0], gy - t * f[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def interp(A, B, t):
    """A, B premultiplied RGBA float. Flow-based in-between at fraction t."""
    ga, gb = gray(A), gray(B)
    fab, fba = flow(ga, gb), flow(gb, ga)
    At = warp(A, fab, t)            # A pushed t of the way towards B
    Bt = warp(B, fba, 1 - t)        # B pulled back (1-t) towards A
    return (1 - t) * At + t * Bt


rows = []   # list of rows; each row = list of COLS premultiplied frames
row_v = []  # head height of each row: 0 = up, 1 = level, 2 = down
src = [[pm(load(f'{ROOT}/assets/sweep/{r}_{i}.webp')) for i in range(COLS)] for r in range(3)]
for r in range(3):
    rows.append(src[r]); row_v.append(float(r))
    if r < 2:
        K = KS[r]
        for k in range(1, K + 1):
            t = k / (K + 1)
            rows.append([interp(src[r][i], src[r + 1][i], t) for i in range(COLS)]); row_v.append(r + t)
        print(f'{K} in-betweens for heights {r}->{r + 1} done')

# head-only layers and their shared bounding box
heads = [[f * w_head for f in row] for row in rows]
mask = np.zeros((H, W), bool)
for row in heads:
    for h in row:
        mask |= h[..., 3] > 3
ys, xs = np.nonzero(mask)
x0, y0 = max(0, xs.min() - 4), max(0, ys.min() - 4)
x1, y1 = min(W, xs.max() + 5), min(H, ys.max() + 5)

for R, row in enumerate(heads):
    for i, h in enumerate(row):
        tile = np.clip(unpm(h[y0:y1, x0:x1]), 0, 255).astype(np.uint8)
        Image.fromarray(tile).save(f'{OUT}/{R}_{i}.webp', quality=88, method=6)
body = np.clip(unpm(pm(body_src) * (1 - w_head)), 0, 255).astype(np.uint8)
Image.fromarray(body).save(f'{OUT}/body.webp', quality=90, method=6)
json.dump({'rows': len(heads), 'rowV': row_v, 'cols': COLS, 'x': int(x0), 'y': int(y0), 'w': int(x1 - x0), 'h': int(y1 - y0), 'frame': W},
          open(f'{OUT}/meta.json', 'w'))
print(f'{len(heads)} heights x {COLS} = {len(heads) * COLS} tiles of {x1 - x0}x{y1 - y0} px')
