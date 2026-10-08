# Jump Meter roadmap

Everything below was proposed as the path from a solid personal tool to a state-of-the-art jump testing platform.
Status as of October 2026: ✅ done, ⏭ deliberately left out (with the reason), 👤 needs a setting only you can change.

## Measurement and accuracy

- ✅ Landing-posture check: knee and hip angles at take-off vs touchdown, with the estimated height inflation.
- ✅ Arm-swing detection from the wrists, offering CMJ ↔ CMJ + arms.
- ✅ Confidence score per result (frame rate, motion check, foot visibility, landing, plausibility), with reasons.
- ✅ Repeated-jump tests: every hop in a clip, per-hop contact/flight/RSI, 10/5 score from the best five.
- ✅ Broad jump distance and jump-and-reach, calibrated from a known length (or your height).
- ✅ Kinematics from the hip trajectory: dip depth, down/push phase times, peak hip speed, momentum.
- ✅ Validation mode: enter another device's result and see bias, limits of agreement and correlation.
- ⏭ Rolling shutter and lens distortion correction: no measurable benefit for flight-time timing at the frame rates
  phones record; distance tools use a calibration in the jump's own plane.
- ⏭ Native 240 fps capture (Capacitor): needs App Store / Play Store apps, a separate build and signing. Filming in
  the camera's Slo-mo and choosing the video gives the same 240 fps today.

## Training and insights

- ✅ Sessions, best or mean of 3, CV%.
- ✅ Readiness from a 28-day baseline and the smallest worthwhile change, with a 7-session trend.
- ✅ Rolling average and normal band on the chart.
- ✅ Personal records and milestones, with a celebration.
- ✅ Goals with a projected date from the trend.
- ✅ Tags and "what makes a difference".
- ✅ Norms (CMJ height, RSI, RSI-modified) by sex.
- ✅ Training plans with re-tests and calendar reminders (.ics).
- ✅ CSV export.
- ⏭ Apple Health / Google Fit: neither can be written to from a web app.

## Coaching and social

- ✅ Coach access with athlete consent, enforced by database rules; coach dashboard with readiness per athlete.
- ✅ Squads with invite codes and opt-in leaderboards.
- ✅ Comments on jumps, with live notifications.
- ✅ Share card.

## Experience

- ✅ First-run guide.
- ✅ Recorder framing guide with live pose, hands-free start and stop.
- ✅ Haptics and sounds.
- ✅ Clip trim, slow-motion replay, side-by-side compare.
- ✅ Accessibility: axe audit clean in light and dark mode; contrast, headings, skip link, focus handling.
- ⏭ Translations: removed at your request.

## Platform and engineering

- ✅ Pose model in a Web Worker (main-thread fallback). Measured worst UI stall during analysis: ~10 ms (was ~145 ms).
- ✅ Tests in CI: unit tests, database security tests on Postgres, browser tests against a fake Supabase. Deploys
  only happen when all pass.
- ✅ Generated TypeScript types for the database.
- ✅ Error reporting into the project's own database (instead of a third-party service), shown on the admin page.
- ✅ Storage housekeeping: per-person file quota, optional auto-delete of old clips, smaller "standard" clip quality.
- ✅ Realtime sync between devices.
- ⏭ Custom domain: needs a domain purchase and DNS; the GitHub Pages address works meanwhile.

## Security and privacy

- ✅ Password strength check (minimum length, common and personal passwords refused, strength meter).
- ✅ Two-step sign-in (authenticator app), enforced by the database for accounts that turn it on.
- ✅ Privacy page and record of processing.
- ✅ Database security tests in CI.
- ✅ Admin audit log of approved-email changes.
- 👤 Leaked-password protection: a toggle in the Supabase dashboard (Authentication → Policies; paid plans).
- 👤 Password rules on the server: Authentication → Policies → minimum length 10 to match the app.
- ⏭ CAPTCHA on the email-code request: accounts are invite-only, so abuse is limited to approved emails; revisit if
  the email quota is ever hit.
