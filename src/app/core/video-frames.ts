/**
 * Frame-accurate seeking for an HTMLVideoElement.
 * We aim at the middle of a frame's display interval so rounding never lands
 * on the neighbouring frame.
 */
export function frameTime(frame: number, fps: number): number {
  return (frame + 0.5) / fps;
}

export function timeToFrame(time: number, fps: number): number {
  return Math.max(0, Math.floor(time * fps + 1e-6));
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

/** Seek and resolve once the new frame is actually decoded and shown. */
export function seekToFrame(video: HTMLVideoElement, frame: number, fps: number): Promise<void> {
  const target = Math.min(frameTime(frame, fps), Math.max(0, (video.duration || Infinity) - 0.0005));
  return seekToTime(video, target);
}

export function seekToTime(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const v = video as FrameCallbackVideo;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // Safety net: some browsers skip events when the time doesn't change.
    const timer = setTimeout(finish, 1500);

    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      if (v.requestVideoFrameCallback) {
        v.requestVideoFrameCallback(() => finish());
        // rVFC may not fire for a paused video in some browsers once the frame is already shown.
        setTimeout(finish, 120);
      } else {
        requestAnimationFrame(() => requestAnimationFrame(finish));
      }
    };
    video.addEventListener('seeked', onSeeked);
    if (Math.abs(video.currentTime - time) < 1e-6) {
      video.removeEventListener('seeked', onSeeked);
      finish();
      return;
    }
    video.currentTime = time;
  });
}
