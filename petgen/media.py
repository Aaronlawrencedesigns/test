"""Image / video processing for petgen (generalised from the Chunky tools).

Every asset shares one frame: the 1024px green-screen canvas with the ground at
y=922, cropped by CROP_1024 to a square and scaled to OUT_SIZE (640x640).
"""
import json, os, subprocess, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
from key import alpha_and_despill, clean_alpha, bbox, on_green, CROP_1024, OUT_SIZE  # noqa: E402

S = 1024
GROUND = int(0.9 * S)
OW, OH = OUT_SIZE
pm = lambda a: np.concatenate([a[..., :3] * a[..., 3:] / 255, a[..., 3:]], -1)


def unpm(o):
    a = o[..., 3:]
    return np.clip(np.concatenate([np.where(a > 0.5, o[..., :3] * 255 / np.maximum(a, 1e-3), 0), a], -1), 0, 255).astype(np.uint8)


def load_rgba(p):
    return np.asarray(Image.open(p).convert('RGBA'))


# ------------------------------------------------------------ keying + QA
def key_rgb(rgb):
    """rgb uint8 HxWx3 -> (rgba, stats). stats: area fraction, share of keyed area
    thrown away as specks/extra blobs, and whether the subject touches the frame edge."""
    raw = alpha_and_despill(rgb)
    rgba = clean_alpha(raw)
    a_raw = (raw[..., 3] > 128).sum()
    a = (rgba[..., 3] > 128)
    H, W = a.shape
    st = {'area': float(a.mean()), 'dropped': float(1 - a.sum() / max(1, a_raw))}
    if a.any():
        x0, y0, x1, y1 = bbox(rgba)
        st['touches_edge'] = bool(x0 <= 2 or y0 <= 2 or x1 >= W - 3)
    else:
        st['touches_edge'] = True
    return rgba, st


def key_file(path, size=S):
    im = Image.open(path).convert('RGB')
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    return key_rgb(np.asarray(im))


def keyframe_ok(st):
    problems = []
    if not 0.03 <= st['area'] <= 0.65:
        problems.append(f"subject covers {st['area']:.0%} of the frame")
    if st['dropped'] > 0.15:
        problems.append(f"{st['dropped']:.0%} of the cut-out was separate pieces (props / second animal / bad key)")
    if st['touches_edge']:
        problems.append('subject is cut off at the frame edge')
    return problems


# ------------------------------------------------------------ keyframes
def ear_span(k):
    x0, y0, x1, y1 = bbox(k)
    band = k[y0:y0 + int(0.12 * (y1 - y0)), :, 3] > 128
    xs = np.nonzero(band.any(0))[0]
    return xs.max() - xs.min()


def place(k, scale, ground=GROUND):
    """Crop the cut-out to its box, scale, centre it horizontally on the ground line."""
    x0, y0, x1, y1 = bbox(k)
    crop = Image.fromarray(k).crop((x0, y0, x1 + 1, y1 + 1))
    crop = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.LANCZOS)
    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    canvas.alpha_composite(crop, (S // 2 - crop.width // 2, ground - crop.height))
    return np.asarray(canvas)


def normalise_keyframes(k_sit, k_lie):
    """Same scale + ground line for sit and lie (sit = 60% of the canvas height)."""
    x0, y0, x1, y1 = bbox(k_sit)
    base = (0.6 * S) / (y1 - y0)
    sit = place(k_sit, base)
    lie = place(k_lie, base * ear_span(k_sit) / max(1, ear_span(k_lie)))
    return sit, lie


def composite_head(turned, base):
    """Paste a turned head (from an image edit) onto the shared sitting body."""
    t, b = turned.astype(np.float32), base.astype(np.float32)
    x0, y0, x1, y1 = bbox(base)
    seam, feather = y0 + int(0.6 * (y1 - y0)), 70
    w = np.clip((seam - np.arange(S, dtype=np.float32)[:, None]) / feather + 0.5, 0, 1)[..., None]
    return unpm(pm(t) * w + pm(b) * (1 - w))


def save_green(rgba, path):
    on_green(rgba, (S, S)).save(path)


def save_still(rgba1024, path):
    Image.fromarray(rgba1024).crop(CROP_1024).resize(OUT_SIZE, Image.LANCZOS).save(path, quality=90, method=6)


def last_frame_1024(video, out_png):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-sseof', '-0.05', '-i', video, '-frames:v', '1',
                    '-vf', f'scale={S}:{S}:flags=lanczos', out_png], check=True)
    return out_png


