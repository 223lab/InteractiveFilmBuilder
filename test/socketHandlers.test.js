// Event-wiring tests: registerSocketHandlers against a fake Socket.io server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerSocketHandlers } from '../server/socketHandlers.js';

const story = JSON.parse(fs.readFileSync(new URL('../story/story-graph.json', import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = { maxPlayers: 5, transitionMs: 10, voteMs: 60, resolveMs: 10, resetMs: 20, lobbyGraceMs: 50, hostGraceMs: 30, allowForceStart: true };

function fakeServer() {
  const io = {
    sockets: { sockets: new Map() },
    handlers: {},
    on(e, fn) { this.handlers[e] = fn; },
    to(ch) { return { emit: (e, p) => { for (const s of io.sockets.sockets.values()) if (s.rooms.has(ch)) s.emit(e, p); } }; },
  };
  let n = 0;
  io.connect = () => {
    const s = {
      id: `c${++n}`, rooms: new Set(), data: {}, got: [], listeners: {}, connected: true,
      on(e, fn) { this.listeners[e] = fn; },
      emit(e, p) { this.got.push([e, p]); },
      join(r) { this.rooms.add(r); },
      leave(r) { this.rooms.delete(r); },
      disconnect() { if (!this.connected) return; this.connected = false; io.sockets.sockets.delete(this.id); this.listeners.disconnect?.('server'); },
      send(e, p) { return new Promise((res) => this.listeners[e](p, res)); },
      last(e) { return this.got.filter(([x]) => x === e).at(-1)?.[1]; },
    };
    io.sockets.sockets.set(s.id, s);
    io.handlers.connection(s);
    return s;
  };
  const reg = registerSocketHandlers(io, { get: () => story }, { config: CFG, log: () => {} });
  return { io, ...reg };
}

test('host creates room, players join by code, 5th triggers start', async () => {
  const { io } = fakeServer();
  const host = io.connect();
  const { roomId, hostKey } = await host.send('host:create', {});
  assert.match(roomId, /^[A-Z2-9]{4}$/);
  assert.ok(hostKey);
  assert.equal((await io.connect().send('player:join', { roomId: 'ZZZZ' })).reason, 'NO_ROOM');
  for (let i = 0; i < 5; i++) assert.equal((await io.connect().send('player:join', { roomId: roomId.toLowerCase() })).ok, true);
  await sleep(5);
  assert.equal(host.last('room:state').phase, 'TRANSITIONING');
});

test('host refresh resumes the same room via hostKey', async () => {
  const { io, rooms } = fakeServer();
  const h1 = io.connect();
  const a = await h1.send('host:create', {});
  h1.disconnect();
  const h2 = io.connect();
  const b = await h2.send('host:create', { hostKey: a.hostKey });
  assert.equal(b.roomId, a.roomId);
  await sleep(40); // past hostGraceMs: room must still exist since host came back
  assert.ok(rooms.has(a.roomId));
});

test('room closes when host never returns', async () => {
  const { io, rooms } = fakeServer();
  const h = io.connect();
  const { roomId } = await h.send('host:create', {});
  const p = io.connect();
  await p.send('player:join', { roomId });
  h.disconnect();
  await sleep(40);
  assert.equal(rooms.has(roomId), false);
  assert.ok(p.last('room:closed'));
});

test('only the host can force start / reset; players vote via socket', async () => {
  const { io } = fakeServer();
  const host = io.connect();
  const { roomId } = await host.send('host:create', {});
  const p = io.connect();
  await p.send('player:join', { roomId });
  assert.equal((await p.send('game:start', {})).reason, 'NOT_HOST');
  assert.equal((await host.send('game:start', {})).ok, true);
  await sleep(20);
  const { sceneSeq } = host.last('room:state');
  host.listeners['scene:ended']({ sceneSeq });
  assert.equal(host.last('room:state').phase, 'AWAITING_VOTES');
  assert.equal((await p.send('vote:submit', { choiceIndex: 1 })).ok, true);
  await sleep(2);
  assert.equal(host.last('room:state').phase, 'RESOLVING_CHOICE');
  const reset = await host.send('game:reset', {});
  assert.notEqual(reset.roomId, roomId);
  assert.equal(host.last('room:state').roomId, reset.roomId);
  assert.ok(p.last('game:reset'));
});
