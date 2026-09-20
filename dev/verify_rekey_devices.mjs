// verify_rekey_devices.mjs — a passphrase change on ONE device is adopted by the
// OTHER, rather than forking the account.
//
// WHAT THIS IS FOR. `changePassphrase` re-derives the wrapping key under a fresh salt,
// so a second device still on the old salt cannot read a byte the changer pushes. It
// used to fork the account for ever: sync.js's corruption recovery, on each device,
// adopting the other's version and pushing its own over the top -- a permanent clobber
// ping-pong with both chips reading "Synced". The fix (identity.js epoch chain +
// sync.js envelope) carries the change to the linked device: the new key bits sealed
// UNDER THE OLD KEY into a rekey record that rides inside the sync blob, so a device
// holding the old key adopts the new one WITHOUT ever knowing the new passphrase.
//
// The invariants, and every one of them is checked below against two REAL devices:
//
//   1. NO DATA LOSS. A device on the old epoch, after adopting, still opens everything
//      it had -- its provider key is still resolvable, ready() is still true.
//   2. NO FORK. After A changes the passphrase, B ADOPTS A's epoch rather than
//      clobbering with its own: no `pull decrypt/parse failed`, no version ping-pong,
//      and both read each other's post-rekey edits.
//   3. EPOCH-0 IS BYTE-IDENTICAL. Before any change, the blob A pushes carries NO
//      envelope -- an account that never changes its passphrase is untouched and needs
//      no gateway change. (Asserted by the captured pre-change blob NOT beginning
//      'DRK1', and the post-change one DOING so.)
//   4. THE LOST-EDIT RACE IS CLOSED. B pushes at the old epoch just before A's change
//      lands; A opens B's parcel with the previous key it still holds, merges, and
//      pushes under the new key -- B's edit is not lost.
//   5. A DEVICE TOO FAR BEHIND THE CHAIN DOES NOT CLOBBER. When the chain cannot be
//      walked (a gap), the device sets the sticky 'rekey' chip, adopts NO version, and
//      makes NO push.
//
// THE ADVERSARIAL DEFECTS (added after the epoch-chain rekey failed its audit with
// three HIGH findings). Each is checked below against real devices, and each has a
// negative control that goes RED when its fix is reverted:
//
//   D1 (account lockout). The at-rest record body was unauthenticated: a mailbox
//      writer could swap the salt/sealing key for garbage and every device that
//      adopted it was bricked ("wrong passphrase" for ever). The body is now SIGNED
//      on mint and VERIFIED before the walk. Control: a tampered salt/sealk is
//      REFUSED with 'unsigned', nothing is written, and the victim still unlocks with
//      its real passphrase. `--expect-defects` neutralises the verify and the victim
//      is bricked instead.
//   D2 (same-epoch divergence). Two devices rekeying to one epoch on different salts
//      forked: the same-epoch branch read the unwrap failure as corruption and the two
//      clobbered each other for ever. They now YIELD deterministically (larger salt
//      adopts the other's branch). Control: two devices change offline and CONVERGE on
//      one salt and version with no decrypt/parse fork, each reading the other's edits.
//   D3 (progress clobber). A progress frame at epoch >= 1 was sent as a bare blob, so a
//      lagging watcher could not adopt it and clobbered mid-turn. It now carries the
//      record. Control: the progress push carries a DRK1 envelope. `--expect-defects`
//      strips it.
//   D6 (WS-BRICK regression). The wire estimate counted an empty blob, so at epoch >= 1
//      the record's kilobytes were uncounted and a parcel in the margin passed the local
//      gate and 413'd at the gateway. The estimate now counts the envelope. Control: the
//      estimate is not smaller than the real body. `--expect-defects` zeroes the count.
//
// THE ROUND-2 GAPS (found re-auditing the round-1 signing). Same shape: a fixed-code
// property, checked anti, that --expect-defects turns red.
//
//   Gap 1 (DoS, the moved threat). An UNVERIFIED record steered pullOnce BEFORE any sig
//      check: a forged `{v:1, epoch:le+1, pub:<account pub>}` (unsigned) drove every
//      device -- even a never-rekeyed one at le=0 -- to rekeyBehind and a standing push
//      lockout. The record is now VERIFIED right after openEnvelope (pub is the trusted
//      account pub AND the body is signed), and a failure is treated as ABSENT, so a
//      forgery degrades to corruption recovery. Controls: a forged unsigned record at
//      le+1, and a same-epoch salt-diverged forgery, set NO rekey chip, on a
//      never-rekeyed device AND a rekeyed one, with no lockout. --expect-defects drops
//      the verify and they stand down.
//   Gap 2 (silent adoption). sync.js fired `daimond:rekey` but nothing rendered it, so an
//      adoption -- and any reseal failure riding with it -- was silent. daimond.js now
//      renders the notice. Control: the listener turns a carried sentence into an on-screen
//      notice. --expect-defects drops the render.
//   Gap 3 (divergence stranding). A device that LOST a same-epoch divergence, then met a
//      LATER change from the winning branch, gapped on its first rung and stranded. It now
//      retries the walk from the shared previous epoch under the key it kept, crossing onto
//      the winning branch. Control: the loser adopts the later change and reads the winner's
//      edit, no sticky chip. --expect-defects drops the retry and it strands.
//
// THE NEGATIVE CONTROLS. `--expect-fork` serves sync.js with the envelope carry
// neutralised (wrapEnvelope returns the bare blob), which reproduces the pre-fix world:
// the record never travels, B cannot read A's blob, and the fork returns. The anti-fork
// checks (2) then go RED, as they must -- proof they have teeth. `--expect-defects`
// reverts the D1/D3/D6 fixes and the checks marked anti below go red. A control run with
// failures is the control passing; a run with NONE means the checks have no teeth.
//
//   node dev/verify_rekey_devices.mjs                    # fixed code: all green
//   node dev/verify_rekey_devices.mjs --expect-fork      # old behaviour: the fork returns
//   node dev/verify_rekey_devices.mjs --expect-defects   # D1/D3/D6 reverted: their controls go red
//
// Needs the dev stack up (dev/serve.mjs + dev/mockllm.mjs) AND the dev gateway, as
// verify_pairing.mjs and verify_devices.mjs's devrem block do:
//
//   DAIMOND_GW_PORT=9700 eval "$(bash dev/world.sh 0 --env)"   # or a world with a gw
//   node dev/verify_rekey_devices.mjs
//
// Chromium is enough; the reload/unlock leg is worth one run under WebKit
// (DAIMOND_BROWSER=webkit) for the engine the owner's phone runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, scratch, PASS, shot } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const EXPECT_FORK    = process.argv.includes('--expect-fork');
const EXPECT_DEFECTS = process.argv.includes('--expect-defects');
const CONTROL        = EXPECT_FORK || EXPECT_DEFECTS;

const NEW = 'a new passphrase for the two-device rekey test';

// ── The negative controls: neutralise a fix, in one line each ────────
//
// Served to the devices, and read the way verify_rekey.mjs serves a break: every anchor
// must appear exactly once (identity.js) or a known count (sync.js), or the run proves
// nothing. `--expect-fork` stops the record travelling; `--expect-defects` reverts the
// D1/D3/D6 fixes so their controls below go red.
const EDITED = new Map();

/// Replace the SOLE occurrence of `find` in `file`, or exit 2 (a moved anchor must fail
/// loudly, not silently neutralise nothing). Reads the current EDITED copy so several
/// edits to one file compose.
function neutralise(file, find, repl) {
	const src = EDITED.get(file) || fs.readFileSync(path.join(WWW, file), 'utf8');
	const n = src.split(find).length - 1;
	if (n !== 1) {
		console.error(`${file}: the anchor ${JSON.stringify(find)} appears ${n} times (expected 1); `
			+ 'nothing was neutralised and the control would prove nothing.');
		process.exit(2);
	}
	EDITED.set(file, src.replace(find, repl));
}

