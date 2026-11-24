import type { Page } from 'puppeteer-core';
import { CANDIDATE_SELECTORS, URL_NOT_LOGIN, classifyState, isLoginPath, type SelectorName, type WhatsAppState } from './state.js';

export { type WhatsAppState } from './state.js';

export const WHATSAPP_URL = 'https://web.whatsapp.com/';

export interface StateProbe {
  state: WhatsAppState;
  matched: Array<SelectorName | typeof URL_NOT_LOGIN>;
  /** document.title with digits masked (it may carry an unread count). */
  title: string | null;
  url: string | null;
}

export async function probeState(page: Page): Promise<StateProbe> {
  // Evaluate only element *presence*; no text or attributes are returned.
  const result = await page.evaluate((sels: Record<string, string>) => {
    const matched: string[] = [];
    for (const [name, sel] of Object.entries(sels)) {
      try {
        if (document.querySelector(sel)) matched.push(name);
      } catch {
        /* selector unsupported in this engine; ignore */
      }
    }
    return { matched, title: document.title, ready: document.readyState };
  }, CANDIDATE_SELECTORS as unknown as Record<string, string>);

  const matched = result.matched as Array<SelectorName | typeof URL_NOT_LOGIN>;
  const url = safeOrigin(page.url());
  let pathname: string | null = null;
  try {
    pathname = new URL(page.url()).pathname;
  } catch {
    /* about:blank etc. */
  }
  if (url?.startsWith('https://web.whatsapp.com/') && !isLoginPath(pathname)) matched.push(URL_NOT_LOGIN);
  return {
    state: classifyState(matched, result.ready),
    matched,
    title: result.title ? result.title.replace(/\d+/g, '#').slice(0, 60) : null,
    url,
  };
}

function safeOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`; // drop query/hash
  } catch {
    return null;
  }
}
