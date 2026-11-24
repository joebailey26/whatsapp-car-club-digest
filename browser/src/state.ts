/**
 * Candidate selectors and pure state classification for WhatsApp Web.
 * No DOM or Puppeteer imports, so this is unit-testable anywhere.
 *
 * STATUS: UNVERIFIED. These selectors are starting points, not facts. WhatsApp
 * Web's DOM changes without notice. During the Phase 1 test, check the
 * `matched` array returned by GET /session/status (selector *names* only, never
 * page content) to see which candidates fire in each state, record the
 * verified ones in docs/selectors.md, and delete the rest.
 *
 * Accessible labels are preferred over class names, per the spec.
 */
export const CANDIDATE_SELECTORS = {
  // Pairing screen: the QR code is rendered into a <canvas>.
  qr_canvas_aria: 'canvas[aria-label*="QR" i]',
  qr_canvas_aria_scan: 'canvas[aria-label*="scan" i]',
  qr_data_ref: 'div[data-ref] canvas',
  // Logged-in shell: the chat list.
  chat_list_aria: '[aria-label="Chat list" i]',
  chat_list_grid: '[role="grid"][aria-label*="chat" i]',
  chat_pane_id: '#pane-side',
  // Progress bar shown while the logged-in app loads ("Loading your chats").
  progress: 'progress',
} as const;

export type SelectorName = keyof typeof CANDIDATE_SELECTORS;

export type WhatsAppState =
  | 'not_running' // no browser
  | 'loading' // page up, neither QR nor chat list yet
  | 'qr' // pairing / logged out: QR code visible
  | 'authenticated' // chat list visible
  | 'unknown'; // page loaded but nothing recognisable (e.g. unsupported-browser page, dialog)

const QR_KEYS: readonly string[] = ['qr_canvas_aria', 'qr_canvas_aria_scan', 'qr_data_ref'];
const AUTH_KEYS: readonly string[] = ['chat_list_aria', 'chat_list_grid', 'chat_pane_id'];

/**
 * Pseudo-signal added to `matched` when the page has left WhatsApp's login
 * route. Verified 2026-11-23: unauthenticated sessions are served at
 * https://web.whatsapp.com/login/.
 */
export const URL_NOT_LOGIN = 'url_not_login';

export function isLoginPath(pathname: string | null): boolean {
  return pathname !== null && /^\/login(\/|$)/.test(pathname);
}

/**
 * Classify from matched selector names (plus the URL pseudo-signal).
 * Ambiguous results (QR and chat list both present) are never treated as
 * authenticated. The URL fallback applies only when no chat-list selector
 * matches, no QR is visible, and loading has finished.
 */
export function classifyState(matched: readonly string[], readyState: string): WhatsAppState {
  const hasAuth = matched.some((m) => AUTH_KEYS.includes(m));
  const hasQr = matched.some((m) => QR_KEYS.includes(m));
  if (hasAuth && !hasQr) return 'authenticated';
  if (hasQr && !hasAuth) return 'qr';
  if (matched.includes('progress') || readyState !== 'complete') return 'loading';
  if (!hasQr && matched.includes(URL_NOT_LOGIN)) return 'authenticated';
  return 'unknown';
}
