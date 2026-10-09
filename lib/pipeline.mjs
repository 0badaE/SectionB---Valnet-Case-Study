// Answers one message. The steps run in this order, and each is commented where it happens:
//
//   BEFORE THE MODEL   1. crisis check (stops here)      2. remove personal identifiers
//                      3. injection check (stops here)   4. account lookups and outcome predictions
//                      5. personalization (D23)
//   RETRIEVAL          6. search the pack, or the benefits overview for "what am I eligible for?"
//   ANSWER             7. coverage gaps, calculators, supporting sentences (mocked generation)
//   AFTER THE MODEL    8. check the answer; replace it with a safe fallback if any check fails
import { detectCrisis, scrubPII, containsPII, isUserInjection, isAccountLookup, asksForOutcomePrediction, checkAnswer, citedDocIds } from './guards.mjs';
import { factsFromProfile, factsFromMessage, combineFacts, hiddenProfileValues } from './personalize.mjs';
import { retrieve } from './retrieve.mjs';
import { runCalculators } from './calculators.mjs';
import { findCoverageGaps } from './coverage.mjs';
import { pickSupportingSentences } from './mock-generator.mjs';
import { buildPrompt } from './prompt.mjs';
import { splitSentences } from './text.mjs';

// Fixed replies. The crisis texts are reviewed by a person, never generated.
const REPLIES = {
  crisisSelf: "I'm really glad you told me, and I'm sorry you're carrying this. You don't have to handle it alone. Please reach the Veterans Crisis Line right now: dial 988 and press 1, text 838255, or chat at VeteransCrisisLine.net. It's free, confidential and available 24/7 [D12]. If you are in immediate danger, call 911 [D12]. I'm here if you want to keep talking.",
  crisisOther: "Thank you for looking out for your buddy. Please contact the Veterans Crisis Line now: dial 988 and press 1, text 838255, or chat at VeteransCrisisLine.net. It's free, confidential and available 24/7, and family members and friends can use it too [D12]. If he is in immediate danger, call 911 [D12].",
  identifiersRemoved: "I removed the personal numbers you shared. Please don't post Social Security numbers or VA file numbers here; I don't need them and can't use them [D23].",
  injection: "I can't do that, but I'm happy to help with benefits, jobs or transition questions.",
  cannotLookUp: "I can't access VA accounts or look up claims, so I can't check this for you [D23]. Here's how to check it yourself:",
  cannotPredict: "I can't predict whether a claim will be approved or what rating you'll get, and I can't give medical advice about your condition.",
  cannotDetermineEligibility: "I can't determine which benefits you're eligible for; VA decides that based on your service and records. Here are the main areas to look at:",
  notCovered: "The knowledge pack doesn't cover this, so I can't answer it reliably.",
  profileNotUsed: "_I didn't use your saved profile because personalization is turned off. You can turn it on, or tell me about your service here._",
  fallback: "Sorry, I can't answer that reliably right now. For benefits questions, an accredited representative can help for free (VA.gov).",
};

// For "what VA benefits am I eligible for?": one line per benefit area instead of a guess.
const ASKS_WHAT_AM_I_ELIGIBLE_FOR = /what\s+(va\s+)?benefits\s+(am i|do i|can i)\b[^?]*\b(eligible|qualify|get)/i;
const BENEFIT_AREAS = [
  ['Education', 'Post-9/11 GI Bill education benefits'],
  ['Disability compensation', 'VA disability compensation monthly tax-free payment'],
  ['Health care', 'VA health care who can enroll'],
  ['Home loans', 'VA home loan guaranty'],
  ['Free help', 'accredited representatives VSOs free help with claims'],
];

// When we refuse to look up a claim, we still answer the safe version of the request.
const SELF_SERVICE_CLAIM_QUERY = 'how to check my claim status yourself on VA.gov';

export function answerMessage({ message, persona, index, asOf }) {
  const trace = { route: 'rag', guards: [], gaps: [], calculators: [] };
  const paragraphs = [];
  const citable = new Set();   // doc ids the answer is allowed to cite

  // 1. Crisis comes first: a fixed response, no retrieval and no model call.
  const crisis = detectCrisis(message);
  if (crisis) {
    trace.route = 'crisis';
    trace.guards.push(`crisis (${crisis.phrase})`);
    citable.add('D12');
    const answer = crisis.aboutSomeoneElse ? REPLIES.crisisOther : REPLIES.crisisSelf;
    return finalize({ message, answer, trace, citable, persona, prompt: null });
  }

  // 2. Remove identifiers before anything is logged or sent to a model.
  const { text: question, found: identifiers } = scrubPII(message);
  if (identifiers.length) {
    trace.guards.push(`PII redacted: ${identifiers.join(', ')}`);
    paragraphs.push(REPLIES.identifiersRemoved);
    citable.add('D23');
  }

  // 3. Attempts to override the assistant's instructions are refused outright.
  if (isUserInjection(question)) {
    trace.route = 'refuse_injection';
    trace.guards.push('user injection');
    return finalize({ message, answer: REPLIES.injection, trace, citable, persona, prompt: null });
  }

  // 4. Things the assistant must not do: open with a plain "I can't", then help with what it can.
  const isLookup = isAccountLookup(question, identifiers.length > 0);
  if (isLookup) {
    trace.route = 'capability_limit';
    trace.guards.push('account lookup');
    paragraphs.push(REPLIES.cannotLookUp);
    citable.add('D23');
  }
  if (asksForOutcomePrediction(question)) {
    trace.route = 'no_prediction';
    trace.guards.push('outcome prediction');
    paragraphs.push(REPLIES.cannotPredict);
  }

  // 5. Personalization: profile facts only with consent; what the user typed is always usable.
  const profile = factsFromProfile(persona, asOf);
  const facts = combineFacts(profile.facts, factsFromMessage(question));
  trace.personalization = { used: profile.used, note: profile.note, facts_sent: facts };

  // 6 + 7. Retrieve and compose.
  const { sources, computed } = ASKS_WHAT_AM_I_ELIGIBLE_FOR.test(question)
    ? answerWithOverview({ index, trace, paragraphs, citable })
    : answerFromPack({ question, isLookup, facts, index, asOf, trace, paragraphs, citable });

  const hasSavedProfile = persona && (persona.branch || persona.separation_date || persona.state);
  if (!profile.used && hasSavedProfile) paragraphs.push(REPLIES.profileNotUsed);

  const prompt = buildPrompt({ question, facts: profile.used ? facts : {}, sources, computed });
  return finalize({ message, answer: paragraphs.join('\n\n'), trace, citable, persona, prompt });
}

