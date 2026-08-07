# Spec — TOTP multi-factor authentication

**Date:** 2026-08-07
**Status:** ready to implement
**Branch target:** `cfg/g2-hardening`
**Origin:** session security audit rev 2 (finding F-7), `security-reports/session-security-20260807.md`

---

## Why this exists

TOTP MFA is **already enabled** on the Supabase project (`paspnksnzqkdnglzjxxg`).
It protects nothing, because wacrm contains no MFA code:

```bash
grep -riE "mfa\.|enroll\(|challenge\(|listFactors|aal2" src/   # → no matches
```

No enrollment UI, no challenge at login, no assurance-level gate. Every production
JWT reports `aal1`. The provider switch is on and unreachable — the security
equivalent of a fire door that opens onto a wall.

**Why it matters here more than on a typical app.** Two audited facts compound:

1. `@supabase/ssr` keeps the session — access token **and refresh token** — in a
   cookie readable from JavaScript, by design (the browser client needs it).
2. This Supabase plan offers no session cap. `SESSIONS_TIMEBOX` and
   `SESSIONS_INACTIVITY_TIMEOUT` are both `0` and the inputs are Pro-gated.

So a phished password yields access that never expires on its own. CSP (enforced
2026-08-07, commit `baac157`) closes the XSS path to the cookie. MFA closes the
phishing path to the password. They are different doors.

## Scope

**In:** TOTP enrolment, verification at login, `aal2` enforcement on protected
routes, factor removal, admin break-glass, both locales.

**Out:** SMS MFA (Pro-only on this plan), WebAuthn/passkeys, account-wide
*mandatory* MFA (see Phase 2), Supabase-native recovery codes (they do not exist —
see Recovery).

---

## Design decisions

### D1 — Opt-in per user first, mandate later
Ship enrolment as voluntary. A mandate with no tested recovery path converts a
support ticket into a lockout, and this deployment has no support desk. Phase 2
adds an account-level `require_mfa` flag once recovery is proven.

### D2 — Enforcement lives in middleware, not in the login page
An MFA challenge that only guards the login form is decorative: the session cookie
is already valid at `aal1`, so any direct navigation to `/inbox` skips it. The gate
must sit where every request passes.

**This is the single most important requirement in the spec.** If only one thing
ships, ship this.

### D3 — Use `getAuthenticatorAssuranceLevel()`, not the raw `aal` claim
Supabase returns `{ currentLevel, nextLevel }`. The condition that matters is
`nextLevel === 'aal2' && currentLevel === 'aal1'` — meaning *this user has a
verified factor and has not yet used it this session*. Reading `aal` alone cannot
distinguish "no factor enrolled" from "factor enrolled but unsatisfied", and
getting that backwards either locks out every user or gates nobody.

### D4 — Unverified factors must be cleaned up
`mfa.enroll()` creates a factor in `unverified` state *before* the user confirms a
code. Abandoning the dialog leaves it behind, and stale unverified factors both
clutter the list and can push a user against `maxEnrolledFactors`. Unenroll on
cancel and on dialog close.

---

## Implementation

### T1 · Enrolment card — `src/components/settings/mfa-card.tsx` (new)

Mirror `sessions-card.tsx`: `'use client'`, `createClient()` from
`@/lib/supabase/client`, shadcn `Card` + `Dialog`, `sonner` toast, `useTranslations`.

State machine:

```
idle ──"Add authenticator"──▶ enrolling ──verify ok──▶ enrolled
  ▲                              │                        │
  └──────── cancel/unenroll ─────┘◀──── "Remove" ─────────┘
```

```ts
// list on mount — drives idle vs enrolled
const { data } = await supabase.auth.mfa.listFactors();
const totp = data?.totp ?? [];            // verified factors only
const verified = totp.filter(f => f.status === 'verified');

// begin enrolment
const { data: e, error } = await supabase.auth.mfa.enroll({
  factorType: 'totp',
  friendlyName: `wacrm ${new Date().toISOString().slice(0, 10)}`,
});
// e.totp.qr_code  → SVG data URI, render directly in an <img>
// e.totp.secret   → show as copyable text for manual entry
// e.id            → factorId, needed below AND for cleanup on cancel

// confirm the first code
const { data: c } = await supabase.auth.mfa.challenge({ factorId: e.id });
const { error: vErr } = await supabase.auth.mfa.verify({
  factorId: e.id, challengeId: c.id, code,
});

// D4 cleanup — on cancel, dialog dismiss, or unmount while unverified
await supabase.auth.mfa.unenroll({ factorId: e.id });
```

Removal path re-authenticates by requiring a current TOTP code before
`unenroll()` — otherwise a hijacked `aal1` session can strip the factor it was
meant to be stopped by.

Register in `security-panel.tsx` under the existing cards:

```tsx
<PasswordForm />
<MfaCard />        // ← new
<SessionsCard />
```

### T2 · Login challenge — `src/app/(auth)/mfa/page.tsx` (new)

`signInWithPassword` succeeds and yields an `aal1` session even when a factor
exists — Supabase does not block it. The challenge is a second step, not part of
sign-in.

