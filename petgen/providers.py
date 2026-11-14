"""AI providers (what makes images / clips) and hosting (public URLs for the video model).

GPTProtoProvider  - the real thing (Nano Banana Pro images, Seedance 2.0 Mini clips).
ReplayProvider    - returns previously generated files instead of calling an API, so the
                    whole pipeline (processing + QA + packaging) can be tested for free.

The video model only accepts images by URL, so keyframes must be hosted:
GitRawUploader    - DEV ONLY: pushes to a branch of a PUBLIC GitHub repo (what we used for
                    Chunky). Never use with customers' pets.
S3Uploader        - production: S3 / Cloudflare R2 bucket, private, short-lived signed URLs.
"""
import base64, os, re, shutil, subprocess, time
import requests

API = 'https://gptproto.com'


def _session():
    s = requests.Session()
    key = os.environ.get('GPTPROTO_API_KEY', 'proxy-injected')   # in the cloud container the proxy injects it
    s.headers.update({'Authorization': f'Bearer {key}'})
    ca = os.environ.get('REQUESTS_CA_BUNDLE') or ('/root/.ccr/ca-bundle.crt' if os.path.exists('/root/.ccr/ca-bundle.crt') else None)
    if ca:
        s.verify = ca
    return s


class GPTProtoProvider:
    image_model = 'gemini-3-pro-image-preview'
    video_path = 'doubao/dreamina-seedance-2-0-mini-260615/image-to-video'

    def __init__(self, log=print):
        self.s = _session()
        self.log = log

    @staticmethod
    def _data_uri(path):
        ext = 'png' if path.lower().endswith('.png') else 'jpeg'
        return f'data:image/{ext};base64,' + base64.b64encode(open(path, 'rb').read()).decode()

    def image(self, key, prompt, ref_paths, out_path):
        """Nano Banana Pro via the OpenAI-style chat endpoint (accepts base64 images)."""
        content = [{'type': 'text', 'text': prompt}] + [{'type': 'image_url', 'image_url': {'url': self._data_uri(p)}} for p in ref_paths]
        for attempt in range(3):
            r = self.s.post(f'{API}/v1/chat/completions', json={'model': self.image_model, 'messages': [{'role': 'user', 'content': content}],
                                                               'modalities': ['image', 'text']}, timeout=300)
            if r.status_code >= 500:
                self.log(f'  {key}: server error {r.status_code}, retrying')
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            msg = r.json()['choices'][0]['message']
            found = [im.get('image_url', {}).get('url') for im in (msg.get('images') or [])]
            text = msg.get('content') if isinstance(msg.get('content'), str) else str(msg.get('content'))
            found += re.findall(r'data:image/[a-z]+;base64,[A-Za-z0-9+/=]+', text or '')
            found = [f for f in found if f]
            if not found:
                raise RuntimeError(f'{key}: no image in response: {(text or "")[:200]}')
            open(out_path, 'wb').write(base64.b64decode(found[0].split(',', 1)[1]))
            return out_path
        raise RuntimeError(f'{key}: image request kept failing')

    def video(self, key, prompt, first_url, last_url, seconds, out_path):
        """Seedance 2.0 Mini first/last-frame image-to-video, 720p square, no audio."""
        body = {'prompt': prompt, 'image': first_url, 'aspect_ratio': '1:1', 'duration': int(seconds),
                'resolution': '720p', 'generate_audio': False, 'is_upload_media': False, 'seed': -1}
        if last_url:
            body['last_image'] = last_url          # (camera_fixed is not allowed together with last_image)
        else:
            body['camera_fixed'] = True
        r = self.s.post(f'{API}/api/v3/{self.video_path}', json=body, timeout=120)
        j = r.json()
        d = j.get('data') or {}
        if not d.get('id'):
            raise RuntimeError(f'{key}: submit failed: {str(j)[:300]}')
        url = (d.get('urls') or {}).get('get') or f"{API}/api/v3/predictions/{d['id']}/result"
        self.log(f'  {key}: submitted {d["id"]}')
        t0 = time.time()
        while True:
            if d.get('status') in ('completed', 'succeeded') and d.get('outputs'):
                break
            if d.get('status') == 'failed':
                raise RuntimeError(f'{key}: failed: {d.get("error")}')
            if time.time() - t0 > 50 * 60:
                raise RuntimeError(f'{key}: timed out ({d["id"]})')
            time.sleep(8)
            try:
                d = self.s.get(url, timeout=60).json().get('data') or d
            except requests.RequestException:
                pass
        out = d['outputs'][0]
        with requests.get(out, stream=True, timeout=300, verify=self.s.verify) as dl:
            dl.raise_for_status()
            with open(out_path, 'wb') as f:
                shutil.copyfileobj(dl.raw, f)
        self.log(f'  {key}: done in {int(time.time() - t0)} s')
        return out_path


