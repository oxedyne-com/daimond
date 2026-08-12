// verify_handle.mjs — the account has a public name, every device of it agrees,
// and the name never restamps itself on the way through.
//
// A handle is what a shared Diamond will be shared WITH and what a rating will
// be attributed TO. Four things have to be true before any of that can be built
// on it, and each one has failed somewhere in this app already:
//
//   1. IT IS THE ACCOUNT'S NAME, NOT THE DEVICE'S. `identity.js` already has a
//      `displayName()`, which labels this device's keypair, lives only in this
//      browser and is seen by nobody. Reusing it is the obvious move and the
//      wrong one, so the check is that the two are SEPARATE: adopting a handle
//      must leave the device's own label exactly where it was.
//
//   2. IT RIDES THE PARCEL, AND IT IS A FIXED POINT. `push()` skips the wire
//      only while two collects give the same bytes. A field restamped on the way
//      in makes every parcel differ from the last one sent, and two devices then
//      push at each other for ever -- which has happened here, over a pairing
//      name, on a phone freshly paired by QR. So the merge must write what
//      arrived VERBATIM, stamp included, and must move nothing when the record
//      it is handed is one this device already holds.
//
//   3. THE MERGE IS THE SAME ON BOTH DEVICES. Later stamp wins; on a tie the
//      lexicographically smaller name wins, because a tie broken by "keep mine"
//      is two devices that never converge.
//
//   4. A REFUSAL SAYS WHICH REFUSAL IT IS. A name somebody else holds, a name
//      that is not a name, and a name the operator keeps are three different
//      sentences. One sentence for all three is a user staring at a field that
//      will not take what they typed.
//
// And the half that makes it public at all: a handle another account holds must
// be resolvable, or nothing can ever be attributed to it.
//
// THE GATEWAY IS STUBBED HERE, and it is stubbed as a real namespace owner --
// one name to one account, a 409 for a name that is held. What the REAL gateway
// does with the namespace is proved in Rust, against a real store, in
// `gateway/src/schema.rs` and `gateway/src/handlers/account.rs`. This file is
// about the browser: what it asks for, what it stores, what it sends on.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// damaged copy of a real source file to the real page, and the run is expected
// to FAIL. A break whose anchor does not appear exactly once aborts, because a
// check proved against code that was never broken is not proved at all.
//
//   node dev/verify_handle.mjs --break restamp     # 2 fails: the stamp is rewritten
//   node dev/verify_handle.mjs --break applystamps # 2 fails: applying its OWN parcel moves it
//   node dev/verify_handle.mjs --break nocarry     # 2 fails: the parcel drops it
//   node dev/verify_handle.mjs --break alwaysadopt # 3 fails: an older record wins
//   node dev/verify_handle.mjs --break onemessage  # 4 fails: one sentence for three noes
//   node dev/verify_handle.mjs --break devicename  # 1 fails: the device label is overwritten
//   node dev/verify_handle.mjs --break nolookup    # the public half fails
//   node dev/verify_handle.mjs                     # and then, clean
//
//   eval "$(bash dev/world.sh 3 --env)"
//   node dev/verify_handle.mjs
//
// Needs dev/serve.mjs only. No gateway on :9002 and no mock LLM: nothing here
// runs a turn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, errors, PASS } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
const BREAKS = {
	// The merge stamps what it adopts with this device's clock. This is the
	// pairing-name defect exactly: the record is right, the stamp is fresh, and
	// the parcel differs from the last one sent every single time.
	//
	// BOTH writes, because there are two -- the merge and the gateway's own
	// answer -- and a break that damaged one would leave the other doing the job
	// on the path the check happens to use. The anchors carry the line above
	// them, which is what tells the two functions apart.
	restamp: [{
		file: 'js/identity.js',
		find: '\t\tif (!handleBeats(incoming, mine)) return false;\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: incoming.t })); }',
		with: '\t\tif (!handleBeats(incoming, mine)) return false;\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: Date.now() })); }',
	}, {
		file: 'js/identity.js',
		find: '\t\tif (mine && mine.h === incoming.h && mine.t === incoming.t) return false;\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: incoming.t })); }',
		with: '\t\tif (mine && mine.h === incoming.h && mine.t === incoming.t) return false;\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: Date.now() })); }',
	}],
	// The section restamps itself ON APPLY: it takes every record it is handed,
	// including one it already holds, and writes the clock over the stamp. This
	// is the `touchSelfDevice` defect precisely -- a parcel that differs from
	// the last one sent every time it is packed, on a device that has just been
	// paired, and two devices pushing at each other about nothing.
	applystamps: [{
		file: 'js/identity.js',
		find: '\t\tif (!handleBeats(incoming, mine)) return false;\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: incoming.t })); }',
		with: '\t\tif (!incoming) return false;\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: Date.now() })); }',
	}],
	// The parcel does not carry the handle at all, so a second device of the
	// same account never hears the name.
	nocarry: [{
		file: 'js/sync.js',
		find: "\t\ttry { if (window.DaimondIdentity) state.handle = DaimondIdentity.handleSnapshot(); }",
		with: "\t\ttry { if (false) state.handle = DaimondIdentity.handleSnapshot(); }",
	}],
	// Whatever arrives is taken, stamps ignored. Two devices then hand the same
	// two names back and forth, and an older record undoes a rename.
	alwaysadopt: [{
		file: 'js/identity.js',
		find: '\t\tif (!handleBeats(incoming, mine)) return false;',
		with: '\t\tif (!incoming) return false;',
	}],
	// One sentence for every refusal.
	onemessage: [{
		file: 'js/sync.js',
		find: "\t\tif (reason === 'taken')    return t('handle.taken');",
		with: "\t\tif (reason === 'taken')    return t('handle.failed');",
	}],
	// The account's public name is written over the device's own label -- the
	// exact confusion this feature is shaped around avoiding.
	devicename: [{
		file: 'js/identity.js',
		find: '\t\tif (!handleBeats(incoming, mine)) return false;\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: incoming.t })); }',
		with: '\t\tif (!handleBeats(incoming, mine)) return false;\n'
			+ '\t\tlocalStorage.setItem(K_NAME, incoming.h);\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: incoming.t })); }',
	}, {
		file: 'js/identity.js',
		find: '\t\tif (mine && mine.h === incoming.h && mine.t === incoming.t) return false;\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: incoming.t })); }',
		with: '\t\tif (mine && mine.h === incoming.h && mine.t === incoming.t) return false;\n'
			+ '\t\tlocalStorage.setItem(K_NAME, incoming.h);\n'
			+ '\t\ttry { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: incoming.t })); }',
	}],
	// Nobody else's name can be resolved, so nothing can be attributed to one.
	nolookup: [{
		file: 'js/sync.js',
		find: '\t\tif (r.status !== 200 || !j.ok || !j.found) return { found: false };',
		with: '\t\tif (true) return { found: false };',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source of ONE file, with every edit for it applied, or a hard
/// stop.
///
/// All of a file's edits go into one body on purpose. Registering two routes for
/// the same URL serves only the last one, so a break with two edits in one file
/// would silently deliver half of itself -- and the half it dropped is the half
/// the check was written for. That happened here: the merge was left intact, the
/// run went green, and the break looked like a proof that the code was right.
function damaged(file, specs) {
	let src = fs.readFileSync(path.join(WWW, file), 'utf8');
	for (const spec of specs) {
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': an anchor appears ${n} times in ${file}, `
				+ 'so it was not applied and the run below would prove nothing.');
			process.exit(2);
		}
		src = src.replace(spec.find, spec.with);
	}
	return src;
}

// ── The English the user is owed ─────────────────────────────────────
// Read from the CATALOGUE FILE, not from the page: a check that asks the page
// what it thinks the sentence is, and then asserts the page said it, is a check
// that would pass with every sentence replaced by the same one.
const CATALOGUE = (() => {
	const src = fs.readFileSync(path.join(WWW, 'i18n/en.js'), 'utf8');
	const out = {};
	for (const key of ['handle.taken', 'handle.invalid', 'handle.reserved', 'handle.failed']) {
		const m = src.match(new RegExp(`'${key.replace('.', '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`));
		if (!m) {
			console.error(`i18n/en.js carries no '${key}' -- the check below would compare nothing.`);
			process.exit(2);
		}
		out[key] = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
	}
	return out;
})();

// ── The stubbed gateway ──────────────────────────────────────────────
// A real namespace owner, in miniature: one name to one account, and a 409 for a
// name somebody else holds.

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});

