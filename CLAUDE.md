# Chunky: project notes for Claude

Chunky is the owner's real French Bulldog (lilac fawn merle, pale blue-grey eyes,
bat ears). This repo is a desktop pet: realistic AI footage of Chunky that sits in
the bottom-right corner and turns his head to follow the mouse.

## Two front-ends, one engine
- **Mac app (Electron):** `src/main.js` (transparent always-on-top click-through
  window, tray + right-click menus incl. Size, global cursor feed),
  `src/preload.js` (bridge `window.dogApi`), `src/index.html`, `src/style.css`.
  Run: `npm install && npm start`. The owner runs it from `~/chunky` on their Mac
  (`git pull` to update). Mac only.
- **Web version / Claude Artifact:** `web/index.html` (page + controls) embeds
  `web/chunky.html` (frame with a `dogApi` shim fed by `postMessage`).
  Published at https://claude.ai/artifact/CxY7zRmwo3guYXh3Uf5Qoc. To update,
  publish `web/index.html` again with the same `url` and the same `files` map
  (chunky.html, portrait.webp, app.js ← src/app.js, style.css ← src/style.css,
  and every file under assets/gaze, assets/stills, assets/clips, assets/look).
  The artifact still holds unused old files under assets/head and assets/sweep;
  remove them (map each path to null) if a publish ever hits the 511-file limit.
- **Shared engine:** `src/app.js` (both use it). `window.CHUNKY_ASSETS` sets the asset path.

## How the animation works
- Resting states `sit | lie | sleep`. Sitting head-tracking shows exactly ONE
  real video frame at a time (never blended → never blurry/ghosted):
  `assets/look/{row}_{i}.webp`, rows = 5 head heights (0 up, 1 slightly up,
  2 level, 3 slightly down, 4 down), i = 0..32 far left → far right, cropped to
  the box in `LOOK` in `src/app.js` (copy from `assets/look/meta.json` if rebuilt).
  Pipeline: Seedance head-sweep clips (far-left → far-right keyframes
  `assets/keyframes/gaze_{0|4}_{0|1|2|hu|hd}.png`, made by
  `tools/gaze_keyframes.py`) → `tools/build_sweeps.py ROW:REF[:U0-U1] clip.mp4 …`
  (turn progress = accumulated head movement; half-sweeps fill halves where a
  full sweep turned too fast. Used: `0:0 sweep_0, 0:0:0-2 half_up_left,
  1:0 sweep_hu, 1:0:0-2 half_hu_left, 2:1 sweep_1, 2:1:2-4 half_lvl_right,
  3:1 sweep_hd, 3:1:2-4 half_hd_right, 4:2 sweep_2`; every row has 33
  distinct frames) →
  `tools/build_look_frames.py`. Head follows the cursor with a critically damped
  spring (stiffness 24); cursor polled at ~120 Hz. Optical-flow in-betweens and
  head/body compositing were tried and dropped: both blur or ghost.
  Fallback until frames load: the 5x3 grid `assets/gaze/{col}_{row}.webp`.
- All assets share one 640x640 frame (`CROP_1024`/`OUT_SIZE` in `tools/key.py`,
  square so he can stand on his hind legs); the Mac window is 400x400 at Normal
  (taller while the food tray is open).
- Actions are transparent VP9 WebM clips (`assets/clips/*.webm`, 640x640) that
  start/end on keyframes; `CLIPS` and `ROUTES` in `src/app.js` define the graph.
  Every cut is crossfaded (280 ms).
- Sleep chosen from a menu/button (`S.stayAsleep`) lasts until another action is
  chosen; mouse moves and clicks don't wake him. Idle-triggered naps still wake on mouse move.
- Nap: after `NAP_AFTER_MS` (30 s) without mouse movement he goes to sleep
  (`S.napping`) and wakes as soon as the mouse moves. Only the owner's activity
  resets the timer (`act(..., fromUser)`); his own idle tricks don't, and tricks
  only happen while the owner is active.
- Lying down on his own: he gets back up after 5–10 s (`S.lieUntil`). "Lie down"
  chosen from the menu (`S.userLie`) lasts until another action. The lie still breathes.
- Bark only plays when chosen from the menu/button: it's left out of his idle
  routine and of the random tricks on click (the owner found it distracting).
