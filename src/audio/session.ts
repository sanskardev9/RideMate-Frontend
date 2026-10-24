/**
 * iOS Safari's audio session decides what a page may do with sound, and the
 * siren and calls want different things from it:
 *
 * - "playback" sounds through the ring/silent switch (an SOS must), but
 *   refuses microphone capture outright.
 * - "play-and-record" is what a call needs, and is not silenced either.
 * - "auto" is the browser's default.
 *
 * Both features set their need here, and a call wins, so a siren going off
 * mid-call never takes the microphone away. Other browsers lack the API and
 * this does nothing.
 */
let sirenOn = false;
let callOn = false;

function apply() {
  const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
  if (!session) return;
  session.type = callOn ? "play-and-record" : sirenOn ? "playback" : "auto";
}

export function setSirenAudio(on: boolean) {
  sirenOn = on;
  apply();
}

export function setCallAudio(on: boolean) {
  callOn = on;
  apply();
}
