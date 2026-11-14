"""petgen: 4 photos of a pet -> a finished desk pet (pet pack + preview + QA report).

  python3 -m petgen make --name Rex --photos front.jpg side.jpg back.jpg sit.jpg --out out/rex
  python3 -m petgen make ... --replay fixtures.json --host none     # free test run, no API calls

Hosting (the video model needs keyframe URLs):
  --host git   DEV ONLY: public GitHub branch (never for customers' pets)
  --host s3    S3 / Cloudflare R2 (env: S3_ENDPOINT, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
  --host none  only for --replay runs
"""
import argparse, json, os, sys

from . import plan
from .pipeline import Job, ROOT
from .providers import GPTProtoProvider, ReplayProvider, GitRawUploader, S3Uploader, NoUploader


def main(argv=None):
    ap = argparse.ArgumentParser(prog='petgen')
    sub = ap.add_subparsers(dest='cmd', required=True)
    mk = sub.add_parser('make', help='make a pet from photos')
    mk.add_argument('--name', required=True)
    mk.add_argument('--photos', nargs='+', required=True)
    mk.add_argument('--out', required=True)
    mk.add_argument('--species', default='dog')
    mk.add_argument('--actions', nargs='*', default=None, help=f'default: {" ".join(plan.DEFAULT_ACTIONS)}')
    mk.add_argument('--rows', choices=['5', '3'], default='5', help='head heights for head tracking')
    mk.add_argument('--host', choices=['git', 's3', 'none'], default='git')
    mk.add_argument('--repo', default='Aaronlawrencedesigns/test', help='owner/repo for --host git')
    mk.add_argument('--replay', help='JSON map of item key -> existing file (free test run)')
    mk.add_argument('--max-retries', type=int, default=2)
    mk.add_argument('--workers', type=int, default=6)
    a = ap.parse_args(argv)

    if a.replay:
        provider = ReplayProvider(json.load(open(a.replay)))
    else:
        provider = GPTProtoProvider()
    if a.host == 'git':
        print('WARNING: --host git publishes keyframes in a PUBLIC GitHub repo. Dev/testing only.', file=sys.stderr)
        uploader = GitRawUploader(ROOT, a.repo)
    elif a.host == 's3':
        uploader = S3Uploader(prefix='petgen')
    else:
        uploader = NoUploader()
    job = Job(a.name, a.photos, a.out, provider, uploader, species=a.species, actions=a.actions,
              rows=plan.ROWS if a.rows == '5' else plan.ROWS_LITE, max_retries=a.max_retries, workers=a.workers)
    ok = job.run()
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