- Feeding: menu "Feed Chunky" / web "Feed" button sends action `feed`, which
  toggles a vertical food tray floating above his head (`TRAY_LIFT` = gap, a quarter
  of his width, 100px at Normal; `#tray`, foods in
  `FOODS` in `src/app.js`). His square is the BOTTOM of the window (`SZ()`,
  `stageTop()`); while the tray is open the window grows upward via
  `dogApi.setExtraTop(px)` (Electron: `extend` IPC; web: `extend` message to the page). Dragging a food
  onto him (dog pixels or near `MOUTH`) runs `act('eat:<food>')`: three bites with
  crumbs, then the `eat` clip (chew + lick lips), then `wag`. A miss floats the food
  back. The tray and a held food count as "over" for click-through.
- To add an action: generate clip → convert → add to `CLIPS` in `src/app.js`,
  the menu in `src/main.js`, and a button in `web/index.html`.

## Generating new footage (costs real money: ask the owner first)
- Provider: **GPTProto** (gptproto.com). Key is saved as a network secret on the
  cloud environment **"test"** (the proxy injects it; scripts use
  `GPTPROTO_API_KEY` or the placeholder `proxy-injected`). Never print or commit keys.
- Images: Nano Banana Pro via the OpenAI-style chat endpoint
  (`tools/generate/chatimg.mjs`, model `gemini-3-pro-image-preview`), which accepts
  base64 images. The v3 image API only takes URLs.
- Video: Seedance 2.0 Mini first/last-frame (`tools/generate/clip.mjs`,
  prompts in `tools/generate/clips.sh`), ~$0.20 per 5 s clip. Keyframes are read
  from this public repo's raw GitHub URLs, so push new keyframes first.
  `camera_fixed` is not allowed together with `last_image`.
  Jobs finish with status `succeeded` (not `completed`).
  Results download from `ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com`
  (allowed on the "test" environment).
- Node's fetch needs `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`
  in the cloud container.
- Convert: `python3 tools/clip2webm.py in.mp4 assets/clips/x.webm --fit-start sit --fit-end sit`
  (chroma key + eases framing drift onto the keyframes). Use `--spread` for clips
  whose framing drifts a lot (lie_down, get_up, wake_up): the correction is spent
  while he moves, so he never visibly shrinks/grows at the end. Stills/gaze:
  `tools/build_stills.py`. Shared crop/size: `CROP_1024`, `OUT_SIZE` in `tools/key.py`.
- Green-screen keyframes: `assets/keyframes/` (sit, lie, sleep, sleep_side, master_studio).

## Signing / notarization
Owner has an Apple Developer account. `npm run dist:signed` = electron-builder with
hardened runtime + `build/entitlements.mac.plist`, signed by the Developer ID cert in
the owner's Keychain, notarized via the Keychain profile `chunky-notary`
(`APPLE_KEYCHAIN_PROFILE`; created with `xcrun notarytool store-credentials`).
Without credentials, notarization is skipped silently. Steps are in README.md.
Signing can only run on the owner's Mac (not in the cloud container).

## Product: Desktop Sidekicks (desktopsidekicks.com)
The owner is turning this into a product: customers upload 4 pet photos, pay, and
get their own desk pet. Milestone 1 is `petgen/` (see petgen/README.md): photos →
pet pack + preview + QA report, automated with quality gates and retries, cached.
**Keep Chunky separate:** the owner wants Chunky's app kept as-is for himself.
Product work lives in `petgen/`, `site/` and `app/` and must NOT change Chunky's `src/`, `web/`,
`assets/` or `tools/`. The product has its own copy of the player in
`petgen/engine/` (reads per-pet measurements from `window.PET`: look, head,
mouth, earTop). Test for free with `--replay`. Never use `--host git` for real
customers (public repo).

## Owner's Mac setup quirks (already solved)
- `~/.npm` had root-owned files → fixed with `sudo chown -R $(id -u):$(id -g) ~/.npm`.
- Newer npm skips dependency install scripts and Electron's downloader is silent
  on Node 26 → `scripts/install-electron.js` (postinstall) falls back to
  downloading the official Electron zip and unpacking with `ditto`.