const ME        = 'acct-under-test';
const SOMEONE   = 'acct-somebody-else';
const THEIRS    = 'quiet-heron-22aa';
const THEIR_FP  = 'aaaa bbbb cccc dddd';
const MINTED    = 'amber-otter-7f3q';

/// handle → account id. The reservation, and the only place a name is held.
const NS = new Map([[THEIRS, SOMEONE]]);
let clock  = 1_700_000_000;		// the gateway's clock, in seconds
let mine   = '';				// what the account under test is called
let mineTs = 0;
let asked  = 0;					// GETs of this account's own record

/// The gateway's own rule, in miniature.
function normalise(raw) {
	const h = String(raw || '').trim().toLowerCase();
	if (h.length < 3 || h.length > 24) return null;
	if (!/^[a-z0-9-]+$/.test(h)) return null;
	if (h.startsWith('-') || h.endsWith('-') || h.includes('--')) return null;
	return h;
}
const RESERVED = new Set(['admin', 'daimond', 'support', 'system', 'root', 'operator']);

function mint() {
	if (mine) return;
	mine   = MINTED;
	mineTs = ++clock;
	NS.set(mine, ME);
}

/// Serve one `/api/account` request. `refuseGet` is device B, whose gateway is
/// deliberately mute so that only the parcel can tell it the account's name.
function accountRoute(refuseGet) {
	return (r) => {
		const req    = r.request();
		const url    = new URL(req.url());
		const method = req.method();

		if (method === 'POST' && url.searchParams.get('op') === 'handle') {
			let body = {};
			try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = {}; }
			const want = normalise(body.handle);
			if (!want) return r.fulfill(json({ ok: false, reason: 'invalid' }, 400));
			if (RESERVED.has(want)) return r.fulfill(json({ ok: false, reason: 'reserved' }, 400));
			const holder = NS.get(want);
			if (holder && holder !== ME) return r.fulfill(json({ ok: false, reason: 'taken' }, 409));
			if (want === mine) {
				return r.fulfill(json({ ok: true, reason: 'unchanged', handle: mine, handle_ts: mineTs }));
			}
			NS.delete(mine);
			mine   = want;
			mineTs = ++clock;
			NS.set(mine, ME);
			return r.fulfill(json({ ok: true, reason: 'claimed', handle: mine, handle_ts: mineTs }));
		}

		if (method === 'GET') {
			if (refuseGet) return r.fulfill(json({ ok: false, error: 'no' }, 500));
			const wanted = url.searchParams.get('handle');
			if (wanted !== null) {
				const holder = NS.get(normalise(wanted) || '');
				if (!holder) return r.fulfill(json({ ok: true, found: false }));
				return r.fulfill(json({
					ok: true, found: true,
					handle: normalise(wanted),
					fingerprint: holder === SOMEONE ? THEIR_FP : 'ffff ffff ffff ffff',
				}));
			}
			asked++;
			return r.fulfill(json({ ok: true, account_id: ME, handle: mine, handle_ts: mineTs }));
		}

		// Registration. The gateway mints the handle: the client never proposes
		// one, so there is no collision to explain during sign-in.
		mint();
		return r.fulfill(json({
			ok: true, account_id: ME, created: true, handle: mine, handle_ts: mineTs,
		}));
	};
}

