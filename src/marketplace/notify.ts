import type { NotificationClass, StoredMarketListing } from './ingest';

/**
 * Owner-only emails. Urgent lead emails go out straight after a collection,
 * with no AI in the way. The daily roundup lists borderline leads once.
 * Both carry the original advert URL and say plainly that "first seen" is
 * when the collector found the advert, not when it was posted.
 *
 * Review links open a page behind Cloudflare Access that only *shows*
 * Interested / Pass buttons; voting is a separate POST with a CSRF header, so
 * a mail scanner prefetching the link cannot vote.
 */

export interface Lead {
  listing: StoredMarketListing;
  class: NotificationClass;
  previousPricePence: number | null;
  aiReason?: string | null;
}

const gbp = (p: number | null): string => (p === null ? 'price not shown' : p === 0 ? 'Free' : `£${(p / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`);

export function londonStamp(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function reviewUrl(workerUrl: string, id: string): string {
  return `${workerUrl.replace(/\/+$/, '')}/admin/review/${encodeURIComponent(id)}`;
}

export function unknowns(l: StoredMarketListing): string[] {
  const u: string[] = [];
  if (l.pricePence === null) u.push('price');
  if (l.year === null) u.push('year');
  if (l.mileage === null) u.push('mileage');
  if (l.distanceMiles === null) u.push('distance');
  if (!l.description) u.push('description (not read)');
  if (!l.publishedText) u.push('original posting time');
  return u;
}

function headline(lead: Lead): string {
  const l = lead.listing;
  const what = lead.class === 'urgent_price_drop' ? `PRICE DROP ${gbp(lead.previousPricePence)} → ${gbp(l.pricePence)}` : gbp(l.pricePence);
  return `${what} · ${l.title}${l.location ? ` · ${l.location}` : ''}`;
}

function leadText(lead: Lead, workerUrl: string): string {
  const l = lead.listing;
  const dist = l.distanceMiles === null ? 'unknown' : `~${Math.round(l.distanceMiles)} miles${l.distanceBasis === 'county' ? ' (county estimate)' : ''}`;
  return [
    headline(lead),
    `Open advert: ${l.url}`,
    `Why: ${l.reasons.join('; ') || 'n/a'}${lead.aiReason ? ` | AI note: ${lead.aiReason}` : ''}`,
    `Score ${l.score ?? '?'} (${l.rulesetVersion ?? '?'}) · Distance ${dist}${l.year ? ` · Year ${l.year}` : ''}${l.mileage ? ` · ${l.mileage.toLocaleString('en-GB')} miles` : ''}`,
    `First discovered by the collector: ${londonStamp(l.firstSeenAt)} (UK). Originally posted: ${l.publishedText ?? 'not shown'}.`,
    `Unknown: ${unknowns(l).join(', ') || 'nothing'}`,
    ...(l.description ? [`Description: ${l.description.replace(/\s+/g, ' ').slice(0, 300)}`] : []),
    `Interested / Pass: ${reviewUrl(workerUrl, l.id)}`,
  ].join('\n');
}

function leadHtml(lead: Lead, workerUrl: string): string {
  const l = lead.listing;
  const e = escapeHtml;
  return `<div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:0 0 12px">
<div style="font-size:16px;font-weight:600"><a href="${e(l.url)}">${e(headline(lead))}</a></div>
<div style="margin:6px 0"><a href="${e(l.url)}">${e(l.url)}</a></div>
<div><b>Why:</b> ${e(l.reasons.join('; ') || 'n/a')}${lead.aiReason ? ` <i>(AI: ${e(lead.aiReason)})</i>` : ''}</div>
<div><b>First discovered:</b> ${e(londonStamp(l.firstSeenAt))} UK · <b>Originally posted:</b> ${e(l.publishedText ?? 'not shown')}</div>
<div><b>Unknown:</b> ${e(unknowns(l).join(', ') || 'nothing')}</div>
${l.description ? `<div style="color:#555;margin-top:6px">${e(l.description.slice(0, 300))}</div>` : ''}
<div style="margin-top:8px"><a href="${e(reviewUrl(workerUrl, l.id))}">Interested / Pass</a></div>
</div>`;
}

/** Machine-readable block so an optional downstream mail-triggered analysis can parse the email. */
function leadJson(leads: readonly Lead[]): string {
  return JSON.stringify(
    leads.map((x) => ({
      id: x.listing.id,
      url: x.listing.url,
      title: x.listing.title,
      price_gbp: x.listing.pricePence === null ? null : x.listing.pricePence / 100,
      previous_price_gbp: x.previousPricePence === null ? null : x.previousPricePence / 100,
      location: x.listing.location,
      distance_miles: x.listing.distanceMiles,
      year: x.listing.year,
      mileage: x.listing.mileage,
      first_discovered_at: x.listing.firstSeenAt,
      originally_posted: x.listing.publishedText,
      score: x.listing.score,
      reasons: x.listing.reasons,
      class: x.class,
    })),
  );
}

export function renderUrgentEmail(leads: readonly Lead[], workerUrl: string): { subject: string; text: string; html: string } {
  const sorted = [...leads].sort((a, b) => (b.listing.score ?? 0) - (a.listing.score ?? 0));
  const top = sorted[0]!;
  const more = sorted.length > 1 ? ` (+${sorted.length - 1} more)` : '';
  const subject = `[Car lead] ${headline(top)}${more}`.slice(0, 200);
  const text = [
    `${sorted.length} new lead${sorted.length > 1 ? 's' : ''} from Facebook Marketplace.`,
    '',
    ...sorted.flatMap((x) => [leadText(x, workerUrl), '']),
    'Scores are a ranking aid, not a valuation. "First discovered" is when the collector found the advert; it may have been posted earlier.',
    '',
    `LEADS-JSON: ${leadJson(sorted)}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font:14px/1.45 system-ui,sans-serif;color:#111;max-width:680px">
<p>${sorted.length} new lead${sorted.length > 1 ? 's' : ''} from Facebook Marketplace.</p>
${sorted.map((x) => leadHtml(x, workerUrl)).join('\n')}
<p style="color:#666;font-size:12px">Scores are a ranking aid, not a valuation. "First discovered" is when the collector found the advert; it may have been posted earlier.</p>
</body></html>`;
  return { subject, text, html };
}

export function renderRoundupEmail(leads: readonly Lead[], workerUrl: string, dateLabel: string): { subject: string; text: string; html: string } {
  const sorted = [...leads].sort((a, b) => (b.listing.score ?? 0) - (a.listing.score ?? 0));
  const subject = `[Car leads] Daily review: ${sorted.length} borderline advert${sorted.length > 1 ? 's' : ''} (${dateLabel})`;
  const text = [
    `Borderline Marketplace adverts from the last day that did not trigger an immediate alert. Each appears in one roundup only.`,
    '',
    ...sorted.flatMap((x) => [leadText(x, workerUrl), '']),
    `LEADS-JSON: ${leadJson(sorted)}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font:14px/1.45 system-ui,sans-serif;color:#111;max-width:680px">
<p>Borderline Marketplace adverts from the last day that did not trigger an immediate alert. Each appears in one roundup only.</p>
${sorted.map((x) => leadHtml(x, workerUrl)).join('\n')}
</body></html>`;
  return { subject, text, html };
}

// ───────────── operational alerts (no listing content) ─────────────

export type MarketAlertCode =
  | 'FB_LOGIN_REQUIRED'
  | 'FB_CHECKPOINT'
  | 'COLLECT_FAILED'
  | 'CIRCUIT_OPEN'
  | 'COST_GUARD'
  | 'COST_WARN'
  | 'LEAD_EMAIL_FAILED'
  | 'OP_FAILED'
  | 'SNAPSHOT_EXPIRING'
  | 'TEST';

export const MARKET_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export function shouldSendAlert(code: MarketAlertCode, lastSent: Readonly<Record<string, number>>, now: number): boolean {
  if (code === 'TEST') return true;
  const last = lastSent[code];
  return last === undefined || now - last >= MARKET_ALERT_COOLDOWN_MS;
}

export function renderOpsAlert(a: { code: MarketAlertCode; title: string; detail: string[]; action: string }, workerUrl: string): { subject: string; text: string } {
  return {
    subject: `[Car leads] Alert: ${a.title}`,
    text: [a.title, '', ...a.detail.map((d) => `- ${d}`), '', `What to do: ${a.action}`, '', `Admin: ${workerUrl}/admin`].join('\n'),
  };
}
