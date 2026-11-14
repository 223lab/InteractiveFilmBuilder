// Dark, cinematic sound cues for the host screen.
//
// Two layers:
//  1. YOUR OWN FILES (recommended for the final show): put audio files in media/sfx/ named
//     after a cue, e.g. media/sfx/resolve.wav. Any cue with a file plays the file instead
//     of the generated sound. Cues: start, cut, freeze, dread (looped while deciding),
//     resolve, ending, reset.  Formats: .mp3 .wav .ogg .m4a
//  2. GENERATED fallback: low rumble, sub-bass and dissonant drones through a long, dark
//     reverb. No bleeps, crackle bursts or ticks.
//
// Browsers only allow audio after a user gesture: call unlockAudio() from a click/tap.

const CUES = ['start', 'cut', 'freeze', 'dread', 'resolve', 'ending', 'reset'];

let ctx = null;
let dry = null;
let wet = null;
let brownBuf = null;
let whiteBuf = null;
let post = null; // final soft-clip stage (bypasses the bass-heavy limiter)
let dread = null;
const files = {}; // cue -> AudioBuffer

// ───────────────────────── setup ─────────────────────────

function brownNoise(seconds = 6) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

function whiteNoise(seconds = 4) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

/** Long, dark hall: 7s tail, highs rolled off. */
function darkImpulse(seconds = 7) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += 0.08 * (Math.random() * 2 - 1 - lp); // pre-darkened noise
      d[i] = lp * 4 * (1 - i / len) ** 3;
    }
  }
  return ir;
}

async function loadCustomFiles() {
  try {
    const list = await (await fetch('/api/sfx')).json();
    await Promise.all(
      Object.entries(list).map(async ([cue, url]) => {
        if (!CUES.includes(cue)) return;
        const data = await (await fetch(url)).arrayBuffer();
        files[cue] = await ctx.decodeAudioData(data);
      }),
    );
  } catch {
    /* no custom files: generated sounds are used */
  }
}

export function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!ctx) {
    ctx = new AC();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    // gentle tanh soft-clip as a last safety stage, so nothing ever distorts harshly
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 1.2) / Math.tanh(1.2);
    clip.curve = curve;
    limiter.connect(clip).connect(ctx.destination);
    post = clip;

    dry = ctx.createGain();
    dry.gain.value = 0.42;
    dry.connect(limiter);

    const conv = ctx.createConvolver();
    conv.buffer = darkImpulse();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1100;
    wet = ctx.createGain();
    wet.gain.value = 0.5;
    wet.connect(conv).connect(tone).connect(limiter);

    brownBuf = brownNoise();
    whiteBuf = whiteNoise();
    loadCustomFiles();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

const ready = () => ctx && ctx.state === 'running';

function route(node, send = 0.6) {
  node.connect(dry);
  const g = ctx.createGain();
  g.gain.value = send;
  node.connect(g).connect(wet);
}

