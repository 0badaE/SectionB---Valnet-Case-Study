// Section C3: monthly model + embedding spend for the C2 plan, compared with all-Tier-M and all-Tier-L.
//   node analysis/cost-model.mjs
// Prices and the token profile come from the brief. Every other number is an assumption, named below.

// ---------------------------------------------------------------------------
// From the brief
// ---------------------------------------------------------------------------
const PRICE_PER_1M = {
  S: { input: 0.25, output: 1.25 },
  M: { input: 3.0, output: 15.0 },
  L: { input: 15.0, output: 75.0 },
};
const CACHED_INPUT_DISCOUNT = 0.10;    // cached input costs 10% of the tier's input price
const EMBEDDING_PRICE_PER_1M = 0.10;
const BUDGET = 3500;
const TURNS_PER_MONTH = 40_000 * 3 * 4; // users x sessions x turns = 480,000

// One full-path turn: 900 cacheable system prompt; 600 history + 1,750 retrieved context + 60 user message; 250 output.
const FULL_TURN = { cached: 900, uncached: 600 + 1750 + 60, output: 250 };
const QUERY_EMBEDDING_TOKENS = 80;
const CORPUS_REFRESH_TOKENS = 20_000 * 1_200 * 0.10;   // 10% of a 24M-token corpus re-embedded each month

// ---------------------------------------------------------------------------
// Assumptions added by the C2 plan
// ---------------------------------------------------------------------------
const ROUTER_CALL = { cached: 300, uncached: 160, output: 20 };   // cached instructions; message + last exchange; JSON label
const ESCALATION_RATE = 0.05;          // Tier S answers that fail the output check and are regenerated on Tier M
const JUDGE_CALL = { cached: 600, uncached: 2100, output: 200 };  // cached rubric; question + context + answer; verdict
const GOLDEN_SET_SIZE = 300;
const GOLDEN_RUNS_PER_MONTH = 4;       // one per weekly content update
const GOLDEN_SET_SHARE_ON_M = 0.2;     // the golden set's answers are generated too: ~80% FAQ (S), ~20% personalized (M)
const PRODUCTION_SAMPLE_RATE = 0.005;  // share of live turns judged each month
const CALCULATOR_SHARE = 0.5;          // personalized turns a deterministic calculator already answers (lever if usage doubles)

// Traffic mix from C1: exact query counts out of 4,000. The chat-adjusted scenario moves FAQ traffic to
// personalized until personalized is 25%, because chat users add personal context that search queries don't.
const C1_COUNTS = { faq: 3152, personalized: 352, crisis: 28, sensitiveFollowUp: 46 + 113, noModel: 108 + 201 };
const C1_TOTAL = 4000;
const measured = Object.fromEntries(Object.entries(C1_COUNTS).map(([k, n]) => [k, n / C1_TOTAL]));
const MIXES = {
  'measured (C1)': measured,
  'chat-adjusted': { ...measured, personalized: 0.25, faq: measured.faq - (0.25 - measured.personalized) },
};
for (const [name, mix] of Object.entries(MIXES)) {
  const sum = Object.values(mix).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`${name} mix sums to ${sum}, not 1`);
}

// ---------------------------------------------------------------------------
// Cost functions
// ---------------------------------------------------------------------------
function callCost(tier, { cached, uncached, output }) {
  const price = PRICE_PER_1M[tier];
  return (cached * price.input * CACHED_INPUT_DISCOUNT + uncached * price.input + output * price.output) / 1e6;
}
const embeddingCost = tokens => tokens * EMBEDDING_PRICE_PER_1M / 1e6;
const turnCost = tier => callCost(tier, FULL_TURN);

