"""Turn head-sweep clips (far left -> far right) into evenly spaced head positions.

usage: python3 tools/build_sweeps.py ROW[:REF[:U0-U1]] sweep.mp4 [...]

ROW = output row (head height, top to bottom). REF = which row of the 5x3 head-direction
grid (assets/gaze, 0 up / 1 level / 2 down) to measure the head turn against
(defaults to ROW). U0-U1 = the part of the turn the clip covers (0 = far left,
2 = straight ahead, 4 = far right; default 0-4). Several clips may feed one row:
half-sweeps (e.g. 0-2) are denser, so they win where they cover a position.

For each green-screen frame: key it, align it to the sitting still (paws),
colour-match it to that still (video models drift warmer), then measure how far
through the turn each frame is (accumulated head movement), then
estimate how far the head is turned by comparing it with the 5 head-direction
images of that row. Frames are picked at N evenly spaced positions and saved as
assets/sweep/{row}_{i}.webp (i = 0 far left .. N-1 far right).
"""
import os, sys, json, subprocess
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from key import alpha_and_despill, clean_alpha, bbox, CROP_1024, OUT_SIZE

ROOT = os.path.join(os.path.dirname(__file__), '..')
N = 33
OW, OH = OUT_SIZE


def load_rgba(p):
    return np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)


def decode(src, fps=24):
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                                               '-show_entries', 'stream=width', '-of', 'json', src]))
    s = info['streams'][0]['width'] / 1024
    x0, y0, x1, y1 = (round(c * s) for c in CROP_1024)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-vf',
                          f'fps={fps},crop={x1 - x0}:{y1 - y0}:{x0}:{y0},scale={OW}:{OH}:flags=lanczos',
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE, check=True).stdout
    n = OW * OH * 3
    return [clean_alpha(alpha_and_despill(np.frombuffer(raw[i:i + n], np.uint8).reshape(OH, OW, 3)))
            for i in range(0, len(raw) - n + 1, n)]


def anchor(rgba):
    bx0, by0, bx1, by1 = bbox(rgba)
    return np.array([(bx0 + bx1) / 2, by1], np.float32)


def shift(rgba, d):
    if abs(d[0]) < 0.25 and abs(d[1]) < 0.25:
        return rgba
    return np.asarray(Image.fromarray(rgba).transform((OW, OH), Image.AFFINE, (1, 0, -d[0], 0, 1, -d[1]), Image.BICUBIC))


pm = lambda a: np.concatenate([a[..., :3] * a[..., 3:] / 255, a[..., 3:]], -1)


def unpm(o):
    a = o[..., 3:]
    return np.clip(np.concatenate([np.where(a > 0, o[..., :3] * 255 / np.maximum(a, 1e-3), 0), a], -1), 0, 255).astype(np.uint8)


body = load_rgba(f'{ROOT}/assets/stills/sit.webp')
bx0, by0, bx1, by1 = bbox(body.astype(np.uint8))
seam = by0 + int(0.6 * (by1 - by0))
feather = 70 * OH / 704
w_head = np.clip((seam - np.arange(OH, dtype=np.float32)[:, None]) / feather + 0.5, 0, 1)[..., None]
target_anchor = anchor(body.astype(np.uint8))
# head region used to compare poses
hy0, hy1 = max(0, by0 - 10), seam
hx0, hx1 = max(0, int(bx0 - 0.15 * OW)), min(OW, int(bx1 + 0.15 * OW))


def color_match(f, ref):
    """Match the dog's colour statistics in frame f to the reference still (per channel)."""
    f = f.astype(np.float32)
    mf, mr = f[..., 3] > 200, ref[..., 3] > 200
    out = f.copy()
    for ch in range(3):
        a, b = f[..., ch][mf], ref[..., ch][mr]
        out[..., ch] = (f[..., ch] - a.mean()) / (a.std() + 1e-3) * b.std() + b.mean()
    return np.clip(out, 0, 255).astype(np.uint8)


def head_sig(rgba):
    a = rgba[hy0:hy1, hx0:hx1].astype(np.float32)
    g = (a[..., :3].mean(-1) * a[..., 3] / 255)
    im = Image.fromarray(g.astype(np.uint8)).resize((48, 40), Image.BILINEAR)
    v = np.asarray(im, np.float32)
    return (v - v.mean()) / (v.std() + 1e-3)


os.makedirs(f'{ROOT}/assets/sweep', exist_ok=True)
args = sys.argv[1:]
clips = {}   # row -> list of (u0, u1, per-frame u, frames)
for spec, src in zip(args[::2], args[1::2]):
    parts = spec.split(':')
    row = int(parts[0])
    ref = int(parts[1]) if len(parts) > 1 and parts[1] else row
    u0, u1 = (float(v) for v in parts[2].split('-')) if len(parts) > 2 else (0.0, 4.0)
    frames = decode(src)
    # ease framing drift: shift every frame so its paws sit where the still's do
    out = []
    for f in frames:
        f = shift(f, target_anchor - anchor(f))
        out.append(color_match(f, body))
    refs = [head_sig(load_rgba(f'{ROOT}/assets/gaze/{c}_{ref}.webp').astype(np.uint8)) for c in range(5)]
    us = []
    for f in out:
        sg = head_sig(f)
        d = np.array([np.mean((sg - r) ** 2) for r in refs])
        i = int(np.argmin(d))
        if 0 < i < 4:   # parabolic refinement between neighbours
            den = d[i - 1] - 2 * d[i] + d[i + 1]
            i = i + (0.5 * (d[i - 1] - d[i + 1]) / den if den > 1e-6 else 0)
        us.append(float(i))
    us = np.array(us)
    # Progress through the turn = accumulated head movement (frame-to-frame
    # change of the head region). Unlike matching against 5 reference images,
    # this is continuous, so every frame of real movement gets its own spot.
    sigs = [head_sig(f) for f in out]
    move = np.array([0.0] + [float(np.abs(sigs[i] - sigs[i - 1]).mean()) for i in range(1, len(sigs))])
    move = np.convolve(move, np.ones(3) / 3, mode='same')
    mono = np.cumsum(move)
    mono = u0 + (mono - mono[0]) / max(1e-6, mono[-1] - mono[0]) * (u1 - u0)
    clips.setdefault(row, []).append((u0, u1, mono, out))
    print(f'row {row} [{u0:g}-{u1:g}] {os.path.basename(src)}: {len(frames)} frames, raw head estimate {us.min():.1f}..{us.max():.1f}')

# For each position use the clip with the narrowest range that covers it
# (half-sweeps are denser than full sweeps), and its nearest frame.
for row, cl in clips.items():
    used = set()
    for j in range(N):
        u = j * 4 / (N - 1)
        covering = [c for c in cl if c[0] - 1e-6 <= u <= c[1] + 1e-6] or cl
        u0, u1, mono, out = min(covering, key=lambda c: c[1] - c[0])
        fi = int(np.argmin(np.abs(mono - u)))
        used.add((id(out), fi))
        Image.fromarray(out[fi]).save(f'{ROOT}/assets/sweep/{row}_{j}.webp', quality=86, method=6)
    print(f'row {row}: {len(used)} distinct frames across {N} positions')
