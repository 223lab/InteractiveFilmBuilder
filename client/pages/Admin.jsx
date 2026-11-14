import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { validateStory } from '../../shared/storyGraph.js';
import bundledStory from '../../story/story-graph.json';

// ───────────────────────── standalone (GitHub Pages) mode ─────────────────────────
// Without the game server there is nowhere to save or upload. The editor then:
//  - keeps your work as a draft in this browser (autosaved),
//  - "saves" by downloading story-graph.json,
//  - doesn't upload videos: it records them as /media/clips/<file name> and previews
//    them from your disk for this session. Copy those files into media/clips/ on the show laptop.
const PAGES = import.meta.env.VITE_PAGES === '1';
const DRAFT_KEY = 'sentient.story.draft';
const CLIP_DIR = '/media/clips/';
const localPreviews = new Map(); // videoUrl -> blob: URL (this session only)
const previewSrc = (url) => localPreviews.get(url) || url;

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeDraft(story) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(story));
  } catch {
    /* storage full or blocked: download still works */
  }
}
function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

// ───────────────────────── graph <-> story-graph.json ─────────────────────────

const HANDLES = ['a', 'b'];
// What happens when a clip finishes
const MODES = [
  ['choice', 'Choice', 'Freeze and let the leader pick A or B'],
  ['continue', 'Continue', 'Play straight into the next clip, no choice'],
  ['ending', 'Ending', 'Show the ending screen'],
];
const MODE_HANDLES = { choice: ['a', 'b'], continue: ['next'], ending: [] };
const modeOf = (n) => (n.isEndingNode ? 'ending' : n.next ? 'continue' : 'choice');
const fileName = (url) => decodeURIComponent(String(url).split('?')[0].split('/').pop() || url);
const newId = () => `n_${Math.random().toString(36).slice(2, 7)}`;

function makeEdge(source, handle, target) {
  return {
    id: `e-${source}-${handle}`,
    source,
    sourceHandle: handle,
    target,
    type: 'smoothstep',
    className: `edge edge--${handle}`,
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  };
}

function storyToFlow(story) {
  const nodes = (story?.nodes || []).map((n, i) => ({
    id: n.id,
    type: 'clip',
    position: n.position || { x: (i % 4) * 300, y: Math.floor(i / 4) * 260 },
    data: {
      title: n.title || '',
      videoUrl: n.videoUrl || '',
      mode: modeOf(n),
      isEndingNode: !!n.isEndingNode,
      endingType: n.endingType ?? null,
      endingName: n.endingName || '',
      freezeAt: n.freezeAt ?? '',
      choiceALabel: n.choiceALabel || '',
      choiceBLabel: n.choiceBLabel || '',
      isStart: n.id === story.startNodeId,
    },
  }));
  const edges = [];
  for (const n of story?.nodes || []) {
    const mode = modeOf(n);
    if (mode === 'continue') edges.push(makeEdge(n.id, 'next', n.next));
    if (mode === 'choice') (n.choices || []).slice(0, 2).forEach((t, i) => t && edges.push(makeEdge(n.id, HANDLES[i], t)));
  }
  return { nodes, edges };
}

function flowToStory(nodes, edges, title) {
  const startNodeId = nodes.find((n) => n.data.isStart)?.id ?? nodes[0]?.id ?? null;
  return {
    version: 1,
    title,
    startNodeId,
    nodes: nodes.map((n) => {
      const target = (h) => edges.find((e) => e.source === n.id && e.sourceHandle === h)?.target ?? null;
      const fz = n.data.freezeAt;
      const mode = n.data.mode || 'choice';
      const ending = mode === 'ending';
      return {
        id: n.id,
        title: n.data.title,
        videoUrl: n.data.videoUrl,
        isEndingNode: ending,
        endingType: ending ? n.data.endingType || null : null,
        endingName: ending ? String(n.data.endingName || '').trim() : '',
        next: mode === 'continue' ? target('next') : null,
        freezeAt: mode === 'choice' && fz !== '' && fz != null ? Number(fz) : null,
        choices: mode === 'choice' ? [target('a'), target('b')] : [],
        choiceALabel: n.data.choiceALabel,
        choiceBLabel: n.data.choiceBLabel,
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      };
    }),
  };
}