## Ideas not done yet
More tricks (stretch, roll over, head tilt), sound.
The `stand` clip is him standing on his hind legs (the model's reading of "stand up").

## Desktop Sidekicks: how an order flows (all live)
1. **Site** (`site/`, Cloudflare Pages project `desktopsidekicks`, root `site`, builds on every push to
   main; desktopsidekicks.com). Create-your-pet form → `functions/api/order.js` saves photos to the
   private R2 bucket `desktopsidekicks-orders` and opens Stripe Checkout ($20) → Stripe webhook
   (`functions/api/stripe-webhook.js`) marks it paid, writes `queue/paid/<id>`, emails a confirmation
   (Postmark, from hello@desktopsidekicks.com). Stripe is still in TEST mode (sandbox key).
2. **Worker** (`petgen/worker.py`, DigitalOcean droplet `sidekicks-worker` 64.225.116.98, systemd
   `sidekicks-worker`, settings `/etc/sidekicks.env`, setup `petgen/deploy/setup.sh`, pulls main on
   restart) makes the pet, uploads `pet.zip` + report, gives it a pet code (`codes/<CODE>`), emails
   the owner an "Approve and send" link. Test-mode orders only if `ALLOW_TEST_ORDERS=1`.
3. **Approve** (`/api/admin/approve?id&t`) → customer gets the "is ready" email with the code.
4. **App** (`app/`, Electron, "Desktop Sidekicks"): adds the pet by code / `desktopsidekicks://add/<CODE>`.
   Owner builds the signed DMG on their Mac and uploads it to R2 as `Desktop-Sidekicks.dmg`
   (served at /download). See app/README.md.
Keys live in: Cloudflare Pages secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, POSTMARK_TOKEN),
the droplet's /etc/sidekicks.env, and this cloud environment's network secrets. Never in git or chat.
- Pet sizing: sit = 60% of the canvas height unless the lying pose would be wider than
  `LIE_MAX_W` (74%) of the frame; then the whole pet is smaller (long pets like Chewie).
  Clip QA rejects clips where the pet touches the frame edge in >2% of frames.
- Green-floor shadows key as dark teal "mats": `soften_shadow()` in petgen/media.py turns them
  into a soft neutral shadow (lower 40% of the pet only).
- Tail: the order form asks (yes / stub / none); `plan.TAILS` adds a note to every prompt.
  Re-make a pet: `sudo sidekicks-requeue <order id> tail=none` (generation cache is keyed by
  prompt + input-file content, so changed settings really regenerate).
- Head tracking (all pets): Seedance holds the pose it STARTS from but drifts back to a level head
  later in a clip and doesn't honour `last_image` for subtle head pitch (verified on Chewie: asked
  to end head-down, it ended level). So each tilted row (up/hu/hd/down) = four clips that start on
  tilted poses and turn outward (0->2, 2->0, 2->4, 4->2, centre pose `gaze_2_<row>`), and
  `pick_row_from_starts` takes each column from the first half of the clip starting nearest it. Tilted gaze images get a vision check
  (`look_check`, gemini-3-flash-preview via GPTProto, <1c) and are remade if they don't tilt;
  `check_look_heights` flags rows whose centre frame clearly faces the wrong way.
- No zoom: clip QA rejects clips where the pet grows mid-clip beyond `plan.MAX_ZOOM` (1.08-1.15x for
  seated tricks, 1.35x otherwise; Chewie's first puppy clip zoomed 1.66x) and, for tricks that keep
  the pet's shape, a slow push-in beyond `plan.MAX_GROWTH` (start->max; Chewie's yawn grew 1.18x).
