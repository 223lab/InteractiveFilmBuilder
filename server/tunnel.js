import { spawn } from 'node:child_process';

/**
 * Opens a free public HTTPS link to this server with Cloudflare's quick tunnel,
 * so phones can join over mobile data. Needs the `cloudflared` CLI installed.
 * The URL changes every run; the host screen picks it up automatically for the QR.
 */
export function startTunnel(port, log = console.log) {
  const state = { status: 'starting', url: null, error: null };
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const scan = (buf) => {
    if (state.url) return;
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      state.url = m[0];
      state.status = 'ready';
      log(`\n  PUBLIC LINK (phones on mobile data): ${state.url}\n`);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  child.on('error', (err) => {
    state.status = 'error';
    state.error =
      err.code === 'ENOENT'
        ? 'cloudflared is not installed (see README: Event mode)'
        : `cloudflared failed: ${err.message}`;
    log(`\n  [tunnel] ${state.error}\n`);
  });
  child.on('exit', (code) => {
    if (state.status === 'error') return;
    state.status = 'error';
    state.error = `cloudflared stopped (exit ${code}). Restart the server to open a new link.`;
    log(`\n  [tunnel] ${state.error}\n`);
  });

  const stop = () => child.kill();
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stop();
      process.exit(0);
    });
  }
  return state;
}
