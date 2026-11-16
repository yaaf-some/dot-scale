# Passkeys (Face ID / Touch ID) for household sync: design

**Status: not pursued.** Tested Nov 2026: passkeys work in Safari but not in Bluefy (the only iPhone browser with Web Bluetooth), so
they would not protect the owner's devices. Kept as a record of the design and of what was learned. The probe described below was
removed again; nothing here is implemented. The real remaining gap is that a household code cannot be changed (a possible small
future feature: "rotate code").

(The rest of this document is written as it was before the result was known.)

## Stage 1: the probe (shipped with this document)

Settings → Sync → "Face ID / passkey support" has two buttons, entirely client-side (`app/sync/passkey-probe.js`):

- **Check support** (no prompt): is the page on https/localhost, does `PublicKeyCredential` exist, does
  `isUserVerifyingPlatformAuthenticatorAvailable()` say yes.
- **Test Face ID passkey**: a throwaway `navigator.credentials.create` (ES256, `userVerification: required`, platform
  authenticator, no attestation, `rp.id = location.hostname`, random challenge) then a `get` with that credential. The result
  line is plain ("Face ID passkeys work in this browser" / "This browser can't use passkeys: <reason>") and every step plus the exact
  `DOMException` name/message goes to Settings → Advanced → log. It also logs whether `response.getPublicKey()` /
  `getAuthenticatorData()` exist (the design below prefers them). Nothing is sent anywhere and the app keeps nothing; the credential id is dropped. The test calls `create()` first thing after the tap (WebKit needs a fresh user gesture), with the capability check running alongside.

The throwaway passkey (a "Passkey test" entry) does stay in the device's passkey store (iOS Passwords / iCloud Keychain, synced to their other Apple devices) under this site, and each test press adds one; the owner can delete them
there. It is not used by anything.

**What the owner reports back:** the result line, and on failure the `name: message` text, from Safari and from Bluefy.
Not covered: whether discoverable sign-in (a `get` with no credential id) works; stage 2's first hardware check.

## Threat model

What passkeys can protect (only once the server *requires* them, see "Modes"):

| Threat | Today (code only) | With passkeys |
| --- | --- | --- |
| Household code leaks or is guessed (45 bits, rate-limited, HMAC-stored) | Full read/write | In `passkey_only`: useless alone. In `code_or_passkey`: no change, the code still works |
| Lost, unlocked, or borrowed device | The code sits in `localStorage`; whoever opens the app syncs | The device holds no code; syncing needs Face ID. A thief with an *unlocked* phone and the app open can still ask for Face ID, which they can't pass |
| Shoulder-surfing / screenshot of the code | Full access | Invites are single-use and expire in 10 minutes |
| Database leak | Hashes only, keyed with `SYNC_PEPPER` | Same, plus public keys (not secret) |

What they do **not** protect: someone who is *you* to the phone (unlocked device + your face/passcode); a compromised Worker or
Cloudflare account; malware in the browser; anyone the owner invites; denial of service. And in `code_or_passkey` mode passkeys add
**no** protection against a leaked code, which is the main practical risk. A passkey layer that still accepts the code adds
convenience (no code on the device), not security.

### The lock-out attack to design against

In `code_or_passkey`, anyone holding the code can register *their* passkey, then flip the household to `passkey_only` and lock the
owner out. Mitigations (all required for stage 3):
1. Switching to `passkey_only` needs a **passkey session** (not the code) with a **fresh assertion** (under 5 minutes old).
2. It does not apply at once: the household shows "passkey-only starts in 24 h" on every device, and **any** device (code or passkey)
   can cancel during that window. Revoking a passkey likewise needs a passkey session in `passkey_only` mode but only the code in the other.
3. It requires at least **two** registered passkeys, or an explicit "I understand" with the recovery steps below.
4. Settings lists registered passkeys (label, created, last used) so a stranger's shows up.

## Design review: the controller's proposal, refined

