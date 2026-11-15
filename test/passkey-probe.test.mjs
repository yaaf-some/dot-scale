import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPasskeys, testPasskeys, describeError } from '../app/sync/passkey-probe.js';

const win = (over = {}) => ({ isSecureContext: true, location: { hostname: 'example.test' }, PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true }, ...over });
const dom = (name, message) => Object.assign(new Error(message), { name });
const okNav = (calls = []) => ({ credentials: {
  create: async (o) => { calls.push(['create', o]); return { rawId: new Uint8Array([1, 2, 3]).buffer }; },
  get: async (o) => { calls.push(['get', o]); return { response: { signature: new Uint8Array(8) } }; },
} });

test('probe: happy path uses ES256, platform, UV required, no attestation, rp id = hostname, and logs every step', async () => {
  const calls = [], lines = [];
  const r = await testPasskeys({ nav: okNav(calls), win: win(), log: (l) => lines.push(l) });
  assert.equal(r.ok, true);
  assert.equal(r.line, 'Face ID passkeys work in this browser.');
  const pk = calls[0][1].publicKey;
  assert.equal(pk.rp.id, 'example.test');
  assert.deepEqual(pk.pubKeyCredParams, [{ type: 'public-key', alg: -7 }]);
  assert.equal(pk.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(pk.authenticatorSelection.userVerification, 'required');
  assert.equal(pk.attestation, 'none');
  assert.equal(calls[1][1].publicKey.rpId, 'example.test');
  assert.equal(calls[1][1].publicKey.userVerification, 'required');
  assert.ok(lines.some((l) => /create a test passkey: ok/.test(l)) && lines.some((l) => /sign in with it: ok/.test(l)));
});

test('probe: failures report the exact DOMException name and message, and never call get after a failed create', async () => {
  for (const name of ['NotAllowedError', 'SecurityError', 'NotSupportedError']) {
    const calls = [];
    const nav = { credentials: { create: async () => { throw dom(name, 'boom'); }, get: async () => { calls.push('get'); } } };
    const r = await testPasskeys({ nav, win: win() });
    assert.equal(r.ok, false);
    assert.ok(r.line.startsWith('This browser can’t use passkeys:'));
    assert.ok(r.line.includes(`${name}: boom`));
    assert.deepEqual(calls, []);
  }
  const nav = { credentials: { create: okNav().credentials.create, get: async () => { throw dom('NotAllowedError', 'denied'); } } };
  const r = await testPasskeys({ nav, win: win() });
  assert.ok(!r.ok && r.line.includes('sign in with it') && r.line.includes('NotAllowedError: denied'));
});

test('probe: create is called before any await (keeps the user gesture fresh); no-credential and no-signature are failures', async () => {
  let createdSync = false;
  const nav = { credentials: { create: () => { createdSync = true; return Promise.resolve({ rawId: new ArrayBuffer(1) }); }, get: async () => ({ response: {} }) } };
  const p = testPasskeys({ nav, win: win() });
  assert.equal(createdSync, true);
  assert.match((await p).line, /NoSignature/);
  const none = { credentials: { create: async () => ({}), get: async () => ({}) } };
  assert.match((await testPasskeys({ nav: none, win: win() })).line, /NoCredential/);
});

test('probe: detection explains missing support without prompting (Check support never calls create)', async () => {
  assert.match((await detectPasskeys({ win: win({ PublicKeyCredential: undefined }) })).summary.line, /no passkey support/);
  assert.match((await detectPasskeys({ win: win({ isSecureContext: false }) })).summary.line, /not on https/);
  const none = win({ PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => false } });
  assert.match((await detectPasskeys({ win: none })).summary.line, /no Face ID/);
  assert.equal(describeError({ name: 'X', message: 'y' }), 'X: y');
});
