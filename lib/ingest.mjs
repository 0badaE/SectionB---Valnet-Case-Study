// Ingestion: read each document, clean it, decide whether it may be retrieved, then chunk it.
//
//   parse -> clean -> safety scan -> dedup -> source policy -> staleness -> editor decisions -> chunk
//
// Each step can add a status and a human-readable reason. A document's final status is the most
// serious one it collected, and only "active" and "stale" documents reach the index.
import fs from 'node:fs';
import path from 'node:path';
import { contentHash, monthsBetween } from './text.mjs';
import { scanDocument } from './guards.mjs';

const MAX_CHUNK_TOKENS = 350;  // matches the brief's token profile (5 chunks x 350)
const STATUS_SEVERITY = ['quarantined', 'duplicate', 'excluded', 'superseded', 'stale', 'active'];

const estimateTokens = text => Math.ceil(text.split(/\s+/).length * 1.33);

function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('document has no front matter');
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: match[2] };
}

// Keep only what a human reader would see. Hidden text (HTML comments, tags, zero-width characters)
// is counted for the report but never indexed: D11 hid its injection in an HTML comment.
function cleanBody(body) {
  const hiddenBlocks = (body.match(/<!--[\s\S]*?-->/g) || []).length;
  const visible = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[​-‍﻿]/g, '');
  const paragraphs = visible.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { paragraphs, text: paragraphs.join('\n\n'), hiddenBlocks };
}

function readDocument(file, rules) {
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontMatter(raw);
  const { paragraphs, text, hiddenBlocks } = cleanBody(body);
  return {
    doc_id: meta.doc_id,
    meta,
    paragraphs,
    text,
    hash: contentHash(text),
    trust_tier: rules.trust_tiers[meta.source_type] ?? null,
    safetyFindings: scanDocument(body), // scan the raw body so hidden instructions are caught too
    hiddenBlocks,
    statuses: new Set(),
    reasons: [],
    flags: [],
  };
}

function mark(doc, status, reason) {
  doc.statuses.add(status);
  doc.reasons.push(reason);
}

function quarantineUnsafe(docs) {
  for (const doc of docs) {
    if (doc.safetyFindings.length) mark(doc, 'quarantined', `Safety scan: ${doc.safetyFindings.join('; ')}`);
    if (doc.hiddenBlocks) doc.flags.push(`Hidden text removed during cleaning (${doc.hiddenBlocks} block)`);
  }
}

// Identical content: keep the most trusted copy (ties go to the lower doc id).
function removeDuplicates(docs) {
  const byHash = Map.groupBy(docs, doc => doc.hash);
  for (const copies of byHash.values()) {
    if (copies.length < 2) continue;
    const [keep, ...drop] = copies.toSorted((a, b) =>
      (a.trust_tier ?? 9) - (b.trust_tier ?? 9) || a.doc_id.localeCompare(b.doc_id));
    for (const doc of drop) {
      mark(doc, 'duplicate', `Exact duplicate of ${keep.doc_id} (same content hash); kept the ${keep.meta.source_type} original`);
    }
  }
}

function applySourcePolicy(docs, rules) {
  for (const doc of docs) {
    const why = rules.excluded_source_types[doc.meta.source_type];
    if (why) mark(doc, 'excluded', `Source type "${doc.meta.source_type}" excluded: ${why}`);
  }
}

// Editorial and first-party pages expire after a review window. Official pages don't age out here:
// in production they are re-confirmed against the live page on every crawl instead.
function markStale(docs, rules) {
  for (const doc of docs) {
    doc.age_months = monthsBetween(doc.meta.last_reviewed, rules.as_of);
    const window = rules.review_window_months[doc.meta.source_type];
    if (window && doc.age_months > window && !rules.pinned[doc.doc_id]) {
      mark(doc, 'stale', `Last reviewed ${doc.meta.last_reviewed} (${doc.age_months} months ago) > ${window}-month window for ${doc.meta.source_type}`);
    }
  }
}

// Contradictions are decided by a person and recorded in pack_rules.json, with the reason.
function applyEditorDecisions(docs, rules) {
  for (const doc of docs) {
    const decision = rules.supersessions[doc.doc_id];
    if (decision) mark(doc, 'superseded', `Superseded by ${decision.superseded_by.join(', ')}: ${decision.decision}`);

    const pin = rules.pinned[doc.doc_id];
    if (pin && doc.age_months > pin.review_every_months) {
      doc.flags.push(`Pinned (${pin.owner}): review every ${pin.review_every_months} months, last reviewed ${doc.meta.last_reviewed} -> OVERDUE`);
    }
  }
}

// Paragraphs are packed into chunks of up to MAX_CHUNK_TOKENS. Each chunk carries its document's
// metadata so retrieval can weight it and the answer can cite it.
function toChunks(doc) {
  const groups = [];
  let current = [];
  for (const paragraph of doc.paragraphs) {
    if (current.length && estimateTokens([...current, paragraph].join(' ')) > MAX_CHUNK_TOKENS) {
      groups.push(current);
      current = [];
    }
    current.push(paragraph);
  }
  if (current.length) groups.push(current);

  return groups.map((paragraphs, i) => ({
    chunk_id: `${doc.doc_id}#${i + 1}`,
    doc_id: doc.doc_id,
    title: doc.meta.title,
    source_type: doc.meta.source_type,
    audience: doc.meta.audience,
    last_reviewed: doc.meta.last_reviewed,
    trust_tier: doc.trust_tier,
    status: doc.status,
    text: paragraphs.join('\n\n'),
  }));
}

export function ingest(packDir, rules) {
  const files = fs.readdirSync(packDir).filter(f => /^D\d+\.md$/.test(f)).sort();
  const docs = files.map(f => readDocument(path.join(packDir, f), rules));

  quarantineUnsafe(docs);
  removeDuplicates(docs);
  applySourcePolicy(docs, rules);
  markStale(docs, rules);
  applyEditorDecisions(docs, rules);

  for (const doc of docs) doc.status = STATUS_SEVERITY.find(s => doc.statuses.has(s)) ?? 'active';

  const retrievable = docs.filter(doc => doc.status === 'active' || doc.status === 'stale');
  return { docs, chunks: retrievable.flatMap(toChunks) };
}
