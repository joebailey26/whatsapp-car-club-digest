import { buildDigest, digestKey, ukDate, type DigestModel } from './model';
import { renderDigest, type RenderedDigest } from './render';
import { coverageFor, loadDigestData, loadListingData, type RunForCoverage } from './data';

/**
 * Generate → store in R2 → send once.
 *
 *  - One digest per key (the Sunday the week runs up to). A key already marked
 *    `sent` is never re-sent unless `force` is set.
 *  - The rendering is stored in R2 BEFORE sending, so a failed email can be
 *    retried (`resend`) without re-exporting or re-analysing anything.
 *  - Email errors are recorded separately from export/analysis status.
 *  - Logs carry codes and counts only, never content or the address.
 */

export interface DigestDeps {
  db: D1Database;
  r2: R2Bucket;
  email: SendEmail;
  from: string;
  to: string;
  groups: ReadonlyArray<{ id: string; name: string; enabled: boolean }>;
  runs: readonly RunForCoverage[];
  now: Date;
}

export interface DigestOutcome {
  id: string;
  status: 'sent' | 'skipped_already_sent' | 'failed' | 'rendered_only';
  errorCode: string | null;
  messageId: string | null;
  r2Key: string;
  upcoming: number;
  coverageComplete: boolean;
  attempts: number;
}

interface DigestRow {
  id: string;
  period_to: string;
  status: string;
  attempts: number;
  r2_key: string;
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.trim().toLowerCase()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function previousDigestAt(db: D1Database, excludeId: string): Promise<string | null> {
  const r = await db.prepare("SELECT period_to FROM digests WHERE status = 'sent' AND id != ? ORDER BY period_to DESC LIMIT 1").bind(excludeId).first<{ period_to: string }>();
  return r?.period_to ?? null;
}

/** `allHistory`: ignore the previous digest and include everything still stored (events and listings). */
export async function generate(deps: DigestDeps, key: string, allHistory = false): Promise<{ model: DigestModel; rendered: RenderedDigest; r2Key: string; periodFrom: string | null }> {
  const generatedAt = deps.now.toISOString();
  const periodFrom = allHistory ? null : await previousDigestAt(deps.db, key);
  const enabled = deps.groups.filter((g) => g.enabled);
  const names = new Map(deps.groups.map((g) => [g.id, g.name] as const));
  const data = await loadDigestData(deps.db, ukDate(generatedAt), names);
  const salesSince = allHistory ? '1970-01-01T00:00:00.000Z' : (periodFrom ?? new Date(deps.now.getTime() - 7 * 86_400_000).toISOString());
  const sales = await loadListingData(deps.db, salesSince, names);
  const model = buildDigest({ id: key, generatedAt, periodFrom, ...data, coverage: coverageFor(enabled, deps.runs, periodFrom), listings: sales.listings, listingChanges: sales.changes, salesSince });
  const rendered = renderDigest(model);
  const base = `digests/${key}`;
  await Promise.all([
    deps.r2.put(`${base}/digest.json`, JSON.stringify({ model, subject: rendered.subject }, null, 2), { httpMetadata: { contentType: 'application/json' } }),
    deps.r2.put(`${base}/digest.md`, rendered.markdown, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } }),
    deps.r2.put(`${base}/email.html`, rendered.html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } }),
    deps.r2.put(`${base}/email.txt`, rendered.text, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }),
  ]);
  return { model, rendered, r2Key: `${base}/digest.json`, periodFrom };
}

/**
 * Build (or reuse) this week's digest and send it.
 * `resend`: send the stored rendering for `key` again without regenerating.
 * `force`: send even if this key was already sent.
 * `dryRun`: generate and store, but do not send.
 */
