"""Build the app's still images: head-direction grid (sit) + lie + sleep, transparent WebP 512px."""
import os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from key import key_image, bbox, CROP_1024, OUT_SIZE

ROOT = os.path.join(os.path.dirname(__file__), '..')
GAZE_SRC = sys.argv[1] if len(sys.argv) > 1 else None   # dir with g_{c}_{r}.png green-screen edits
OUT = 512


def save(rgba, path):
    Image.fromarray(rgba).crop(CROP_1024).resize(OUT_SIZE, Image.LANCZOS).save(path, quality=90, method=6)


def pm(a):
    return np.concatenate([a[..., :3] * a[..., 3:] / 255, a[..., 3:]], -1)


os.makedirs(f'{ROOT}/assets/gaze', exist_ok=True)
os.makedirs(f'{ROOT}/assets/stills', exist_ok=True)
for n, src in [('sit', 'sit'), ('lie', 'lie'), ('sleep', 'sleep_side')]:
    save(key_image(f'{ROOT}/assets/keyframes/{src}.png'), f'{ROOT}/assets/stills/{n}.webp')

if GAZE_SRC:
    base = key_image(f'{ROOT}/assets/keyframes/sit.png').astype(np.float32)
    x0, y0, x1, y1 = bbox(base.astype(np.uint8))
    seam, feather = y0 + int(0.6 * (y1 - y0)), 70
    yy = np.arange(1024, dtype=np.float32)[:, None]
    w = np.clip((seam - yy) / feather + 0.5, 0, 1)[..., None]   # 1 = turned head, 0 = shared body
    for r in range(3):
        for c in range(5):
            src = f'{GAZE_SRC}/g_{c}_{r}.png'
            k = base if (c, r) == (2, 1) else key_image(src).astype(np.float32)
            out = pm(k) * w + pm(base) * (1 - w)
            a = out[..., 3:]
            rgb = np.where(a > 0, out[..., :3] * 255 / np.maximum(a, 1e-3), 0)
            save(np.clip(np.concatenate([rgb, a], -1), 0, 255).astype(np.uint8), f'{ROOT}/assets/gaze/{c}_{r}.webp')
print('ok')
