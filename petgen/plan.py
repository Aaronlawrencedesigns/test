"""What petgen generates for one pet: images, head-sweep clips and action clips.

Prompts are the ones tuned on Chunky, generalised with {pet} / {species}.
Every item has a stable key; results are cached under work/ by that key, so a
re-run never pays for something it already has.
"""

# ---------------------------------------------------------------- images
# (key, refs, prompt). refs name earlier results ('photos' = customer photos).
GREEN_BG = ("Background: perfectly flat, uniform chroma-key green screen (pure green #00B140), evenly lit, "
            "no gradient, no floor line, no shadow. No green tint on the {species}. Use the other reference photos "
            "to keep the markings accurate. No text, no props, no collar. Square image.")

MASTER = ("Photorealistic photo of this exact {species} (use all reference photos: same coat colours and markings, "
          "same eye colour, same ear shape, same body shape and size). Sitting upright on the floor, full body "
          "visible, facing the camera, head straight, looking directly into the lens, mouth closed, calm. Plain "
          "seamless light-grey studio background, soft even studio lighting, sharp focus, the whole {species} in "
          "frame with generous space around it, no collar, no props, no text. Square image.")

GREEN_SIT = ("Recreate the first image exactly: the same {species}, identical pose, identical framing, size and "
             "position in the frame, same lighting, facing the camera and looking straight into the lens. Only change "
             "the background: replace the entire background and floor with a perfectly flat, uniform chroma-key green "
             "screen (pure green #00B140), evenly lit, with no gradient, no texture, no floor line and no shadow. Keep "
             "the {species} photorealistic with natural colours (no green tint). Use the other reference photos only to "
             "keep the markings accurate. No text, no props. Square image.")

GREEN_LIE = ("Same {species} as in the first image, photorealistic, same camera position, same distance and framing, "
             "same lighting. It is now lying down on its belly in a relaxed sphinx pose, front legs stretched forward, "
             "head up, awake, looking straight into the camera, mouth closed, whole body inside the frame, centred. " + GREEN_BG)

# The sleeping pose is an EDIT of the pet's actual lying frame (end of lie_down), so it
# keeps the same scale and spot (measuring head size across poses is unreliable: ears fold).
SLEEP_EDIT = ("Edit this photo. Keep the same {species} with the same markings, in exactly the same spot, at exactly "
              "the same size and scale, same camera position and framing, same lighting and the same flat chroma-key "
              "green background. Only change its pose: it is now fast asleep, still lying on its belly in the same "
              "place, chin resting on its front paws, eyes fully closed, ears relaxed, peaceful. Photorealistic. "
              "Square image, same size.")

H_DIR = {0: "far toward the LEFT side of the image (head turned about 40 degrees to the image's left)",
         2: "straight ahead at the camera",
         4: "far toward the RIGHT side of the image (head turned about 40 degrees to the image's right)"}
V_DIR = {'up': "and clearly upward (chin raised about 30 degrees, nose pointing up, eyes looking up toward the top of the image)",
         'hu': "and upward (chin raised about 15 degrees, eyes looking up)",
         'level': "at eye level",
         'hd': "and slightly downward (head lowered about 12 degrees, eyes looking a little down)",
         'down': "and downward (head lowered about 25 degrees, eyes looking down at the floor in front of it)"}
# what a vision check must see in each head height (centre pose); used to retry weak poses
V_OK = {'up': {'up'}, 'hu': {'up', 'slightly up'}, 'hd': {'slightly down', 'down'}, 'down': {'down', 'slightly down'}}
GAZE = ("Edit this photo. Keep EVERYTHING identical: the same {species} with the same markings, the same body position, "
        "paws, framing, scale, lighting and the flat chroma-key green background. Do not move or change the body at all. "
        "Only change where it is looking: turn its head and eyes so it looks {h} {v}. Its eyes clearly look that way "
        "too (pupils turned in that direction, not back at the camera), and its nose points there, like a pet following "
        "something with its gaze. Mouth closed. Photorealistic. Square image, same size.")

# Tail: customers say whether their pet has one (many French Bulldogs, Corgis, Aussies... don't).
# Every prompt gets the matching note so the models never invent a tail.
TAILS = {
    'yes': {'note': '', 'and': ' and tail', 'raised': ' with its tail raised'},
    'stub': {'note': ' This {species} has only a very short stubby tail: never show a long tail.', 'and': '', 'raised': ''},
    'none': {'note': ' This {species} has no tail at all (bobtail / docked): never draw or show a tail.', 'and': '', 'raised': ''},
}
# Sex: customers say male / female. Unprompted, the models give every pet male anatomy, so female
# pets get a note in every prompt (and a vision check on images and clips).
SEX_NOTE = {'female': ' This {species} is female: anatomically a female, with no male genitals (no penis or sheath on the belly).',
            'male': ''}
