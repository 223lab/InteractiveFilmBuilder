// Story graph helpers shared by the server runtime and the /admin editor.
//
// story-graph.json shape:
// {
//   "version": 1,
//   "title": "…",
//   "startNodeId": "intro",
//   "nodes": [{
//     "id": "intro",                 unique string
//     "title": "Signal Lost",        short label
//     "videoUrl": "/media/…mp4",     local path or full cloud URL
//     "isEndingNode": false,
//     "endingType": null,            "GOOD" | "BAD" | null (sets the ending screen colour)
//     "endingName": "",              optional custom headline for the ending screen
//     "next": null,                  optional: continue straight to this node with NO choice
//     "freezeAt": null,              optional seconds: freeze + vote here instead of at clip end
//     "choices": ["room", "hall"],   [Choice A (left) target, Choice B (right) target]; null = unused
//     "choiceALabel": "ENTER THE ROOM",
//     "choiceBLabel": "RUN AWAY",
//     "position": { "x": 0, "y": 0 } editor layout only
//   }]
// }

export const MAX_CHOICES = 2;
export const ENDING_TYPES = ['GOOD', 'BAD'];

export function indexNodes(story) {
  return new Map((story?.nodes || []).filter((n) => n && n.id).map((n) => [n.id, n]));
}

/** Continue link (plays straight into another clip without a choice), or null. */
export function nextTarget(node) {
  if (!node || node.isEndingNode) return null;
  return typeof node.next === 'string' && node.next ? node.next : null;
}

/** Choices that actually lead somewhere: [{ index, label, targetId }]. */
export function liveChoices(node) {
  if (!node || node.isEndingNode || nextTarget(node)) return [];
  const labels = [node.choiceALabel, node.choiceBLabel];
  return (Array.isArray(node.choices) ? node.choices : [])
    .slice(0, MAX_CHOICES)
    .map((targetId, index) => ({
      index,
      targetId,
      label: String(labels[index] || '').trim() || (index === 0 ? 'OPTION A' : 'OPTION B'),
    }))
    .filter((c) => typeof c.targetId === 'string' && c.targetId);
}

export function normalizeFreezeAt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Returns { errors: string[], warnings: string[] }. Errors block saving / playing. */
export function validateStory(story) {
  const errors = [];
  const warnings = [];
  if (!story || typeof story !== 'object') return { errors: ['Story is not a JSON object'], warnings };
  if (!Array.isArray(story.nodes)) return { errors: ['Missing "nodes" array'], warnings };
  if (story.nodes.length === 0) errors.push('Story has no nodes');

  const ids = new Set();
  for (const n of story.nodes) {
    if (!n || typeof n.id !== 'string' || !n.id.trim()) {
      errors.push('A node is missing a string "id"');
      continue;
    }
    if (ids.has(n.id)) errors.push(`Duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  if (!ids.has(story.startNodeId)) errors.push(`Start node "${story.startNodeId ?? ''}" does not exist`);

  for (const n of story.nodes) {
    if (!n?.id) continue;
    const name = `"${n.title || n.id}"`;
    const choices = Array.isArray(n.choices) ? n.choices : [];
    if (!n.videoUrl) warnings.push(`${name} has no video`);
    if (choices.length > MAX_CHOICES) errors.push(`${name} has more than ${MAX_CHOICES} choices`);
    if (n.freezeAt !== null && n.freezeAt !== undefined && n.freezeAt !== '' && normalizeFreezeAt(n.freezeAt) === null) {
      errors.push(`${name} freezeAt must be a number of seconds`);
    }

    if (n.isEndingNode) {
      if (!ENDING_TYPES.includes(n.endingType)) errors.push(`${name} is an ending but endingType is not GOOD or BAD`);
      if (choices.some(Boolean)) warnings.push(`${name} is an ending, so its choices are ignored`);
      continue;
    }

    const next = nextTarget(n);
    if (next) {
      if (!ids.has(next)) errors.push(`${name} continues to missing node "${next}"`);
      if (next === n.id) errors.push(`${name} continues into itself (infinite loop)`);
      continue;
    }

    const live = choices.filter(Boolean);
    if (live.length === 0) errors.push(`${name} is a dead end: not an ending, no choices and no continue link`);
    if (live.length === 1) warnings.push(`${name} has one choice, so it auto-advances without a vote`);
    choices.forEach((target, i) => {
      if (!target) return;
      const letter = i === 0 ? 'A' : 'B';
      if (!ids.has(target)) errors.push(`${name} choice ${letter} points to missing node "${target}"`);
      if (target === n.id) warnings.push(`${name} choice ${letter} loops back to itself`);
      const label = i === 0 ? n.choiceALabel : n.choiceBLabel;
      if (live.length > 1 && !String(label || '').trim()) warnings.push(`${name} choice ${letter} has no label`);
    });
  }

  if (ids.has(story.startNodeId)) {
    const map = indexNodes(story);
    const seen = new Set();
    const stack = [story.startNodeId];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const node = map.get(id);
      if (!node || node.isEndingNode) continue;
      const next = nextTarget(node);
      const outs = next ? [next] : node.choices || [];
      for (const t of outs) if (t && map.has(t)) stack.push(t);
    }
    for (const id of ids) if (!seen.has(id)) warnings.push(`"${map.get(id).title || id}" is unreachable from the start`);
    if (![...seen].some((id) => map.get(id)?.isEndingNode)) errors.push('No ending can be reached from the start node');
  }

  return { errors, warnings };
}
