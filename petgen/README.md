# petgen: 4 photos → a finished desk pet

Milestone 1 of **Desktop Sidekicks** (desktopsidekicks.com): the generator that
turns customer photos into a pet pack, with no hand-fixing.

```bash
python3 -m petgen make --name Rex --photos front.jpg side.jpg back.jpg sitting.jpg --out out/rex
```

Output in `out/rex/`:
- `pet/`: the pet pack (`manifest.json`, `look/` head-tracking frames, `stills/`, `clips/`), about 9 MB.
- `preview/`: a playable page using the product's player (`petgen/engine/`, its own copy, separate
  from Chunky's `src/`); serve it with `python3 -m http.server`.
- `report.html`: verdict, estimated AI cost, every quality check, contact sheets of every clip.
- `work/`: raw generations (cache), keyframes, sheets.

## Steps
1. **Photos:** 3–6 photos, size and sharpness checks, resized to ≤1024 px.
2. **Portrait and poses (Nano Banana Pro):** studio portrait from the photos, then green-screen
   sit / lie / sleep, cut out and normalised to one scale and ground line.
3. **Head directions:** far-left / far-right head poses for each head height, with the turned
   head pasted onto the shared sitting body.
4. **Clips (Seedance 2.0 Mini, run in parallel):**
   - one head-sweep per head height (5 by default, `--rows 3` for fewer); a half sweep is added
     **only** when a sweep spent < 30 % of its frames on one side.
   - tricks: wag, puppy, stand, eat, bark, poop, lie_down, get_up, fall_asleep, then
     sleep_loop / wake_up from fall_asleep's last frame, so they connect exactly.
5. **Processing:** chroma key, drift correction (`spread` for lie/get-up/wake-up),
   colour-matched head-tracking frames picked evenly by accumulated head movement.
6. **Package:** manifest (head, mouth and ear positions for the engine), preview, report.

## Quality gates (each failure regenerates that item, up to `--max-retries`, default 2)
- poses: cut-out size sane, no separate pieces, not cut off at the frame edge
- clips: pet never vanishes (keying), framing drift within limits, ends in the expected pose
- sweeps: the head really turns; coverage of each side (adds a half sweep when thin)
If every try fails, the best one is kept and the report says **Needs review**.

## Cost and caching
About **$7–9 per pet** at current GPTProto prices (≈11 images + ≈16 clips), shown in the report.
Every API result is cached in `work/gen/`, so re-running a job never pays twice.

## Hosting (the video model only accepts image URLs)
- `--host git`: **DEV ONLY**, pushes keyframes to the `petgen-uploads` branch of a public repo.
- `--host s3`: production, a private S3 / Cloudflare R2 bucket with short-lived signed URLs
  (`pip install boto3`; env `S3_ENDPOINT S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY`).
Customer photos themselves are never uploaded to hosting; only generated green-screen keyframes are.

## Free test runs
`--replay fixtures.json --host none` serves recorded files instead of calling the API
(a JSON map of item key → file, e.g. Chunky's footage). It exercises every processing
step, gate and the packaging at $0.

## Next (milestone 2+)
Website + Stripe checkout + uploads, a worker queue, a signed "Desktop Sidekicks" app that
downloads a customer's pet pack by personal link, email delivery, owner approve-before-send.