# Video models follow positive descriptions better than "no X": used for a female pet's later tries
# of a clip whose earlier tries still showed male anatomy (Chewie's eat / bark, 3 tries each).
SEX_NOTE_STRONG = {'female': ' She is a female {species}: between her hind legs her belly is smooth, plain and soft, '
                             'exactly like in the first frame, all the way through the clip.', 'male': ''}
SEX_EXTRA_TRIES = 1
# tricks where the pet stays seated: female pets get the clean belly of the sitting pose patched in
# (media.patch_groin); the video model adds male anatomy mid-clip whatever the prompt says
SEATED_TRICKS = {'eat', 'bark', 'puppy', 'wag'}
# female pets: front-on standing / squatting tricks get a dark shadow between the legs (media.shade_belly)
SHADE_TRICKS = set()   # (was {'poop'}: Seedance 2.5 draws girls correctly, and the shadow read as a dark blob)
# of those, the vision check's 'male anatomy' is ignored only where it misreads the front-on shadow (play bow);
# poop keeps the check: if it still shows, it's retried once and then flagged so the owner can drop it
SHADE_NO_SEX_CHECK = set()
# lying / sleeping: female pets get a clean edit of each resting pose (FEMALE_EDIT), patched into the
# frames of these clips wherever the pet is in that pose
# tricks where the pet stands / moves: female pets get KEYFRAME_EDITS frames image-edited to a clean
# female belly, and every frame is patched from the nearest edited frame (media.patch_from)
MOVING_TRICKS = {}   # tried {'stand': 5, 'poop': 6, 'wag': 4}: too much motion to match frames; poses changed instead
# Female pets: versions of tricks that keep the belly out of view (the video model adds male anatomy
# whenever it's visible, i.e. in side views; front-facing views hide it). Same clip names.
# menu names that differ from the default for female pets (the app and preview read manifest['labels'])
FEMALE_LABELS = {}   # (was {'stand': 'Bow'} while girls did a play bow; Seedance 2.5 stands them up properly)

FEMALE_ACTIONS = {
    # like Chunky's poop, but at a three-quarter angle (side-on showed male anatomy) and low to the floor
    'poop': "The {species} gets up from sitting onto all four paws (it never rises onto its hind legs), standing facing the camera with its body turned only slightly, chest and face toward the camera and its rear behind it, like a happy dog standing in front of the camera. Then it bends its back legs and lowers its rear toward the floor into a squat as if pooping, still facing the camera so its chest and front legs hide its belly, the way a female {species} squats, and holds the squat for about two seconds in the middle of the clip, then rises back onto all four paws and stands for a moment, then sits down again in exactly the same pose as the start, looking at the camera.",
    'get_up': "The {species} gets up from lying down by turning toward the camera as it rises, ending sitting upright and facing the camera, looking straight at the camera.",
    'wag': "The {species} gets excited and happy while staying firmly seated on its bottom the whole time (it never stands up): it wiggles its shoulders and whole body side to side, opens its mouth into a happy pant with its tongue out, ears perk, then closes its mouth and settles back into exactly the same calm sitting pose as the start, looking at the camera.",
}
REST_CLIPS = {'lie_down', 'get_up', 'fall_asleep', 'sleep_loop', 'wake_up'}
FEMALE_EDIT = ("Edit this photo. Keep EVERYTHING identical: the same {species}, same pose, same position, same size "
               "and scale, same lighting, same flat chroma-key green background. Change only one small detail: "
               "this {species} is female, so the belly between its hind legs is smooth and plain, like a female's. "
               "Photorealistic. Square image, same size.")   # one more try for clips that fail only the female-anatomy check
# Video model: keep the whole pet in shot (a cut-off pet can't be fixed afterwards)
IN_FRAME = ' The whole {species} stays fully inside the frame at all times, with space around it; the camera does not zoom or move.'

ROWS = ['up', 'hu', 'level', 'hd', 'down']   # head heights for head tracking, top to bottom
ROWS_LITE = ['up', 'level', 'down']


def image_items():
    items = [
        ('master', ['photos'], MASTER),
        ('green_sit', ['master', 'photos'], GREEN_SIT),
        ('green_lie', ['master', 'photos'], GREEN_LIE),
    ]
    return items


def gaze_item(col, row):
    """Head-direction edit of the normalised sitting keyframe (sweep end points / centres)."""
    return (f'gaze_{col}_{row}', ['kf_sit'], GAZE.replace('{h}', H_DIR[col]).replace('{v}', V_DIR[row]))