function playFile(cue, { loop = false, level = 1 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = files[cue];
  src.loop = loop;
  const g = ctx.createGain();
  g.gain.value = level;
  src.connect(g).connect(ctx.destination); // files play as-is (they're already mixed)
  src.start();
  return { src, g };
}

// ───────────────────────── building blocks ─────────────────────────

/** Low rumble: brown noise through a low-pass whose cutoff and level follow envelopes. */
function rumble({ at = 0, attack = 0.5, hold = 0, release = 1.5, level = 0.5, from = 120, to = 400, send = 0.7 }) {
  const t = ctx.currentTime + at;
  const end = t + attack + hold + release;
  const src = ctx.createBufferSource();
  src.buffer = brownBuf;
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.5;
  lp.frequency.setValueAtTime(from, t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(to, 30), t + attack);
  lp.frequency.exponentialRampToValueAtTime(Math.max(from * 0.5, 30), end);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(level, t + attack);
  g.gain.setValueAtTime(level, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  src.connect(lp).connect(g);
  route(g, send);
  src.start(t, Math.random() * 4);
  src.stop(end + 0.1);
}

/**
 * Burst of dead-channel TV static: hits hard, crackles and stutters, then gets
 * swallowed by a closing filter. Bright enough to cut through, dark enough to stay eerie.
 */
function staticBurst({ at = 0, duration = 1.6, level = 0.7 }) {
  const t = ctx.currentTime + at;
  const end = t + duration;
  const src = ctx.createBufferSource();
  src.buffer = whiteBuf;
  src.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 250;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.8;
  lp.frequency.setValueAtTime(7000, t);
  lp.frequency.exponentialRampToValueAtTime(2500, t + duration * 0.35);
  lp.frequency.exponentialRampToValueAtTime(350, end);

  // crackle: irregular level jumps (smoothed so they don't click), thinning out as it decays
  const crackle = ctx.createGain();
  crackle.gain.setValueAtTime(1, t);
  for (let x = 0.06; x < duration; x += 0.03 + Math.random() * 0.07) {
    const keep = 1 - x / duration;
    const v = Math.random() < 0.25 + keep * 0.6 ? 0.5 + Math.random() * 0.5 : 0.08;
    crackle.gain.setTargetAtTime(v, t + x, 0.008);
  }
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(level, t + 0.01);
  env.gain.setValueAtTime(level, t + 0.18);
  env.gain.exponentialRampToValueAtTime(0.0001, end);

  src.connect(hp).connect(lp).connect(crackle).connect(env);
  // own path so the sub-bass hit doesn't duck it; a little goes to the reverb for the tail
  env.connect(post);
  const send = ctx.createGain();
  send.gain.value = 0.35;
  env.connect(send).connect(wet);
  src.start(t, Math.random() * 3);
  src.stop(end + 0.1);
}

/** Sub-bass boom that sinks in pitch. */
function boom({ at = 0, level = 0.7, from = 55, to = 26, decay = 3.5 }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + decay * 0.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(level, t + 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g);
  // overtone an octave+fifth up so the hit is felt on small speakers too
  const o2 = ctx.createOscillator();
  o2.type = 'sine';
  o2.frequency.setValueAtTime(from * 3, t);
  o2.frequency.exponentialRampToValueAtTime(to * 3, t + decay * 0.6);
  const g2 = ctx.createGain();
  g2.gain.value = 0.7;
  o2.connect(g2).connect(g);
  route(g, 0.8);
  o.start(t);
  o2.start(t);
  o.stop(t + decay + 0.1);
  o2.stop(t + decay + 0.1);
}

/** Dissonant low cluster (minor second + tritone), slowly beating against itself. */
function cluster({ at = 0, attack = 2, hold = 1, release = 4, level = 0.25, root = 43.65 }) {
  const t = ctx.currentTime + at;
  const end = t + attack + hold + release;
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0.0001, t);
  bus.gain.exponentialRampToValueAtTime(level, t + attack);
  bus.gain.setValueAtTime(level, t + attack + hold);
  bus.gain.exponentialRampToValueAtTime(0.0001, end);
  route(bus, 0.9);
  const oscs = [2, 2.119, 2.828, 4.006, 1].map((r, i) => {
    const o = ctx.createOscillator();
    o.type = i === 3 ? 'triangle' : 'sine';
    o.frequency.value = root * r;
    const g = ctx.createGain();
    g.gain.value = [0.45, 0.45, 0.3, 0.12, 0.5][i];
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(end + 0.1);
    return o;
  });
  return oscs;
}

// ───────────────────────── cues ─────────────────────────

export function cue(name) {
  if (!ready()) return;
  if (files[name] && name !== 'dread') return void playFile(name);
  switch (name) {
    case 'start': // lobby → film: a slow, rising pressure that collapses into a sub boom
      rumble({ attack: 2.2, hold: 0, release: 0.25, level: 0.6, from: 60, to: 900, send: 0.5 });
      boom({ at: 2.3, level: 0.6, from: 62, to: 30, decay: 5 });
      cluster({ at: 2.3, attack: 0.1, hold: 0.5, release: 6, level: 0.18, root: 41.2 });
      break;
    case 'cut': // between scenes: a muffled breath of static
      rumble({ attack: 0.15, release: 1.2, level: 0.28, from: 90, to: 500, send: 0.8 });
      break;
    case 'freeze': // frame freezes: low hit
      boom({ level: 0.5, from: 66, to: 34, decay: 4 });
      rumble({ attack: 0.05, release: 2.5, level: 0.35, from: 200, to: 300, send: 0.9 });
      break;
    case 'resolve': // decision locks: silence, then a static-drenched impact
      staticBurst({ duration: 1.8, level: 0.5 });
      rumble({ attack: 0.02, release: 1.8, level: 0.8, from: 900, to: 1200, send: 0.7 });
      boom({ level: 0.9, from: 58, to: 28, decay: 5 });
      cluster({ attack: 0.05, hold: 0.3, release: 5, level: 0.2, root: 46.25 });
      break;
    case 'ending':
      cluster({ attack: 4, hold: 3, release: 6, level: 0.22, root: 36.7 });
      rumble({ attack: 4, hold: 2, release: 5, level: 0.3, from: 50, to: 220, send: 0.9 });
      break;
    case 'reset': // power fades away
      rumble({ attack: 0.05, release: 2.5, level: 0.45, from: 700, to: 700, send: 0.6 });
      boom({ at: 0.2, level: 0.4, from: 55, to: 27, decay: 3 });
      break;
    default:
  }
}

/**
 * Tension bed while the leader decides. It slowly grows over durationMs:
 * rumble opens up, drones get louder. stopDread() cuts it (abruptly = the "drop").
 */
export function startDread(durationMs = 15000) {
  if (!ready() || dread) return;
  if (files.dread) {
    const { src, g } = playFile('dread', { loop: true, level: 0.0001 });
    g.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 2);
    dread = { gains: [g], srcs: [src] };
    return;
  }
  const t = ctx.currentTime;
  const dur = durationMs / 1000;

  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0.0001, t);
  bus.gain.exponentialRampToValueAtTime(0.1, t + 2.5);
  bus.gain.linearRampToValueAtTime(0.24, t + dur); // pressure builds toward zero
  route(bus, 0.8);

  const noise = ctx.createBufferSource();
  noise.buffer = brownBuf;
  noise.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(110, t);
  lp.frequency.exponentialRampToValueAtTime(650, t + dur);
  const ng = ctx.createGain();
  ng.gain.value = 0.9;
  // slow breathing of the rumble
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.11;
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = 0.35;
  lfo.connect(lfoAmt).connect(ng.gain);
  noise.connect(lp).connect(ng).connect(bus);

  const drones = [41.2, 82.4, 87.3, 116.5, 123.5].map((f, i) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * 0.985, t + dur); // sags flat as time runs out
    const g = ctx.createGain();
    g.gain.value = [0.6, 0.4, 0.4, 0.22, 0.22][i];
    o.connect(g).connect(bus);
    return o;
  });

  noise.start(t, Math.random() * 4);
  lfo.start(t);
  drones.forEach((o) => o.start(t));
  dread = { gains: [bus], srcs: [noise, lfo, ...drones] };
}

export function stopDread(fade = 0.12) {
  if (!dread || !ctx) return;
  const { gains, srcs } = dread;
  dread = null;
  const t = ctx.currentTime;
  gains.forEach((g) => {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + fade);
  });
  srcs.forEach((s) => s.stop(t + fade + 0.05));
}
