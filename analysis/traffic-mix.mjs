// Section C1: estimate the traffic mix from the 4,000 on-site search queries.
//   node analysis/traffic-mix.mjs
//
// Each query goes to the first bucket it matches, in this order:
//   junk -> sensitive -> out of scope -> personalized / multi-step -> simple FAQ -> unclassified
// The sensitive checks are the production guards from lib/guards.mjs, so we measure with the code we would ship.
import fs from 'node:fs';
import { ROOT } from '../lib/assistant.mjs';
import { parseCsv } from '../lib/text.mjs';
import { detectCrisis, containsPII, isUserInjection, asksForOutcomePrediction } from '../lib/guards.mjs';

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
const FILLER_PREFIX = /^(pls|please|hey|quick q|question:|need to know:)\s+/i;

// "Quick q Does the GI Bill expire??" -> "does the gi bill expire"
function normalize(query) {
  return query.trim()
    .replace(FILLER_PREFIX, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\?+$/, '')
    .trim();
}

// Keep letters and digits only, so misplaced spaces don't matter: "i goto ut in 2013" -> "igotoutin2013".
const squash = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');

// Most typos in the logs are one swapped pair of neighbouring letters ("waht", "skillbrdige"),
// so we also try the query with each neighbouring pair swapped back.
function spellingVariants(squashed) {
  const variants = [squashed];
  for (let i = 0; i < squashed.length - 1; i++) {
    variants.push(squashed.slice(0, i) + squashed[i + 1] + squashed[i] + squashed.slice(i + 2));
  }
  return variants;
}

function matchesAny(variants, keywords) {
  return keywords.some(keyword => variants.some(v => (keyword instanceof RegExp ? keyword.test(v) : v.includes(keyword))));
}

// ---------------------------------------------------------------------------
// Rules. Keywords are squashed (no spaces). Keep them long: short ones like "tap" match inside other
// words once a letter swap is allowed ("retiremenTPAy", "discounts aT APple").
// ---------------------------------------------------------------------------
const JUNK = ['asdkjh', 'buyfollowers', 'freebitcoin', /^a{4,}$/];
const OUT_OF_SCOPE = ['deletemyaccount', 'updatemyemail', 'cancelnewsletter', 'resetmypassword'];
const OUTCOME_PREDICTION = ['whatratingwilliget', 'willmyclaimbeapproved'];

const PERSONALIZED = [
  'iseparatein',             // "can i do skillbridge i separate in 3 months"
  'igotoutin',               // "i got out in 2016 does my gi bill still work"
  /served\d+months/,         // "am i eligible for 100% gi bill, served 36 months"
  'iwasin',                  // "i was in iraq do i qualify for va health care"
  'whatjobsmatchmy',         // "what jobs match my 92Y experience and my Ohio location"
  'increasemyvaratingfrom',  // "increase my va rating from 70%"
  /\d+vadisabilitypay/,      // "70% va disability pay per month"
];

// FAQ topics, and whether the knowledge pack can answer them:
//   covered = the pack answers it · partial = it touches the topic but lacks specifics · none = not in the pack
// Order matters where topics overlap.
const TOPICS = [
  { name: 'GI Bill (eligibility, applying, expiry, transfer, uses)', coverage: 'covered',
    keywords: ['gibill', 'post911', 'forevergi'] },
  // "ebenefitslog", not "ebenefits": "statE BENEFITS for veterans" contains the shorter one.
  { name: 'VA claims (filing, status, intent to file, back pay, VSO, lawyer)', coverage: 'covered',
    keywords: ['claim', 'intenttofile', 'effectivedate', 'vso', 'lawyer', 'ebenefitslog'] },
  { name: 'VA health care and PACT Act', coverage: 'covered',
    keywords: ['healthcare', 'priority', 'copay', 'pactact', 'burnpit', 'agentorange'] },
  // Before home loans, so "va loan rates today" counts as a rates question.
  { name: 'Home loan rates and lenders', coverage: 'partial',
    keywords: ['loanrate', 'lender'] },
  { name: 'VA home loans (requirements, COE, funding fee)', coverage: 'covered',
    keywords: ['valoan', 'homeloan', 'fundingfee', 'certificateofeligibility', 'downpayment'] },
  { name: 'Transition (TAP, SkillBridge)', coverage: 'covered',
    keywords: ['tapclass', 'skillbridge'] },
  { name: 'Jobs and resumes', coverage: 'covered',
    keywords: ['job', 'resume', 'translate', 'employer', 'civilian'] },
  { name: 'Military discounts', coverage: 'partial',
    keywords: ['discount'] },
  { name: 'State benefits (property tax, tuition, plates)', coverage: 'partial',
    keywords: ['propertytax', 'tuitionwaiver', 'licenseplate', 'statebenefit', 'disabledveteranbenefit'] },
  { name: 'Crisis line number', coverage: 'covered',
    keywords: ['crisisline'] },
  { name: 'TRICARE, SGLI/VGLI, survivors, burial', coverage: 'none',
    keywords: ['tricare', 'sgli', 'vgli', 'survivor', 'burial', 'headstone'] },
  { name: 'Pay charts, retirement pay, ID cards, Space-A', coverage: 'none',
    keywords: ['dfas', 'paychart', 'retirementpay', 'idcard', 'spaceavailable'] },
];

