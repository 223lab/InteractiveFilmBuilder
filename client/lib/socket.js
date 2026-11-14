import { io } from 'socket.io-client';
import { useEffect, useRef, useState } from 'react';

export { STATES, EVENTS } from '../../shared/states.js';

let socket = null;

/** One shared connection per tab, same origin (Vite proxies /socket.io in dev). */
export function getSocket() {
  if (!socket) {
    socket = io({
      transports: ['websocket', 'polling'],
      reconnectionDelay: 400,
      reconnectionDelayMax: 2500,
    });
  }
  return socket;
}

/**
 * Latest room snapshot. Adds `receivedAt` (performance.now()) so timers can be
 * computed locally as receivedAt + timer.remainingMs without trusting device clocks.
 */
export function useRoomState(sock) {
  const [state, setState] = useState(null);
  useEffect(() => {
    const onState = (s) => setState({ ...s, receivedAt: performance.now() });
    sock.on('room:state', onState);
    return () => sock.off('room:state', onState);
  }, [sock]);
  return state;
}

export function useConnected(sock) {
  const [connected, setConnected] = useState(sock.connected);
  useEffect(() => {
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    sock.on('connect', on);
    sock.on('disconnect', off);
    return () => {
      sock.off('connect', on);
      sock.off('disconnect', off);
    };
  }, [sock]);
  return connected;
}

/** Subscribe to one-shot events: useSocketEvents(socket, { 'game:start': fn, … }) */
export function useSocketEvents(sock, handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const names = Object.keys(handlers).join('|');
  useEffect(() => {
    const bound = names.split('|').map((e) => [e, (...args) => ref.current[e]?.(...args)]);
    bound.forEach(([e, fn]) => sock.on(e, fn));
    return () => bound.forEach(([e, fn]) => sock.off(e, fn));
  }, [sock, names]);
}

export function deadlineOf(state) {
  if (!state?.timer) return null;
  return { deadline: state.receivedAt + state.timer.remainingMs, durationMs: state.timer.durationMs };
}
