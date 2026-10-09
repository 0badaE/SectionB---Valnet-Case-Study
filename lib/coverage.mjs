// Questions the knowledge pack structurally cannot answer. These are detected in code, so saying
// "not covered" never depends on the model noticing the gap (and inventing a dollar figure instead).

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const ASKS_FOR_AMOUNT = /how much|per month|\$\d|what amount/i;
const ASKS_FOR_LIVE_RATES = new RegExp([
  /\b(best|lowest|cheapest)\b[^?]*\b(rates?|lenders?|loans?)\b/.source,       // "best VA loan rates"
  /\brates?\b[^?]*\b(right now|today|this week|current)\b/.source,             // "rates today"
  /\b(right now|today|current)\b[^?]*\brates?\b/.source,                       // "current rates"
].join('|'), 'i');

function stateAskedAbout(question, profileState) {
  const named = Object.values(STATE_NAMES).find(name => new RegExp(`\\b${name}\\b`, 'i').test(question));
  if (named) return named;
  if (/\bmy state\b/i.test(question)) return STATE_NAMES[profileState];
  return null;
}

// Returns one entry per gap. `notice` opens the answer; `followUp` (if any) closes it with who can help.
export function findCoverageGaps(question, sources, facts) {
  const gaps = [];
  const sourcesMention = pattern => sources.some(source => pattern.test(source.text));

  if (ASKS_FOR_AMOUNT.test(question) && !sourcesMention(/\$\s?\d/)) {
    gaps.push({
      type: 'amount',
      notice: "The knowledge pack doesn't include payment amounts, so I can't give you a dollar figure.",
      followUp: 'Check the current-year rate table on VA.gov for the amount that matches your rating and dependents; rates change every December 1 [D05].',
    });
  }

  const state = stateAskedAbout(question, facts.state);
  if (state && !sources.some(source => source.text.includes(state))) {
    gaps.push({
      type: 'state_specific',
      notice: `The knowledge pack doesn't cover ${state}'s state-specific rules, so I can't tell you what ${state} offers or who qualifies.`,
      followUp: `For ${state}'s rules, contact the ${state} Department of Veterans Affairs or a county veterans service office [D18].`,
    });
  }

  if (ASKS_FOR_LIVE_RATES.test(question)) {
    gaps.push({ type: 'current_market', notice: "I don't have current loan rates, and I don't recommend specific lenders." });
  }

  return gaps;
}