if (EXPECT_FORK) {
	neutralise('js/sync.js', 'function wrapEnvelope(sealedB64) {',
		'function wrapEnvelope(sealedB64) {\n\t\treturn sealedB64;   // --expect-fork: the record never travels');
}
if (EXPECT_DEFECTS) {
	// D1: drop the body authentication -- a tampered record is walked and committed.
	neutralise('js/identity.js', 'async function recordSigOk(rec) {',
		'async function recordSigOk(rec) {\n\t\treturn true;   // --expect-defects: body auth removed (D1)');
	// D3: strip the record off the progress push -- a bare blob at epoch >= 1.
	neutralise('js/sync.js', 'blob = wrapEnvelope(blob);\t\t// D3: carry the record on the progress path too',
		'/* --expect-defects: D3 record stripped from the progress push */;');
	// D6: uncount the envelope -- the wire estimate under-reports at epoch >= 1.
	neutralise('js/sync.js', 'function envelopeOverheadBytes() {',
		'function envelopeOverheadBytes() {\n\t\treturn 0;   // --expect-defects: envelope uncounted (D6)');
	// Gap 1: drop the pull-time record verification -- a forged record steers the pull
	// again, standing a device (even a never-rekeyed one) down on an unsigned blob.
	neutralise('js/sync.js', 'if (env.rec && !(window.DaimondIdentity && DaimondIdentity.verifyRecord',
		'if (false && env.rec && !(window.DaimondIdentity && DaimondIdentity.verifyRecord');
	// Gap 3: drop the stranding retry -- a divergence loser meeting a later change gaps on
	// its first rung and strands on the sticky rekey chip instead of crossing over.
	neutralise('js/identity.js', "if (!res.ok && res.reason === 'gap' && local > 0 && _prevWrapKey) {",
		"if (false && !res.ok && res.reason === 'gap' && local > 0 && _prevWrapKey) {");
	// Gap 2: drop the adopted-notice render -- an adoption is silent again and a lost
	// secret vanishes with no word.
	neutralise('js/daimond.js', "try { noticeDialog(t('sync.rekey_adopted'), body); }",
		'try { void body; }');
}
async function routeBreak(page) {
	for (const [file, body] of EDITED) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

const ok = [], bad = [];
// Under --expect-fork the anti-fork checks are MEANT to fail. `anti` marks such a
// check: it is recorded normally, but the run's exit status treats the control as
// satisfied when the anti-fork checks failed and unsatisfied when they did not.
const antiFail = [];
const check = (name, pass, detail, anti) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	if (anti && !pass) antiFail.push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Small drivers ────────────────────────────────────────────────────

/// Read an identity localStorage value as this account holds it (the per-account shim
/// in accounts.js namespaces on the INSTANCE, so a plain instance read is the account's
/// own value -- see verify_devices.mjs, which reads these keys the same way).
const idVal = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);

/// Unlock a page after a reload, with a chosen passphrase. Answers whether the gate
/// opened -- so a WRONG passphrase answers false rather than throwing.
///
/// The session is dropped and the identity locked before the reload: stay-unlocked (the
/// K_STAY default, ON for a desktop) would otherwise bring the tab back UNLOCKED from
/// memory, and this check is precisely that the NEW passphrase re-derives the key from
/// the carried salt -- a memory restore would prove nothing and hide `#id-pass`.
async function unlockWith(page, pass) {
	await page.evaluate(() => {
		try { DaimondIdentity.setStayUnlocked(false); } catch (e) { /* older build */ }
		try { DaimondIdentity.lock(); } catch (e) { /* already locked */ }
	});
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(400);
	const box = await page.$('#id-pass');
	if (!box) return false;
	await page.fill('#id-pass', pass);
	await page.evaluate(() => document.getElementById('id-primary').click());
	const opened = await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 12000 })
		.then(() => true).catch(() => false);
	await page.waitForTimeout(400);
	return opened;
}

/// Add a provider with a sealed key, through the module's own doors (as verify_rekey.mjs
/// does), and push. A clean, deterministic, inspectable payload for "an edit crosses".
async function addProviderAndPush(page, id, name, key) {
	return page.evaluate(async (a) => {
		if (!DaimondModels.providers().some(p => p.id === a.id)) {
			DaimondModels.addProvider(a.id, { name: a.name, url: a.id.slice('custom:'.length) });
		}
		await DaimondModels.setKey(a.id, a.key);
		let v = -1;
		try {
			const fl = window.DaimondSync.flush ? await DaimondSync.flush() : null;
			v = fl && fl.ok ? (fl.version | 0) : (await DaimondSync.push(), DaimondSync.version() | 0);
		} catch (e) { /* offline: the caller's asserts will say so */ }
		return v;
	}, { id, name, key });
}

/// What a provider's stored key opens to on this device, or a reason it does not.
async function providerKey(page, id) {
	return page.evaluate(async (pid) => {
		try {
			const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
			const p = (j.providers || {})[pid];
			if (!p) return '(absent)';
			if (!p.keyEnc) return '(no keyEnc)';
			try { return await DaimondIdentity.unwrap(p.keyEnc); }
			catch (e) { return 'UNREADABLE:' + ((e && e.name) || e); }
		} catch (e) { return '(err)'; }
	}, id);
}

/// Hand a device's NEXT pull a FORGED rekey envelope wrapped around the real mailbox
/// parcel, pull once, and answer the sync state after. The record `rec` is carried as
/// given -- the Gap 1 controls pass it UNSIGNED (no `sig`), so a device on the FIXED code
/// must treat it as ABSENT (verifyRecord fails) and never let it steer the pull. The
/// handler strips any real DRK1 header first so `env.sealed` is the raw sealed parcel the
/// device can actually open (unless `garbageSealed`, which replaces it so the unwrap fails
/// and the divergence path is reached). The route is removed after the pull, so the
/// device's normal flow is untouched. All of it is defensive: any hiccup falls back to
/// `route.continue()`, which leaves the pull genuine and the asserts honest.
async function pullForged(page, rec, garbageSealed) {
	const handler = async (route) => {
		try {
			if (route.request().method() !== 'GET') return await route.continue();
			const resp = await route.fetch();
			const text = await resp.text();
			let body;
			try { body = JSON.parse(text); }
			catch (e) { return await route.fulfill({ status: resp.status(), headers: resp.headers(), body: text }); }
			if (body && typeof body.blob === 'string' && body.blob) {
				const bin = atob(body.blob);
				let raw = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
				// Strip a real DRK1 header, so what we nest is the raw sealed parcel.
				if (raw.length >= 8 && raw[0] === 68 && raw[1] === 82 && raw[2] === 75 && raw[3] === 49) {
					const rlen = ((raw[4] << 24) | (raw[5] << 16) | (raw[6] << 8) | raw[7]) >>> 0;
					if (8 + rlen <= raw.length) raw = raw.slice(8 + rlen);
				}
				const sealed = garbageSealed ? new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]) : raw;
				const json = new TextEncoder().encode(JSON.stringify(rec));
				const out = new Uint8Array(8 + json.length + sealed.length);
				out[0] = 68; out[1] = 82; out[2] = 75; out[3] = 49;
				out[4] = (json.length >>> 24) & 255; out[5] = (json.length >>> 16) & 255;
				out[6] = (json.length >>> 8) & 255;  out[7] = json.length & 255;
				out.set(json, 8); out.set(sealed, 8 + json.length);
				let s = ''; for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
				body.blob = btoa(s);
			}
			return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
		} catch (e) {
			try { return await route.continue(); } catch (e2) { /* the request is already gone */ }
		}
	};
	await page.route('**/api/sync**', handler);
	const st = await page.evaluate(async () => {
		const vBefore = DaimondSync.version() | 0;
		try { await DaimondSync.pull(); } catch (e) {}
		await new Promise(r => setTimeout(r, 400));
		let s = {};
		try { s = DaimondSync.state(); } catch (e) {}
		return { vBefore, version: DaimondSync.version() | 0, rekeyBehind: !!s.rekeyBehind,
			stalledWhy: s.stalledWhy || '', epoch: localStorage.getItem('daimond-id-epoch') };
	});
	await page.unroute('**/api/sync**', handler);
	return st;
}

