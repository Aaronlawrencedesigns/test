"""Chroma-key helpers for Chunky's green-screen frames (numpy + Pillow only)."""
import numpy as np
from PIL import Image

GREEN = (0, 177, 64)
# Canonical crop of the 1024px keyframe canvas (ground line y=922) used for every app asset.
CROP_1024 = (32, 0, 992, 960)     # 960x960 square: headroom for standing on his hind legs
OUT_SIZE = (640, 640)


def alpha_and_despill(rgb):
    """rgb: HxWx3 uint8 -> (rgba uint8). Green-dominant pixels become transparent."""
    f = rgb.astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    spill = g - np.maximum(r, b)              # >0 where green dominates
    # 0 below lo (dog), 1 above hi (screen)
    lo, hi = 18.0, 55.0
    t = np.clip((spill - lo) / (hi - lo), 0, 1)
    alpha = 1.0 - t
    # despill: pull green down to the max of red/blue on the remaining pixels
    g2 = np.where(spill > 0, np.maximum(r, b) + np.minimum(spill, 0) , g)
    out = np.stack([r, np.minimum(g, g2 + 4), b], -1)
    rgba = np.concatenate([out, alpha[..., None] * 255], -1)
    return np.clip(rgba, 0, 255).astype(np.uint8)


def clean_alpha(rgba):
    """Remove specks: keep only the largest connected blob of solid alpha."""
    try:
        from scipy import ndimage
    except ImportError:
        return _clean_alpha_slow(rgba)
    a = rgba[..., 3]
    lab, n = ndimage.label(a > 128)
    if n == 0:
        return rgba
    sizes = ndimage.sum_labels(np.ones_like(lab), lab, index=np.arange(1, n + 1))
    keep = ndimage.binary_dilation(lab == (1 + int(np.argmax(sizes))), iterations=2)
    keep = ndimage.binary_fill_holes(keep)
    out = rgba.copy()
    out[..., 3] = np.where(keep, a, 0)
    return out


def _clean_alpha_slow(rgba):
    from collections import deque
    a = rgba[..., 3]
    solid = a > 128
    h, w = solid.shape
    lab = np.zeros((h, w), np.int32)
    best, best_n, cur = 0, 0, 0
    for y0, x0 in zip(*np.nonzero(solid[::4, ::4])):
        y0, x0 = y0 * 4, x0 * 4
        if lab[y0, x0] or not solid[y0, x0]:
            continue
        cur += 1
        n = 0
        q = deque([(y0, x0)])
        lab[y0, x0] = cur
        while q:
            y, x = q.popleft()
            n += 1
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < h and 0 <= xx < w and solid[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = cur
                    q.append((yy, xx))
        if n > best_n:
            best, best_n = cur, n
    keep = lab == best
    # dilate keep by 2px so soft edges around the blob survive
    k = keep.copy()
    for _ in range(2):
        k[1:] |= k[:-1]; k[:-1] |= k[1:]; k[:, 1:] |= k[:, :-1]; k[:, :-1] |= k[:, 1:]
    out = rgba.copy()
    out[..., 3] = np.where(k, a, 0)
    return out


def key_image(path):
    rgb = np.asarray(Image.open(path).convert('RGB'))
    return clean_alpha(alpha_and_despill(rgb))


def bbox(rgba, thr=128):
    ys, xs = np.nonzero(rgba[..., 3] > thr)
    return xs.min(), ys.min(), xs.max(), ys.max()


def on_green(rgba, size):
    bg = Image.new('RGBA', size, GREEN + (255,))
    bg.alpha_composite(Image.fromarray(rgba) if isinstance(rgba, np.ndarray) else rgba)
    return bg.convert('RGB')
