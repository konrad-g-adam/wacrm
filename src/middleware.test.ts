import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
// `mockAal`          — what getAuthenticatorAssuranceLevel() resolves to.
//                      currentLevel = what this session has satisfied,
//                      nextLevel    = what it COULD reach (aal2 only when the
//                      user has a verified factor). The gate condition is the
//                      pair, not the raw `aal` claim: reading currentLevel
//                      alone cannot tell "no factor enrolled" apart from
//                      "factor enrolled but unsatisfied".
let mockUser: { id: string } | null = null;
let mockAal: { currentLevel: string; nextLevel: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    }
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: mockAal }),
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import('./middleware');

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  mockUser = null;
  // Default: no factor enrolled. aal1/aal1 is what every wacrm user
  // reports today, so the MFA gate must be inert for this shape.
  mockAal = { currentLevel: 'aal1', nextLevel: 'aal1' };
  refreshedCookies = [];
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: 'sb-test-auth-token',
  value: 'rotated-refresh-token',
  options: { path: '/', httpOnly: true },
};

describe('middleware — refreshed auth cookies survive redirects', () => {
  it('carries the rotated token when redirecting a signed-in user off /login', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest('https://app.test/login'));

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/dashboard');
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it('carries the rotated token when redirecting an unauth user to /login', async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: 'cleared' }];

    const res = await middleware(new NextRequest('https://app.test/dashboard'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.cookies.get(ROTATED.name)?.value).toBe('cleared');
  });

  it('redirects a signed-in user with an invite token to /join/<token>', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest('https://app.test/login?invite=abc123')
    );

    expect(res.headers.get('location')).toContain('/join/abc123');
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it('passes through (no redirect) for a signed-in user on a protected page', async () => {
    mockUser = { id: 'user-1' };
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest('https://app.test/dashboard'));

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get('location')).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

// --- T3: assurance-level gate (spec docs/2026-08-07-spec-mfa-totp.md) -------
//
// The gate condition is `nextLevel === 'aal2' && currentLevel === 'aal1'` —
// the user HAS a verified factor and has NOT satisfied it this session.
// Anything else must pass through untouched.
describe('middleware — MFA assurance-level gate', () => {
  const NEEDS_MFA = { currentLevel: 'aal1', nextLevel: 'aal2' };

  it('is inert for a user with no enrolled factor', async () => {
    mockUser = { id: 'user-1' };
    mockAal = { currentLevel: 'aal1', nextLevel: 'aal1' };

    const res = await middleware(new NextRequest('https://app.test/inbox'));

    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects an aal1 session with a factor to /mfa, preserving the target', async () => {
    mockUser = { id: 'user-1' };
    mockAal = NEEDS_MFA;

    const res = await middleware(new NextRequest('https://app.test/inbox'));

    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/mfa');
    expect(location).toContain('next=%2Finbox');
  });

  it('carries refreshed cookies on the MFA redirect', async () => {
    // Same reasoning as the redirects above: a rotated refresh token that
    // never reaches the browser wedges the session (issue #288). A new
    // redirect that forgets withRefreshedCookies reintroduces that bug.
    mockUser = { id: 'user-1' };
    mockAal = NEEDS_MFA;
    refreshedCookies = [ROTATED];

    const res = await middleware(new NextRequest('https://app.test/inbox'));

    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it('401s API routes instead of redirecting them', async () => {
    // An API client following a 302 into an HTML page fails confusingly.
    mockUser = { id: 'user-1' };
    mockAal = NEEDS_MFA;

    const res = await middleware(
      new NextRequest('https://app.test/api/v1/contacts')
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
  });

  it('does not redirect /mfa onto itself', async () => {
    mockUser = { id: 'user-1' };
    mockAal = NEEDS_MFA;

    const res = await middleware(new NextRequest('https://app.test/mfa'));

    expect(res.headers.get('location')).toBeNull();
  });

  it('passes through once aal2 is satisfied', async () => {
    mockUser = { id: 'user-1' };
    mockAal = { currentLevel: 'aal2', nextLevel: 'aal2' };

    const res = await middleware(new NextRequest('https://app.test/inbox'));

    expect(res.headers.get('location')).toBeNull();
  });

  it('still lets an unauthenticated user reach /login (no gate before auth)', async () => {
    mockUser = null;
    mockAal = NEEDS_MFA; // must be ignored — there is no session to gate

    const res = await middleware(new NextRequest('https://app.test/login'));

    expect(res.headers.get('location')).toBeNull();
  });
});

// --- F-1: default-deny routing (audit finding, coupled to T3) ---------------
//
// protectedPaths was a hardcoded ALLOWLIST, so any page added later was
// public until someone remembered to extend the array — a silent failure.
// Inverted: everything is protected unless explicitly public.
describe('middleware — default-deny for unknown routes', () => {
  it('redirects an unauthenticated user away from an unlisted page', async () => {
    mockUser = null;

    const res = await middleware(
      new NextRequest('https://app.test/some-future-page')
    );

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('leaves genuinely public routes reachable when logged out', async () => {
    mockUser = null;

    for (const path of ['/login', '/signup', '/forgot-password']) {
      const res = await middleware(new NextRequest(`https://app.test${path}`));
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('does not gate the WhatsApp webhook (Meta calls it unauthenticated)', async () => {
    mockUser = null;

    const res = await middleware(
      new NextRequest('https://app.test/api/whatsapp/webhook')
    );

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });
});
