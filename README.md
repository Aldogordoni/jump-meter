# Jump Meter

Measure your vertical jump from a slow-motion video, using flight time.

**Live app:** https://aldogordoni.github.io/jump-meter/

## How it works

Rising takes as long as falling, so the time in the air (*t*) gives the jump height directly:

```
h = g · t² / 8
```

The app finds two frames in your video, the **first frame in the air** and the **first frame back on the ground**.
It counts the frames between them and divides by the real capture rate to get *t*.

- **Manual:** step frame by frame (±1 / ±10, or ← → keys, `a` / `l` to mark) and set both frames.
- **Auto:** MediaPipe Pose runs in the browser. It tracks the lowest point of your feet, scans the whole clip to find the
  jump, then checks every frame around take-off and landing. It extrapolates the foot path to the floor for sub-frame
  timing. You can nudge the result afterwards.

Accuracy depends on frame rate: about ±0.5 cm at 240 fps, ±1 cm at 120 fps, ±5 cm at 30 fps.

### Slow-mo files

Phones save slow motion in two ways:

1. **High-fps file** (e.g. 240 fps container). The frame rate is read from the MP4 `stts` box.
2. **Normal-speed file** of a slow-mo capture (e.g. 30 fps file, shot at 240). Android usually records
   `com.android.capture.fps` in the metadata, which the app reads. Otherwise enter the real rate in "Recorded at".

## Jump types and metrics

| Type | Marks | Metrics |
|---|---|---|
| CMJ, CMJ + arms, squat jump | movement start (optional), take-off, landing | height, flight time, take-off speed, peak power (Sayers), time to take-off, **RSI-modified** = h / time to take-off |
| Drop jump | box landing, take-off, landing | height, **contact time**, **RSI** = h / contact time, flight : contact ratio |
| Single-leg L / R | take-off, landing | height per side, **asymmetry %** in History |
| Approach, other | take-off, landing | height, flight time |

Heights display in **cm or inches** (Setup, or the toggle on the result). They're always stored in cm.

## Features

- Frame-accurate stepping (`requestVideoFrameCallback`)
- MP4/MOV metadata parsing for fps, with no dependencies (`src/app/core/mp4-info.ts`)
- Auto-detection with MediaPipe Pose (`src/app/core/pose-detector.service.ts`, `flight-detect.ts`)
- Flight time, take-off velocity, timing uncertainty and peak power (Sayers equation, if you add your body mass)
- History per jump type, with a progress chart and JSON export/import (stored in `localStorage`)
- Installable PWA that works offline after first use. Videos never leave the device.

## Development

```bash
npm install
npm start            # http://localhost:4200
npm run build
```

To use auto-detect locally, download the model into `public/models/` (the deploy workflow does this):

```bash
mkdir -p public/models
curl -L -o public/models/pose_landmarker_full.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
```

If that file is missing, the app loads the model from Google's CDN instead.

## Deploy

Pushing to `main` builds the app and deploys it to GitHub Pages (`.github/workflows/deploy.yml`).

Stack: Angular 20 (standalone components, signals), TypeScript, MediaPipe Tasks Vision.
