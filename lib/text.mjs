// Small text and date helpers shared by ingestion, retrieval and the answer step.
import crypto from 'node:crypto';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been',
  'it', 'its', 'this', 'that', 'you', 'your', 'i', 'im', 'my', 'me', 'do', 'does', 'did', 'can', 'could', 'will',
  'would', 'should', 'have', 'has', 'had', 'at', 'by', 'from', 'as', 'if', 'not', 'no', 'so', 'up', 'out', 'about',
  'what', 'how', 'when', 'who', 'which', 'there', 'their', 'they', 'them', 'we', 'our', 'us', 'any', 'all', 'more',
  'most', 'some', 'than', 'then', 'into', 'just', 'also', 'only', 'get', 'got', 'am', 'being',
]);

// A deliberately simple suffix stripper ("expires", "expired", "expiring" -> "expir").
// Good enough for a 24-document pack; a real system would use a proper stemmer or embeddings.
export function stem(word) {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);

  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);

  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.filter(w => !STOP_WORDS.has(w)).map(stem);
}

export function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

// Share of words two sentences have in common (0 = nothing, 1 = identical). Used to avoid repeating ourselves.
export function wordOverlap(a, b) {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));
  const shared = [...wordsA].filter(w => wordsB.has(w)).length;
  const total = wordsA.size + wordsB.size - shared;
  return total === 0 ? 0 : shared / total;
}

// Hash of the text with whitespace normalized, so formatting differences don't hide duplicates.
export function contentHash(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

const toDate = iso => new Date(`${iso}T00:00:00Z`);

export function daysBetween(fromIso, toIso) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((toDate(toIso) - toDate(fromIso)) / msPerDay);
}

export function monthsBetween(fromIso, toIso) {
  const from = toDate(fromIso), to = toDate(toIso);
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1; // not a full month yet
  return months;
}

// Minimal CSV parser: handles quoted fields and "" escapes, which search_queries.csv uses.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }

  const [header, ...body] = rows.filter(r => r.some(Boolean));
  return body.map(r => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ''])));
}
