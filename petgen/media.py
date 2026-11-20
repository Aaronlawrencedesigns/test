"""Image / video processing for petgen (generalised from the Chunky tools).

Every asset shares one frame: the 1024px green-screen canvas with the ground at
y=922, cropped by CROP_1024 to a square and scaled to OUT_SIZE (640x640).
"""
import json, os, subprocess, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
from key import clean_alpha, bbox, on_green, CROP_1024, OUT_SIZE  # noqa: E402

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
def soften_shadow(rgba):
    """The pet's shadow on the green floor comes out dark teal (green only just above blue),
    which the key keeps as solid, hard-edged 'mat' under the pet. Turn those pixels, in the
    lower part of the pet only (so dark fur and eyes are safe), into a soft neutral shadow."""
    a = rgba[..., 3]
    if not (a > 128).any():
        return rgba
    f = rgba.astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    x0, y0, x1, y1 = bbox(rgba)
    low = np.zeros(a.shape, bool)
    low[y0 + int(0.6 * (y1 - y0)):, :] = True
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    teal = low & (a > 0) & (np.maximum(np.maximum(r, g), b) < 125) & (g > r + 10) & (b > r + 4)
    if not teal.any():
        return rgba
    try:
        from scipy import ndimage
        w = ndimage.gaussian_filter(teal.astype(np.float32), 2.0)   # soft edge around the patch
    except ImportError:
        w = teal.astype(np.float32)
    w = np.clip(w * 1.6, 0, 1)
    grey = np.clip(lum * 0.55, 0, 255)                                 # neutral, a bit darker
    out = f.copy()
    for c in range(3):
        out[..., c] = f[..., c] * (1 - w) + grey * w
    out[..., 3] = f[..., 3] * (1 - 0.55 * w)                           # half-transparent
    return np.clip(out, 0, 255).astype(np.uint8)


def alpha_and_despill(rgb):
    """The product's green-screen key (Chunky's tools/key.py is left as it is). The screen is green AND
    saturated: (0, 177, 64) has green 64% above red/blue. Light fur lit by green bounce light, e.g. a
    white chest (185, 215, 175), is only ~14% above, so it keys by how strongly green a pixel is relative
    to its brightness, not by the absolute difference (which cut out pale chests and bellies)."""
    f = rgb.astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    spill = g - np.maximum(r, b)
    ratio = spill / np.maximum(g, 1)
    t = np.clip((ratio - 0.28) / (0.5 - 0.28), 0, 1) * np.clip((spill - 14) / 20, 0, 1)
    alpha = 1.0 - t
    # Semi-transparent edge pixels (fluffy fur) are a MIX of fur and green screen: take the screen colour back
    # out (fg = (pixel - (1 - a) * screen) / a), otherwise the outline keeps a dark teal fringe.
    scr = alpha < 0.02
    screen = np.median(f[scr][::97], axis=0) if scr.sum() > 1000 else np.array([0.0, 177.0, 64.0], np.float32)  # sampled: fast
    edge = (alpha > 0.04) & (alpha < 0.96)
    if edge.any():
        a3 = np.maximum(alpha[edge], 0.04)[:, None]
        f[edge] = np.clip((f[edge] - (1 - a3) * screen) / a3, 0, 255)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    spill = g - np.maximum(r, b)
    g2 = np.where(spill > 0, np.maximum(r, b), g)
    out = np.stack([r, np.minimum(g, g2 + 4), b], -1)
    return np.clip(np.concatenate([out, alpha[..., None] * 255], -1), 0, 255).astype(np.uint8)


def fill_translucent(rgba, r=7, solid=0.72):
    """Shaded fur under the chest / belly (green-floor bounce light) keys as see-through patches, so the
    desktop shows through the pet as white / grey smudges. A partly transparent pixel whose neighbourhood
    (radius r) is mostly solid pet is inside the body, not on its outline: make it solid and fill its colour
    from the surrounding fur. Real edges (about half their neighbourhood is background) stay soft."""
    from scipy import ndimage
    a = rgba[..., 3].astype(np.float32) / 255
    part = (a > 0.04) & (a < 0.94)
    if not part.any():
        return rgba
    op = (a >= 0.94).astype(np.float32)
    share = ndimage.uniform_filter(op, 2 * r + 1)
    inner = part & (share >= solid)
    if not inner.any():
        return rgba
    out = rgba.copy()
    rgb = rgba[..., :3].astype(np.float32)
    k = 2 * r + 1
    den = ndimage.uniform_filter(op, k) + 1e-6
    fill = np.stack([ndimage.uniform_filter(rgb[..., c] * op, k) / den for c in range(3)], -1)
    ai = a[inner][:, None]
    out[..., :3][inner] = np.clip(rgb[inner] * ai + fill[inner] * (1 - ai), 0, 255).astype(np.uint8)
    out[..., 3][inner] = 255
    return out