// ───────────────────────── custom node ─────────────────────────

function ClipNode({ id, data, selected }) {
  const mode = data.mode || 'choice';
  const ending = mode === 'ending';
  return (
    <div
      className={[
        'clip',
        selected && 'is-selected',
        data.isStart && 'is-start',
        ending && `is-ending is-${(data.endingType || 'unset').toLowerCase()}`,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Handle type="target" position={Position.Top} className="clip__in" />
      <div className="clip__thumb">
        <Thumb url={data.videoUrl} />
        <div className="clip__tags">
          {data.isStart && <span className="tag tag--start">START</span>}
          {ending && <span className={`tag tag--${(data.endingType || 'unset').toLowerCase()}`}>{data.endingType || 'ENDING?'}</span>}
          {mode === 'continue' && <span className="tag tag--continue">CONTINUE</span>}
        </div>
      </div>
      <div className="clip__body">
        <div className="clip__title">{data.title || 'Untitled clip'}</div>
        <div className="clip__meta">
          {id} · {data.videoUrl ? fileName(data.videoUrl) : '—'}
        </div>
      </div>
      {ending && data.endingName && <div className="clip__ending-name">“{data.endingName}”</div>}
      {mode === 'continue' && (
        <>
          <div className="clip__continue">↓ plays straight into next clip</div>
          <Handle type="source" id="next" position={Position.Bottom} className="clip__out clip__out--next" />
        </>
      )}
      {mode === 'choice' && (
        <>
          <div className="clip__choices">
            <span className="clip__choice clip__choice--a">A · {data.choiceALabel || '—'}</span>
            <span className="clip__choice clip__choice--b">B · {data.choiceBLabel || '—'}</span>
          </div>
          <Handle type="source" id="a" position={Position.Bottom} className="clip__out clip__out--a" style={{ left: '25%' }} />
          <Handle type="source" id="b" position={Position.Bottom} className="clip__out clip__out--b" style={{ left: '75%' }} />
        </>
      )}
    </div>
  );
}
const nodeTypes = { clip: ClipNode };

function Thumb({ url }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url) return <span>NO VIDEO</span>;
  if (failed) return <span className="clip__nopreview">{fileName(url)}</span>;
  return <video src={`${previewSrc(url)}#t=0.8`} muted preload="metadata" playsInline onError={() => setFailed(true)} />;
}

// ───────────────────────── editor ─────────────────────────

async function uploadVideos(files, standalone) {
  if (standalone) {
    return files.map((f) => {
      const url = CLIP_DIR + f.name;
      localPreviews.set(url, URL.createObjectURL(f));
      return { name: f.name, url };
    });
  }
  const body = new FormData();
  files.forEach((f) => body.append('files', f));
  const res = await fetch('/api/upload', { method: 'POST', body });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Upload failed');
  return json.files;
}

function Editor() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [title, setTitle] = useState('Untitled story');
  const [status, setStatus] = useState({ kind: 'info', text: 'Loading story…' });
  const [dirty, setDirty] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [standalone, setStandalone] = useState(PAGES);
  const { screenToFlowPosition, deleteElements, fitView } = useReactFlow();
  const importRef = useRef(null);
  const uploadRef = useRef(null);

  const load = useCallback(
    (story, msg) => {
      const flow = storyToFlow(story);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setTitle(story?.title || 'Untitled story');
      setDirty(false);
      setStatus({ kind: 'info', text: msg });
      requestAnimationFrame(() => fitView({ padding: 0.2 }));
    },
    [setNodes, setEdges, fitView],
  );

  // Load once. (Re-running this after edits would reset the canvas.)
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const goStandalone = () => {
      setStandalone(true);
      const draft = readDraft();
      if (draft?.nodes) {
        load(draft, 'Restored your draft from this browser');
        setDirty(true);
      } else load(bundledStory, 'Loaded the starter story. Import your story-graph.json to continue yours.');
    };
    if (PAGES) return goStandalone();
    fetch('/api/story')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((s) => load(s, 'Loaded story-graph.json from server'))
      .catch(goStandalone);
  }, [load]);

  // warn before leaving with unsaved edits
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const story = useMemo(() => flowToStory(nodes, edges, title), [nodes, edges, title]);
  const validation = useMemo(() => validateStory(story), [story]);

  // standalone: autosave a draft in this browser so nothing is lost on refresh
  useEffect(() => {
    if (standalone && dirty && nodes.length) writeDraft(story);
  }, [standalone, dirty, story, nodes.length]);
  const selected = nodes.find((n) => n.selected) || null;

  const touch = () => setDirty(true);

  const handleNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);
      if (changes.some((c) => c.type !== 'select' && c.type !== 'dimensions')) setDirty(true);
    },
    [onNodesChange],
  );
  const handleEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes);
      if (changes.some((c) => c.type !== 'select')) setDirty(true);
    },
    [onEdgesChange],
  );

  // One outgoing edge per handle: connecting A again replaces the old A link.
  const onConnect = useCallback(
    ({ source, sourceHandle, target }) => {
      if (!sourceHandle || source === target) return;
      setEdges((eds) => [
        ...eds.filter((e) => !(e.source === source && e.sourceHandle === sourceHandle)),
        makeEdge(source, sourceHandle, target),
      ]);
      setDirty(true);
    },
    [setEdges],
  );

  const patchNode = (id, patch) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    if (patch.mode) {
      const keep = MODE_HANDLES[patch.mode];
      setEdges((eds) => eds.filter((e) => e.source !== id || keep.includes(e.sourceHandle)));
    }
    touch();
  };

  const setStart = (id) => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, isStart: n.id === id } })));
    touch();
  };

  const renameNode = (oldId, raw) => {
    const id = raw.trim().replace(/\s+/g, '_');
    if (!id || id === oldId) return;
    if (nodes.some((n) => n.id === id)) {
      setStatus({ kind: 'error', text: `Id "${id}" is already used` });
      return;
    }
    setNodes((ns) => ns.map((n) => (n.id === oldId ? { ...n, id } : n)));
    setEdges((eds) =>
      eds.map((e) => {
        const source = e.source === oldId ? id : e.source;
        const target = e.target === oldId ? id : e.target;
        return { ...makeEdge(source, e.sourceHandle, target) };
      }),
    );
    touch();
  };

  const addNode = (position, data = {}) => {
    const id = newId();
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      {
        id,
        type: 'clip',
        position,
        selected: true,
        data: {
          title: data.title || 'New clip',
          videoUrl: data.videoUrl || '',
          mode: 'choice',
          isEndingNode: false,
          endingType: null,
          endingName: '',
          freezeAt: '',
          choiceALabel: '',
          choiceBLabel: '',
          isStart: ns.length === 0,
        },
      },
    ]);
    touch();
    return id;
  };

  const addFromFiles = async (files, at) => {
    const vids = files.filter((f) => f.type.startsWith('video/'));
    if (!vids.length) {
      setStatus({ kind: 'error', text: 'Drop video files (mp4 / webm / mov)' });
      return;
    }
    setStatus({ kind: 'info', text: `Uploading ${vids.length} clip${vids.length > 1 ? 's' : ''}…` });
    try {
      const uploaded = await uploadVideos(vids, standalone);
      uploaded.forEach((u, i) =>
        addNode(
          { x: at.x + i * 40, y: at.y + i * 40 },
          { videoUrl: u.url, title: u.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') },
        ),
      );
      setStatus({ kind: 'ok', text: `Added ${uploaded.length} clip node${uploaded.length > 1 ? 's' : ''}. Connect A/B for a choice, or set it to Continue.` });
    } catch (e) {
      setStatus({ kind: 'error', text: e.message });
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    addFromFiles(files, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const centerPos = () => screenToFlowPosition({ x: window.innerWidth * 0.4, y: window.innerHeight * 0.45 });

  const save = async () => {
    if (validation.errors.length) {
      setStatus({ kind: 'error', text: `Fix ${validation.errors.length} error(s) before saving` });
      return;
    }
    if (standalone) {
      exportJson();
      writeDraft(story);
      setDirty(false);
      const clips = [...new Set(story.nodes.map((n) => n.videoUrl).filter((u) => u?.startsWith(CLIP_DIR)))];
      setStatus({
        kind: 'ok',
        text: `Downloaded story-graph.json. Put it in the project's story/ folder${
          clips.length ? ` and make sure these ${clips.length} clip(s) are in media/clips/` : ''
        }.`,
      });
      return;
    }
    const res = await fetch('/api/story', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(story),
    });
    const json = await res.json();
    if (res.ok) {
      setDirty(false);
      setStatus({ kind: 'ok', text: 'Saved. The next session on /host uses this graph.' });
    } else {
      setStatus({ kind: 'error', text: (json.errors || ['Save failed']).join(' · ') });
    }
  };

  const exportJson = () => {
    const blob = new Blob([`${JSON.stringify(story, null, 2)}\n`], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'story-graph.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = async (file) => {
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed?.nodes)) throw new Error('No "nodes" array in file');
      load(parsed, `Imported ${file.name} (not saved yet)`);
      setDirty(true);
    } catch (e) {
      setStatus({ kind: 'error', text: `Import failed: ${e.message}` });
    }
  };

  const startOver = () => {
    if (dirty && !window.confirm('Discard this draft and load the starter story? Download it first if you want to keep it.')) return;
    clearDraft();
    load(bundledStory, 'Started over from the starter story');
  };

  const others = nodes.filter((n) => n.id !== selected?.id);
  const edgeTarget = (h) => edges.find((e) => e.source === selected?.id && e.sourceHandle === h)?.target ?? '';
  const setEdgeTarget = (h, target) => {
    setEdges((eds) => {
      const rest = eds.filter((e) => !(e.source === selected.id && e.sourceHandle === h));
      return target ? [...rest, makeEdge(selected.id, h, target)] : rest;
    });
    touch();
  };

  return (
    <div className="admin">
      <header className="admin__bar">
        <strong className="admin__logo">SENTIENT · STORY EDITOR</strong>
        <input className="admin__title" value={title} onChange={(e) => { setTitle(e.target.value); touch(); }} aria-label="Story title" />
        <div className="admin__actions">
          <button type="button" className="btn" onClick={() => addNode(centerPos())}>+ Node</button>
          <button type="button" className="btn" onClick={() => uploadRef.current.click()}>Upload clips</button>
          <button type="button" className="btn" onClick={() => importRef.current.click()}>Import JSON</button>
          <button type="button" className="btn" onClick={exportJson}>Export JSON</button>
          {standalone ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={startOver}>Start over</button>
              <button type="button" className={`btn btn--primary ${dirty ? 'is-dirty' : ''}`} onClick={save}>
                Download story-graph.json
              </button>
            </>
          ) : (
            <>
              <button type="button" className={`btn btn--primary ${dirty ? 'is-dirty' : ''}`} onClick={save}>
                {dirty ? 'Save to server •' : 'Saved'}
              </button>
              <a className="btn btn--ghost" href="/host?debug=1" target="_blank" rel="noreferrer">Test on /host ↗</a>
            </>
          )}
        </div>
        <input ref={uploadRef} type="file" accept="video/*" multiple hidden onChange={(e) => { addFromFiles([...e.target.files], centerPos()); e.target.value = ''; }} />
        <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; }} />
      </header>

      {standalone && (
        <div className="admin__banner">
          OFFLINE EDITOR · work is autosaved in this browser · “Download” gives you story-graph.json for the show laptop ·
          dropped videos are linked as <code>media/clips/&lt;file name&gt;</code>, not uploaded
        </div>
      )}
      <div className="admin__main">
        <div
          className={`admin__canvas ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(e) => {
            if ([...e.dataTransfer.types].includes('Files')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDragging(true);
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            colorMode="dark"
            fitView
            deleteKeyCode={['Backspace', 'Delete']}
            defaultEdgeOptions={{ type: 'smoothstep' }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} color="#1d2228" />
            <Controls />
            <MiniMap pannable zoomable nodeColor={(n) => (n.data.mode === 'ending' ? (n.data.endingType === 'GOOD' ? '#38d6e8' : '#d6283f') : n.data.mode === 'continue' ? '#e8b04a' : '#5b6570')} />
          </ReactFlow>
          {dragging && <div className="admin__drop">DROP VIDEO CLIPS TO CREATE NODES</div>}
          {nodes.length === 0 && !dragging && (
            <div className="admin__empty">Drag video files here, or use “+ Node”.</div>
          )}
        </div>

        <aside className="admin__panel">
          {selected ? (
            <NodePanel
              key={selected.id}
              node={selected}
              others={others}
              edgeTarget={edgeTarget}
              setEdgeTarget={setEdgeTarget}
              patch={(p) => patchNode(selected.id, p)}
              rename={(id) => renameNode(selected.id, id)}
              setStart={() => setStart(selected.id)}
              remove={() => deleteElements({ nodes: [{ id: selected.id }] })}
              replaceVideo={async (file) => {
                try {
                  const [u] = await uploadVideos([file], standalone);
                  patchNode(selected.id, { videoUrl: u.url });
                } catch (e) {
                  setStatus({ kind: 'error', text: e.message });
                }
              }}
            />
          ) : (
            <div className="panel__help">
              <h3>How it works</h3>
              <ol>
                <li>Drop video clips onto the canvas: each becomes a node.</li>
                <li>Select a node and choose what happens <b>after the clip</b>: a <b>Choice</b>, <b className="c-warn">Continue</b> (flows into the next clip with no choice) or an <b>Ending</b>.</li>
                <li>Drag from a node’s <b className="c-a">A</b> / <b className="c-b">B</b> dots (choice) or the <b className="c-warn">amber</b> dot (continue) to the next clip.</li>
                <li>Endings can be GOOD or BAD and have their own custom name.</li>
                {standalone ? (
                  <li>Click <b>Download story-graph.json</b>, put it in the project’s <code>story/</code> folder and your clips in <code>media/clips/</code>.</li>
                ) : (
                  <li>Save to server, then open <code>/host</code>.</li>
                )}
              </ol>
              <p className="muted small">Delete / Backspace removes the selected node or edge.</p>
            </div>
          )}

          <section className="panel__validation">
            <h4>
              Validation{' '}
              <span className={validation.errors.length ? 'c-bad' : 'c-good'}>
                {validation.errors.length ? `${validation.errors.length} error(s)` : 'ready'}
              </span>
            </h4>
            <ul>
              {validation.errors.map((m) => <li key={m} className="c-bad">✕ {m}</li>)}
              {validation.warnings.map((m) => <li key={m} className="c-warn">! {m}</li>)}
            </ul>
          </section>
          <div className={`panel__status panel__status--${status.kind}`}>{status.text}</div>
        </aside>
      </div>
    </div>
  );
}

function NodePanel({ node, others, edgeTarget, setEdgeTarget, patch, rename, setStart, remove, replaceVideo }) {
  const d = node.data;
  const mode = d.mode || 'choice';
  const [idDraft, setIdDraft] = useState(node.id);
  const fileRef = useRef(null);
  return (
    <div className="panel">
      <h3>Clip node</h3>
      <label className="field">
        <span>ID</span>
        <input value={idDraft} onChange={(e) => setIdDraft(e.target.value)} onBlur={() => rename(idDraft)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      </label>
      <label className="field">
        <span>Title</span>
        <input value={d.title} onChange={(e) => patch({ title: e.target.value })} />
      </label>
      <label className="field">
        <span>Video URL</span>
        <input value={d.videoUrl} placeholder="/media/… or https://…" onChange={(e) => patch({ videoUrl: e.target.value })} />
      </label>
      <div className="field-row">
        <button type="button" className="btn btn--small" onClick={() => fileRef.current.click()}>Replace video…</button>
        <input ref={fileRef} type="file" accept="video/*" hidden onChange={(e) => { if (e.target.files[0]) replaceVideo(e.target.files[0]); e.target.value = ''; }} />
      </div>
      {d.videoUrl && <video key={d.videoUrl} className="panel__preview" src={previewSrc(d.videoUrl)} controls muted preload="metadata" />}

      <div className="field-row">
        <label className="check">
          <input type="radio" checked={!!d.isStart} onChange={setStart} /> Start node
        </label>
      </div>

      <div className="field">
        <span>After this clip</span>
        <div className="seg seg--modes">
          {MODES.map(([m, label, hint]) => (
            <button
              key={m}
              type="button"
              title={hint}
              className={`seg__btn seg__btn--${m} ${mode === m ? 'is-on' : ''}`}
              onClick={() =>
                patch({
                  mode: m,
                  isEndingNode: m === 'ending',
                  endingType: m === 'ending' ? d.endingType || 'BAD' : null,
                })
              }
            >
              {label}
            </button>
          ))}
        </div>
        <small className="muted">{MODES.find(([m]) => m === mode)[2]}</small>
      </div>

      {mode === 'ending' && (
        <>
          <div className="field-row seg">
            {['GOOD', 'BAD'].map((t) => (
              <button key={t} type="button" className={`seg__btn seg__btn--${t.toLowerCase()} ${d.endingType === t ? 'is-on' : ''}`} onClick={() => patch({ endingType: t })}>
                {t} ENDING
              </button>
            ))}
          </div>
          <label className="field">
            <span>Ending name (big headline on the ending screen)</span>
            <input
              placeholder={`${d.endingType || 'BAD'} ENDING`}
              value={d.endingName || ''}
              onChange={(e) => patch({ endingName: e.target.value.toUpperCase() })}
            />
          </label>
        </>
      )}

      {mode === 'continue' && (
        <fieldset className="choice-edit choice-edit--next">
          <legend>Continues into</legend>
          <select value={edgeTarget('next')} onChange={(e) => setEdgeTarget('next', e.target.value)}>
            <option value="">— pick the next clip —</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>{o.data.title || o.id} ({o.id})</option>
            ))}
          </select>
        </fieldset>
      )}

      {mode === 'choice' && (
        <>
          {[['a', 'choiceALabel', 'A · left'], ['b', 'choiceBLabel', 'B · right']].map(([h, key, name]) => (
            <fieldset key={h} className={`choice-edit choice-edit--${h}`}>
              <legend>Choice {name}</legend>
              <input placeholder="Button label, e.g. ENTER THE ROOM" value={d[key]} onChange={(e) => patch({ [key]: e.target.value.toUpperCase() })} />
              <select value={edgeTarget(h)} onChange={(e) => setEdgeTarget(h, e.target.value)}>
                <option value="">— no target —</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>{o.data.title || o.id} ({o.id})</option>
                ))}
              </select>
            </fieldset>
          ))}
          <label className="field">
            <span>Freeze at (sec, optional)</span>
            <input type="number" min="0" step="0.1" placeholder="clip end" value={d.freezeAt} onChange={(e) => patch({ freezeAt: e.target.value })} />
          </label>
        </>
      )}

      <button type="button" className="btn btn--danger" onClick={remove}>Delete node</button>
    </div>
  );
}

export default function Admin() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
