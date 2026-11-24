import { coverageNote, longDate, shortDate, type DigestItem, type DigestModel } from './model';
import type { SaleItem, SalesSection } from './sales';

/**
 * HTML + plain-text rendering. Every value derived from WhatsApp messages is
 * escaped. The email contains no remote images, links to message content,
 * tracking or attachments, and never includes raw transcripts.
 */

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
  markdown: string;
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const BADGE_LABEL: Record<DigestItem['badges'][number], string> = {
  new: 'New',
  confirmed: 'Confirmed',
  tentative: 'Tentative',
  updated: 'Updated',
  cancelled: 'Cancelled',
  check: 'Check the chat',
  rsvp: 'Reply needed',
};
const BADGE_COLOUR: Record<DigestItem['badges'][number], string> = {
  new: '#0a6c5a',
  confirmed: '#1e6b2e',
  tentative: '#8a5a00',
  updated: '#1d4f91',
  cancelled: '#a12620',
  check: '#8a2b8a',
  rsvp: '#1d4f91',
};

export function subjectFor(m: DigestModel): string {
  const tag = m.coverageComplete ? '' : ' (incomplete)';
  return `Your Car Club Weekly Digest — ${longDate(m.id)}${tag}`;
}

function itemHtml(i: DigestItem, opts: { showChanges: boolean }): string {
  const badges = i.badges
    .map((b) => `<span style="display:inline-block;font-size:11px;font-weight:600;color:${BADGE_COLOUR[b]};border:1px solid ${BADGE_COLOUR[b]};border-radius:10px;padding:1px 7px;margin-right:4px">${BADGE_LABEL[b]}</span>`)
    .join('');
  const lines: string[] = [];
  if (i.where) lines.push(`<div>📍 ${esc(i.where)}</div>`);
  if (i.meetingPoint && i.meetingPoint !== i.where) lines.push(`<div>Meeting point: ${esc(i.meetingPoint)}</div>`);
  if (opts.showChanges) for (const c of i.changes) lines.push(`<div style="color:#1d4f91">↻ ${esc(c)}</div>`);
  if (i.action) lines.push(`<div style="color:#1d4f91;font-weight:600">→ ${esc(i.action)}</div>`);
  if (i.needsReview) lines.push('<div style="color:#8a2b8a">Messages disagree on some details. Check the group before travelling.</div>');
  if (i.badges.includes('tentative')) lines.push('<div style="color:#8a5a00">Suggested or unconfirmed.</div>');
  lines.push(`<div style="color:#6b6b70;font-size:12px">${esc(i.provenance)}</div>`);
  return `<div style="margin:0 0 14px;padding:10px 12px;border:1px solid #e3e3e8;border-radius:8px">
  <div style="font-weight:600;font-size:15px">${esc(i.title)}</div>
  <div style="margin:2px 0 6px;color:#333">${esc(i.when)}</div>
  <div style="margin-bottom:6px">${badges}</div>
  ${lines.join('\n  ')}
</div>`;
}

function itemText(i: DigestItem, opts: { showChanges: boolean }): string {
  const out = [`* ${i.title} — ${i.when}  [${i.badges.map((b) => BADGE_LABEL[b]).join(', ')}]`];
  if (i.where) out.push(`  Where: ${i.where}`);
  if (i.meetingPoint && i.meetingPoint !== i.where) out.push(`  Meeting point: ${i.meetingPoint}`);
  if (opts.showChanges) for (const c of i.changes) out.push(`  Changed: ${c}`);
  if (i.action) out.push(`  Action: ${i.action}`);
  if (i.needsReview) out.push('  Messages disagree on some details. Check the group before travelling.');
  if (i.badges.includes('tentative')) out.push('  Suggested or unconfirmed.');
  out.push(`  Source: ${i.provenance}`);
  return out.join('\n');
}

const SALE_GROUPS = (s: SalesSection): Array<[string, SaleItem[]]> =>
  ([['Cars', s.newCars], ['Parts', s.newParts], ['Price changes', s.priceChanges], ['Sold or withdrawn', s.closed]] as Array<[string, SaleItem[]]>).filter(([, xs]) => xs.length > 0);

function salesHtml(s: SalesSection): string {
  if (s.total === 0) return '';
  const rows = SALE_GROUPS(s)
    .map(
      ([label, xs]) => `<h3 style="font-size:13px;margin:12px 0 6px;color:#444;text-transform:uppercase;letter-spacing:.04em">${esc(label)}</h3>
  ${xs
    .map(
      (x) => `<div style="margin:0 0 10px;padding:8px 10px;border-left:3px solid #e3e3e8">
    <div style="font-weight:600">${esc(x.title)}${x.note ? ` <span style="font-weight:400;color:#1d4f91">(${esc(x.note)})</span>` : ''}</div>
    <div style="color:#333">${esc(x.facts)}</div>
    ${x.details ? `<div style="color:#555;font-size:13px">${esc(x.details)}</div>` : ''}
    <div style="color:#6b6b70;font-size:12px">${esc(x.provenance)}</div>
  </div>`,
    )
    .join('\n  ')}`,
    )
    .join('\n  ');
  return `<h2 style="font-size:16px;margin:22px 0 6px;border-bottom:1px solid #e3e3e8;padding-bottom:4px">For sale</h2>
  ${rows}
  ${s.more ? `<p style="color:#6b6b70;font-size:13px">+${s.more} more not shown.</p>` : ''}
  <p style="color:#8a8a90;font-size:12px">Listings are taken from what members posted (photos are not included). Check the group before arranging anything.</p>`;
}

