/* ============================================================
   Test — PAIR-QR P1: the `#runner=` deep link and the code entry
   (UNBLOCK-35; pairqr_design.md P1 as amended by pairqr_review.md).
   ------------------------------------------------------------
   The computer shows a QR of `https://daimond.app/#runner=<session>.<kc>`
   and a short code. The phone's camera opens the link, or he types
   the code into Settings -> Devices. Either way the page claims the
   session at the gateway and one tap on Approve runs the same
   `approveRunner` the Pending tile does.

     Q1  the hash opens the approval overlay and claims exactly once;
     Q2  one Approve press calls approveRunner with the claim's device
         and key;
     Q3  a claimed key whose commitment is not the QR's `kc` is
         refused in a plain sentence, with no Approve and no call (H1);
     Q4  404, 409, 410 (contested, H2) and not-signed-in each say
         their sentence;
     Q5  the hash is stripped, so a reload neither reclaims nor keeps
         the session in history;
     Q6  a re-claim by the same account (a second scan) opens the
         approval again (H2.2);
     Q7  the code path claims with `{code}` and shows the key with the
         "matches the computer" line, and holds Approve until it shows;
     Q8  a cancelled passkey keeps the overlay and its Approve;
     Q10 his own browser, still locked, claims only once he unlocks.

   Loads the REAL pairing.js into a small fake DOM.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(join(HERE, 'pairing.js'), 'utf8');

// The runner key and its commitment, worked out here, independently of the page.
const RAW  = Buffer.alloc(32, 7);
const PK   = RAW.toString('base64url');
const KC   = createHash('sha256').update(RAW).digest().subarray(0, 12).toString('base64url');
const PK2  = Buffer.alloc(32, 9).toString('base64url');	// a substituted key
const SESS = 'Ab3dE5gH7jK9mN1p';
const DEV  = 'dev_runner_0001';
const CODE = 'k7m-q2p';

// ── A DOM just deep enough for pairing.js's dialogs ─────────────
function makeDom() {
	const byId = {};
	function mk(tag) {
		const n = {
			tag, children: [], parentNode: null, className: '', id: '', textContent: '', value: '',
			disabled: false, type: '', attrs: {}, style: {}, listeners: {},
			classList: { contains: (c) => (' ' + n.className + ' ').includes(' ' + c + ' ') },
			appendChild(c) { c.parentNode = n; n.children.push(c); if (c.id) byId[c.id] = c; return c; },
			insertBefore(c, ref) {
				c.parentNode = n;
				const i = n.children.indexOf(ref);
				if (i < 0) n.children.push(c); else n.children.splice(i, 0, c);
				return c;
			},
			removeChild(c) {
				const i = n.children.indexOf(c);
				if (i < 0) throw new Error('not a child');
				n.children.splice(i, 1);
				c.parentNode = null;
				return c;
			},
			get firstChild() { return n.children[0] || null; },
			setAttribute(k, v) { n.attrs[k] = String(v); },
			getAttribute(k) { return n.attrs[k]; },
			addEventListener(k, f) { (n.listeners[k] = n.listeners[k] || []).push(f); },
			removeEventListener() {},
			getClientRects() { return [1]; },
			focus() { doc.activeElement = n; },
			contains(x) { for (let p = x; p; p = p.parentNode) if (p === n) return true; return false; },
			querySelectorAll(sel) { return all(n, sel); },
			querySelector(sel) { return all(n, sel)[0] || null; },
		};
		return n;
	}
	function matches(n, sel) {
		return sel.split(',').some((s) => {
			s = s.trim();
			if (s.startsWith('.')) return n.classList.contains(s.slice(1));
			if (s.startsWith('#')) return n.id === s.slice(1);
			return n.tag === s.replace(/\[.*$/, '');
		});
	}
	function all(root, sel) {
		const out = [];
		(function walk(x) { x.children.forEach((c) => { if (matches(c, sel)) out.push(c); walk(c); }); })(root);
		return out;
	}
	const body = mk('body');
	const head = mk('head');
	const doc = {
		readyState: 'complete', body, head, activeElement: null,
		createElement: mk,
		getElementById: (id) => { const f = all(body, '#' + id)[0] || all(head, '#' + id)[0]; return f || null; },
		querySelector: (sel) => all(body, sel)[0] || null,
		addEventListener() {}, removeEventListener() {},
	};
	return doc;
}

function text(n) { return (n.textContent || '') + n.children.map(text).join(' '); }
function find(root, pred) {
	let hit = null;
	(function walk(x) { if (!hit && pred(x)) hit = x; x.children.forEach(walk); })(root);
	return hit;
}
function approveBtn(doc) { return find(doc.body, (n) => n.tag === 'button' && n.classList.contains('pair-runner-approve')); }
async function click(n) { for (const f of n.listeners.click || []) await f({ preventDefault() {} }); }
// Waits on the page's own promise for the latest link's claim and card, never on a count
// of ticks: a guess at "long enough" was the Q10 flake (1 in 11,254 under dk arms).
function drawn(p) { return p.win.DaimondPairing.runner.flow(); }

function reply(status, body) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// One page load: `hash` is where the camera landed, `claims` the claim door's
// replies in order, `status` the status door's, `approve` approveRunner's answer.
function boot({ hash = '', claims = [], status = null, approve = { ok: true }, identity = null } = {}) {
	const doc  = makeDom();
	const st   = { claimed: [], statused: [], approveCalls: [], replaced: [] };
	const loc  = { hash, pathname: '/', search: '', origin: 'https://daimond.app' };
	const win  = {
		document: doc, location: loc,
		history: { state: null, replaceState(s, _t, url) {
			st.replaced.push(url);
			const i = url.indexOf('#');
			loc.hash = i < 0 ? '' : url.slice(i);
		} },
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		listeners: {},
		addEventListener(k, f) { (win.listeners[k] = win.listeners[k] || []).push(f); },
		removeEventListener(k, f) { win.listeners[k] = (win.listeners[k] || []).filter((x) => x !== f); },
		dispatch(k) { (win.listeners[k] || []).slice().forEach((f) => f({})); },
		DaimondIdentity: identity,
		DaimondLayers: { open: () => 1, done() {}, uid: (x) => x },
		DaimondGateway: {
			clientApi: () => 2,
			gwFetch: async (url, opts) => {
				st.claimed.push([url, JSON.parse(opts.body || '{}')]);
				return claims.shift() || reply(500, {});
			},
		},
		fetch: async (url, opts) => {
			st.statused.push([url, JSON.parse((opts && opts.body) || '{}')]);
			return status || reply(500, {});
		},
		DaimondPasskey: { approveRunner: async (d, k) => { st.approveCalls.push([d, k]); return approve; } },
		DaimondI18n: { t: (k, v) => (v ? k + ' ' + JSON.stringify(v) : k) },
		// A SLOW redraw on purpose: the key is shown a beat after the claim lands, as on a busy
		// phone, so a test that guessed at "long enough" instead of waiting on the page goes red.
		DaimondRunnerPair: { fingerprint: async (k) => {
			await new Promise((r) => setTimeout(r, 30));
			return k === PK ? '311d 23d8 4360 c5dc' : '9999 9999 9999 9999';
		} },
		crypto: webcrypto, TextEncoder, Uint8Array, atob, btoa, setTimeout, clearTimeout, console, JSON, Promise,
	};
	win.window = win;
	vm.createContext(win);
	vm.runInContext(SRC, win);
	return { win, doc, st, loc };
}

const CLAIM_OK = () => reply(200, { ok: true, device: DEV, pubkey: PK, name: 'argonaut', fingerprint: '311d 23d8 4360 c5dc' });

test('Q1 the hash opens the overlay and claims exactly once', async () => {
	const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [CLAIM_OK()] });
	await drawn(p);
	assert.equal(p.st.claimed.length, 1, 'one claim');
	assert.equal(p.st.claimed[0][0], '/api/runner/pair/claim');
	assert.deepEqual(p.st.claimed[0][1], { session: SESS });
	assert.ok(p.doc.querySelector('.pair-scrim'), 'the overlay is up');
	assert.match(text(p.doc.body), /argonaut/);
	assert.match(text(p.doc.body), /311d 23d8 4360 c5dc/, 'the four key groups are shown');
	// A hash change on the same tab does not claim a second time while it is up.
	p.loc.hash = '#runner=' + SESS + '.' + KC;
	p.win.DaimondPairing.runner.fromHash();
	await drawn(p);
	assert.equal(p.st.claimed.length, 1, 'still one claim');
});

test('Q2 one Approve press calls approveRunner with the claim\'s device and key', async () => {
	const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [CLAIM_OK()] });
	await drawn(p);
	const b = approveBtn(p.doc);
	assert.ok(b && !b.disabled, 'Approve is offered');
	await click(b);
	await drawn(p);
	assert.deepEqual(p.st.approveCalls, [[DEV, PK]]);
	assert.match(text(p.doc.body), /pending\.runnerpair\.approved/, 'says it is approved');
	assert.doesNotMatch(text(p.doc.body), /pending\.runnerpair\.headline/, 'and no longer asks');
	assert.equal(approveBtn(p.doc), null, 'and the Approve is gone');
});

test('Q3 a key that does not match the QR commitment is refused, with no approve', async () => {
	const p = boot({ hash: '#runner=' + SESS + '.' + KC,
		claims: [reply(200, { ok: true, device: DEV, pubkey: PK2, name: 'argonaut' })] });
	await drawn(p);
	assert.match(text(p.doc.body), /runnerpair\.err_key/, 'the mismatch sentence');
	assert.equal(approveBtn(p.doc), null, 'no Approve to press');
	assert.equal(p.st.approveCalls.length, 0);
});

test('Q3b a link without its commitment is refused before any claim', async () => {
	const p = boot({ hash: '#runner=' + SESS, claims: [CLAIM_OK()] });
	await drawn(p);
	assert.equal(p.st.claimed.length, 0, 'nothing claimed');
	assert.match(text(p.doc.body), /runnerpair\.err_link/);
});

for (const [code, key] of [[404, 'runnerpair.err_unknown'], [409, 'runnerpair.err_used'], [410, 'runnerpair.err_contested']]) {
	test('Q4 a ' + code + ' says its sentence', async () => {
		const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [reply(code, { ok: false, error: 'x' })] });
		await drawn(p);
		assert.match(text(p.doc.body), new RegExp(key.replace('.', '\\.')));
		assert.equal(approveBtn(p.doc), null);
	});
}

test('Q4 a 429 says the gateway\'s own sentence', async () => {
	const s = 'This account already has 4 computers waiting. Approve or refuse one first.';
	const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [reply(429, { ok: false, error: s })] });
	await drawn(p);
	assert.ok(text(p.doc.body).includes(s));
});

test('Q4 not signed in says where to go, with no Approve', async () => {
	const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [reply(401, { ok: false })] });
	await drawn(p);
	assert.match(text(p.doc.body), /runnerpair\.err_signin_nocode/);
	assert.equal(approveBtn(p.doc), null);
});

test('Q5 the hash is stripped once read', async () => {
	const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [CLAIM_OK()] });
	await drawn(p);
	assert.equal(p.loc.hash, '', 'no runner= left in the address');
	assert.ok(p.st.replaced.every((u) => !u.includes(SESS)), 'the session never went back into history');
});

test('Q6 a second scan by the same account re-opens the approval', async () => {
	const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [CLAIM_OK(), CLAIM_OK()] });
	await drawn(p);
	// Dismiss and scan again (the gateway answers the same account's re-claim with 200).
	const scrim = p.doc.querySelector('.pair-scrim');
	p.doc.body.removeChild(scrim);
	p.loc.hash = '#runner=' + SESS + '.' + KC;
	p.win.DaimondPairing.runner.fromHash();
	await drawn(p);
	assert.equal(p.st.claimed.length, 2);
	assert.ok(approveBtn(p.doc), 'Approve is offered again');
});

test('Q7 the code path claims with the code and asks him to match the key', async () => {
	const p = boot({ claims: [CLAIM_OK()] });
	p.win.DaimondPairing.runner.enterCode();
	await drawn(p);
	const input = find(p.doc.body, (n) => n.tag === 'input');
	assert.ok(input, 'a field for the code');
	input.value = ' K7M Q2P ';
	const go = find(p.doc.body, (n) => n.tag === 'button' && n.classList.contains('pair-runner-claim'));
	await click(go);
	await drawn(p);
	assert.deepEqual(p.st.claimed[0][1], { code: 'k7mq2p' });
	assert.match(text(p.doc.body), /runnerpair\.code_key \{"fp":"311d 23d8 4360 c5dc"\}/, 'the match line');
	const b = approveBtn(p.doc);
	assert.ok(b && !b.disabled);
	await click(b);
	await drawn(p);
	assert.deepEqual(p.st.approveCalls, [[DEV, PK]]);
});

test('Q7b a code of the wrong shape is said in place and not sent', async () => {
	const p = boot({ claims: [CLAIM_OK()] });
	p.win.DaimondPairing.runner.enterCode();
	await drawn(p);
	find(p.doc.body, (n) => n.tag === 'input').value = 'k7m';
	await click(find(p.doc.body, (n) => n.tag === 'button' && n.classList.contains('pair-runner-claim')));
	await drawn(p);
	assert.equal(p.st.claimed.length, 0);
	assert.match(text(p.doc.body), /runnerpair\.err_code/);
});

test('Q8 a cancelled passkey keeps the overlay and its Approve', async () => {
	const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [CLAIM_OK()],
		approve: { ok: false, error: 'passkey.err_runner_no_assertion' } });
	await drawn(p);
	await click(approveBtn(p.doc));
	await drawn(p);
	assert.ok(p.doc.querySelector('.pair-scrim'), 'still up');
	const b = approveBtn(p.doc);
	assert.ok(b && !b.disabled, 'Approve can be pressed again');
	assert.match(text(p.doc.body), /passkey\.err_runner_no_assertion/);
});

test('Q9 the page\'s commitment is the runner\'s: first 12 bytes of SHA-256, base64url', async () => {
	const p = boot();
	assert.equal(await p.win.DaimondPairing.runner.commit(PK), KC);
	assert.equal(await p.win.DaimondPairing.runner.commit('short'), '');
});

test('Q10 a locked identity claims only after the unlock', async () => {
	let unlocked = false;
	const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [CLAIM_OK()],
		identity: { exists: () => true, isUnlocked: () => unlocked } });
	await drawn(p);
	assert.equal(p.st.claimed.length, 0, 'nothing claimed while locked');
	assert.equal(p.doc.querySelector('.pair-scrim'), null, 'no card over the unlock screen');
	assert.equal(p.loc.hash, '', 'the hash is already gone');
	unlocked = true;
	p.win.dispatch('daimond:authed');
	p.win.dispatch('daimond:authed');
	await drawn(p);
	assert.equal(p.st.claimed.length, 1, 'claimed once, on the unlock');
	assert.ok(approveBtn(p.doc));
});

test('F4 a scan while a pairing dialog is up still strips the session from the address', async () => {
	const p = boot({ claims: [CLAIM_OK()] });
	p.win.DaimondPairing.runner.enterCode();
	await drawn(p);
	p.loc.hash = '#runner=' + SESS + '.' + KC;
	p.win.DaimondPairing.runner.fromHash();
	await drawn(p);
	assert.equal(p.loc.hash, '', 'no runner= left in the address');
	assert.equal(p.st.claimed.length, 0, 'nothing claimed under the open dialog');
});

test('F5 two scans while locked keep one pending link: one claim, one card, the later scan', async () => {
	let unlocked = false;
	const SESS2 = 'Zz9yX8wV7uT6sR5q';
	const p = boot({ hash: '#runner=' + SESS + '.' + KC, claims: [CLAIM_OK(), CLAIM_OK()],
		identity: { exists: () => true, isUnlocked: () => unlocked } });
	await drawn(p);
	const before = (p.win.listeners['daimond:authed'] || []).length;
	p.loc.hash = '#runner=' + SESS2 + '.' + KC;
	p.win.DaimondPairing.runner.fromHash();
	await drawn(p);
	assert.equal((p.win.listeners['daimond:authed'] || []).length, before, 'no second listener');
	unlocked = true;
	p.win.dispatch('daimond:authed');
	await drawn(p);
	assert.equal(p.st.claimed.length, 1, 'one claim');
	assert.deepEqual(p.st.claimed[0][1], { session: SESS2 }, 'the later scan wins');
	assert.equal(p.doc.body.querySelectorAll('.pair-scrim').length, 1, 'one card');
});
