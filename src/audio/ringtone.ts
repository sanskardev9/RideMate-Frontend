/**
 * The incoming-call ring: two soft chimes, a pause, repeat. Synthesised for
 * the same reason as the SOS siren — nothing to download, so it starts on the
 * first frame of the call. Deliberately gentler than the siren: a call is not
 * an emergency, and the two must never be mistaken for each other.
 */
const CHIME = [784, 988]; // G5, B5
const BEAT_MS = 190;
const CYCLE_MS = 2400;
const LEVEL = 0.12;

let ctx: AudioContext | null = null;
let cycle: number | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

function chime(audio: AudioContext, at: number, frequency: number) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(LEVEL, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
  osc.connect(gain).connect(audio.destination);
  osc.start(at);
  osc.stop(at + 0.36);
}

export function startRingtone() {
  if (cycle !== null) return;
  const audio = context();
  if (!audio) return;
  void audio.resume();

  const ring = () => {
    const now = audio.currentTime;
    CHIME.forEach((frequency, index) => chime(audio, now + (index * BEAT_MS) / 1000, frequency));
    navigator.vibrate?.([300, 200, 300]);
  };
  ring();
  cycle = window.setInterval(ring, CYCLE_MS);
}

export function stopRingtone() {
  if (cycle === null) return;
  window.clearInterval(cycle);
  cycle = null;
  navigator.vibrate?.(0);
}
