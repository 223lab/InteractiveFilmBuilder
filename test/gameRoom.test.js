// State machine tests with an in-memory fake of the Socket.io server API.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GameRoom } from '../server/GameRoom.js';
import { STATES } from '../shared/states.js';
import { validateStory } from '../shared/storyGraph.js';

const story = JSON.parse(fs.readFileSync(new URL('../story/story-graph.json', import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

const CFG = {
  maxPlayers: 5,
  transitionMs: 20,
  voteMs: 80,
  resolveMs: 20,
  resetMs: 30,
  lobbyGraceMs: 40,
  hostGraceMs: 50,
  allowForceStart: true,
};

class FakeIO {
  constructor() {
    this.sockets = { sockets: new Map() };
    this.n = 0;
  }
  socket() {
    const io = this;
    const s = {
      id: `s${++this.n}`,
      rooms: new Set(),
      data: {},
      got: [],
      connected: true,
      join(r) { this.rooms.add(r); },
      leave(r) { this.rooms.delete(r); },
      emit(e, p) { this.got.push([e, p]); },
      disconnect() { this.connected = false; io.sockets.sockets.delete(this.id); },
      events(name) { return this.got.filter(([e]) => e === name).map(([, p]) => p); },
    };
    this.sockets.sockets.set(s.id, s);
    return s;
  }
  to(ch) {
    return { emit: (e, p) => { for (const s of this.sockets.sockets.values()) if (s.rooms.has(ch)) s.emit(e, p); } };
  }
}

function setup(overrides = {}) {
  const io = new FakeIO();
  const ended = [];
  const room = new GameRoom({
    io,
    id: 'TEST',
    config: { ...CFG, ...overrides },
    log: () => {},
    getStory: () => story,
    onSessionEnd: (r) => ended.push(r),
  });
  const host = io.socket();
  room.attachHost(host);
  return { io, room, host, ended };
}

function joinN(io, room, n) {
  return Array.from({ length: n }, () => {
    const s = io.socket();
    const res = room.joinPlayer(s, {});
    return { s, res };
  });
}

test('mock story graph is valid', () => {
  const { errors } = validateStory(story);
  assert.deepEqual(errors, []);
});

test('auto-starts on 5th player, rejects 6th, assigns slots 1..5', async () => {
  const { io, room, host } = setup();
  const players = joinN(io, room, 5);
  assert.deepEqual(players.map((p) => p.res.slot), [1, 2, 3, 4, 5]);
  await tick();
  assert.equal(room.phase, STATES.TRANSITIONING);
  assert.equal(host.events('game:start').length, 1);
  const sixth = room.joinPlayer(io.socket(), {});
  assert.deepEqual(sixth, { ok: false, reason: 'IN_PROGRESS' });
  await sleep(30);
  assert.equal(room.phase, STATES.PLAYING_SCENE);
  assert.equal(room.node.id, 'intro');
});

test('lobby is FULL at 5 even before start fires', () => {
  const { io, room } = setup({ maxPlayers: 2 });
  joinN(io, room, 2);
  assert.deepEqual(room.joinPlayer(io.socket(), {}), { ok: false, reason: 'FULL' });
});

test('majority wins once everyone has voted; next scene plays', async () => {
  const { io, room, host } = setup();
  const players = joinN(io, room, 5);
  await sleep(30);
  room.sceneEnded(999); // stale report ignored
  assert.equal(room.phase, STATES.PLAYING_SCENE);
  room.sceneEnded(room.sceneSeq);
  assert.equal(room.phase, STATES.AWAITING_VOTES);
  const snap = host.events('room:state').at(-1);
  assert.deepEqual(snap.choices.map((c) => c.label), ['ENTER THE ROOM', 'RUN AWAY']);
  assert.equal(snap.preloadUrls.length, 2);

  [0, 0, 1, 0, 1].forEach((choice, i) => {
    assert.equal(room.submitVote(players[i].res.slot, choice).ok, true);
  });
  await tick();
  assert.equal(room.phase, STATES.RESOLVING_CHOICE);
  assert.equal(room.resolution.winnerIndex, 0);
  assert.deepEqual(room.resolution.tally, [3, 2]);
  assert.equal(room.resolution.tieBreak, false);
  await sleep(30);
  assert.equal(room.phase, STATES.PLAYING_SCENE);
  assert.equal(room.node.id, 'room');
});

test('double votes and invalid choices are rejected', async () => {
  const { io, room } = setup();
  const players = joinN(io, room, 5);
  await sleep(30);
  room.sceneEnded(room.sceneSeq);
  const slot = players[0].res.slot;
  assert.equal(room.submitVote(slot, 5).reason, 'INVALID_CHOICE');
  assert.equal(room.submitVote(slot, 1).ok, true);
  assert.equal(room.submitVote(slot, 0).reason, 'ALREADY_VOTED');
});

test('timeout with no votes picks randomly and flags it', async () => {
  const { io, room } = setup();
  joinN(io, room, 5);
  await sleep(30);
  room.sceneEnded(room.sceneSeq);
  await sleep(100);
  assert.equal(room.phase, STATES.RESOLVING_CHOICE);
  assert.equal(room.resolution.noVotes, true);
  assert.equal(room.resolution.tieBreak, true);
  assert.equal(room.resolution.reason, 'TIMEOUT');
  assert.ok([0, 1].includes(room.resolution.winnerIndex));
});

test('tie is broken randomly (both outcomes reachable)', async () => {
  const seen = new Set();
  for (let i = 0; i < 30 && seen.size < 2; i++) {
    const { io, room } = setup();
    const players = joinN(io, room, 2);
    room.startGame('FORCED');
    await sleep(25);
    room.sceneEnded(room.sceneSeq);
    room.submitVote(players[0].res.slot, 0);
    room.submitVote(players[1].res.slot, 1);
    await tick();
    assert.equal(room.resolution.tieBreak, true);
    seen.add(room.resolution.winnerIndex);
    room.clearTimers();
  }
  assert.equal(seen.size, 2);
});

test('a player dropping mid-vote does not stall the vote', async () => {
  const { io, room } = setup();
  const players = joinN(io, room, 5);
  await sleep(30);
  room.sceneEnded(room.sceneSeq);
  for (let i = 0; i < 4; i++) room.submitVote(players[i].res.slot, 1);
  await tick();
  assert.equal(room.phase, STATES.AWAITING_VOTES);
  room.dropPlayer(players[4].s);
  assert.equal(room.phase, STATES.RESOLVING_CHOICE);
  assert.equal(room.resolution.winnerIndex, 1);
});

test('phone can rejoin mid-game with its token and keeps its slot', async () => {
  const { io, room } = setup();
  const players = joinN(io, room, 5);
  await sleep(30);
  const { s, res } = players[2];
  room.dropPlayer(s);
  const again = room.joinPlayer(io.socket(), { token: res.token });
  assert.equal(again.ok, true);
  assert.equal(again.slot, res.slot);
  assert.equal(again.rejoin, true);
});

test('lobby slot is freed after grace period', async () => {
  const { io, room } = setup();
  const [p] = joinN(io, room, 1);
  room.dropPlayer(p.s);
  assert.equal(room.players.size, 1);
  await sleep(60);
  assert.equal(room.players.size, 0);
});

test('reaching an ending -> GAME_OVER with stats -> session end callback', async () => {
  const { io, room, host, ended } = setup();
  const players = joinN(io, room, 5);
  await sleep(30);
  // intro -> A (room)
  room.sceneEnded(room.sceneSeq);
  players.forEach((p) => room.submitVote(p.res.slot, 0));
  await sleep(30);
  assert.equal(room.node.id, 'room');
  // room -> A (end_unplug, GOOD)
  room.sceneEnded(room.sceneSeq);
  players.forEach((p, i) => room.submitVote(p.res.slot, i < 4 ? 0 : 1));
  await sleep(30);
  assert.equal(room.node.id, 'end_unplug');
  room.sceneEnded(room.sceneSeq);
  assert.equal(room.phase, STATES.GAME_OVER);
  const over = host.events('game:over').at(-1);
  assert.equal(over.type, 'GOOD');
  assert.equal(over.stats.decisions.length, 2);
  assert.equal(over.stats.votesCast, 10);
  assert.equal(over.stats.unanimous, 1);
  await sleep(40);
  assert.deepEqual(ended, ['CYCLE']);
});

test('reset re-opens lobby under a new code and disconnects phones', async () => {
  const { io, room, host } = setup();
  const players = joinN(io, room, 5);
  await sleep(30);
  room.reset('MANUAL', 'NEW1');
  assert.equal(room.id, 'NEW1');
  assert.equal(room.phase, STATES.LOBBY_WAITING);
  assert.equal(room.players.size, 0);
  assert.ok(players.every((p) => p.s.events('game:reset').length === 1));
  assert.ok(host.rooms.has('room:NEW1'));
  await sleep(450);
  assert.ok(players.every((p) => !p.s.connected));
  assert.equal(host.events('room:state').at(-1).roomId, 'NEW1');
});

test('single-leader mode: 1 player starts the film and decides alone', async () => {
  const { io, room } = setup({ maxPlayers: 1 });
  const [leader] = joinN(io, room, 1);
  assert.equal(leader.res.slot, 1);
  assert.deepEqual(room.joinPlayer(io.socket(), {}), { ok: false, reason: 'FULL' });
  await tick();
  assert.equal(room.phase, STATES.TRANSITIONING);
  await sleep(30);
  room.sceneEnded(room.sceneSeq);
  room.submitVote(1, 1);
  await tick();
  assert.equal(room.phase, STATES.RESOLVING_CHOICE);
  assert.equal(room.resolution.winnerIndex, 1);
  assert.equal(room.resolution.tieBreak, false);
});

test('continue links play the next clip without a vote', async () => {
  const s = {
    startNodeId: 'a',
    nodes: [
      { id: 'a', title: 'A', videoUrl: '/a.mp4', next: 'b', choices: [] },
      { id: 'b', title: 'B', videoUrl: '/b.mp4', choices: ['end', null], choiceALabel: 'GO' },
      { id: 'end', title: 'Fin', videoUrl: '/e.mp4', isEndingNode: true, endingType: 'GOOD', endingName: 'THE QUIET' },
    ],
  };
  assert.deepEqual(validateStory(s).errors, []);
  const io = new FakeIO();
  const room = new GameRoom({ io, id: 'T', config: CFG, log: () => {}, getStory: () => s, onSessionEnd: () => {} });
  room.attachHost(io.socket());
  room.joinPlayer(io.socket(), {});
  room.startGame('FORCED');
  await sleep(30);
  assert.equal(room.node.id, 'a');
  assert.deepEqual(room.snapshot().preloadUrls, ['/b.mp4']);
  room.sceneEnded(room.sceneSeq);
  assert.equal(room.phase, STATES.PLAYING_SCENE);
  assert.equal(room.node.id, 'b');
  assert.equal(room.snapshot().continued, true);
  room.sceneEnded(room.sceneSeq); // single choice also auto-advances
  assert.equal(room.node.id, 'end');
  room.sceneEnded(room.sceneSeq);
  assert.equal(room.phase, STATES.GAME_OVER);
  assert.equal(room.ending.name, 'THE QUIET');
  assert.equal(room.ending.stats.decisions.length, 0);
  room.clearTimers();
});

test('validator catches broken continue links', () => {
  const bad = { startNodeId: 'a', nodes: [{ id: 'a', next: 'nope' }, { id: 'e', isEndingNode: true, endingType: 'BAD' }] };
  assert.ok(validateStory(bad).errors.some((e) => e.includes('continues to missing node')));
});
