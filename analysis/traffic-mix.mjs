// Section C1: estimate the traffic mix from the 4,000 on-site search queries.
//   node analysis/traffic-mix.mjs
//
// Each query goes to the first bucket it matches, in this order:
//   junk -> sensitive -> out of scope -> personalized / multi-step -> simple FAQ -> unclassified
// Sensitive reuses the production guards from lib/guards.mjs, so we measure with the code we would ship.
import fs from 'node:fs';
import { ROOT } from '../lib/assistant.mjs';
import { parseCsv } from '../lib/text.mjs';
import { detectCrisis, containsPII, isUserInjection, asksForOutcomePrediction } from '../lib/guards.mjs';

const FILLER_PREFIX = /^(pls|please|hey|quick q|question:|need to know:)\s+/i;

function normalize(query) {
  return query.trim().replace(FILLER_PREFIX, '').toLowerCase().replace(/\s+/g, ' ').replace(/\?+$/, '').trim();
}

// Letters and digits only: "i goto ut in 2013" -> "igotoutin2013", so misplaced spaces don't matter.
const squash = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');

// The logs' typos are mostly one swapped pair of neighbouring letters ("waht", "skillbrdige").
// A keyword matches if it appears in the query as typed, or with any one neighbouring pair swapped back.
function withOneSwapUndone(squashed) {
  const variants = [squashed];
  for (let i = 0; i < squashed.length - 1; i++) {
    variants.push(squashed.slice(0, i) + squashed[i + 1] + squashed[i] + squashed.slice(i + 2));
  }
  return variants;
}
const matchesAny = (variants, keywords) => keywords.some(k =>
  variants.some(v => (k instanceof RegExp ? k.test(v) : v.includes(k))));

// ---- Bucket rules (keywords are squashed) ----
const JUNK = ['asdkjh', 'buyfollowers', 'freebitcoin', /^a{4,}$/];
const OUT_OF_SCOPE = ['deletemyaccount', 'updatemyemail', 'cancelnewsletter', 'resetmypassword'];
const OUTCOME_PREDICTION = ['whatratingwilliget', 'willmyclaimbeapproved'];
const PERSONALIZED = [
  'iseparatein',            // "can i do skillbridge i separate in 3 months"
  'igotoutin',              // "i got out in 2016 does my gi bill still work"
  /served\d+months/,        // "am i eligible for 100% gi bill, served 36 months"
  'iwasin',                 // "i was in iraq do i qualify for va health care"
  'whatjobsmatchmy',        // "what jobs match my 92Y experience and my Ohio location"
  'increasemyvaratingfrom', // "increase my va rating from 70%"
  /\d+vadisabilitypay/,     // "70% va disability pay per month"
];

// ---- FAQ topics, and whether the knowledge pack can answer them ----
// covered: the pack answers it; partial: the pack touches it but lacks the specifics; none: not in the pack.
const TOPICS = [
  ['GI Bill (eligibility, applying, expiry, transfer, uses)', 'covered', ['gibill', 'post911', 'forevergi']],
  ['VA claims (filing, status, intent to file, back pay, VSO, lawyer)', 'covered', ['claim', 'intenttofile', 'effectivedate', 'vso', 'lawyer', 'ebenefitslog']],   // not 'ebenefits': "statE BENEFITS" contains it
  ['VA health care and PACT Act', 'covered', ['healthcare', 'priority', 'copay', 'pactact', 'burnpit', 'agentorange']],
  ['Home loan rates and lenders', 'partial', ['loanrate', 'lender']],   // before home loans: "va loan rates" is a rates question
  ['VA home loans (requirements, COE, funding fee)', 'covered', ['valoan', 'homeloan', 'fundingfee', 'certificateofeligibility', 'downpayment']],
  ['Transition (TAP, SkillBridge)', 'covered', ['tapclass', 'skillbridge']],   // not 'tap': "retiremenTPAy" and "discounts aT APple" contain it
  ['Jobs and resumes', 'covered', ['job', 'resume', 'translate', 'employer', 'civilian']],
  ['Military discounts', 'partial', ['discount']],
  ['State benefits (property tax, tuition, plates)', 'partial', ['propertytax', 'tuitionwaiver', 'licenseplate', 'statebenefit', 'disabledveteranbenefit']],
  ['Crisis line number', 'covered', ['crisisline']],
  ['TRICARE, SGLI/VGLI, survivors, burial', 'none', ['tricare', 'sgli', 'vgli', 'survivor', 'burial', 'headstone']],
  ['Pay charts, retirement pay, ID cards, Space-A', 'none', ['dfas', 'paychart', 'retirementpay', 'idcard', 'spaceavailable']],
];

