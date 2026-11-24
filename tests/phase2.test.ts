import { describe, expect, it } from 'vitest';
import { FlowSchema, GroupsConfigSchema, StepsSchema } from '../src/config/schema';
import { cssString, exportRange, renderSteps, renderString, ukIsoDate, varsFor } from '../src/config/template';
import { checkIntegrity, exportKeys } from '../src/exports/store';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('template rendering', () => {
  it('substitutes known placeholders', () => {
    expect(renderString('span[title="{{groupNameCss}}"]', { groupNameCss: 'A \\"B\\"' })).toBe('span[title="A \\"B\\""]');
  });
  it('rejects unknown placeholders rather than leaving them in', () => {
    expect(() => renderString('{{nope}}', {})).toThrow('UNKNOWN_PLACEHOLDER:nope');
  });
  it('escapes quotes and backslashes for CSS attribute values', () => {
    expect(cssString('Club "VR-4" \\ chat')).toBe('Club \\"VR-4\\" \\\\ chat');
  });
  it('renders only selector and text fields', () => {
    const out = renderSteps(
      [
        { op: 'type', selector: '#s', text: '{{groupName}}' },
        { op: 'exists', selector: 'span[title="{{groupNameCss}}"]', as: 'chat_title' },
      ],
      varsFor('Example Club Chat', { from: new Date('2026-11-16T00:00:00Z'), to: new Date('2026-11-23T00:00:00Z') }),
    );
    expect(out[0]).toEqual({ op: 'type', selector: '#s', text: 'Example Club Chat' });
    expect(out[1]).toMatchObject({ selector: 'span[title="Example Club Chat"]', as: 'chat_title' });
  });
  it('formats UK and ISO dates', () => {
    const v = varsFor('x', { from: new Date('2026-11-14T00:00:00Z'), to: new Date('2026-11-23T00:00:00Z') });
    expect(v).toMatchObject({ dateFromUk: '14/11/2026', dateToUk: '23/11/2026', dateFromIso: '2026-11-14', dateToIso: '2026-11-23' });
  });
});

describe('exportRange', () => {
  it('defaults to the last 7 days for a first export', () => {
    const r = exportRange(new Date('2026-11-23T09:00:00Z'), null);
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-11-16');
    expect(r.to.toISOString().slice(0, 10)).toBe('2026-11-23');
  });
  it('overlaps the previous export by one day (spec example: 15 Nov → 14–23 Nov)', () => {
    const r = exportRange(new Date('2026-11-23T09:00:00Z'), '2026-11-15');
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-11-14');
  });
  it('uses the Europe/London calendar date, not UTC', () => {
    // 23:30 UTC on 30 June is 00:30 on 1 July in London (BST)
    expect(ukIsoDate(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
  });
});

describe('export integrity', () => {
  const zip = (complete: boolean): ArrayBuffer => {
    const body = [0x50, 0x4b, 0x03, 0x04, ...new Array(40).fill(0)];
    const eocd = [0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)];
    return new Uint8Array(complete ? [...body, ...eocd] : body).buffer;
  };
  it('accepts a complete zip and non-empty text', () => {
    expect(checkIntegrity(zip(true), 'zip')).toBeNull();
    expect(checkIntegrity(enc('23/11/2026, 10:00 - A: hi\n').buffer as ArrayBuffer, 'text')).toBeNull();
  });
  it('rejects truncated zips, empty files and unknown types', () => {
    expect(checkIntegrity(zip(false), 'zip')).toBe('ZIP_TRUNCATED');
    expect(checkIntegrity(new ArrayBuffer(0), 'text')).toBe('EMPTY_FILE');
    expect(checkIntegrity(new Uint8Array([0, 1, 2]).buffer, 'other')).toBe('UNEXPECTED_FILE_TYPE');
  });
  it('builds R2 keys under exports/<group>/<stamp>/', () => {
    expect(exportKeys('group-a', '2026-11-23_153012', 'zip')).toEqual({
      original: 'exports/group-a/2026-11-23_153012/original.zip',
      metadata: 'exports/group-a/2026-11-23_153012/metadata.json',
    });
  });
});

describe('config schemas', () => {
  it('validates group ids and rejects duplicates', () => {
    expect(GroupsConfigSchema.safeParse({ groups: [{ id: 'group-a', name: 'Example Club Chat', enabled: true }] }).success).toBe(true);
    expect(GroupsConfigSchema.safeParse({ groups: [{ id: 'Bad Id', name: 'x', enabled: true }] }).success).toBe(false);
    const dup = { id: 'a1', name: 'x', enabled: true };
    expect(GroupsConfigSchema.safeParse({ groups: [dup, dup] }).success).toBe(false);
  });
  it('validates a flow', () => {
    const flow = {
      version: 1,
      openChat: [{ op: 'click', selector: '#search' }],
      verifyChat: [{ op: 'exists', selector: 'header span[title="{{groupNameCss}}"]', as: 'chat_title' }],
      export: [{ op: 'click', selector: '::-p-aria(Export chat)' }, { op: 'expectDownload', timeoutMs: 60000 }],
      reset: [{ op: 'press', key: 'Escape', times: 2 }],
    };
    expect(FlowSchema.safeParse(flow).success).toBe(true);
    expect(StepsSchema.safeParse([{ op: 'press', key: 'F12' }]).success).toBe(false);
  });
});

describe('sanitizeUi (inspection redaction)', () => {
  it('drops avatar buttons and person-bearing labels, keeps navigation chrome', async () => {
    const { sanitizeUi } = await import('../src/container/sanitize');
    const out = sanitizeUi([
      { where: 'other', tag: 'div', role: 'button', label: 'Open chat details for Maybe Alex [number]', testid: 'group-chat-profile-picture' },
      { where: 'other', tag: 'div', role: 'button', label: 'Open chat details for Alex', testid: null },
      { where: 'other', tag: 'button', label: null, title: null, testid: null },
      { where: 'menu', tag: 'button', role: 'menuitem', label: 'Export chat', text: 'Export chat' },
      { where: 'header', tag: 'button', label: 'Menu' },
      { where: 'other', tag: 'button', label: 'Attach' },
    ]) as Array<{ label: string }>;
    expect(out.map((n) => n.label)).toEqual(['Export chat', 'Menu', 'Attach']);
  });
});
