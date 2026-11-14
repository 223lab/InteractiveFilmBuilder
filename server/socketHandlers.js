import { CONFIG, EVENTS } from './config.js';
import { GameRoom, makeCode } from './GameRoom.js';

export function registerSocketHandlers(io, storyStore, { config = CONFIG, log = console.log } = {}) {
  const rooms = new Map(); // roomId -> GameRoom

  const newCode = () => {
    let code;
    do code = makeCode(); while (rooms.has(code));
    return code;
  };

  const rotate = (room, reason) => {
    if (rooms.get(room.id) !== room) return;
    rooms.delete(room.id);
    const id = newCode();
    rooms.set(id, room);
    room.reset(reason, id);
  };

  const createRoom = () => {
    const room = new GameRoom({
      io,
      id: newCode(),
      config,
      log,
      getStory: () => storyStore.get(),
      onSessionEnd: (reason) => rotate(room, reason),
    });
    rooms.set(room.id, room);
    log(`[room ${room.id}] created`);
    return room;
  };

  const ack = (cb, value) => {
    if (typeof cb === 'function') cb(value);
  };

  io.on('connection', (socket) => {
    socket.data = {};
    const currentRoom = () => rooms.get(socket.data?.roomId);
    const asHost = () => (socket.data?.role === 'host' ? currentRoom() : null);
    const asPlayer = () => (socket.data?.role === 'player' ? currentRoom() : null);

    socket.on(EVENTS.HOST_CREATE, (payload, cb) => {
      const { hostKey } = payload || {};
      let room = hostKey ? [...rooms.values()].find((r) => r.hostKey === hostKey) : null;
      if (!room) room = createRoom();
      room.attachHost(socket);
      ack(cb, { ok: true, roomId: room.id, hostKey: room.hostKey, allowForceStart: config.allowForceStart });
    });

    socket.on(EVENTS.PLAYER_JOIN, (payload, cb) => {
      const { roomId, token } = payload || {};
      if (socket.data?.role === 'host') return ack(cb, { ok: false, reason: 'IS_HOST' });
      const room = rooms.get(String(roomId || '').trim().toUpperCase());
      if (!room) return ack(cb, { ok: false, reason: 'NO_ROOM' });
      ack(cb, room.joinPlayer(socket, { token }));
    });

    socket.on(EVENTS.GAME_START, (_payload, cb) => {
      const room = asHost();
      if (!room) return ack(cb, { ok: false, reason: 'NOT_HOST' });
      if (!config.allowForceStart) return ack(cb, { ok: false, reason: 'DISABLED' });
      ack(cb, room.startGame('FORCED'));
    });

    socket.on(EVENTS.SCENE_ENDED, (payload) => {
      asHost()?.sceneEnded(Number(payload?.sceneSeq));
    });

    socket.on(EVENTS.VOTE_SUBMIT, (payload, cb) => {
      const room = asPlayer();
      if (!room) return ack(cb, { ok: false, reason: 'NOT_IN_ROOM' });
      ack(cb, room.submitVote(socket.data.slot, Number(payload?.choiceIndex)));
    });

    socket.on(EVENTS.GAME_RESET, (_payload, cb) => {
      const room = asHost();
      if (!room) return ack(cb, { ok: false, reason: 'NOT_HOST' });
      rotate(room, 'MANUAL');
      ack(cb, { ok: true, roomId: room.id });
    });

    socket.on('disconnect', () => {
      const room = currentRoom();
      if (!room) return;
      if (socket.data.role === 'host') {
        room.detachHost(socket, () => {
          log(`[room ${room.id}] host gone, closing`);
          room.close();
          rooms.delete(room.id);
        });
      } else if (socket.data.role === 'player') {
        room.dropPlayer(socket);
      }
    });
  });

  return { rooms };
}
