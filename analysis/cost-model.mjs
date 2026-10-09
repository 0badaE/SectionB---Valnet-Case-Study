// Section C3: monthly model + embedding spend for the C2 plan, compared with all-Tier-M and all-Tier-L.
//   node analysis/cost-model.mjs
// Prices and the token profile are the brief's; every other number is an assumption named below.

const PRICES = {                       // $ per 1M tokens
  S: { input: 0.25, output: 1.25 },
  M: { input: 3.0, output: 15.0 },
  L: { input: 15.0, output: 75.0 },
};
const CACHED_SHARE = 0.10;             // cached input costs 10% of the tier's input price
const EMBED_PRICE = 0.10;
const BUDGET = 3500;

const TURNS = 480_000;                 // 40,000 users x 3 sessions x 4 turns

// One full-path turn (brief): 900 cacheable system + 600 history + 1,750 context + 60 user = 3,310 in, 250 out.
const FULL_TURN = { cached: 900, uncached: 600 + 1750 + 60, output: 250 };
const QUERY_EMBED_TOKENS = 80;
const CORPUS_REFRESH_TOKENS = 20_000 * 1_200 * 0.10;   // 10% of 24M tokens re-embedded monthly

// --- Assumptions added by the C2 plan ---
const ROUTER_CALL = { cached: 300, uncached: 160, output: 20 };   // instructions cached; message + last exchange; short JSON label
const ESCALATION_RATE = 0.05;          // share of Tier S answers that fail the output check and are regenerated on Tier M
const JUDGE_CALL = { cached: 600, uncached: 2100, output: 200 };  // rubric cached; question + context + answer; verdict
const GOLDEN_SET = 300, GOLDEN_RUNS_PER_MONTH = 4;                // weekly content updates
const PROD_SAMPLE_RATE = 0.005;        // 0.5% of live turns judged weekly

function callCost(tier, { cached, uncached, output }) {
  const p = PRICES[tier];
  return (cached * p.input * CACHED_SHARE + uncached * p.input + output * p.output) / 1e6;
}
const embedCost = tokens => tokens * EMBED_PRICE / 1e6;
const usd = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdPrecise = n => '$' + n.toFixed(5);   // for per-call costs, which are fractions of a cent

// Traffic mix from C1 (measured on search), plus a chat-adjusted scenario with personalized at 25%.
const MIXES = {
  'measured (C1)': { faq: 0.788, personalized: 0.088, crisis: 0.007, sensitiveFollowUp: 0.039, noModel: 0.077 },
  'chat-adjusted': { faq: 0.626, personalized: 0.250, crisis: 0.007, sensitiveFollowUp: 0.039, noModel: 0.077 },
};

function planCost(mix, turns) {
  const perTurn = { S: callCost('S', FULL_TURN), M: callCost('M', FULL_TURN) };
  const retrievalTurns = turns * (mix.faq + mix.personalized + mix.sensitiveFollowUp);
  const goldenAnswerCost = 0.8 * perTurn.S + 0.2 * perTurn.M;      // generating the golden-set answers to grade
  const lines = {
    'Router + safety classifier (S, every turn)': turns * callCost('S', ROUTER_CALL),
    'FAQ answers (S)': turns * mix.faq * perTurn.S,
    'Escalations, S -> M regeneration': turns * mix.faq * ESCALATION_RATE * perTurn.M,
    'Personalized / multi-step answers (M)': turns * mix.personalized * perTurn.M,
    'Sensitive safe follow-up (S)': turns * mix.sensitiveFollowUp * perTurn.S,
    'Crisis, out of scope, junk (no model)': 0,
    'Query embeddings': embedCost(retrievalTurns * QUERY_EMBED_TOKENS),
    'Corpus refresh embeddings': embedCost(CORPUS_REFRESH_TOKENS),
    'Offline eval: golden set, Tier L judge': GOLDEN_RUNS_PER_MONTH * GOLDEN_SET * (callCost('L', JUDGE_CALL) + goldenAnswerCost),
    'Offline eval: production sample, Tier M judge': turns * PROD_SAMPLE_RATE * callCost('M', JUDGE_CALL),
  };
  return { lines, total: Object.values(lines).reduce((a, b) => a + b, 0) };
}

function baselineCost(tier, turns) {
  return turns * callCost(tier, FULL_TURN) + embedCost(turns * QUERY_EMBED_TOKENS) + embedCost(CORPUS_REFRESH_TOKENS);
}

// ---- Report ----
console.log('Per full-path turn:', ['S', 'M', 'L'].map(t => `${t} ${usdPrecise(callCost(t, FULL_TURN))}`).join(' · '),
  `· router call ${usdPrecise(callCost('S', ROUTER_CALL))} · judge L ${usdPrecise(callCost('L', JUDGE_CALL))} / M ${usdPrecise(callCost('M', JUDGE_CALL))}`);

for (const [name, mix] of Object.entries(MIXES)) {
  const { lines, total } = planCost(mix, TURNS);
  console.log(`\n=== Plan, ${name} mix, ${TURNS.toLocaleString()} turns ===`);
  for (const [label, cost] of Object.entries(lines)) console.log(`  ${label.padEnd(48)} ${usd(cost).padStart(10)}`);
  console.log(`  ${'TOTAL'.padEnd(48)} ${usd(total).padStart(10)}  (${(100 * total / BUDGET).toFixed(0)}% of ${usd(BUDGET)})`);
}

console.log('\n=== Baselines (same token profile and caching, every turn on one tier) ===');
for (const tier of ['M', 'L']) {
  const total = baselineCost(tier, TURNS);
  console.log(`  All Tier ${tier}: ${usd(total)}  (${(100 * total / BUDGET).toFixed(0)}% of budget)`);
}
const noCacheM = TURNS * (3310 * PRICES.M.input + 250 * PRICES.M.output) / 1e6;
console.log(`  (All Tier M without prompt caching: ${usd(noCacheM)})`);

console.log('\n=== Usage doubles (960,000 turns) ===');
for (const [name, mix] of Object.entries(MIXES)) {
  const { total } = planCost(mix, TURNS * 2);
  console.log(`  Plan, ${name}: ${usd(total)}  (${(100 * total / BUDGET).toFixed(0)}% of budget)`);
}

// First change if usage doubles: personalized questions whose logic a calculator already computed go to Tier S.
const CALCULATOR_SHARE = 0.5;
const doubled = planCost(MIXES['chat-adjusted'], TURNS * 2);
const moved = TURNS * 2 * MIXES['chat-adjusted'].personalized * CALCULATOR_SHARE;
const saving = moved * (callCost('M', FULL_TURN) - callCost('S', FULL_TURN));
console.log(`  Lever: send calculator-answered personalized turns to S (${(CALCULATOR_SHARE * 100)}% of them, ${moved.toLocaleString()} turns):`
  + ` saves ${usd(saving)} -> ${usd(doubled.total - saving)} (${(100 * (doubled.total - saving) / BUDGET).toFixed(0)}% of budget)`);
