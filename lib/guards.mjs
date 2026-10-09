// Safety checks, grouped by where they sit:
//   before the model  - crisis, personal identifiers, prompt injection, account lookups, outcome predictions
//   on documents      - injection scan at ingestion (layer 1) and again at retrieval (layer 2)
//   after the model   - output check (layer 3 for injection, plus citations, PII and profile leaks)

// ---------------------------------------------------------------------------
// Crisis
// ---------------------------------------------------------------------------
// Matched against the message with everything except letters removed, so typos and spacing
// ("i want toe nd it all") still match. We favour recall: a false alarm costs one extra resource
// card, a miss can cost a life.
const CRISIS_PHRASES = [
  'endit', 'endingit', 'enditall', 'killmyself', 'killhimself', 'killherself', 'killinghimself', 'killingherself',
  'killingthemself', 'suicid', 'nobodywouldmissme', 'noonewouldmissme', 'dontseethepoint', 'nopointinanything',
  'nopointanymore', 'wanttodie', 'betteroffdead', 'hurtmyself', 'selfharm', 'imnotok', 'notworthliving',
  'noreasontolive', 'cantgoon',
];
// "endit" is short enough to appear inside ordinary words ("spend it", "credit").
const ENDIT_LOOKALIKES = ['credit', 'audit', 'spendit', 'depend', 'attendit', 'vendit', 'pendit'];
const ABOUT_SOMEONE_ELSE = /\b(buddy|friend|husband|wife|son|daughter|brother|sister|he|she|they)\b.*\b(himself|herself|themself|themselves|killing)/i;

export function detectCrisis(message) {
  const lettersOnly = message.toLowerCase().replace(/[^a-z]/g, '');
  const phrase = CRISIS_PHRASES.find(p => lettersOnly.includes(p));
  if (!phrase) return null;

  const isLookalike = phrase === 'endit'
    && ENDIT_LOOKALIKES.some(word => lettersOnly.includes(word))
    && !/\bend(ing)?\s+it\b/i.test(message);
  if (isLookalike) return null;

  return { phrase, aboutSomeoneElse: ABOUT_SOMEONE_ELSE.test(message) };
}