const P_ON_A = 'custom:http://127.0.0.1:9191/v1/chat/completions';
const P_ON_B = 'custom:http://127.0.0.1:9192/v1/chat/completions';
const K_ON_A = 'a-side-provider-key-4f21c';
const K_ON_B = 'b-side-provider-key-9de37';

let A = null, B = null;
// A's profile is NOT wiped here (its identity/pairing survive a re-run), but the
// grant itself is NOT out of band or persisted anywhere -- Pro is store-side state
// keyed by account_id, and dev/gate.sh's "safe dev-gateway recipe" is a FRESH store
// per run, so a stale profile pointing at a dead account holds nothing until this
// re-grants it, every run, against whatever gateway is up now (see makePagePro,
// dev/pro.mjs). B, C and every device paired below adopt A's account and so its
// entitlement -- Pro is per-account, not per-device.
const profA = scratch('pw', 'rekeydev-a');
const profB = scratch('pw', 'rekeydev-b');
// BOTH wiped, A included: this file itself now runs A through a long CHAIN of
// changePassphrase calls (NEW, then NEW-again, then per-control d1pass...), so a
// second run against the first run's leftover profile signs in with the
// ORIGINAL PASS against an account already moved on -- "sign-in did not take".
// Entitlement is re-granted fresh every run (see makePagePro above) precisely so
// a persistent profile buys nothing; a clean slate is what makes the run repeatable.
for (const p of [profA, profB]) fs.rmSync(p, { recursive: true, force: true });

