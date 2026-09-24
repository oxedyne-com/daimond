// probe_sealed_nox25519.mjs — which engines can send and open a sealed message.
//
// A matrix, not a pass/fail verifier: it answers, for the tree the dev server is
// serving, what an account created on each kind of engine can do with post.js's
// seal. Run it against two trees and compare the two tables. Written for the
// "Ed25519 for all" unit (D-20260923-46), to settle whether making every account
// Ed25519 cost any engine the sealed messaging it had before.
//
// Four engines, each made by refusing curves in `crypto.subtle` exactly as an
// old engine refuses them (NotSupportedError), with the pure-JS fallback loaded
// as it ships:
//
//   modern  both curves in WebCrypto
//   noX     Ed25519 but no X25519 (Firefox 129)
//   noEd    X25519 but no Ed25519 (Chrome 133 to 136)
//   noEdX   neither (Chrome before 133, Firefox before 129, Safari before 17)
//
// For each, an account is created through the create screen, and then:
//
//   card      it mints an identity card, which is how anybody learns its keys
//   open raw  it opens bytes a modern browser sealed to its sealing key
//   open msg  it opens a whole message a modern browser composed to it
//   seal raw  it seals bytes to a modern browser, which opens them
//   send msg  it composes a whole message to a modern browser, which opens it
//
// A cell is "ok", or the first line of what refused it.
//
//   DAIMOND_PORT=8741 node dev/probe_sealed_nox25519.mjs

import { open, signInAs } from './harness.mjs';

/// Refuse curves before any page script runs, as an old engine does.
function wrapSubtle(mode) {
	const s = crypto.subtle;
	const nameOf = (a) => (typeof a === 'string') ? a : (a && a.name);
	const refused = (n) => (mode.noEd && n === 'Ed25519') || (mode.noX && n === 'X25519');
	const at = { generateKey: 0, importKey: 2, deriveBits: 0, sign: 0, verify: 0 };
	for (const fn of Object.keys(at)) {
		const orig = s[fn].bind(s);
		s[fn] = function () {
			if (refused(nameOf(arguments[at[fn]]))) {
				return Promise.reject(new DOMException('Algorithm: Unrecognized name', 'NotSupportedError'));
			}
			return orig.apply(null, arguments);
		};
	}
}

/// Two minutes for a page load rather than Playwright's thirty: under disk
/// pressure a fresh profile's first navigation has taken longer than thirty.
const patient = async (page) => { page.setDefaultNavigationTimeout(120000); };

const ENGINES = [
	['modern', {}],
	['noX',    { noX: true }],
	['noEd',   { noEd: true }],
	['noEdX',  { noEd: true, noX: true }],
];

const BODY = 'sealed on one engine, opened on another';

/// Wait for the create gate, drive it, and answer '' or what refused it.
async function create(s) {
	await s.page.waitForFunction(() => {
		const b = document.getElementById('id-primary');
		return !!b && b.offsetParent !== null;
	}, null, { timeout: 120000 }).catch(() => { /* signInAs says what it found */ });
	try {
		await signInAs(s, s.name);
		return '';
	} catch (e) {
		const shown = await s.page.evaluate(() =>
			(document.getElementById('id-error') || {}).textContent || '').catch(() => '');
		return shown || String(e && e.message || e).split('\n')[0];
	}
}

/// The page's own keys, after asking for a sealing key and a card.
const keys = (page) => page.evaluate(async () => {
	const I = window.DaimondIdentity;
	let seal = null, card = null;
	try { seal = await I.ensureSealingKey(); } catch (e) { seal = { ok: false, why: e.message }; }
	try { card = await I.mintCard(); } catch (e) { card = { ok: false, why: e.message }; }
	const enc = I.sealingKeyRaw();
	const pub = await I.publicKeyRaw();
	return {
		alg:    localStorage.getItem('daimond-id-alg'),
		pub:    I.publicKeyB64url(),
		pubLen: pub ? pub.length : 0,
		enc:    enc ? Array.from(enc) : null,
		seal:   !!(seal && seal.ok),
		card:   card && card.ok ? 'ok' : ('no: ' + ((card && card.why) || 'refused')),
	};
});

