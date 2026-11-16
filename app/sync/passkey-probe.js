// Passkey probe (docs/PASSKEYS.md, stage 1). Answers one question for the owner: can this browser use Face ID / Touch ID
// passkeys (WebAuthn)? Nothing is sent anywhere and nothing is stored: the throwaway credential's id is never kept, and no
// server is involved. Pure ES module; everything the browser provides is injectable so tests can run it in Node.

const bytes = (n, crypto = globalThis.crypto) => crypto.getRandomValues(new Uint8Array(n));

/** "NotAllowedError: The operation either timed out or was not allowed" */
export const describeError = (e) => `${e?.name || 'Error'}: ${e?.message || 'no message'}`;

const REASONS = {
  NotAllowedError: 'it was cancelled, timed out, or this browser is not allowed to use Face ID passkeys',
  SecurityError: 'this page address is not allowed to use passkeys here',
  NotSupportedError: 'this browser does not support the kind of passkey needed',
  InvalidStateError: 'a passkey for this test already exists on this device',
  AbortError: 'the request was cancelled',
};
export const plainReason = (e) => REASONS[e?.name] || 'the browser refused';

/** Step 1, no prompt: what does the browser say it can do? */
export async function detectPasskeys({ win = globalThis, log = () => {} } = {}) {
  const out = { secureContext: !!win.isSecureContext, hasPublicKeyCredential: !!win.PublicKeyCredential, platformAuthenticator: null, error: null };
  log(`Passkeys: secure page (https/localhost): ${out.secureContext ? 'yes' : 'no'}`);
  log(`Passkeys: PublicKeyCredential exists: ${out.hasPublicKeyCredential ? 'yes' : 'no'}`);
  if (out.hasPublicKeyCredential && typeof win.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
    try { out.platformAuthenticator = !!(await win.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch (e) { out.error = describeError(e); }
    log(out.error ? `Passkeys: platform authenticator check failed: ${out.error}` : `Passkeys: Face ID / Touch ID style authenticator available: ${out.platformAuthenticator ? 'yes' : 'no'}`);
  } else if (out.hasPublicKeyCredential) log('Passkeys: isUserVerifyingPlatformAuthenticatorAvailable is missing');
  out.summary = summarize(out);
  return out;
}

/** The plain-language line shown at the top. `ok` is true only when a real create + get succeeded. */
function summarize(d) {
  if (!d.secureContext) return { ok: false, line: 'This browser can’t use passkeys: the page is not on https (or localhost).' };
  if (!d.hasPublicKeyCredential) return { ok: false, line: 'This browser can’t use passkeys: it has no passkey support (PublicKeyCredential is missing).' };
  if (d.platformAuthenticator === false) return { ok: false, line: 'This browser can’t use passkeys: no Face ID / Touch ID style unlock is available here.' };
  if (d.error) return { ok: false, line: `This browser can’t use passkeys: ${d.error}` };
  return { ok: null, line: 'This browser says passkeys should work. Press “Test Face ID passkey” to be sure.' };
}

/** Step 2, prompts the user: throwaway create() then get() with it. Returns { ok, line, steps }. */
export async function testPasskeys({ nav = globalThis.navigator, win = globalThis, log = () => {}, crypto = globalThis.crypto } = {}) {
  const steps = [];
  const rpId = win.location?.hostname;
  const step = (name, ok, detail) => { steps.push({ name, ok, detail }); log(`Passkeys: ${name}: ${ok ? 'ok' : 'FAILED'}${detail ? ` (${detail})` : ''}`); };
  const fail = (name, e) => { step(name, false, describeError(e)); return { ok: false, steps, line: `This browser can’t use passkeys: ${plainReason(e)} (${name}: ${describeError(e)}).` }; };
  // WebKit wants create() close to the tap (transient user activation), so no await comes before it: the
  // synchronous checks run first, the capability check runs alongside and is reported afterwards.
  if (!win.isSecureContext) return { ok: false, steps, line: 'This browser can\u2019t use passkeys: the page is not on https (or localhost).' };
  if (!win.PublicKeyCredential) return { ok: false, steps, line: 'This browser can\u2019t use passkeys: it has no passkey support (PublicKeyCredential is missing).' };
  if (!nav?.credentials?.create || !nav.credentials.get) return { ok: false, steps, line: 'This browser can\u2019t use passkeys: navigator.credentials is missing.' };
  log(`Passkeys: test using rp id "${rpId}" on ${win.location?.origin ?? 'unknown origin'}`);
  const detection = detectPasskeys({ win, log });

  let cred;
  try {
    cred = await nav.credentials.create({ publicKey: {
      rp: { id: rpId, name: 'Dot Scale passkey test' },
      user: { id: bytes(16, crypto), name: 'passkey-test', displayName: 'Passkey test' },
      challenge: bytes(32, crypto),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none', timeout: 60000,
    } });
    if (!cred?.rawId) throw Object.assign(new Error('no credential returned'), { name: 'NoCredential' });
    step('create a test passkey', true);
    // Not pass/fail: facts the server design (docs/PASSKEYS.md) relies on, for the Debug log.
    const r = cred.response;
    log(`Passkeys: response.getPublicKey available: ${typeof r?.getPublicKey === 'function' ? 'yes' : 'no'}; getAuthenticatorData: ${typeof r?.getAuthenticatorData === 'function' ? 'yes' : 'no'}`);
  } catch (e) { await detection; return fail('create a test passkey', e); }
  await detection;

  try {
    const a = await nav.credentials.get({ publicKey: {
      rpId, challenge: bytes(32, crypto), userVerification: 'required', timeout: 60000,
      allowCredentials: [{ type: 'public-key', id: cred.rawId }],
    } });
    if (!a?.response?.signature) throw Object.assign(new Error('no signature returned'), { name: 'NoSignature' });
    step('sign in with it', true);
  } catch (e) { return fail('sign in with it', e); }

  // `cred` goes out of scope here: its id is never stored or sent. The passkey itself stays in the device's passkey store.
  return { ok: true, steps, line: 'Face ID passkeys work in this browser.' };
}