# ---------------------------------------------------------------- clips
SWEEP = ("The {species} stays seated with its body, chest, legs and ear position completely still. It slowly and "
         "smoothly turns only its head {path}, at a perfectly steady, even speed across the whole clip, its eyes "
         "leading the turn in the same direction, mouth closed, no blinking, no other movement. Throughout, including "
         "as it passes the middle, its head stays {tilt}; it never returns to a level head.")
TILT = {'up': "clearly tilted upward, chin raised, eyes looking up", 'hu': "tilted upward, eyes looking above eye level",
        'level': "level, looking at eye level", 'hd': "slightly lowered, eyes looking a little below eye level",
        'down': "clearly lowered, eyes looking down at the floor"}
PATH = {(0, 4): "from looking far toward the left side of the image to looking far toward the right side of the image",
        (0, 2): "from looking far toward the left side of the image to looking straight at the camera",
        (2, 4): "from looking straight at the camera to looking far toward the right side of the image",
        (2, 0): "from looking straight at the camera to looking far toward the left side of the image",
        (4, 2): "from looking far toward the right side of the image to looking straight at the camera"}


def sweep_item(row, c0=0, c1=4):
    first = 'kf_sit' if (c0 == 2 and row == 'level') else f'kf_gaze_{c0}_{row}'
    last = 'kf_sit' if (c1 == 2 and row == 'level') else f'kf_gaze_{c1}_{row}'
    return {'key': f'sweep_{row}_{c0}{c1}', 'first': first, 'last': last, 'seconds': 5,
            'prompt': SWEEP.replace('{path}', PATH[(c0, c1)]).replace('{tilt}', TILT[row])}