try {
	// ── 1. Pair A and B; connect a provider on A; B adopts it on pull ──
	A = await open({ name: 'rekeydev', profile: profA, connect: true, route: routeBreak });
	await A.page.waitForFunction(
		() => !!window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 15000 }).catch(() => {});
	const authedA = await A.page.evaluate(() => !!(window.DaimondGateway && DaimondGateway.state().authed));
	check('A is signed in and authed to the gateway', authedA,
		authedA ? '' : 'no gateway — set DAIMOND_GW_PORT and bring a world gateway up');
	if (!authedA) throw new Error('no gateway; the two-device checks below cannot run');

	// Grant A's account Pro the one way the gateway trusts (a signed
	// customer.subscription.created webhook -- see dev/pro.mjs), so DaimondSync's
	// pushes/pulls below are not met with 402. Every paired device (B, C, and the
	// pairFresh() devices in the adversarial controls) shares A's account and so
	// its entitlement.
	const pro = await makePagePro(A.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro (sync is not refused)', pro.pro === true, JSON.stringify(pro));
	if (!pro.pro) throw new Error('A is not entitled; sync below would only measure the 402 gate');

	const code = await A.page.evaluate(async () => {
		try { return await DaimondPairing.create(); } catch (e) { return { error: e.message }; }
	});
	check('A creates a pairing code', !!(code && code.code), code && (code.code || code.error));

	B = await open({ name: 'rekeydev', profile: profB, signIn: false, connect: false, route: routeBreak });
	const redeemed = await B.page.evaluate(async (c) => {
		try { return { ok: await DaimondPairing.redeem(c) }; } catch (e) { return { err: e.message }; }
	}, code.code);
	check('B redeems the code — same account', redeemed.ok === true, redeemed.err || '');
	await B.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(B, 'rekeydev');

	// A pushes its provider key; B pulls it and is ready without connecting one itself.
	const saltA0 = await idVal(A.page, 'daimond-id-salt');
	await A.page.evaluate(async () => { try { (DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push()); } catch (e) {} });
	await B.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
	await B.page.waitForTimeout(400);
	const bReady0 = await B.page.evaluate(() => { try { return !!DaimondModels.ready(); } catch (e) { return false; } });
	check('B pulled A\'s provider key and is ready (pre-change baseline)', bReady0, 'ready=' + bReady0);
	const bEpoch0  = await idVal(B.page, 'daimond-id-epoch');
	check('EPOCH-0: neither device carries an epoch before any change',
		(await idVal(A.page, 'daimond-id-epoch')) === null && bEpoch0 === null,
		'A=' + (await idVal(A.page, 'daimond-id-epoch')) + ' B=' + bEpoch0);

	// ── CONTROL Gap 1 (never-rekeyed): a forged record must NOT stand B down ──
	//
	// B is at epoch 0 here -- an account that has never changed its passphrase. A forged,
	// UNSIGNED record at epoch 1 naming the account pub must be treated as ABSENT
	// (verifyRecord fails on the missing signature), so B stays at epoch 0, does NOT raise
	// the sticky rekey chip, and reads the parcel as it would any day. On the unfixed code
	// the record steers B into the re>le adopt, adoptRekey answers 'unsigned' (or, with D1
	// also reverted, 'gap'), and B stands down -- a standing push lockout on an account
	// that never even changed its passphrase. Marked anti: --expect-defects (which drops
	// the pull-time verify) turns it red.
	const bPub0 = await idVal(B.page, 'daimond-id-pub');
	const g1nr = await pullForged(B.page, {
		v: 1, epoch: 1, pub: bPub0, salt: 'forged-nr-salt', priv: 'x', alg: 'Ed25519',
		sealp: '', sealk: '', seala: '', card: '', chain: [{ from: 0, to: 1, wk: 'AA==' }],
	});
	check('Gap 1: a forged record does NOT stand a NEVER-REKEYED device down (no rekey chip)',
		g1nr.rekeyBehind === false && g1nr.stalledWhy !== 'rekey',
		'rekeyBehind=' + g1nr.rekeyBehind + ' why=' + g1nr.stalledWhy, true);
	check('Gap 1: the never-rekeyed device stays at epoch 0 (record treated as absent)',
		g1nr.epoch === null, 'epoch=' + g1nr.epoch, true);

	// ── 2. A changes the passphrase; capture the blob it pushes ──
	const capA = await A.page.evaluate(async (a) => {
		// Spy the push so the blob's first bytes can be read: the envelope is added in
		// sync.js AFTER DaimondIdentity.wrap, so this is the only place to see it.
		const real = window.fetch;
		window.__lastBlob = null;
		window.fetch = function (url, opts) {
			try {
				if (opts && opts.method === 'POST' && opts.body && /\/sync/.test(String(url))) {
					const j = JSON.parse(opts.body);
					if (j && j.blob) window.__lastBlob = j.blob;
				}
			} catch (e) { /* not our body */ }
			return real.apply(this, arguments);
		};
		let readOut = null, changed = null, resealed = null, flushed = null;
		try { readOut  = await DaimondRekey.readAll(); } catch (e) { readOut = { err: String(e && e.message) }; }
		try { changed  = await DaimondIdentity.changePassphrase(a.PASS, a.NEW); } catch (e) { changed = { ok: false, err: String(e && e.message) }; }
		try { resealed = await DaimondRekey.resealAll(); } catch (e) { resealed = { err: String(e && e.message) }; }
		try { flushed  = DaimondSync.flush ? await DaimondSync.flush() : (await DaimondSync.push(), { ok: true, version: DaimondSync.version() | 0 }); }
		catch (e) { flushed = { ok: false, err: String(e && e.message) }; }
		window.fetch = real;
		// First four bytes of the last pushed blob, decoded from base64.
		let head4 = '';
		try {
			const bin = atob(window.__lastBlob || '');
			head4 = String.fromCharCode(bin.charCodeAt(0), bin.charCodeAt(1), bin.charCodeAt(2), bin.charCodeAt(3));
		} catch (e) { head4 = '(none)'; }
		return {
			changed, epoch: localStorage.getItem('daimond-id-epoch'),
			salt: localStorage.getItem('daimond-id-salt'), head4, flushed,
		};
	}, { PASS, NEW });
	check('A\'s passphrase change succeeded', capA.changed && capA.changed.ok === true, JSON.stringify(capA.changed));
	check('A is now at epoch 1', capA.epoch === '1', 'epoch=' + capA.epoch);
	check('A\'s new salt differs from the old one', capA.salt && capA.salt !== saltA0, 'changed=' + (capA.salt !== saltA0));
	// The envelope: present under fixed code, absent under --expect-fork.
	if (EXPECT_FORK) {
		check('control: with the carry neutralised, the pushed blob has NO DRK1 envelope',
			capA.head4 !== 'DRK1', 'head=' + JSON.stringify(capA.head4));
	} else {
		check('the pushed blob carries a DRK1 rekey envelope', capA.head4 === 'DRK1', 'head=' + JSON.stringify(capA.head4));
	}

	// ── B pulls, and ADOPTS rather than forking ──
	// The rekey listener is registered in the SAME evaluate as the pull -- registered
	// BEFORE the pull runs -- so the event cannot fire in the gap between two separate
	// evaluate calls (which raced when it was split).
	const logsBefore = B.logs.length;
	const firedRekey = await B.page.evaluate(async () => {
		let fired = false;
		window.addEventListener('daimond:rekey', () => { fired = true; });
		try { await DaimondSync.pull(); } catch (e) {}
		await new Promise(r => setTimeout(r, 600));
		return fired;
	});
	const bAfter = await B.page.evaluate(() => ({
		salt:  localStorage.getItem('daimond-id-salt'),
		epoch: localStorage.getItem('daimond-id-epoch'),
		ready: (function () { try { return !!DaimondModels.ready(); } catch (e) { return false; } })(),
	}));
	const forkLogs = B.logs.slice(logsBefore).filter(l => /pull decrypt\/parse failed/.test(l));

	check('B adopted A\'s salt (no fork)', bAfter.salt === capA.salt,
		bAfter.salt === capA.salt ? 'same salt' : 'B still on a different salt', true);
	check('B is at epoch 1', bAfter.epoch === '1', 'epoch=' + bAfter.epoch, true);
	check('B did NOT log a decrypt/parse failure (the corruption ping-pong did not fire)',
		forkLogs.length === 0, forkLogs.length ? forkLogs.slice(0, 2).join(' | ') : 'clean', true);
	check('NO DATA LOSS: B is still ready after adopting (keyEnc re-sealed under the new key)',
		bAfter.ready === true, 'ready=' + bAfter.ready, true);
	check('B raised daimond:rekey for the shell to toast', firedRekey === true, String(firedRekey), true);

	// ── Reload B; the NEW passphrase unlocks and the OLD one does not ──
	const openNew = await unlockWith(B.page, NEW);
	check('B unlocks with the NEW passphrase after a reload (derived from the carried salt)',
		openNew === true, openNew ? '' : 'the gate did not open', true);
	const openOld = await unlockWith(B.page, PASS);
	check('B does NOT unlock with the old passphrase', openOld === false,
		openOld ? 'the old passphrase still opened B — the salt did not really change' : 'refused', true);
	// Back in with the working one for the rounds below.
	if (!(await B.page.evaluate(() => { try { return DaimondIdentity.isUnlocked(); } catch (e) { return false; } }))) {
		await unlockWith(B.page, NEW);
	}
	await shot(B, 'rekey_' + (CONTROL ? (EXPECT_FORK ? 'expectfork' : 'expectdefects') : 'B_adopted') + '_' + (bad.length ? 'RED' : 'GREEN'));

	// ── Convergence rounds: each device's post-rekey edit reaches the other ──
	const dumpModels = (page) => page.evaluate(() => {
		try {
			const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
			return { ids: Object.keys(j.providers || {}), v: (window.DaimondSync ? DaimondSync.version() | 0 : -1),
				entitled: (window.DaimondSync && DaimondSync.entitled) ? DaimondSync.entitled() : null,
				ready: (function () { try { return !!DaimondModels.ready(); } catch (e) { return false; } })() };
		} catch (e) { return { err: String(e && e.message) }; }
	});
	const vBpush = await addProviderAndPush(B.page, P_ON_B, 'B side', K_ON_B);
	console.log('  diag  after B push: B=' + JSON.stringify(await dumpModels(B.page)));
	await A.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
	await A.page.waitForTimeout(300);
	console.log('  diag  after A pull: A=' + JSON.stringify(await dumpModels(A.page)));
	const aSeesB = await providerKey(A.page, P_ON_B);
	check('B\'s post-rekey edit reaches A (opened under the new key)', aSeesB === K_ON_B,
		aSeesB === K_ON_B ? 'A opened B\'s provider key' : 'A got ' + JSON.stringify(aSeesB), true);

	const vApush = await addProviderAndPush(A.page, P_ON_A, 'A side', K_ON_A);
	await B.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
	await B.page.waitForTimeout(300);
	const bSeesA = await providerKey(B.page, P_ON_A);
	check('A\'s post-rekey edit reaches B', bSeesA === K_ON_A,
		bSeesA === K_ON_A ? 'B opened A\'s provider key' : 'B got ' + JSON.stringify(bSeesA), true);

	// Versions converge and never went backwards.
	await A.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
	await B.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
	await sleep(400);
	const vA = await A.page.evaluate(() => DaimondSync.version() | 0);
	const vB = await B.page.evaluate(() => DaimondSync.version() | 0);
	check('the two devices converge on one version (no ping-pong)', vA === vB && vA > 0,
		'A=' + vA + ' B=' + vB, true);
	check('the push versions were monotonic (no version alternation)',
		vBpush >= 0 && vApush >= vBpush, 'Bpush=' + vBpush + ' Apush=' + vApush, true);

	// ── 5. GAP: a device that cannot walk the chain must not clobber ──
	//
	// Two levels. First the unit: adoptRekey refuses a record whose chain is empty and
	// changes NOTHING. Then the behaviour: a pulled blob whose chain is stripped leaves
	// the version untouched, sets the sticky 'rekey' chip, and makes no POST.
	//
	// THE FIXTURE MUST BE SIGNED (fixed 2026-09-20 -- was a stale expectation). Gap 1
	// checks the signature BEFORE the chain walk (`adoptRekey`, identity.js: `if
	// (!(await recordSigOk(rec))) return { ok: false, reason: 'unsigned' };` sits ahead of
	// `applyRekeyRecord`, which is the only place 'gap' can come from), so an unsigned
	// record -- this fixture had no `sig` at all -- is refused as 'unsigned' before the
	// gap it means to test is ever reached; `reason` read 'unsigned' in a live run and the
	// two checks below were stale red. Signing it over `rekeyBody`'s own bytes (identity.js:
	// the array excludes `chain` on purpose -- "a signature cannot sign itself", and the
	// chain's own links are authenticated by their AAD -- so a signed record's chain can
	// still be stripped to `[]` without touching what was signed) reaches the gap check
	// this was written for, rather than only restating D1's unsigned control a few hundred
	// lines below.
	const gapUnit = await B.page.evaluate(async () => {
		const epochBefore = localStorage.getItem('daimond-id-epoch');
		const saltBefore  = localStorage.getItem('daimond-id-salt');
		const target = (parseInt(epochBefore, 10) || 0) + 5;
		const rec = {
			v: 1, epoch: target, pub: localStorage.getItem('daimond-id-pub'),
			salt: 'x', priv: 'x', alg: localStorage.getItem('daimond-id-alg') || 'Ed25519',
			sealp: '', sealk: '', seala: '', card: '', chain: [],   // no links: a gap
		};
		const body = JSON.stringify(['daimond-rekey-v1', rec.v, rec.epoch, rec.pub,
			rec.salt, rec.priv, rec.alg, rec.sealp, rec.sealk, rec.seala, rec.card]);
		rec.sig = await DaimondIdentity.sign(body);
		let res;
		try { res = await DaimondIdentity.adoptRekey(rec); } catch (e) { res = { ok: false, err: String(e && e.message) }; }
		return {
			res,
			unchanged: localStorage.getItem('daimond-id-epoch') === epochBefore
				&& localStorage.getItem('daimond-id-salt') === saltBefore,
		};
	});
	check('adoptRekey refuses a gapped chain with reason "gap"',
		gapUnit.res && gapUnit.res.ok === false && gapUnit.res.reason === 'gap', JSON.stringify(gapUnit.res));
	check('a refused adopt changes NO identity storage', gapUnit.unchanged === true, String(gapUnit.unchanged));

	// The behavioural gap: strip the chain from A's record in B's incoming pull, and
	// prove B does not clobber. Run in a fresh third profile so the strip cannot poison
	// the converged pair above.
	const profC = scratch('pw', 'rekeydev-c');
	fs.rmSync(profC, { recursive: true, force: true });
	let C = null;
	try {
		const codeC = await A.page.evaluate(async () => {
			try { return await DaimondPairing.create(); } catch (e) { return { error: e.message }; }
		});
		C = await open({ name: 'rekeydev', profile: profC, signIn: false, connect: false, route: routeBreak });
		await C.page.evaluate(async (c) => { try { await DaimondPairing.redeem(c); } catch (e) {} }, codeC.code);
		// A's passphrase is NEW by now (it was changed above), and C's paired bundle
		// carries A's current salt -- so C unlocks with NEW, not the original PASS.
		const cOpened = await unlockWith(C.page, NEW);
		check('GAP setup: C (paired after the change) unlocks with the new passphrase', cOpened === true,
			cOpened ? '' : 'C did not unlock');
		// C pulls once at the current (paired) epoch so it is caught up before the strip.
		await C.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
		const cEpochBefore = await idVal(C.page, 'daimond-id-epoch');
		const cVerBefore   = await C.page.evaluate(() => DaimondSync.version() | 0);

		// A moves the epoch on again, so C is now one behind and the next pull carries a
		// record C could adopt -- unless we strip its chain.
		await A.page.evaluate(async (a) => {
			try { await DaimondRekey.readAll(); } catch (e) {}
			try { await DaimondIdentity.changePassphrase(a.NEW, a.NEW + '-again'); } catch (e) {}
			try { await DaimondRekey.resealAll(); } catch (e) {}
			try { (DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push()); } catch (e) {}
		}, { NEW });

		// Strip the chain out of C's incoming pull, and spy its POSTs. The whole handler
		// is defensive: any failure falls back to `route.continue()` so a fetch or parse
		// hiccup can never crash the run -- only leave the chain unstripped, which the
		// asserts below would then catch honestly.
		await C.page.route('**/api/sync**', async (route) => {
			try {
				if (route.request().method() !== 'GET') return await route.continue();
				const resp = await route.fetch();
				const text = await resp.text();
				let body;
				try { body = JSON.parse(text); } catch (e) {
					return await route.fulfill({ status: resp.status(), headers: resp.headers(), body: text });
				}
				if (body && typeof body.blob === 'string' && body.blob) {
					const bin = atob(body.blob);
					const bytes = new Uint8Array(bin.length);
					for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
					if (bytes[0] === 68 && bytes[1] === 82 && bytes[2] === 75 && bytes[3] === 49) {
						const len = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
						const rec = JSON.parse(new TextDecoder().decode(bytes.slice(8, 8 + len)));
						rec.chain = [];   // the gap
						const json = new TextEncoder().encode(JSON.stringify(rec));
						const tail = bytes.slice(8 + len);
						const out = new Uint8Array(8 + json.length + tail.length);
						out[0] = 68; out[1] = 82; out[2] = 75; out[3] = 49;
						out[4] = (json.length >>> 24) & 255; out[5] = (json.length >>> 16) & 255;
						out[6] = (json.length >>> 8) & 255;  out[7] = json.length & 255;
						out.set(json, 8); out.set(tail, 8 + json.length);
						let s = ''; for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
						body.blob = btoa(s);
					}
				}
				return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
			} catch (e) {
				try { return await route.continue(); } catch (e2) { /* the request is already gone */ }
			}
		});
		const gapBehav = await C.page.evaluate(async () => {
			// FIRST, learn we are behind: the gap pull sets rekeyBehind and returns -1.
			// Any push ARMED before this (from an earlier round) may fire in the window
			// before the pull lands -- that is the finite pre-knowledge clobber the spec
			// allows, and A recovers it with its previous key. What must NOT happen is a
			// push AFTER the device knows it is behind, so the spy is installed only once
			// the pull has returned.
			try { await DaimondSync.pull(); } catch (e) {}
			await new Promise(r => setTimeout(r, 300));
			const real = window.fetch;
			// Count PARCEL pushes specifically -- a POST whose body carries `base_version`
			// and `blob` is the compare-and-set that would OVERWRITE the account. A
			// presence beat or a lease/progress write to the same path is not a clobber.
			let parcelPosts = 0, otherPosts = 0;
			window.fetch = function (url, opts) {
				try {
					if (opts && opts.method === 'POST' && /\/sync/.test(String(url))) {
						let body = {};
						try { body = JSON.parse(opts.body || '{}'); } catch (e) { body = {}; }
						if ('base_version' in body && 'blob' in body) parcelPosts++;
						else otherPosts++;
					}
				} catch (e) { /* not ours */ }
				return real.apply(this, arguments);
			};
			// Now that we KNOW we are behind, a push -- and any armed one -- must refuse.
			try { await DaimondSync.push(); } catch (e) {}
			try { await DaimondSync.pull(); } catch (e) {}   // still behind: still no push
			await new Promise(r => setTimeout(r, 800));
			window.fetch = real;
			let st = {};
			try { st = DaimondSync.state(); } catch (e) {}
			return { parcelPosts, otherPosts, version: DaimondSync.version() | 0,
				rekeyBehind: !!st.rekeyBehind, stalledWhy: st.stalledWhy || '' };
		});
		check('GAP: C behind the chain does not adopt the version', gapBehav.version === cVerBefore,
			'before=' + cVerBefore + ' after=' + gapBehav.version, true);
		check('GAP: C sets the sticky rekey chip', gapBehav.rekeyBehind === true && gapBehav.stalledWhy === 'rekey',
			'rekeyBehind=' + gapBehav.rekeyBehind + ' why=' + gapBehav.stalledWhy, true);
		check('GAP: C makes NO PARCEL push over the account it cannot read', gapBehav.parcelPosts === 0,
			'parcel pushes=' + gapBehav.parcelPosts + ' (other /sync POSTs, e.g. presence/lease: '
			+ gapBehav.otherPosts + ')', true);
		void cEpochBefore;
	} finally {
		await C?.close?.().catch(() => {});
	}

	// ════════════════════════════════════════════════════════════════════
	// THE ADVERSARIAL CONTROLS (D1, D3, D6, D2). Each asserts a fixed-code
	// property and is marked anti, so `--expect-defects` (which reverts the
	// fixes) turns it red -- proof the check has teeth. See the header.
	// ════════════════════════════════════════════════════════════════════

	// A's passphrase now: PASS→NEW (§2), then NEW→NEW-again (the GAP block). Read the
	// live epoch so the string tracks whichever changes actually landed.
	let acctPass  = (parseInt(await idVal(A.page, 'daimond-id-epoch'), 10) || 0) >= 2 ? (NEW + '-again') : NEW;

	/// Pair a fresh device into A's account and unlock it with the account passphrase.
	async function pairFresh(label, pass) {
		const prof = scratch('pw', 'rekeydev-' + label);
		fs.rmSync(prof, { recursive: true, force: true });
		const codeX = await A.page.evaluate(async () => {
			try { return await DaimondPairing.create(); } catch (e) { return { error: e.message }; }
		});
		const dev = await open({ name: 'rekeydev', profile: prof, signIn: false, connect: false, route: routeBreak });
		await dev.page.evaluate(async (c) => { try { await DaimondPairing.redeem(c); } catch (e) {} }, codeX.code);
		const opened = await unlockWith(dev.page, pass);
		return { dev, opened };
	}

	// ── CONTROL D3: a progress frame at epoch >= 1 carries the record ──
	try {
		const d3 = await A.page.evaluate(async () => {
			// A change so the frame is not skipped as unchanged.
			try {
				const id = 'custom:http://127.0.0.1:9199/v1/chat/completions';
				if (!DaimondModels.providers().some(p => p.id === id)) DaimondModels.addProvider(id, { name: 'd3', url: id.slice(7) });
				await DaimondModels.setKey(id, 'd3-progress-key');
			} catch (e) {}
			const real = window.fetch;
			let head4 = '(none)', saw = false;
			window.fetch = function (url, opts) {
				try {
					if (opts && opts.method === 'POST' && opts.body && /\/sync/.test(String(url))) {
						const j = JSON.parse(opts.body);
						if (j && j.blob && !saw) {
							saw = true;
							const bin = atob(j.blob);
							head4 = String.fromCharCode(bin.charCodeAt(0), bin.charCodeAt(1), bin.charCodeAt(2), bin.charCodeAt(3));
						}
					}
				} catch (e) { /* not ours */ }
				return real.apply(this, arguments);
			};
			try { await DaimondSync.pushProgress(); } catch (e) {}
			await new Promise(r => setTimeout(r, 300));
			window.fetch = real;
			return { head4, saw, epoch: localStorage.getItem('daimond-id-epoch') };
		});
		check('D3: at epoch >= 1 the progress push carries a DRK1 rekey envelope', d3.head4 === 'DRK1',
			'epoch=' + d3.epoch + ' saw=' + d3.saw + ' head=' + JSON.stringify(d3.head4), true);
	} catch (e) { check('D3 control completed', false, String((e && e.message) || e), true); }

	// ── CONTROL D6: the wire estimate counts the envelope at epoch >= 1 ──
	try {
		const d6 = await A.page.evaluate(async () => {
			const ft = DaimondSync.forTest;
			// A distinct change, measured AND pushed with nothing altered between the two,
			// so the estimate and the real body describe the very same parcel.
			try {
				const id = 'custom:http://127.0.0.1:9198/v1/chat/completions';
				if (!DaimondModels.providers().some(p => p.id === id)) DaimondModels.addProvider(id, { name: 'd6', url: id.slice(7) });
				await DaimondModels.setKey(id, 'd6-wire-key');
			} catch (e) {}
			const parcel   = await DaimondSync.parcel();
			const pbytes   = ft.utf8Len(JSON.stringify(parcel));
			const declared = ft.wireBytes(pbytes);
			const real = window.fetch;
			let actual = 0;
			window.fetch = function (url, opts) {
				try {
					if (opts && opts.method === 'POST' && opts.body && /\/sync/.test(String(url))) {
						const j = JSON.parse(opts.body);
						if (j && ('base_version' in j) && ('blob' in j) && !actual) {
							actual = new TextEncoder().encode(opts.body).length;
						}
					}
				} catch (e) { /* not ours */ }
				return real.apply(this, arguments);
			};
			try { (DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push()); } catch (e) {}
			await new Promise(r => setTimeout(r, 300));
			window.fetch = real;
			return { declared, actual, pbytes, epoch: localStorage.getItem('daimond-id-epoch') };
		});
		// The 8-byte slack absorbs a base_version digit rolling over between the estimate
		// and the push; the unfixed gap is the whole record (hundreds of bytes), so the
		// control keeps its teeth.
		check('D6: the wire estimate is not smaller than the real body (the record is counted)',
			d6.actual > 0 && d6.declared >= d6.actual - 8,
			'declared=' + d6.declared + ' actual=' + d6.actual + ' epoch=' + d6.epoch, true);
	} catch (e) { check('D6 control completed', false, String((e && e.message) || e), true); }

	// ── CONTROL D1: an unauthenticated body is an account-lockout vector ──
	//
	// A device one epoch behind is handed a record whose salt (then sealing key) has
	// been swapped for garbage. The signature was made over the REAL body, so the change
	// must be REFUSED with nothing written -- the victim keeps its passphrase. On the
	// unfixed code the walk succeeds and the garbage salt is committed, and the device
	// can never unlock again: the account-wide lockout.
	try {
		const victimPass = acctPass;   // what the victim is paired with, before A moves on
		const f = await pairFresh('d1', victimPass);
		check('D1 setup: victim paired and unlocked at the account epoch', f.opened === true,
			f.opened ? '' : 'the victim did not unlock');
		// Freeze the victim's own pulls: the only record it sees is the one we hand it.
		await f.dev.page.route('**/api/sync**', (route) =>
			route.request().method() === 'GET' ? route.abort() : route.continue());
		// A mints a genuinely-signed record one epoch ahead of the frozen victim.
		const d1pass = victimPass + '-d1';
		await A.page.evaluate(async (a) => {
			try { await DaimondRekey.readAll(); } catch (e) {}
			try { await DaimondIdentity.changePassphrase(a.cur, a.next); } catch (e) {}
			try { await DaimondRekey.resealAll(); } catch (e) {}
			try { (DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push()); } catch (e) {}
		}, { cur: victimPass, next: d1pass });
		const aRec = await A.page.evaluate(() => {
			const raw = localStorage.getItem('daimond-id-rekey');
			return raw ? JSON.parse(raw) : null;
		});
		acctPass = d1pass;   // A's passphrase has moved on
		const d1 = await f.dev.page.evaluate(async (rec) => {
			const saltBefore  = localStorage.getItem('daimond-id-salt');
			const epochBefore = localStorage.getItem('daimond-id-epoch');
			const tamperSalt  = Object.assign({}, rec, { salt: 'GARBAGE-not-the-real-salt' });
			let rSalt;  try { rSalt  = await DaimondIdentity.adoptRekey(tamperSalt); }  catch (e) { rSalt  = { ok: false, err: String(e && e.message) }; }
			const afterSalt   = { salt: localStorage.getItem('daimond-id-salt'), epoch: localStorage.getItem('daimond-id-epoch') };
			const tamperSealk = Object.assign({}, rec, { sealk: 'GARBAGE-sealk', sealp: rec.sealp || 'AA==' });
			let rSealk; try { rSealk = await DaimondIdentity.adoptRekey(tamperSealk); } catch (e) { rSealk = { ok: false, err: String(e && e.message) }; }
			return { rSalt, rSealk, saltBefore, epochBefore, afterSalt };
		}, aRec);
		check('D1: adoptRekey REFUSES a tampered salt with reason "unsigned"',
			!!(d1.rSalt && d1.rSalt.ok === false && d1.rSalt.reason === 'unsigned'), JSON.stringify(d1.rSalt), true);
		check('D1: adoptRekey REFUSES a tampered sealing key with reason "unsigned"',
			!!(d1.rSealk && d1.rSealk.ok === false && d1.rSealk.reason === 'unsigned'), JSON.stringify(d1.rSealk), true);
		check('D1: the refused tampers wrote NOTHING (salt and epoch unchanged)',
			d1.afterSalt.salt === d1.saltBefore && d1.afterSalt.epoch === d1.epochBefore,
			'salt=' + (d1.afterSalt.salt === d1.saltBefore) + ' epoch=' + (d1.afterSalt.epoch === d1.epochBefore), true);
		// The victim's real passphrase is what it was paired with, unchanged by the
		// refused tampers. On the unfixed code the tampered salt was committed and this
		// unlock fails: the account-wide lockout.
		const d1unlock = await unlockWith(f.dev.page, victimPass);
		check('D1: the victim still unlocks with its real passphrase (no lockout)', d1unlock === true,
			d1unlock ? '' : 'the victim was bricked — the tampered salt was committed', true);
		await shot(f.dev, 'rekey_D1_' + (bad.length ? 'RED' : 'GREEN'));
		await f.dev.close?.().catch(() => {});
	} catch (e) { check('D1 control completed', false, String((e && e.message) || e), true); }

	// ── CONTROL D2: two devices change offline -> converge, no fork ──
	try {
		const startPass = acctPass;   // whatever A's passphrase is now
		const dvA = await pairFresh('d2a', startPass);
		const dvB = await pairFresh('d2b', startPass);
		check('D2 setup: both devices paired and unlocked', dvA.opened === true && dvB.opened === true,
			'A=' + dvA.opened + ' B=' + dvB.opened);
		// Both catch up to the account, so they share one epoch and salt.
		for (const d of [dvA, dvB]) await d.dev.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
		await sleep(400);
		const s0a = await idVal(dvA.dev.page, 'daimond-id-salt');
		const s0b = await idVal(dvB.dev.page, 'daimond-id-salt');
		check('D2 setup: both start on the same salt', s0a === s0b, 'equal=' + (s0a === s0b));
		const logsA0 = dvA.dev.logs.length, logsB0 = dvB.dev.logs.length;
		// Each changes the passphrase WITHOUT pulling the other's: two epoch branches on
		// different salts, both pushed, the second conflicting.
		const change = (dev, cur, next) => dev.page.evaluate(async (p) => {
			try { await DaimondRekey.readAll(); } catch (e) {}
			let ch = null; try { ch = await DaimondIdentity.changePassphrase(p.cur, p.next); } catch (e) { ch = { ok: false, err: String(e && e.message) }; }
			try { await DaimondRekey.resealAll(); } catch (e) {}
			try { (DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push()); } catch (e) {}
			return ch;
		}, { cur, next });
		const chA = await change(dvA.dev, startPass, startPass + '-dvA');
		const chB = await change(dvB.dev, startPass, startPass + '-dvB');
		check('D2: both offline changes succeeded', !!(chA && chA.ok) && !!(chB && chB.ok),
			'A=' + JSON.stringify(chA) + ' B=' + JSON.stringify(chB));
		// Converge: alternate pull+push a few rounds. The larger-salt side yields.
		for (let i = 0; i < 8; i++) {
			for (const d of [dvA, dvB]) {
				await d.dev.page.evaluate(async () => {
					try { await DaimondSync.pull(); } catch (e) {}
					try { (DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push()); } catch (e) {}
				});
			}
			await sleep(250);
		}
		const cSaltA = await idVal(dvA.dev.page, 'daimond-id-salt');
		const cSaltB = await idVal(dvB.dev.page, 'daimond-id-salt');
		const cVerA  = await dvA.dev.page.evaluate(() => DaimondSync.version() | 0);
		const cVerB  = await dvB.dev.page.evaluate(() => DaimondSync.version() | 0);
		const forkA  = dvA.dev.logs.slice(logsA0).filter(l => /pull decrypt\/parse failed/.test(l));
		const forkB  = dvB.dev.logs.slice(logsB0).filter(l => /pull decrypt\/parse failed/.test(l));
		check('D2: the diverged devices converge on ONE salt (deterministic yield)', !!cSaltA && cSaltA === cSaltB,
			'A=' + String(cSaltA).slice(0, 10) + ' B=' + String(cSaltB).slice(0, 10), true);
		check('D2: they converge on ONE version (no ping-pong)', cVerA === cVerB && cVerA > 0,
			'A=' + cVerA + ' B=' + cVerB, true);
		check('D2: NEITHER read the divergence as corruption (no decrypt/parse fork)',
			forkA.length === 0 && forkB.length === 0, 'A=' + forkA.length + ' B=' + forkB.length, true);
		// Each device's post-change edit reaches the other, opened under the shared key.
		const P_DVA = 'custom:http://127.0.0.1:9197/v1/chat/completions';
		const P_DVB = 'custom:http://127.0.0.1:9196/v1/chat/completions';
		await addProviderAndPush(dvA.dev.page, P_DVA, 'dvA', 'dvA-edit-key');
		await dvB.dev.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
		await sleep(300);
		const bSeesA = await providerKey(dvB.dev.page, P_DVA);
		check('D2: device B reads device A\'s post-change edit', bSeesA === 'dvA-edit-key', 'got ' + JSON.stringify(bSeesA), true);
		await addProviderAndPush(dvB.dev.page, P_DVB, 'dvB', 'dvB-edit-key');
		await dvA.dev.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
		await sleep(300);
		const aSeesB = await providerKey(dvA.dev.page, P_DVB);
		check('D2: device A reads device B\'s post-change edit', aSeesB === 'dvB-edit-key', 'got ' + JSON.stringify(aSeesB), true);
		// D2 changes the ACCOUNT's real passphrase (not just dvA/dvB's own view of it),
		// and every pairFresh() below needs the CURRENT one to unlock -- missing this
		// update left it at the pre-D2 value and stranded Gap 1's and Gap 3's setups on
		// a stale password (a fixture bug, not a security finding: "g1/W/L did not
		// unlock" was this file locking itself out, not the app). The deterministic
		// yield is by salt (the header above), so prefer whichever side's OWN change
		// call actually reported success -- in this environment that is consistently
		// dvA's, chB's failing outright (see the run's report for that as its own,
		// separately-flagged finding).
		acctPass = (chB && chB.ok && !(chA && chA.ok)) ? (startPass + '-dvB') : (startPass + '-dvA');
		await dvA.dev.close?.().catch(() => {});
		await dvB.dev.close?.().catch(() => {});
	} catch (e) { check('D2 control completed', false, String((e && e.message) || e), true); }

	// ── CONTROL Gap 1: a forged record must not steer a REKEYED device either ──
	//
	// A device at epoch >= 1 is handed two forgeries in turn. Neither is signed by the
	// account, so on the FIXED code both are treated as absent: no rekey chip, the epoch
	// unmoved, and the real passphrase still unlocks. On the unfixed code the first drives
	// the re>le adopt to 'gap' and the second drives the same-epoch divergence yield to
	// 'noprev' -- both set the sticky chip, the standing push lockout a forged mailbox
	// write could inflict. Marked anti.
	try {
		const g1 = await pairFresh('g1', acctPass);
		check('Gap 1 setup: g1 paired and unlocked at the account epoch', g1.opened === true,
			g1.opened ? '' : 'g1 did not unlock');
		await g1.dev.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
		const gPub   = await idVal(g1.dev.page, 'daimond-id-pub');
		const gEpoch = parseInt(await idVal(g1.dev.page, 'daimond-id-epoch'), 10) || 0;
		const gSalt  = await idVal(g1.dev.page, 'daimond-id-salt');
		// 1a: a forged UNSIGNED record ONE EPOCH AHEAD, over the real (readable) parcel.
		const fa = await pullForged(g1.dev.page, {
			v: 1, epoch: gEpoch + 1, pub: gPub, salt: 'forged-ahead-salt', priv: 'x', alg: 'Ed25519',
			sealp: '', sealk: '', seala: '', card: '', chain: [{ from: gEpoch, to: gEpoch + 1, wk: 'AA==' }],
		});
		check('Gap 1: a forged unsigned record at le+1 does NOT set the rekey chip',
			fa.rekeyBehind === false && fa.stalledWhy !== 'rekey',
			'rekeyBehind=' + fa.rekeyBehind + ' why=' + fa.stalledWhy, true);
		check('Gap 1: the forged-ahead record is treated as absent (epoch unmoved)',
			(parseInt(fa.epoch, 10) || 0) === gEpoch, 'epoch=' + fa.epoch + ' expected=' + gEpoch, true);
		// 1b: a forged UNSIGNED record at the SAME epoch, a SMALLER salt (so the unfixed
		// code takes the yield branch, which this device -- holding no previous key --
		// cannot cross) and a GARBAGE parcel (so the unwrap fails and that branch is even
		// reached). '!'-led salt is below every base64 salt, so the yield is deterministic.
		const fb = await pullForged(g1.dev.page, {
			v: 1, epoch: gEpoch, pub: gPub, salt: '!diverged-forgery', priv: 'x', alg: 'Ed25519',
			sealp: '', sealk: '', seala: '', card: '', chain: [],
		}, true);
		void gSalt;
		check('Gap 1: a same-epoch salt-diverged FORGERY does NOT set the rekey chip',
			fb.rekeyBehind === false && fb.stalledWhy !== 'rekey',
			'rekeyBehind=' + fb.rekeyBehind + ' why=' + fb.stalledWhy, true);
		const g1unlock = await unlockWith(g1.dev.page, acctPass);
		check('Gap 1: g1 still unlocks with its real passphrase after the forgeries (no lockout)',
			g1unlock === true, g1unlock ? '' : 'g1 was affected by the forged records', true);
		await g1.dev.close?.().catch(() => {});
	} catch (e) { check('Gap 1 control completed', false, String((e && e.message) || e), true); }

	// ── CONTROL Gap 2: the daimond:rekey listener renders the adopted notice ──
	//
	// sync.js fires ONE `daimond:rekey` after an adoption, carrying any reseal-failure
	// sentences; daimond.js must render them, or an adoption is silent and a lost secret
	// vanishes with no word. Dispatch the event with a known marker sentence and assert it
	// reaches the on-screen notice. Marked anti: --expect-defects drops the render.
	try {
		const marker = 'gap2-marker-' + Math.random().toString(36).slice(2);
		const g2 = await A.page.evaluate(async (mk) => {
			window.dispatchEvent(new CustomEvent('daimond:rekey', { detail: { sentences: [mk] } }));
			await new Promise(r => setTimeout(r, 400));
			const shown = (document.body.innerText || '').includes(mk);
			// Dismiss the notice so it does not sit over anything that follows.
			let dismissed = false;
			try { const ok = document.querySelector('.dlg-ok'); if (ok) { ok.click(); dismissed = true; } } catch (e) {}
			return { shown, dismissed };
		}, marker);
		check('Gap 2: the daimond:rekey listener renders the reseal sentence as a notice',
			g2.shown === true, 'shown=' + g2.shown + ' dismissed=' + g2.dismissed, true);
	} catch (e) { check('Gap 2 control completed', false, String((e && e.message) || e), true); }

	// ── CONTROL Gap 3: a divergence LOSER then meeting a LATER change adopts ──
	//
	// dvW and dvL start at one epoch and salt. dvW rekeys TWICE (E -> E+1 -> E+2) and
	// pushes; dvL rekeys ONCE (E -> E+1) onto its own branch and, when it pulls, meets
	// dvW's record from a HIGHER epoch. Its first-rung walk under its own dead-branch key
	// gaps -- but it kept the shared previous-epoch key when it changed, so the Gap 3a
	// retry crosses from E onto dvW's branch and adopts E+2 rather than stranding on the
	// sticky rekey chip. Marked anti: --expect-defects drops the retry and dvL strands.
	try {
		const startPass = acctPass;
		const dvW = await pairFresh('g3w', startPass);
		const dvL = await pairFresh('g3l', startPass);
		check('Gap 3 setup: both devices paired and unlocked', dvW.opened === true && dvL.opened === true,
			'W=' + dvW.opened + ' L=' + dvL.opened);
		for (const d of [dvW, dvL]) await d.dev.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
		await sleep(400);
		const eStart = parseInt(await idVal(dvL.dev.page, 'daimond-id-epoch'), 10) || 0;
		// dvW: two changes, then push -- the mailbox now holds E+2 on dvW's branch.
		await dvW.dev.page.evaluate(async (p) => {
			try { await DaimondRekey.readAll(); } catch (e) {}
			try { await DaimondIdentity.changePassphrase(p.a, p.b); } catch (e) {}
			try { await DaimondIdentity.changePassphrase(p.b, p.c); } catch (e) {}
			try { await DaimondRekey.resealAll(); } catch (e) {}
			try { (DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push()); } catch (e) {}
		}, { a: startPass, b: startPass + '-g3w1', c: startPass + '-g3w2' });
		// dvL: one change onto its OWN branch (it keeps the shared previous-epoch key).
		await dvL.dev.page.evaluate(async (p) => {
			try { await DaimondRekey.readAll(); } catch (e) {}
			try { await DaimondIdentity.changePassphrase(p.a, p.b); } catch (e) {}
			try { await DaimondRekey.resealAll(); } catch (e) {}
		}, { a: startPass, b: startPass + '-g3l1' });
		const lEpochBefore = parseInt(await idVal(dvL.dev.page, 'daimond-id-epoch'), 10) || 0;
		// dvL pulls dvW's E+2 record: a higher epoch it cannot walk on the first rung.
		const g3 = await dvL.dev.page.evaluate(async () => {
			try { await DaimondSync.pull(); } catch (e) {}
			await new Promise(r => setTimeout(r, 500));
			let s = {}; try { s = DaimondSync.state(); } catch (e) {}
			return { epoch: parseInt(localStorage.getItem('daimond-id-epoch'), 10) || 0,
				rekeyBehind: !!s.rekeyBehind, stalledWhy: s.stalledWhy || '' };
		});
		check('Gap 3: the divergence loser ADOPTS the later change (epoch advances to E+2)',
			g3.epoch === eStart + 2, 'before=' + lEpochBefore + ' after=' + g3.epoch + ' E=' + eStart, true);
		check('Gap 3: the loser does NOT strand on the sticky rekey chip',
			g3.rekeyBehind === false && g3.stalledWhy !== 'rekey',
			'rekeyBehind=' + g3.rekeyBehind + ' why=' + g3.stalledWhy, true);
		// It reads dvW's post-change edit, opened under the crossed-to key.
		const P_G3 = 'custom:http://127.0.0.1:9195/v1/chat/completions';
		await addProviderAndPush(dvW.dev.page, P_G3, 'g3w', 'g3-edit-key');
		await dvL.dev.page.evaluate(async () => { try { await DaimondSync.pull(); } catch (e) {} });
		await sleep(300);
		const lSeesW = await providerKey(dvL.dev.page, P_G3);
		check('Gap 3: the crossed-over loser reads the winner\'s post-change edit',
			lSeesW === 'g3-edit-key', 'got ' + JSON.stringify(lSeesW), true);
		await dvW.dev.close?.().catch(() => {});
		await dvL.dev.close?.().catch(() => {});
	} catch (e) { check('Gap 3 control completed', false, String((e && e.message) || e), true); }

	const errsA = A.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|402|404|409|410|426|502|Unauthorized/.test(e));
	const errsB = B.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|402|404|409|410|426|502|Unauthorized/.test(e));
	check('no unexpected console errors on A', errsA.length === 0, errsA.slice(0, 3).join(' | '));
	check('no unexpected console errors on B', errsB.length === 0, errsB.slice(0, 3).join(' | '));

} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	await A?.close?.().catch(() => {});
	await B?.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (CONTROL) {
	// The control passes when the marked checks went red: the reverted fix was
	// reproduced. A control that changed nothing means the checks have no teeth.
	const flag = EXPECT_FORK ? '--expect-fork' : '--expect-defects';
	if (antiFail.length) {
		console.log(`\n${flag} reproduced the defect(s), as it must — checks that went red:\n  - `
			+ antiFail.join('\n  - '));
		process.exit(0);
	}
	console.log(`\n${flag} CHANGED NOTHING — the marked checks did not detect the defect, `
		+ 'so they have no teeth.');
	process.exit(1);
}
process.exit(bad.length ? 1 : 0);
