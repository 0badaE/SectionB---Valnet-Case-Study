// Personalization, following the policy in D23:
//   - profile data is used only when personalization_opt_in is true
//   - what the user types in the chat can always be used
// Profile data is passed on in derived form ("separated on or after 2013"), never raw (exact dates, rating %).
import { daysBetween } from './text.mjs';

const FOREVER_GI_BILL_CUTOFF = '2013-01-01'; // D02: discharges on/after this date have no time limit

export function factsFromProfile(persona, asOf) {
  if (!persona) return { used: false, note: 'No profile.', facts: {} };
  if (!persona.personalization_opt_in) {
    return { used: false, note: 'Personalization is off, so the profile was not used (D23). Only what the user typed was used.', facts: {} };
  }

  const facts = {};
  if (persona.branch) facts.branch = persona.branch;
  if (persona.separation_date) {
    const daysLeft = daysBetween(asOf, persona.separation_date);
    if (daysLeft > 0) {
      facts.still_serving = true;
      facts.days_to_separation = daysLeft;
    } else {
      facts.still_serving = false;
      facts.separation_year = Number(persona.separation_date.slice(0, 4));
      facts.separated_on_or_after_2013 = persona.separation_date >= FOREVER_GI_BILL_CUTOFF;
    }
  }
  if (persona.va_disability_rating != null) facts.has_disability_rating = persona.va_disability_rating > 0;
  if (persona.state) facts.state = persona.state;
  if (persona.dependents != null) facts.has_dependents = persona.dependents > 0;
  if (persona.deployments?.length) facts.deployments = persona.deployments;

  return { used: true, note: 'Personalization is on; derived profile facts were used.', facts };
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const DAYS_PER_UNIT = { month: 30.4, week: 7, day: 1 };

// Pulls the few facts the calculators need out of the message itself.
export function factsFromMessage(message) {
  const text = message.toLowerCase();
  const facts = {};

  // "I got out in 2019", "I left the Air Force in 2010", "I separated in 2024"
  const pastSeparation = text.match(/\b(got out|left|separated|discharged|retired|get out)\b[^.?]*?\b((?:19|20)\d{2})\b/);
  if (pastSeparation) {
    const year = Number(pastSeparation[2]);
    facts.still_serving = false;
    facts.separation_year = year;
    facts.separated_on_or_after_2013 = year >= 2013;
  }

  // "I'm separating in about two months"
  const upcoming = text.match(/\bseparat\w*\s+in\s+(?:about\s+|around\s+|roughly\s+)?(\d+|[a-z]+)\s+(month|week|day)s?/);
  if (upcoming) {
    const amount = NUMBER_WORDS[upcoming[1]] ?? Number(upcoming[1]);
    if (amount) {
      facts.still_serving = true;
      facts.days_to_separation = Math.round(amount * DAYS_PER_UNIT[upcoming[2]]);
      facts.days_is_estimate = true;
    }
  }

  const location = text.match(/\b(iraq|afghanistan|kuwait|syria|vietnam)\b/);
  if (location) facts.served_in = location[1][0].toUpperCase() + location[1].slice(1);

  return facts;
}

// The message wins over the profile for this turn, with one exception: a rough "in about two months"
// does not replace an exact separation date from the profile.
export function combineFacts(profileFacts, messageFacts) {
  const combined = { ...profileFacts, ...messageFacts };
  if (profileFacts.days_to_separation && messageFacts.days_to_separation) {
    combined.days_to_separation = profileFacts.days_to_separation;
    delete combined.days_is_estimate;
  }
  return combined;
}

// Profile values that must never appear in an answer when the user has opted out (checked after the model).
export function hiddenProfileValues(persona) {
  if (!persona || persona.personalization_opt_in) return [];
  const rating = persona.va_disability_rating ? `${persona.va_disability_rating}%` : null;
  return [rating, persona.branch, persona.state, persona.separation_date].filter(Boolean);
}
