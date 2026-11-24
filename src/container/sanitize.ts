/**
 * Second redaction layer for inspection output, applied in the Worker so it
 * can be tightened without a new container image. Drops message-area chrome
 * that can carry people's names (e.g. avatar buttons labelled "Open chat
 * details for <name>", seen 2026-11-23) and keeps only navigational chrome.
 */
export function sanitizeUi(nodes: readonly unknown[]): unknown[] {
  const PERSONAL = /(chat details for|profile|contact|message from|replied|reacted|@)/i;
  return nodes.filter((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const n = raw as Record<string, unknown>;
    const s = (k: string): string => (typeof n[k] === 'string' ? (n[k] as string) : '');
    if (s('testid') === 'group-chat-profile-picture') return false;
    if (PERSONAL.test(s('label')) || PERSONAL.test(s('title'))) return false;
    // Unlabelled elements in the message area carry no selector value.
    if (n.where === 'other' && !s('label') && !s('title') && !s('testid')) return false;
    return true;
  });
}
