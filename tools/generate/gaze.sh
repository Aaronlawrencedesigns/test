#!/bin/bash
# usage: gaze.sh col row   col: 0..4 (image-left..image-right)  row: 0..2 (up, level, down)
cd "$(dirname "$0")"; mkdir -p gaze
H=("far toward the LEFT side of the image (his head turned about 40 degrees to the image's left)" "slightly toward the LEFT side of the image (head turned about 20 degrees to the image's left)" "straight ahead at the camera" "slightly toward the RIGHT side of the image (head turned about 20 degrees to the image's right)" "far toward the RIGHT side of the image (his head turned about 40 degrees to the image's right)")
V=("and upward (chin raised about 20 degrees, eyes looking up)" "at eye level" "and downward (head lowered about 20 degrees, eyes looking down)")
cat > gaze/p_$1_$2.txt <<P
Edit this photo. Keep EVERYTHING identical: the same dog with the same markings, the same body position, paws, framing, scale, lighting and the flat chroma-key green background. Do not move or change the body at all.
Only change where he is looking: turn his head and eyes so he looks ${H[$1]} ${V[$2]}. His eyes and nose point in that direction, like a dog following something with its gaze. Mouth closed. Photorealistic. Square image, same size.
P
node chatimg.mjs gemini-3-pro-image-preview gaze/g_$1_$2 gaze/p_$1_$2.txt ../../assets/keyframes/sit.png > gaze/log_$1_$2.txt 2>&1
tail -1 gaze/log_$1_$2.txt