function planCost(mix, turns) {
  const retrievalTurns = turns * (mix.faq + mix.personalized + mix.sensitiveFollowUp);
  const goldenAnswerCost = (1 - GOLDEN_SET_SHARE_ON_M) * turnCost('S') + GOLDEN_SET_SHARE_ON_M * turnCost('M');
  const lines = [
    ['Router + safety classifier (S, every turn)', turns * callCost('S', ROUTER_CALL)],
    ['FAQ answers (S)', turns * mix.faq * turnCost('S')],
    ['Escalations, S -> M regeneration', turns * mix.faq * ESCALATION_RATE * turnCost('M')],
    ['Personalized / multi-step answers (M)', turns * mix.personalized * turnCost('M')],
    ['Sensitive safe follow-up (S)', turns * mix.sensitiveFollowUp * turnCost('S')],
    ['Crisis, out of scope, junk (no model)', 0],
    ['Query embeddings', embeddingCost(retrievalTurns * QUERY_EMBEDDING_TOKENS)],
    ['Corpus refresh embeddings', embeddingCost(CORPUS_REFRESH_TOKENS)],
    ['Offline eval: golden set, Tier L judge', GOLDEN_RUNS_PER_MONTH * GOLDEN_SET_SIZE * (callCost('L', JUDGE_CALL) + goldenAnswerCost)],
    ['Offline eval: production sample, Tier M judge', turns * PRODUCTION_SAMPLE_RATE * callCost('M', JUDGE_CALL)],
  ];
  return { lines, total: lines.reduce((sum, [, cost]) => sum + cost, 0) };
}

function singleTierCost(tier, turns, { cached = true } = {}) {
  const turn = cached ? FULL_TURN : { cached: 0, uncached: FULL_TURN.cached + FULL_TURN.uncached, output: FULL_TURN.output };
  return turns * callCost(tier, turn) + embeddingCost(turns * QUERY_EMBEDDING_TOKENS) + embeddingCost(CORPUS_REFRESH_TOKENS);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const usd = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdPrecise = n => '$' + n.toFixed(5);   // per-call costs are fractions of a cent
const ofBudget = n => `${(100 * n / BUDGET).toFixed(0)}% of budget`;

console.log('Per full-path turn:', ['S', 'M', 'L'].map(t => `${t} ${usdPrecise(turnCost(t))}`).join(' · '),
  `· router call ${usdPrecise(callCost('S', ROUTER_CALL))}`,
  `· judge L ${usdPrecise(callCost('L', JUDGE_CALL))} / M ${usdPrecise(callCost('M', JUDGE_CALL))}`);

for (const [name, mix] of Object.entries(MIXES)) {
  const { lines, total } = planCost(mix, TURNS_PER_MONTH);
  console.log(`\n=== Plan, ${name} mix, ${TURNS_PER_MONTH.toLocaleString()} turns ===`);
  for (const [label, cost] of lines) console.log(`  ${label.padEnd(48)} ${usd(cost).padStart(10)}`);
  console.log(`  ${'TOTAL'.padEnd(48)} ${usd(total).padStart(10)}  (${ofBudget(total)})`);
}

console.log('\n=== Baselines (same token profile and caching, every turn on one tier) ===');
for (const tier of ['M', 'L']) {
  const total = singleTierCost(tier, TURNS_PER_MONTH);
  console.log(`  All Tier ${tier}: ${usd(total)}  (${ofBudget(total)})`);
}
console.log(`  (All Tier M without prompt caching: ${usd(singleTierCost('M', TURNS_PER_MONTH, { cached: false }))})`);

console.log('\n=== Usage doubles (960,000 turns) ===');
for (const [name, mix] of Object.entries(MIXES)) {
  const { total } = planCost(mix, TURNS_PER_MONTH * 2);
  console.log(`  Plan, ${name}: ${usd(total)}  (${ofBudget(total)})`);
}

// First change if usage doubles: personalized turns that a calculator already answered move from Tier M to Tier S.
const doubledChat = planCost(MIXES['chat-adjusted'], TURNS_PER_MONTH * 2);
const turnsMoved = TURNS_PER_MONTH * 2 * MIXES['chat-adjusted'].personalized * CALCULATOR_SHARE;
const saving = turnsMoved * (turnCost('M') - turnCost('S'));
console.log(`  Lever: send calculator-answered personalized turns to S (${CALCULATOR_SHARE * 100}% of them, ${turnsMoved.toLocaleString()} turns):`
  + ` saves ${usd(saving)} -> ${usd(doubledChat.total - saving)} (${ofBudget(doubledChat.total - saving)})`);