Flow: after successful password sign-in, `login/page.tsx` checks the assurance
level. If a factor is pending, full-page navigate to `/mfa?next=<path>` (keep the
existing full-page navigation comment's reasoning — the server needs the cookie).

```ts
const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
if (aal?.nextLevel === 'aal2' && aal.currentLevel === 'aal1') {
  window.location.href = `/mfa?next=${encodeURIComponent(next ?? '/dashboard')}`;
}
```

On `/mfa`: list factors → `challenge({ factorId })` → six-digit input →
`verify(...)`. On success the cookie is rewritten at `aal2`; navigate to `next`.

Offer "Sign out" on this page — a user who cannot produce a code must be able to
leave without clearing cookies by hand.

Rate-limit the verify step. Supabase applies its own limits, but surface a clear
error rather than a raw message on repeated failure.

### T3 · Middleware gate — `src/middleware.ts` (the load-bearing change)

Insert **after** the `getUser()` call and **before** the protected-path branch:

```ts
if (user) {
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const needsMfa = aal?.nextLevel === 'aal2' && aal.currentLevel === 'aal1';
  const onMfaPage = request.nextUrl.pathname.startsWith('/mfa');
  if (needsMfa && !onMfaPage && !isPublicPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/mfa';
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
    return withRefreshedCookies(NextResponse.redirect(url));
  }
}
```

Three things not to get wrong:

- **Wrap in `withRefreshedCookies`.** Every other redirect in this file does, for
  the reason documented at line 38: a rotated refresh token that never reaches the
  browser wedges the session (issue #288). A new redirect that forgets this
  reintroduces exactly that bug.
- **Exempt `/mfa` itself**, or the redirect loops.
- **`/api/*` must 401, not redirect.** An API client following a 302 to an HTML
  page produces a confusing failure. Return
  `NextResponse.json({ error: 'MFA required' }, { status: 401 })` for API paths.

**Dependency on F-1.** The audit's F-1 recommends inverting `protectedPaths` from a
fail-open allowlist to default-deny. Do that in the same change: `isPublicPath()`
above is that helper, and having one list serve both the auth gate and the MFA gate
prevents them drifting apart. Two independent path lists is how a route ends up
auth-gated but not MFA-gated.

### T4 · i18n — `messages/en.json` **and** `messages/ko.json`

Add under `Settings.security` (which currently holds only `title` and
`description`) and a new top-level `Mfa` namespace for the challenge page.

⚠️ **Both files.** Production currently throws `MISSING_MESSAGE: roles (en)` on
`/settings` — a pre-existing bug from exactly this omission. Adding keys to one
locale reproduces it.

Keys: `mfaTitle`, `mfaDescription`, `mfaAddButton`, `mfaScanInstruction`,
`mfaManualEntry`, `mfaCodeLabel`, `mfaVerify`, `mfaEnrolledOn`, `mfaRemove`,
`mfaRemoveConfirm`, `mfaInvalidCode`, `mfaEnrolled`, `mfaRemoved`,
`Mfa.challengeTitle`, `Mfa.challengeDescription`, `Mfa.signOutInstead`.

### T5 · Admin break-glass — `docs/` runbook + optional admin action

Supabase does **not** issue recovery codes for TOTP. If the authenticator is lost,
the factor must be deleted server-side.

Two paths, document both:

1. **Dashboard (always available):** Supabase → Authentication → Users → select
   user → delete the MFA factor.
2. **In-app (optional, admin-only):** owner/admin action on the members tab calling
   `supabase.auth.admin.mfa.deleteFactor()` via the service-role client. Route it
   through `requireRole` and write an audit row — an admin who can silently strip
   another user's MFA is a privilege worth logging.

🔴 **Sole-owner caveat.** The production account has one owner. If that owner loses
their authenticator, no in-app admin can help — path 1 via the Supabase dashboard
is the only recovery, and it requires the Supabase login to still work. **Enrol a
second factor on a separate device, or confirm Supabase dashboard access is
independently recoverable, before enrolling.** Allow `maxEnrolledFactors ≥ 2` for
this reason.

---

## Testing

Unit / integration (vitest, alongside `src/middleware.test.ts`):

| Case | Expected |
|---|---|
| User with no factor | unaffected; no redirect |
| `nextLevel=aal2, currentLevel=aal1` on `/inbox` | 302 → `/mfa?next=/inbox` |
| Same, on `/api/v1/contacts` | 401 JSON, no redirect |
| Already `aal2` | passes through |
| Request to `/mfa` while needing MFA | no redirect (no loop) |
| MFA redirect response | carries refreshed auth cookies |
| Enrol then cancel | no `unverified` factor remains |
| Remove factor without a valid code | rejected |

Manual, on a throwaway account before touching the owner account:
enrol → sign out → sign in → challenged → verify → reach `/dashboard`; then
confirm a direct `/inbox` hit at `aal1` is intercepted.

## Rollout

1. Merge with MFA **available but not required** (D1).
2. Enrol a test account. Verify the middleware gate by navigating directly.
3. Enrol the owner account **with a second factor on a separate device** (break-glass).
4. Let it sit a week.
5. Phase 2 — account-level `require_mfa` flag: block members without a factor,
   with an enrolment grace path. Needs its own spec.

## Estimate

| Task | Effort |
|---|---|
| T1 enrolment card | ~3 h |
| T2 challenge page | ~2 h |
| T3 middleware gate + F-1 default-deny | ~2 h |
| T4 i18n (2 locales) | ~1 h |
| T5 runbook + admin action | ~2 h |
| Tests | ~2 h |

~12 h. T3 alone is ~2 h and delivers most of the security value — if this gets cut
short, T1+T2+T3 without T5 is still coherent, provided the sole-owner caveat is
respected.

## What this does and does not fix

**Fixes:** phished or reused password no longer grants access on its own.

**Does not fix:** F-4 (session cookie remains JS-readable — an already-authenticated
`aal2` session stolen via XSS is still a valid `aal2` session; CSP is the control
there), and F-3 (no session cap; a stolen refresh token still never expires). MFA
raises the bar on *obtaining* a session. It does nothing about one already taken.
