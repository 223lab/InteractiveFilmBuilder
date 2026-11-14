import crypto from 'node:crypto';
import { STATES, EVENTS, CONFIG } from './config.js';
import { indexNodes, liveChoices, nextTarget, normalizeFreezeAt } from '../shared/storyGraph.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function makeCode(len = 4) {
  return Array.from(crypto.randomBytes(len), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
const makeToken = () => crypto.randomBytes(12).toString('hex');

/**
 * One host screen + up to CONFIG.maxPlayers phones. The server is authoritative for
 * phase, timers and vote tallies; the host only reports "clip finished".
 *
 * LOBBY_WAITING → TRANSITIONING → PLAYING_SCENE → AWAITING_VOTES → RESOLVING_CHOICE ─┐
 *                                      ▲   │                                         │
 *                                      │   └─(ending node / dead end)→ GAME_OVER     │
 *                                      └─────────────────────────────────────────────┘
 * GAME_OVER → (resetMs) → new room code, phones disconnected, LOBBY_WAITING
 */
export class GameRoom {
  constructor({ io, id, getStory, onSessionEnd, log = console.log, config = CONFIG }) {
    this.io = io;
    this.id = id;
    this.getStory = getStory;
    this.onSessionEnd = onSessionEnd || (() => {});
    this.log = log;
    this.config = config;
    this.hostKey = makeToken();
    this.hostSocketId = null;
    this.hostDropTimer = null;
    this.timers = new Set();
    this.players = new Map();
    this.resetSession();
  }

  get channel() {
    return `room:${this.id}`;
  }

  // ───────────────────────── internals ─────────────────────────

  resetSession() {
    this.clearTimers();
    for (const p of this.players.values()) clearTimeout(p.dropTimer);
    this.players = new Map(); // slot -> { slot, token, socketId, connected, dropTimer }
    this.phase = STATES.LOBBY_WAITING;
    this.phaseEndsAt = null;
    this.phaseDurationMs = null;
    this.story = null;
    this.nodes = null;
    this.node = null;
    this.continued = false;
    this.sceneSeq = 0;
    this.votes = new Map(); // slot -> choiceIndex
    this.resolution = null;
    this.ending = null;
    this.history = [];
    this.startedAt = null;
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  setPhase(phase, durationMs = null) {
    this.phase = phase;
    this.phaseDurationMs = durationMs;
    this.phaseEndsAt = durationMs ? Date.now() + durationMs : null;
    this.log(`[room ${this.id}] ${phase}${this.node ? ` · ${this.node.id}` : ''}`);
  }

  socketById(id) {
    return id ? this.io.sockets.sockets.get(id) : undefined;
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  lobbyPayload() {
    return { count: this.connectedPlayers().length, max: this.config.maxPlayers };
  }

  snapshot() {
    const voting = this.phase === STATES.AWAITING_VOTES || this.phase === STATES.RESOLVING_CHOICE;
    const choices = voting ? liveChoices(this.node) : [];
    // Host warms up whatever can come next so the following clip starts without a gap.
    const upcoming =
      this.phase === STATES.PLAYING_SCENE
        ? [nextTarget(this.node), ...liveChoices(this.node).map((c) => c.targetId)]
        : choices.map((c) => c.targetId);
    return {
      roomId: this.id,
      phase: this.phase,
      maxPlayers: this.config.maxPlayers,
      players: [...this.players.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((p) => ({ slot: p.slot, connected: p.connected, voted: this.votes.has(p.slot) })),
      sceneSeq: this.sceneSeq,
      node: this.node
        ? {
            id: this.node.id,
            title: this.node.title || '',
            videoUrl: this.node.videoUrl || '',
            freezeAt: normalizeFreezeAt(this.node.freezeAt),
            isEndingNode: !!this.node.isEndingNode,
            endingType: this.node.endingType ?? null,
          }
        : null,
      continued: this.continued, // true when this clip followed a continue link (no cut FX)
      choices: voting ? choices.map(({ index, label }) => ({ index, label })) : null,
      preloadUrls: [...new Set(upcoming.map((id) => id && this.nodes?.get(id)?.videoUrl).filter(Boolean))],
      // remainingMs (not an absolute timestamp) so client clock skew doesn't matter.
      timer: this.phaseEndsAt
        ? { durationMs: this.phaseDurationMs, remainingMs: Math.max(0, this.phaseEndsAt - Date.now()) }
        : null,
      votes: { count: this.votes.size, total: this.connectedPlayers().length },
      resolution: this.resolution,
      ending: this.ending,
    };
  }

  /** Emit an optional one-shot event (for FX), then the full snapshot (for rendering). */
  broadcast(event, payload) {
    if (event) this.io.to(this.channel).emit(event, payload ?? {});
    this.io.to(this.channel).emit(EVENTS.ROOM_STATE, this.snapshot());
  }

  // ───────────────────────── host ─────────────────────────

  attachHost(socket) {
    if (this.hostSocketId && this.hostSocketId !== socket.id) {
      const old = this.socketById(this.hostSocketId);
      if (old) {
        old.emit(EVENTS.REPLACED);
        old.leave(this.channel);
        old.data = {};
      }
    }
    clearTimeout(this.hostDropTimer);
    this.hostDropTimer = null;
    this.hostSocketId = socket.id;
    socket.data = { role: 'host', roomId: this.id };
    socket.join(this.channel);
    socket.emit(EVENTS.ROOM_STATE, this.snapshot());
  }

  detachHost(socket, onExpire) {
    if (this.hostSocketId !== socket.id) return;
    this.hostSocketId = null;
    this.hostDropTimer = setTimeout(onExpire, this.config.hostGraceMs);
  }

  // ───────────────────────── players ─────────────────────────

  joinPlayer(socket, { token } = {}) {
    if (token) {
      for (const p of this.players.values()) if (p.token === token) return this.bindPlayer(socket, p, true);
    }
    if (this.phase !== STATES.LOBBY_WAITING) return { ok: false, reason: 'IN_PROGRESS' };
    let slot = null;
    for (let s = 1; s <= this.config.maxPlayers; s++) {
      if (!this.players.has(s)) {
        slot = s;
        break;
      }
    }
    if (!slot) return { ok: false, reason: 'FULL' };
    const player = { slot, token: makeToken(), socketId: null, connected: false, dropTimer: null };
    this.players.set(slot, player);
    return this.bindPlayer(socket, player, false);
  }

  bindPlayer(socket, player, rejoin) {
    clearTimeout(player.dropTimer);
    player.dropTimer = null;
    if (player.socketId && player.socketId !== socket.id) {
      const old = this.socketById(player.socketId);
      if (old) {
        old.emit(EVENTS.REPLACED);
        old.leave(this.channel);
        old.data = {};
      }
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.data = { role: 'player', roomId: this.id, slot: player.slot };
    socket.join(this.channel);
    this.log(`[room ${this.id}] player ${player.slot} ${rejoin ? 'rejoined' : 'joined'}`);
    this.broadcast(EVENTS.LOBBY_UPDATE, this.lobbyPayload());
    // Defer so the joining phone gets its ack (slot number) before the transition fires.
    setImmediate(() => this.maybeAutoStart());
    return { ok: true, slot: player.slot, token: player.token, rejoin };
  }

  dropPlayer(socket) {
    const player = this.players.get(socket.data?.slot);
    if (!player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    this.log(`[room ${this.id}] player ${player.slot} disconnected`);
    if (this.phase === STATES.LOBBY_WAITING) {
      // Phones drop when the screen locks; hold the slot briefly so they can come back.
      player.dropTimer = setTimeout(() => {
        if (!player.connected && this.players.get(player.slot) === player && this.phase === STATES.LOBBY_WAITING) {
          this.players.delete(player.slot);
          this.broadcast(EVENTS.LOBBY_UPDATE, this.lobbyPayload());
        }
      }, this.config.lobbyGraceMs);
    }
    this.broadcast(EVENTS.LOBBY_UPDATE, this.lobbyPayload());
    if (this.phase === STATES.AWAITING_VOTES) this.checkAllVoted();
  }

  // ───────────────────────── game flow ─────────────────────────

  maybeAutoStart() {
    if (this.phase === STATES.LOBBY_WAITING && this.connectedPlayers().length >= this.config.maxPlayers) {
      this.startGame('AUTO');
    }
  }

  startGame(reason = 'AUTO') {
    if (this.phase !== STATES.LOBBY_WAITING) return { ok: false, reason: 'NOT_IN_LOBBY' };
    const story = this.getStory();
    const nodes = indexNodes(story);
    const start = nodes.get(story?.startNodeId);
    if (!start) {
      this.io.to(this.channel).emit(EVENTS.ROOM_ERROR, { message: 'Story has no valid start node' });
      return { ok: false, reason: 'NO_STORY' };
    }
    this.story = story; // snapshot: edits saved mid-game apply next session
    this.nodes = nodes;
    this.history = [];
    this.startedAt = Date.now();
    this.setPhase(STATES.TRANSITIONING, this.config.transitionMs);
    this.broadcast(EVENTS.GAME_START, { reason, durationMs: this.config.transitionMs });
    this.later(this.config.transitionMs, () => this.playNode(start.id));
    return { ok: true };
  }

  playNode(id, { continued = false } = {}) {
    const node = this.nodes.get(id);
    if (!node) {
      this.log(`[room ${this.id}] missing node "${id}" - ending run`);
      return this.finish(null);
    }
    this.clearTimers();
    this.node = node;
    this.continued = continued;
    this.sceneSeq += 1;
    this.votes.clear();
    this.resolution = null;
    this.setPhase(STATES.PLAYING_SCENE);
    this.broadcast(EVENTS.SCENE_PLAY, { sceneSeq: this.sceneSeq, nodeId: node.id, continued });
  }

  /** Host says the clip ended (or hit freezeAt). Stale reports are ignored via sceneSeq. */
  sceneEnded(sceneSeq) {
    if (this.phase !== STATES.PLAYING_SCENE || sceneSeq !== this.sceneSeq) return;
    const node = this.node;
    if (node.isEndingNode) return this.finish(node);
    const next = nextTarget(node);
    if (next) return this.playNode(next, { continued: true });
    const choices = liveChoices(node);
    if (choices.length === 0) return this.finish(node);
    if (choices.length === 1) {
      this.history.push({ nodeId: node.id, nodeTitle: node.title, choiceLabel: choices[0].label, auto: true });
      return this.playNode(choices[0].targetId, { continued: true });
    }
    this.freeze();
  }

  freeze() {
    this.votes.clear();
    this.setPhase(STATES.AWAITING_VOTES, this.config.voteMs);
    this.broadcast(EVENTS.SCENE_FREEZE, { sceneSeq: this.sceneSeq, durationMs: this.config.voteMs });
    this.later(this.config.voteMs, () => this.resolve('TIMEOUT'));
  }

  submitVote(slot, choiceIndex) {
    if (this.phase !== STATES.AWAITING_VOTES) return { ok: false, reason: 'NOT_VOTING' };
    if (!this.players.has(slot)) return { ok: false, reason: 'NOT_A_PLAYER' };
    if (this.votes.has(slot)) return { ok: false, reason: 'ALREADY_VOTED', choiceIndex: this.votes.get(slot) };
    if (!liveChoices(this.node).some((c) => c.index === choiceIndex)) return { ok: false, reason: 'INVALID_CHOICE' };
    this.votes.set(slot, choiceIndex);
    this.broadcast(EVENTS.VOTE_PROGRESS, { count: this.votes.size, total: this.connectedPlayers().length });
    setImmediate(() => this.checkAllVoted()); // ack the vote first, then resolve
    return { ok: true, choiceIndex };
  }

  checkAllVoted() {
    const connected = this.connectedPlayers();
    if (this.phase === STATES.AWAITING_VOTES && connected.length > 0 && connected.every((p) => this.votes.has(p.slot))) {
      this.resolve('ALL_VOTED');
    }
  }

  resolve(reason) {
    if (this.phase !== STATES.AWAITING_VOTES) return;
    this.clearTimers();
    const choices = liveChoices(this.node);
    const tally = [0, 0];
    for (const v of this.votes.values()) tally[v] += 1;
    const best = Math.max(...choices.map((c) => tally[c.index]));
    const leaders = choices.filter((c) => tally[c.index] === best);
    const winner = leaders[crypto.randomInt(leaders.length)]; // tie or zero votes -> random
    this.resolution = {
      winnerIndex: winner.index,
      winnerLabel: winner.label,
      tally,
      tieBreak: leaders.length > 1,
      noVotes: this.votes.size === 0,
      reason,
    };
    this.history.push({
      nodeId: this.node.id,
      nodeTitle: this.node.title,
      labels: [this.node.choiceALabel || 'OPTION A', this.node.choiceBLabel || 'OPTION B'],
      choiceLabel: winner.label,
      winnerIndex: winner.index,
      tally: [...tally],
      tieBreak: leaders.length > 1,
      noVotes: this.votes.size === 0,
    });
    this.setPhase(STATES.RESOLVING_CHOICE, this.config.resolveMs);
    this.broadcast(EVENTS.VOTE_RESOLVE, this.resolution);
    this.later(this.config.resolveMs, () => this.playNode(winner.targetId));
  }

  finish(node) {
    this.clearTimers();
    const decisions = this.history.filter((h) => !h.auto);
    const votesCast = decisions.reduce((s, h) => s + h.tally[0] + h.tally[1], 0);
    this.ending = {
      type: node?.endingType ?? null,
      name: String(node?.endingName || '').trim() || null,
      title: node?.title || 'SIGNAL LOST',
      stats: {
        durationMs: Date.now() - (this.startedAt || Date.now()),
        scenes: this.sceneSeq,
        decisions,
        votesCast,
        unanimous: decisions.filter((h) => {
          const total = h.tally[0] + h.tally[1];
          return total > 0 && (h.tally[0] === total || h.tally[1] === total);
        }).length,
        tieBreaks: decisions.filter((h) => h.tieBreak).length,
      },
    };
    this.setPhase(STATES.GAME_OVER, this.config.resetMs);
    this.broadcast(EVENTS.GAME_OVER, this.ending);
    this.later(this.config.resetMs, () => this.onSessionEnd('CYCLE'));
  }

  /**
   * Ends the session: tells everyone, disconnects the phones, and re-opens the lobby
   * under a fresh room code (so the old QR / stale phones can't slip into the next run).
   */
  reset(reason, newId) {
    this.io.to(this.channel).emit(EVENTS.GAME_RESET, { reason });
    for (const p of this.players.values()) {
      const s = this.socketById(p.socketId);
      if (!s) continue;
      s.leave(this.channel);
      s.data = {};
      setTimeout(() => s.disconnect(true), 400); // let game:reset flush first
    }
    const host = this.socketById(this.hostSocketId);
    host?.leave(this.channel);
    this.id = newId;
    this.resetSession();
    if (host) {
      host.data = { role: 'host', roomId: this.id };
      host.join(this.channel);
    }
    this.log(`[room ${this.id}] lobby reopened (${reason})`);
    this.broadcast(EVENTS.LOBBY_UPDATE, this.lobbyPayload());
  }

  /** Host is gone for good. */
  close() {
    this.io.to(this.channel).emit(EVENTS.ROOM_CLOSED, {});
    for (const p of this.players.values()) {
      const s = this.socketById(p.socketId);
      if (s) {
        s.data = {};
        setTimeout(() => s.disconnect(true), 400);
      }
    }
    clearTimeout(this.hostDropTimer);
    this.resetSession();
  }
}