Kept as proposed: ES256 only, attestation `none`, `userVerification: required`, server-side challenge/response with single-use
short-lived challenges, origin and rpId checked, WebCrypto-only verification, stateless HMAC session token held in memory, additive
migration, `code_or_passkey` default.

Changes and why:

1. **Store the public key as SPKI, not COSE.** `PublicKeyCredential.response.getPublicKey()` returns SPKI, which
   `crypto.subtle.importKey('spki', …, {name:'ECDSA', namedCurve:'P-256'})` takes directly: no CBOR decoder, no COSE→JWK code in the
   Worker. The client also sends `getAuthenticatorData()`. Fallback if the probe says a browser lacks them: send `attestationObject` and
   parse it with a ~60-line CBOR reader (a stage 2 decision, driven by the Bluefy probe log).
2. **WebAuthn signatures are DER; WebCrypto `verify` wants raw `r‖s`.** Needs a small DER→P1363 converter (unit-tested).
   Verify `signature` over `authenticatorData ‖ SHA-256(clientDataJSON)`.
3. **`signCount` cannot be relied on.** iCloud-synced passkeys (Apple) always report `0`, and synced passkeys can be used from
   several devices. Rule: if both stored and new counts are non-zero, the new one must be greater, else reject; a stored `0` with a new
   `0` is accepted. So *cloned-authenticator detection is best-effort and effectively absent for Apple passkeys*; user verification
   (Face ID) is the real protection. Say this plainly in the UI copy ("passkey" not "hardware key").
4. **Discoverable credentials (`residentKey: required`).** An iCloud passkey is shared across the owner's Apple devices, so a new
   device of the same Apple ID can sign in with no invite, via `get` with empty `allowCredentials`. The server finds the credential by the
   `credentialId` in the assertion, so `/api/auth/challenge` needs no account identifier and can't be used to probe which credentials exist.
   Different people (Yaaf, Alexa: different Apple IDs) still need an invite. The probe creates its throwaway passkey with `residentKey: preferred`; stage 2 must verify
   `required` on hardware.
5. **Challenges: stateless to issue, one D1 insert to consume.** The challenge is `nonce(16 B) ‖ expiry ‖ HMAC` (key derived from
   `SYNC_PEPPER`, label `dot-scale/challenge/v1`), 60 s lifetime. Issuing costs **zero D1 queries**, so flooding `/api/auth/challenge`
   can't touch the database or the budget. Single use is enforced at verify time by `INSERT INTO auth_nonces(nonce, expires_at)`: a
   primary-key conflict means replay. Expired rows are purged opportunistically (the existing `purgeExpired` pattern).
6. **Session token = HMAC over `{ h: householdHash, c: credentialId, exp }`**, prefix `dst1.`, so the Worker can tell it from a
   household code (codes never contain `.`) in the same `Authorization: Bearer` header. Key derived from `SYNC_PEPPER`
   (`dot-scale/session/v1`, never the same key as hashing). Lifetime **1 hour**. Stateless can't be revoked, so the existing
   per-request household lookup (`gate`) also checks the credential still exists (a join in the same query: no extra query), so deleting a
   passkey ends its sessions at once. Rotating `SYNC_PEPPER` already orphans households; it also kills every session.
7. **User activation.** Safari/WebKit requires a user gesture for `create()`/`get()`. So sync can't silently re-sign-in after the token
   expires or on app launch: the status becomes "Tap to unlock sync" and the next tap (Sync now, or any button) runs Face ID. Expect one
   Face ID prompt per app session, at most hourly. This is the cost of "the device forgets the code" and of memory-only tokens.
8. **Uniform failure.** In `passkey_only` a raw-code request gets the same `401 unauthorized` and counts as an IP failure exactly like
   a wrong code. Replying "passkey required" would tell an attacker that a guessed code was correct.