function classify(rawQuery) {
  const text = normalize(rawQuery);
  const variants = spellingVariants(squash(text));

  if (isUserInjection(rawQuery)) return { bucket: 'junk', why: 'injection attempt' };
  if (matchesAny(variants, JUNK)) return { bucket: 'junk', why: 'spam or keyboard mash' };

  if (detectCrisis(rawQuery)) return { bucket: 'sensitive', why: 'crisis' };
  if (containsPII(rawQuery)) return { bucket: 'sensitive', why: 'personal identifier' };
  if (asksForOutcomePrediction(text) || matchesAny(variants, OUTCOME_PREDICTION)) {
    return { bucket: 'sensitive', why: 'claim outcome / rating prediction' };
  }

  if (matchesAny(variants, OUT_OF_SCOPE)) return { bucket: 'out_of_scope', why: 'account or site support' };
  if (matchesAny(variants, PERSONALIZED)) return { bucket: 'personalized', why: "depends on the user's own facts" };

  const topic = TOPICS.find(t => matchesAny(variants, t.keywords));
  if (topic) return { bucket: 'faq', why: topic.name, coverage: topic.coverage };
  return { bucket: 'unclassified', why: 'no rule matched' };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const BUCKETS = ['faq', 'personalized', 'sensitive', 'out_of_scope', 'junk', 'unclassified'];

const percent = (part, whole) => `${(100 * part / whole).toFixed(1)}%`;

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(item[key], (counts.get(item[key]) || 0) + 1);
  return counts;
}

function markdownTable(header, rows) {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)];
}

const csvField = value => `"${String(value).replace(/"/g, '""')}"`;

const rows = parseCsv(fs.readFileSync(`${ROOT}data/search_queries.csv`, 'utf8'));
const results = rows.map(row => ({ ...row, ...classify(row.query_text) }));
const total = results.length;
const inBucket = bucket => results.filter(r => r.bucket === bucket);

const summaryRows = BUCKETS.map(bucket => {
  const queries = inBucket(bucket);
  const uniquePhrasings = new Set(queries.map(r => normalize(r.query_text))).size;
  const loggedIn = queries.filter(r => r.logged_in === '1').length;
  return [bucket, queries.length, percent(queries.length, total), uniquePhrasings, queries.length ? percent(loggedIn, queries.length) : '-'];
});

const reasonRows = BUCKETS.flatMap(bucket =>
  [...countBy(inBucket(bucket), 'why')]
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => [bucket, why, n, percent(n, total)]));

const faq = inBucket('faq');
const coverageRows = [...countBy(faq, 'coverage')].map(([coverage, n]) => [coverage, n, percent(n, faq.length)]);

const offMonth = results.filter(r => !r.ts.startsWith('2026-09'));
const offMonthDates = [...new Set(offMonth.map(r => r.ts.slice(0, 10)))].join(', ');

const unclassified = countBy(inBucket('unclassified').map(r => ({ phrasing: normalize(r.query_text) })), 'phrasing');

const report = [
  '# C1 traffic mix (search_queries.csv)',
  '',
  `${total} queries, ${new Set(results.map(r => r.session_id)).size} sessions.`,
  '',
  ...markdownTable(['Bucket', 'Queries', 'Share', 'Unique phrasings', 'Logged in'], summaryRows),
  '',
  '## Why (reason within each bucket)',
  '',
  ...markdownTable(['Bucket', 'Reason', 'Queries', 'Share of all'], reasonRows),
  '',
  '## Can the knowledge pack answer the FAQ traffic?',
  '',
  ...markdownTable(['Pack coverage', 'Queries', 'Share of FAQ'], coverageRows),
  '',
  `Data note: ${offMonth.length} rows are dated outside September 2026 (${offMonthDates}).`,
  '',
  `## Unclassified (${unclassified.size} phrasings, for review)`,
  '',
  ...[...unclassified].map(([phrasing, n]) => `- ${n} x ${phrasing}`),
].join('\n');

const labelsCsv = [
  'query_id,bucket,why,query_text',
  ...results.map(r => [r.query_id, r.bucket, csvField(r.why), csvField(r.query_text)].join(',')),
].join('\n');

fs.mkdirSync(`${ROOT}out`, { recursive: true });
fs.writeFileSync(`${ROOT}out/traffic_mix.md`, report + '\n');
fs.writeFileSync(`${ROOT}out/traffic_mix_labels.csv`, labelsCsv + '\n');
console.log(report);
