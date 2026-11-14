"""4 photos in -> finished pet out.

  photos -> checks -> studio portrait -> green-screen poses (sit / lie / sleep)
         -> head-direction poses -> head-sweep clips (+ half sweeps only where needed)
         -> action clips -> cut-out, drift correction, quality gates (retry on failure)
         -> pet pack (assets + manifest) + playable preview + QA report

Every API result is cached in work/gen/<key>[__N].<ext>; re-running a job never
pays again for something it already has.
"""
import json, os, shutil, threading, time, traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from PIL import Image, ImageOps

from . import plan, media

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


class Job:
    def __init__(self, name, photos, out, provider, uploader, species='dog', actions=None, rows=None,
                 max_retries=2, workers=6, log=print):
        self.name, self.species, self.photos_in = name, species, photos
        self.out = os.path.abspath(out)
        self.provider, self.uploader = provider, uploader
        self.actions = actions or plan.DEFAULT_ACTIONS
        self.rows = rows or plan.ROWS
        self.max_retries, self.workers = max_retries, workers
        self._log = log
        self.lock = threading.Lock()
        self.upload_lock = threading.Lock()
        self.work = f'{self.out}/work'
        self.gen = f'{self.work}/gen'
        self.kfdir = f'{self.work}/kf'
        self.pet = f'{self.out}/pet'
        for d in (self.gen, self.kfdir, f'{self.work}/photos', f'{self.work}/sheets', f'{self.pet}/clips', f'{self.pet}/stills'):
            os.makedirs(d, exist_ok=True)
        self.cost = {'images': 0, 'video_seconds': 0, 'cached': 0}
        self.qa = []          # {item, attempt, problems, metrics}
        self.kf = {}          # keyframe name -> keyed 1024 RGBA
        self.urls = {}
        self.still = {}       # still name -> 640 RGBA
        self.t0 = time.time()

    def log(self, msg):
        with self.lock:
            self._log(f'[{time.time() - self.t0:6.0f}s] {msg}')

    def fill(self, text):
        return text.replace('{species}', self.species).replace('{pet}', self.name)

    # ------------------------------------------------------------ generation (cached)
    def _gen_path(self, key, attempt, ext):
        return f'{self.gen}/{key}{"" if attempt == 1 else f"__{attempt}"}.{ext}'

    def gen_image(self, key, prompt, refs, attempt=1):
        p = self._gen_path(key, attempt, 'png')
        if os.path.exists(p):
            with self.lock: self.cost['cached'] += 1
            return p
        self.log(f'image  {key} (try {attempt})')
        self.provider.image(key if attempt == 1 else f'{key}__{attempt}', self.fill(prompt), refs, p)
        with self.lock: self.cost['images'] += 1
        return p

    def gen_video(self, key, prompt, first, last, seconds, attempt=1):
        # clips that start from a pose derived from another clip get their own cache entry
        if first.endswith('_end'):
            key = f'{key}@{first[3:]}'
        p = self._gen_path(key, attempt, 'mp4')
        if os.path.exists(p):
            with self.lock: self.cost['cached'] += 1
            return p
        self.log(f'clip   {key} (try {attempt})')
        self.provider.video(key if attempt == 1 else f'{key}__{attempt}', self.fill(prompt), self.url(first),
                            self.url(last) if last else None, seconds, p)
        with self.lock: self.cost['video_seconds'] += seconds
        return p

    def url(self, kfname):
        # one upload per keyframe, one at a time (parallel clips share their start frames)
        with self.upload_lock:
            if kfname not in self.urls:
                self.urls[kfname] = self.uploader.upload(f'{self.kfdir}/{kfname}.png',
                                                         f'{self.name.lower()}-{int(self.t0)}/{kfname}.png')
            return self.urls[kfname]

    def record(self, item, attempt, problems, metrics=None):
        with self.lock:
            self.qa.append({'item': item, 'attempt': attempt, 'problems': problems, 'metrics': metrics or {}})
        self.log(f'QA     {item} try {attempt}: ' + ('pass' if not problems else '; '.join(problems)))

    def with_retries(self, item, fn):
        """fn(attempt) -> (result, problems). Retries while problems, up to max_retries extra tries.
        If every try fails, keeps the try with the fewest problems."""
        best = None
        for attempt in range(1, self.max_retries + 2):
            try:
                res, problems, metrics = fn(attempt)
            except FileNotFoundError as e:       # replay has no recording for a retry
                self.log(f'       {item}: {e}')
                break
            self.record(item, attempt, problems, metrics)
            if best is None or len(problems) < len(best[1]):
                best = (res, problems)
            if not problems:
                break
        if best is None:
            raise RuntimeError(f'{item}: nothing generated')
        return best[0]

    # ------------------------------------------------------------ steps
    def check_photos(self):
        """Basic checks + normalise to JPEG <=1024px. (Photo QA can grow: blur, pet detection…)"""
        if not 3 <= len(self.photos_in) <= 6:
            raise ValueError('please provide 3–6 photos (front, side, back, sitting)')
        import cv2
        out = []
        for i, p in enumerate(self.photos_in):
            im = ImageOps.exif_transpose(Image.open(p))
            if im.mode in ('RGBA', 'LA', 'P'):
                im = im.convert('RGBA')
                bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
                bg.alpha_composite(im)
                im = bg
            im = im.convert('RGB')
            problems = []
            if min(im.size) < 400:
                problems.append(f'photo {i + 1} is small ({im.size[0]}x{im.size[1]})')
            g = np.asarray(im.convert('L').resize((512, int(512 * im.height / im.width))))
            sharp = float(cv2.Laplacian(g, cv2.CV_64F).var())
            if sharp < 25:
                problems.append(f'photo {i + 1} looks blurry (sharpness {sharp:.0f})')
            im.thumbnail((1024, 1024))
            q = f'{self.work}/photos/photo_{i + 1}.jpg'
            im.save(q, quality=90)
            out.append(q)
            self.record(f'photo {i + 1}', 1, problems, {'size': list(im.size), 'sharpness': round(sharp)})
        self.photos = out

    def images(self):
        refs = {'photos': None}
        for key, ref_names, prompt in plan.image_items():
            def ref_paths():
                ps = []
                for r in ref_names:
                    ps += self.photos if r == 'photos' else [self._gen_path(r, self.best_attempt.get(r, 1), 'png')]
                return ps
            if key == 'master':
                p = self.gen_image(key, prompt, ref_paths())
                self.best_attempt = {'master': 1}
                continue

            def attempt_fn(attempt, key=key, prompt=prompt):
                p = self.gen_image(key, prompt, ref_paths(), attempt)
                k, st = media.key_file(p)
                return (p, k, attempt), media.keyframe_ok(st), st
            p, k, att = self.with_retries(key, attempt_fn)
            self.best_attempt[key] = att
            self.kf['raw_' + key.split('_')[1]] = k
        sit, lie, sleep = media.normalise_keyframes(self.kf['raw_sit'], self.kf['raw_lie'], self.kf['raw_sleep'])
        for n, k in (('sit', sit), ('lie', lie), ('sleep', sleep)):
            self.kf[n] = k
            media.save_green(k, f'{self.kfdir}/kf_{n}.png')
        self.still['sit'] = self.to_still(sit)
        self.still['lie'] = self.to_still(lie)
        media.save_still(sit, f'{self.pet}/stills/sit.webp')
        media.save_still(lie, f'{self.pet}/stills/lie.webp')

    def to_still(self, k1024):
        return np.asarray(Image.fromarray(k1024).crop(media.CROP_1024).resize(media.OUT_SIZE, Image.LANCZOS))

    def gaze_kf(self, col, row):
        """Head-direction pose (turned head on the shared sitting body) -> kf_gaze_{col}_{row}.png"""
        name = f'kf_gaze_{col}_{row}'
        if os.path.exists(f'{self.kfdir}/{name}.png'):
            return name
        key, _, prompt = plan.gaze_item(col, row)

        def attempt_fn(attempt):
            p = self.gen_image(key, prompt, [f'{self.kfdir}/kf_sit.png'], attempt)
            k, st = media.key_file(p)
            return k, media.keyframe_ok(st), st
        k = self.with_retries(key, attempt_fn)
        media.save_green(media.composite_head(k, self.kf['sit']), f'{self.kfdir}/{name}.png')
        return name

    def still_for(self, kfname):
        n = kfname.replace('kf_', '')
        if n.endswith('_end'):
            n = n[:-4]                     # kf_lie_end -> still 'lie' (derived from a clip)
        return self.still.get(n)

    def derive_pose(self, frames, start_still):
        """The resting pose a clip ends in, at the clip's own scale (fitted at its start),
        with camera zoom during the clip undone using head size (ear span), within limits.
        Returns the pose on the 1024 canvas (for the next clip's start image)."""
        s0, _ = media.fit(frames[0], start_still)
        try:
            r = media.ear_span(frames[0]) / max(1, media.ear_span(frames[-1]))
        except ValueError:
            r = 1.0
        sc = s0 * min(1.33, max(0.75, r))
        last = frames[-1]
        x0, y0, x1, y1 = media.bbox(last)
        crop = Image.fromarray(last).crop((x0, y0, x1 + 1, y1 + 1))
        crop = crop.resize((max(1, round(crop.width * sc)), max(1, round(crop.height * sc))), Image.LANCZOS)
        _, _, _, gy = media.bbox(start_still)                       # same ground line as the start pose
        still = Image.new('RGBA', media.OUT_SIZE, (0, 0, 0, 0))
        still.alpha_composite(crop, (media.OW // 2 - crop.width // 2, max(0, gy - crop.height)))
        k = np.zeros((media.S, media.S, 4), np.uint8)
        cx0, cy0, cx1, cy1 = media.CROP_1024
        k[cy0:cy1, cx0:cx1] = np.asarray(still.resize((cx1 - cx0, cy1 - cy0), Image.LANCZOS))
        return k

    def action(self, key):
        first, last, seconds, prompt, opts = plan.ACTIONS[key]
        end_name = plan.ACTION_END_STILL.get(key, 'sit')
        derive = opts.get('derive')

        def attempt_fn(attempt):
            src = self.gen_video(key, prompt, first, last, seconds, attempt)
            frames, stats = media.decode_keyed(src)
            start_still = self.still_for(first)
            problems_extra, pose_k = [], None
            if derive:
                pose_k = self.derive_pose(frames, start_still)
                end_still = self.to_still(pose_k)
                x0, y0, x1, y1 = media.bbox(end_still)
                if (x1 - x0) < 1.05 * (y1 - y0):
                    problems_extra.append(f'does not end {"lying down" if derive == "lie" else "asleep, lying down"}')
            else:
                end_still = self.still.get(end_name) if end_name else None
            fixed, metrics = media.correct_clip(frames, start_still, end_still, spread=opts.get('spread', False), ramp=opts.get('ramp', 1.0))
            fitted_end = None
            if end_still is not None and not derive:
                sc, o = media.fit(frames[-1], end_still)
                fitted_end = [media.affine(frames[-1], sc, o)]
            problems = media.clip_qa(frames, stats, metrics, end_still if not derive else None, fitted_end) + problems_extra
            return (src, fixed, pose_k), problems, metrics
        src, fixed, pose_k = self.with_retries(key, attempt_fn)
        if derive:     # the chosen clip defines the resting pose the next clips start from
            self.kf[f'{derive}_end'] = pose_k
            media.save_green(pose_k, f'{self.kfdir}/kf_{derive}_end.png')
            self.still[derive] = self.to_still(pose_k)
            media.save_still(pose_k, f'{self.pet}/stills/{derive}.webp')
        media.encode_webm(fixed, f'{self.pet}/clips/{key}.webm')
        media.sheet(fixed, f'{self.work}/sheets/{key}.jpg')
        return src

    def sweep(self, row, c0, c1):
        it = plan.sweep_item(row, c0, c1)
        for kfname in (it['first'], it['last']):
            if kfname.startswith('kf_gaze_'):
                _, _, col, r = kfname.split('_', 3)
                self.gaze_kf(int(col), r)

        def attempt_fn(attempt):
            src = self.gen_video(it['key'], it['prompt'], it['first'], it['last'], it['seconds'], attempt)
            frames, prog, info = media.sweep_frames(src, self.still['sit'])
            problems = []
            need = 0.35 * (1.0 if (c0, c1) == (0, 4) else 0.6)
            if info['turn'] < need:
                problems.append(f'head barely turns (turn {info["turn"]:.2f} < {need:.2f})')
            areas = np.array([s['area'] for s in info['stats']])
            if areas.min() < 0.6 * np.median(areas):
                problems.append('subject vanishes in some frames')
            left, right = media.half_coverage(prog)
            metrics = {'turn': round(info['turn'], 3), 'left_share': round(left, 2), 'right_share': round(right, 2)}
            return (frames, prog, left, right), problems, metrics
        return self.with_retries(it['key'], attempt_fn)

    def head_tracking(self):
        """Full sweep per head height; add a half sweep where the full one turned too fast."""
        def one_row(row):
            frames, prog, left, right = self.sweep(row, 0, 4)
            pieces = [(0, 4, frames, prog)]
            for (c0, c1, share) in ((0, 2, left), (2, 4, right)):
                if share < 0.3:
                    self.log(f'       {row}: {"left" if c0 == 0 else "right"} half only got {share:.0%} of frames -> half sweep')
                    try:   # optional improvement: if it fails, the full sweep alone still works
                        if row != 'level':
                            self.gaze_kf(2, row)
                        f2, p2, _, _ = self.sweep(row, c0, c1)
                        pieces.append((c0, c1, f2, p2))
                    except Exception as e:  # noqa: BLE001
                        self.log(f'       {row}: half sweep skipped ({e})')
            return media.pick_row(pieces)
        with ThreadPoolExecutor(min(self.workers, len(self.rows))) as ex:
            futs = {row: ex.submit(one_row, row) for row in self.rows}
            rows = [futs[r].result() for r in self.rows]
        self.look = media.save_look(rows, f'{self.pet}/look')
        for r, row in zip(self.rows, rows):
            media.sheet(row, f'{self.work}/sheets/look_{r}.jpg', n=11)

    def clips(self):
        acts = [a for a in self.actions if a in plan.ACTIONS]
        # gaze keyframes for the sweeps first (cheap), so the video queue starts full
        for row in self.rows:
            for col in (0, 4):
                self.gaze_kf(col, row)
        from concurrent.futures import wait, FIRST_COMPLETED
        done, waiting = set(), list(acts)
        with ThreadPoolExecutor(self.workers) as ex:
            running = {ex.submit(self.head_tracking): 'head tracking'}

            def launch():
                for a in list(waiting):
                    dep = plan.DEPENDS.get(a)
                    if dep is None or dep in done or dep not in acts:
                        waiting.remove(a)
                        running[ex.submit(self.action, a)] = a
            launch()
            while running:
                fin, _ = wait(list(running), return_when=FIRST_COMPLETED)
                for f in fin:
                    name = running.pop(f)
                    f.result()            # raise errors
                    done.add(name)
                launch()                  # clips that were waiting for this one can start now
        self.log('all clips done')

    def _latest(self, key, ext):
        best = None
        for a in range(1, self.max_retries + 2):
            p = self._gen_path(key, a, ext)
            if os.path.exists(p):
                best = p
        return best

    def package(self):
        sit = self.still['sit']
        x0, y0, x1, y1 = media.bbox(sit)
        ear = y0 / media.OH
        manifest = {
            'name': self.name, 'species': self.species, 'version': 1,
            'look': self.look,
            'earTop': round(ear, 3), 'head': {'x': 0.5, 'y': round(ear + 0.14, 3)}, 'mouth': {'x': 0.5, 'y': round(ear + 0.24, 3)},
            'clips': sorted(os.path.splitext(f)[0] for f in os.listdir(f'{self.pet}/clips')),
        }
        manifest['features'] = plan.FEATURES
        # completeness: every pet ships with everything Chunky has
        missing = [f'clip: {c}' for c in plan.REQUIRED_CLIPS if c not in manifest['clips']]
        missing += [f'still: {n}' for n in plan.REQUIRED_STILLS if not os.path.exists(f'{self.pet}/stills/{n}.webp')]
        if self.look.get('rows', 0) < plan.REQUIRED_ROWS:
            missing.append(f'head tracking: {self.look.get("rows")} heights (need {plan.REQUIRED_ROWS})')
        if not os.path.exists(f'{HERE}/engine/app.js') or 'eat:' not in open(f'{HERE}/engine/app.js').read():
            missing.append('feed mode missing from the player')
        self.missing = missing
        self.record('complete set (Chunky parity)', 1, missing, {'clips': len(manifest['clips']), 'look rows': self.look.get('rows')})
        json.dump(manifest, open(f'{self.pet}/manifest.json', 'w'), indent=1)
        # playable preview: the product's player (petgen/engine) + this pet's assets
        pv = f'{self.out}/preview'
        os.makedirs(pv, exist_ok=True)
        for f in ('app.js', 'style.css'):          # the product's own copy of the player (never Chunky's src/)
            shutil.copy(f'{HERE}/engine/{f}', f'{pv}/{f}')
        if os.path.exists(f'{pv}/pet'):
            shutil.rmtree(f'{pv}/pet')
        shutil.copytree(self.pet, f'{pv}/pet')
        tpl = open(f'{HERE}/preview.html').read()
        open(f'{pv}/index.html', 'w').write(tpl.replace('__PET__', json.dumps(manifest)).replace('__NAME__', self.name))
        self.manifest = manifest

    def run(self):
        steps = [('checking photos', self.check_photos), ('portrait + poses', self.images),
                 ('clips + head tracking', self.clips), ('packaging', self.package)]
        self.error = None
        try:
            for label, fn in steps:
                self.log(f'== {label}')
                fn()
        except Exception as e:  # noqa: BLE001 - report every failure
            self.error = f'{e.__class__.__name__}: {e}'
            self.log('FAILED: ' + self.error)
            traceback.print_exc()
        finally:
            from .report import write_report
            write_report(self)
        return self.error is None