export async function runDigest(deps: DigestDeps, opts: { key?: string; force?: boolean; resend?: boolean; dryRun?: boolean; allHistory?: boolean } = {}): Promise<DigestOutcome> {
  const key = opts.key ?? digestKey(ukDate(deps.now.toISOString()));
  const existing = await deps.db.prepare('SELECT id, period_to, status, attempts, r2_key FROM digests WHERE id = ?').bind(key).first<DigestRow>();

  if (existing?.status === 'sent' && !opts.force) {
    return { id: key, status: 'skipped_already_sent', errorCode: null, messageId: null, r2Key: existing.r2_key, upcoming: 0, coverageComplete: true, attempts: existing.attempts };
  }

  let subject: string;
  let html: string;
  let text: string;
  let r2Key: string;
  let upcoming = 0;
  let coverageComplete = true;

  if (opts.resend && existing) {
    const [h, t, j] = await Promise.all([
      deps.r2.get(`digests/${key}/email.html`),
      deps.r2.get(`digests/${key}/email.txt`),
      deps.r2.get(`digests/${key}/digest.json`),
    ]);
    if (!h || !t || !j) return { id: key, status: 'failed', errorCode: 'STORED_DIGEST_MISSING', messageId: null, r2Key: existing.r2_key, upcoming: 0, coverageComplete: false, attempts: existing.attempts };
    const stored = (await j.json()) as { model: DigestModel; subject: string };
    [subject, html, text, r2Key] = [stored.subject, await h.text(), await t.text(), existing.r2_key];
    upcoming = stored.model.upcoming.length;
    coverageComplete = stored.model.coverageComplete;
  } else {
    const g = await generate(deps, key, opts.allHistory === true);
    [subject, html, text, r2Key] = [g.rendered.subject, g.rendered.html, g.rendered.text, g.r2Key];
    upcoming = g.model.upcoming.length;
    coverageComplete = g.model.coverageComplete;
    await deps.db
      .prepare(
        `INSERT INTO digests (id, created_at, period_from, period_to, r2_key, coverage_complete, events_upcoming, status, attempts, recipient_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'rendered', 0, ?)
         ON CONFLICT (id) DO UPDATE SET period_from = excluded.period_from, period_to = excluded.period_to, r2_key = excluded.r2_key,
           coverage_complete = excluded.coverage_complete, events_upcoming = excluded.events_upcoming,
           status = CASE WHEN digests.status = 'sent' THEN 'sent' ELSE 'rendered' END`,
      )
      .bind(key, deps.now.toISOString(), g.periodFrom, g.model.generatedAt, r2Key, coverageComplete ? 1 : 0, upcoming, await sha256(deps.to))
      .run();
  }

  const attempts = (existing?.attempts ?? 0) + (opts.dryRun ? 0 : 1);
  if (opts.dryRun) return { id: key, status: 'rendered_only', errorCode: null, messageId: null, r2Key, upcoming, coverageComplete, attempts: attempts };

  await deps.db.prepare("UPDATE digests SET status = 'sending', attempts = ? WHERE id = ?").bind(attempts, key).run();
  try {
    const res = await deps.email.send({
      from: { email: deps.from, name: 'Car Club Digest' },
      to: deps.to,
      subject,
      html,
      text,
      headers: { 'X-Digest-Id': key },
    } as unknown as EmailMessageBuilder);
    const messageId = (res as { messageId?: string } | undefined)?.messageId ?? null;
    await deps.db
      .prepare("UPDATE digests SET status = 'sent', sent_at = ?, message_id = ?, last_error = NULL WHERE id = ?")
      .bind(new Date().toISOString(), messageId, key)
      .run();
    return { id: key, status: 'sent', errorCode: null, messageId, r2Key, upcoming, coverageComplete, attempts };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const errorCode = typeof code === 'string' ? code : err instanceof TypeError ? 'E_INVALID_MESSAGE' : 'E_SEND_FAILED';
    await deps.db.prepare("UPDATE digests SET status = 'failed', last_error = ? WHERE id = ?").bind(errorCode, key).run();
    return { id: key, status: 'failed', errorCode, messageId: null, r2Key, upcoming, coverageComplete, attempts };
  }
}