# Actions: key -> (first keyframe, last keyframe, seconds, prompt, convert options)
ACTIONS = {
    'wag': ('kf_sit', 'kf_sit', 5, "The {species} gets excited and happy: it wiggles its whole rear end{tail_and} side to side while staying seated, opens its mouth into a happy pant with its tongue out, ears perk, then closes its mouth and settles back into exactly the same calm sitting pose as the start, looking at the camera.", {}),
    'puppy': ('kf_sit', 'kf_sit', 5, "The {species} gives sweet puppy-dog eyes: it slowly lowers and tilts its head to one side, looks up at the camera with big soulful pleading eyes, ears slightly back, then slowly straightens its head and returns to exactly the same sitting pose as the start.", {}),
    'stand': ('kf_sit', 'kf_sit', 7, "The {species} stands up on its hind legs, like it is begging: it rises from sitting onto its back legs with its front paws raised in front of its chest, balancing upright for a moment while looking at the camera, then lowers itself and sits back down in exactly the same calm sitting pose as the start, looking at the camera.", {}),
    'eat': ('kf_sit', 'kf_sit', 4, "The {species} has just been given a treat: it happily chews with its mouth, jaw moving up and down, swallows, then licks its lips and nose with its tongue a couple of times, looking pleased, then closes its mouth and returns to exactly the same calm sitting pose as the start, looking at the camera.", {}),
    'bark': ('kf_sit', 'kf_sit', 4, "The {species} barks loudly at the camera two times: each bark it opens its mouth wide showing teeth and tongue, its head jerks slightly forward, cheeks puff, then it closes its mouth and returns to exactly the same calm sitting pose as the start.", {}),
    'poop': ('kf_sit', 'kf_sit', 8, "The {species} stands up, turns its body sideways, hunches its back into a squat{tail_raised} as if pooping, holds briefly, then stands, turns back toward the camera and sits down again in exactly the same pose as the start.", {}),
    'lie_down': ('kf_sit', 'kf_lie', 5, "The {species} lies down: from sitting it lowers itself onto its belly, turning its body only partly as it goes down, ending lying at a three-quarter angle to the camera (body angled about 45 degrees, chest and face toward the camera, rear further back) with its back legs tucked to one side, front legs resting on the floor in front of its chest, head up looking at the camera, exactly matching the final frame. Its paws never reach toward the camera; all four paws stay fully inside the frame.", {'spread': True, 'derive': 'lie', 'low': True}),
    # 'lie' / 'sleep' are taken from the LAST FRAME of lie_down / fall_asleep ('derive'), so clips connect exactly
    # (an image-generated pose never quite matches where a video ends). 'sleep' is an
    # image edit of that lying frame (SLEEP_EDIT), made before fall_asleep runs.
    'get_up': ('kf_lie_end', 'kf_sit', 4, "The {species} gets up from lying down and sits upright, ending sitting and looking straight at the camera.", {'spread': True, 'low': True}),
    'fall_asleep': ('kf_lie_end', 'kf_sleep_end', 6, "The {species} gets sleepy: it yawns, its eyelids get heavy, it lowers its head and rests its chin on its front paws, and closes its eyes, falling asleep in the same spot and at the same angle to the camera, ending exactly like the final frame. Its paws stay fully inside the frame.", {'spread': True, 'sleep_edit': True, 'derive': 'sleep', 'low': True}),
    # starts and ends on the (resized) sleeping pose so it loops seamlessly
    'sleep_loop': ('kf_sleep_end', 'kf_sleep_end', 6, "The {species} is fast asleep lying down with its head resting on its paws and eyes closed: its body rises and falls slowly as it breathes deeply, one ear twitches gently once, otherwise completely still. Static camera.", {'ramp': 0.6}),
    'wake_up': ('kf_sleep_end', 'kf_sit', 5, "The sleeping {species} wakes up: it opens its eyes, lifts its head, stretches its front legs, then gets up and sits upright, turning to face the camera, ending sitting and looking straight at the camera.", {'spread': True, 'low': True}),
}
# still each clip should end on (for the end-pose check); derived clips define their own
ACTION_END_STILL = {'lie_down': None, 'get_up': 'sit', 'fall_asleep': 'sleep', 'sleep_loop': 'sleep', 'wake_up': 'sit'}
# clips that need another clip to finish first (they start from its last frame)
DEPENDS = {'get_up': 'lie_down', 'fall_asleep': 'lie_down', 'sleep_loop': 'fall_asleep', 'wake_up': 'fall_asleep'}
# No camera zoom: the pet keeps its size. Tricks where it stays seated may barely change size;
# standing up / lying down / getting up legitimately change it a little (Chunky's poop: 1.26x).
MAX_ZOOM = {'puppy': 1.12, 'bark': 1.12, 'eat': 1.12, 'wag': 1.15, 'sleep_loop': 1.08, 'fall_asleep': 1.15}
MAX_ZOOM_DEFAULT = 1.35
# share of frames the pet may touch a side/top edge (a big wake-up stretch brushes it for a moment)
MAX_EDGE = {'wake_up': 0.06}
# share of frames the paws may run off the bottom (the wake-up stretch reaches toward the camera; Chunky's: 26%)
MAX_BOTTOM = {'wake_up': 0.3}
# ...and for tricks where the pet keeps its shape, how much bigger than at the start it may get
# (catches a slow push-in, e.g. Chewie's yawn-to-sleep grew 1.18x; Chunky's: 1.01x)
MAX_GROWTH = {'fall_asleep': 1.08, 'sleep_loop': 1.05, 'puppy': 1.08, 'bark': 1.08, 'eat': 1.08, 'wag': 1.12}
DEFAULT_ACTIONS = ['wag', 'puppy', 'stand', 'eat', 'bark', 'poop', 'lie_down', 'get_up', 'fall_asleep', 'sleep_loop', 'wake_up']
# Every pet must ship with everything Chunky has (checked at packaging; missing = Needs review)
REQUIRED_CLIPS = list(DEFAULT_ACTIONS)            # 11 animations (eat powers Feed mode)
REQUIRED_STILLS = ['sit', 'lie', 'sleep']
REQUIRED_ROWS = 5                                  # head-tracking heights
FEATURES = ['head tracking (5 heights x 33 positions)', 'feed mode (treat tray, drag to feed, eat + wiggle)',
            'naps when the mouse is still', 'gets up after lying down', 'bark only on request']

# rough GPTProto prices (USD) for the cost estimate in the report
PRICE_IMAGE = 0.0804
PRICE_VIDEO_PER_SECOND = 0.08
# Female pets: clips that show the belly are made with Seedance 2.5 (GPTProto dreamina-seedance-2-5), which
# draws female anatomy correctly even standing on the hind legs (tested on Chewie, Nov 2026); 2.0 Mini
# draws male parts whatever the prompt says. About 3-5x the price, so only these clips use it.
HQ_CLIPS_FEMALE = {'stand', 'poop'}   # (lying / sleeping clips are fixed with image edits + patches, cheaper)
PRICE_HQ_VIDEO_PER_SECOND = 0.2    # estimate (720p 1:1; GPTProto lists 480p at ~$0.10/s)


def est_cost(cost):
    return (cost['images'] * PRICE_IMAGE + cost['video_seconds'] * PRICE_VIDEO_PER_SECOND
            + cost.get('video_seconds_hq', 0) * PRICE_HQ_VIDEO_PER_SECOND)