def fill_holes(rgba, r=11):
    """The image model sometimes paints green-screen green INSIDE the pet (a patch on the chest, under the
    chin), which keys out as a hole. A hole fully enclosed by the pet can't be background: make it solid
    and fill it with the surrounding fur colour (blurred from the solid pixels around it)."""
    from scipy import ndimage
    solid = rgba[..., 3] > 128
    holes = ndimage.binary_fill_holes(solid) & ~solid
    if not holes.any():
        return rgba
    # Only small holes in the upper body (chest, chin). Real background enclosed between the legs / paws
    # (lower part of the pet, often larger) must stay see-through: filling it painted a dark block there.
    x0, y0, x1, y1 = bbox(rgba)
    lab, n = ndimage.label(holes)
    keep = np.zeros_like(holes)
    for i in range(1, n + 1):
        comp = lab == i
        ys, xs = np.nonzero(comp)
        if ys.mean() < y0 + 0.6 * (y1 - y0) and comp.sum() < 0.02 * solid.sum():
            keep |= comp
    holes = keep
    if not holes.any():
        return rgba
    holes = ndimage.binary_dilation(holes, iterations=1) & ~(rgba[..., 3] > 250)
    rgb = rgba[..., :3].astype(np.float32)
    op = (rgba[..., 3] > 250).astype(np.float32)
    out = rgba.copy()
    fill = rgb.copy()
    for k in (2 * r + 1, 4 * r + 1, 8 * r + 1):      # widen until every hole pixel has fur around it
        den = ndimage.uniform_filter(op, k)
        f = np.stack([ndimage.uniform_filter(rgb[..., c] * op, k) for c in range(3)], -1) / (den[..., None] + 1e-6)
        todo = holes & (den > 0.02) & (fill is not None)
        fill[todo] = f[todo]
    out[..., :3][holes] = np.clip(fill[holes], 0, 255).astype(np.uint8)
    out[..., 3][holes] = 255
    return out


def fix_spill(rgba, rgb, r=9, solid=0.72):
    """Green light bouncing onto the pet's underside (chest, belly, inner legs) despills to flat grey /
    white streaks. Inside the body, give those pixels the colour of the surrounding fur (keeping their
    brightness), so the underside reads as shaded fur, not a grey smear."""
    from scipy import ndimage
    o = rgb.astype(np.float32)
    spill = np.clip((o[..., 1] - np.maximum(o[..., 0], o[..., 2]) - 8) / 40, 0, 1)
    a = rgba[..., 3].astype(np.float32) / 255
    body = a >= 0.5
    share = ndimage.uniform_filter(body.astype(np.float32), 2 * r + 1)
    target = body & (share >= solid) & (spill > 0.05)
    if not target.any():
        return rgba
    cur = rgba[..., :3].astype(np.float32)
    clean = (body & (spill <= 0.05)).astype(np.float32)
    k = 4 * r + 1
    den = ndimage.uniform_filter(clean, k) + 1e-6
    fur = np.stack([ndimage.uniform_filter(cur[..., c] * clean, k) / den for c in range(3)], -1)
    lum = cur.mean(-1, keepdims=True)
    tint = fur / (fur.mean(-1, keepdims=True) + 1e-6) * lum            # fur hue, this pixel's brightness
    w = spill[..., None]
    out = rgba.copy()
    out[..., :3][target] = np.clip(cur * (1 - w) + tint * w, 0, 255)[target].astype(np.uint8)
    return out