// ---------------------------------------------------------------------------
// Personal identifiers
// ---------------------------------------------------------------------------
// Runs before anything is logged or sent to a model. Order matters: the name rule looks for the
// word "dob", so it must run before the date-of-birth rule replaces it.
// Regex cannot catch free-standing names or addresses; production would add an NER-based detector.
const PII_PATTERNS = [
  ['NAME_WITH_DOB', /\b[a-z]+ [a-z]+(?=\s+(?:dob|date of birth)\b)/gi],
  ['SSN', /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g],
  ['VA_FILE_NUMBER', /\b(?:va\s*)?(?:file|claim)\s*(?:number|no\.?|#)?\s*(?:is\s*)?:?\s*\d{8,9}\b/gi],
  ['PHONE', /\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g],
  ['DOB', /\b(?:dob|date of birth|born)\s*:?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi],
  ['EMAIL', /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g],
  ['LONG_NUMBER', /\b\d{8,9}\b/g], // a bare 8-9 digit number is probably a VA file number
];

export function scrubPII(text) {
  let scrubbed = text;
  const found = new Set();
  for (const [type, pattern] of PII_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, () => { found.add(type); return `[${type}]`; });
  }
  return { text: scrubbed, found: [...found] };
}

export const containsPII = text => scrubPII(text).found.length > 0;

// ---------------------------------------------------------------------------
// Prompt injection
// ---------------------------------------------------------------------------
const OVERRIDE_ATTEMPT = /ignore (all )?(of )?(your |the )?(previous|prior|above) instructions|\byou are now\b/i;

// From a user: jailbreak attempts and code injection.
const USER_ATTACK = /system prompt|reveal (your )?(hidden )?(rules|instructions)|\bsudo\b|admin access|<script/i;

export const isUserInjection = message => OVERRIDE_ATTEMPT.test(message) || USER_ATTACK.test(message);

// Inside a document: text addressed to an AI, or a request for identifiers. A negated warning
// such as D23's "Do not enter Social Security numbers" must not count as a request.
const DOCUMENT_ATTACKS = [
  OVERRIDE_ATTEMPT,
  /\b(system|admin) (notice|prompt|message|override)\b/i,
  /\bnotice to (ai|assistants?|llms?|language models?)\b/i,
  /\bdo not (mention|reveal|disclose) (this|these)\b/i,
  /(?<!\b(?:do not|don't|never|not)\s+)\b(type|enter|provide|send|share)\b[^.]{0,60}\b(ssn|social security|date of birth)\b/i,
];

const LINK_ALLOWLIST = ['va.gov', 'military.com', 'veteranscrisisline.net', 'login.gov', 'id.me', 'defense.gov', 'milconnect.dmdc.osd.mil'];
const DOMAIN = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|gov|net|org|biz|info|io|me|us|mil))\b/gi;

function domainsOutsideAllowlist(text) {
  const domains = [...text.matchAll(DOMAIN)].map(m => m[1].toLowerCase().replace(/^www\./, ''));
  return domains.filter(d => !LINK_ALLOWLIST.some(allowed => d === allowed || d.endsWith(`.${allowed}`)));
}

// Returns a list of findings; an empty list means the document is clean.
export function scanDocument(text) {
  const findings = [];
  for (const pattern of DOCUMENT_ATTACKS) {
    const match = text.match(pattern);
    if (match) findings.push(`instruction-like text: "${match[0]}"`);
  }
  for (const domain of domainsOutsideAllowlist(text)) findings.push(`link outside allowlist: ${domain}`);
  return findings;
}

// ---------------------------------------------------------------------------
// Things the assistant must not do
// ---------------------------------------------------------------------------
const ASKS_ASSISTANT_TO_LOOK = /\b(can|could|will|would)\s+you\b[^.?]{0,40}\b(look\s*up|check|pull\s*up|find|access|see|tell me)\b/i;
const STARTS_WITH_LOOKUP_COMMAND = /^(pls |please )?(check|look up|pull up)\b/i;
const MENTIONS_PERSONAL_RECORD = /\b(my\s+)?(claim|account|records?|file|status|appeal)\b/i;

// "Can you look up my claim?" is a lookup; "How do I check my claim status?" is a how-to question.
// Pasting an identifier next to a record also counts as a lookup.
export function isAccountLookup(message, hadIdentifiers) {
  if (!MENTIONS_PERSONAL_RECORD.test(message)) return false;
  return hadIdentifiers || ASKS_ASSISTANT_TO_LOOK.test(message) || STARTS_WITH_LOOKUP_COMMAND.test(message.trim());
}

const OUTCOME_PREDICTION = new RegExp([
  /\b(will|would)\s+(my|i|the va)\b[^.?]{0,40}\b(approved|approve|denied|win|get (a|my)?\s*\d*%?\s*rating)/.source,
  /what\s+(rating|percent(age)?)\s+will\s+i\s+get/.source,
  /chances?\s+(of|that)\b[^.?]{0,30}\b(approv|claim)/.source,
].join('|'), 'i');

export const asksForOutcomePrediction = message => OUTCOME_PREDICTION.test(message);

// ---------------------------------------------------------------------------
// After the model
// ---------------------------------------------------------------------------
export const citedDocIds = text => [...new Set([...text.matchAll(/\[(D\d{2})\]/g)].map(m => m[1]))];

// Checks a drafted answer before it is shown. Any problem means the answer is replaced with a safe fallback.
export function checkAnswer(answer, { citableDocIds, hiddenProfileValues = [] }) {
  const problems = [];
  const cited = citedDocIds(answer);

  for (const id of cited) {
    if (!citableDocIds.has(id)) problems.push(`cites ${id}, which was not in the retrieved context`);
  }
  if (containsPII(answer)) problems.push('answer contains a personal identifier');
  for (const domain of domainsOutsideAllowlist(answer)) problems.push(`link outside allowlist: ${domain}`);
  if (/\byou (will|'ll) (be approved|be denied|get (a|an) \d+%)/i.test(answer)) problems.push('predicts a claim outcome');
  for (const value of hiddenProfileValues) {
    if (answer.includes(value)) problems.push(`mentions opted-out profile value "${value}"`);
  }
  return { ok: problems.length === 0, cited, problems };
}
