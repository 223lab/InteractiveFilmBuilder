// Shared between server and client so both sides agree on phase names.
export const STATES = Object.freeze({
  LOBBY_WAITING: 'LOBBY_WAITING',
  TRANSITIONING: 'TRANSITIONING',
  PLAYING_SCENE: 'PLAYING_SCENE',
  AWAITING_VOTES: 'AWAITING_VOTES',
  RESOLVING_CHOICE: 'RESOLVING_CHOICE',
  GAME_OVER: 'GAME_OVER',
});

/*
 * Socket events
 *
 * client -> server
 *   host:create   { hostKey? }              host opens / resumes a room       ack { ok, roomId, hostKey }
 *   player:join   { roomId, token? }        phone joins (token = rejoin)      ack { ok, slot, token } | { ok:false, reason }
 *   game:start    {}                        host force-start (dev / testing)  ack { ok }
 *   scene:ended   { sceneSeq }              host: clip finished / freezeAt hit
 *   vote:submit   { choiceIndex }           phone vote (0 = A/left, 1 = B/right) ack { ok, choiceIndex } | { ok:false, reason }
 *   game:reset    {}                        host: abort session, back to lobby
 *
 * server -> clients (room channel)
 *   room:state     full snapshot, sent after every change (render from this)
 *   lobby:update   { count, max }
 *   game:start     { reason, durationMs }   glitch boot transition begins
 *   scene:play     { sceneSeq, nodeId }
 *   scene:freeze   { sceneSeq, durationMs } voting unlocked
 *   vote:progress  { count, total }
 *   vote:resolve   { winnerIndex, winnerLabel, tally, tieBreak, noVotes, reason }
 *   game:over      { type, title, stats }
 *   game:reset     { reason }               phones are disconnected right after
 *   room:closed    {}                       host went away for good
 */
export const EVENTS = Object.freeze({
  HOST_CREATE: 'host:create',
  PLAYER_JOIN: 'player:join',
  GAME_START: 'game:start',
  SCENE_ENDED: 'scene:ended',
  VOTE_SUBMIT: 'vote:submit',
  GAME_RESET: 'game:reset',
  ROOM_STATE: 'room:state',
  LOBBY_UPDATE: 'lobby:update',
  SCENE_PLAY: 'scene:play',
  SCENE_FREEZE: 'scene:freeze',
  VOTE_PROGRESS: 'vote:progress',
  VOTE_RESOLVE: 'vote:resolve',
  GAME_OVER: 'game:over',
  ROOM_CLOSED: 'room:closed',
  ROOM_ERROR: 'room:error',
  REPLACED: 'session:replaced',
});
