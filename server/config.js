export { STATES, EVENTS } from '../shared/states.js';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// All timings in ms. Override with env vars, e.g. VOTE_MS=5000 npm run dev
export const CONFIG = Object.freeze({
  port: num(process.env.PORT, 3001),
  maxPlayers: num(process.env.MAX_PLAYERS, 1), // single leader decides
  transitionMs: num(process.env.TRANSITION_MS, 2800), // lobby -> film glitch boot
  voteMs: num(process.env.VOTE_MS, 15000), // choice countdown
  resolveMs: num(process.env.RESOLVE_MS, 1800), // winner glitch hold (1.5–2s)
  resetMs: num(process.env.RESET_MS, 10000), // ending screen -> new lobby
  lobbyGraceMs: num(process.env.LOBBY_GRACE_MS, 15000), // phone dropped in lobby keeps its slot this long
  hostGraceMs: num(process.env.HOST_GRACE_MS, 30000), // host refresh window before the room is closed
  allowForceStart: process.env.ALLOW_FORCE_START !== 'false', // host can start with < 5 players (?debug=1)
  publicUrl: process.env.PUBLIC_URL || null, // e.g. https://cinema.example.com (overrides LAN IP in the QR)
});
