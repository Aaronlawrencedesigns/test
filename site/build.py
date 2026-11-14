"""Assemble the Desktop Sidekicks site into site/dist/ (ready to host anywhere static).

The demo pet uses the product player (petgen/engine) with copies of Chunky's footage;
Chunky's own files are only read, never changed.
    python3 site/build.py && python3 -m http.server -d site/dist 8000
"""
import os, shutil
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')
DIST = os.path.join(SITE, 'dist')

FILES = {'index.html': 'site/index.html', 'pet.html': 'site/pet.html',
         'app.js': 'petgen/engine/app.js', 'style.css': 'petgen/engine/style.css'}
ASSET_DIRS = ['assets/look', 'assets/gaze', 'assets/stills', 'assets/clips']


def files():
    out = dict(FILES)
    for d in ASSET_DIRS:
        for f in sorted(os.listdir(os.path.join(ROOT, d))):
            if f.endswith(('.webp', '.webm')):
                out[f'{d}/{f}'] = f'{d}/{f}'
    return out


if __name__ == '__main__':
    shutil.rmtree(DIST, ignore_errors=True)
    for dest, src in files().items():
        os.makedirs(os.path.dirname(os.path.join(DIST, dest)), exist_ok=True)
        shutil.copy(os.path.join(ROOT, src), os.path.join(DIST, dest))
    print(f'{len(files())} files -> {DIST}')
