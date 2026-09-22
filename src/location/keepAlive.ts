/**
 * Keeping the app alive long enough to keep reporting a position.
 *
 * The web has no true background geolocation: once a browser tab is hidden,
 * the operating system is free to freeze it, and a frozen tab reports nothing.
 * Two levers exist, and this module is both of them:
 *
 *  - a screen wake lock, so a phone on the handlebars does not sleep mid-ride;
 *  - an all-but-silent looping sound, which marks the tab as playing media.
 *    Chrome on Android does not freeze a tab that is playing audio, so timers
 *    and the geolocation watch keep running when the rider switches apps. iOS
 *    suspends the page regardless, so there it buys nothing.
 *
 * Anything more than this needs a native shell (Capacitor, or a native app).
 */

let lock: WakeLockSentinel | null = null;
let wanted = false;
let keepAlive: HTMLAudioElement | null = null;
let keepAliveUrl: string | null = null;

/** True where the audio trick has a chance of working. */
export function backgroundKeepAliveSupported() {
  if (typeof navigator === "undefined") return false;
  // iOS suspends a backgrounded page whatever it is playing -- including
  // every browser on iOS, which are all Safari underneath.
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return !ios;
}

export const screenLockSupported = () =>
  typeof navigator !== "undefined" && "wakeLock" in navigator;

async function acquire() {
  if (!wanted || lock || document.visibilityState !== "visible") return;
  try {
    lock = await navigator.wakeLock.request("screen");
    lock.addEventListener("release", () => {
      lock = null;
    });
  } catch {
    // Denied, or the battery is too low for the browser to allow it.
    lock = null;
  }
}

// A lock is dropped whenever the page is hidden and is not handed back on its
// own, so take it again every time the rider comes back to the app.
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void acquire();
  });

export function holdScreenAwake() {
  wanted = true;
  void acquire();
}

export function letScreenSleep() {
  wanted = false;
  void lock?.release().catch(() => undefined);
  lock = null;
}

/**
 * A one-second loop of the faintest possible noise. Digital silence is
 * treated as "not playing audio" by Chrome, which defeats the point, so the
 * samples carry a couple of bits of dither -- inaudible through a speaker.
 */
function quietLoop(): string {
  const rate = 8000;
  const samples = rate;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1)
    view.setInt16(44 + i * 2, i % 2 === 0 ? 2 : -2, true);

  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/**
 * `blocked` is the case worth reporting: the browser would not start the
 * sound without a gesture behind it, so nothing is holding the tab open and
 * the rider would otherwise believe background tracking was running.
 */
export type KeepAliveState = "off" | "running" | "blocked";

let state: KeepAliveState = "off";
const watchers = new Set<(state: KeepAliveState) => void>();

export const keepAliveState = () => state;

export function onKeepAliveChange(listener: (state: KeepAliveState) => void) {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

function setState(next: KeepAliveState) {
  if (state === next) return;
  state = next;
  watchers.forEach((listener) => listener(next));
}

export function startBackgroundKeepAlive() {
  if (keepAlive || typeof Audio === "undefined") return;
  keepAliveUrl = quietLoop();
  const audio = new Audio(keepAliveUrl);
  audio.loop = true;
  audio.volume = 1; // the recording itself is inaudible
  audio.setAttribute("playsinline", "");
  keepAlive = audio;
  audio
    .play()
    .then(() => setState("running"))
    .catch(() => {
      // No user gesture behind this attempt. Take the next one.
      setState("blocked");
      const retry = () => {
        if (keepAlive !== audio) return;
        void audio.play().then(() => setState("running")).catch(() => undefined);
      };
      window.addEventListener("pointerdown", retry, { once: true });
      window.addEventListener("keydown", retry, { once: true });
    });
}

export function stopBackgroundKeepAlive() {
  keepAlive?.pause();
  keepAlive = null;
  if (keepAliveUrl) URL.revokeObjectURL(keepAliveUrl);
  keepAliveUrl = null;
  setState("off");
}
