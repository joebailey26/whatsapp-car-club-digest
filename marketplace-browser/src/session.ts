import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core';
import { errorCode, log } from './log.js';
import { ALLOWED_KEYS, WARNING_PHRASES, classifyFb, isAllowedUrl, type FbSignals, type FbState } from './state.js';

const execFileAsync = promisify(execFile);

export const MARKETPLACE_URL = 'https://www.facebook.com/marketplace/';
export const LOGIN_URL = 'https://www.facebook.com/login/';

export interface SessionConfig {
  executablePath: string;
  profileDir: string;
  navigationTimeoutMs: number;
}

export interface Probe {
  state: FbState;
  signals: FbSignals | null;
}

export interface CollectSearch {
  id: string;
  url: string;
  maxScrolls: number;
}

export interface SearchResult {
  id: string;
  ok: boolean;
  errorCode: string | null;
  state: FbState;
  cards: Array<{ href: string; lines: string[]; photo: string | null }>;
  navMs: number;
  collectMs: number;
}

export interface CollectResult {
  aborted: string | null;
  searches: SearchResult[];
}

/**
 * One Chromium on a persistent profile, used only for Facebook Marketplace.
 *
 * Same principles as the WhatsApp browser: headful on Xvfb, no user-agent
 * spoofing, no stealth plugins, no fingerprint changes and no attempt to get
 * past a login, checkpoint or warning page. It only reads visible listing
 * cards and item pages; it never clicks Message, Make offer or anything that
 * contacts a seller.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private launchedAt: number | undefined;
  private blocking = false;

  constructor(private readonly cfg: SessionConfig) {}

  get running(): boolean {
    return this.browser?.connected === true;
  }

  async start(url: string = MARKETPLACE_URL): Promise<Probe> {
    if (this.running && this.page) return this.status();
    const t0 = Date.now();
    await mkdir(this.cfg.profileDir, { recursive: true });
    await this.clearStaleSingletonLocks();
    this.browser = await puppeteer.launch({
      executablePath: this.cfg.executablePath,
      headless: false,
      userDataDir: this.cfg.profileDir,
      defaultViewport: { width: 1280, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--disable-gpu',
        '--window-size=1280,900',
        '--lang=en-GB',
        // Lean: keep memory low enough for a small instance.
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        '--renderer-process-limit=2',
        '--mute-audio',
      ],
      handleSIGTERM: true,
      handleSIGINT: true,
    });
    this.launchedAt = Date.now();
    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
    this.page.setDefaultNavigationTimeout(this.cfg.navigationTimeoutMs);
    await this.page.goto(isAllowedUrl(url) ? url : MARKETPLACE_URL, { waitUntil: 'domcontentloaded' });
    log('info', 'browser_started', { duration_ms: Date.now() - t0 });
    return this.status();
  }

  async status(): Promise<Probe> {
    if (!this.running || !this.page) return { state: 'not_running', signals: null };
    const page = this.page;
    let path: string | null = null;
    let onFacebook = false;
    try {
      const u = new URL(page.url());
      onFacebook = isAllowedUrl(u.toString());
      path = u.pathname;
    } catch {
      /* about:blank */
    }
    const dom = await page
      .evaluate((phrases: readonly string[]) => {
        const text = (document.body?.innerText ?? '').slice(0, 4000).toLowerCase();
        return {
          hasLoginForm: !!document.querySelector('form input[name="pass"], form input[type="password"]'),
          warning: phrases.some((p) => text.includes(p)),
          readyState: document.readyState,
        };
      }, WARNING_PHRASES)
      .catch(() => ({ hasLoginForm: false, warning: false, readyState: 'loading' }));
    const cookies = await page.cookies('https://www.facebook.com').catch(() => []);
    const signals: FbSignals = { path, onFacebook, hasSessionCookie: cookies.some((c) => c.name === 'c_user'), ...dom };
    return { state: classifyFb(signals), signals };
  }

  /** Poll until authenticated / login / checkpoint holds for 3 probes, or timeout. */
  async waitForSettled(timeoutMs: number, pollMs = 1000): Promise<Probe> {
    const settled = (s: FbState): boolean => s === 'authenticated' || s === 'login' || s === 'checkpoint';
    const deadline = Date.now() + timeoutMs;
    let last = await this.status();
    let streak = settled(last.state) ? 1 : 0;
    while (Date.now() < deadline && streak < 3 && last.state !== 'not_running') {
      await sleep(pollMs);
      const next = await this.status();
      streak = settled(next.state) && next.state === last.state ? streak + 1 : settled(next.state) ? 1 : 0;
      last = next;
    }
    return streak >= 3 || !settled(last.state) ? last : { ...last, state: 'loading' };
  }

  /** Screenshot for the remote login console only. Refused once authenticated, so feeds and messages are never captured. */
  async loginScreenshot(): Promise<Uint8Array | { refused: string }> {
    if (!this.running || !this.page) return { refused: 'not_running' };
    const p = await this.status();
    if (p.state === 'authenticated') return { refused: 'authenticated' };
    return this.page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
  }

  /**
   * Remote input for the owner's own interactive sign-in. Typed text is never
   * logged or stored; only the event type is. Refused once authenticated.
   */
  async input(ev: unknown): Promise<{ ok: true } | { refused: string }> {
    if (!this.running || !this.page) return { refused: 'not_running' };
    const p = await this.status();
    if (p.state === 'authenticated') return { refused: 'authenticated' };
    const page = this.page;
    const e = ev as { type?: unknown; x?: unknown; y?: unknown; text?: unknown; key?: unknown; to?: unknown };
    switch (e.type) {
      case 'click': {
        const x = Number(e.x);
        const y = Number(e.y);
        if (!(x >= 0 && x <= 1280 && y >= 0 && y <= 900)) return { refused: 'bad_coordinates' };
        await page.mouse.click(x, y);
        break;
      }
      case 'type':
        if (typeof e.text !== 'string' || e.text.length === 0 || e.text.length > 256) return { refused: 'bad_text' };
        await page.keyboard.type(e.text, { delay: 40 });
        break;
      case 'key':
        if (typeof e.key !== 'string' || !ALLOWED_KEYS.includes(e.key)) return { refused: 'bad_key' };
        await page.keyboard.press(e.key === 'Space' ? ' ' : (e.key as 'Enter'));
        break;
      case 'navigate':
        if (e.to !== 'login' && e.to !== 'marketplace') return { refused: 'bad_target' };
        await page.goto(e.to === 'login' ? LOGIN_URL : MARKETPLACE_URL, { waitUntil: 'domcontentloaded' });
        break;
      default:
        return { refused: 'bad_type' };
    }
    log('info', 'login_input', { type: String(e.type) });
    return { ok: true };
  }

  private async setBlocking(on: boolean): Promise<void> {
    if (!this.page || on === this.blocking) return;
    this.blocking = on;
    await this.page.setRequestInterception(on);
    if (on) {
      this.page.on('request', onRequest);
    } else {
      this.page.off('request', onRequest);
    }
  }

  /**
   * Visit each search, scroll a bounded number of times and read result cards.
   * Stops the whole collection at the first sign of logout or a checkpoint.
   */
  async collect(searches: readonly CollectSearch[], opts: { maxItems: number; pageDelayMs: number; deadlineMs: number; blockImages: boolean }): Promise<CollectResult> {
    if (!this.running || !this.page) return { aborted: 'not_running', searches: [] };
    const page = this.page;
    const deadline = Date.now() + opts.deadlineMs;
    const out: SearchResult[] = [];
    await this.setBlocking(opts.blockImages).catch(() => undefined);
    try {
      for (const s of searches) {
        if (Date.now() > deadline - 10_000) {
          out.push({ id: s.id, ok: false, errorCode: 'RUN_DEADLINE', state: 'unknown', cards: [], navMs: 0, collectMs: 0 });
          continue;
        }
        if (!isAllowedUrl(s.url)) {
          out.push({ id: s.id, ok: false, errorCode: 'URL_NOT_ALLOWED', state: 'unknown', cards: [], navMs: 0, collectMs: 0 });
          continue;
        }
        const t0 = Date.now();
        try {
          await page.goto(s.url, { waitUntil: 'domcontentloaded' });
        } catch (err) {
          out.push({ id: s.id, ok: false, errorCode: `NAV_FAILED: ${errorCode(err).slice(0, 60)}`, state: 'unknown', cards: [], navMs: Date.now() - t0, collectMs: 0 });
          continue;
        }
        await page.waitForSelector('a[href*="/marketplace/item/"]', { timeout: 15_000 }).catch(() => undefined);
        const navMs = Date.now() - t0;
        const probe = await this.status();
        if (probe.state === 'login' || probe.state === 'checkpoint') {
          out.push({ id: s.id, ok: false, errorCode: probe.state === 'login' ? 'LOGGED_OUT' : 'CHECKPOINT', state: probe.state, cards: [], navMs, collectMs: 0 });
          return { aborted: probe.state, searches: out };
        }
        const t1 = Date.now();
        for (let i = 0; i < s.maxScrolls; i++) {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
          await sleep(1500);
        }
        const cards = await page.evaluate((max: number) => {
          const seen = new Set<string>();
          const res: Array<{ href: string; lines: string[]; photo: string | null }> = [];
          for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/marketplace/item/"]'))) {
            const href = a.getAttribute('href') ?? '';
            const id = /\/marketplace\/item\/(\d+)/.exec(href)?.[1];
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const lines = (a.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12);
            res.push({ href, lines, photo: a.querySelector('img')?.getAttribute('src') ?? null });
            if (res.length >= max) break;
          }
          return res;
        }, opts.maxItems);
        out.push({ id: s.id, ok: true, errorCode: cards.length ? null : 'NO_RESULTS', state: probe.state, cards, navMs, collectMs: Date.now() - t1 });
        log('info', 'search_collected', { search: s.id, cards: cards.length, nav_ms: navMs });
        await sleep(opts.pageDelayMs);
      }
      return { aborted: null, searches: out };
    } finally {
      await this.setBlocking(false).catch(() => undefined);
    }
  }

  /** Read visible text of item pages (description + "Listed … ago"), stopping before seller details. */
  async details(urls: readonly string[], opts: { pageDelayMs: number; deadlineMs: number }): Promise<{ aborted: string | null; items: Array<{ href: string; ok: boolean; lines: string[] }> }> {
    if (!this.running || !this.page) return { aborted: 'not_running', items: [] };
    const page = this.page;
    const deadline = Date.now() + opts.deadlineMs;
    const items: Array<{ href: string; ok: boolean; lines: string[] }> = [];
    await this.setBlocking(true).catch(() => undefined);
    try {
      for (const url of urls) {
        if (Date.now() > deadline - 8_000 || !isAllowedUrl(url) || !/\/marketplace\/item\/\d+\/?$/.test(new URL(url).pathname)) {
          items.push({ href: url, ok: false, lines: [] });
          continue;
        }
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await sleep(2500);
        } catch {
          items.push({ href: url, ok: false, lines: [] });
          continue;
        }
        const probe = await this.status();
        if (probe.state === 'login' || probe.state === 'checkpoint') return { aborted: probe.state, items };
        const lines = await page.evaluate(() => {
          const root = document.querySelector('[role="main"]') ?? document.body;
          const all = ((root as HTMLElement).innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
          const stop = all.findIndex((l) => /^(seller information|seller details|send seller a message)$/i.test(l));
          return (stop >= 0 ? all.slice(0, stop) : all).slice(0, 200);
        });
        items.push({ href: url, ok: true, lines });
        await sleep(opts.pageDelayMs);
      }
      return { aborted: null, items };
    } finally {
      await this.setBlocking(false).catch(() => undefined);
    }
  }

  /** Graceful shutdown so cookies and storage are flushed before a snapshot. */
  async close(): Promise<{ closed: boolean; uptime_ms: number | null }> {
    const uptime = this.launchedAt ? Date.now() - this.launchedAt : null;
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        log('warn', 'browser_close_error', { error_code: errorCode(err) });
        try {
          this.browser.process()?.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    this.browser = undefined;
    this.page = undefined;
    this.launchedAt = undefined;
    this.blocking = false;
    await syncFilesystem();
    log('info', 'browser_closed', { uptime_ms: uptime });
    return { closed: true, uptime_ms: uptime };
  }

  /** See browser/src/session.ts: stale Singleton* locks from a snapshot block the profile after restore. */
  private async clearStaleSingletonLocks(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.cfg.profileDir);
    } catch {
      return;
    }
    const stale = entries.filter((e) => e.startsWith('Singleton'));
    await Promise.all(stale.map((e) => rm(join(this.cfg.profileDir, e), { force: true })));
    if (stale.length) log('info', 'cleared_singleton_locks', { count: stale.length });
  }
}

function onRequest(req: HTTPRequest): void {
  const t = req.resourceType();
  if (t === 'image' || t === 'media' || t === 'font') void req.abort().catch(() => undefined);
  else void req.continue().catch(() => undefined);
}

/** Container-wide CPU and memory from cgroup v2, for cost measurement. Null where unavailable. */
export async function readMetrics(): Promise<{ cpu_seconds: number | null; mem_peak_bytes: number | null; mem_current_bytes: number | null }> {
  const num = async (file: string, re?: RegExp): Promise<number | null> => {
    try {
      const t = await readFile(file, 'utf8');
      const m = re ? re.exec(t)?.[1] : t.trim();
      const n = Number(m);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };
  const usec = await num('/sys/fs/cgroup/cpu.stat', /usage_usec (\d+)/);
  return {
    cpu_seconds: usec === null ? null : usec / 1e6,
    mem_peak_bytes: await num('/sys/fs/cgroup/memory.peak'),
    mem_current_bytes: await num('/sys/fs/cgroup/memory.current'),
  };
}

async function syncFilesystem(): Promise<void> {
  try {
    await execFileAsync('sync');
  } catch (err) {
    log('warn', 'sync_failed', { error_code: errorCode(err) });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