/// Everything a page needs to boot signed in, plus the account endpoint.
async function stub(page, { refuseGet = false, broken = true } = {}) {
	if (BREAK && broken) {
		const byFile = new Map();
		for (const spec of BREAKS[BREAK]) {
			if (!byFile.has(spec.file)) byFile.set(spec.file, []);
			byFile.get(spec.file).push(spec);
		}
		for (const [file, specs] of byFile) {
			const body = damaged(file, specs);
			await page.route('**/' + file, r => r.fulfill({
				status: 200, contentType: 'application/javascript', body,
			}));
		}
	}
	await page.route(/\/api\/account(\?|$)/, accountRoute(refuseGet));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-h', challenge_id: 'cid-h' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 5000, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: true, currency: 'usd' })));
	// The sync mailbox is not what this is about, and a device pushing into a
	// 404 retries. Answer it, emptily.
	await page.route('**/api/sync**', r => r.fulfill(json({ ok: true, version: 0, blob: null })));
}

const PROFILE_A = scratch('pw', 'handle-a' + (BREAK ? '-' + BREAK : ''));
const PROFILE_B = scratch('pw', 'handle-b' + (BREAK ? '-' + BREAK : ''));
for (const p of [PROFILE_A, PROFILE_B]) fs.rmSync(p, { recursive: true, force: true });

