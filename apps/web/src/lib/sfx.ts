/**
 * Tiny chiptune sound effects synthesised with WebAudio: no audio files, fits the pixel style.
 * Muted state persists per browser. Every call is a no-op when muted or when audio is unavailable.
 */
const KEY = 'ff.sfx.muted';
let ctx: AudioContext | null = null;
let muted = (() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } })();

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try { localStorage.setItem(KEY, m ? '1' : '0'); } catch { /* storage blocked */ }
}

function ac(): AudioContext | null {
  if (muted || typeof window === 'undefined') return null;
  try {
    ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}

/** One square/triangle note with a quick attack and exponential decay. */
function note(freq: number, at: number, dur: number, type: OscillatorType = 'square', vol = 0.06, slideTo?: number) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

/** Short burst of filtered noise (paper tearing). */
function noise(at: number, dur: number, vol = 0.12) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + at;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf; f.type = 'highpass'; f.frequency.value = 1800; g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}

export const sfx = {
  /** Pack wobble while the transaction confirms. */
  rumble: () => { note(70, 0, 0.18, 'triangle', 0.08, 55); },
  /** Pack ready: rising shimmer. */
  charge: (tier: number) => { [0, 4, 7, 12].slice(0, 2 + tier).forEach((s, i) => note(330 * 2 ** (s / 12), i * 0.07, 0.18, 'triangle', 0.05)); },
  tear: () => { noise(0, 0.28); note(220, 0, 0.2, 'square', 0.03, 880); },
  deal: (i: number) => { note(500 + i * 60, 0, 0.06, 'square', 0.025); },
  flip: (rarity: string) => {
    if (rarity === 'legendary') {
      [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => note(262 * 2 ** (s / 12), i * 0.07, 0.35, 'square', 0.05));
      note(1046, 0.5, 0.9, 'triangle', 0.06);
    } else if (rarity === 'rare') {
      [0, 7, 12, 16].forEach((s, i) => note(392 * 2 ** (s / 12), i * 0.06, 0.25, 'square', 0.045));
    } else if (rarity === 'uncommon') {
      note(523, 0, 0.12, 'square', 0.04); note(784, 0.07, 0.16, 'square', 0.04);
    } else note(440, 0, 0.09, 'square', 0.035, 520);
  },
  done: () => { [0, 4, 7].forEach((s, i) => note(523 * 2 ** (s / 12), i * 0.05, 0.2, 'triangle', 0.04)); },
  // ─── Match ───
  play: () => { note(330, 0, 0.08, 'square', 0.035, 660); },
  summon: () => { note(120, 0, 0.16, 'triangle', 0.09, 60); noise(0, 0.08, 0.05); },
  attack: () => { note(180, 0, 0.1, 'square', 0.04, 90); },
  hit: (n: number) => { noise(0, 0.12 + Math.min(n, 8) * 0.01, 0.08 + Math.min(n, 8) * 0.01); note(110, 0, 0.12, 'square', 0.05, 55); },
  death: () => { noise(0, 0.35, 0.1); [0, -3, -7].forEach((s, i) => note(220 * 2 ** (s / 12), i * 0.06, 0.12, 'square', 0.03)); },
  buff: () => { note(660, 0, 0.08, 'triangle', 0.04); note(990, 0.06, 0.12, 'triangle', 0.04); },
  turn: () => { [0, 7].forEach((s, i) => note(440 * 2 ** (s / 12), i * 0.09, 0.2, 'triangle', 0.05)); },
  predict: (hit: boolean) => { (hit ? [0, 4, 7, 12] : [12, 6, 0]).forEach((s, i) => note(392 * 2 ** (s / 12), i * 0.07, 0.16, 'square', 0.04)); },
  win: () => { [0, 4, 7, 12, 7, 12, 16].forEach((s, i) => note(392 * 2 ** (s / 12), i * 0.11, 0.25, 'square', 0.045)); },
  lose: () => { [7, 3, 0, -5].forEach((s, i) => note(330 * 2 ** (s / 12), i * 0.16, 0.3, 'triangle', 0.05)); },
};