def key_rgb(rgb):
    """rgb uint8 HxWx3 -> (rgba, stats). stats: area fraction, share of keyed area
    thrown away as specks/extra blobs, and whether the subject touches the frame edge."""
    raw = alpha_and_despill(rgb)
    rgba = fix_spill(fill_holes(fill_translucent(soften_shadow(clean_alpha(raw)))), rgb)
    a_raw = (raw[..., 3] > 128).sum()
    a = (rgba[..., 3] > 128)
    H, W = a.shape
    st = {'area': float(a.mean()), 'dropped': float(1 - a.sum() / max(1, a_raw))}
    if a.any():
        x0, y0, x1, y1 = bbox(rgba)
        st['touches_edge'] = bool(x0 <= 2 or y0 <= 2 or x1 >= W - 3)
        st['touches_bottom'] = bool(y1 >= H - 3)     # paws run off the bottom of the frame
    else:
        st['touches_edge'] = st['touches_bottom'] = True
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


# widest the lying pose may be, as a share of the app frame's width (room for long pets,
# side-on poses like poop, and the framing drift the video model adds)
LIE_MAX_W = 0.74


def normalise_keyframes(k_sit, k_lie):
    """Same scale + ground line for sit and lie. Sit is 60% of the canvas height, unless the
    pet is long: then everything is smaller, so the lying pose still fits across the frame."""
    x0, y0, x1, y1 = bbox(k_sit)
    base = (0.6 * S) / (y1 - y0)
    lie_rel = ear_span(k_sit) / max(1, ear_span(k_lie))
    lx0, _, lx1, _ = bbox(k_lie)
    lie_w = (lx1 - lx0) * lie_rel                        # lying width at scale 1
    base = min(base, LIE_MAX_W * (CROP_1024[2] - CROP_1024[0]) / max(1, lie_w))
    sit = place(k_sit, base)
    lie = place(k_lie, base * lie_rel)
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
LOW_SHIFT = S - CROP_1024[3]   # 64 px (1024 canvas): the strip below the usual crop


def decode_keyed(src, fps=24, low=False, wide=False):
    """Decode a green-screen clip into keyed RGBA frames in the shared 640x640 frame.
    low=True (lying / sleeping clips): crop the same size but LOW_SHIFT lower, so it reaches the
    very bottom of the video (paws stretched toward the camera sit there; the usual crop cut them
    off). The clip is re-aligned to the pet's poses afterwards, so the shift doesn't move it."""
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                               'stream=width', '-of', 'json', src]))
    sc = info['streams'][0]['width'] / S
    cx0, cy0, cx1, cy1 = CROP_1024
    if wide:      # the whole video (stand: a dog on its hind legs is taller than the usual crop; the clip is
        cx0, cy0, cx1, cy1 = 0, 0, S, S     # re-scaled onto the sitting pose afterwards, so the size still matches)
    elif low:
        cy0, cy1 = cy0 + LOW_SHIFT, cy1 + LOW_SHIFT
    x0, y0, x1, y1 = (round(c * sc) for c in (cx0, cy0, cx1, cy1))
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


def correct_clip(frames, start_still=None, end_still=None, spread=False, ramp=1.0, fps=24, hold=False):
    """Ease framing drift so the clip starts/ends exactly on the stills.
    spread: spend the correction while the subject moves (no visible shrink at the end).
    hold: keep the correction for the whole clip, blending start -> end (clips decoded wide=True are on a
    different scale from the stills, so easing the correction off after a second made the pet shrink and
    float up mid-clip: Tess's stand, Nov 20, feet rose 56 px and glided back down)."""
    n = len(frames)
    out = list(frames)
    s0, o0 = fit(frames[0], start_still) if start_still is not None else (1.0, np.zeros(2, np.float32))
    s1, o1 = fit(frames[-1], end_still) if end_still is not None else (1.0, np.zeros(2, np.float32))
    if hold:
        sm = lambda x: x * x * (3 - 2 * x)
        weights = [(1 - sm(i / max(1, n - 1)), sm(i / max(1, n - 1))) for i in range(n)]
        if start_still is None or end_still is None:   # one end only: hold that end's fit throughout
            weights = [(1.0 if start_still is not None else 0.0, 1.0 if end_still is not None else 0.0)] * n
    elif spread:
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


