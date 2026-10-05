// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/admin/audit', query: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.query),
}));

import { MfaSignInLink } from '@/app/admin/MfaSignInLink';

afterEach(cleanup);

describe('MfaSignInLink', () => {
  it('signs in with MFA and comes back to the staff page that was open, with its query', () => {
    nav.pathname = '/admin/audit';
    nav.query = 'actor=e2e-admin';
    render(<MfaSignInLink label="Sign in with MFA" />);
    expect(screen.getByRole('link', { name: 'Sign in with MFA' })).toHaveProperty(
      'href',
      expect.stringContaining(`/auth/login?mfa=1&returnTo=${encodeURIComponent('/admin/audit?actor=e2e-admin')}`),
    );
  });

  it('comes back to the overview when that was the page', () => {
    nav.pathname = '/admin/overview';
    nav.query = '';
    render(<MfaSignInLink label="Sign in with MFA" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe(`/auth/login?mfa=1&returnTo=${encodeURIComponent('/admin/overview')}`);
  });
});
