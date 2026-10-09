// Ask one question as one of the test personas:
//   node ask.mjs P1 "How long do I have to use my GI Bill?"
//   node ask.mjs P1 "How long do I have to use my GI Bill?" --trace   (show how the answer was produced)
import { loadAssistant } from './lib/assistant.mjs';

const args = process.argv.slice(2);
const showTrace = args.includes('--trace');
const [personaId, ...words] = args.filter(arg => arg !== '--trace');

const assistant = loadAssistant();

if (!assistant.personas[personaId] || words.length === 0) {
  console.log('Usage: node ask.mjs <persona> "<question>" [--trace]\n\nPersonas:');
  for (const p of Object.values(assistant.personas)) {
    console.log(`  ${p.persona_id}  ${p.display_name.padEnd(7)} ${p.branch ?? '-'}, personalization ${p.personalization_opt_in ? 'on' : 'off'}`);
  }
  process.exit(1);
}

const reply = assistant.ask(words.join(' '), personaId);
console.log(`\n${reply.answer}\n`);
console.log(`Citations: ${reply.citations.join(', ') || 'none'} · route: ${reply.trace.route}`);
if (showTrace) console.log(`\n${JSON.stringify(reply.trace, null, 2)}`);
