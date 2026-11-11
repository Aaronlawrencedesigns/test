"""Turn a green-screen clip (mp4) into a transparent VP9 WebM in Chunky's canonical frame.

usage: python3 tools/clip2webm.py in.mp4 out.webm [--fit-start sit] [--fit-end lie]

--fit-start/--fit-end STILL: over the first/last second, ease a scale+offset so the
dog's silhouette lands exactly on assets/stills/STILL.webp. This hides the small
framing drift AI video models add, so clips chain onto stills without a pop.
"""
import argparse, subprocess, json, os
import numpy as np
from PIL import Image
from key import alpha_and_despill, clean_alpha, bbox, CROP_1024, OUT_SIZE

ROOT = os.path.join(os.path.dirname(__file__), '..')
ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('dst')
ap.add_argument('--fps', type=float, default=24)
ap.add_argument('--fit-start'); ap.add_argument('--fit-end')
ap.add_argument('--ramp', type=float, default=1.0, help='seconds to ease the fit over')
args = ap.parse_args()

OW, OH = OUT_SIZE
info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                           'stream=width,height', '-of', 'json', args.src]))
W = info['streams'][0]['width']
s = W / 1024
x0, y0, x1, y1 = (round(c * s) for c in CROP_1024)
dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', args.src,
                      '-vf', f'fps={args.fps},crop={x1 - x0}:{y1 - y0}:{x0}:{y0},scale={OW}:{OH}:flags=lanczos',
                      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE, check=True).stdout
frames = [clean_alpha(alpha_and_despill(np.frombuffer(dec[i:i + OW * OH * 3], np.uint8).reshape(OH, OW, 3)))
          for i in range(0, len(dec) - OW * OH * 3 + 1, OW * OH * 3)]


def anchor(rgba):
    """bottom-centre and height of the silhouette"""
    bx0, by0, bx1, by1 = bbox(rgba)
    return np.array([(bx0 + bx1) / 2, by1]), by1 - by0


def fit(src_rgba, still):
    tgt = np.asarray(Image.open(f'{ROOT}/assets/stills/{still}.webp').convert('RGBA'))
    (pc, ph), (tc, th) = anchor(src_rgba), anchor(tgt)
    return th / ph, pc, tc   # scale, src anchor, target anchor


def warp(rgba, scale, pc, tc, w):
    if w <= 0:
        return rgba
    sc = 1 + (scale - 1) * w
    dst_anchor = pc + (tc - pc) * w
    # inverse map for PIL: src = (dst - dst_anchor) / sc + pc
    a = 1 / sc
    coeffs = (a, 0, pc[0] - dst_anchor[0] * a, 0, a, pc[1] - dst_anchor[1] * a)
    return np.asarray(Image.fromarray(rgba).transform((OW, OH), Image.AFFINE, coeffs, Image.BICUBIC))


n = len(frames)
ramp = max(1, int(args.ramp * args.fps))
smooth = lambda x: x * x * (3 - 2 * x)
if args.fit_end:
    sc, pc, tc = fit(frames[-1], args.fit_end)
    for i in range(max(0, n - ramp), n):
        frames[i] = warp(frames[i], sc, pc, tc, smooth((i - (n - ramp) + 1) / ramp))
if args.fit_start:
    sc, pc, tc = fit(frames[0], args.fit_start)
    for i in range(0, min(ramp, n)):
        frames[i] = warp(frames[i], sc, pc, tc, smooth(1 - i / ramp))

enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{OW}x{OH}',
                        '-r', str(args.fps), '-i', '-', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
                        '-b:v', '0', '-crf', '32', '-row-mt', '1', '-auto-alt-ref', '0', args.dst], stdin=subprocess.PIPE)
for f in frames:
    enc.stdin.write(np.ascontiguousarray(f).tobytes())
enc.stdin.close(); enc.wait()
print(f'{args.dst}: {n} frames, {n / args.fps:.2f}s')
