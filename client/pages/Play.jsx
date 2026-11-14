import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getSocket, useConnected, useRoomState, useSocketEvents, deadlineOf, STATES } from '../lib/socket.js';
import { HAPTIC, startWakeLock, vibrate } from '../lib/haptics.js';
import * as sfx from '../lib/sfx.js';
import { CountdownBar, GlitchText, StaticNoise } from '../components/fx.jsx';

const REJECT_COPY = {
  FULL: ['LEADER ALREADY JOINED', 'Someone else is leading this session. Watch the main screen.'],
  IN_PROGRESS: ['FILM IN PROGRESS', 'A leader is already making the choices. Wait for the next session.'],
  NO_ROOM: ['ROOM NOT FOUND', 'Scan the QR code on the main screen again.'],
  IS_HOST: ['WRONG DEVICE', 'This browser is the host screen.'],
};

export default function Play() {
  const roomId = useMemo(
    () => (new URLSearchParams(window.location.search).get('room') || '').trim().toUpperCase(),
    [],
  );
  const socket = getSocket();
  const state = useRoomState(socket);
  const connected = useConnected(socket);
  const [status, setStatus] = useState(roomId ? 'joining' : 'noroom'); // joining | joined | rejected | ended | closed | replaced
  const [reason, setReason] = useState(null);
  const [slot, setSlot] = useState(null);
  const [myVote, setMyVote] = useState(null); // { sceneSeq, index }
  const [flash, setFlash] = useState(0);
  const done = useRef(false);
  const tokenKey = `gc.player.${roomId}`;

  // Join (and silently rejoin with the same slot after a dropped connection).
  useEffect(() => {
    if (!roomId) return undefined;
    const join = () => {
      if (done.current) return;
      socket.emit('player:join', { roomId, token: sessionStorage.getItem(tokenKey) }, (res) => {
        if (res?.ok) {
          sessionStorage.setItem(tokenKey, res.token);
          setSlot(res.slot);
          setStatus('joined');
        } else {
          setStatus('rejected');
          setReason(res?.reason || 'NO_ROOM');
        }
      });
    };
    const end = (s) => {
      done.current = true;
      sessionStorage.removeItem(tokenKey);
      setStatus(s);
    };
    const onDisconnect = (why) => {
      // server kicked us (session reset) without us seeing game:reset
      if (why === 'io server disconnect' && !done.current) end('ended');
    };
    const onReset = () => end('ended');
    const onClosed = () => end('closed');
    const onReplaced = () => {
      end('replaced');
      socket.disconnect();
    };
    if (socket.connected) join();
    socket.on('connect', join);
    socket.on('disconnect', onDisconnect);
    socket.on('game:reset', onReset);
    socket.on('room:closed', onClosed);
    socket.on('session:replaced', onReplaced);
    return () => {
      socket.off('connect', join);
      socket.off('disconnect', onDisconnect);
      socket.off('game:reset', onReset);
      socket.off('room:closed', onClosed);
      socket.off('session:replaced', onReplaced);
    };
  }, [socket, roomId, tokenKey]);

  useEffect(() => (status === 'joined' ? startWakeLock(true) : undefined), [status]);

  const myVoteRef = useRef(myVote);
  myVoteRef.current = myVote;
  const glitchFlash = () => setFlash((f) => f + 1);
  useSocketEvents(socket, {
    'game:start': () => {
      vibrate(HAPTIC.glitch);
      glitchFlash();
    },
    'scene:play': ({ continued }) => !continued && glitchFlash(),
    'scene:freeze': () => {
      vibrate(HAPTIC.freeze);
    },
    'vote:resolve': (r) => {
      const mine = myVoteRef.current;
      if (mine && state && mine.sceneSeq === state.sceneSeq) vibrate(mine.index === r.winnerIndex ? HAPTIC.win : HAPTIC.lose);
      else vibrate(HAPTIC.tap);
      glitchFlash();
    },
  });

  const vote = (index) => {
    sfx.unlockAudio();
    if (!state || myVote?.sceneSeq === state.sceneSeq) return;
    setMyVote({ sceneSeq: state.sceneSeq, index }); // optimistic lock-in
    vibrate(HAPTIC.vote);
    socket.emit('vote:submit', { choiceIndex: index }, (res) => {
      if (res?.ok) return;
      if (res?.reason === 'ALREADY_VOTED') setMyVote({ sceneSeq: state.sceneSeq, index: res.choiceIndex });
      else if (res?.reason === 'NOT_VOTING') {
        /* vote closed just before the tap; the resolve screen takes over */
      } else setMyVote(null);
    });
  };

  // ── screens that don't depend on room state ──
  if (status === 'noroom') return <Shell><Message title="NO ROOM CODE" body="Scan the QR code on the main screen." /></Shell>;
  if (status === 'rejected') {
    const [t, b] = REJECT_COPY[reason] || REJECT_COPY.NO_ROOM;
    return <Shell><Message title={t} body={b} /></Shell>;
  }
  if (status === 'ended')
    return (
      <Shell>
        <Message title="SESSION TERMINATED" body="Thanks for playing. To play again, scan the new code on the main screen." />
      </Shell>
    );
  if (status === 'closed') return <Shell><Message title="HOST OFFLINE" body="The main screen disconnected." /></Shell>;
  if (status === 'replaced') return <Shell><Message title="OPENED ELSEWHERE" body="The leader continued in another tab." /></Shell>;
  if (status === 'joining' || !state) return <Shell><Message title="CONNECTING…" body={`Room ${roomId}`} pulse /></Shell>;

  const phase = state.phase;
  const me = state.players.find((p) => p.slot === slot);
  const voted = myVote?.sceneSeq === state.sceneSeq || !!me?.voted;
  const myIndex = myVote?.sceneSeq === state.sceneSeq ? myVote.index : null;

  let screen;
  switch (phase) {
    case STATES.LOBBY_WAITING: {
      screen = (
        <div className="pl-center">
          <div className="pl-kicker">CONNECTED AS</div>
          <GlitchText as="div" text="LEADER" className="pl-player" />
          <div className="pl-wait">You make every choice. Waiting for film to begin…</div>
        </div>
      );
      break;
    }
    case STATES.TRANSITIONING:
      screen = (
        <div className="pl-center pl-boot">
          <StaticNoise opacity={0.35} />
          <GlitchText as="div" text="SYNCHRONIZING" className="pl-player" intense />
          <div className="pl-wait">Eyes on the main screen.</div>
        </div>
      );
      break;
    case STATES.PLAYING_SCENE:
      screen = (
        <div className="pl-center">
          <div className="pl-eye" aria-hidden />
          <div className="pl-kicker">LEADER</div>
          <div className="pl-wait">{state.node?.isEndingNode ? 'Watch closely…' : 'Watch the screen. Your choice is coming.'}</div>
        </div>
      );
      break;
    case STATES.AWAITING_VOTES: {
      const t = deadlineOf(state);
      const choiceFor = (i) => state.choices?.find((c) => c.index === i);
      screen = voted ? (
        <div className="pl-center pl-locked">
          {t && <CountdownBar deadline={t.deadline} durationMs={t.durationMs} className="pl-countdown" />}
          <GlitchText as="div" text="VOTE REGISTERED" className="pl-player" />
          <div className={`pl-yourpick ${myIndex === 1 ? 'is-b' : 'is-a'}`}>
            {myIndex != null ? `${myIndex === 0 ? '◄ A' : 'B ►'}  ${choiceFor(myIndex)?.label ?? ''}` : 'LOCKED IN'}
          </div>
          <div className="pl-wait">Locking in…</div>
        </div>
      ) : (
        <div className="pl-vote">
          {t && <CountdownBar deadline={t.deadline} durationMs={t.durationMs} className="pl-countdown" />}
          <div className="pl-vote__split">
            {[0, 1].map((i) => {
              const c = choiceFor(i);
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!c}
                  className={`pl-btn ${i === 0 ? 'pl-btn--a' : 'pl-btn--b'}`}
                  onPointerDown={() => c && vote(i)}
                >
                  <span className="pl-btn__key">{i === 0 ? '◄ A' : 'B ►'}</span>
                  <span className="pl-btn__label">{c?.label ?? '—'}</span>
                </button>
              );
            })}
          </div>
        </div>
      );
      break;
    }
    case STATES.RESOLVING_CHOICE: {
      const r = state.resolution;
      const won = myIndex != null && r && myIndex === r.winnerIndex;
      screen = (
        <div className={`pl-center pl-resolve ${won ? 'is-won' : myIndex != null ? 'is-lost' : ''}`}>
          <div className="pl-kicker">{r?.noVotes ? 'TIME RAN OUT · SYSTEM DECIDED' : 'YOU DECIDED'}</div>
          <GlitchText as="div" text={r?.winnerLabel || '…'} className="pl-player" intense />
          <div className="pl-wait">
            {myIndex == null || r?.noVotes ? 'You did not choose in time.' : 'Watch what happens next.'}
          </div>
        </div>
      );
      break;
    }
    case STATES.GAME_OVER: {
      const e = state.ending;
      screen = (
        <div className={`pl-center pl-ending pl-ending--${(e?.type || 'none').toLowerCase()}`}>
          <div className="pl-kicker">TRANSMISSION TERMINATED</div>
          <GlitchText as="div" text={e?.name || (e?.type ? `${e.type} ENDING` : 'END')} className="pl-player" intense />
          <div className="pl-wait">“{e?.title}”</div>
          <div className="pl-small">Results on the main screen</div>
        </div>
      );
      break;
    }
    default:
      screen = <Message title="…" body={phase} />;
  }

  return (
    <Shell flash={flash} offline={!connected}>
      <header className="pl-bar">
        <span>SENTIENT</span>
        <span>
          LEADER · {state.roomId}
        </span>
      </header>
      {screen}
    </Shell>
  );
}

function Shell({ children, flash = 0, offline = false }) {
  return (
    <main className="play" onPointerDown={sfx.unlockAudio}>
      {children}
      {flash > 0 && <div key={flash} className="pl-flash" aria-hidden />}
      <div className="crt-scanlines crt-scanlines--soft" aria-hidden />
      {offline && <div className="pl-offline">RECONNECTING…</div>}
    </main>
  );
}

function Message({ title, body, pulse }) {
  return (
    <div className={`pl-center ${pulse ? 'pl-pulse' : ''}`}>
      <GlitchText as="div" text={title} className="pl-player" />
      <div className="pl-wait">{body}</div>
    </div>
  );
}
