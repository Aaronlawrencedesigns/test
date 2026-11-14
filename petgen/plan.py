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

GREEN_SLEEP = ("Same {species} as in the first image, photorealistic, same camera position, same distance and framing, "
               "same lighting. It is lying down on its belly, fast asleep: chin resting on its front paws, eyes fully "
               "closed, ears relaxed, peaceful, whole body inside the frame, centred. " + GREEN_BG)

H_DIR = {0: "far toward the LEFT side of the image (head turned about 40 degrees to the image's left)",
         2: "straight ahead at the camera",
         4: "far toward the RIGHT side of the image (head turned about 40 degrees to the image's right)"}
V_DIR = {'up': "and upward (chin raised about 20 degrees, eyes looking up)",
         'hu': "and slightly upward (chin raised about 10 degrees, eyes looking a little up)",
         'level': "at eye level",
         'hd': "and slightly downward (head lowered about 10 degrees, eyes looking a little down)",
         'down': "and downward (head lowered about 20 degrees, eyes looking down)"}
GAZE = ("Edit this photo. Keep EVERYTHING identical: the same {species} with the same markings, the same body position, "
        "paws, framing, scale, lighting and the flat chroma-key green background. Do not move or change the body at all. "
        "Only change where it is looking: turn its head and eyes so it looks {h} {v}. Its eyes and nose point in that "
        "direction, like a pet following something with its gaze. Mouth closed. Photorealistic. Square image, same size.")

ROWS = ['up', 'hu', 'level', 'hd', 'down']   # head heights for head tracking, top to bottom
ROWS_LITE = ['up', 'level', 'down']


def image_items():
    items = [
        ('master', ['photos'], MASTER),
        ('green_sit', ['master', 'photos'], GREEN_SIT),
        ('green_lie', ['master', 'photos'], GREEN_LIE),
        ('green_sleep', ['master', 'photos'], GREEN_SLEEP),
    ]
    return items


def gaze_item(col, row):
    """Head-direction edit of the normalised sitting keyframe (sweep end points / centres)."""
    return (f'gaze_{col}_{row}', ['kf_sit'], GAZE.replace('{h}', H_DIR[col]).replace('{v}', V_DIR[row]))


# ---------------------------------------------------------------- clips
SWEEP = ("The {species} stays seated with its body, chest, legs and ear position completely still. It slowly and "
         "smoothly turns only its head {path}, at a perfectly steady, even speed across the whole clip, its eyes "
         "following the same direction, mouth closed, no blinking, no other movement. Throughout, its head stays {tilt}.")
TILT = {'up': "tilted upward, looking up", 'hu': "tilted slightly upward, looking a little above eye level",
        'level': "level, looking at eye level", 'hd': "very slightly lowered, looking a little below eye level",
        'down': "lowered, looking downward"}
PATH = {(0, 4): "from looking far toward the left side of the image to looking far toward the right side of the image",
        (0, 2): "from looking far toward the left side of the image to looking straight at the camera",
        (2, 4): "from looking straight at the camera to looking far toward the right side of the image"}


def sweep_item(row, c0=0, c1=4):
    first = 'kf_sit' if (c0 == 2 and row == 'level') else f'kf_gaze_{c0}_{row}'
    last = 'kf_sit' if (c1 == 2 and row == 'level') else f'kf_gaze_{c1}_{row}'
    return {'key': f'sweep_{row}_{c0}{c1}', 'first': first, 'last': last, 'seconds': 5,
            'prompt': SWEEP.replace('{path}', PATH[(c0, c1)]).replace('{tilt}', TILT[row])}


# Actions: key -> (first keyframe, last keyframe, seconds, prompt, convert options)
ACTIONS = {
    'wag': ('kf_sit', 'kf_sit', 5, "The {species} gets excited and happy: it wiggles its whole rear end and tail side to side while staying seated, opens its mouth into a happy pant with its tongue out, ears perk, then closes its mouth and settles back into exactly the same calm sitting pose as the start, looking at the camera.", {}),
    'puppy': ('kf_sit', 'kf_sit', 5, "The {species} gives sweet puppy-dog eyes: it slowly lowers and tilts its head to one side, looks up at the camera with big soulful pleading eyes, ears slightly back, then slowly straightens its head and returns to exactly the same sitting pose as the start.", {}),
    'stand': ('kf_sit', 'kf_sit', 7, "The {species} stands up from sitting onto all four legs facing the camera, stands for a moment looking around curiously, shifts its weight and gives a small wiggle of its rear end, then sits back down in exactly the same calm sitting pose as the start, looking at the camera.", {}),
    'eat': ('kf_sit', 'kf_sit', 4, "The {species} has just been given a treat: it happily chews with its mouth, jaw moving up and down, swallows, then licks its lips and nose with its tongue a couple of times, looking pleased, then closes its mouth and returns to exactly the same calm sitting pose as the start, looking at the camera.", {}),
    'bark': ('kf_sit', 'kf_sit', 4, "The {species} barks loudly at the camera two times: each bark it opens its mouth wide showing teeth and tongue, its head jerks slightly forward, cheeks puff, then it closes its mouth and returns to exactly the same calm sitting pose as the start.", {}),
    'poop': ('kf_sit', 'kf_sit', 8, "The {species} stands up, turns its body sideways, hunches its back into a squat with its tail raised as if pooping, holds briefly, then stands, turns back toward the camera and sits down again in exactly the same pose as the start.", {}),
    'lie_down': ('kf_sit', 'kf_lie', 5, "The {species} lies down: from sitting it walks its front paws forward and lowers itself onto its belly, ending lying in a relaxed sphinx pose, front legs stretched forward, head up looking at the camera, exactly matching the final frame.", {'spread': True}),
    'get_up': ('kf_lie', 'kf_sit', 4, "The {species} gets up from lying down and sits upright, ending sitting and looking straight at the camera.", {'spread': True}),
    'fall_asleep': ('kf_lie', 'kf_sleep', 6, "The {species} gets sleepy: it yawns, its eyelids get heavy, it lowers its head and rests its chin on its front paws, and closes its eyes, falling asleep.", {}),
    # sleep_loop / wake_up start from the LAST FRAME of fall_asleep ('kf_sleep_side'), so they connect exactly
    'sleep_loop': ('kf_sleep_side', 'kf_sleep_side', 6, "The {species} is fast asleep lying down with its head resting on its paws and eyes closed: its body rises and falls slowly as it breathes deeply, one ear twitches gently once, otherwise completely still.", {'ramp': 0.5}),
    'wake_up': ('kf_sleep_side', 'kf_sit', 5, "The sleeping {species} wakes up: it opens its eyes, lifts its head, stretches its front legs, then gets up and sits upright, turning to face the camera, ending sitting and looking straight at the camera.", {'spread': True}),
}
# still each clip should end on (for the end-pose quality check)
ACTION_END_STILL = {'lie_down': 'lie', 'get_up': 'sit', 'fall_asleep': None, 'sleep_loop': 'sleep',
                    'wake_up': 'sit'}
DEFAULT_ACTIONS = ['wag', 'puppy', 'stand', 'eat', 'bark', 'poop', 'lie_down', 'get_up', 'fall_asleep', 'sleep_loop', 'wake_up']

# rough GPTProto prices (USD) for the cost estimate in the report
PRICE_IMAGE = 0.0804
PRICE_VIDEO_PER_SECOND = 0.08
