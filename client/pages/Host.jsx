import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { getSocket, useConnected, useRoomState, useSocketEvents, deadlineOf, STATES } from '../lib/socket.js';
import * as sfx from '../lib/sfx.js';
import { BootTransition, CountdownBar, CrtOverlay, GlitchText, StaticNoise } from '../components/fx.jsx';

const HOST_KEY = 'gc.hostKey';
const VIDEO_PHASES = [STATES.PLAYING_SCENE, STATES.AWAITING_VOTES, STATES.RESOLVING_CHOICE, STATES.GAME_OVER];

/** Base URL phones should open. Localhost is useless to a phone, so swap in the LAN IP. */
function joinBase(net) {
  if (net?.publicUrl) return net.publicUrl.replace(/\/$/, '');
  const { protocol, hostname, port } = window.location;
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  if (!isLocal || !net?.addresses?.length) return window.location.origin;
  return `${protocol}//${net.addresses[0]}${port ? `:${port}` : ''}`;
}

export default function Host() {
  const socket = getSocket();
  const state = useRoomState(socket);
  const connected = useConnected(socket);
  const [armed, setArmed] = useState(false);
  const [net, setNet] = useState(null);
  const [cut, setCut] = useState(0);
  const [allowForce, setAllowForce] = useState(false);
  const debug = useMemo(() => new URLSearchParams(window.location.search).has('debug'), []);

  // Create or resume (after refresh) this screen's room.
  useEffect(() => {
    const create = () =>
      socket.emit('host:create', { hostKey: sessionStorage.getItem(HOST_KEY) }, (res) => {
        if (!res?.ok) return;
        sessionStorage.setItem(HOST_KEY, res.hostKey);
        setAllowForce(!!res.allowForceStart);
      });
    if (socket.connected) create();
    socket.on('connect', create);
    return () => socket.off('connect', create);
  }, [socket]);

  // Network info for the QR. In event mode, keep polling until the public tunnel link is up.
  useEffect(() => {
    let timer;
    let stopped = false;
    const load = () =>
      fetch('/api/network')
        .then((r) => r.json())
        .then((n) => {
          if (stopped) return;
          setNet(n);
          if (n.tunnel?.status === 'starting') timer = setTimeout(load, 1500);
        })
        .catch(() => {
          if (stopped) return;
          setNet((prev) => prev || { addresses: [] });
          timer = setTimeout(load, 3000);
        });
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const cutTimer = useRef(null);
  useSocketEvents(socket, {
    'game:start': () => {
      sfx.cue('start');
    },
    'scene:play': ({ sceneSeq, continued }) => {
      if (continued) return; // continue links flow straight on, no glitch cut
      sfx.cue('cut');
      setCut(sceneSeq);
      clearTimeout(cutTimer.current);
      cutTimer.current = setTimeout(() => setCut(0), 520);
    },
    'scene:freeze': ({ durationMs }) => {
      sfx.cue('freeze');
      sfx.startDread(durationMs);
    },
    'vote:resolve': () => {
      sfx.stopDread();
      sfx.cue('resolve');
    },
    'game:over': () => sfx.cue('ending'),
    'game:reset': () => {
      sfx.stopDread(1);
      sfx.cue('reset');
    },
  });

  const arm = () => {
    sfx.unlockAudio();
    document.documentElement.requestFullscreen?.().catch(() => {});
    setArmed(true);
  };

  // Keyboard: F fullscreen · debug: S force start, R reset
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'f' || e.key === 'F') {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().catch(() => {});
      }
      if (!debug) return;
      if (e.key === 's' || e.key === 'S') socket.emit('game:start', {});
      if (e.key === 'r' || e.key === 'R') socket.emit('game:reset', {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [debug, socket]);

  const onEnded = useCallback((sceneSeq) => socket.emit('scene:ended', { sceneSeq }), [socket]);

  const phase = state?.phase;
  const tunnelPending = net?.tunnel?.status === 'starting';
  const tunnelError = net?.tunnel?.status === 'error' ? net.tunnel.error : null;
  const joinUrl =
    state?.roomId && net && !tunnelPending && !tunnelError ? `${joinBase(net)}/play?room=${state.roomId}` : null;
  const qrMessage = tunnelError ? `PUBLIC LINK FAILED · ${tunnelError}` : tunnelPending ? 'OPENING PUBLIC LINK…' : 'GENERATING…';
  const showVideo = state?.node && VIDEO_PHASES.includes(phase);

  return (
    <div
      className={[
        'host',
        phase === STATES.RESOLVING_CHOICE && 'host--resolving',
        phase === STATES.PLAYING_SCENE && 'host--playing',
        phase === STATES.AWAITING_VOTES && 'host--frozen',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showVideo && (
        <SceneVideo
          key={state.sceneSeq}
          node={state.node}
          sceneSeq={state.sceneSeq}
          startFrozen={phase !== STATES.PLAYING_SCENE}
          onEnded={onEnded}
        />
      )}

      {(!state || phase === STATES.LOBBY_WAITING) && (
        <Lobby
          state={state}
          joinUrl={joinUrl}
          qrMessage={qrMessage}
          debug={debug && allowForce}
          onForceStart={() => socket.emit('game:start', {})}
        />
      )}

      {phase === STATES.TRANSITIONING && <BootTransition durationMs={state.timer?.durationMs || 2800} />}

      {(phase === STATES.AWAITING_VOTES || phase === STATES.RESOLVING_CHOICE) && state.choices && (
        <ChoiceOverlay state={state} />
      )}

      {phase === STATES.GAME_OVER && state.ending && <EndingScreen state={state} />}

      {cut > 0 && (
        <div key={cut} className="scene-cut" aria-hidden>
          <StaticNoise opacity={0.45} />
        </div>
      )}

      <Preloader urls={state?.preloadUrls} />
      <CrtOverlay />

      {!connected && <div className="host__offline">CONNECTION LOST · RECONNECTING…</div>}
      {debug && state && (
        <div className="host__debug">
          {state.roomId} · {phase} · seq {state.sceneSeq} · [S] start [R] reset [F] fullscreen
        </div>
      )}
      {!armed && <ArmOverlay onArm={arm} />}
    </div>
  );
}

// ───────────────────────── Lobby ─────────────────────────

function Lobby({ state, joinUrl, qrMessage, debug, onForceStart }) {
  const players = state?.players || [];
  const leader = players.find((p) => p.slot === 1);
  const leaderStatus = !leader ? 'empty' : leader.connected ? 'on' : 'weak';

  return (
    <section className="lobby">
      <StaticNoise opacity={0.05} />
      <div className="lobby__watermark">CTIG</div>
      <header className="lobby__head">
        <GlitchText as="h1" text="SENTIENT" className="lobby__title" />
        <p className="lobby__tag">AN INTERACTIVE SHORT FILM · ONE LEADER DECIDES</p>
      </header>

      <div className="lobby__body">
        <div className="lobby__qr-wrap">
          <div className="lobby__qr frame">
            {joinUrl ? (
              <QRCodeSVG value={joinUrl} size={320} level="M" marginSize={2} bgColor="#d8dde3" fgColor="#000000" />
            ) : (
              <div className="lobby__qr-loading">{qrMessage}</div>
            )}
          </div>
          <div className="lobby__scan">SCAN TO JOIN</div>
          <div className="lobby__url">{joinUrl || '…'}</div>
        </div>

        <div className="lobby__side">
          <div className="lobby__code-label">ROOM CODE</div>
          <div className="lobby__code">{state?.roomId || '----'}</div>

          <ul className="lobby__slots">
            <li className={`slot slot--leader slot--${leaderStatus}`} style={{ '--i': 0 }}>
              <span className="slot__name">
                {leaderStatus === 'empty' ? 'LEADER HAS NOT JOINED' : 'LEADER HAS JOINED'}
              </span>
              <span className="slot__status">
                {leaderStatus === 'empty' ? '· · ·' : leaderStatus === 'on' ? 'ONLINE' : 'SIGNAL WEAK'}
              </span>
            </li>
          </ul>
          <p className="lobby__hint">
            {leaderStatus === 'empty'
              ? 'The first person to scan becomes the leader and makes every choice.'
              : 'The film is starting…'}
          </p>
          {debug && (
            <button type="button" className="btn btn--ghost" onClick={onForceStart}>
              FORCE START
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ───────────────────────── Video ─────────────────────────

function SceneVideo({ node, sceneSeq, startFrozen, onEnded }) {
  const ref = useRef(null);
  const reported = useRef(false);
  const [error, setError] = useState(null);
  const [mutedFallback, setMutedFallback] = useState(false);

  const report = useCallback(() => {
    if (reported.current) return;
    reported.current = true;
    onEnded(sceneSeq);
  }, [onEnded, sceneSeq]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return undefined;
    if (!node.videoUrl) {
      setError('NO VIDEO SOURCE');
      const t = setTimeout(report, 2000);
      return () => clearTimeout(t);
    }
    if (startFrozen) {
      // Remounted mid-vote (e.g. host refresh): show the freeze frame without playing.
      const seek = () => {
        v.currentTime = node.freezeAt ?? Math.max(0, (v.duration || 0) - 0.05);
      };
      if (v.readyState >= 1) seek();
      else v.addEventListener('loadedmetadata', seek, { once: true });
      return undefined;
    }
    v.play().catch(() => {
      // Autoplay with sound blocked (screen not armed): fall back to muted.
      v.muted = true;
      setMutedFallback(true);
      v.play().catch(() => setError('PLAYBACK BLOCKED'));
    });

    // freezeAt: poll per frame so the freeze lands within ~1 frame (timeupdate is ~250ms).
    if (node.freezeAt == null) return undefined;
    let raf;
    const watch = () => {
      if (v.currentTime >= node.freezeAt) {
        v.pause();
        report();
        return;
      }
      raf = requestAnimationFrame(watch);
    };
    raf = requestAnimationFrame(watch);
    return () => cancelAnimationFrame(raf);
    // mount-only: a new scene remounts this component via key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scene">
      <video
        ref={ref}
        className="scene__video"
        src={node.videoUrl || undefined}
        playsInline
        preload="auto"
        disablePictureInPicture
        controls={false}
        onEnded={() => !startFrozen && report()}
        onError={() => {
          setError('SIGNAL CORRUPTED');
          if (!startFrozen) setTimeout(report, 2500);
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      {error && (
        <div className="scene__error">
          <StaticNoise opacity={0.35} />
          <GlitchText text={error} intense />
          <small>{node.videoUrl || node.id}</small>
        </div>
      )}
      {mutedFallback && (
        <button
          type="button"
          className="scene__unmute"
          onClick={() => {
            sfx.unlockAudio();
            ref.current.muted = false;
            setMutedFallback(false);
          }}
        >
          SOUND BLOCKED · CLICK TO UNMUTE
        </button>
      )}
    </div>
  );
}

function Preloader({ urls }) {
  if (!urls?.length) return null;
  return (
    <div className="preloader" aria-hidden>
      {urls.map((u) => (
        <video key={u} src={u} preload="auto" muted playsInline />
      ))}
    </div>
  );
}

// ───────────────────────── Choice / vote ─────────────────────────

function ChoiceOverlay({ state }) {
  const { choices, resolution, votes, phase } = state;
  const resolving = phase === STATES.RESOLVING_CHOICE && resolution;
  const t = phase === STATES.AWAITING_VOTES ? deadlineOf(state) : null;
  const byIndex = (i) => choices.find((c) => c.index === i);

  const renderChoice = (i) => {
    const c = byIndex(i);
    if (!c) return <div className="choice choice--empty" />;
    const isWinner = resolving && resolution.winnerIndex === i;
    const isLoser = resolving && resolution.winnerIndex !== i;
    return (
      <div
        className={['choice', i === 0 ? 'choice--a' : 'choice--b', isWinner && 'is-winner', isLoser && 'is-loser']
          .filter(Boolean)
          .join(' ')}
      >
        <span className="choice__key">{i === 0 ? '◄ A' : 'B ►'}</span>
        <GlitchText text={c.label} className="choice__label" intense={isWinner} />
        {isWinner && <span className="choice__count">{resolution.noVotes ? 'SYSTEM CHOICE' : 'LEADER CHOICE'}</span>}
      </div>
    );
  };

  const verdict = !resolving
    ? null
    : resolution.noVotes
      ? 'NO INPUT DETECTED · SYSTEM DECIDES'
      : resolution.tieBreak
        ? 'SYSTEM OVERRIDE'
        : 'THE LEADER HAS CHOSEN';

  return (
    <div className={`choices ${resolving ? 'choices--resolving' : ''}`}>
      <div className="choices__dim" />
      <div className="choices__prompt">
        <GlitchText text={resolving ? 'DECISION LOCKED' : 'CHOOSE'} intense={!!resolving} />
      </div>

      <div className="choices__stack">
        {/* timer spans from the centre of box A to the centre of box B */}
        <div className="choices__timer">
          {t ? (
            <CountdownBar deadline={t.deadline} durationMs={t.durationMs} />
          ) : (
            <div className="choices__verdict">{verdict}</div>
          )}
          {!resolving && (
            <div className="choices__votes">
              {votes.count > 0 ? 'LEADER HAS CHOSEN' : votes.total > 0 ? 'LEADER IS DECIDING…' : 'LEADER DISCONNECTED'}
            </div>
          )}
        </div>
        <div className="choices__row">
          {renderChoice(0)}
          {renderChoice(1)}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Ending ─────────────────────────

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function EndingScreen({ state }) {
  const { type, name, title, stats } = state.ending;
  const t = deadlineOf(state);
  const tone = type === 'GOOD' ? 'good' : type === 'BAD' ? 'bad' : 'none';

  return (
    <section className={`ending ending--${tone}`}>
      <StaticNoise opacity={0.07} />
      <div className="ending__kicker">TRANSMISSION TERMINATED</div>
      <GlitchText as="h1" text={name || (type ? `${type} ENDING` : 'END OF FEED')}
        className={`ending__type ${name && name.length > 12 ? 'ending__type--long' : ''}`}
        intense
      />
      {name && type && <div className="ending__kicker">{type} ENDING</div>}
      {!name && <div className="ending__title">“{title}”</div>}

      <dl className="ending__stats">
        <div><dt>DECISIONS</dt><dd>{stats.decisions.length}</dd></div>
        <div><dt>LEADER CHOICES</dt><dd>{stats.votesCast}</dd></div>
        <div><dt>TIMED OUT</dt><dd>{stats.decisions.filter((d) => d.noVotes).length}</dd></div>
        <div><dt>RUNTIME</dt><dd>{fmtTime(stats.durationMs)}</dd></div>
      </dl>

      {stats.decisions.length > 0 && (
        <ol className="ending__log">
          {stats.decisions.map((d, i) => {
            return (
              <li key={i}>
                <span className="log__node">{d.nodeTitle}</span>
                <span className="log__bar">
                  <span className={`log__seg log__seg--a ${d.winnerIndex === 0 ? 'is-win' : ''}`} style={{ flex: '1 1 0' }}>
                    {d.labels[0]}
                  </span>
                  <span className={`log__seg log__seg--b ${d.winnerIndex === 1 ? 'is-win' : ''}`} style={{ flex: '1 1 0' }}>
                    {d.labels[1]}
                  </span>
                </span>
                <span className="log__pick">
                  → {d.choiceLabel}
                  {d.noVotes ? ' (timed out)' : ''}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {t && (
        <div className="ending__reset">
          <span>SYSTEM REBOOT IN</span>
          <CountdownBar deadline={t.deadline} durationMs={t.durationMs} />
        </div>
      )}
    </section>
  );
}

// ───────────────────────── Arm ─────────────────────────

function ArmOverlay({ onArm }) {
  return (
    <button type="button" className="arm" onClick={onArm}>
      <GlitchText text="CLICK TO ARM PROJECTOR" />
      <span>enables sound + fullscreen · the leader can already join</span>
    </button>
  );
}
