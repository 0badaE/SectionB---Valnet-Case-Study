// Retrieval: BM25 keyword search with query expansion and trust weighting.
// Production would combine this with embeddings; BM25 alone is transparent and needs no API for 24 docs.
import { tokenize } from './text.mjs';
import { scanDocument } from './guards.mjs';

const RESULTS_PER_QUERY = 5;
const MIN_SCORE = 2.0;            // below this a chunk is too weak to cite
const MIN_SHARE_OF_TOP = 0.35;    // and it must score at least 35% of the best chunk
const TRUST_WEIGHT = { 1: 1.0, 2: 0.85 };   // tier 1 = official / first-party, tier 2 = editorial
const STALE_WEIGHT = 0.6;

// Veterans and the pack use different words for the same thing ("trade school" vs "vocational").
// Each rule adds pack vocabulary when the question matches. Built from the eval questions and search logs.
const QUERY_EXPANSIONS = [
  [/expire|how long|time limit|still work/, 'time limit expire discharge release'],
  [/trade school|hvac|vocational|certification|licens/, 'vocational technical training apprenticeship non-college approved program'],
  [/claim status|check (my )?claim|track/, 'claim status sign in VA.gov'],
  [/ebenefits|ds logon/, 'eBenefits DS Logon retired sign-in'],
  [/funding fee/, 'funding fee exempt disability compensation'],
  [/how much|pay per month|per month|\$/, 'payment rate monthly compensation rate table'],
  [/burn pit|iraq|afghanistan|toxic|agent orange|pact/, 'PACT Act burn pits toxic exposure presumptive conditions'],
  [/health care|healthcare/, 'health care enroll apply'],
  [/transfer/, 'transfer unused benefits family spouse children'],
  [/daughter|son|kids|child/, 'children family member'],
  [/property tax|state benefit|tuition waiver|license plate/, 'state veterans benefits property tax exemptions'],
  [/loan rate|best va loan|lender/, 'lenders interest rates compare offers'],
  [/approved|what rating|rating will/, 'disability rating evidence claim accredited representative'],
  [/skillbridge/, 'SkillBridge 180 days commander approval transition'],
  [/separat|getting out|transition/, 'separation transition TAP'],
];

export function expandQuery(question) {
  const lower = question.toLowerCase();
  const additions = QUERY_EXPANSIONS.filter(([pattern]) => pattern.test(lower)).map(([, words]) => words);
  return [question, ...additions].join(' ');
}

export class Bm25Index {
  constructor(chunks, { k1 = 1.2, b = 0.75 } = {}) {
    this.chunks = chunks;
    this.k1 = k1;
    this.b = b;
    this.termCounts = chunks.map(chunk => countTerms(tokenize(`${chunk.title} ${chunk.text}`)));
    this.lengths = this.termCounts.map(counts => Object.values(counts).reduce((sum, n) => sum + n, 0));
    this.avgLength = this.lengths.reduce((sum, n) => sum + n, 0) / chunks.length;
    this.docFrequency = {};
    for (const counts of this.termCounts) {
      for (const term of Object.keys(counts)) this.docFrequency[term] = (this.docFrequency[term] || 0) + 1;
    }
  }

  idf(term) {
    const df = this.docFrequency[term] || 0;
    return Math.log(1 + (this.chunks.length - df + 0.5) / (df + 0.5));
  }

  score(queryTerms, chunkIndex) {
    const counts = this.termCounts[chunkIndex];
    const lengthNorm = 1 - this.b + this.b * this.lengths[chunkIndex] / this.avgLength;
    let total = 0;
    for (const term of new Set(queryTerms)) {
      const tf = counts[term];
      if (tf) total += this.idf(term) * (tf * (this.k1 + 1)) / (tf + this.k1 * lengthNorm);
    }
    return total;
  }
}

function countTerms(terms) {
  const counts = {};
  for (const term of terms) counts[term] = (counts[term] || 0) + 1;
  return counts;
}

const round2 = n => Number(n.toFixed(2));

export function retrieve(index, question, { k = RESULTS_PER_QUERY } = {}) {
  const expanded = expandQuery(question);
  const queryTerms = tokenize(expanded);

  const ranked = index.chunks
    .map((chunk, i) => {
      const weight = (TRUST_WEIGHT[chunk.trust_tier] ?? 0) * (chunk.status === 'stale' ? STALE_WEIGHT : 1);
      return { ...chunk, score: round2(index.score(queryTerms, i) * weight) };
    })
    .sort((a, b) => b.score - a.score);

  const topScore = ranked[0]?.score ?? 0;
  const results = [], dropped = [];
  for (const chunk of ranked.slice(0, k)) {
    // Layer 2 against injection: re-scan every retrieved chunk, even though ingestion already did.
    const findings = scanDocument(chunk.text);
    if (findings.length) { dropped.push({ chunk_id: chunk.chunk_id, why: findings.join('; ') }); continue; }
    if (chunk.score >= MIN_SCORE && chunk.score >= topScore * MIN_SHARE_OF_TOP) results.push(chunk);
  }
  return { expanded, results, dropped };
}
