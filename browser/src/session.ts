import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { DownloadManager } from './downloads.js';
import { runSteps, validateSteps, type RunResult } from './driver.js';
import { errorCode, log } from './log.js';
import { probeState, WHATSAPP_URL, type StateProbe } from './whatsapp.js';

const execFileAsync = promisify(execFile);

export interface SessionConfig {
  executablePath: string;
  /** Persistent Chromium profile. Lives on the container filesystem so it is captured by snapshots. */
  profileDir: string;
  navigationTimeoutMs: number;
}

/**
 * Owns the single Chromium instance in this container.
 *
 * Design notes:
 *  - Chromium runs *headful* on an Xvfb virtual display rather than headless,
 *    so it presents as an ordinary Chromium build. We deliberately do NOT
 *    spoof the user agent, hide navigator.webdriver or use "stealth" plugins:
 *    the spec forbids disguising automation.
 *  - `--no-sandbox` is needed because Cloudflare Containers (like most
 *    container runtimes) do not grant the user-namespace privileges Chromium's
 *    sandbox requires. The browser only ever loads web.whatsapp.com.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private launchedAt: number | undefined;
  readonly downloads = new DownloadManager();

  constructor(private readonly cfg: SessionConfig) {}

  get running(): boolean {
    return this.browser?.connected === true;
  }

  /**
   * Run data-driven steps. Refused unless WhatsApp is authenticated, so the
   * driver can never act on a login or pairing screen.
   */
  async run(rawSteps: unknown, deadlineMs: number): Promise<RunResult | { refused: string }> {
    const steps = validateSteps(rawSteps);
    if (!this.running || !this.page) return { refused: 'not_running' };
    const probe = await this.status();
    if (probe.state !== 'authenticated') return { refused: `not_authenticated:${probe.state}` };
    return runSteps(this.page, this.downloads, steps, deadlineMs);
  }

  async start(): Promise<StateProbe> {
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
      ],
      // Make Chromium exit cleanly on SIGTERM/SIGINT forwarded by puppeteer.
      handleSIGTERM: true,
      handleSIGINT: true,
    });
    this.launchedAt = Date.now();
    await this.downloads.wipe();
    await this.downloads.attach(this.browser);

    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
    this.page.setDefaultNavigationTimeout(this.cfg.navigationTimeoutMs);
    await this.page.goto(WHATSAPP_URL, { waitUntil: 'domcontentloaded' });

    log('info', 'browser_started', { duration_ms: Date.now() - t0 });
    return this.status();
  }

  async status(): Promise<StateProbe> {
    if (!this.running || !this.page) {
      return { state: 'not_running', matched: [], title: null, url: null };
    }
    return probeState(this.page);
  }

  /**
   * Poll until the page reaches a settled state (qr or authenticated) or the
   * timeout elapses. Returns the last probe either way; never retries login.
   */
  async waitForSettled(timeoutMs: number, pollMs = 1000): Promise<StateProbe> {
    return this.waitForStable((s) => s === 'qr' || s === 'authenticated', timeoutMs, pollMs);
  }

  /** Wait specifically for `authenticated` (used after the user scans the QR code). */
  async waitForAuthenticated(timeoutMs: number, pollMs = 1000): Promise<StateProbe> {
    return this.waitForStable((s) => s === 'authenticated', timeoutMs, pollMs);
  }

  /**
   * A target state only counts once it holds for STABLE_POLLS consecutive
   * probes. This filters transient states, e.g. the instant after navigation
   * before WhatsApp redirects an unauthenticated browser to /login/.
   */
  private async waitForStable(
    isTarget: (s: StateProbe['state']) => boolean,
    timeoutMs: number,
    pollMs: number,
  ): Promise<StateProbe> {
    const STABLE_POLLS = 3;
    const deadline = Date.now() + timeoutMs;
    let last = await this.status();
    let streak = isTarget(last.state) ? 1 : 0;
    while (Date.now() < deadline) {
      if (last.state === 'not_running') return last;
      if (streak >= STABLE_POLLS) return last;
      await sleep(pollMs);
      const next = await this.status();
      streak = isTarget(next.state) && (streak === 0 || next.state === last.state) ? streak + 1 : isTarget(next.state) ? 1 : 0;
      last = next;
    }
    // Timed out: report the last observation, but never as a settled target it didn't hold.
    return streak >= STABLE_POLLS || !isTarget(last.state) ? last : { ...last, state: 'loading' };
  }

  /**
   * PNG screenshot for the pairing page only. Refused once the chat list is
   * visible so conversation content is never captured.
   */
  async pairingScreenshot(): Promise<Uint8Array | { refused: string }> {
    if (!this.running || !this.page) return { refused: 'not_running' };
    const probe = await this.status();
    if (probe.state === 'authenticated') return { refused: 'authenticated' };
    const buf = await this.page.screenshot({ type: 'png', fullPage: false });
    return buf;
  }

  /**
   * Graceful shutdown: let Chromium close normally so it flushes cookies,
   * IndexedDB and LevelDB to disk, then fsync the filesystem before snapshot.
   */
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
          /* already gone */
        }
      }
    }
    this.browser = undefined;
    this.page = undefined;
    this.launchedAt = undefined;
    // Exports must never be captured in a snapshot.
    const wiped = await this.downloads.wipe();
    await syncFilesystem();
    log('info', 'browser_closed', { uptime_ms: uptime, downloads_wiped: wiped });
    return { closed: true, uptime_ms: uptime };
  }

  /**
   * Chromium leaves Singleton{Lock,Socket,Cookie} symlinks that embed the old
   * hostname. After a snapshot restore the hostname differs and Chromium would
   * refuse the profile as "in use on another computer". No process can own the
   * profile at this point (we only launch one browser), so remove them.
   */
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
