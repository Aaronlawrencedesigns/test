"""Desktop Sidekicks worker: makes a pet for every paid order. Runs as a systemd service on the
DigitalOcean server (see deploy/setup.sh).

Order flow in the R2 bucket (written by the website's Stripe webhook, site/functions/):
  queue/paid/<id>      paid, waiting          -> this worker claims it
  queue/working/<id>   being made
  queue/review/<id>    made; the owner reviews it and clicks "Approve and send" (site: /api/admin/approve)
  queue/delivered/<id> approved; the customer was emailed their pet code (codes/<CODE> -> id)
  queue/failed/<id>    making failed (see order.json "error")
  queue/test/<id>      Stripe test-mode order, skipped unless ALLOW_TEST_ORDERS=1
Results: orders/<id>/pet.zip, orders/<id>/report.html. Generation keyframes: orders/<id>/kf/*.

Env (/etc/sidekicks.env): GPTPROTO_API_KEY, S3_ENDPOINT, S3_BUCKET, AWS_ACCESS_KEY_ID,
AWS_SECRET_ACCESS_KEY, POSTMARK_TOKEN, OWNER_EMAIL, ALLOW_TEST_ORDERS, SIDEKICKS_WORK,
PETGEN_WORKERS (clips made at once; default 3, each needs ~0.5-1 GB of memory).
"""
import datetime, json, os, secrets, shutil, sys, time, traceback

import boto3
import requests

from . import plan
from .pipeline import Job
from .providers import GPTProtoProvider, S3Uploader

try:                                    # customers' iPhone photos (HEIC)
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

BUCKET = os.environ.get('S3_BUCKET', 'desktopsidekicks-orders')
WORK = os.environ.get('SIDEKICKS_WORK', '/var/lib/sidekicks/orders')
POLL = int(os.environ.get('POLL_SECONDS', '60'))
ALLOW_TEST = os.environ.get('ALLOW_TEST_ORDERS', '0') == '1'
OWNER = os.environ.get('OWNER_EMAIL', '').strip()
VIEWS = ['front', 'side', 'back', 'sit']
SITE = os.environ.get('SITE_URL', 'https://desktopsidekicks.com').rstrip('/')
CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'   # no 0/O, 1/I


def new_code():
    """A pet code like K7QM-4XTP-9HRC (60 bits), unique in the bucket."""
    while True:
        raw = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(12))
        code = f'{raw[:4]}-{raw[4:8]}-{raw[8:]}'
        try:
            s3.head_object(Bucket=BUCKET, Key=f'codes/{code}')
        except Exception:  # noqa: BLE001 - not found: free to use
            return code

s3 = boto3.client('s3', endpoint_url=os.environ.get('S3_ENDPOINT'), region_name=os.environ.get('AWS_DEFAULT_REGION', 'auto'))


def log(msg):
    print(f'{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}', flush=True)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def get_order(oid):
    return json.loads(s3.get_object(Bucket=BUCKET, Key=f'orders/{oid}/order.json')['Body'].read())


def put_order(o):
    s3.put_object(Bucket=BUCKET, Key=f'orders/{o["id"]}/order.json', Body=json.dumps(o, indent=2).encode(), ContentType='application/json')


def move(oid, src, dst):
    s3.put_object(Bucket=BUCKET, Key=f'queue/{dst}/{oid}', Body=now().encode())
    s3.delete_object(Bucket=BUCKET, Key=f'queue/{src}/{oid}')


def queued(state):
    keys = []
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=f'queue/{state}/'):
        keys += [c['Key'].rsplit('/', 1)[1] for c in page.get('Contents', [])]
    return keys


def link(key, days=7):
    return s3.generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': key}, ExpiresIn=days * 86400)


def email_owner(subject, text):
    token = os.environ.get('POSTMARK_TOKEN')
    if not (token and OWNER):
        log(f'(no owner email set) {subject}')
        return
    try:
        r = requests.post('https://api.postmarkapp.com/email', timeout=30,
                          headers={'Accept': 'application/json', 'X-Postmark-Server-Token': token},
                          json={'From': 'Desktop Sidekicks <hello@desktopsidekicks.com>', 'To': OWNER, 'Subject': subject,
                                'TextBody': text, 'Tag': 'owner-review', 'MessageStream': 'outbound'})
        if r.status_code != 200:
            log(f'owner email failed: {r.text[:200]}')
    except requests.RequestException as e:
        log(f'owner email failed: {e}')


def verdict(job):
    final = {}
    for q in job.qa:
        final[q['item']] = q
    failed = [k for k, q in final.items() if q['problems'] and not k.startswith('photo')]
    warn = [k for k, q in final.items() if q['problems'] and k.startswith('photo')]
    cost = plan.est_cost(job.cost)
    ok = job.error is None and not failed
    return ok, failed, warn, round(cost, 2)


