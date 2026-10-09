// Deterministic rules for the date and threshold logic in the pack. Language models are unreliable at
// date arithmetic, so code computes the answer and the model only phrases it.
//
// Each rule is tied to one source document and only fires when that document was retrieved.
// A rule returns { text } when it can answer, or { ask } when it needs one more fact from the user.

const RULES = [
  {
    id: 'gi_bill_time_limit',
    source: 'D02',
    matches: q => /gi bill/i.test(q) && /expire|how long|time limit|still work|use my gi bill/i.test(q),
    answer(facts, { asOf }) {
      if (facts.separated_on_or_after_2013 === undefined) {
        return { ask: 'When was your last discharge or release from active duty? The answer depends on whether it was before or after January 1, 2013 [D02].' };
      }
      if (facts.separated_on_or_after_2013) {
        return { text: `Because your last discharge was in ${facts.separation_year}, on or after January 1, 2013, your Post-9/11 GI Bill benefits do not expire; there is no 15-year time limit for you [D02].` };
      }
      const limitYear = facts.separation_year + 15;
      const alreadyPassed = limitYear < Number(asOf.slice(0, 4));
      return {
        text: `Because you left before January 1, 2013, your benefits generally expire 15 years after your last period of active duty of at least 90 consecutive days [D02]. `
          + `If that period ended in ${facts.separation_year}, the limit falls around ${limitYear}, which ${alreadyPassed ? 'has already passed as of today' : 'is still ahead of you'}. `
          + 'Some exceptions apply, so confirm your own end date with VA before making plans [D02].',
      };
    },
  },
  {
    id: 'skillbridge_window',
    source: 'D14',
    matches: q => /skillbridge/i.test(q),
    answer(facts) {
      const days = facts.days_to_separation;
      if (!days) return { ask: 'How many months until your separation date? SkillBridge runs during your last 180 days of service [D14].' };

      const about = facts.days_is_estimate ? 'about ' : '';
      if (days > 180) {
        return { text: `You separate in ${about}${days} days; SkillBridge opens in your last 180 days of service, about ${days - 180} days from now [D14]. Start with your transition office before the window opens [D14].` };
      }
      return {
        text: `You separate in ${about}${days} days, so you are already inside SkillBridge's last-180-days window [D14]. `
          + "Whether you can still start depends on approvals, not the calendar: you need your commander's approval and must have completed the required transition steps, and availability varies by branch and installation [D14]. "
          + 'Completing TAP is how you build the Individual Transition Plan that SkillBridge requires [D13]. '
          + `Talk to your transition office now; with ${about}${days} days left, time is short.`,
      };
    },
  },
  {
    id: 'gi_bill_transfer',
    source: 'D04',
    matches: q => /transfer/i.test(q) && /gi bill|benefit/i.test(q),
    answer(facts, { retrievedDocs }) {
      if (facts.still_serving === undefined) return { ask: 'Are you still serving? Transfers can only be requested while serving [D04].' };
      if (facts.still_serving) {
        return { text: 'Possibly, if you transfer before you separate. You must be on active duty or in the Selected Reserve, have at least 6 years of service, and agree to serve 4 more years [D04].' };
      }
      const year = facts.separation_year ? ` in ${facts.separation_year}` : '';
      const mentionDea = retrievedDocs.has('D24')
        ? " A separate program, Dependents' Educational Assistance (DEA), covers children and spouses of veterans who died or are permanently and totally disabled because of a service-connected condition; VA decides who qualifies [D24]."
        : '';
      return {
        text: "Unfortunately, no. A transfer has to be requested while you are still serving, through DoD's milConnect, and it cannot be requested after you have separated or retired [D04]. "
          + `Since you separated${year}, a transfer to a family member is no longer possible under these rules.${mentionDea}`,
      };
    },
  },
  {
    id: 'funding_fee',
    source: 'D10',
    matches: q => /funding fee/i.test(q),
    answer(facts) {
      const rule = 'Most borrowers pay a one-time VA funding fee, but veterans who receive VA disability compensation are exempt [D10].';
      if (!facts.has_disability_rating) return { text: `${rule} Whether you are exempt depends on whether you receive disability compensation.` };
      return {
        text: `${rule} Your profile shows a VA disability rating, so if you are receiving disability compensation you should not have to pay it. `
          + 'Your Certificate of Eligibility (COE), which is the first step of the loan, is where to confirm this [D10].',
      };
    },
  },
  {
    id: 'pact_exposure',
    source: 'D09',
    matches: q => /burn pit|iraq|afghanistan|toxic|pact/i.test(q),
    answer(facts) {
      const deployedTo = (facts.deployments || []).map(d => d.split(' ')[0]).find(place => /iraq|afghanistan/i.test(place));
      const where = facts.served_in || deployedTo;
      if (!where) return null; // nothing to compute; the retrieved text answers on its own
      return {
        text: `${where} is one of the Southwest Asia locations where D09 says veterans may have been exposed to burn pits, and the PACT Act expanded VA health care for veterans with toxic exposures [D09]. `
          + 'You may qualify for health care under these expanded rules [D08], and you can apply at any time; VA makes the final eligibility decision [D09].',
      };
    },
  },
];

export function runCalculators(question, facts, retrievedDocs, asOf) {
  const results = [];
  for (const rule of RULES) {
    if (!rule.matches(question) || !retrievedDocs.has(rule.source)) continue;
    const result = rule.answer(facts, { asOf, retrievedDocs });
    if (result) results.push({ id: rule.id, source: rule.source, ...result });
  }
  return results;
}
