import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Pages reachable WITHOUT a session. Everything else is protected.
 *
 * This is an explicit denylist-by-default (audit finding F-1). It replaced a
 * `protectedPaths` ALLOWLIST, which failed open: any page added later was
 * publicly reachable until someone remembered to extend the array, and nothing
 * errored to say so. Forgetting to exempt a public page is loud (a redirect
 * loop to /login); forgetting to protect a private one was silent.
 *
 * `/` is listed because it does nothing but `redirect('/dashboard')` — the
 * redirect target is protected, so the entry point need not be.
 */
const PUBLIC_PAGE_PREFIXES = ['/login', '/signup', '/forgot-password', '/join'];

function isPublicPage(pathname: string): boolean {
  if (pathname === '/') return true;
  return PUBLIC_PAGE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

/**
 * `/api/*` is deliberately NOT session-gated here.
 *
 * Every API route authenticates itself — Bearer API key on the v1 surface, a
 * cron shared secret on the sweeper endpoints, the Meta webhook signature, or
 * an in-handler `getCurrentAccount()`. All 56 were audited on 2026-08-07 and
 * none lacked a guard. Session-gating them in middleware would break the
 * machine-to-machine callers outright, since they carry no cookie by design.
 */
function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie);
    });
    return response;
  };

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (
    user &&
    (request.nextUrl.pathname === '/login' ||
      request.nextUrl.pathname === '/signup' ||
      request.nextUrl.pathname === '/forgot-password')
  ) {
    const url = request.nextUrl.clone();
    const inviteToken = request.nextUrl.searchParams.get('invite');
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`;
      url.search = '';
    } else {
      url.pathname = '/dashboard';
      url.search = '';
    }
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // MFA assurance-level gate (spec: docs/2026-08-07-spec-mfa-totp.md, T3).
  //
  // The condition is the PAIR, not the raw `aal` claim: nextLevel === 'aal2'
  // means this user has a verified factor, currentLevel === 'aal1' means the
  // session hasn't satisfied it yet. Reading currentLevel alone cannot tell
  // "no factor enrolled" apart from "factor enrolled but unsatisfied" — one
  // reading gates nobody, the other locks out every user.
  //
  // This must live in middleware, not on the login page: signInWithPassword
  // yields a valid aal1 session, so a challenge that only guards the login
  // form is bypassed by navigating straight to /inbox.
  //
  // Inert until someone enrolls a factor — every wacrm user reports aal1/aal1
  // today, so this branch is unreachable until the enrolment UI (T1) ships.
  if (user) {
    const { data: aal } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const needsMfa = aal?.nextLevel === 'aal2' && aal.currentLevel === 'aal1';
    const onMfaPage = request.nextUrl.pathname.startsWith('/mfa');

    if (needsMfa && !onMfaPage && !isPublicPage(request.nextUrl.pathname)) {
      // API callers get a status code, not a redirect — an API client that
      // follows a 302 into an HTML login page fails confusingly.
      if (isApiPath(request.nextUrl.pathname)) {
        return withRefreshedCookies(
          NextResponse.json({ error: 'MFA required' }, { status: 401 })
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = '/mfa';
      url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
      return withRefreshedCookies(NextResponse.redirect(url));
    }
  }

  // Protected pages - default-deny (audit F-1). Anything not explicitly
  // public requires a session. `/api/*` is excluded: those routes carry their
  // own auth and no cookie (see isApiPath).
  if (
    !user &&
    !isPublicPage(request.nextUrl.pathname) &&
    !isApiPath(request.nextUrl.pathname)
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // API routes that need auth (not webhooks)
  if (
    !user &&
    request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook')
  ) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