# ------------------------------------------------------------ clips
def decode_keyed(src, fps=24):
    """Decode a green-screen clip into keyed RGBA frames in the shared 640x640 frame."""
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                               'stream=width', '-of', 'json', src]))
    sc = info['streams'][0]['width'] / S
    x0, y0, x1, y1 = (round(c * sc) for c in CROP_1024)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-vf',
                          f'fps={fps},crop={x1 - x0}:{y1 - y0}:{x0}:{y0},scale={OW}:{OH}:flags=lanczos',
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE, check=True).stdout
    n = OW * OH * 3
    frames, stats = [], []
    for i in range(0, len(raw) - n + 1, n):
        k, st = key_rgb(np.frombuffer(raw[i:i + n], np.uint8).reshape(OH, OW, 3))
        frames.append(k)
        stats.append(st)
    return frames, stats


def anchor(rgba):
    x0, y0, x1, y1 = bbox(rgba)
    return np.array([(x0 + x1) / 2, y1], np.float32), y1 - y0


def fit(frame, still):
    (pc, ph), (tc, th) = anchor(frame), anchor(still)
    sc = th / max(1, ph)
    return sc, tc - sc * pc          # X' = sc * X + o


def affine(rgba, sc, o):
    a = 1 / sc
    return np.asarray(Image.fromarray(rgba).transform((OW, OH), Image.AFFINE, (a, 0, -o[0] * a, 0, a, -o[1] * a), Image.BICUBIC))


def iou(a, b):
    A, B = a[..., 3] > 128, b[..., 3] > 128
    return float((A & B).sum() / max(1, (A | B).sum()))


def correct_clip(frames, start_still=None, end_still=None, spread=False, ramp=1.0, fps=24):
    """Ease framing drift so the clip starts/ends exactly on the stills.
    spread: spend the correction while the subject moves (no visible shrink at the end)."""
    n = len(frames)
    out = list(frames)
    s0, o0 = fit(frames[0], start_still) if start_still is not None else (1.0, np.zeros(2, np.float32))
    s1, o1 = fit(frames[-1], end_still) if end_still is not None else (1.0, np.zeros(2, np.float32))
    if spread:
        alph = [f[..., 3].astype(np.float32) / 255 for f in frames]
        motion = np.array([0.0] + [float(np.abs(alph[i] - alph[i - 1]).mean()) for i in range(1, n)])
        motion = np.convolve(motion, np.ones(5) / 5, mode='same') + 1e-6
        lam = np.cumsum(motion) / motion.sum()
        lam = (lam - lam[0]) / max(1e-6, lam[-1] - lam[0])
        weights = [(1 - l, l) for l in lam]
    else:
        r = max(1, int(ramp * fps))
        sm = lambda x: x * x * (3 - 2 * x)
        weights = []
        for i in range(n):
            ws = sm(max(0.0, 1 - i / r)) if start_still is not None else 0.0
            we = sm(max(0.0, (i - (n - r) + 1) / r)) if end_still is not None else 0.0
            weights.append((ws, we))
    for i, (ws, we) in enumerate(weights):
        sc = 1 + (s0 - 1) * ws + (s1 - 1) * we
        o = o0 * ws + o1 * we
        if abs(sc - 1) > 1e-3 or abs(o).max() > 0.25:
            out[i] = affine(frames[i], sc, o)
    return out, {'scale_start': float(s0), 'scale_end': float(s1)}


def encode_webm(frames, dst, fps=24):
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{OW}x{OH}',
                            '-r', str(fps), '-i', '-', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0',
                            '-crf', '32', '-row-mt', '1', '-auto-alt-ref', '0', dst], stdin=subprocess.PIPE)
    for f in frames:
        enc.stdin.write(np.ascontiguousarray(f).tobytes())
    enc.stdin.close()
    enc.wait()


def clip_qa(frames, stats, metrics, end_still_img=None, corrected=None):
    """Return a list of problems (empty = pass)."""
    problems = []
    areas = np.array([s['area'] for s in stats])
    med = float(np.median(areas))
    if med < 0.02:
        problems.append('subject almost invisible (keying failed)')
    elif areas.min() < 0.45 * med:
        problems.append(f'subject vanishes in some frames (min area {areas.min() / med:.0%} of normal)')
    if max(s['dropped'] for s in stats) > 0.35:
        problems.append('stray pieces in the cut-out')
    for k in ('scale_start', 'scale_end'):
        v = metrics.get(k, 1.0)
        if not 0.7 <= v <= 1.45:
            problems.append(f'{k.replace("_", " ")} correction {v:.2f}x (framing drifted too much)')
    if end_still_img is not None and corrected is not None:
        j = iou(corrected[-1], end_still_img)
        metrics['end_iou'] = j
        if j < 0.62:
            problems.append(f'does not end in the expected pose (overlap {j:.0%})')
    return problems


