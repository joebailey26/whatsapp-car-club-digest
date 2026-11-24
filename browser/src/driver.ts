import type { Page } from 'puppeteer-core';
import { DownloadManager, DriverError, type DownloadInfo } from './downloads.js';
import { inspectUi, type UiNode } from './inspect.js';
import { log } from './log.js';

/**
 * Generic, data-driven browser steps.
 *
 * The export click path is sent by the Worker as data, so fixing a selector
 * needs only a Worker config change. It never needs a new container image,
 * which would invalidate the snapshot and force re-pairing.
 *
 * Selectors are Puppeteer selectors: CSS, `::-p-aria(Name[role="menuitem"])`
 * or `::-p-text(Export chat)`. Step text (e.g. the group name typed into
 * search) is never logged.
 */

export type Step =
  | { op: 'click'; selector: string; timeoutMs?: number; optional?: boolean }
  | { op: 'type'; selector: string; text: string; timeoutMs?: number; clear?: boolean }
  | { op: 'press'; key: string; times?: number }
  | { op: 'waitFor'; selector: string; timeoutMs?: number; optional?: boolean }
  | { op: 'waitGone'; selector: string; timeoutMs?: number }
  | { op: 'sleep'; ms: number }
  | { op: 'exists'; selector: string; as: string }
  | { op: 'inspect'; as: string }
  | { op: 'expectDownload'; timeoutMs?: number; maxBytes?: number };

export interface StepResult {
  i: number;
  op: Step['op'];
  ok: boolean;
  skipped?: boolean;
  ms: number;
  error_code?: string;
}

export interface RunResult {
  ok: boolean;
  failedStep: number | null;
  error_code: string | null;
  steps: StepResult[];
  facts: Record<string, boolean>;
  inspections: Record<string, UiNode[]>;
  downloads: DownloadInfo[];
}

const KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Backspace']);
const MAX_STEPS = 80;
const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export function validateSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STEPS) throw new DriverError('INVALID_STEPS');
  return raw.map((s) => {
    if (!s || typeof s !== 'object') throw new DriverError('INVALID_STEPS');
    const step = s as Record<string, unknown>;
    const str = (k: string, max = 500): string => {
      const v = step[k];
      if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new DriverError(`INVALID_STEP_${String(step.op).toUpperCase()}`);
      return v;
    };
    const num = (k: string, min: number, max: number): number | undefined => {
      const v = step[k];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new DriverError(`INVALID_STEP_${String(step.op).toUpperCase()}`);
      return v;
    };
    const timeoutMs = num('timeoutMs', 100, 180_000);
    const opt = step.optional === true;
    switch (step.op) {
      case 'click':
        return { op: 'click', selector: str('selector'), ...(timeoutMs ? { timeoutMs } : {}), ...(opt ? { optional: true } : {}) };
      case 'type':
        return { op: 'type', selector: str('selector'), text: str('text', 200), ...(timeoutMs ? { timeoutMs } : {}), ...(step.clear === true ? { clear: true } : {}) };
      case 'press': {
        const key = str('key', 20);
        if (!KEYS.has(key)) throw new DriverError('INVALID_STEP_PRESS');
        const times = num('times', 1, 5);
        return { op: 'press', key, ...(times ? { times } : {}) };
      }
      case 'waitFor':
        return { op: 'waitFor', selector: str('selector'), ...(timeoutMs ? { timeoutMs } : {}), ...(opt ? { optional: true } : {}) };
      case 'waitGone':
        return { op: 'waitGone', selector: str('selector'), ...(timeoutMs ? { timeoutMs } : {}) };
      case 'sleep':
        return { op: 'sleep', ms: num('ms', 0, 30_000) ?? 0 };
      case 'exists':
        return { op: 'exists', selector: str('selector'), as: str('as', 40) };
      case 'inspect':
        return { op: 'inspect', as: str('as', 40) };
      case 'expectDownload': {
        const maxBytes = num('maxBytes', 1, 200 * 1024 * 1024);
        return { op: 'expectDownload', ...(timeoutMs ? { timeoutMs } : {}), ...(maxBytes ? { maxBytes } : {}) };
      }
      default:
        throw new DriverError('INVALID_STEP_OP');
    }
  });
}

export async function runSteps(page: Page, downloads: DownloadManager, steps: Step[], deadlineMs: number): Promise<RunResult> {
  const deadline = Date.now() + deadlineMs;
  const res: RunResult = { ok: true, failedStep: null, error_code: null, steps: [], facts: {}, inspections: {}, downloads: [] };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const t0 = Date.now();
    const remaining = deadline - t0;
    if (remaining <= 0) {
      res.ok = false;
      res.failedStep = i;
      res.error_code = 'RUN_DEADLINE_EXCEEDED';
      break;
    }
    const timeout = Math.min('timeoutMs' in step && step.timeoutMs ? step.timeoutMs : DEFAULT_TIMEOUT, remaining);
    try {
      const skipped = await runStep(page, downloads, step, timeout, res);
      res.steps.push({ i, op: step.op, ok: true, ms: Date.now() - t0, ...(skipped ? { skipped: true } : {}) });
    } catch (err) {
      const code = err instanceof DriverError ? err.code : classify(err);
      res.steps.push({ i, op: step.op, ok: false, ms: Date.now() - t0, error_code: code });
      res.ok = false;
      res.failedStep = i;
      res.error_code = code;
      log('warn', 'step_failed', { i, op: step.op, error_code: code });
      break;
    }
  }
  log('info', 'steps_run', { count: res.steps.length, ok: res.ok, downloads: res.downloads.length });
  return res;
}

async function runStep(page: Page, downloads: DownloadManager, step: Step, timeout: number, res: RunResult): Promise<boolean> {
  switch (step.op) {
    case 'click':
      try {
        await page.locator(step.selector).setTimeout(timeout).click();
      } catch (err) {
        if (step.optional) return true;
        throw err;
      }
      return false;
    case 'type': {
      await page.locator(step.selector).setTimeout(timeout).click();
      if (step.clear) {
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
      }
      await page.keyboard.type(step.text, { delay: 40 });
      return false;
    }
    case 'press':
      for (let n = 0; n < (step.times ?? 1); n++) await page.keyboard.press(step.key as 'Enter');
      return false;
    case 'waitFor':
      try {
        await page.locator(step.selector).setTimeout(timeout).wait();
      } catch (err) {
        if (step.optional) return true;
        throw err;
      }
      return false;
    case 'waitGone':
      await page.waitForSelector(step.selector, { hidden: true, timeout });
      return false;
    case 'sleep':
      await new Promise((r) => setTimeout(r, Math.min(step.ms, timeout)));
      return false;
    case 'exists':
      res.facts[step.as] = (await page.$(step.selector).catch(() => null)) !== null;
      return false;
    case 'inspect':
      res.inspections[step.as] = await inspectUi(page);
      return false;
    case 'expectDownload':
      res.downloads.push(await downloads.next(timeout, step.maxBytes ?? DEFAULT_MAX_BYTES));
      return false;
  }
}

function classify(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || /timeout/i.test(err.message)) return 'STEP_TIMEOUT';
    if (/not (visible|clickable)|detached/i.test(err.message)) return 'STEP_NOT_INTERACTABLE';
    if (/selector/i.test(err.message)) return 'STEP_BAD_SELECTOR';
  }
  // Error messages can quote selectors that contain the group name: keep the type only.
  return `STEP_ERROR_${err instanceof Error ? err.name.replace(/[^A-Za-z]/g, '').slice(0, 30) || 'Error' : 'Unknown'}`;
}
