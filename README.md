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

### Frame rate: file first, then physics

The frame rate matters a lot: height goes with the *square* of the flight time, so reading the same frames at the wrong
rate is way off (2× the fps = ¼ of the height).

1. **From the file.** The MP4/MOV sample table gives the rate the video plays at, and Android slow-mo clips also store the
   real capture rate (`com.android.capture.fps`).
2. **From the jump itself.** In the air your hips follow a parabola under gravity. Its curvature in image units per frame²
   is `½·g / (S·fps²)`, where `S` (metres per image unit) comes from your body size in the frame and your height (entered
   in Setup, or 175 cm by default). That pins the real rate to within a few percent. It isn't precise enough to replace the
   file's rate, but it easily catches slow motion saved as a normal-speed video (×2, ×4, ×8), which the app then fixes
   automatically, with an undo (`src/app/core/fps-infer.ts`).

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

## Recording and dates

- **Record now** uses the in-app camera. It picks the highest frame rate the camera offers at 720p or better (usually
  60 fps in a browser) and records at a high bitrate, about 16 Mbps at 1080p60. The file picker's own "Take Video"
  option records at medium quality, which websites can't change. For 240 fps, film in the phone's Slo-mo and choose the
  video.
- Timing uses each frame's real **timestamp**, interpolated for sub-frame marks, so the uneven frame timing of live
  recordings doesn't skew the result.
- **Jump date** comes from when the video was filmed: `com.apple.quicktime.creationdate`, the MP4 `mvhd` creation time,
  or the file's date if it's clearly older than the upload. Live recordings use the recording time. You can always edit
  it before saving, which keeps the progress chart accurate.

## Features

- Frame-accurate stepping (`requestVideoFrameCallback`)
- MP4/MOV metadata parsing for fps, with no dependencies (`src/app/core/mp4-info.ts`)
- Auto-detection with MediaPipe Pose (`src/app/core/pose-detector.service.ts`, `flight-detect.ts`)
- Flight time, take-off velocity, timing uncertainty and peak power (Sayers equation, if you add your body mass)
- History per jump type, with a progress chart and JSON export/import (stored in `localStorage`)
- Saves a short slow-motion **video clip** of each jump (key frames labelled, result captioned) to view, download or share
- Installable PWA that works offline after first use

## Cloud sync and privacy

The phone is always the working copy: everything works offline, in `localStorage` with clips in IndexedDB. Signing in
adds a long-term cloud copy in **Supabase** (EU region).

- **Invite-only.** Only emails in `public.allowed_emails` can create an account: a trigger on `auth.users` rejects
  everyone else. Every table and the clips bucket also check the list on each request with row-level security, so
  removing an email cuts off access immediately. Admins manage the list in the app under **Account → Manage approved
  emails**.
- **Own data only.** Row-level security limits every row and file to its owner (`clips/<user id>/…`).
- **Passwordless.** Users sign in with a 6-digit code sent by email.
- **Deletable.** Users can delete all their cloud data from the Account page.
- The page's Content Security Policy only allows network requests to the app itself, Supabase, and Google's model CDN.

### Supabase setup

1. Apply `supabase/migrations/0001_init.sql` (already applied to the `jump-meter` project). Optionally also apply
   `0002_delete_my_account.sql`, so users can delete their own login and not just their data.
2. **Authentication → Email Templates**: in both **Magic Link** and **Confirm signup**, put the code in the email:
   `<h2>Your Jump Meter code</h2><p>Enter this code in the app: <strong>{{ .Token }}</strong></p>`
3. **Authentication → URL Configuration**: set Site URL to `https://aldogordoni.github.io/jump-meter/`.
4. Put the project URL and publishable key in `src/app/core/cloud.config.ts`. Both are public by design.

Supabase's built-in email sender only allows a few emails per hour. For more than a handful of users, add your own SMTP
under Authentication → SMTP Settings.

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
