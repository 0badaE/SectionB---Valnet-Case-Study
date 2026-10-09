// THE MOCKED STEP. In production a model writes the answer from the prompt in prompt.mjs.
// Here we pick the source sentences that best match the question, so the rest of the pipeline
// (retrieval, guards, citations, output checks) can be tested for real without an API.
import { tokenize, splitSentences, wordOverlap } from './text.mjs';

const MIN_DOC_SHARE = 0.6;        // a source must score at least 60% of the top source
const MIN_SENTENCE_SHARE = 0.6;   // a sentence must score at least 60% of the best sentence
const MIN_SENTENCE_SCORE = 3;
const MAX_PER_SOURCE = 2;
const REPEAT_THRESHOLD = 0.5;     // skip sentences that mostly repeat something already in the answer
const RANK_PENALTY = 0.5;         // prefer sentences from higher-ranked sources

// A word from the user's own question counts double; a word only from the query expansion counts once.
function scoreSentence(sentence, questionWords, expansionWords) {
  let score = 0, questionHits = 0;
  for (const word of new Set(tokenize(sentence))) {
    if (questionWords.has(word)) { score += 2; questionHits++; }
    else if (expansionWords.has(word)) score += 1;
  }
  return { score, questionHits };
}

export function pickSupportingSentences({ question, expandedQuery, sources, skipDocs, max, minQuestionWords, alreadySaid }) {
  const questionWords = new Set(tokenize(question));
  const expansionWords = new Set(tokenize(expandedQuery));
  const topSourceScore = sources[0]?.score ?? 0;

  const candidates = [];
  sources.forEach((source, rank) => {
    if (skipDocs.has(source.doc_id) || source.score < topSourceScore * MIN_DOC_SHARE) return;
    for (const sentence of splitSentences(source.text)) {
      const { score, questionHits } = scoreSentence(sentence, questionWords, expansionWords);
      if (score >= MIN_SENTENCE_SCORE && questionHits >= minQuestionWords) {
        candidates.push({ docId: source.doc_id, sentence, score: score - rank * RANK_PENALTY });
      }
    }
  });
  candidates.sort((a, b) => b.score - a.score);

  const bestScore = Math.max(0, ...candidates.map(c => c.score));
  const said = alreadySaid.flatMap(splitSentences);
  const perSource = {};
  const picked = [];

  for (const candidate of candidates) {
    if (picked.length >= max) break;
    if (candidate.score < bestScore * MIN_SENTENCE_SHARE) continue;
    if ((perSource[candidate.docId] || 0) >= MAX_PER_SOURCE) continue;
    if (said.some(s => wordOverlap(s, candidate.sentence) >= REPEAT_THRESHOLD)) continue;

    picked.push(candidate);
    said.push(candidate.sentence);
    perSource[candidate.docId] = (perSource[candidate.docId] || 0) + 1;
  }
  return picked.map(p => `${p.sentence} [${p.docId}]`);
}
