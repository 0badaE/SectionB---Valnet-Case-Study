// Builds the assistant once: ingest the pack, index it, load personas. Used by run.mjs, ask.mjs and the tests.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ingest } from './ingest.mjs';
import { Bm25Index } from './retrieve.mjs';
import { answerMessage } from './pipeline.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const readJson = file => JSON.parse(fs.readFileSync(ROOT + file, 'utf8'));

export function loadAssistant() {
  const rules = readJson('pack_rules.json');
  const { docs, chunks } = ingest(ROOT + 'data/knowledge_pack', rules);
  const index = new Bm25Index(chunks);
  const personas = Object.fromEntries(readJson('data/personas.json').personas.map(p => [p.persona_id, p]));

  return {
    asOf: rules.as_of,
    docs,
    chunks,
    personas,
    ask: (message, personaId) => answerMessage({ message, persona: personas[personaId], index, asOf: rules.as_of }),
  };
}