- Sleep pose = last frame of fall_asleep (derived, like lie), so sleeping continues exactly where
  falling asleep ended (the SLEEP_EDIT image is only the clip's target). Resting poses whose paws
  run off the bottom of the frame are rejected.
- Sex: the order form asks male / female (Chewie is a girl; the models gave her male anatomy).
  `plan.SEX_NOTE` adds a note to every prompt for female pets; `anatomy_problems` (vision check on the
  sit/lie images and 3 frames of every trick) rejects a tail on tail-less pets and male anatomy on
  female pets. Re-make: `sidekicks-requeue <id> sex=female`. Prompts alone don't stop the video model
  adding male anatomy mid-clip in seated tricks, so for female pets `media.patch_groin` copies the clean
  belly area of the sit still into frames of `plan.SEATED_TRICKS` (eat, bark, puppy, wag) whose lower
  body lines up with it (IoU >= 0.85; the patch follows small shifts only on a near-exact fit), before the
  anatomy check. Free; no retries needed. The same patch runs on every head-tracking sweep frame of female pets (Tess, Nov 19: male parts in some head-turn frames). `patch_from` follows the body smoothly: 1 px offsets,
  smoothed over time, faded in/out (it used to snap in 4 px steps and pop on/off: a 'jiggle' on puppy eyes / sleep). Lying / sleeping: `female_rest_fix` makes a clean image edit of
  each derived resting pose (`plan.FEMALE_EDIT`, ~$0.08), `media.edit_mask` takes the small changed
  area, and `patch_from` puts it into the stills and the frames of `plan.REST_CLIPS` that match the pose.
  Standing / moving frames can't be patched (key-frame edits tried: too much motion), so female pets get
  belly-hiding versions: `plan.FEMALE_ACTIONS` (stand = play bow, poop = front-facing squat, wag = seated,
  get_up = rises toward the camera). Side views show male anatomy; front-facing views hide it.
- Clip QA rejects paws running off the bottom of the frame (>5% of frames; wake_up 30%, `plan.MAX_BOTTOM`).
- Image requests retry on 429 / timeouts (GPTProto rate-limits under load).
- sleep_loop is NOT decoded with the low crop (its ends-only correction left it hovering 40 px).
- `stand` = standing up on the hind legs (begging), like Chunky's; on all fours looked like sitting.
  Female pets do a play bow instead.
- Lying / sleeping / getting-up / waking clips are decoded with a crop shifted to the very bottom of the
  video (`decode_keyed(low=True)`): the normal crop cut off paws stretched toward the camera.
- Site: `site/legal.html` (Terms, Refund Policy, Privacy Policy), linked from a small footer on the
  desktop ("Contact: hello@desktopsidekicks.com · Privacy Policy & Terms") and under checkout.
- Retry cost: videos get 2 tries (`PETGEN_VIDEO_RETRIES`=1), images 3; a clip failing only the
  female-anatomy check gets one extra try with positive wording (`SEX_NOTE_STRONG`, attempt >= 3).
  Spending cap per pet run `PETGEN_BUDGET` (default $10, est.; the owner's 'Needs a look' threshold): over it, no more retries; best try kept
  and the pet goes to the owner as Needs a look. Price stays $20 for launch.
- Lying check: lower than 0.88x the sitting height (front-on sphinx) or wider than tall (side-on).
- Female pets: Stand, Poop, Lie down and Get up are made with **Seedance 2.5** (`plan.HQ_CLIPS_FEMALE`, GPTProto
  `dreamina-seedance-2-5-260628`, est. $0.20/s vs 2.0 Mini $0.08/s): tested on Chewie standing on her hind
  legs, it drew female anatomy correctly where 2.0 Mini always drew male parts (Kling 3.0 was worse; Veo 3.1
  isn't enabled on the account). So girls get the real hind-legs Stand again (the play bow / "Bow" label is gone).
  Seedance 2.5 output has a yellow-green cast: `media.match_tint` balances its colour to the sit still, right after
  decoding (before a lie / sleep pose is derived from the clip, so the derived poses aren't green either). The
  belly shadow (`media.shade_belly`, `plan.SHADE_TRICKS`) is now off: 2.5 doesn't need it and it read as a dark blob. GPTProto video downloads also come from
  oss-us.gptproto.com (allowed on the "test" environment).
- Lying / sleeping are a 3/4 view like Chunky's (lie_down prompt), not side-on.
- Owner QA email has a "Try it" link: `/api/admin/preview/<id>/<token>/index.html` (petgen/preview.html, uploaded by the
  worker to `orders/<id>/preview/`): works like the Mac app (Menu pill, right-click menu, sizes, feed, drag).
- Owner orders page `/admin/orders` (`site/functions/admin/orders.js`, `?format=csv`, `?month=YYYY-MM`, `?all=1`):
  paid / Stripe fee / AI cost / profit per order with totals. Protected by Cloudflare Access on /admin/*; the function
  also verifies the Access JWT (`site/lib/access.js`, Pages vars ACCESS_TEAM_DOMAIN + ACCESS_AUD) and refuses
  everyone until they're set. The webhook saves Stripe's exact fee (`stripe_fee_cents`, needs PaymentIntents +
  Charges read on the key; otherwise the page estimates 2.9% + 30c). The worker keeps `ai_cost_total_usd`
  (all runs of a pet). The QA report and Try-it page also show the customer's uploaded photos (`photos/<view>`).
- Worker emails the owner "New order: <pet>" when a paid order is picked up (`notify_new_order`, once per order,
  `owner_notified_at`). GPTProto outages (out of credit, key cap, model overloaded: `providers.ProviderUnavailable`)
  don't fail the pet: the order goes back to queue/paid with status `waiting`, the worker retries every
  `PROVIDER_WAIT_SECONDS` (900) and emails the owner once per outage; after `PROVIDER_MAX_WAITS` (48, ~12 h) it fails.
- Cats (species 'cat'): `plan.CAT_ACTIONS` replace the dog-only tricks (bark -> meow, wag -> happy purr with slow blinks
  and kneading, puppy -> big pleading eyes), menu names from `plan.CAT_LABELS` (Meow / Happy purr / Kitten eyes) via
  manifest `labels`, and the engine's bark bubble says Meow!/Mrrp!/Mew! when `PET.species === 'cat'`.
- First live order (Chewie, new photos, sitting at an angle) cost $17.85: seated tricks failed for tiny push-ins
  (1.09x vs 1.08) and every retry costs ~$0.40, so `MAX_GROWTH` for puppy/bark/eat is 1.12 and wag 1.2. `stand` is
  decoded from the whole video (`decode_keyed(wide=True)`): a dog on its hind legs is taller than the usual crop
  (paws at the bottom in 47% of frames -> 0%). Wide clips keep their start->end framing correction for the whole clip (`correct_clip(hold=True)`):
  easing it off after 1 s made the pet shrink and float up while standing (Tess, Nov 20: feet rose 56 px). Customers are NOT asked for new photos; flagged pets go to the owner.
- Keying (product only, `petgen/media.py`): own `alpha_and_despill` keys by how strongly green a pixel is relative to
  its brightness (the shared absolute threshold cut out pale chests/bellies lit by green bounce light), then
  `fill_translucent` makes see-through patches inside the body solid and `fix_spill` gives grey despilled underside
  streaks the surrounding fur colour. `plan.GREEN_SIT` always turns the pet to sit front-on (an angled customer sit
  photo made the first live order drift into side views); customers still send any photos. The sitting image gets a vision check (`plan.SIT_CHECK`: front_on + artifacts,
  e.g. a dark block the image model painted on the chest) and is remade (~$0.08/try, with retry hints) if it isn't
  straight-on like Chunky or has a glitch; all dogs should sit straight so the head can turn without bending.
- Backup image model: `GPTProtoProvider.image` tries gemini-3-pro-image-preview twice, and if it's overloaded / down
  (`ProviderUnavailable`) switches to `image_fallbacks` (gemini-3.1-flash-image, tested on a sleeping-pose edit: same
  dog/spot/size, clean green) before the order goes to `waiting`. Nov 18 the main model was overloaded 8+ hours.
  `media.fill_holes` fills small holes enclosed in the UPPER body only (chest / chin), never the real background
  between the legs. The keyer unmixes semi-transparent edge pixels from the screen colour (no teal fringe on fluffy
  fur). Image prompts use `plan.SEX_NOTE_IMAGE` (plain "smooth fur" wording): "genitals / penis / sheath" made the
  image model paint a pixelated mosaic between the legs / on the chest (Tess, Chewie, Nov 19).
- Retries learn: a failed try's problems add fixes to the next try's prompt (`plan.RETRY_HINTS` / `retry_hint`: camera
  further back, locked-off camera, exact end pose, female anatomy). The worker saves every try's QA to
  `orders/<id>/qa.json`; `/admin/orders?view=qa` shows failure rates and top problems per clip across all pets (tune there).
- No web-console runs needed: the worker checks GitHub main every 5 min (`code_update_waiting`) and, between orders,
  exits so systemd restarts it with a fresh `git pull` (Restart=always + ExecStartPre). Claude can re-queue an order
  itself through the Cloudflare R2 API (move `queue/<review|delivered|failed|test>/<id>` to `queue/paid/<id>`; edit
  order.json for tail/sex), which is what `sidekicks-requeue` does.
- Player (petgen/engine/app.js): with the pointer on the pet (`S.overDog`) she looks at you instead of aiming at
  her own body (that swung the target across her and flipped between look frames at row/column seams, e.g. the
  partner's Chewie, Nov 20); look-frame hysteresis 0.85 col / 0.75 row. Lying down: while the mouse is in use she
  gets up (own lie 5-10 s, menu "Lie down" 20 s); a missing timer is always started, so she never stays down
  for good. Changes to the player reach the Mac app only with a new DMG (app/scripts/sync-engine.js copies it).
- Playful Mode (Do Random Tricks) (menu On / Off, on by default, saved in the app's settings.json as `playful`): a random trick about every
  2 min (`TRICK_EVERY` 105-135 s) while the mouse is in use; off = no tricks on her own (naps still happen). Sent to the
  player as action `playful:on|off`. Menu item "Sleep (Pause)" = chosen sleep, stays asleep until another action.
- App: several pets at once. Each shown pet has its own window (`wins` map in app/main.js; IPC is routed by sender).
  settings.json: `shown` (codes on the desktop, first in the corner, the next to its left; old `pet` setting migrates)
  and `petPrefs[code]` (scale, playful). A newly added code joins the pets already out. Right-click menu = that pet's
  items + "Pets on desktop" checkboxes (2+ pets) / Add a pet / login / Quit; the menu-bar icon has a submenu per pet.
- App: hovering the pet shows a "Menu" pill centred on its body (engine option `dogApi.menuButton`); the menu starts with "✕ Close menu".