function salesText(s: SalesSection): string[] {
  if (s.total === 0) return [];
  return [
    '',
    'FOR SALE',
    ...SALE_GROUPS(s).flatMap(([label, xs]) => [
      `${label}:`,
      ...xs.flatMap((x) => [`* ${x.title}${x.note ? ` (${x.note})` : ''} — ${x.facts}`, ...(x.details ? [`  ${x.details}`] : []), `  ${x.provenance}`]),
    ]),
    ...(s.more ? [`+${s.more} more not shown.`] : []),
    'Listings are taken from what members posted (photos are not included). Check the group before arranging anything.',
  ];
}

export function renderDigest(m: DigestModel): RenderedDigest {
  const subject = subjectFor(m);
  const sections: Array<{ title: string; items: DigestItem[]; showChanges: boolean; empty?: string }> = [
    { title: 'Upcoming meets', items: m.upcoming, showChanges: true },
    { title: 'Changed arrangements', items: m.changed, showChanges: true },
    { title: 'Action required', items: m.actions, showChanges: false },
    { title: 'Cancelled', items: m.cancelled, showChanges: false },
  ];
  // Changed/Action items are also listed under Upcoming; in those sections show them compactly.
  const visible = sections.filter((s) => s.items.length > 0);

  const coverageRows = m.coverage
    .map((c) => {
      const ok = !m.missingGroups.includes(c.groupName);
      return `<tr><td style="padding:3px 10px 3px 0">${ok ? '✅' : '⚠️'} ${esc(c.groupName)}</td><td style="padding:3px 0;color:#444">${esc(coverageNote(c))}</td></tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f6f8">
<div style="max-width:600px;margin:0 auto;padding:20px 16px;font:15px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;background:#ffffff">
  <h1 style="font-size:20px;margin:0 0 4px">Car Club Weekly Digest</h1>
  <div style="color:#6b6b70;margin-bottom:14px">${esc(longDate(m.id))}</div>
  <p style="margin:0 0 18px;font-weight:600">${esc(m.headline)}</p>
  ${
    m.coverageComplete
      ? ''
      : `<div style="margin:0 0 18px;padding:10px 12px;background:#fff4e5;border:1px solid #f0c27a;border-radius:8px"><b>Incomplete coverage.</b> These groups could not be fully checked, so meets or changes in them may be missing: ${esc(m.missingGroups.join(', '))}.</div>`
  }
  ${visible
    .map(
      (s) => `<h2 style="font-size:16px;margin:22px 0 10px;border-bottom:1px solid #e3e3e8;padding-bottom:4px">${esc(s.title)}</h2>
  ${s.items.map((i) => itemHtml(i, { showChanges: s.showChanges && s.title !== 'Upcoming meets' ? true : s.title === 'Upcoming meets' && !m.changed.includes(i) })).join('\n  ')}`,
    )
    .join('\n  ')}
  ${
    m.upcoming.length === 0 && m.cancelled.length === 0
      ? '<p style="color:#444">Most messages were general car chat, with nothing to act on.</p>'
      : ''
  }
  ${salesHtml(m.sales)}
  <h2 style="font-size:14px;margin:26px 0 8px;color:#444">Groups checked</h2>
  <table style="border-collapse:collapse;font-size:13px">${coverageRows}</table>
  <p style="margin:22px 0 0;font-size:12px;color:#8a8a90">Generated automatically from WhatsApp group exports. Details are taken only from what members wrote; anything marked tentative or "check the chat" may be wrong. This digest does not mean you have replied to or booked anything.</p>
</div></body></html>`;

  const text = [
    `CAR CLUB WEEKLY DIGEST — ${longDate(m.id)}`,
    '',
    m.headline,
    ...(m.coverageComplete ? [] : ['', `INCOMPLETE COVERAGE: ${m.missingGroups.join(', ')} could not be fully checked, so meets or changes there may be missing.`]),
    ...visible.flatMap((s) => ['', s.title.toUpperCase(), ...s.items.map((i) => itemText(i, { showChanges: s.title !== 'Action required' && s.title !== 'Cancelled' }))]),
    ...(m.upcoming.length === 0 && m.cancelled.length === 0 ? ['', 'Most messages were general car chat, with nothing to act on.'] : []),
    ...salesText(m.sales),
    '',
    'GROUPS CHECKED',
    ...m.coverage.map((c) => `- ${c.groupName}: ${coverageNote(c)}`),
    '',
    'Generated automatically from WhatsApp group exports. Details come only from what members wrote. Tentative or "check the chat" items may be wrong. This digest does not mean you have replied to or booked anything.',
  ].join('\n');

  const markdown = [
    `# Car Club Weekly Digest — ${longDate(m.id)}`,
    '',
    `**${m.headline}**`,
    ...(m.coverageComplete ? [] : ['', `> **Incomplete coverage:** ${m.missingGroups.join(', ')}`]),
    ...visible.flatMap((s) => [
      '',
      `## ${s.title}`,
      ...s.items.map((i) => `- **${i.title}**, ${i.when}${i.where ? `, ${i.where}` : ''} (${i.badges.map((b) => BADGE_LABEL[b]).join(', ')})${i.changes.length ? `\n  - ${i.changes.join('\n  - ')}` : ''}${i.action ? `\n  - ${i.action}` : ''}\n  - _${i.provenance}_`),
    ]),
    ...(m.sales.total ? ['', '## For sale', ...SALE_GROUPS(m.sales).flatMap(([label, xs]) => [`### ${label}`, ...xs.map((x) => `- **${x.title}**${x.note ? ` (${x.note})` : ''}: ${x.facts}. _${x.provenance}_`)])] : []),
    '',
    '## Groups checked',
    ...m.coverage.map((c) => `- ${c.groupName}: ${coverageNote(c)}`),
  ].join('\n');

  void shortDate;
  return { subject, html, text, markdown };
}
