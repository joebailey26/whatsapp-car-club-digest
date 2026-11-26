/**
 * Pure Facebook session-state classification (no DOM imports; unit-tested).
 *
 * STATUS: UNVERIFIED against live Facebook. Check `signals` returned by
 * GET /session/status during the login test and record what fires in
 * docs/marketplace.md.
 *
 * The collector must STOP on anything that is not plainly an authenticated
 * session: a login form, a checkpoint/verification route, or account-warning
 * wording. It never tries to get past any of them.
 */

export type FbState =
  | 'not_running'
  | 'loading'
  | 'login' // logged out: login form or login route
  | 'checkpoint' // verification challenge, CAPTCHA, account warning or restriction
  | 'authenticated'
  | 'unknown';

export interface FbSignals {
  /** URL path on facebook.com (no query). */
  path: string | null;
  onFacebook: boolean;
  hasLoginForm: boolean;
  /** A session cookie named c_user exists (presence only; the value is never read). */
  hasSessionCookie: boolean;
  /** Visible text contains account-warning / challenge wording (boolean only). */
  warning: boolean;
  readyState: string;
}

const CHECKPOINT_PATHS = /^\/(checkpoint|two_step_verification|two_factor|authentication|recover|confirmemail|login\/identify|help\/contact|captcha|privacy\/consent)(\/|$)/i;
const LOGIN_PATHS = /^\/(login|login\.php|r\.php|reg)(\/|$)/i;

/** Lower-case phrases that mean "stop and let the owner look". Matched on page text inside the browser. */
export const WARNING_PHRASES: readonly string[] = [
  'your account has been locked',
  'your account has been disabled',
  'we suspended your account',
  'your account has been suspended',
  'confirm your identity',
  'security check',
  'enter the characters you see',
  'we noticed unusual activity',
  'suspicious activity',
  "you're temporarily blocked",
  'you’re temporarily blocked',
  'temporarily blocked',
  "you can't use this feature right now",
  'you can’t use this feature right now',
  'your account is restricted',
  'account restricted',
  'we limit how often you can',
  'help us confirm it’s you',
  "help us confirm it's you",
];

export function classifyFb(s: FbSignals): FbState {
  if (!s.onFacebook) return s.readyState === 'complete' ? 'unknown' : 'loading';
  if (s.path && CHECKPOINT_PATHS.test(s.path)) return 'checkpoint';
  if (s.warning) return 'checkpoint';
  if ((s.path && LOGIN_PATHS.test(s.path)) || s.hasLoginForm) return 'login';
  if (s.readyState !== 'complete') return 'loading';
  return s.hasSessionCookie ? 'authenticated' : 'login';
}

/** Allowed hosts for navigation: the collector only ever loads Facebook. */
export function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /^(www\.|m\.)?facebook\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Keys the remote login console may press. */
export const ALLOWED_KEYS: readonly string[] = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
