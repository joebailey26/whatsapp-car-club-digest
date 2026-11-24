import type { ProcessResult } from '../exports/process';
import { applyPlan, loadCandidatesForMatching } from '../events/repository';
import { chunkMessages, extractChunk, type ModelId } from './extract';
import { ukDateOf } from './grounding';
import { reconcile } from './reconcile';
import { reconcileListings } from './listings';
import { applyListingPlan, loadListingsForMatching } from '../events/listings-repository';

/**
 * Stage A + B for one processed export: chunk the NEW messages (with earlier
 * messages as context), extract, ground, reconcile into D1.
 * Stops cleanly when the run's chunk or token budget is spent.
 */

export interface AnalyseDeps {
  ai: Ai;
  db: D1Database;
  r2: R2Bucket;
  model: ModelId;
  now: Date;
}

export interface Budget {
  chunksLeft: number;
  tokensLeft: number;
}

export interface GroupAnalysis {
  exportId: string;
  groupId: string;
  status: 'analysed' | 'skipped' | 'failed' | 'budget_exceeded' | 'partial';
  reason: string | null;
  model: ModelId;
  messagesAnalysed: number;
  chunks: number;
  candidates: number;
  accepted: number;
  rejected: Record<string, number>;
  flags: Record<string, number>;
  created: number;
  updated: number;
  evidenceOnly: number;
  tokensIn: number;
  tokensOut: number;
  errors: string[];
  /** Sale listings (optional so older stored runs still read correctly). */
  listingsFound?: number;
  listingsCreated?: number;
  listingsUpdated?: number;
  listingsRejected?: Record<string, number>;
  /** Model-written titles of rejected listings with the reason (for diagnosing misses). */
  listingsRejectedDetail?: Array<{ title: string; reason: string }>;
  /** Listings call failures (the events call records into `errors`). */
  listingsErrors?: string[];
}

interface StoredMessage {
  id: string;
  groupId: string;
  author: string | null;
  timestamp: string;
  text: string;
  attachment: boolean;
  system: boolean;
  sourceExport: string;
  isNew: boolean;
}

/** `range` (UTC ISO, `to` exclusive): analyse exactly these messages, whether or not they are new. */
export async function analyseExport(p: ProcessResult, deps: AnalyseDeps, budget: Budget, range?: { from: string; to: string }): Promise<GroupAnalysis> {
  const a: GroupAnalysis = {
    exportId: p.exportId,
    groupId: p.groupId,
    status: 'skipped',
    reason: null,
    model: deps.model,
    messagesAnalysed: 0,
    chunks: 0,
    candidates: 0,
    accepted: 0,
    rejected: {},
    flags: {},
    created: 0,
    updated: 0,
    evidenceOnly: 0,
    tokensIn: 0,
    tokensOut: 0,
    errors: [],
    listingsFound: 0,
    listingsCreated: 0,
    listingsUpdated: 0,
    listingsRejected: {},
  };
  if (p.status !== 'processed' || !p.messagesKey) {
    a.reason = `processing_${p.status}`;
    return a;
  }
  const obj = await deps.r2.get(p.messagesKey);
  if (!obj) {
    a.status = 'failed';
    a.reason = 'MESSAGES_OBJECT_MISSING';
    return a;
  }
  const payload = (await obj.json()) as { messages: StoredMessage[] };
  // Attachment-only placeholders carry no event information; skip them to save tokens.
  let msgs = payload.messages.filter((m) => !(m.attachment && m.text.replace(/<[^>]*>/g, '').trim().length < 3)).sort((x, y) => x.timestamp.localeCompare(y.timestamp));
  if (range) msgs = msgs.filter((m) => m.timestamp < range.to);
  const firstNew = range ? msgs.findIndex((m) => m.timestamp >= range.from) : msgs.findIndex((m) => m.isNew);
  if (firstNew < 0) {
    a.reason = 'no_new_messages';
    return a;
  }
  const chunks = chunkMessages(
    msgs.map((m) => ({ id: m.id, exportId: m.sourceExport, timestamp: m.timestamp, author: m.author, text: m.text })),
    firstNew,
  );
  a.messagesAnalysed = msgs.length - firstNew;
  const today = ukDateOf(deps.now.toISOString());
  a.status = 'analysed';

  for (const chunk of chunks) {
    if (budget.chunksLeft <= 0 || budget.tokensLeft <= 0) {
      a.status = 'budget_exceeded';
      a.reason = budget.chunksLeft <= 0 ? 'chunk_budget' : 'token_budget';
      break;
    }
    budget.chunksLeft--;
    a.chunks++;
    const existing = await loadCandidatesForMatching(deps.db, today);
    const known = existing.filter((e) => !e.eventDate || e.eventDate >= today).map((e) => ({ title: e.title, date: e.eventDate, location: e.location, status: e.status }));
    const res = await extractChunk(deps.ai, deps.model, chunk, known, deps.now.toISOString());
    a.tokensIn += res.tokensIn;
    a.tokensOut += res.tokensOut;
    budget.tokensLeft -= res.tokensIn + res.tokensOut;
    if (res.errorCode) {
      a.errors.push(res.errorCode);
      continue;
    }
    a.candidates += res.grounded.length + res.rejected.length;
    a.accepted += res.grounded.length;
    for (const r of res.rejected) a.rejected[r.reason] = (a.rejected[r.reason] ?? 0) + 1;
    for (const g of res.grounded) for (const f of g.flags) a.flags[f] = (a.flags[f] ?? 0) + 1;

    const plan = reconcile(res.grounded, existing, { groupId: p.groupId, today, newId: () => crypto.randomUUID() });
    const applied = await applyPlan(deps.db, plan);
    a.created += applied.created;
    a.updated += applied.updated;
    a.evidenceOnly += applied.evidence;

    // Sale listings from the same response.
    a.listingsFound = (a.listingsFound ?? 0) + res.listings.length;
    for (const r of res.listingsRejected) {
      a.listingsRejected![r.reason] = (a.listingsRejected![r.reason] ?? 0) + 1;
      if ((a.listingsRejectedDetail ??= []).length < 40) a.listingsRejectedDetail.push({ title: r.title, reason: r.reason });
    }
    if (res.listingsErrorCode) (a.listingsErrors ??= []).push(res.listingsErrorCode);
    if (res.listings.length) {
      const existingListings = await loadListingsForMatching(deps.db, p.groupId, deps.now);
      const lplan = reconcileListings(res.listings, existingListings, { groupId: p.groupId, newId: () => crypto.randomUUID() });
      const la = await applyListingPlan(deps.db, lplan);
      a.listingsCreated = (a.listingsCreated ?? 0) + la.created;
      a.listingsUpdated = (a.listingsUpdated ?? 0) + la.updated;
    }
  }
  if (a.errors.length && a.status === 'analysed') a.status = a.errors.length >= a.chunks ? 'failed' : 'partial';
  return a;
}
