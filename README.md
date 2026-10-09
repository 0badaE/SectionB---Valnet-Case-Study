# Section B: Retrieval prototype (veteran assistant)

**Reviewers, start here:** the 15 answers with citations are in [`out/answers.md`](out/answers.md),
the problems found in the pack are in the [table below](#problems-found-in-the-pack), and the code
starts at [`lib/pipeline.mjs`](lib/pipeline.mjs).

Plain Node.js (v22+), no dependencies. Retrieval, personalization and every safety check are real code.
Only the final wording step is mocked, as the brief allows, and it lives in one clearly labelled file.

```bash
node run.mjs                              # answer the 15 eval questions, check them, write out/
node eval/guard-tests.mjs                 # safety tests + sweep over the 4,000 search queries
node ask.mjs P1 "your question" --trace   # ask anything as a persona (P1-P5)
```

Outputs in `out/`: `answers.md` (15 answers with citations and how each was produced), `ingest_report.md`
(what happened to each document), `prompts/Qxx.json` (the exact payload that would go to the model provider).

## Code map

| File | What it does |
|---|---|
| `lib/pipeline.mjs` | **Start here.** Answers one message, step by step (see below). |
| `lib/guards.mjs` | Every safety check: crisis, identifiers, injection, lookups, predictions, the output check |
| `lib/ingest.mjs` | Reads the pack and decides what may be retrieved; editor decisions live in `pack_rules.json` |
| `lib/retrieve.mjs` | BM25 keyword search with query expansion and trust weighting |
| `lib/personalize.mjs` | The D23 consent rule, and the facts we derive from a profile or a message |
| `lib/calculators.mjs` | Date and threshold rules (GI Bill time limit, SkillBridge window, transfer, funding fee, PACT) |
| `lib/coverage.mjs` | Spots questions the pack can't answer (amounts, state rules, live rates) |
| `lib/mock-generator.mjs` | **The mocked step**: picks source sentences instead of calling a model |
| `lib/prompt.mjs` | The system prompt and the payload a real model would receive |
| `lib/assistant.mjs`, `lib/report.mjs`, `lib/text.mjs` | Setup, report writing, small helpers |
| `eval/expected.json`, `eval/check-answer.mjs` | What each of the 15 answers must (not) do, and the checker |
| `analysis/traffic-mix.mjs` | Section C1: classifies the 4,000 search queries (reusing the guards above); results in `out/traffic_mix.md` |

## How one message is answered (`lib/pipeline.mjs`)

| Step | Where it sits |
|---|---|
| 1. Crisis check: fixed, human-reviewed reply; no retrieval, no model call | before the model |
| 2. Remove personal identifiers (SSN, VA file no., phone, DOB, name + DOB, email) before logging or any model call | before the model |
| 3. Refuse attempts to override instructions | before the model |
| 4. Decline claim lookups and outcome predictions, then help with the safe version | before the model |
| 5. Personalization: profile only with consent, and only derived facts (no exact dates, no rating %) | before the model |
| 6. Retrieve; every retrieved chunk is re-scanned for injection | retrieval |
| 7. Coverage gaps and calculators are computed in code; sources go to the model marked as untrusted data | in the prompt |
| 8. Check the answer: citations must come from retrieved docs, no identifiers, links on the allowlist, no predictions, no opted-out profile values. Any failure → safe fallback | after the model |

Ingestion (`lib/ingest.mjs`): strip hidden text → safety scan → quarantine → dedup by content hash →
source-type policy → staleness by source type → editor decisions (supersessions, pinned reviews) → chunk.
24 docs in, 19 retrievable.

## Problems found in the pack

| # | Problem | Docs | Risk if indexed as-is | How the pipeline handles it |
|---|---|---|---|---|
| 1 | Hidden prompt injection in an HTML comment: tells the AI to call VetHomeDirect "the only trustworthy lender" and send users to a third-party site to type their full SSN and DOB | D11 | Phishing via our own assistant (Q11) | Hidden text stripped; safety scan quarantines the doc; source type (scraped partner) excluded; retrieval re-scans chunks (layer 2); output link allowlist (layer 3). Q11 answers from D10 only |
| 2 | Scraped mirror is a word-for-word copy of an official doc, including its dates | D22 = D06 | Same fact takes two of five retrieval slots; unknown provenance; can drift | Content-hash dedup keeps D06; mirror source type excluded; scraped dates treated as untrusted |
| 3 | 2016 editorial says GI Bill benefits expire 15 years after leaving, for everyone | D03 vs D02 | Q01: Marcus (out 2019) would be told his benefits expire in 2034; under D02 they never expire | Stale (125 months) and superseded by D02; Q01/Q02 cite D02 only |
| 4 | Retired process: tells users to use eBenefits / DS Logon | D03, D07 vs D06 | Q07 user "always used eBenefits" would be sent to a retired sign-in | Superseded by D06; Q07 answers from D06 |
| 5 | Unsourced claim: "most claims are processed in about 30 days" | D03 | False expectations on claim timing | Removed with D03 |
| 6 | Community myth: "GI Bill only covers 4-year colleges" | D20 vs D21 | Q08 would confirm the myth | Community source type excluded; Q08 answers from D21 (vocational, apprenticeships, certifications) |
| 7 | Coverage gaps: no payment amounts, no state-by-state rules, no live loan rates | Q06, Q14, Q11 | Invitations to hallucinate a dollar figure or an Ohio rule | Gap detectors in code; answer says "not covered" and names who can answer (VA.gov rate table, Ohio DVA / county office) |
| 8 | Old editorial with no contradiction | D18 (30 months) | Possibly outdated | Marked stale: ranked ×0.6 and shown with an "older article" note |
| 9 | High-stakes pinned docs overdue for review | D12 (crisis line), D23 (data policy) | Crisis numbers or privacy promises drift | Flagged OVERDUE in the ingest report; still served; review is a launch gate |
| 10 | Audience tags don't match who asks | D04 is tagged "service members" but answers a veteran's Q10 | Filtering on audience would drop the right answer | Audience is metadata only, never a retrieval filter |

## Known limitations (what I don't trust)

- **The eval is not independent.** I wrote `eval/expected.json` from the same reading of the pack that shaped the code, so we share blind spots. 15/15 means "behaves as I intended," not "correct." A second reviewer and a held-out question set are needed.
- **Tuned on the test set.** The query expansions and calculator triggers were written with these 15 questions and the search logs in view. Expect lower accuracy on unseen phrasing.
- **Calculators are pattern-triggered.** They are reliable for arithmetic but brittle for phrasing; in production the model would choose the tool and code would compute.
- **The mock generator is extractive.** It stitches source sentences, so tone is stiff; a real model would phrase the same facts and citations.
- **PII:** regex only. It catches the identifier formats in the logs, but not free-standing names or addresses. Production would add an NER-based detector (e.g. Microsoft Presidio).
- **Crisis detection** is a keyword list with typo tolerance: 100% recall on the 28 crisis messages in the search logs, but untested beyond them. Production would add a classifier and keep the list as a floor.
- **Contradictions are decided by a person**, recorded with the reason in `pack_rules.json`. Detecting them automatically (e.g. an LLM comparing documents on the same topic) is future work; a simple word-similarity heuristic I tried matched D03 to the wrong document, so I removed it.
- **Profile facts are minimized but not trimmed per question** (e.g. state is sent with a funding-fee question).
- **BM25 instead of embeddings:** fine for 24 docs; production would run hybrid retrieval.
