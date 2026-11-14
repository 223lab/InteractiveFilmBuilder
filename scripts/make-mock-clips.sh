#!/usr/bin/env bash
# Generates placeholder clips (static + labels + drone) into media/mock/ so the whole
# flow can be tested before real footage exists. Requires ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=media/mock
mkdir -p "$OUT"

FONT=$(fc-match -f '%{file}' 'DejaVu Sans Mono:bold' 2>/dev/null || true)
[ -f "$FONT" ] || FONT=$(fc-match -f '%{file}' monospace)

make_clip() { # id  title  subtitle  color  seconds  drone_hz
  local id=$1 title=$2 sub=$3 color=$4 dur=$5 hz=$6
  ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=0x060606:s=854x480:r=24:d=${dur}" \
    -f lavfi -i "sine=f=${hz}:d=${dur}" \
    -filter_complex "\
[0:v]noise=alls=38:allf=t+u,eq=contrast=1.25,\
drawbox=x=0:y=ih*0.47:w=iw:h=2:color=${color}@0.35:t=fill,\
drawtext=fontfile='${FONT}':text='${title}':fontcolor=${color}:fontsize=52:x=(w-text_w)/2:y=h*0.36,\
drawtext=fontfile='${FONT}':text='${sub}':fontcolor=0x7fe9ff:fontsize=22:x=(w-text_w)/2:y=h*0.54,\
drawtext=fontfile='${FONT}':text='MOCK CLIP  %{pts\:hms}':fontcolor=white@0.55:fontsize=16:x=24:y=h-40,\
drawtext=fontfile='${FONT}':text='REC':fontcolor=0xff2a3d:fontsize=18:x=w-70:y=24:enable='lt(mod(t,1),0.5)'[v];\
[1:a]volume=0.25,tremolo=f=3:d=0.6,afade=t=in:d=0.5,afade=t=out:st=$(echo "$dur-0.6" | bc):d=0.6[a]" \
    -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p \
    -c:a aac -b:a 64k -movflags +faststart "$OUT/$id.mp4"
  echo "  $OUT/$id.mp4"
}

make_clip intro      'SIGNAL LOST'     'scene 01 - the server room door hums'   0xff2a3d 6 55
make_clip room       'THE ROOM'        'scene 02 - a terminal is still awake'   0xff2a3d 6 62
make_clip corridor   'THE CORRIDOR'    'scene 03 - something follows the lights' 0xff2a3d 6 49
make_clip end_unplug 'POWER CUT'       'ending - it is finally quiet'           0x7fe9ff 5 82
make_clip end_screen 'IT SAW YOU'      'ending - the screen reads you back'     0xff2a3d 5 41
make_clip end_hide   'NO ONE CAME'     'ending - the lights go out one by one'  0xff2a3d 5 37
