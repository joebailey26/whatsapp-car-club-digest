import type { Page } from 'puppeteer-core';

/**
 * Redacted UI inspection, used to discover real selectors without exposing
 * conversation content.
 *
 * Returns *interactive chrome only* (buttons, menu items, dialogs, inputs) and
 * excludes:
 *  - the chat list (#pane-side) and anything in rows, list items or grid cells
 *    (message bubbles, chat rows)
 *  - contenteditable regions (the composer and search drafts)
 *  - input values (never read)
 * Long strings are truncated, phone-number-like sequences masked, and list-like
 * labels (commas, as in participant lists) dropped.
 */

export interface UiNode {
  tag: string;
  role: string | null;
  label: string | null;
  title: string | null;
  icon: string | null;
  testid: string | null;
  text: string | null;
  inputType: string | null;
  checked: string | null;
  where: 'menu' | 'dialog' | 'header' | 'side' | 'other';
}

export async function inspectUi(page: Page): Promise<UiNode[]> {
  return page.evaluate(() => {
    const EXCLUDE =
      '#pane-side, [role="row"], [role="listitem"], [role="gridcell"], [contenteditable="true"], .message-in, .message-out';
    const SEL = [
      'button',
      '[role="button"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="menuitemcheckbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="option"]',
      '[role="tab"]',
      '[role="switch"]',
      'input',
      'select',
      '[role="dialog"] h1',
      '[role="dialog"] h2',
      '[role="dialog"] h3',
      '[role="heading"]',
    ].join(',');

    const mask = (s: string | null, max = 80): string | null => {
      if (!s) return null;
      const t = s.replace(/\s+/g, ' ').trim();
      if (!t) return null;
      if (t.includes(',') && t.length > 30) return '[list]';
      return t.replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]').slice(0, max);
    };

    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<Element>();
    for (const el of Array.from(document.querySelectorAll(SEL))) {
      if (out.length >= 150) break;
      if (seen.has(el) || el.closest(EXCLUDE)) continue;
      seen.add(el);
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const inMenu = !!el.closest('[role="menu"], [role="listbox"], [data-animate-dropdown-item], ul[role]');
      const inDialog = !!el.closest('[role="dialog"], [role="alertdialog"], [data-animate-modal-popup]');
      const inHeader = !!el.closest('header');
      const inSide = !!el.closest('#side, [data-testid="chatlist-header"]');
      const where = inMenu ? 'menu' : inDialog ? 'dialog' : inHeader ? 'header' : inSide ? 'side' : 'other';

      const role = el.getAttribute('role');
      const isTextual = inMenu || inDialog || /^h[1-3]$/i.test(el.tagName) || role === 'heading' || role === 'menuitem' || role === 'option' || role === 'radio' || role === 'checkbox';
      const iconEl = el.querySelector('[data-icon]') ?? el.closest('[data-icon]');
      out.push({
        tag: el.tagName.toLowerCase(),
        role,
        label: mask(el.getAttribute('aria-label')),
        title: mask(el.getAttribute('title')),
        icon: iconEl?.getAttribute('data-icon') ?? null,
        testid: el.getAttribute('data-testid'),
        text: isTextual ? mask((el as HTMLElement).innerText, 60) : null,
        inputType: el.tagName === 'INPUT' ? (el as HTMLInputElement).type : null,
        checked: el.getAttribute('aria-checked') ?? (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type) ? String((el as HTMLInputElement).checked) : null),
        where,
      });
    }
    return out;
  }) as unknown as Promise<UiNode[]>;
}
