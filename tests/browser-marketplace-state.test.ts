import { describe, expect, it } from 'vitest';
import { classifyFb, isAllowedUrl, type FbSignals } from '../marketplace-browser/src/state.js';

const s = (p: Partial<FbSignals>): FbSignals => ({ path: '/marketplace/', onFacebook: true, hasLoginForm: false, hasSessionCookie: true, warning: false, readyState: 'complete', ...p });

describe('Facebook session state (container)', () => {
  it('is authenticated only with a session cookie, no login form, no warning', () => {
    expect(classifyFb(s({}))).toBe('authenticated');
    expect(classifyFb(s({ hasSessionCookie: false }))).toBe('login');
  });
  it('stops on the login page or a login form', () => {
    expect(classifyFb(s({ path: '/login/' }))).toBe('login');
    expect(classifyFb(s({ hasLoginForm: true }))).toBe('login');
  });
  it('stops on checkpoints, two-step verification and account warnings, even with a cookie', () => {
    expect(classifyFb(s({ path: '/checkpoint/1501092823525282/' }))).toBe('checkpoint');
    expect(classifyFb(s({ path: '/two_step_verification/authentication/' }))).toBe('checkpoint');
    expect(classifyFb(s({ warning: true }))).toBe('checkpoint');
    expect(classifyFb(s({ warning: true, hasLoginForm: true }))).toBe('checkpoint');
  });
  it('waits while loading and is unknown off Facebook', () => {
    expect(classifyFb(s({ readyState: 'interactive' }))).toBe('loading');
    expect(classifyFb(s({ onFacebook: false }))).toBe('unknown');
  });
  it('only ever navigates to Facebook over https', () => {
    expect(isAllowedUrl('https://www.facebook.com/marketplace/item/1/')).toBe(true);
    expect(isAllowedUrl('http://www.facebook.com/')).toBe(false);
    expect(isAllowedUrl('https://facebook.com.evil.example/')).toBe(false);
  });
});
