import { describe, expect, it } from 'vitest';
import { classifyState, isLoginPath } from '../browser/src/state.js';

describe('classifyState (browser)', () => {
  it('recognises the chat list as authenticated', () => {
    expect(classifyState(['chat_pane_id'], 'complete')).toBe('authenticated');
  });
  it('recognises a QR canvas as needing pairing', () => {
    expect(classifyState(['qr_canvas_aria'], 'complete')).toBe('qr');
  });
  it('never reports authenticated when a QR code is also visible', () => {
    expect(classifyState(['qr_data_ref', 'chat_list_aria'], 'complete')).toBe('unknown');
  });
  it('reports loading while the document or progress bar is still loading', () => {
    expect(classifyState([], 'interactive')).toBe('loading');
    expect(classifyState(['progress'], 'complete')).toBe('loading');
  });
  it('reports unknown for an unrecognised, fully loaded page', () => {
    expect(classifyState([], 'complete')).toBe('unknown');
  });
});

describe('URL fallback', () => {
  it('treats a finished, QR-free page off the login route as authenticated', () => {
    expect(classifyState(['url_not_login'], 'complete')).toBe('authenticated');
  });
  it('never overrides a visible QR code', () => {
    expect(classifyState(['qr_data_ref', 'url_not_login'], 'complete')).toBe('qr');
  });
  it('does not apply while still loading', () => {
    expect(classifyState(['progress', 'url_not_login'], 'complete')).toBe('loading');
  });
  it('recognises the login route', () => {
    expect(isLoginPath('/login/')).toBe(true);
    expect(isLoginPath('/login')).toBe(true);
    expect(isLoginPath('/')).toBe(false);
    expect(isLoginPath(null)).toBe(false);
  });
});
