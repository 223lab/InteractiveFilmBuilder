# SENTIENT

Interactive tech-horror short film. One host screen plays the film; a single **leader** joins by QR code on their phone and makes every choice (15 seconds per decision). Includes a drag-and-drop story editor.

| Route | What it is |
| --- | --- |
| `/host` | Main screen: QR lobby → glitch boot → film → freeze-frame voting → ending + stats → auto-reset |
| `/play?room=CODE` | Phone controller (opened from the QR code) |
| `/admin` | Story node editor: drop clips, wire A/B branches, mark endings, save / export `story-graph.json` |

## Run it

```bash
npm install
npm run dev          # server :3001 + Vite :5173 (LAN-visible)
```

1. Open `http://localhost:5173/host` on the screen / projector and **click once to arm** (browsers block sound and fullscreen until a click).
2. Phones on the **same Wi-Fi** scan the QR code. The QR uses your machine's LAN IP automatically.
3. The film starts by itself as soon as the leader joins. Anyone else who scans sees "Leader already joined".

**Testing without a phone**
- `http://localhost:5173/host?debug=1` shows a Force Start button (keys: `S` start, `R` reset, `F` fullscreen).
- `npm run simulate -- ABCD` adds a bot leader to room `ABCD`.
- `npm run simulate` runs a headless host + bot leader through a full game in the terminal.
- `npm test` runs the state-machine and socket-wiring tests (no install needed for these).

## Event mode (phones on mobile data, no shared Wi-Fi)

Only the host laptop needs internet. It runs everything and opens a free public HTTPS link via Cloudflare Tunnel; the QR code on screen switches to that link automatically, so players join over their own 4G/5G.

1. Install `cloudflared` once:
   - macOS: `brew install cloudflared`
   - Windows: `winget install --id Cloudflare.cloudflared`
   - Linux: see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Run `npm run event` (builds the app, starts the server, opens the link).
3. Open `http://localhost:3001/host` on the laptop driving the screen. The QR shows "OPENING PUBLIC LINK…" for a few seconds, then the real code.

Videos play from the laptop's own disk, so they don't use the internet at all; phones only send tiny vote messages. The link changes each time you restart, which is fine because the QR is generated live. Quick tunnels are free with no uptime guarantee, so do a full test run at the venue. For extra safety, a phone hotspot for the laptop is a good backup internet source.

**Production / venue (LAN)**

```bash
npm run build && npm start      # everything on :3001
```

Set `PUBLIC_URL=https://your-domain` if phones should reach a public address instead of the LAN IP.

Timings are env vars: `VOTE_MS` (15000), `RESOLVE_MS` (1800), `RESET_MS` (10000), `TRANSITION_MS` (2800), `MAX_PLAYERS` (1, set to 5 for group voting), `ALLOW_FORCE_START` (true).

## Project layout

```
server/
  index.js           Express: /api/story (GET/POST), /api/upload, /api/network, /media, built client
  GameRoom.js        The state machine (one per host screen)
  socketHandlers.js  Socket.io wiring + room registry (create / resume / rotate / close)
  storyStore.js      Load / validate / atomically save story-graph.json
  config.js          Timings and limits
shared/
  states.js          Phase names + event reference (used by server and client)
  storyGraph.js      Graph helpers + validator (used by server and editor)
client/
  pages/Host.jsx     Lobby + QR, video engine, choice overlay, ending screen
  pages/Play.jsx     Phone controller
  pages/Admin.jsx    React Flow node editor
  components/fx.jsx  Glitch text, static canvas, CRT boot transition, countdown bar
  lib/               socket hooks, synthesized glitch audio, haptics + wake lock
  styles/global.css  All visuals (glitch keyframes, scanlines, layouts)
story/story-graph.json   Mock 6-node story
media/mock/              Placeholder clips (regenerate: npm run mock:clips)
media/uploads/           Clips uploaded from /admin
```

## State machine

The server owns phases, timers and tallies. The host only reports "this clip finished".

```
LOBBY_WAITING ──leader joins─▶ TRANSITIONING ──2.8s──▶ PLAYING_SCENE ──clip end──▶ AWAITING_VOTES
      ▲                                                  ▲     │                       │ all voted / timer
      │                                                  │     └─ending node─▶ GAME_OVER
      │                                         RESOLVING_CHOICE ◀───────────────────┘      │ 10s
      └──────────── new room code, phones disconnected ◀───────────────────────────────────┘
```

