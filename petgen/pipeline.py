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
from .providers import ProviderUnavailable

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


class Job:
    def __init__(self, name, photos, out, provider, uploader, species='dog', actions=None, rows=None,
                 max_retries=2, workers=6, log=print, tail='yes', sex='male'):
        self.name, self.species, self.photos_in = name, species, photos
        self.tail = plan.TAILS.get(tail, plan.TAILS['yes'])
        self.sex = sex if sex in plan.SEX_NOTE else 'male'
        self.out = os.path.abspath(out)
        self.provider, self.uploader = provider, uploader
        self.actions = actions or plan.DEFAULT_ACTIONS
        self.rows = rows or plan.ROWS
        self.max_retries, self.workers = max_retries, workers
        # videos cost ~5x an image: fewer retries, and a spending cap per pet (USD, estimated)
        self.video_retries = int(os.environ.get('PETGEN_VIDEO_RETRIES', '1'))
        self.budget = float(os.environ.get('PETGEN_BUDGET', '10'))
        self._log = log
        self.lock = threading.Lock()
        self.upload_lock = threading.Lock()
        self.work = f'{self.out}/work'
        self.gen = f'{self.work}/gen'
        self.kfdir = f'{self.work}/kf'
        self.pet = f'{self.out}/pet'
        for d in (self.gen, self.kfdir, f'{self.work}/photos', f'{self.work}/sheets', f'{self.pet}/clips', f'{self.pet}/stills'):
            os.makedirs(d, exist_ok=True)
        self.cost = {'images': 0, 'video_seconds': 0, 'video_seconds_hq': 0, 'cached': 0}
        self.image_path = {}  # (item, attempt) -> generated file (names carry a content tag)
        self._gaze_events, self._gaze_started = {}, set()
        self.rest_fix = {}    # female pets: rest pose -> (clean 640 still, mask) for belly patching
        self.qa = []          # {item, attempt, problems, metrics}
        self.hints = {}       # item -> problems of its last failed try (added to the next try's prompt)
        self.kf = {}          # keyframe name -> keyed 1024 RGBA
        self.urls = {}
        self.still = {}       # still name -> 640 RGBA
        self.t0 = time.time()

    def log(self, msg):
        with self.lock:
            self._log(f'[{time.time() - self.t0:6.0f}s] {msg}')

    def fill(self, text, video=False, attempt=1):
        t = self.tail
        if not video:
            sex = plan.SEX_NOTE_IMAGE[self.sex]       # (no anatomy words: they make the image model pixelate)
        elif attempt >= 3 and self.sex == 'female':
            sex = plan.SEX_NOTE_STRONG[self.sex]
        else:
            sex = plan.SEX_NOTE[self.sex]
        text = (text.replace('{tail_and}', t['and']).replace('{tail_raised}', t['raised'])
                + t['note'] + sex + (plan.IN_FRAME if video else ''))
        return text.replace('{species}', self.species).replace('{pet}', self.name)

    @staticmethod
    def _content_tag(text, files):
        """Short hash of a prompt and the files it uses: the cache key changes whenever
        either changes (e.g. a pet re-made at a new size, or with its tail setting fixed)."""
        import hashlib
        h = hashlib.md5(text.encode())
        for f in files:
            with open(f, 'rb') as fh:
                h.update(fh.read())
        return h.hexdigest()[:8]

    # ------------------------------------------------------------ generation (cached)
    def _gen_path(self, key, attempt, ext):
        return f'{self.gen}/{key}{"" if attempt == 1 else f"__{attempt}"}.{ext}'

    def gen_image(self, key, prompt, refs, attempt=1):
        base = key
        if attempt > 1:     # retries say what went wrong last time (turned to the side, glitch, ...)
            prompt = prompt + plan.retry_hint(self.hints.get(key))
        key = f'{key}@{self._content_tag(self.fill(prompt), refs)}'
        p = self._gen_path(key, attempt, 'png')
        self.image_path[(base, attempt)] = p
        if os.path.exists(p):
            with self.lock: self.cost['cached'] += 1
            return p
        self.log(f'image  {key} (try {attempt})')
        self.provider.image(key if attempt == 1 else f'{key}__{attempt}', self.fill(prompt), refs, p)
        with self.lock: self.cost['images'] += 1
        return p

    def gen_video(self, key, prompt, first, last, seconds, attempt=1):
        # cache entry per prompt + keyframe contents (a clip from changed keyframes is a new clip)
        kfs = [f'{self.kfdir}/{kf}.png' for kf in (first, last) if kf]
        if attempt > 1:     # retries say what went wrong last time (cut off, zoom, wrong end pose, anatomy)
            prompt = prompt + plan.retry_hint(self.hints.get(key))
        hq = self.sex == 'female' and key in plan.HQ_CLIPS_FEMALE
        key = f'{key}@{self._content_tag(self.fill(prompt, video=True, attempt=attempt), kfs)}' + ('hq' if hq else '')
        if first == 'kf_sleep_end':
            key += 'u2'   # (made before the stale-upload fix: those clips started from the wrong image)
        p = self._gen_path(key, attempt, 'mp4')
        if os.path.exists(p):
            with self.lock: self.cost['cached'] += 1
            return p
        self.log(f'clip   {key} (try {attempt})')
        self.provider.video(key if attempt == 1 else f'{key}__{attempt}', self.fill(prompt, video=True, attempt=attempt), self.url(first),
                            self.url(last) if last else None, seconds, p, hq=hq)
        with self.lock: self.cost['video_seconds_hq' if hq else 'video_seconds'] += seconds
        return p

    def url(self, kfname):
        # one upload per keyframe, one at a time (parallel clips share their start frames)
        with self.upload_lock:
            if kfname not in self.urls:
                path = f'{self.kfdir}/{kfname}.png'
                tag = self._content_tag('', [path])
                self.urls[kfname] = self.uploader.upload(path, f'{self.name.lower()}-{int(self.t0)}/{kfname}-{tag}.png')
            return self.urls[kfname]

    def record(self, item, attempt, problems, metrics=None):
        with self.lock:
            self.qa.append({'item': item, 'attempt': attempt, 'problems': problems, 'metrics': metrics or {}})
        self.log(f'QA     {item} try {attempt}: ' + ('pass' if not problems else '; '.join(problems)))

    def spent(self):
        return plan.est_cost(self.cost)

    def with_retries(self, item, fn, video=False):
        """fn(attempt) -> (result, problems). Retries while problems, up to max_retries extra tries
        (plus plan.SEX_EXTRA_TRIES when the only problem left is female anatomy).
        If every try fails, keeps the try with the fewest problems."""
        best = None
        tries = (min(self.max_retries, self.video_retries) if video else self.max_retries) + 1
        attempt, last = 0, tries
        while attempt < last:
            attempt += 1
            if attempt > 1 and self.spent() > self.budget:   # over budget: keep the best try, owner decides
                self.record(item, attempt, [f'not retried: pet budget ${self.budget:.0f} reached (est. ${self.spent():.2f})'])
                break
            try:
                res, problems, metrics = fn(attempt)
            except FileNotFoundError as e:       # replay has no recording for a retry
                self.log(f'       {item}: {e}')
                break
            except ProviderUnavailable:          # GPTProto down / out of credit: stop, the worker re-queues the order
                raise
            except Exception as e:  # noqa: BLE001 - provider rejected / failed: count it as a failed try
                self.record(item, attempt, [f'generation failed: {str(e)[:160]}'])
                continue
            self.record(item, attempt, problems, metrics)
            if problems:
                self.hints[item] = problems       # the next try is told what went wrong (plan.retry_hint)
            if best is None or len(problems) < len(best[1]):
                best = (res, problems)
            if not problems:
                break
            if (attempt == last and last == tries and plan.SEX_EXTRA_TRIES
                    and all('male anatomy' in p for p in problems)):
                last += plan.SEX_EXTRA_TRIES
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
                    ps += self.photos if r == 'photos' else [self.image_path[(r, self.best_attempt.get(r, 1))]]
                return ps
            if key == 'master':
                p = self.gen_image(key, prompt, ref_paths())
                self.best_attempt = {'master': 1}
                continue

            def attempt_fn(attempt, key=key, prompt=prompt):
                p = self.gen_image(key, prompt, ref_paths(), attempt)
                k, st = media.key_file(p)
                problems = media.keyframe_ok(st)
                if not problems:   # sitting / lying poses: right anatomy (tail, sex)
                    problems += self.anatomy_problems([k], f'{key}_{attempt}', picks=(0,))
                if not problems and key == 'green_sit':   # straight-on like Chunky, no image glitches
                    ans = self.provider.ask_image(p, plan.SIT_CHECK.replace('{species}', self.species)) or {}
                    if ans.get('front_on') is False:
                        problems.append('not sitting straight facing the camera (turned to one side)')
                    if ans.get('artifacts') is True:
                        problems.append('image glitch: dark patch or smudge on the pet')
                return (p, k, attempt), problems, st
            p, k, att = self.with_retries(key, attempt_fn)
            self.best_attempt[key] = att
            self.kf['raw_' + key.split('_')[1]] = k
        sit, lie = media.normalise_keyframes(self.kf['raw_sit'], self.kf['raw_lie'])
        for n, k in (('sit', sit), ('lie', lie)):
            self.kf[n] = k
            media.save_green(k, f'{self.kfdir}/kf_{n}.png')
        self.still['sit'] = self.to_still(sit)
        self.still['lie'] = self.to_still(lie)
        media.save_still(sit, f'{self.pet}/stills/sit.webp')
        media.save_still(lie, f'{self.pet}/stills/lie.webp')

    def to_still(self, k1024):
        return np.asarray(Image.fromarray(k1024).crop(media.CROP_1024).resize(media.OUT_SIZE, Image.LANCZOS))

    def gaze_kf(self, col, row):
        """Head-direction pose (turned head on the shared sitting body) -> kf_gaze_{col}_{row}.png.
        Tilted poses get a vision check (does it really look up / down?) and are remade if not."""
        name = f'kf_gaze_{col}_{row}'
        with self.lock:
            ev = self._gaze_events.setdefault(name, threading.Event())
            mine = name not in self._gaze_started
            self._gaze_started.add(name)
        if not mine:
            ev.wait()
            return name
        try:
            key, _, prompt = plan.gaze_item(col, row)

            def attempt_fn(attempt):
                p = self.gen_image(key, prompt, [f'{self.kfdir}/kf_sit.png'], attempt)
                k, st = media.key_file(p)
                problems, metrics = media.keyframe_ok(st), dict(st)
                if row in plan.V_OK and not problems:
                    seen = self.look_check(p)
                    if seen:
                        metrics['looks'] = f"{seen.get('vertical')} / {seen.get('horizontal')}"
                        if seen.get('vertical') not in plan.V_OK[row]:
                            problems.append(f"head should look {row.replace('hu', 'slightly up').replace('hd', 'slightly down')}"
                                            f" but looks {seen.get('vertical')}")
                return k, problems, metrics
            k = self.with_retries(key, attempt_fn)
            media.save_green(media.composite_head(k, self.kf['sit']), f'{self.kfdir}/{name}.png')
        finally:
            ev.set()
        return name

    def is_lying(self, img):
        """Lying down = clearly lower than sitting (front-on sphinx pose) or wider than tall (side-on)."""
        x0, y0, x1, y1 = media.bbox(img)
        sx0, sy0, sx1, sy1 = media.bbox(self.kf['sit'] if img.shape[0] == media.S else self.still['sit'])
        return (x1 - x0) >= 1.05 * (y1 - y0) or (y1 - y0) <= 0.88 * (sy1 - sy0)

    ANATOMY_Q = ('Look at this photo of a pet. Answer ONLY with JSON {"tail_visible": true|false, '
                 '"male_genitals_visible": true|false}. tail_visible: is a tail (longer than a tiny stub) visible? '
                 'male_genitals_visible: is a penis or penile sheath visible on its belly?')

    def _anatomy(self, png):
        cache = png + '.anatomy.json'
        if os.path.exists(cache):
            return json.load(open(cache))
        ans = self.provider.ask_image(png, self.ANATOMY_Q)
        if ans:
            json.dump(ans, open(cache, 'w'))
        return ans

    def anatomy_problems(self, frames, key, picks=None):
        """Vision check on a few frames: no tail on tail-less pets, no male anatomy on female pets
        (the models invent both). Returns a list of problems."""
        want_tail = self.tail is not plan.TAILS['yes']
        want_sex = self.sex == 'female'
        if not (want_tail or want_sex) or not getattr(self.provider, 'ask_image', None):
            return []
        picks = picks or (len(frames) // 3, len(frames) // 2, 2 * len(frames) // 3)
        tails = males = 0
        for i in picks:
            png = f'{self.work}/anatomy_{key}_{i}.png'
            bg = Image.new('RGBA', (frames[i].shape[1], frames[i].shape[0]), (255, 255, 255, 255))
            bg.alpha_composite(Image.fromarray(frames[i]))
            bg.convert('RGB').save(png)
            ans = self._anatomy(png) or {}
            tails += bool(ans.get('tail_visible'))
            males += bool(ans.get('male_genitals_visible'))
        need = 2 if len(picks) > 1 else 1
        out = []
        if want_tail and tails >= need:
            out.append('shows a tail (this pet has none)')
        if want_sex and males >= need:
            out.append('shows male anatomy (this pet is female)')
        return out

    def female_rest_fix(self, name):
        """Female pets: an image edit of the resting pose with a female belly; the changed area becomes
        a patch for this pose's still and for the frames of lying / sleeping clips."""
        if self.sex != 'female' or name not in self.still:
            return
        orig_k = self.kf[f'{name}_end']
        src = f'{self.kfdir}/kf_{name}_end.png'

        def attempt_fn(attempt):
            p = self.gen_image(f'female_{name}', plan.FEMALE_EDIT, [src], attempt)
            k, st = media.key_file(p)
            clean = self.to_still(k)
            orig = self.to_still(orig_k)
            mask = media.edit_mask(orig, clean)
            problems = [] if mask is not None else ['the edit moved or changed the pet']
            return (clean, mask), problems, {'changed_px': int((mask > 0.5).sum()) if mask is not None else -1}
        try:
            clean, mask = self.with_retries(f'female {name} pose', attempt_fn)
        except RuntimeError:
            return
        if mask is None or mask.max() <= 0:
            return
        clean = media.apply_tf(clean, media.tf_to(media.dog_stats(clean), media.dog_stats(self.still[name])))
        self.rest_fix[name] = (clean, mask)
        (self.still[name],), _ = media.patch_from([self.still[name]], clean, mask, min_iou=0)
        Image.fromarray(self.still[name]).save(f'{self.pet}/stills/{name}.webp', quality=90, method=6)

    def _frame_on_green(self, frame, path):
        k = np.zeros((media.S, media.S, 4), np.uint8)
        cx0, cy0, cx1, cy1 = media.CROP_1024
        k[cy0:cy1, cx0:cx1] = np.asarray(Image.fromarray(frame).resize((cx1 - cx0, cy1 - cy0), Image.LANCZOS))
        media.save_green(k, path)

    def patch_moving(self, key, frames):
        """Female pets, tricks where the pet stands / moves: image-edit a few frames to a clean female
        belly and patch every frame from the nearest edited one (where it lines up)."""
        n_keys = plan.MOVING_TRICKS[key]
        N = len(frames)
        picks = np.linspace(int(0.15 * N), int(0.85 * N), n_keys).round().astype(int)
        fixes = []   # (frame index, clean frame, mask)
        for i in picks:
            src = f'{self.work}/female_{key}_{i}.png'
            self._frame_on_green(frames[i], src)
            try:
                p = self.gen_image(f'female_{key}_{i}', plan.FEMALE_EDIT, [src])
            except ProviderUnavailable:
                raise
            except Exception as e:  # noqa: BLE001 - a missing edit just leaves those frames as they are
                self.log(f'       {key}: frame {i} edit failed ({e})')
                continue
            k, _ = media.key_file(p)
            clean = self.to_still(k)
            mask = media.edit_mask(frames[i], clean)
            if mask is None or mask.max() <= 0:
                continue
            clean = media.apply_tf(clean, media.tf_to(media.dog_stats(clean), media.dog_stats(frames[i])))
            fixes.append((int(i), clean, mask))
        if not fixes:
            return frames, 0
        out, n = [], 0
        for j, f in enumerate(frames):
            _, clean, mask = min(fixes, key=lambda t: abs(t[0] - j))
            (f2,), k = media.patch_from([f], clean, mask, min_iou=0.88)
            out.append(f2)
            n += k
        return out, n

    def patch_rest(self, frames):
        n = 0
        for clean, mask in self.rest_fix.values():
            frames, k = media.patch_from(frames, clean, mask)
            n += k
        return frames, n

    def look_check(self, path):
        """Vision check of where the pet looks, cached per image (None if unavailable)."""
        cache = f'{path}.look.json'
        if os.path.exists(cache):
            return json.load(open(cache))
        fn = getattr(self.provider, 'look_check', None)
        seen = fn(path) if fn else None
        if seen:
            json.dump(seen, open(cache, 'w'))
        return seen

    def still_for(self, kfname):
        n = kfname.replace('kf_', '')
        if n.endswith('_end'):
            n = n[:-4]                     # kf_lie_end -> still 'lie' (derived from a clip)
        return self.still.get(n)

    def derive_pose(self, frames, start_still, undo_zoom=True):
        """The resting pose a clip ends in, at the clip's own scale (fitted at its start),
        with camera zoom during the clip undone using head size (ear span), within limits.
        Returns the pose on the 1024 canvas (for the next clip's start image)."""
        s0, _ = media.fit(frames[0], start_still)
        try:   # (ears fold when a pet falls asleep, so ear span can't measure zoom there)
            r = media.ear_span(frames[0]) / max(1, media.ear_span(frames[-1])) if undo_zoom else 1.0
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

    def sleep_pose(self):
        """Sleeping pose = image edit of the actual lying frame (same spot and scale)."""
        def attempt_fn(attempt):
            p = self.gen_image('sleep_edit', plan.SLEEP_EDIT, [f'{self.kfdir}/kf_lie_end.png'], attempt)
            k, st = media.key_file(p)
            problems = media.keyframe_ok(st)
            if not self.is_lying(k):
                problems.append('not lying down')
            x0, y0, x1, y1 = media.bbox(k)
            lx0, ly0, lx1, ly1 = media.bbox(self.kf['lie_end'])
            if (y1 - y0) > 1.15 * (ly1 - ly0):     # asleep (head down) is never taller than lying
                problems.append('bigger than the lying pose (scale changed)')
            return k, problems, st
        k = self.with_retries('sleep pose', attempt_fn)
        self.kf['sleep_end'] = k
        media.save_green(k, f'{self.kfdir}/kf_sleep_end.png')
        sleep = self.to_still(k)
        if 'lie' in self.still:          # image edit -> match the video look of the lying pose
            sleep = media.apply_tf(sleep, media.tf_to(media.dog_stats(sleep), media.dog_stats(self.still['lie'])))
        self.still['sleep'] = sleep
        Image.fromarray(self.still['sleep']).save(f'{self.pet}/stills/sleep.webp', quality=90, method=6)

    def action(self, key):
        first, last, seconds, prompt, opts = plan.ACTIONS[key]
        if self.species == 'cat' and key in plan.CAT_ACTIONS:      # cats meow and purr (all seated: belly-safe)
            prompt = plan.CAT_ACTIONS[key]
        elif self.sex == 'female' and key in plan.FEMALE_ACTIONS:
            prompt = plan.FEMALE_ACTIONS[key]
        end_name = plan.ACTION_END_STILL.get(key, 'sit')
        derive = opts.get('derive')
        if opts.get('sleep_edit'):
            self.sleep_pose()

        def attempt_fn(attempt):
            src = self.gen_video(key, prompt, first, last, seconds, attempt)
            frames, stats = media.decode_keyed(src, low=opts.get('low', False), wide=opts.get('wide', False))
            tinted = 0
            if self.sex == 'female' and key in plan.HQ_CLIPS_FEMALE and 'sit' in self.still:
                # Seedance 2.5's green cast, removed BEFORE a resting pose is taken from the clip (Tess, Nov 20:
                # her lying pose came from the untinted last frame, so lying / sleeping / getting up looked green)
                frames, tinted = media.match_tint(frames, self.still['sit'])
            start_still = self.still_for(first)
            problems_extra, pose_k, paws_low = [], None, False
            if derive:
                pose_k = self.derive_pose(frames, start_still, undo_zoom=(derive != 'sleep'))
                end_still = self.to_still(pose_k)
                paws_low = bool(stats[-1].get('touches_bottom'))   # noted in the report (front paws may look a little flat)
                if not self.is_lying(end_still):
                    problems_extra.append(f'does not end {"lying down" if derive == "lie" else "asleep, lying down"}')
            else:
                end_still = self.still.get(end_name) if end_name else None
            fixed, metrics = media.correct_clip(frames, start_still, end_still, spread=opts.get('spread', False), ramp=opts.get('ramp', 1.0))
            if self.sex == 'female' and key in plan.REST_CLIPS and self.rest_fix:
                fixed, n = self.patch_rest(fixed)
                metrics['belly_patched'] = f'{n} frames'
            if self.sex == 'female' and (key in plan.SEATED_TRICKS or key in plan.MOVING_TRICKS) and 'sit' in self.still:
                fixed, n = media.patch_groin(fixed, self.still['sit'])
                metrics['belly_patched'] = f'{n}/{len(fixed)} frames'
            if tinted:
                metrics['tint_matched'] = f'{tinted} frames'
            if self.sex == 'female' and key in plan.SHADE_TRICKS:
                fixed, n = media.shade_belly(fixed)
                metrics['belly_shaded'] = f'{n}/{len(fixed)} frames'
            if derive and paws_low:   # the paws really leave the video (the low crop reaches its bottom)
                problems_extra.append('paws cut off at the bottom of the frame in the resting pose')
            fitted_end = None
            if end_still is not None and not derive:
                sc, o = media.fit(frames[-1], end_still)
                fitted_end = [media.affine(frames[-1], sc, o)]
            # (seated tricks of female pets are belly-patched above; the vision check misreads a smooth
            # front-on belly as male, so only the tail is checked there)
            patched = self.sex == 'female' and (key in plan.SEATED_TRICKS or key in plan.MOVING_TRICKS or key in plan.SHADE_NO_SEX_CHECK)
            problems_extra += [p for p in self.anatomy_problems(fixed, f'{key}_{attempt}')
                               if not (patched and 'male anatomy' in p)]
            if key == 'sleep_loop' and np.mean([bool(t.get('touches_bottom')) for t in stats]) > 0.1:
                problems_extra.append('paws cut off at the bottom of the frame while asleep')
            problems = media.clip_qa(frames, stats, metrics, end_still if not derive else None, fitted_end, final=fixed,
                                     max_zoom=plan.MAX_ZOOM.get(key, plan.MAX_ZOOM_DEFAULT),
                                     max_growth=plan.MAX_GROWTH.get(key),
                                     max_edge=plan.MAX_EDGE.get(key, 0.02),
                                     max_bottom=plan.MAX_BOTTOM.get(key, 0.05)) + problems_extra
            return (src, fixed, pose_k), problems, metrics
        src, fixed, pose_k = self.with_retries(key, attempt_fn, video=True)
        if derive:     # the chosen clip defines the resting pose the next clips start from
            self.kf[f'{derive}_end'] = pose_k
            media.save_green(pose_k, f'{self.kfdir}/kf_{derive}_end.png')
            with self.upload_lock:   # the old image (e.g. the sleep edit, used as this clip's target)
                self.urls.pop(f'kf_{derive}_end', None)   # may already be uploaded: send the new one
            self.still[derive] = self.to_still(pose_k)
            if derive == 'sleep' and 'lie' in self.still:     # one colour look across lying / sleeping
                self.still['sleep'] = media.apply_tf(self.still['sleep'], media.tf_to(media.dog_stats(self.still['sleep']), media.dog_stats(self.still['lie'])), 0.5)
            media.save_still(pose_k, f'{self.pet}/stills/{derive}.webp')
            self.female_rest_fix(derive)
            if derive in self.rest_fix:
                fixed, _ = self.patch_rest(fixed)
        if self.sex == 'female' and key in plan.MOVING_TRICKS:
            fixed, n = self.patch_moving(key, fixed)
            self.log(f'       {key}: female belly patched in {n}/{len(fixed)} frames from edited key frames')
        start_ref = self.still_for(first)
        end_ref = self.still.get(derive) if derive else (self.still.get(end_name) if end_name else None)
        fixed = media.blend_clip_colours(fixed, start_ref, end_ref)
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
            patched = 0
            if self.sex == 'female':      # the video model adds male anatomy in some head-turn frames: the body
                frames, patched = media.patch_groin(frames, self.still['sit'])   # barely moves, so the clean belly fits
            problems = []
            need = 0.25 * (1.0 if (c0, c1) == (0, 4) else 0.6)   # (tuned on Chunky + Chewie: good turns >= 0.33)
            if info['turn'] < need:
                problems.append(f'head barely turns (turn {info["turn"]:.2f} < {need:.2f})')
            areas = np.array([s['area'] for s in info['stats']])
            if areas.min() < 0.6 * np.median(areas):
                problems.append('subject vanishes in some frames')
            left, right = media.half_coverage(prog)
            metrics = {'turn': round(info['turn'], 3), 'left_share': round(left, 2), 'right_share': round(right, 2)}
            if self.sex == 'female':
                metrics['belly_patched'] = f'{patched}/{len(frames)} frames'
            return (frames, prog, left, right), problems, metrics
        return self.with_retries(it['key'], attempt_fn, video=True)

    def head_tracking(self):
        """One row of real frames per head height. Level: a full left->right sweep (plus a half
        sweep where it turned too fast). Tilted rows: four clips that start on tilted poses (left
        edge, centre, right edge) and turn outward; frames come from the first half of each, before
        the video model drifts back to a level head. Falls back to full / half sweeps."""
        def one_row(row):
            if row == 'level':
                frames, prog, left, right = self.sweep(row, 0, 4)
                pieces = [(0, 4, frames, prog)]
                for (c0, c1, share) in ((0, 2, left), (2, 4, right)):
                    if share < 0.3:
                        self.log(f'       {row}: {"left" if c0 == 0 else "right"} half only got {share:.0%} of frames -> half sweep')
                        try:
                            f2, p2, _, _ = self.sweep(row, c0, c1)
                            pieces.append((c0, c1, f2, p2))
                        except ProviderUnavailable:
                            raise
                        except Exception as e:  # noqa: BLE001
                            self.log(f'       {row}: half sweep skipped ({e})')
                return media.pick_row(pieces)
            # tilted: four clips that start on a tilted pose and turn outward (see pick_row_from_starts)
            pieces = []
            try:
                self.gaze_kf(2, row)
                for c0, c1 in ((0, 2), (2, 0), (2, 4), (4, 2)):
                    f2, p2, _, _ = self.sweep(row, c0, c1)
                    pieces.append((c0, c1, f2, p2))
            except ProviderUnavailable:
                raise
            except Exception as e:  # noqa: BLE001
                self.log(f'       {row}: tilted sweeps failed ({e}) -> fallback')
            frames = media.pick_row_from_starts(pieces) if len(pieces) == 4 else None
            if frames is not None:
                return frames
            if not any(p[:2] == (0, 4) for p in pieces):
                f, pr, _, _ = self.sweep(row, 0, 4)
                pieces.append((0, 4, f, pr))
            return media.pick_row([p for p in pieces if p[0] < p[1]])
        with ThreadPoolExecutor(min(self.workers, len(self.rows))) as ex:
            futs = {row: ex.submit(one_row, row) for row in self.rows}
            rows = [futs[r].result() for r in self.rows]
        self.look = media.save_look(rows, f'{self.pet}/look')
        for r, row in zip(self.rows, rows):
            media.sheet(row, f'{self.work}/sheets/look_{r}.jpg', n=11)
        self.check_look_heights()

    def check_look_heights(self):
        """Final check on what customers see most: the centre frame of each head height must
        really look up / down (vision check). A miss marks the pet for review."""
        problems, metrics = [], {}
        mid = self.look['cols'] // 2
        for r, row in enumerate(self.rows):
            if row not in plan.V_OK:
                continue
            p = f'{self.pet}/look/{r}_{mid}.webp'
            png = f'{self.work}/look_{row}_centre.png'
            Image.open(p).convert('RGBA').save(png)
            seen = self.look_check(png)
            if not seen:
                continue
            metrics[row] = seen.get('vertical')
            wrong = {'up': {'level', 'slightly down', 'down'}, 'hu': {'slightly down', 'down'},
                     'hd': {'slightly up', 'up'}, 'down': {'level', 'slightly up', 'up'}}[row]
            if seen.get('vertical') in wrong:   # the vision check is noisy: only flag clear misses
                problems.append(f'{row} row: centre frame looks {seen.get("vertical")}')
        self.record('head looks up and down', 1, problems, metrics)

    def reference_colours(self):
        """The pet's true colours = the video look of the level head sweep (same sitting pose).
        The sitting still comes from the image model, which renders colours a little
        differently, so it's recoloured to match; everything else follows from it."""
        if getattr(self, 'ref_stats', None) is not None:
            return
        it = plan.sweep_item('level', 0, 4)
        for kfname in (it['first'], it['last']):
            if kfname.startswith('kf_gaze_'):
                _, _, col, r = kfname.split('_', 3)
                self.gaze_kf(int(col), r)
        src = self.gen_video(it['key'], it['prompt'], it['first'], it['last'], it['seconds'])
        frames, _, _ = media.sweep_frames(src, self.still['sit'], match=False)
        mid = frames[len(frames) // 4: 3 * len(frames) // 4]
        px = np.concatenate([f[..., :3][f[..., 3] > 200].astype(np.float32) for f in mid[::4]])
        self.ref_stats = (px.mean(0), px.std(0) + 1e-3)
        before = media.dog_stats(self.still['sit'])
        self.still['sit'] = media.apply_tf(self.still['sit'], media.tf_to(before, self.ref_stats))
        Image.fromarray(self.still['sit']).save(f'{self.pet}/stills/sit.webp', quality=90, method=6)
        self.log('       colours: sitting pose matched to the video look '
                 f'(mean RGB {np.round(before[0]).astype(int).tolist()} -> {np.round(self.ref_stats[0]).astype(int).tolist()})')

    def clips(self):
        acts = [a for a in self.actions if a in plan.ACTIONS]
        # gaze keyframes for the sweeps first (cheap), so the video queue starts full
        for row in self.rows:
            for col in (0, 4):
                self.gaze_kf(col, row)
        self.reference_colours()
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
        for a in range(1, self.max_retries + 2 + plan.SEX_EXTRA_TRIES):
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
        labels = dict(plan.FEMALE_LABELS) if self.sex == 'female' else {}
        if self.species == 'cat':
            labels.update(plan.CAT_LABELS)                    # Meow / Happy purr / Kitten eyes
        if labels:
            manifest['labels'] = labels
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
        except ProviderUnavailable:      # not a pet problem: the worker puts the order back in the queue
            raise
        except Exception as e:  # noqa: BLE001 - report every failure
            self.error = f'{e.__class__.__name__}: {e}'
            self.log('FAILED: ' + self.error)
            traceback.print_exc()
        finally:
            from .report import write_report
            write_report(self)
        return self.error is None
