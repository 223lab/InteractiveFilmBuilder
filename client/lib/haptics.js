// navigator.vibrate works on Android Chrome/Firefox. iOS Safari ignores it (no web vibration API),
// so every haptic is paired with a visual + audio cue.
export function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}

export const HAPTIC = {
  tap: 35,
  vote: [40, 30, 80],
  freeze: [20, 40, 20, 40, 120],
  glitch: [15, 25, 15, 25, 15, 60, 200],
  win: [60, 40, 60],
  lose: [200],
};

/** Keep the phone screen awake while in the game (where supported). Returns a cleanup fn. */
export function startWakeLock(active = true) {
  let lock = null;
  let disposed = false;
  const request = async () => {
    try {
      if (!active || disposed || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
      lock = await navigator.wakeLock.request('screen');
    } catch {
      /* denied or unsupported */
    }
  };
  const onVis = () => document.visibilityState === 'visible' && request();
  request();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVis);
    lock?.release?.().catch(() => {});
  };
}