function answerWithOverview({ index, trace, paragraphs, citable }) {
  trace.route = 'broad_eligibility';
  const sources = [];
  paragraphs.push(REPLIES.cannotDetermineEligibility);

  for (const [area, query] of BENEFIT_AREAS) {
    const [best] = retrieve(index, query, { k: 1 }).results;
    if (!best) continue;
    sources.push(best);
    citable.add(best.doc_id);
    paragraphs.push(`- **${area}:** ${splitSentences(best.text)[0]} [${best.doc_id}]`);
  }
  trace.retrieval = { results: sources.map(s => `${s.chunk_id}:${s.score}`) };
  return { sources, computed: [] };
}

function answerFromPack({ question, isLookup, facts, index, asOf, trace, paragraphs, citable }) {
  const searchQuery = isLookup ? SELF_SERVICE_CLAIM_QUERY : question;
  const retrieval = retrieve(index, searchQuery);
  let sources = retrieval.results;

  // A guard reply cites the data policy (D23), so the model must be given D23 as a source too.
  if (citable.has('D23') && !sources.some(s => s.doc_id === 'D23')) {
    sources = [...sources, ...index.chunks.filter(c => c.doc_id === 'D23')];
  }
  for (const source of sources) citable.add(source.doc_id);
  trace.retrieval = {
    expanded: retrieval.expanded,
    results: sources.map(s => `${s.chunk_id}:${s.score}${s.status === 'stale' ? '(stale)' : ''}`),
    dropped_by_injection_scan: retrieval.dropped,
  };

  // What the pack can't answer is said first, plainly.
  const gaps = findCoverageGaps(question, sources, facts);
  trace.gaps = gaps.map(g => g.type);
  paragraphs.push(...gaps.map(g => g.notice));

  // Date and threshold logic is computed, not generated.
  const computed = runCalculators(question, facts, citable, asOf);
  trace.calculators = computed.map(c => c.id);
  paragraphs.push(...computed.map(c => c.text || c.ask));

  const followUps = gaps.filter(g => g.followUp).map(g => g.followUp);

  // Supporting sentences. Docs a calculator already cited are skipped so we don't say it twice, and
  // after a computed answer, extra sentences must be clearly on-topic (2+ words from the question).
  const support = pickSupportingSentences({
    question: searchQuery,
    expandedQuery: retrieval.expanded,
    sources,
    skipDocs: new Set(computed.flatMap(c => [c.source, ...citedDocIds(c.text || '')])),
    max: computed.length ? 2 : 3,
    minQuestionWords: computed.length ? 2 : 1,
    alreadySaid: [...paragraphs, ...followUps],
  });
  if (support.length) paragraphs.push((gaps.length ? 'What the pack does say: ' : '') + support.join(' '));
  if (!sources.length) {
    trace.route = 'not_covered';
    paragraphs.push(REPLIES.notCovered);
  }
  paragraphs.push(...followUps);

  // Flag older articles we actually quoted.
  const quoted = new Set(citedDocIds([...support, ...followUps].join(' ')));
  const staleQuoted = new Map(sources.filter(s => s.status === 'stale' && quoted.has(s.doc_id)).map(s => [s.doc_id, s]));
  for (const [docId, source] of staleQuoted) {
    paragraphs.push(`(Note: [${docId}] is an older article, last reviewed ${source.last_reviewed}; confirm current details with the office it names.)`);
  }

  return { sources, computed };
}

// 8. After the model: check the answer and the provider payload. Any problem -> safe fallback.
function finalize({ message, answer, trace, citable, persona, prompt }) {
  const check = checkAnswer(answer, { citableDocIds: citable, hiddenProfileValues: hiddenProfileValues(persona) });
  const promptHasPII = prompt !== null && containsPII(JSON.stringify(prompt));
  if (promptHasPII) check.problems.push('PII present in the payload sent to the provider');

  if (check.problems.length) {
    trace.blocked = check.problems;
    answer = REPLIES.fallback;
  }
  return { message, answer, citations: check.cited, check, promptHasPII, trace, prompt };
}
