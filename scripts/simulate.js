// Bot players for testing without five phones.
//
//   npm run simulate                 headless host + 5 bots play a full run, then exit
//   npm run simulate -- ABCD 4       4 bots join the real host screen showing room ABCD
//                                    (join with your own phone as the 5th player)
//
// Env: SERVER=http://localhost:3001
import { io } from 'socket.io-client';

const SERVER = process.env.SERVER || 'http://localhost:3001';
const [roomArg, countArg] = process.argv.slice(2);
const COUNT = Number(countArg || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(SERVER, { transports: ['websocket'], forceNew: true });

async function getRoomFromHeadlessHost() {
  const host = connect();
  let seq = 0;
  host.on('room:state', (s) => {
    if (s.phase === 'PLAYING_SCENE' && s.sceneSeq !== seq) {
      seq = s.sceneSeq;
      console.log(`[host] ▶ ${s.node.id} "${s.node.title}"`);
      // pretend the clip lasts 1.2s
      setTimeout(() => host.emit('scene:ended', { sceneSeq: s.sceneSeq }), 1200);
    }
  });
  host.on('vote:resolve', (r) =>
    console.log(`[host] ✓ "${r.winnerLabel}" tally ${r.tally.join('-')}${r.tieBreak ? ' (random tie-break)' : ''}`),
  );
  host.on('game:over', (e) => {
    console.log(`[host] ■ ${e.type} ENDING "${e.title}" · ${e.stats.decisions.length} decisions, ${e.stats.votesCast} votes`);
    console.log('[host] waiting for reset…');
  });
  host.on('game:reset', () => {
    console.log('[host] reset → lobby. done.');
    setTimeout(() => process.exit(0), 300);
  });
  return new Promise((resolve) =>
    host.on('connect', () => host.emit('host:create', {}, (res) => resolve(res.roomId))),
  );
}

function bot(roomId, n) {
  const s = connect();
  s.on('connect', () =>
    s.emit('player:join', { roomId }, (res) => {
      if (!res.ok) return console.log(`[bot${n}] rejected: ${res.reason}`);
      console.log(`[bot${n}] joined as Player ${res.slot}`);
    }),
  );
  s.on('scene:freeze', async () => {
    await sleep(300 + Math.random() * 2500);
    const choiceIndex = Math.random() < 0.5 ? 0 : 1;
    s.emit('vote:submit', { choiceIndex }, (r) => r.ok && console.log(`[bot${n}] voted ${choiceIndex ? 'B' : 'A'}`));
  });
  s.on('game:reset', () => console.log(`[bot${n}] session ended`));
  s.on('connect_error', (e) => console.log(`[bot${n}] cannot reach ${SERVER}: ${e.message}`));
}

const roomId = roomArg ? roomArg.toUpperCase() : await getRoomFromHeadlessHost();
console.log(`room ${roomId} · ${COUNT} bots → ${SERVER}`);
for (let i = 1; i <= COUNT; i++) {
  bot(roomId, i);
  await sleep(250);
}