function classify(rawQuery) {
  const text = normalize(rawQuery);
  const variants = withOneSwapUndone(squash(text));

  if (isUserInjection(rawQuery)) return { bucket: 'junk', why: 'injection attempt' };
  if (matchesAny(variants, JUNK)) return { bucket: 'junk', why: 'spam or keyboard mash' };

  if (detectCrisis(rawQuery)) return { bucket: 'sensitive', why: 'crisis' };
  if (containsPII(rawQuery)) return { bucket: 'sensitive', why: 'personal identifier' };
  if (asksForOutcomePrediction(text) || matchesAny(variants, OUTCOME_PREDICTION)) return { bucket: 'sensitive', why: 'claim outcome / rating prediction' };

  if (matchesAny(variants, OUT_OF_SCOPE)) return { bucket: 'out_of_scope', why: 'account or site support' };
  if (matchesAny(variants, PERSONALIZED)) return { bucket: 'personalized', why: 'depends on the user\'s own facts' };

  const topic = TOPICS.find(([, , keywords]) => matchesAny(variants, keywords));
  if (topic) return { bucket: 'faq', why: topic[0], coverage: topic[1] };
  return { bucket: 'unclassified', why: 'no rule matched' };
}

// ---- Run ----
const rows = parseCsv(fs.readFileSync(`${ROOT}data/search_queries.csv`, 'utf8'));
const results = rows.map(row => ({ ...row, ...classify(row.query_text) }));

const BUCKETS = ['faq', 'personalized', 'sensitive', 'out_of_scope', 'junk', 'unclassified'];
const pct = (n, total) => `${(100 * n / total).toFixed(1)}%`;
const countBy = (list, key) => list.reduce((m, x) => m.set(x[key], (m.get(x[key]) || 0) + 1), new Map());

const total = results.length;
const byBucket = countBy(results, 'bucket');
const uniqueByBucket = new Map(BUCKETS.map(b => [b, new Set(results.filter(r => r.bucket === b).map(r => normalize(r.query_text))).size]));

const lines = ['# C1 traffic mix (search_queries.csv)', '', `${total} queries, ${new Set(results.map(r => r.session_id)).size} sessions.`, '',
  '| Bucket | Queries | Share | Unique phrasings | Logged in |', '|---|---|---|---|---|'];
for (const b of BUCKETS) {
  const inBucket = results.filter(r => r.bucket === b);
  const loggedIn = inBucket.filter(r => r.logged_in === '1').length;
  lines.push(`| ${b} | ${inBucket.length} | ${pct(inBucket.length, total)} | ${uniqueByBucket.get(b)} | ${inBucket.length ? pct(loggedIn, inBucket.length) : '-'} |`);
}

lines.push('', '## Why (reason within each bucket)', '', '| Bucket | Reason | Queries | Share of all |', '|---|---|---|---|');
for (const b of BUCKETS) {
  for (const [why, n] of [...countBy(results.filter(r => r.bucket === b), 'why')].sort((x, y) => y[1] - x[1])) {
    lines.push(`| ${b} | ${why} | ${n} | ${pct(n, total)} |`);
  }
}

const faq = results.filter(r => r.bucket === 'faq');
lines.push('', '## Can the knowledge pack answer the FAQ traffic?', '', '| Pack coverage | Queries | Share of FAQ |', '|---|---|---|');
for (const [coverage, n] of countBy(faq, 'coverage')) lines.push(`| ${coverage} | ${n} | ${pct(n, faq.length)} |`);

const outsideSeptember = results.filter(r => !r.ts.startsWith('2026-09'));
lines.push('', `Data note: ${outsideSeptember.length} rows are dated outside September 2026 (${[...new Set(outsideSeptember.map(r => r.ts.slice(0, 10)))].join(', ')}).`);

const unclassified = [...countBy(results.filter(r => r.bucket === 'unclassified').map(r => ({ q: normalize(r.query_text) })), 'q')];
lines.push('', `## Unclassified (${unclassified.length} phrasings, for review)`, '', ...unclassified.map(([q, n]) => `- ${n} x ${q}`));

fs.mkdirSync(`${ROOT}out`, { recursive: true });
fs.writeFileSync(`${ROOT}out/traffic_mix.md`, lines.join('\n') + '\n');
fs.writeFileSync(`${ROOT}out/traffic_mix_labels.csv`, ['query_id,bucket,why,query_text',
  ...results.map(r => `${r.query_id},${r.bucket},"${r.why}","${r.query_text.replace(/"/g, '""')}"`)].join('\n') + '\n');
console.log(lines.join('\n'));