9. **Joining a new device in `passkey_only` is one atomic step:** redeem invite *and* register this device's passkey (`create()` with the
   invite's challenge). An invite alone grants nothing. Invites are 128-bit random, stored as HMAC hashes, single-use, 10 min, delivered
   as a link/QR with the secret in the URL **fragment** (never sent to a server), created only by a passkey session. Invite redemption failures count
   like wrong codes. `code_or_passkey` may use the same invites; the old code still joins there.
10. **No code rotation exists today.** In `code_or_passkey` a leaked code is permanent. Stage 3 could add "rotate code" (needs a passkey
    session). Out of scope for stage 2.
11. **Origin/rpId.** The expected origin is `new URL(request.url).origin` and rpId its hostname, never a client-supplied value.
    clientDataJSON `type`, `challenge`, `origin` (and no `crossOrigin: true`), authData `rpIdHash`, flags UP and UV all checked. A passkey is
    bound to the host: moving off `coffee.yaafsome.fyi` or testing on a preview URL means separate passkeys; the code path is unaffected.

## Modes

- **`code_or_passkey` (default; today's behaviour).** Everything keeps working. Registering a passkey is optional per device. If a device
  has one, it can drop the stored code ("Use Face ID on this device").
- **`passkey_only`.** The server rejects code authentication for sync and registration; new devices join by invite or a synced passkey.

**Recommendation: do not offer `passkey_only` in stage 2, and not at all until the Bluefy result is known.** If Bluefy can't do passkeys,
`passkey_only` would lock the owner's main devices out of their own coffee data; even if it works, the lock-out attack above and the recovery cost
need the stage 3 guard rails. Stage 2 ships registration, sign-in and passkey listing in `code_or_passkey` only. A device with a working
passkey is then merely convenient, and the code stays the fallback everywhere.

## Data model (migration `0002_passkeys.sql`, additive)

Existing tables are untouched except one added column with a default, so the old Worker keeps running against the new schema.

```sql
ALTER TABLE households ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'code_or_passkey';
ALTER TABLE households ADD COLUMN passkey_only_from INTEGER;        -- pending switch (stage 3), NULL normally
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,               -- base64url credential id
  household_hash TEXT NOT NULL, public_key TEXT NOT NULL,   -- SPKI, base64url
  sign_count INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER
) WITHOUT ROWID;
CREATE INDEX credentials_by_household ON credentials (household_hash);
CREATE TABLE auth_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE invites (hash TEXT PRIMARY KEY, household_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER) WITHOUT ROWID;
```

Per-household cap: 10 credentials, 5 open invites. Deploys do not run migrations (DEPLOY.md), so apply 0002 **before** merging stage 2;
the Worker must answer the passkey endpoints with the existing "not set up" style 503 if the tables are missing.

## Endpoints (stage 2)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/auth/challenge` | none | `{ challenge, expiresAt }`; stateless, no DB |
| `POST /api/auth/register` | code (or passkey session) | verify a `create()` response, store the credential, return `{ credentialId }` |
| `POST /api/auth/verify` | none | verify a `get()` assertion, return `{ token, expiresAt }` |
| `POST /api/auth/invite` | passkey session | `{ invite, expiresAt }` |
| `POST /api/auth/redeem` | invite | register this device's passkey, return a token |
| `GET/DELETE /api/auth/credentials` | code or passkey session | list / remove (rules above) |

All are plain `(Request, deps) → Response` in `worker/auth.js`; database access stays in `worker/storage.js` (new functions; SYNC.md
says "eight functions", that count changes). The WebAuthn verification (`worker/webauthn.js`) is pure functions, WebCrypto only.

## Rate limits and abuse

| Case | Handling |
| --- | --- |
| Challenge flooding | Stateless: no D1, only Worker CPU. Add a Cloudflare rate-limiting rule (dashboard) if it ever matters |
| Verify with garbage | Same per-IP failure counter as wrong codes (10 per 10 min) |
| Replay of a captured assertion | Challenge is single-use (`auth_nonces` PK) and expires in 60 s; origin and rpId are in the signed data |
| Replay of a session token | Bearer by design; 1 h life, memory only, ended at once by deleting the credential |
| Cloned authenticator | Not detectable for synced passkeys (see 3); Face ID gate is the protection |
| Attacker with the code registers a passkey | Possible in `code_or_passkey` (the code is the full secret there); visible in the list, removable; lock-out guarded above |
| Invite guessing | 128-bit; failures rate-limited anyway |
| Credential-id enumeration | Challenge needs no id; verify failures are uniform |
| Timing | Constant-time compare for HMACs via `crypto.subtle.verify` |

## D1 cost (Workers Free: 50 queries per invocation; SYNC.md budget)

| Request | Queries |
| --- | --- |
| `challenge` | 0 |
| `verify` (sign-in) | ~4: IP gate, credential+household lookup, nonce insert, `sign_count`/`last_used_at` update |
| sync with a token | unchanged: today's `gate` (credential check folded in) + merge; worst case stays 38 |
| `register` | ~4 (gate, count, insert, optional mode read) |
| `invite` / `redeem` | ~2 / ~6 in one `batch` |

Daily volume at household scale (a few sign-ins a day) is far below the Free plan's daily read/write allowances.

## Recovery if every device is lost

Local-first: each device keeps its full data, and the household holds a copy. In `code_or_passkey` nothing changes: the code still joins a
new device. In `passkey_only` (stage 3, if ever): losing all passkeys *and* iCloud Keychain would make the household unreachable. Recovery
paths, in order: (1) another device with a synced passkey; (2) an existing signed-in device creates an invite; (3) the owner, in the D1
console, runs `UPDATE households SET auth_mode='code_or_passkey'` for their household (a documented DEPLOY.md step added in stage 3);
(4) last resort: use Settings → export on any device that still has the data, create a new household, import. Stage 3's switch UI shows
these before confirming.

## What changes in docs/SYNC.md (stage 2)

Authentication section: Bearer may be a code or a `dst1.` session token; the new endpoints; storage adapter function list; limits table rows
for challenges/verify/invites; "the code is the only thing protecting a household" becomes mode-dependent; "Leaving" also forgets the
credential id. `docs/DEPLOY.md` §4: apply migration 0002.

## Test plan

Unit tests run the real handlers and storage on the in-memory SQLite shim (`test/worker.test.mjs` style), with a **software WebAuthn
authenticator in the test** using Node's `webcrypto`: generates a P-256 key, builds `authenticatorData` (rpIdHash, flags UP|UV, counter),
`clientDataJSON`, signs and **converts the signature to DER** (as real authenticators do), exports SPKI. Cases: register and sign-in happy
path; wrong challenge, expired challenge, reused challenge (replay), wrong origin, wrong rpId hash, missing UV, `crossOrigin`, tampered
signature or authData, other key, unknown credential, signCount rules (0/0 ok, equal or lower rejected), DER edge cases (short r/s, leading
zeros), token tamper/expiry/other household/deleted credential, raw code rejected in `passkey_only` with the same response as a wrong code,
invite single-use/expiry/atomic register, caps, D1 statement budget, no secrets in logs, migration is additive on a v1 database.
Client tests use the fake fetch and a fake `navigator.credentials` (as the probe test does), plus the "Tap to unlock" state.

**Verified only on real hardware (cannot be tested in the cloud):** Face ID prompts; whether **Bluefy** allows passkeys at all (third-party iOS
browsers may need Apple's web-browser entitlement); behaviour in Safari vs Bluefy vs a home-screen web app; iCloud-synced passkeys appearing
on a second device and reporting `signCount 0`; discoverable (`residentKey: required`) sign-in; `getPublicKey()` availability in Bluefy; the user-activation rule
for `get()` after launch. The probe covers the first and part of the rest; stage 2's client work must be re-verified by the owner on device.