- **Tally:** majority wins; a tie or zero votes picks randomly (flagged as a "system override").
- **Vote ends** when every *connected* player has voted or the timer runs out, so a phone that drops never stalls the room.
- **Reconnects:** a phone that drops keeps its slot (token in sessionStorage). In the lobby the slot is held 15s. The host can refresh mid-game and resume the same room.
- **Reset:** after the ending, the lobby reopens under a **new room code** and old phones are disconnected, so stale devices can't slip into the next audience's run.
- Timers are sent as `remainingMs`, not timestamps, so phone clock drift doesn't matter.

Event names and payloads are documented at the top of `shared/states.js`.

## story-graph.json

```json
{
  "startNodeId": "intro",
  "nodes": [{
    "id": "intro",
    "title": "Signal Lost",
    "videoUrl": "/media/mock/intro.mp4",
    "isEndingNode": false,
    "endingType": null,
    "freezeAt": null,
    "choices": ["room", "corridor"],
    "choiceALabel": "ENTER THE ROOM",
    "choiceBLabel": "RUN AWAY",
    "position": { "x": 300, "y": 0 }
  }]
}
```

- `next`: set this (instead of choices) to make a clip **continue** straight into another clip with no choice and no glitch cut. In `/admin` pick **After this clip → Continue** and drag from the amber dot.
- `endingName`: custom headline for the ending screen (e.g. "SHE NEVER WOKE UP"); `endingType` GOOD/BAD still sets the colour.
- `choices[0]` is Choice A (left button), `choices[1]` is Choice B (right). Use `null` for an unused slot; a node with one choice auto-advances without a vote.
- `freezeAt` (seconds, optional) freezes and votes at that timestamp instead of at the clip's last frame.
- `videoUrl` can be a local `/media/...` path or any full URL (cloud storage needs CORS-free direct video links).
- Saving from `/admin` validates the graph (dead ends, missing targets, unreachable nodes, no reachable ending). Games already running keep the graph they started with.

## Online story editor (GitHub Pages)

The story editor can also run as a free website on GitHub Pages, so you (or teammates) can build the story from any computer without running the server.

1. Create a GitHub repository and push this project to it (`main` branch).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` rebuilds the editor (`.github/workflows/pages.yml`). It appears at `https://<your-username>.github.io/<repo-name>/`.

The online editor has no server behind it, so it works slightly differently (an amber banner says so):
- Your work is **autosaved in that browser**. **Download story-graph.json** gives you the file; put it in `story/` on the show laptop (or use **Import JSON** in `/admin` there).
- Videos are **not uploaded**. A clip you add is linked as `/media/clips/<file name>` and previewed from your disk while the page is open. Copy the same files, with the same names, into `media/clips/` on the show laptop.
- The film itself (host screen + leader's phone) still runs from the laptop with `npm run event`.

Note: GitHub Pages on a free account needs a **public** repo, so anyone could see the project code and story file. Video files are kept out of git (`.gitignore`), and GitHub rejects files over 100 MB anyway.

## Sound

The host screen plays dark generated sound (sub-bass, low rumble, dissonant drones in a long reverb); phones are silent and use vibration only. To use your own sound design, drop files into `media/sfx/` named `start`, `cut`, `freeze`, `dread` (looped while deciding), `resolve`, `ending`, `reset` (`.mp3/.wav/.ogg/.m4a`). See `media/sfx/README.txt`.

## Things to know

- **Video format:** use H.264 MP4 with `-movflags +faststart` for instant start on every browser. Each clip's last frame is the freeze frame, so end clips on a meaningful image.
- **Next clips preload** during the vote, so the winning branch starts without a black gap on a decent connection.
- **Haptics:** `navigator.vibrate` works on Android. iOS Safari has no web vibration API, so every vibration is paired with a visual flash.
- **Fonts** load from Google Fonts; offline venues fall back to the system monospace font. Self-host the two fonts if the venue has no internet.
- Phones must be able to reach the host machine: same network, and allow Node through the OS firewall on first run.