def make(oid):
    o = get_order(oid)
    name = o.get('pet_name') or 'Your pet'
    log(f'{oid}: making {name} ({o.get("species")})')
    move(oid, 'paid', 'working')
    o.update(status='making', started_at=now())
    put_order(o)

    d = os.path.join(WORK, oid)
    pdir = os.path.join(d, 'photos')
    os.makedirs(pdir, exist_ok=True)
    photos = []
    for v in VIEWS:
        key = o['photos'][v]
        dest = os.path.join(pdir, os.path.basename(key))
        if not os.path.exists(dest):
            s3.download_file(BUCKET, key, dest)
        photos.append(dest)

    job = Job(name, photos, os.path.join(d, 'out'), GPTProtoProvider(log=lambda m: log(f'{oid}: {m}')),
              S3Uploader(prefix=f'orders/{oid}/kf'), species=o.get('species') or 'dog', log=lambda m: log(f'{oid}: {m}'),
              workers=int(os.environ.get('PETGEN_WORKERS', '3')), tail=o.get('tail') or 'yes',
              sex=o.get('sex') or 'male')
    job.run()
    ok, failed, warn, cost = verdict(job)

    zip_path = shutil.make_archive(os.path.join(d, 'pet'), 'zip', job.pet)
    s3.upload_file(zip_path, BUCKET, f'orders/{oid}/pet.zip', ExtraArgs={'ContentType': 'application/zip'})
    s3.upload_file(f'{job.out}/report.html', BUCKET, f'orders/{oid}/report.html', ExtraArgs={'ContentType': 'text/html'})
    upload_preview(oid, f'{job.out}/preview')

    o = get_order(oid)
    if not o.get('code'):                          # the customer's pet code (works once approved)
        o['code'] = new_code()
        s3.put_object(Bucket=BUCKET, Key=f'codes/{o["code"]}', Body=oid.encode())
    o.setdefault('approve_token', secrets.token_urlsafe(24))
    o.update(status='review', made_at=now(), ready=ok, needs_look=failed, photo_warnings=warn, ai_cost_usd=cost,
             error=job.error, pet_zip=f'orders/{oid}/pet.zip', report=f'orders/{oid}/report.html')
    put_order(o)
    move(oid, 'working', 'review')
    head = 'Ready to ship' if ok and not warn else ('Ready, with photo warnings' if ok else 'Needs a look')
    log(f'{oid}: {head} (est. ${cost}), code {o["code"]}')
    approve = f'{SITE}/api/admin/approve?id={oid}&t={o["approve_token"]}'
    email_owner(f'{head}: {name} (order {oid[:8]})',
                f'{name} for {o.get("email")} is made.\n\nVerdict: {head}\nEstimated AI cost: ${cost}\n'
                + (f'Needs a look: {", ".join(failed)}\n' if failed else '')
                + (f'Photo warnings: {", ".join(warn)}\n' if warn else '')
                + (f'Error: {job.error}\n' if job.error else '')
                + f'\nReview it, then approve and send it to the customer:\n{approve}\n'
                + f'\nTry it like on your Mac (menu, sizes, every trick):\n{SITE}/api/admin/preview/{oid}/{o["approve_token"]}/index.html\n'
                + f'\nQA report:\n{SITE}/api/admin/report?id={oid}&t={o["approve_token"]}\n'
                + f'\nPet pack (link valid 7 days):\n{link(f"orders/{oid}/pet.zip")}\n'
                + f'\nTo remake it instead: sidekicks-requeue {oid}\n')


PREVIEW_TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
                 '.webp': 'image/webp', '.webm': 'video/webm', '.png': 'image/png'}


def upload_preview(oid, pv):
    """The playable preview (petgen/preview.html + player + pet files) -> orders/<id>/preview/ for the owner."""
    if not os.path.isdir(pv):
        return
    for root, _, files in os.walk(pv):
        for f in files:
            src = os.path.join(root, f)
            rel = os.path.relpath(src, pv).replace(os.sep, '/')
            ct = PREVIEW_TYPES.get(os.path.splitext(f)[1], 'application/octet-stream')
            s3.upload_file(src, BUCKET, f'orders/{oid}/preview/{rel}', ExtraArgs={'ContentType': ct})


def tick():
    for oid in queued('paid'):
        try:
            o = get_order(oid)
        except Exception as e:  # noqa: BLE001
            log(f'{oid}: cannot read order: {e}')
            continue
        if not o.get('livemode') and not ALLOW_TEST:
            log(f'{oid}: test-mode order, skipped (set ALLOW_TEST_ORDERS=1 to make it)')
            move(oid, 'paid', 'test')
            continue
        try:
            make(oid)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            log(f'{oid}: FAILED {e}')
            try:
                o = get_order(oid)
                o.update(status='failed', error=f'{e.__class__.__name__}: {e}', failed_at=now())
                put_order(o)
                move(oid, 'working', 'failed')
            except Exception:  # noqa: BLE001
                traceback.print_exc()
            email_owner(f'Failed: order {oid[:8]}', f'Making order {oid} failed:\n{e}\n\nCheck the server log: journalctl -u sidekicks-worker')


def requeue(oid, tail=None, sex=None):
    if tail or sex:
        o = get_order(oid)
        if tail:
            o['tail'] = tail
        if sex:
            o['sex'] = sex
        put_order(o)
    """python -m petgen.worker requeue <order id> [tail=yes|stub|none] [sex=male|female]: retry a failed order, make a skipped
    test order, or re-make a pet (a re-made pet waits for approval again; its code stays the same)."""
    for state in ('test', 'failed', 'review', 'delivered'):
        if oid in queued(state):
            move(oid, state, 'paid')
            return log(f'{oid}: moved from {state} back to the queue')
    log(f'{oid}: not found in test/failed/review/delivered')


def main():
    if len(sys.argv) > 2 and sys.argv[1] == 'requeue':
        opt = lambda k: next((a.split('=', 1)[1] for a in sys.argv[3:] if a.startswith(k + '=')), None)
        return requeue(sys.argv[2], opt('tail'), opt('sex'))
    os.makedirs(WORK, exist_ok=True)
    log(f'worker up: bucket {BUCKET}, test orders {"ON" if ALLOW_TEST else "off"}, owner email {"set" if OWNER else "NOT set"}')
    for oid in queued('working'):           # interrupted by a restart: resume (finished steps are cached)
        log(f'{oid}: resuming')
        move(oid, 'working', 'paid')
    while True:
        try:
            tick()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        if '--once' in sys.argv:
            return
        time.sleep(POLL)


if __name__ == '__main__':
    main()
