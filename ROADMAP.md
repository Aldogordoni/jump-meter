# Jump Meter roadmap

What would take Jump Meter from a solid personal tool to a state-of-the-art jump testing platform. Ordered by value per
effort within each section. **Effort**: S = an evening, M = a few days, L = a week or more.

## Top picks

These eight give the biggest jump in accuracy, insight and polish:

1. **Landing-posture check** (accuracy, M). The biggest error source in flight-time testing is landing with bent knees or
   tucked legs, which inflates height. The pose model already sees the knees, so measure knee and hip angles at take-off
   vs landing and flag "landing looked bent, height may be inflated by ~X cm".
2. **Readiness score from daily CMJs** (insight, M). This is how pro teams use jump tests. Take a rolling baseline, then
   compare today's jump to it using the *smallest worthwhile change* (0.2 × between-day SD) and the coefficient of
   variation. Show "fresh / normal / fatigued" instead of a raw number.
3. **Sessions and best-of-3 protocol** (insight, S). Group jumps into sessions, take the best or mean of 3, and show
   within-session consistency (CV%). Standard testing practice, and it makes the chart far less noisy.
4. **Live framing guide in the recorder** (accuracy and UX, M). Run the pose model on the camera preview, then show
   "move back, feet cut off", "hold still" and a floor line. Bad framing is the main reason auto-detect fails.
5. **Native 240 fps capture with Capacitor** (accuracy, L). Browsers cap at 60 fps (±2 cm). Wrapping the Angular app in
   Capacitor gives AVFoundation / Camera2 access to 240 fps in-app (±0.5 cm), keeping one codebase.
6. **Kinematics from the hip trajectory** (insight, M). Countermovement depth, eccentric/braking time, concentric time,
   peak take-off velocity and jump momentum (mass × velocity). Pro force-plate metrics, estimated from video.
7. **Share card** (engagement, S). A story-sized image with the result, the Vertec graphic and a key frame, ready for
   Instagram or WhatsApp.
8. **Italian, Albanian and Polish translations** (reach, S–M). Angular i18n with the four languages.

## Measurement and accuracy

- [ ] Landing-posture check (see top picks).
- [ ] Arm-swing detection: auto-classify CMJ vs CMJ + arms from wrist landmarks, so types stay honest.
- [ ] Confidence score per result: fps, fit quality of the take-off/landing extrapolation, pose visibility. Show
      "high/medium/low confidence".
- [ ] Multiple jumps per clip: detect every flight in a clip. Enables **repeated-jump tests**: 10/5 RSI, pogo
      jumps, and the 15 s / 30 s Bosco test with power and fatigue index.
- [ ] Broad jump and approach-jump distance, using a known reference length in frame (e.g. a 1 m tape) to calibrate
      pixels to metres.
- [ ] Jump-and-reach (true vertical reach) from a calibrated frame, to compare with flight-time height.
- [ ] Validation mode: enter results from a contact mat or force plate for the same jump and track the app's bias.
- [ ] Rolling shutter and lens distortion correction for phones at close range.
- [ ] Native high-fps capture (see top picks).

## Training and insights

- [ ] Sessions, best-of-3 and CV% (see top picks).
- [ ] Readiness and fatigue monitoring (see top picks), with a 7-day trend and alerts.
- [ ] Rolling averages and smallest-worthwhile-change bands on the chart, so you can see whether progress is real or
      just noise.
- [ ] Personal records and milestones (first 40 cm, +5 cm in a month) with a small celebration.
- [ ] Goals: target height or RSI by a date, with the trend line projected.
- [ ] Tags per jump: shoes, surface, time of day, warm-up, sleep, soreness. Filter and compare.
- [ ] Norms and percentiles by age, sex and sport (published CMJ/RSI reference data).
- [ ] Training plans: plyometric and strength blocks, with re-tests scheduled and reminders.
- [ ] CSV export for spreadsheets, and Apple Health / Google Fit integration.

## Coaching and social

- [ ] Coach mode: an athlete shares their data with a coach, consent-based and enforced with RLS. The coach sees a team
      dashboard.
- [ ] Squads and leaderboards within an invite-only group (opt-in).
- [ ] Comments on a jump clip (coach feedback on technique).
- [ ] Share card (see top picks).

## Experience

- [ ] First-run onboarding: a 3-step filming guide with an example video.
- [ ] Recorder framing overlay (see top picks), plus auto-start recording when you stand still and auto-stop after
      landing.
- [ ] Haptics and sound when a jump is detected.
- [ ] Clip editor: trim, slow-mo replay around take-off and landing, side-by-side comparison of two jumps.
- [ ] Translations (see top picks).
- [ ] Accessibility audit (screen reader pass, larger text, reduced motion already honoured).

## Platform and engineering

- [ ] Move pose and decoding into a Web Worker (OffscreenCanvas) so the UI never stutters; try WebGPU for the pose
      model.
- [ ] Automated tests in CI: unit tests for the maths and detection, and the Playwright end-to-end scripts (already
      written during development) against a mocked Supabase.
- [ ] Generated TypeScript types from the database schema.
- [ ] Error reporting (e.g. Sentry) with no personal data.
- [ ] Custom domain (e.g. jumpmeter.app) for nicer sign-in emails and links.
- [ ] Storage housekeeping: per-user quota, optional auto-delete of clips older than N months, and cheaper re-encoding.
- [ ] Realtime sync between devices (Supabase Realtime) instead of sync-on-open.

## Security and privacy

- [ ] Turn on **leaked-password protection** and minimum password strength in Supabase Auth settings (S, dashboard).
- [ ] Optional two-factor sign-in (TOTP authenticator app).
- [ ] CAPTCHA (Cloudflare Turnstile) on the email-code request, to stop abuse of your email quota.
- [ ] Privacy notice page and a data-processing record (who, what, where, how long), since you're the controller for
      approved friends' data.
- [ ] Database security tests in CI (the rules were tested locally during development; automate it).
- [ ] Admin audit log: who approved or removed which email, and when.