/// Seal raw bytes to `enc` on `from`, open them on `to`.
async function rawRoundTrip(from, to, enc) {
	const sealed = await from.page.evaluate(async ([enc, text]) => {
		try {
			const b = await window.DaimondPost.seal([new Uint8Array(enc)], new TextEncoder().encode(text));
			return { ok: true, bytes: Array.from(b) };
		} catch (e) { return { ok: false, why: (e && e.name ? e.name + ': ' : '') + (e && e.message) }; }
	}, [enc, BODY]);
	if (!sealed.ok) return 'seal refused: ' + sealed.why;
	return await to.page.evaluate(async ([bytes, text]) => {
		try {
			const p = await window.DaimondPost.unseal(new Uint8Array(bytes));
			return new TextDecoder().decode(p) === text ? 'ok' : 'opened to different bytes';
		} catch (e) { return 'open refused: ' + (e && e.name ? e.name + ': ' : '') + (e && e.message); }
	}, [sealed.bytes, BODY]);
}

/// Compose a whole message on `from` to the account `rcpt`, open it on `to`.
async function messageRoundTrip(from, to, rcpt, authorPub) {
	const made = await from.page.evaluate(async ([pub, enc, text]) => {
		try {
			const m = await window.DaimondPost.compose({ body: text, to: pub, toEnc: new Uint8Array(enc) });
			return { ok: true, addr: m.addr, envelope: m.envelope };
		} catch (e) { return { ok: false, why: (e && e.name ? e.name + ': ' : '') + (e && e.message) }; }
	}, [rcpt.pub, rcpt.enc, BODY]);
	if (!made.ok) return 'compose refused: ' + made.why;
	return await to.page.evaluate(async ([env, addr, text, author]) => {
		try {
			const got = await window.DaimondPost.open(env, addr);
			if (got.post.body !== text) return 'opened to a different body';
			// The author is the sender's own signing key, and the signature over
			// it verified inside DaimondCrypto.read.
			const u8 = new Uint8Array(got.author.length / 2);
			for (let i = 0; i < u8.length; i++) u8[i] = parseInt(got.author.substr(i * 2, 2), 16);
			let s = ''; for (const x of u8) s += String.fromCharCode(x);
			const b64u = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
			return b64u === author ? 'ok' : 'opened, but the author is not the sender';
		} catch (e) { return 'open refused: ' + (e && e.name ? e.name + ': ' : '') + (e && e.message); }
	}, [made.envelope, made.addr, BODY, authorPub]);
}

const sessions = [];
const rows = [];
try {
	// The other party: a modern engine, as most correspondents are.
	const ref = await open({ name: 'seal-ref', signIn: false, connect: false, route: patient });
	sessions.push(ref);
	await ref.page.waitForFunction(() => !!window.DaimondPost && !!window.DaimondIdentity, null, { timeout: 120000 });
	const refMade = await create(ref);
	if (refMade) throw new Error('the reference account was not created: ' + refMade);
	const R = await keys(ref.page);
	if (!R.enc || R.card !== 'ok') throw new Error('the reference account has no sealing key or card: ' + JSON.stringify(R));

	for (const [label, mode] of ENGINES) {
		const row = { engine: label };
		const s = await open({
			name: 'seal-' + label, signIn: false, connect: false,
			route: async (page) => { await patient(page); await page.addInitScript(wrapSubtle, mode); },
		});
		sessions.push(s);
		try {
			await s.page.waitForFunction(() => !!window.DaimondPost && !!window.DaimondIdentity,
				null, { timeout: 120000 });
			const made = await create(s);
			if (made) {
				row.create = made;
				rows.push(row);
				continue;
			}
			const P = await keys(s.page);
			row.create  = 'ok';
			row.account = P.alg + ' (' + P.pubLen + '-byte key)';
			row.sealKey = P.seal && P.enc && P.enc.length === 32 ? 'ok' : 'none';
			row.card    = P.card;
			row.openRaw = P.enc ? await rawRoundTrip(ref, s, P.enc) : 'no sealing key';
			row.openMsg = P.enc ? await messageRoundTrip(ref, s, P, R.pub) : 'no sealing key';
			row.sealRaw = await rawRoundTrip(s, ref, R.enc);
			row.sendMsg = await messageRoundTrip(s, ref, R, P.pub);
		} catch (e) {
			row.error = String(e && e.message || e).split('\n')[0];
		}
		rows.push(row);
	}
} finally {
	for (const s of sessions) { try { await s.close(); } catch (e) { /* already gone */ } }
}

for (const r of rows) {
	console.log('\n' + r.engine);
	for (const [k, v] of Object.entries(r)) {
		if (k !== 'engine') console.log('  ' + k.padEnd(8) + ' ' + String(v).split('\n')[0].slice(0, 200));
	}
}
console.log('\nJSON ' + JSON.stringify(rows));
