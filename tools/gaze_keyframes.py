"""Green-screen 1024px keyframes of the far-left / far-right head directions
(turned head composited onto the shared sitting body), used as first/last frames
for the head-sweep videos.  usage: python3 tools/gaze_keyframes.py GAZE_SRC_DIR [HEIGHT ...]
(HEIGHT = suffix of g_{col}_{HEIGHT}.png: 0 1 2 by default, or e.g. hu hd;
 set COLS=0,2,4 to choose which head directions, default 0,4)"""
import os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from key import key_image, bbox, on_green

ROOT = os.path.join(os.path.dirname(__file__), '..')
src = sys.argv[1]
base = key_image(f'{ROOT}/assets/keyframes/sit.png').astype(np.float32)
x0, y0, x1, y1 = bbox(base.astype(np.uint8))
seam, feather = y0 + int(0.6 * (y1 - y0)), 70
w = np.clip((seam - np.arange(1024, dtype=np.float32)[:, None]) / feather + 0.5, 0, 1)[..., None]
pm = lambda a: np.concatenate([a[..., :3] * a[..., 3:] / 255, a[..., 3:]], -1)
for r in (sys.argv[2:] or ['0', '1', '2']):
    for c in [int(c) for c in os.environ.get('COLS', '0,4').split(',')]:
        k = key_image(f'{src}/g_{c}_{r}.png').astype(np.float32)
        out = pm(k) * w + pm(base) * (1 - w)
        a = out[..., 3:]
        rgb = np.where(a > 0, out[..., :3] * 255 / np.maximum(a, 1e-3), 0)
        on_green(np.clip(np.concatenate([rgb, a], -1), 0, 255).astype(np.uint8), (1024, 1024)).save(f'{ROOT}/assets/keyframes/gaze_{c}_{r}.png')
print('ok')
