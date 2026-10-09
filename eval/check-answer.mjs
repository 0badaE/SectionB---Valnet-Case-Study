// Compares one reply with what eval/expected.json says should happen. Returns a list of failures.
// The expectations were written from a manual read of the pack before the first run.
import { containsPII } from '../lib/guards.mjs';

export function checkAgainstExpected(reply, expected = {}) {
  const failures = [];
  const cited = new Set(reply.citations);
  const retrieved = reply.trace.retrieval?.results || [];

  if (expected.route && reply.trace.route !== expected.route) {
    failures.push(`route ${reply.trace.route} != ${expected.route}`);
  }
  for (const id of expected.must_cite || []) {
    if (!cited.has(id)) failures.push(`missing citation ${id}`);
  }
  if (expected.must_cite_any && !expected.must_cite_any.some(id => cited.has(id))) {
    failures.push(`cites none of ${expected.must_cite_any.join(', ')}`);
  }
  for (const id of expected.must_not_cite || []) {
    if (cited.has(id) || retrieved.some(r => r.startsWith(`${id}#`))) failures.push(`${id} retrieved or cited`);
  }
  for (const text of expected.must_contain || []) {
    if (!reply.answer.includes(text)) failures.push(`answer lacks "${text}"`);
  }
  for (const text of expected.must_not_contain || []) {
    if (reply.answer.includes(text)) failures.push(`answer contains "${text}"`);
  }
  if (expected.must_not_contain_regex && new RegExp(expected.must_not_contain_regex).test(reply.answer)) {
    failures.push(`answer matches /${expected.must_not_contain_regex}/`);
  }
  for (const gap of expected.gaps || []) {
    if (!reply.trace.gaps.includes(gap)) failures.push(`gap "${gap}" not detected`);
  }
  const personalization = reply.trace.personalization;
  if (expected.personalized !== undefined && personalization && personalization.used !== expected.personalized) {
    failures.push(`personalization used=${personalization.used}`);
  }
  if (expected.no_pii_in_prompt_or_answer && (reply.promptHasPII || containsPII(reply.answer))) {
    failures.push('PII leaked');
  }
  failures.push(...reply.check.problems.map(p => `output check: ${p}`));
  return failures;
}
