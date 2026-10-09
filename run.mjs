// Answers the 15 eval questions, checks each against eval/expected.json, and writes the reports to out/.
//   node run.mjs
import fs from 'node:fs';
import { loadAssistant, readJson, ROOT } from './lib/assistant.mjs';
import { ingestReport, answersReport } from './lib/report.mjs';
import { parseCsv } from './lib/text.mjs';
import { checkAgainstExpected } from './eval/check-answer.mjs';

const assistant = loadAssistant();
const questions = parseCsv(fs.readFileSync(ROOT + 'data/eval_questions.csv', 'utf8'));
const expected = readJson('eval/expected.json');

const results = questions.map(({ q_id, persona_id, question }) => {
  const reply = assistant.ask(question, persona_id);
  return { q_id, persona_id, ...reply, failures: checkAgainstExpected(reply, expected[q_id]) };
});

const OUT = ROOT + 'out/';
fs.mkdirSync(OUT + 'prompts', { recursive: true });
for (const r of results) {
  if (r.prompt) fs.writeFileSync(`${OUT}prompts/${r.q_id}.json`, JSON.stringify(r.prompt, null, 2));
}
fs.writeFileSync(OUT + 'answers.json', JSON.stringify(results, null, 2));
fs.writeFileSync(OUT + 'answers.md', answersReport(results, assistant.personas, assistant.asOf));
fs.writeFileSync(OUT + 'ingest_report.md', ingestReport(assistant.docs, assistant.chunks, assistant.asOf));
fs.writeFileSync(OUT + 'index.json', JSON.stringify(assistant.chunks, null, 1));

for (const r of results) {
  const status = r.failures.length ? 'FAIL' : 'pass';
  const detail = r.failures.length ? `  <- ${r.failures.join('; ')}` : '';
  console.log(`${r.q_id} ${status}  ${r.trace.route.padEnd(18)} cites=${r.citations.join(',') || '-'}${detail}`);
}
const passed = results.filter(r => r.failures.length === 0).length;
console.log(`\n${passed}/${results.length} pass · wrote out/answers.md, out/ingest_report.md, out/prompts/`);
process.exitCode = passed === results.length ? 0 : 1;