class ReplayProvider:
    """Serves existing files by key (e.g. Chunky's footage) instead of calling an API."""

    def __init__(self, mapping, log=print):
        self.map = mapping
        self.log = log
        self.misses = []

    def _get(self, key, out_path):
        src = self.map.get(key)
        if not src or not os.path.exists(src):
            self.misses.append(key)
            raise FileNotFoundError(f'replay: nothing recorded for {key}')
        shutil.copy(src, out_path)
        return out_path

    def image(self, key, prompt, ref_paths, out_path):
        return self._get(key, out_path)

    def video(self, key, prompt, first_url, last_url, seconds, out_path):
        return self._get(key, out_path)


# ------------------------------------------------------------------ hosting
class NoUploader:
    """For replay runs: nothing needs to be reachable from outside."""
    def upload(self, path, key):
        return f'file://{os.path.abspath(path)}'


class GitRawUploader:
    """DEV ONLY. Pushes files to a branch of a PUBLIC GitHub repo and returns raw URLs."""

    def __init__(self, repo_dir, owner_repo, branch='petgen-uploads'):
        import threading
        self.lock = threading.Lock()      # git can't run concurrently in one worktree
        self.repo_dir, self.owner_repo, self.branch = repo_dir, owner_repo, branch
        self.wt = os.path.join(repo_dir, '.petgen-uploads')
        if not os.path.exists(self.wt):
            subprocess.run(['git', '-C', repo_dir, 'fetch', '-q', 'origin', branch], check=False)
            has_remote = subprocess.run(['git', '-C', repo_dir, 'rev-parse', '--verify', '-q', f'origin/{branch}'], capture_output=True).returncode == 0
            if has_remote:
                subprocess.run(['git', '-C', repo_dir, 'worktree', 'add', '-B', branch, self.wt, f'origin/{branch}'], check=True)
            else:
                subprocess.run(['git', '-C', repo_dir, 'worktree', 'add', '--detach', self.wt], check=True)
                subprocess.run(['git', '-C', self.wt, 'checkout', '-q', '--orphan', branch], check=True)
                subprocess.run(['git', '-C', self.wt, 'rm', '-rqf', '.'], check=True)

    def upload(self, path, key):
        with self.lock:
            return self._upload(path, key)

    def _upload(self, path, key):
        gitdir = subprocess.run(['git', '-C', self.wt, 'rev-parse', '--absolute-git-dir'], capture_output=True, text=True).stdout.strip()
        lock = os.path.join(gitdir, 'index.lock')
        if os.path.exists(lock) and time.time() - os.path.getmtime(lock) > 60:
            os.remove(lock)               # stale lock from a crashed run
        dest = os.path.join(self.wt, key)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy(path, dest)
        subprocess.run(['git', '-C', self.wt, 'add', key], check=True)
        subprocess.run(['git', '-C', self.wt, 'commit', '-qm', f'petgen upload {key}'], check=False)
        for i in range(4):
            if subprocess.run(['git', '-C', self.wt, 'push', '-q', 'origin', f'HEAD:{self.branch}']).returncode == 0:
                break
            time.sleep(2 ** (i + 1))
        url = f'https://raw.githubusercontent.com/{self.owner_repo}/{self.branch}/{key}'
        for _ in range(10):   # wait until GitHub serves it
            try:
                if requests.head(url, timeout=20).status_code == 200:
                    break
            except requests.RequestException:
                pass
            time.sleep(3)
        return url


class S3Uploader:
    """Production: private S3 / Cloudflare R2 bucket + short-lived signed URLs.
    Env: S3_ENDPOINT (R2: https://<account>.r2.cloudflarestorage.com), S3_BUCKET,
    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.  Needs `pip install boto3`."""

    def __init__(self, prefix):
        import boto3   # noqa: deferred so dev runs don't need it
        self.s3 = boto3.client('s3', endpoint_url=os.environ.get('S3_ENDPOINT'))
        self.bucket = os.environ['S3_BUCKET']
        self.prefix = prefix.strip('/')

    def upload(self, path, key):
        k = f'{self.prefix}/{key}'
        self.s3.upload_file(path, self.bucket, k, ExtraArgs={'ContentType': 'image/png'})
        return self.s3.generate_presigned_url('get_object', Params={'Bucket': self.bucket, 'Key': k}, ExpiresIn=6 * 3600)