# ------------------------------------------------------------ head sweeps
def colour_match(f, ref):
    f = f.astype(np.float32)
    mf, mr = f[..., 3] > 200, ref[..., 3] > 200
    out = f.copy()
    for ch in range(3):
        a, b = f[..., ch][mf], ref[..., ch][mr].astype(np.float32)
        out[..., ch] = (f[..., ch] - a.mean()) / (a.std() + 1e-3) * b.std() + b.mean()
    return np.clip(out, 0, 255).astype(np.uint8)


def head_box(body):
    x0, y0, x1, y1 = bbox(body)
    seam = y0 + int(0.6 * (y1 - y0))
    return max(0, y0 - 10), seam, max(0, int(x0 - 0.15 * OW)), min(OW, int(x1 + 0.15 * OW))


def head_sig(rgba, box):
    hy0, hy1, hx0, hx1 = box
    a = rgba[hy0:hy1, hx0:hx1].astype(np.float32)
    g = a[..., :3].mean(-1) * a[..., 3] / 255
    v = np.asarray(Image.fromarray(g.astype(np.uint8)).resize((48, 40), Image.BILINEAR), np.float32)
    return (v - v.mean()) / (v.std() + 1e-3)


def sweep_frames(src, body):
    """Keyed, aligned, colour-matched frames of a head-sweep clip + turn progress (0..1)."""
    frames, stats = decode_keyed(src)
    tgt, _ = anchor(body)
    out = []
    for f in frames:
        c, _ = anchor(f)
        d = tgt - c
        f = affine(f, 1.0, d) if abs(d).max() > 0.25 else f
        out.append(colour_match(f, body))
    box = head_box(body)
    sigs = [head_sig(f, box) for f in out]
    move = np.array([0.0] + [float(np.abs(sigs[i] - sigs[i - 1]).mean()) for i in range(1, len(sigs))])
    move = np.convolve(move, np.ones(3) / 3, mode='same')
    prog = np.cumsum(move)
    prog = (prog - prog[0]) / max(1e-6, prog[-1] - prog[0])
    turn = float(np.abs(sigs[0] - sigs[-1]).mean())      # how different first and last head poses are
    return out, prog, {'turn': turn, 'frames': len(out), 'stats': stats}


def half_coverage(prog):
    """Share of the clip's frames spent in the left / right half of the turn."""
    return float((prog < 0.5).mean()), float((prog >= 0.5).mean())


def pick_row(pieces, cols=33):
    """pieces: list of (u0, u1, frames, prog). For each of `cols` positions use the narrowest
    covering piece and its nearest frame. Returns frames (left->right)."""
    out = []
    for j in range(cols):
        u = j * 4 / (cols - 1)
        cov = [p for p in pieces if p[0] - 1e-6 <= u <= p[1] + 1e-6] or pieces
        u0, u1, frames, prog = min(cov, key=lambda p: p[1] - p[0])
        uu = u0 + prog * (u1 - u0)
        out.append(frames[int(np.argmin(np.abs(uu - u)))])
    return out


def save_look(rows, out_dir):
    """rows: list (top->bottom) of lists of 640x640 RGBA frames. Crops all to their union box."""
    os.makedirs(out_dir, exist_ok=True)
    mask = np.zeros((OH, OW), bool)
    for row in rows:
        for f in row:
            mask |= f[..., 3] > 2
    ys, xs = np.nonzero(mask)
    x0, y0 = max(0, xs.min() - 2), max(0, ys.min() - 2)
    x1, y1 = min(OW, xs.max() + 3), min(OH, ys.max() + 3)
    for r, row in enumerate(rows):
        for i, f in enumerate(row):
            Image.fromarray(f[y0:y1, x0:x1]).save(f'{out_dir}/{r}_{i}.webp', quality=88, method=6)
    meta = {'rows': len(rows), 'cols': len(rows[0]), 'x': int(x0), 'y': int(y0), 'w': int(x1 - x0), 'h': int(y1 - y0), 'frame': OW}
    json.dump(meta, open(f'{out_dir}/meta.json', 'w'))
    return meta


def sheet(frames, path, n=8, size=150, bg=(226, 229, 236)):
    """Contact sheet of n evenly spaced RGBA frames on a light background."""
    idx = np.linspace(0, len(frames) - 1, n).round().astype(int)
    W = Image.new('RGBA', (n * size, size), bg + (255,))
    for k, i in enumerate(idx):
        W.alpha_composite(Image.fromarray(frames[i]).resize((size, size), Image.LANCZOS), (k * size, 0))
    W.convert('RGB').save(path, quality=82)
    return path