const a = await open({
	name: 'handlea', profile: PROFILE_A, connect: false,
	route: (page) => stub(page),
});
const page = a.page;
let b = null;

/// The handle this device is showing.
const handleOf = (p) => p.evaluate(() => window.DaimondSync.handle());
/// The handle section of the parcel this device would send.
const sectionOf = (p) => p.evaluate(async () => {
	const parcel = await window.DaimondSync.parcel();
	return JSON.stringify(parcel.handle === undefined ? null : parcel.handle);
});

try {
	await page.waitForFunction(() => !!(window.DaimondSync && window.DaimondSync.handle),
		null, { timeout: 15000 });

	// ── 1. The device learns the account's name ──────────────────────
	await page.waitForFunction(() => !!window.DaimondSync.handle(), null, { timeout: 15000 })
		.catch(() => { /* asserted below, with the value in the message */ });
	const learned = await handleOf(page);
	check('the device learns the handle the gateway minted', learned === MINTED,
		`showing '${learned}', the gateway minted '${MINTED}'`);
	check('and it had to ask for it', asked > 0, `${asked} request(s)`);

	// ── 2. It is the ACCOUNT's name, not the device's ────────────────
	// The trap this whole feature is shaped around: `displayName()` labels this
	// device's keypair and must be untouched by any of it.
	const label = await page.evaluate(() => ({
		device: window.DaimondIdentity.displayName(),
		raw:    localStorage.getItem('daimond-id-name'),
	}));
	check('the device\'s own label is left alone', label.device === 'handlea' && label.raw !== learned,
		`device label '${label.device}', handle '${learned}'`);

	// ── 3. It rides the parcel ───────────────────────────────────────
	const carried = JSON.parse(await sectionOf(page) || 'null');
	check('the parcel carries the handle', !!carried && carried.h === learned,
		`parcel carries ${JSON.stringify(carried)}`);
	check('and carries the gateway\'s stamp, not a local clock',
		!!carried && carried.t === mineTs, `parcel stamp ${carried && carried.t}, gateway ${mineTs}`);

	// ── 4. The fixed point ───────────────────────────────────────────
	// Applying this device's OWN parcel must leave the next one identical.
	// Compared as BYTES, because that is what the push-skip compares.
	const before = await sectionOf(page);
	await page.evaluate(async () => {
		const p = await window.DaimondSync.parcel();
		await window.DaimondSync.apply(p);
	});
	await page.waitForTimeout(1200);
	const after = await sectionOf(page);
	check('applying its own parcel leaves the handle section byte-identical',
		before === after, `${before} → ${after}`);

	// ── 5. A newer record is adopted VERBATIM ────────────────────────
	const NEWER = { v: 1, h: 'silver-brolga-4k2m', t: mineTs + 500 };
	await page.evaluate(async (rec) => {
		await window.DaimondSync.apply({ handle: rec });
	}, NEWER);
	await page.waitForTimeout(600);
	const adopted = JSON.parse(await sectionOf(page) || 'null');
	check('a later record is adopted', adopted && adopted.h === NEWER.h,
		`showing '${adopted && adopted.h}'`);
	check('and its stamp is copied, not taken from this device\'s clock',
		adopted && adopted.t === NEWER.t, `stamp ${adopted && adopted.t}, sent ${NEWER.t}`);
	// The stamp check is only worth anything if a local clock would LOOK
	// different, so say what one would have been.
	const nowish = await page.evaluate(() => Date.now());
	check('and a local clock would have been visibly different',
		Math.abs(nowish - NEWER.t) > 60_000, `local ${nowish} vs adopted ${NEWER.t}`);
	// And the device's own label survived a handle arriving by parcel, which is
	// the OTHER of the two paths that write the record. Asked again here rather
	// than only after sign-in, because the first check went through the
	// gateway's answer and this one goes through the merge.
	const labelAfter = await page.evaluate(() => window.DaimondIdentity.displayName());
	check('a handle arriving by parcel still leaves the device label alone',
		labelAfter === 'handlea' && labelAfter !== NEWER.h, `device label '${labelAfter}'`);

	// ── 6. An older record is refused ────────────────────────────────
	await page.evaluate(async (t) => {
		await window.DaimondSync.apply({ handle: { v: 1, h: 'olive-quoll-1a1a', t: t } });
	}, NEWER.t - 100);
	await page.waitForTimeout(600);
	const held = await handleOf(page);
	check('an older record does not undo a rename', held === NEWER.h, `showing '${held}'`);

	// ── 7. A tie is broken the same way on both devices ──────────────
	// Same stamp, two names: the smaller name wins, whichever order they arrive
	// in. A tie broken by "keep mine" is two devices that never converge.
	const TIE = NEWER.t;
	const settle = async (first, second) => {
		await page.evaluate(async ([f, s, t]) => {
			await window.DaimondSync.apply({ handle: { v: 1, h: f, t: t } });
			await window.DaimondSync.apply({ handle: { v: 1, h: s, t: t } });
		}, [first, second, TIE]);
		await page.waitForTimeout(400);
		return handleOf(page);
	};
	const one = await settle('mellow-teal-3x3x', 'amber-wren-9q9q');
	const two = await settle('amber-wren-9q9q', 'mellow-teal-3x3x');
	check('a tie settles the same way whichever parcel arrives first',
		one === two && !!one, `${one} vs ${two}`);

	// ── 8. A second device of the same account shows the same name ───
	// Its gateway is mute (every GET is a 500), so the ONLY thing that can tell
	// it the account's name is the parcel.
	const bundle = await page.evaluate(() => window.DaimondIdentity.exportBundle());
	check('the pairing bundle carries the handle', !!(bundle && bundle.hdl && bundle.hdl.h),
		JSON.stringify(bundle && bundle.hdl));

	b = await open({
		name: 'handleb', profile: PROFILE_B, connect: false,
		route: (p) => stub(p, { refuseGet: true }),
	});
	await b.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondSync.parcel),
		null, { timeout: 15000 });
	// B becomes the SAME account: it adopts A's identity bundle and unlocks it
	// with the same passphrase, exactly as a paired device does. The handle is
	// then wiped from B, so what it shows afterwards can only have come from the
	// parcel it is about to be handed.
	const became = await b.page.evaluate(async ([bun, pass]) => {
		const took = window.DaimondIdentity.importBundle(bun);
		const un   = await window.DaimondIdentity.unlock(pass);
		localStorage.removeItem('daimond-id-handle');
		return { took: took, unlocked: !!(un && un.ok), showing: window.DaimondSync.handle() };
	}, [bundle, PASS]);
	check('the second device adopted the identity and holds no name yet',
		became.took && became.unlocked && !became.showing, JSON.stringify(became));

	const parcelA = await page.evaluate(() => window.DaimondSync.parcel());
	await b.page.evaluate(async (p) => { await window.DaimondSync.apply(p); }, parcelA);
	await b.page.waitForTimeout(800);
	const onB = await handleOf(b.page);
	const onA = await handleOf(page);
	check('and the parcel alone gives it the account\'s name', onB === onA && !!onB,
		`A shows '${onA}', B shows '${onB}'`);

	// ── 9. A refusal says WHICH refusal ──────────────────────────────
	// Back to a name the stub's namespace will accept, so the refusals below are
	// about the names asked for and not about where this device had got to.
	await page.evaluate(async () => { await window.DaimondSync.claimHandle('bright-finch-5m5m'); });
	await page.waitForTimeout(400);

	const refusals = await page.evaluate(async ([taken, reserved]) => {
		const out = {};
		out.taken    = await window.DaimondSync.claimHandle(taken);
		out.invalid  = await window.DaimondSync.claimHandle('no');
		out.reserved = await window.DaimondSync.claimHandle(reserved);
		out.after    = window.DaimondSync.handle();
		return out;
	}, [THEIRS, 'admin']);

	check('a name somebody else holds is refused as taken',
		refusals.taken.ok === false && refusals.taken.reason === 'taken',
		JSON.stringify(refusals.taken));
	check('and each refusal carries its own sentence from the catalogue',
		refusals.taken.message    === CATALOGUE['handle.taken']
		&& refusals.invalid.message  === CATALOGUE['handle.invalid']
		&& refusals.reserved.message === CATALOGUE['handle.reserved'],
		[refusals.taken.message, refusals.invalid.message, refusals.reserved.message].join(' | '));
	check('which are three different sentences, not one repeated',
		new Set([refusals.taken.message, refusals.invalid.message, refusals.reserved.message]).size === 3);
	check('and a refused rename leaves the name where it was',
		refusals.after === 'bright-finch-5m5m', `showing '${refusals.after}'`);

	// ── 10. A rename that takes ──────────────────────────────────────
	const renamed = await page.evaluate(async () => {
		const r = await window.DaimondSync.claimHandle('Copper-Marten-8P8P');
		return { r: r, showing: window.DaimondSync.handle() };
	});
	check('a rename takes, folded to what the namespace stores',
		renamed.r.ok === true && renamed.showing === 'copper-marten-8p8p', JSON.stringify(renamed));
	check('and the namespace agrees the account holds it',
		NS.get('copper-marten-8p8p') === ME, `held by ${NS.get('copper-marten-8p8p')}`);
	const afterRename = JSON.parse(await sectionOf(page) || 'null');
	check('and the parcel carries the new name with the gateway\'s stamp',
		afterRename && afterRename.h === 'copper-marten-8p8p' && afterRename.t === mineTs,
		JSON.stringify(afterRename));
	// The third and last place the record is written, and the device's own label
	// has to survive that one too.
	const labelEnd = await page.evaluate(() => window.DaimondIdentity.displayName());
	check('and a rename still leaves the device label alone',
		labelEnd === 'handlea', `device label '${labelEnd}'`);

	// ── 11. Somebody else's name resolves ────────────────────────────
	const found = await page.evaluate(async (h) => window.DaimondSync.lookupHandle(h), THEIRS);
	check('another account\'s handle is readable', found.found === true && found.handle === THEIRS,
		JSON.stringify(found));
	check('and comes with the key fingerprint a share would be checked against',
		found.fingerprint === THEIR_FP, JSON.stringify(found));
	const missing = await page.evaluate(async () => window.DaimondSync.lookupHandle('nobody-here-7z'));
	check('a name nobody holds is a miss, not a crash', missing.found === false,
		JSON.stringify(missing));

	// And nothing THREW on the way past. Failed loads are excluded on purpose:
	// this world has no gateway on :9002, so the endpoints that are not stubbed
	// here -- the wake channel among them -- answer 502, which says nothing about
	// the handle. An exception does.
	const threw = errors(a).concat(b ? errors(b) : [])
		.filter(e => !/Failed to load resource|502|WebSocket/i.test(e));
	check('nothing threw in either page', threw.length === 0, threw.slice(0, 3).join(' | '));

} finally {
	await a.close();
	if (b) await b.close();
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('failed: ' + bad.join(', '));
process.exit(bad.length ? 1 : 0);
