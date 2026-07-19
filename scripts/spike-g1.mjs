// G1 spike — CFG evaluation of wacrm (2026-07-19).
// Runs against a LOCAL supabase stack + local `npm run dev` server.
// Validates: signup provisioning, whatsapp_config seeding, webhook GET
// handshake, HMAC-valid inbound POST -> message row, HMAC-invalid -> 401,
// and the /api/v1 public API with a scoped key.
//
// Usage:  node scripts/spike-g1.mjs
// Env:    reads .env.local (SUPABASE url/keys, ENCRYPTION_KEY, META_APP_SECRET)

import crypto from 'node:crypto'
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const APP = process.env.APP_URL || 'http://localhost:3003'

// --- load .env.local -------------------------------------------------
const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].trim()
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
const ENC_KEY = env.ENCRYPTION_KEY
const APP_SECRET = env.META_APP_SECRET
if (!SB_URL || !SERVICE || !ENC_KEY || !APP_SECRET) {
  console.error('FAIL missing env values'); process.exit(1)
}

const admin = createClient(SB_URL, SERVICE)
const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// AES-256-GCM encrypt matching src/lib/whatsapp/encryption.ts (iv:ct:tag hex)
function encrypt(text) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENC_KEY, 'hex'), iv)
  let enc = c.update(text, 'utf8', 'hex'); enc += c.final('hex')
  return `${iv.toString('hex')}:${enc}:${c.getAuthTag().toString('hex')}`
}

const PHONE_NUMBER_ID = 'spike-pnid-001'
const VERIFY_TOKEN = 'spike-verify-token'
const TEST_SENDER = '48500100200'

// --- 1. user + account provisioning ---------------------------------
const email = `spike-${Date.now()}@cfg.local`
const { data: created, error: userErr } = await admin.auth.admin.createUser({
  email, password: 'Spike-g1-pass!234', email_confirm: true,
  user_metadata: { full_name: 'G1 Spike' },
})
ok('signup via admin API', !userErr, userErr?.message)
const userId = created?.user?.id

let accountId = null
for (let i = 0; i < 10 && !accountId; i++) {
  const { data: prof } = await admin.from('profiles')
    .select('account_id').eq('user_id', userId).maybeSingle()
  accountId = prof?.account_id
  if (!accountId) await new Promise(r => setTimeout(r, 300))
}
ok('handle_new_user provisions profile+account', !!accountId, accountId ?? 'no account_id')

// --- 2. seed whatsapp_config ----------------------------------------
const { error: cfgErr } = await admin.from('whatsapp_config').insert({
  user_id: userId, account_id: accountId,
  phone_number_id: PHONE_NUMBER_ID, waba_id: 'spike-waba',
  access_token: encrypt('spike-meta-access-token'),
  verify_token: encrypt(VERIFY_TOKEN),
  status: 'connected', connected_at: new Date().toISOString(),
})
ok('whatsapp_config seeded (encrypted GCM)', !cfgErr, cfgErr?.message)

// --- 3. webhook GET handshake ---------------------------------------
const hs = await fetch(`${APP}/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=CHAL-42&hub.verify_token=${VERIFY_TOKEN}`)
ok('webhook GET handshake echoes challenge', hs.status === 200 && (await hs.text()) === 'CHAL-42', `status ${hs.status}`)

const hsBad = await fetch(`${APP}/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=x&hub.verify_token=WRONG`)
ok('webhook GET rejects wrong verify_token', hsBad.status === 403, `status ${hsBad.status}`)

// --- 4. inbound message webhook (valid HMAC) ------------------------
const payload = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'spike-waba',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '48500999888', phone_number_id: PHONE_NUMBER_ID },
        contacts: [{ profile: { name: 'Spike Lead' }, wa_id: TEST_SENDER }],
        messages: [{
          id: `wamid.SPIKE${Date.now()}`, from: TEST_SENDER,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text', text: { body: 'Dzien dobry, prosze o wycene dachu 800 m2' },
        }],
      },
    }],
  }],
})
const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(payload).digest('hex')
const post = await fetch(`${APP}/api/whatsapp/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
  body: payload,
})
ok('inbound webhook accepted (valid HMAC)', post.status === 200, `status ${post.status}`)

// poll for the message row (processed via after())
let msgRow = null
for (let i = 0; i < 20 && !msgRow; i++) {
  const { data } = await admin.from('messages')
    .select('id, content_text, conversations!inner(account_id, contacts(name, phone))')
    .eq('conversations.account_id', accountId).limit(5)
  msgRow = data?.find(m => m.content_text?.includes('800 m2'))
  if (!msgRow) await new Promise(r => setTimeout(r, 500))
}
ok('message row + contact + conversation created', !!msgRow,
  msgRow ? `contact=${msgRow.conversations?.contacts?.name}` : 'not found after 10s')

// --- 5. spoofed webhook (invalid HMAC) ------------------------------
const spoof = await fetch(`${APP}/api/whatsapp/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
  body: payload,
})
ok('spoofed webhook rejected 401', spoof.status === 401, `status ${spoof.status}`)

const noSig = await fetch(`${APP}/api/whatsapp/webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
})
ok('unsigned webhook rejected 401', noSig.status === 401, `status ${noSig.status}`)

// --- 6. public API /api/v1 with scoped key --------------------------
// Mint a key exactly as src/lib/api-keys/keys.ts does.
const body = crypto.randomBytes(32).toString('base64url')
const plaintext = `wacrm_live_${body}`
const keyHash = crypto.createHash('sha256').update(plaintext).digest('hex')
const { error: keyErr } = await admin.from('api_keys').insert({
  account_id: accountId, created_by: userId, name: 'g1-spike',
  key_prefix: `wacrm_live_${body.slice(0, 8)}`, key_hash: keyHash,
  scopes: ['contacts:read'],
})
ok('api key minted (hash-stored, contacts:read)', !keyErr, keyErr?.message)

const v1 = await fetch(`${APP}/api/v1/contacts`, {
  headers: { authorization: `Bearer ${plaintext}` },
})
const v1json = await v1.json().catch(() => null)
const foundSpike = JSON.stringify(v1json ?? {}).includes('Spike Lead')
ok('GET /api/v1/contacts with key returns spike contact', v1.status === 200 && foundSpike, `status ${v1.status}`)

// scope enforcement: key lacks messages:send
const v1send = await fetch(`${APP}/api/v1/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
  body: JSON.stringify({ to: TEST_SENDER, type: 'text', text: 'x' }),
})
ok('scope enforcement: messages:send denied 403', v1send.status === 403, `status ${v1send.status}`)

const v1bad = await fetch(`${APP}/api/v1/contacts`, {
  headers: { authorization: 'Bearer wacrm_live_invalid' },
})
ok('invalid api key rejected 401', v1bad.status === 401, `status ${v1bad.status}`)

// --- summary ---------------------------------------------------------
const fails = results.filter(r => !r.pass)
console.log(`\n=== G1 SPIKE: ${results.length - fails.length}/${results.length} PASS ===`)
process.exit(fails.length ? 1 : 0)