def edge_share(frames, margin=2):
    """Share of frames where the pet touches the left, right or top edge (= it is cut off)."""
    hit = 0
    for f in frames:
        a = f[..., 3] > 100
        if a[:, :margin].any() or a[:, -margin:].any() or a[:margin, :].any():
            hit += 1
    return hit / max(1, len(frames))


def zoom_peak(frames):
    """How much bigger the pet gets mid-clip than at its start/end (size = sqrt of its area)."""
    sz = [float(np.sqrt((f[..., 3] > 128).sum())) for f in frames[::2]]
    ref = max(1.0, (sz[0] + sz[-1]) / 2)
    return max(sz) / ref


def clip_qa(frames, stats, metrics, end_still_img=None, corrected=None, final=None, max_zoom=1.4, max_growth=None, max_edge=0.02, max_bottom=0.05):
    """Return a list of problems (empty = pass)."""
    problems = []
    raw_edge = sum(1 for s in stats if s.get('touches_edge')) / max(1, len(stats))
    fin_edge = edge_share(final) if final is not None else 0.0
    metrics['cut_off'] = round(max(raw_edge, fin_edge), 3)
    bottom = float(np.mean([bool(f[-2:, :, 3].max() > 100) for f in final])) if final is not None and len(final) else 0.0
    metrics['paws_at_bottom'] = round(bottom, 3)
    if bottom > max_bottom:   # paws run off the bottom of the frame (shows as a flat cut / dark line)
        problems.append(f'paws cut off at the bottom of the frame in {bottom:.0%} of frames')
    if max(raw_edge, fin_edge) > max_edge:
        problems.append(f'the pet is cut off at the frame edge in {max(raw_edge, fin_edge):.0%} of frames')
    if final is not None and len(final) > 2:
        z = zoom_peak(final)
        metrics['zoom'] = round(z, 2)
        if max_growth:     # a slow camera push-in: the pet ends up bigger than it started
            sz = [float(np.sqrt((f[..., 3] > 128).sum())) for f in final[::2]]
            g = max(sz) / max(1.0, sz[0])
            metrics['growth'] = round(g, 2)
            if g > max_growth:
                problems.append(f'the camera pushes in (the pet grows {g:.2f}x)')
        if z > max_zoom:   # the camera zoomed in mid-clip
            problems.append(f'the camera zooms in mid-clip ({z:.2f}x)')
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


# ------------------------------------------------------------ female anatomy fix
def groin_mask(still):
    """Soft mask of the area between a sitting pet's hind legs (where video models draw male parts)."""
    from scipy import ndimage
    a = still[..., 3] > 128
    x0, y0, x1, y1 = bbox(still)
    w, h = x1 - x0, y1 - y0
    yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    m = ((((xx - (x0 + x1) / 2) / (0.16 * w)) ** 2 + ((yy - (y0 + 0.86 * h)) / (0.10 * h)) ** 2) <= 1) & a
    return np.clip(ndimage.gaussian_filter(m.astype(np.float32), 4) * 1.4, 0, 1)


def patch_groin(frames, still, min_iou=0.85):
    """Seated tricks of female pets: copy the clean belly area of the sitting pose into every frame
    (following the pet as it shifts) where its lower body lines up with the sitting pose."""
    return patch_from(frames, still, groin_mask(still), min_iou=min_iou)


