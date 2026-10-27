# Room Scanner

## Problem statement

Anyone who rents, moves, renovates, or furnishes a space needs the same thing:
accurate room layouts with real dimensions — wall widths, floor area, where the
doors, windows, and outlets are, and whether the sofa will actually fit through
the door.

Today that requires either tedious manual measuring (tape measure, sketching,
transcription errors), expensive hardware (LiDAR, which is iPhone Pro–only),
or pro-grade tools with a learning curve. Most people just guess, and guessing
is why furniture gets returned and renovation quotes go wrong.

A phone-camera-only room scanner would remove all of that friction: walk through
a room shooting video, get back a labeled layout with measurements. No special
hardware, no expertise.

Proposed approach: SAM 3.1 segments and tracks every object and region across
the walkthrough frames (zero-shot, open-vocabulary prompts like "door" or
"window"), an open-weight monocular depth model supplies per-frame geometry,
and the two fuse into a measured layout. A conversational layer on top answers
questions like "how wide is that wall?" Scale is resolved with a single
user-supplied reference measurement.
