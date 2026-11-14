import fs from 'node:fs/promises';
import { validateStory } from '../shared/storyGraph.js';

export class StoryStore {
  constructor(file) {
    this.file = file;
    this.story = null;
  }

  async load() {
    const story = JSON.parse(await fs.readFile(this.file, 'utf8'));
    const { errors, warnings } = validateStory(story);
    if (errors.length) console.warn(`[story] ${this.file} has errors:\n  - ${errors.join('\n  - ')}`);
    if (warnings.length) console.warn(`[story] warnings:\n  - ${warnings.join('\n  - ')}`);
    this.story = story;
    return story;
  }

  get() {
    return this.story;
  }

  /** Validates, then writes atomically. Running games keep the graph they started with. */
  async save(story) {
    const result = validateStory(story);
    if (result.errors.length) return { ok: false, ...result };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(story, null, 2)}\n`);
    await fs.rename(tmp, this.file);
    this.story = story;
    return { ok: true, ...result };
  }
}