def match_tint(frames, ref, smooth=9):
    """Seedance 2.5 clips come back with a yellow-green cast (green-screen spill on pale fur) that the
    other clips don't have. Per frame, scale R/G/B so the pet's average colour has the same balance as
    the reference still (brightness kept), with the gains smoothed over time so it never flickers."""
    def mean(a):
        m = a[..., 3] > 200
        return a[..., :3][m].astype(np.float32).mean(0) if m.any() else None
    r = mean(ref)
    if r is None:
        return frames, 0
    rc = r / r.mean()
    g = []
    for f in frames:
        m = mean(f)
        g.append(rc / (m / m.mean()) if m is not None else np.ones(3, np.float32))
    g = np.clip(np.array(g, np.float32), 0.8, 1.25)
    k = np.ones(smooth, np.float32) / smooth
    g = np.stack([np.convolve(np.pad(g[:, c], smooth // 2, mode='edge'), k, 'valid') for c in range(3)], 1)
    out = []
    for f, gi in zip(frames, g):
        f = f.copy()
        f[..., :3] = np.clip(f[..., :3] * gi, 0, 255).astype(np.uint8)
        out.append(f)
    return out, len(out)


def _leg_gap_top(a):
    """Top of the see-through gap between the legs under the body (front-on standing / squatting),
    as (x, y, gap width); None when the legs are together (sitting, lying)."""
    x0, y0, x1, y1 = bbox(a)
    w, h = x1 - x0, y1 - y0
    cx = (x0 + x1) // 2
    lo, hi = max(0, int(cx - 0.3 * w)), min(a.shape[1], int(cx + 0.3 * w))
    m = a[..., 3] > 128
    gap = np.zeros_like(m)
    for y in range(int(y0 + 0.4 * h), y1):
        idx = np.flatnonzero(m[y, lo:hi])
        if len(idx) >= 2:
            gap[y, lo + idx[0]:lo + idx[-1]] = ~m[y, lo + idx[0]:lo + idx[-1]]
    # the gap may be off-centre when the pet is at a three-quarter angle: take the column whose gap
    # reaches highest up from the floor (the space under the belly)
    def run_top(ys):
        top = ys[-1]
        for y in ys[::-1]:
            if y < top - 1:
                break
            top = y
        return top
    best = None
    band = max(2, int(0.06 * w))
    ys = np.flatnonzero(gap[:, cx - band:cx + band].any(1))
    if len(ys) and y1 - run_top(ys) >= 0.12 * h:      # front-on: the gap under the middle of the body
        best = (cx, run_top(ys))
    for x in ([] if best or w < 0.85 * h else range(lo, hi, 2)):   # off-centre only for side / 3/4 views
        ys = np.flatnonzero(gap[:, x])
        if len(ys) == 0 or ys[-1] < y1 - 0.06 * h:      # must open onto the floor
            continue
        top = ys[-1]
        for y in ys[::-1]:
            if y < top - 1:
                break
            top = y
        if best is None or top < best[1]:
            best = (x, top)
    if best is None or y1 - best[1] < 0.12 * h:
        return None
    cx, top = best
    gx = np.flatnonzero(gap[min(top + 3, a.shape[0] - 1), lo:hi])
    if len(gx):     # the part of the gap row around the chosen column
        runs = np.split(gx, np.flatnonzero(np.diff(gx) > 1) + 1)
        gx = min(runs, key=lambda r: abs(lo + r.mean() - cx))
    return (lo + gx.mean() if len(gx) else cx), top, max(len(gx), 0.06 * w), w, h


def shade_belly(frames, strength=0.85, fade=6):
    """Female pets, front-on standing / squatting tricks: a soft dark shadow where the belly meets the
    gap between the legs, deep enough to hide what the video model draws there. Only in frames where
    the legs are apart; it fades in and out over `fade` frames so it never pops. Returns (frames, n)."""
    found = [_leg_gap_top(f) for f in frames]
    on = np.array([g is not None for g in found], np.float32)
    # fade: strength ramps toward each run of frames with a gap, and holds through 1-2 frame dropouts
    k = np.zeros(len(frames), np.float32)
    for i in range(len(frames)):
        lo, hi = max(0, i - fade), min(len(frames), i + fade + 1)
        near = np.flatnonzero(on[lo:hi])
        if len(near):
            k[i] = max(0.0, 1 - np.min(np.abs(near + lo - i)) / fade)
    last = None
    out, n = [], 0
    yy, xx = np.mgrid[0:frames[0].shape[0], 0:frames[0].shape[1]]
    for f, g, s in zip(frames, found, k):
        g = g or last
        if g is None or s <= 0:
            out.append(f)
            continue
        if found[len(out)] is not None:
            last = g
        gx, top, gw, w, h = g
        d = ((xx - gx) / (0.9 * gw + 0.05 * w)) ** 2 + ((yy - (top - 0.01 * h)) / (0.14 * h)) ** 2
        m = np.clip(1 - d, 0, 1) ** 0.7
        m = m * (f[..., 3] > 128) * (strength * s)
        f = f.copy()
        f[..., :3] = (f[..., :3] * (1 - m)[..., None]).astype(np.uint8)
        out.append(f)
        n += 1
    return out, n


def edit_mask(orig, clean, max_share=0.08):
    """Soft mask of where an anatomy edit changed the pet (lower half of its body only).
    None if the edit moved / rescaled the pet or changed too much to trust."""
    from scipy import ndimage
    ao, ac = orig[..., 3] > 128, clean[..., 3] > 128
    if (ao & ac).sum() / max(1, (ao | ac).sum()) < 0.93:
        return None
    x0, y0, x1, y1 = bbox(orig)
    d = np.abs(orig[..., :3].astype(np.int16) - clean[..., :3].astype(np.int16)).max(-1) > 40
    d &= ao & ac
    d[:y0 + int(0.45 * (y1 - y0))] = False
    d = ndimage.binary_opening(d, iterations=1)
    lab, n = ndimage.label(d)
    if n == 0:
        return np.zeros(orig.shape[:2], np.float32)
    sizes = ndimage.sum_labels(np.ones_like(lab), lab, index=np.arange(1, n + 1))
    keep = lab == (1 + int(np.argmax(sizes)))
    if keep.sum() > max_share * ao.sum():
        return None
    keep = ndimage.binary_dilation(keep, iterations=6)
    return np.clip(ndimage.gaussian_filter(keep.astype(np.float32), 3) * 1.5, 0, 1)


def _shift(a, dx, dy):
    out = np.zeros_like(a)
    h, w = a.shape[:2]
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = a[ys, xs]
    return out


def patch_from(frames, ref, mask, min_iou=0.85, pad=24, search=40, step=4):
    """Blend ref into frames under mask, following the pet as it shifts. Two passes so the patch moves WITH the
    body instead of jiggling (Tess's puppy eyes / sleep, Nov 19: it snapped in 4 px steps and switched on/off
    from frame to frame): (1) per frame, the best offset (coarse search, then 1 px refinement) and how well the
    pet's shape lines up (IoU); (2) offsets smoothed over time, and the patch faded in / out over a few frames
    instead of popping. Frames where nothing lines up get no patch."""
    if mask is None or mask.max() <= 0:
        return frames, 0
    ys, xs = np.nonzero(mask > 0.01)
    y0, y1 = max(0, ys.min() - pad), min(mask.shape[0], ys.max() + pad)
    x0, x1 = max(0, xs.min() - pad), min(mask.shape[1], xs.max() + pad)
    ra = ref[..., 3] > 128
    a = ra[y0:y1, x0:x1]
    rf = ref.astype(np.float32)
    H, W = ra.shape

    def iou_at(fa, dx, dy):
        if not (0 <= y0 + dy and y1 + dy <= H and 0 <= x0 + dx and x1 + dx <= W):
            return -1.0
        b = fa[y0 + dy:y1 + dy, x0 + dx:x1 + dx]
        return (a & b).sum() / max(1, (a | b).sum())

    fits = []
    for f in frames:
        fa = f[..., 3] > 128
        best = (-1.0, 0, 0)
        for dy in (range(-search, search + 1, step) if search else [0]):
            for dx in (range(-search // 2, search // 2 + 1, step) if search else [0]):
                v = iou_at(fa, dx, dy)
                if v > best[0]:
                    best = (v, dx, dy)
        if search and step > 1:          # refine to 1 px around the coarse best
            _, bx, by = best
            for dy in range(by - step + 1, by + step):
                for dx in range(bx - step + 1, bx + step):
                    v = iou_at(fa, dx, dy)
                    if v > best[0]:
                        best = (v, dx, dy)
        fits.append(best)
    n_f = len(frames)
    if not n_f:
        return frames, 0
    iou = np.array([b[0] for b in fits])
    off = np.array([[b[1], b[2]] for b in fits], np.float32)
    shifted = np.abs(off).sum(1) > 0
    ok = iou >= np.where(shifted, max(min_iou, 0.92), min_iou)
    # smooth the offsets over time (median of accepted neighbours), so the patch glides with the body
    sm = off.copy()
    for i in range(n_f):
        lo, hi = max(0, i - 3), min(n_f, i + 4)
        good = [k for k in range(lo, hi) if ok[k]]
        if good:
            sm[i] = np.median(off[good], axis=0)
    # fade the patch in / out over ~4 frames instead of switching it on and off
    w = ok.astype(np.float32)
    k = np.array([0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25], np.float32)
    w = np.minimum(w, np.convolve(w, k / k.max(), mode='same').clip(0, 1)) if n_f > 7 else w
    w = np.convolve(w, np.ones(3) / 3, mode='same') if n_f > 3 else w
    out, n = [], 0
    for f, (dx, dy), wi in zip(frames, sm, w):
        if wi <= 0.02:
            out.append(f)
            continue
        dx, dy = int(round(dx)), int(round(dy))
        m = (_shift(mask, dx, dy) if (dx or dy) else mask)[..., None] * float(wi)
        r = _shift(rf, dx, dy) if (dx or dy) else rf
        m = m * (f[..., 3:4] > 128)          # never paint outside the pet in this frame
        out.append(np.clip(f.astype(np.float32) * (1 - m) + r * m, 0, 255).astype(np.uint8))
        n += 1
    return out, n


# ------------------------------------------------------------ head sweeps
def dog_stats(rgba):
    """Per-channel mean / std of the pet's pixels (alpha > 200)."""
    m = rgba[..., 3] > 200
    px = rgba[..., :3][m].astype(np.float32)
    return px.mean(0), px.std(0) + 1e-3


def tf_to(src_stats, ref_stats):
    """Per-channel linear colour transform (a, b) that maps src statistics onto ref."""
    (ms, ss), (mr, sr) = src_stats, ref_stats
    a = sr / ss
    return a, mr - a * ms


def apply_tf(rgba, tf, w=1.0):
    if w <= 0.002:
        return rgba
    a, b = tf
    out = rgba.astype(np.float32)
    out[..., :3] = out[..., :3] * (1 + w * (a - 1)) + w * b
    return np.clip(out, 0, 255).astype(np.uint8)


def blend_clip_colours(frames, start_ref=None, end_ref=None, seconds=1.0, fps=24):
    """Colour-match a clip's first / last second to the stills it starts / ends on
    (so there's never a colour jump between clips); the middle keeps its own lighting."""
    n = len(frames)
    r = max(1, min(int(seconds * fps), n // 3))
    sm = lambda x: x * x * (3 - 2 * x)
    t0 = tf_to(dog_stats(frames[0]), dog_stats(start_ref)) if start_ref is not None else None
    t1 = tf_to(dog_stats(frames[-1]), dog_stats(end_ref)) if end_ref is not None else None
    out = []
    for i, f in enumerate(frames):
        if t0 is not None:
            f = apply_tf(f, t0, sm(max(0.0, 1 - i / r)))
        if t1 is not None:
            f = apply_tf(f, t1, sm(max(0.0, (i - (n - r) + 1) / r)))
        out.append(f)
    return out


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


def sweep_frames(src, body, match=True):
    """Keyed, aligned, colour-matched frames of a head-sweep clip + turn progress (0..1)."""
    frames, stats = decode_keyed(src)
    tgt, _ = anchor(body)
    out = []
    for f in frames:
        c, _ = anchor(f)
        d = tgt - c
        f = affine(f, 1.0, d) if abs(d).max() > 0.25 else f
        out.append(colour_match(f, body) if match else f)
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


def pick_row_from_starts(pieces, cols=33):
    """Tilted head rows. pieces: list of (u_start, u_end, frames, prog), clips that START at a
    tilted pose (left edge, centre, right edge) and turn outward. The video model holds the pose
    it starts from but drifts back to a level head later in a clip (it doesn't honour the pose
    it's asked to end on), so each position uses the clip that starts nearest to it, and only
    frames from the first half of that clip's turn."""
    out = []
    for j in range(cols):
        u = j * 4 / (cols - 1)
        best = None
        for u0, u1, frames, prog in pieces:
            if u1 == u0 or not (min(u0, u1) - 1e-6 <= u <= max(u0, u1) + 1e-6):
                continue
            d = abs(u - u0)
            if d > abs(u1 - u0) / 2 + 1e-6:          # past the halfway point of this clip
                continue
            if best is None or d < best[0]:
                best = (d, u0, u1, frames, prog)
        if best is None:
            return None
        _, u0, u1, frames, prog = best
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
