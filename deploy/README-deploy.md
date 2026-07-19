# wacrm — CFG hardened deploy (G2)

Target: CFG VPS `76.13.14.45` (srv1553869) behind the existing Traefik
(`traefik-proxy` network, `letsencrypt` resolver, HTTP->HTTPS forced).
Fork: `konrad-g-adam/wacrm`, branch `cfg/g2-hardening` (upstream pinned:
ArnasDon/wacrm @ b24aa79, 2026-07-17).

## One-time prerequisites (manual, ~10 min)

1. **Hosted Supabase project (EU)**: supabase.com -> New project, region
   **eu-central-1 (Frankfurt)**. Then Project Settings -> API: copy URL,
   anon key, service_role key into `/docker/wacrm/.env`.
2. **Apply schema**: SQL Editor -> paste `deploy/all-migrations.sql`
   (concatenation of all 36 migrations, in order) -> Run.
   Hosted projects auto-grant table privileges — the local-CLI GRANT
   quirk does NOT apply.
3. **Auth settings** (Authentication -> Sign In / Providers):
   - Email provider ON; **keep "Confirm email" ENABLED** (G2 hardening;
     the `cfg/g2-hardening` signup fix handles both modes correctly).
   - Site URL: `https://crm.dachprotect.com.pl`.
4. **DNS**: A record `crm.dachprotect.com.pl` -> `76.13.14.45`
   (Hostinger hPanel, dachprotect.com.pl zone). Traefik then issues the
   Let's Encrypt cert automatically on first request.

## Deploy / update (repeatable)

```bash
ssh 76.13.14.45
cd /docker/wacrm            # contains docker-compose.wacrm.yml + .env
docker compose -f docker-compose.wacrm.yml --env-file .env up -d --build
docker logs -f wacrm        # first boot: watch for "Ready"
```

The compose builds straight from the GitHub branch, so "update" =
push to `cfg/g2-hardening`, then re-run the same command.

## Hardening delta vs upstream (this branch)

- `output: "standalone"` in next.config.ts + multi-stage Dockerfile
  (non-root `nextjs` user, no full node_modules in runtime image).
- Traefik rate limit 30 rps / burst 60 per IP (G0 note #1).
- `NEXT_PUBLIC_SITE_URL` + `ALLOWED_INVITE_HOSTS` pinned (G0 note #2).
- `AUTOMATION_CRON_SECRET` + in-compose cron pinger (G0 note #3).
- Signup fix: session-aware redirect (upstream bug - "Check your email"
  shown even when confirmations are disabled and no mail is ever sent).
- Port 3000 never published on the host; only Traefik reaches the app.

## Meta wiring (G3, after business verification)

Webhook callback: `https://crm.dachprotect.com.pl/api/whatsapp/webhook`
+ verify token from Settings -> WhatsApp in the app. `META_APP_SECRET`
into `.env`, then `docker compose ... up -d` to recreate.
