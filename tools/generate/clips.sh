#!/bin/bash
# The clip requests used for Chunky: name, first keyframe, last keyframe, seconds, prompt.
# Keyframes are fetched from this repo on GitHub (assets/keyframes/*.png), so push new ones first.
# Usage (from tools/generate/):  GPTPROTO_API_KEY=... NODE_USE_ENV_PROXY=1 ./clips.sh wag
# Then convert: python3 ../clip2webm.py clips/wag.mp4 ../../assets/clips/wag.webm --fit-start sit --fit-end sit
set -e
mkdir -p clips
go() { local n=$1; shift; [ -z "$ONLY" ] || [ "$ONLY" = "$n" ] && node clip.mjs "$n" "$@"; }
ONLY=$1

go wag sit sit 5 "The French Bulldog gets excited and happy: he wiggles his whole rear end and stub tail side to side while staying seated, opens his mouth into a happy pant with his tongue out, ears perk, then closes his mouth and settles back into exactly the same calm sitting pose as the start, looking at the camera."
go bark sit sit 4 "The French Bulldog barks loudly at the camera two times: each bark he opens his mouth wide showing teeth and tongue, his head jerks slightly forward, cheeks puff, then he closes his mouth and returns to exactly the same calm sitting pose as the start."
go puppy sit sit 5 "The French Bulldog gives sweet puppy-dog eyes: he slowly lowers and tilts his head to one side, looks up at the camera with big soulful pleading eyes, ears slightly back, then slowly straightens his head and returns to exactly the same sitting pose as the start."
go poop sit sit 8 "The French Bulldog stands up, turns his body sideways, hunches his back into a squat with his tail raised as if pooping, holds briefly, then stands, turns back toward the camera and sits down again in exactly the same pose as the start."
go lie_down sit lie 5 "The French Bulldog lies down: from sitting he turns his body a little to the right side of the image, walks his front paws forward and lowers himself onto his belly, ending lying in a relaxed sphinx pose with his body angled toward the right of the image, front legs stretched forward, head up looking at the camera, exactly matching the final frame."
go get_up lie sit 4 "The French Bulldog gets up from lying down and sits upright, ending sitting and looking straight at the camera."
go fall_asleep lie sleep 6 "The French Bulldog gets sleepy: he yawns, his eyelids get heavy, he lowers his head and rests his chin on his front paws, and closes his eyes, falling asleep."
go sleep_loop sleep_side sleep_side 6 "The French Bulldog is fast asleep lying down with his head resting on his paws and eyes closed: his body rises and falls slowly as he breathes deeply, one ear twitches gently once, otherwise completely still."
go wake_up sleep_side sit 5 "The sleeping French Bulldog wakes up: he opens his eyes, lifts his head, stretches his front legs, then gets up and sits upright, turning to face the camera, ending sitting and looking straight at the camera."
