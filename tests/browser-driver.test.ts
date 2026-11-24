import { describe, expect, it } from 'vitest';
import { detectKind, DriverError } from '../browser/src/downloads.js';
import { validateSteps } from '../browser/src/driver.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('detectKind (browser)', () => {
  it('detects zip, text, empty and binary', () => {
    expect(detectKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(detectKind(enc('23/11/2026, 10:00 - Alice: Meet at 10 🚗\n'))).toBe('text');
    expect(detectKind(new Uint8Array())).toBe('empty');
    expect(detectKind(new Uint8Array([0x00, 0x01, 0x02, 0xff]))).toBe('other');
  });
  it('does not misread a multibyte character cut at the sample boundary', () => {
    const s = enc('a'.repeat(510) + '🚗'); // emoji straddles byte 512
    expect(detectKind(s.subarray(0, 512))).toBe('text');
  });
});

describe('validateSteps (browser)', () => {
  it('accepts a valid flow and strips unknown fields', () => {
    const steps = validateSteps([{ op: 'click', selector: '::-p-aria(Menu)', extra: 1 }, { op: 'expectDownload' }]);
    expect(steps).toEqual([{ op: 'click', selector: '::-p-aria(Menu)' }, { op: 'expectDownload' }]);
  });
  it('rejects unknown ops, keys outside the allowlist and empty lists', () => {
    expect(() => validateSteps([{ op: 'eval', code: 'x' }])).toThrow(DriverError);
    expect(() => validateSteps([{ op: 'press', key: 'F12' }])).toThrow(DriverError);
    expect(() => validateSteps([])).toThrow(DriverError);
  });
});
