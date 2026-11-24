/**
 * Operational alerts. They're kept separate from the digest, are plain text,
 * and contain only codes, group names and counts: never message content.
 * Each code is sent at most once per ALERT_COOLDOWN_MS.
 */

export const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type AlertCode =
  | 'RELINK_REQUIRED'
  | 'SESSION_FAILED'
  | 'EXPORT_FAILED'
  | 'PROCESSING_FAILED'
  | 'ANALYSIS_FAILED'
  | 'DIGEST_SEND_FAILED'
  | 'OP_FAILED'
  | 'SCHEDULED_RUN_SKIPPED'
  | 'MISSED_WEEKLY_RUN'
  | 'SNAPSHOT_EXPIRING'
  | 'AI_USAGE_HIGH'
  | 'TEST';

export interface Alert {
  code: AlertCode;
  title: string;
  detail: string[];
  action: string;
}

export interface RunSummary {
  runId: string;
  sessionOutcome: string; // pass | relink_required | indeterminate | error
  sessionError: string | null;
  records: Array<{ groupName: string; status: string; errorCode: string | null; failedStep: string | null }>;
  processing: Array<{ groupName: string; status: string; errorCode: string | null }>;
  analysis: Array<{ groupName: string; status: string; reason: string | null }>;
  digest: { status: string; errorCode: string | null } | null;
}

/** Alerts warranted by one completed run (pure; unit-tested). */
export function alertsForRun(r: RunSummary): Alert[] {
  const out: Alert[] = [];
  if (r.sessionOutcome === 'relink_required') {
    out.push({
      code: 'RELINK_REQUIRED',
      title: 'WhatsApp needs re-linking',
      detail: [`Run ${r.runId}: WhatsApp Web showed the QR code instead of your chats. No groups were exported.`],
      action: 'Open /admin, press Start pairing, scan with WhatsApp → Linked devices, then Complete pairing. Remove the old linked device on your phone.',
    });
    return out; // everything else is a consequence
  }
  if (r.sessionOutcome !== 'pass') {
    out.push({
      code: 'SESSION_FAILED',
      title: 'Weekly run could not start a WhatsApp session',
      detail: [`Run ${r.runId}: session ${r.sessionOutcome}${r.sessionError ? ` (${r.sessionError})` : ''}.`],
      action: 'Check /admin status. Run "Run restore test" once. If it reports relink_required, pair again.',
    });
  }
  const failedExports = r.records.filter((x) => x.status !== 'succeeded');
  if (failedExports.length && r.sessionOutcome === 'pass') {
    out.push({
      code: 'EXPORT_FAILED',
      title: `${failedExports.length} group export${failedExports.length > 1 ? 's' : ''} failed`,
      detail: failedExports.map((x) => `${x.groupName}: ${x.status}${x.errorCode ? ` ${x.errorCode}` : ''}${x.failedStep ? ` at ${x.failedStep}` : ''}`),
      action: 'The digest marks these groups as not checked. If this repeats, WhatsApp Web may have changed. Run an inspection from /admin and update the export flow.',
    });
  }
  const failedProc = r.processing.filter((x) => x.status === 'failed');
  if (failedProc.length) {
    out.push({
      code: 'PROCESSING_FAILED',
      title: 'Some exports could not be read',
      detail: failedProc.map((x) => `${x.groupName}: ${x.errorCode ?? 'failed'}`),
      action: 'Reprocess from storage with POST /admin/api/process once fixed. No new WhatsApp export is needed.',
    });
  }
  const failedAi = r.analysis.filter((x) => ['failed', 'partial', 'budget_exceeded'].includes(x.status));
  if (failedAi.length) {
    out.push({
      code: 'ANALYSIS_FAILED',
      title: 'Event analysis was incomplete',
      detail: failedAi.map((x) => `${x.groupName}: ${x.status}${x.reason ? ` (${x.reason})` : ''}`),
      action: 'Re-run with POST /admin/api/analyse. Check the AI budget settings if it says budget_exceeded.',
    });
  }
  if (r.digest && r.digest.status === 'failed') {
    out.push({
      code: 'DIGEST_SEND_FAILED',
      title: 'The weekly digest email could not be sent',
      detail: [`Error: ${r.digest.errorCode ?? 'unknown'}. The digest is stored and can be re-sent without re-exporting.`],
      action: 'POST /admin/api/digest {"resend":true} from the admin page once the cause is fixed.',
    });
  }
  return out;
}

export function shouldSend(code: AlertCode, lastSent: Readonly<Record<string, number>>, now: number): boolean {
  if (code === 'TEST') return true;
  const last = lastSent[code];
  return last === undefined || now - last >= ALERT_COOLDOWN_MS;
}

export function renderAlert(a: Alert, workerUrl: string): { subject: string; text: string } {
  return {
    subject: `[Car Club Digest] Alert: ${a.title}`,
    text: [
      a.title,
      '',
      ...a.detail.map((d) => `- ${d}`),
      '',
      `What to do: ${a.action}`,
      '',
      `Admin: ${workerUrl}/admin`,
      '',
      'This is an automated operational alert. It contains no WhatsApp message content.',
    ].join('\n'),
  };
}
