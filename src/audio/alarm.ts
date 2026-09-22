/**
 * The SOS siren, synthesised rather than loaded from a file: it has to sound
 * the instant an alert arrives, with no network fetch in the way, and it must
 * keep going for as long as the alert is live.
 *
 * Browsers refuse to start audio until the page has been interacted with, so
 * `unlockAlarm` is wired to the first gesture and the context is kept alive
 * from then on.
 */
const CARRIER_HZ = 620; // middle of the two-tone sweep
const SWING_HZ = 260; // how far either side of it the tone steps
const WAIL_HZ = 3.1; // steps per second
const LEVEL = 0.16; // loud enough to notice, not to distort a phone speaker
const VIBRATE_PATTERN = [500, 220, 500, 220];

type Running = {
  carrier: OscillatorNode;
  wail: OscillatorNode;
  gain: GainNode;
  buzzer: number;
};

let ctx: AudioContext | null = null;
let running: Running | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/** Call from a user gesture so the siren is allowed to sound later on. */
export function unlockAlarm() {
  const audio = context();
  if (audio?.state === "suspended") void audio.resume();
}

export function alarmSupported() {
  return Boolean(context());
}

export function startAlarm() {
  if (running) return;
  const audio = context();
  if (!audio) return;
  void audio.resume();

  // A square carrier whose pitch is stepped up and down by a second, very slow
  // square oscillator: the classic two-tone emergency wail.
  const carrier = audio.createOscillator();
  carrier.type = "square";
  carrier.frequency.value = CARRIER_HZ;

  const wail = audio.createOscillator();
  wail.type = "square";
  wail.frequency.value = WAIL_HZ;

  const swing = audio.createGain();
  swing.gain.value = SWING_HZ;
  wail.connect(swing).connect(carrier.frequency);

  // Takes the edge off the square wave so it carries without being shrill.
  const tone = audio.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 1900;

  const gain = audio.createGain();
  gain.gain.setValueAtTime(0, audio.currentTime);
  gain.gain.linearRampToValueAtTime(LEVEL, audio.currentTime + 0.08);

  carrier.connect(tone).connect(gain).connect(audio.destination);
  carrier.start();
  wail.start();

  // Phones in a pocket or tank bag get felt as well as heard.
  const buzz = () => navigator.vibrate?.(VIBRATE_PATTERN);
  buzz();
  const buzzer = window.setInterval(buzz, 1500);

  running = { carrier, wail, gain, buzzer };
}

export function stopAlarm() {
  const current = running;
  if (!current) return;
  running = null;
  window.clearInterval(current.buzzer);
  navigator.vibrate?.(0);

  const audio = ctx;
  if (!audio) return;
  // Fade out rather than cut, so it does not end on a click.
  const end = audio.currentTime + 0.12;
  current.gain.gain.cancelScheduledValues(audio.currentTime);
  current.gain.gain.setValueAtTime(current.gain.gain.value, audio.currentTime);
  current.gain.gain.linearRampToValueAtTime(0, end);
  current.carrier.stop(end);
  current.wail.stop(end);
}

export const alarmSounding = () => running !== null;
