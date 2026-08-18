// dev/verify_post.mjs -- the messaging client: the seal, the five verbs, and the
// ordering that is the whole safety property.
//
// Nine properties, and each one is a thing that could be broken silently:
//
//   1. SEAL AND OPEN BETWEEN TWO IDENTITIES, WITH NO SERVER IN THE PATH AT ALL.
//      Two browsers, two profiles, two identities. The bytes are carried between
//      them by this file. A third identity must NOT be able to open the same
//      envelope, or the seal is decoration.
//   2. ACK AFTER COMMIT. The `?op=ack` request must be made AFTER the sync push
//      that carried the message came back 200, and never before.
//   3. NO COMMIT, NO ACK. A push that 409s is not a commit, and nothing may be
//      acked on the back of it.
//   4. NOT IN THE PARCEL, NO ACK. Where the parcel does not carry the message
//      record, the relay must not be told to let go: the message would be
//      dropped from the only place it exists.
//   5. A ROW THE RELAY WROTE IS NEVER DRAWN AS A PERSON. `kind != "post"` goes
//      to the notices and never to the message list, in the record AND on screen.
//   6. A FULL BOX IS DRAWN HONESTLY. 507 means the message did not arrive, and
//      no Sent copy may be kept.
//   7. A PARK ANSWER WITHOUT `waited` STOPS THE PARKING. A front door that drops
//      the query string turns a park into an unthrottled loop.
//   8. THE TRAY'S THREE BUTTONS, pressed the way a person presses them. Accept
//      and Block reach the relay; IGNORE REACHES IT IN NO WAY AT ALL, or a
//      sender who could tell an ignore from a silence has a presence oracle.
//   9. SENDING THROUGH THE PANEL. The delegated click, the real button, and the
//      words nowhere in what left the browser.
//
// FOUR LINES IN OTHER LANES' FILES WERE ONCE SUPPLIED HERE, by a script tag
// injected from disk and a wrapper hung on `collectSync`. All four have landed,
// and the shims have gone with them -- because a shim that outlives its seam
// stops standing in for the line and starts standing in FRONT of it:
//
//   * `<script src="js/post.js">`  www/index.html:1414   (5c14eea, 9aa963b)
//   * `<script src="js/trust.js">` www/index.html:1411   (5c14eea)
//   * `DaimondCrypto.postDraft`    www/js/daimond.js:201
//   * `state.post = DaimondPost.snapshot()`  www/js/sync.js:715
//
// While `addScriptTag` was loading post.js and trust.js from disk, this suite
// would have passed identically with both script tags deleted from index.html;
// while `wireParcel` was rebuilding the parcel, §2, §3 and §5 onwards proved
// nothing whatever about sync.js. §0 now asserts all four are real, and every
// section below runs on the page as the browser assembles it.
//
// `#social-messages-list` is likewise never built here: the Social panel already
// carries it, and a verifier that built its own region would pass on a panel
// that had none.
//
//   node dev/verify_post.mjs

import { open, errors } from './harness.mjs';

// NO PATHS TO post.js OR trust.js. They were here to read the files off disk and
// inject them; a file this suite can reach without the browser reaching it is
// the shape the shims took, and there is nothing left to point at.

/// Console errors that are the PAGE's fault. A 502 from a gateway this fixture
/// never started is the fixture, not the panel, and counting it would make this
/// assertion fail for a reason that has nothing to do with what is being tested.
function thrown(s) {
	return errors(s).filter(e => !/Failed to load resource/.test(e));
}

let failures = 0;
function ok(cond, what, detail) {
	if (cond) { console.log(`  ok    ${what}`); return true; }
	failures++;
	console.log(`  FAIL  ${what}${detail !== undefined ? `  -- ${JSON.stringify(detail)}` : ''}`);
	return false;
}
function eq(got, want, what) {
	return ok(JSON.stringify(got) === JSON.stringify(want), what, { got, want });
}

// ── The seams, asserted rather than supplied ─────────────────

/// Wait for the page the browser assembled, and refuse to test a page that is
/// missing a piece rather than quietly building the piece.
///
/// Nothing is injected here. `waitForFunction` only waits for a tag in
/// `index.html` to have run; if the tag is gone this throws, §0 says which seam,
/// and the section is a failure rather than a pass on an injected copy.
async function ready(s) {
	await s.page.waitForFunction(
		() => !!window.DaimondPost && !!window.DaimondTrust
			&& !!document.querySelector('#social-messages-list'),
		null, { timeout: 15000 }
	).catch(() => { throw new Error(
		'the page did not assemble: post.js, trust.js or #social-messages-list is '
		+ 'missing from www/index.html. Run section 0 for which.'); });
}

/// 0. The four seams this file used to supply for itself.
///
/// Read off the page and off `index.html` itself, because a global can be put
/// there by anything and a script tag cannot. This runs FIRST: every section
/// below is only evidence about the shipped app if these hold.
async function seamsAreReal() {
	console.log('\n0. the seams are in the app, not in this file');
	const s = await open({ name: 'post-seams', connect: false });
	try {
		const seen = await s.page.evaluate(async () => {
			const html = await (await fetch('/index.html')).text();
			// A SCRIPT TAG, not the string: index.html carries comments naming both
			// files, and matching those would report a tag present for a build that
			// never loaded it.
			const tag = n => new RegExp('<script[^>]+src=["\']js/' + n + '\\.js["\']').test(html);
			// What `collectParcel` really returns, through sync.js's own door.
			// GUARDED, because a missing script tag is exactly what this section
			// exists to report: a TypeError here would abort §0 and the run would
			// say "seams threw" instead of naming which seam is gone.
			let parcel = null;
			try {
				await window.DaimondIdentity.ensureSealingKey();
				await window.DaimondPost.read();
				parcel = await window.DaimondSync.parcel();
			} catch (e) { parcel = null; }
			return {
				tagPost:  tag('post'),
				tagTrust: tag('trust'),
				post:   !!window.DaimondPost,
				trust:  !!window.DaimondTrust,
				bridge: !!(window.DaimondCrypto
					&& typeof window.DaimondCrypto.postDraft === 'function'),
				host:   !!document.querySelector('#social-messages-list'),
				carries: !!(parcel && parcel.post && parcel.post.v),
			};
		});
		ok(seen.tagPost,  'www/index.html carries a script tag for js/post.js');
		ok(seen.tagTrust, 'www/index.html carries a script tag for js/trust.js');
		ok(seen.post,  'and post.js ran, so DaimondPost is on the page unaided');
		ok(seen.trust, 'and trust.js ran, so DaimondTrust is too');
		ok(seen.bridge, 'daimond.js\'s bridge publishes postDraft');
		ok(seen.host, '#social-messages-list is in the Social panel');
		// The line whose absence §4 and §4b used to be measuring. Read through
		// `DaimondSync.parcel()`, which is what `push()` sends, not a reconstruction.
		ok(seen.carries, 'sync.js\'s collectParcel carries the message record', seen);
	} finally { await s.close(); }
}

/// Take the message record off the parcel, the way a locked identity does.
///
/// `snapshot()` answering null is the REAL cause in the field, and sync.js's own
/// `if (pst) state.post = pst` then leaves the section off -- so the strip runs
/// through the shipped line rather than around it. Deleting `state.post` from a
/// wrapper on `DaimondCore.collectSync` would do nothing at all: `collectParcel`
/// calls `collectSync` and adds the section AFTERWARDS (www/js/sync.js:657,715).
async function stripPostFromParcel(s) {
	await s.page.evaluate(() => {
		if (!window.__postSnapReal) window.__postSnapReal = window.DaimondPost.snapshot;
		window.DaimondPost.snapshot = function () { return null; };
	});
}

/// Put it back. `delete` would NOT do this: `snapshot` is an own property of the
/// published object, so deleting it leaves sync.js calling `undefined()`.
async function restorePostToParcel(s) {
	await s.page.evaluate(() => {
		if (window.__postSnapReal) window.DaimondPost.snapshot = window.__postSnapReal;
	});
}

// ── A relay in the test, so the ordering can be watched ──────
//
// The gateway's own half has its own tests in `gateway/src/handlers/post.rs`.
// What is unproven, and what this watches, is the CLIENT's ordering: which
// request it makes, and after what.

/// Install a mock relay and a mock sync mailbox, and hand back the log.
async function mockServer(s, cfg = {}) {
	const log = [];
	s.page.on('request', () => {});
	await s.page.route('**/api/post*', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const op  = url.searchParams.get('op') || '';
		const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null;
		log.push({ what: op || (req.method() === 'GET'
			? (url.searchParams.has('above') ? 'park' : 'collect') : 'deliver'), body });
		if (req.method() === 'GET' && url.searchParams.has('above')) {
			return route.fulfill({ status: 200, contentType: 'application/json',
				body: JSON.stringify(cfg.park || { ok: true, waited: true, seq: 0, changed: false }) });
		}
		if (req.method() === 'GET') {
			const since = Number(url.searchParams.get('since') || 0);
			const rows  = (cfg.rows || []).filter(r => r.seq > since);
			return route.fulfill({ status: 200, contentType: 'application/json',
				body: JSON.stringify({ ok: true, seq: rows.length ? rows[rows.length - 1].seq : since,
					rows, more: false }) });
		}
		if (op === 'ack') {
			return route.fulfill({ status: 200, contentType: 'application/json',
				body: JSON.stringify({ ok: true, dropped: 1 }) });
		}
		if (op === 'connect') {
			return route.fulfill({ status: 200, contentType: 'application/json',
				body: JSON.stringify({ ok: true }) });
		}
		// A delivery.
		if (cfg.deliverStatus && cfg.deliverStatus !== 200) {
			return route.fulfill({ status: cfg.deliverStatus, contentType: 'application/json',
				body: JSON.stringify({ ok: false, error: 'no' }) });
		}
		return route.fulfill({ status: 200, contentType: 'application/json',
			body: JSON.stringify({ ok: true, accepted: true }) });
	});

	let version = 1;
	await s.page.route('**/api/sync*', async (route) => {
		const req = route.request();
		if (req.method() !== 'POST') {
			return route.fulfill({ status: 200, contentType: 'application/json',
				body: JSON.stringify({ ok: true, version, blob: '' }) });
		}
		log.push({ what: 'sync-push' });
		if (cfg.pushStatus && cfg.pushStatus !== 200) {
			return route.fulfill({ status: cfg.pushStatus, contentType: 'application/json',
				body: JSON.stringify({ ok: false }) });
		}
		version += 1;
		return route.fulfill({ status: 200, contentType: 'application/json',
			body: JSON.stringify({ ok: true, version }) });
	});
	return log;
}

/// Put sync.js into the state a signed-in Pro account is in, so `push()` really
/// runs. The harness opens with no gateway, so `ready()` is false and a push
/// returns before it makes a request -- which would make every ordering
/// assertion below pass without a push ever happening.
///
/// `recheck()` is sync.js's own door for exactly this ("a Pro purchase just
/// landed"), so nothing here reaches inside the module; the only thing faked is
/// the gateway saying there is a session.
async function entitle(s) {
	await s.page.evaluate(async () => {
		const st = window.DaimondGateway.state;
		window.DaimondGateway.state = () => Object.assign({}, st(), { authed: true });
		window.DaimondSync.wakeVia('off');		// no channel noise on the request log
		window.DaimondSync.recheck();
		await new Promise(r => setTimeout(r, 300));
	});
	// And prove it took, rather than assuming: a push that cannot run is the one
	// way every ordering assertion here passes for the wrong reason.
	const live = await s.page.evaluate(async () => {
		const before = window.DaimondSync.version();
		await window.DaimondSync.push();
		return { before, after: window.DaimondSync.version() };
	});
	if (!(live.after > live.before)) {
		throw new Error(`sync.push() does not reach the wire in this fixture: ${JSON.stringify(live)}`);
	}
}

// ── 1. The seal, between two identities, with no server at all ──

async function sealBetweenTwoIdentities() {
	console.log('\n1. seal and open between two identities, no server in the path');
	const a = await open({ name: 'post-a', connect: false });
	const b = await open({ name: 'post-b', connect: false });
	const c = await open({ name: 'post-c', connect: false });
	try {
		for (const s of [a, b, c]) await ready(s);

		// Both identities make a sealing key and a card. Nothing crosses a wire:
		// the card's bytes are carried by this file, which is what a QR code does.
		const card = async (s) => s.page.evaluate(async () => {
			await window.DaimondIdentity.ensureSealingKey();
			await window.DaimondIdentity.mintCard();
			return {
				card: window.DaimondIdentity.card(),
				text: window.DaimondTrust.cardText(),
				pub:  window.DaimondIdentity.publicKeyB64url(),
			};
		});
		const A = await card(a), B = await card(b), C = await card(c);
		ok(!!A.card && !!B.card && !!C.card, 'three identities each minted a card');

		// A reads B's card, exactly as a paste hands it over, through trust.js --
		// the module that owns the log and re-verifies every signature on replay.
		const taken = await a.page.evaluate(async (text) => {
			const card = window.DaimondTrust.parse(text);
			if (!card) return { ok: false, why: 'the card did not parse' };
			await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.PASTE);
			await window.DaimondPost.refreshPeople();
			const who = window.DaimondPost.people();
			return { ok: who.length === 1, who };
		}, B.text);
		ok(taken.ok, 'A took B\'s card and holds a sealing key for them', taken);
		eq(taken.who && taken.who[0] && taken.who[0].pub, B.pub,
			'the card names B\'s own signing key');

		// A composes, signs and seals. The relay is not involved and is not up.
		const TEXT = 'The file view scrolls to the wrong line — twice, on a phone.';
		const made = await a.page.evaluate(async ([to, text]) => {
			const m = await window.DaimondPost.compose({ body: text, to });
			return { addr: m.addr, envelope: m.envelope };
		}, [B.pub, TEXT]);
		ok(!!made.addr && !!made.envelope, 'A sealed a message', { addr: made.addr });

		// B opens it. The verification -- envelope, address, signature -- runs
		// inside `DaimondCrypto.read`, on B's own device.
		const got = await b.page.evaluate(async ([env, addr]) => {
			try { return { ok: true, got: await window.DaimondPost.open(env, addr) }; }
			catch (e) { return { ok: false, why: String(e && e.message || e) }; }
		}, [made.envelope, made.addr]);
		ok(got.ok, 'B opened it', got.why);
		if (got.ok) {
			eq(got.got.post.body, TEXT, 'the text B reads is the text A wrote');
			eq(got.got.address, made.addr, 'the address B computes is the address A did');
			// The author is A's signing key, and the signature over it verified.
			const authorPubB64url = await b.page.evaluate((hexKey) => {
				const u8 = new Uint8Array(hexKey.length / 2);
				for (let i = 0; i < u8.length; i++) u8[i] = parseInt(hexKey.substr(i * 2, 2), 16);
				let s = ''; for (const x of u8) s += String.fromCharCode(x);
				return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
			}, got.got.author);
			eq(authorPubB64url, A.pub, 'the signature verifies under A\'s key and nobody else\'s');
		}

		// The negative that makes the positive mean something.
		const stranger = await c.page.evaluate(async (env) => {
			try { await window.DaimondPost.open(env); return { opened: true }; }
			catch (e) { return { opened: false, why: String(e && e.message || e) }; }
		}, made.envelope);
		ok(!stranger.opened, 'a third identity cannot open the same envelope', stranger);
		// FOR THE RIGHT REASON. C holds a sealing key and a full bridge, so a
		// refusal about either would be this assertion passing on an accident.
		ok(/not sealed to any key/i.test(stranger.why || ''),
			'and is refused because no slot is theirs, not because it could not try',
			stranger.why);

		// And a message addressed to B does not become a message to A, however it
		// is re-slotted: the payload's `to` is signed. A's own Sent slot DOES open
		// the seal -- so the refusal must come from the signed `to` and nowhere
		// else, which is what the sentence is checked for.
		const backToA = await a.page.evaluate(async (env) => {
			try { await window.DaimondPost.open(env); return { opened: true }; }
			catch (e) { return { opened: false, why: String(e && e.message || e) }; }
		}, made.envelope);
		ok(!backToA.opened, 'A\'s own Sent slot opens but does not pass as a message TO A',
			backToA);
		ok(/addressed to a different key/i.test(backToA.why || ''),
			'and the refusal is the signed `to`, not a seal that would not open',
			backToA.why);
	} finally {
		await a.close(); await b.close(); await c.close();
	}
}

// ── 2-4. The ordering ────────────────────────────────────────

/// One collected message, sealed to this session's own identity, as a row.
async function selfRow(s, seq = 1, { kind = 'post', tray = false } = {}) {
	return await s.page.evaluate(async ([seq, kind, tray]) => {
		await window.DaimondIdentity.ensureSealingKey();
		const to = window.DaimondIdentity.publicKeyB64url();
		const m = await window.DaimondPost.compose({ body: 'a message to myself', to });
		return {
			seq, kind, addr: m.addr, from_pub: to, ts: Math.floor(Date.now() / 1000),
			bytes: m.envelope.length, tray, expired: false, envelope: m.envelope,
		};
	}, [seq, kind, tray]);
}

async function ackAfterCommit() {
	console.log('\n2. the ack is made AFTER the push that carried it committed');
	const s = await open({ name: 'post-ack', connect: false });
	try {
		await ready(s);
		const row = await selfRow(s, 1);
		const cfg = { rows: [row] };
		const log = await mockServer(s, cfg);
		await entitle(s);
		log.length = 0;					// forget the traffic entitling made

		const r = await s.page.evaluate(() => window.DaimondPost.round());
		ok(r.ok && r.got === 1, 'one message was collected', r);
		eq(r.acked, 1, 'the relay was told it may let go through sequence 1');

		const order = log.map(e => e.what);
		const iPush = order.lastIndexOf('sync-push');
		const iAck  = order.indexOf('ack');
		ok(iAck >= 0, 'an ack was sent', order);
		ok(iPush >= 0 && iAck > iPush,
			'the ack came AFTER the parcel push, not before', order);
		const ackBody = (log.find(e => e.what === 'ack') || {}).body;
		eq(ackBody, { through: 1 }, 'the ack names exactly the sequence that was folded');
	} finally { await s.close(); }
}

async function noCommitNoAck() {
	console.log('\n3. a push that did not commit acks nothing');
	const s = await open({ name: 'post-nocommit', connect: false });
	try {
		await ready(s);
		const row = await selfRow(s, 1);
		const cfg = { rows: [row] };
		const log = await mockServer(s, cfg);
		// Entitled while the push still works, so this test cannot pass because a
		// push never happened -- which is the trap. THEN the mailbox starts
		// answering 409: another device moved it on, and that is not a commit.
		await entitle(s);
		cfg.pushStatus = 409;
		log.length = 0;

		const r = await s.page.evaluate(() => window.DaimondPost.round());
		ok(r.got === 1, 'the message was still collected', r);
		eq(r.acked, 0, 'nothing was acked');
		eq(r.why, 'not_committed', 'and the reason given is that the push did not commit');
		ok(!log.some(e => e.what === 'ack'), 'no ack request left the browser at all',
			log.map(e => e.what));
		ok(log.some(e => e.what === 'sync-push'),
			'and a push WAS attempted, so this is a refused commit and not an absent one',
			log.map(e => e.what));
		const st = await s.page.evaluate(() => window.DaimondPost.state());
		ok(st.through === 1 && st.acked === 0,
			'the message is folded and unacked, so the relay still holds it', st);
	} finally { await s.close(); }
}

async function notInParcelNoAck() {
	console.log('\n4. a parcel that does not carry the record acks nothing');
	const s = await open({ name: 'post-noparcel', connect: false });
	try {
		await ready(s);
		const row = await selfRow(s, 1);
		const log = await mockServer(s, { rows: [row] });
		await entitle(s);
		// STRIPPED DELIBERATELY, and only now -- after `entitle` has proved a push
		// reaches the wire against a parcel that DID carry the record. This section
		// used to rely on the record simply not being there, which was true of the
		// tree it was written in; when sync.js:715 landed the section stopped
		// simulating anything and the ack correctly fired. A test whose premise the
		// code has since fixed does not become a bug report, it becomes a stale
		// test, and it read as seven failures in post.js for a month.
		await stripPostFromParcel(s);
		log.length = 0;

		const r = await s.page.evaluate(() => window.DaimondPost.round());
		ok(r.got === 1, 'the message was collected', r);
		eq(r.acked, 0, 'nothing was acked');
		eq(r.why, 'not_in_parcel', 'and the reason names the section the parcel is missing');
		ok(!log.some(e => e.what === 'ack'), 'no ack request left the browser at all',
			log.map(e => e.what));
		// The control: without the strip, this same fixture DOES ack. Otherwise
		// every assertion above would pass on a fixture that never collects.
		await restorePostToParcel(s);
		const back = await s.page.evaluate(() => window.DaimondPost.ack());
		ok(back.acked === 1 && !back.why,
			'and with the record back on the parcel the very same fixture acks -- '
			+ 'so the refusal above is the strip and not a fixture that cannot ack', back);
	} finally { await s.close(); }
}

async function committedButNotCarriedNoAck() {
	console.log('\n4b. a push that DID commit, carrying everything but the record, acks nothing');
	const s = await open({ name: 'post-carried', connect: false });
	try {
		await ready(s);
		// The parcel changes on every collect and commits every time -- but it does
		// not carry the message record. Without the parcel read-back this is the
		// case that acks messages sitting on no parcel anywhere and loses them:
		// the version check alone cannot see it, because the version really did
		// move. It is the state a locked identity produces, since `snapshot()`
		// answers null and the section is left off.
		await s.page.evaluate(() => {
			const orig = window.DaimondCore.collectSync;
			window.DaimondCore.collectSync = async function () {
				const state = await orig.call(window.DaimondCore);
				state.__churn = Date.now() + Math.random();
				return state;
			};
		});
		const row = await selfRow(s, 1);
		const log = await mockServer(s, { rows: [row] });
		await entitle(s);
		// The churn alone no longer strips the record, and `delete state.post`
		// inside that wrapper would not either: `collectParcel` calls `collectSync`
		// and adds the section AFTERWARDS (www/js/sync.js:657, :715), so a wrapper
		// underneath it is deleting a key that has not been written yet. The strip
		// has to be where sync.js reads from, which is `snapshot()`.
		await stripPostFromParcel(s);
		log.length = 0;

		const r = await s.page.evaluate(() => window.DaimondPost.round());
		ok(r.got === 1, 'the message was collected', r);
		// The push in `entitle` already committed against this same churning
		// parcel, so a commit is demonstrably available here and the version has
		// demonstrably moved. Remove the parcel read-back and the ack fires on it.
		const version = await s.page.evaluate(() => window.DaimondSync.version());
		ok(version > 1, 'a commit against this parcel is available -- the version has moved',
			version);
		eq(r.acked, 0, 'and still nothing was acked');
		eq(r.why, 'not_in_parcel', 'because the parcel does not carry the record');
		ok(!log.some(e => e.what === 'sync-push'),
			'the refusal came before the push, so no round was spent on it',
			log.map(e => e.what));
		ok(!log.some(e => e.what === 'ack'), 'no ack request left the browser at all',
			log.map(e => e.what));
	} finally { await s.close(); }
}

// ── 5. A relay row is never a person ─────────────────────────

async function relayRowIsNeverAMessage() {
	console.log('\n5. a row the relay wrote is never drawn as a message from a person');
	const s = await open({ name: 'post-kind', connect: false });
	try {
		await ready(s);
		// A row that carries a perfectly good envelope AND a kind the relay writes.
		// If `kind` were ignored, this would open and draw as an ordinary message.
		const good = await selfRow(s, 1);
		const forged = Object.assign({}, good, { seq: 2, kind: 'expiry' });
		await mockServer(s, { rows: [forged] });
		await entitle(s);

		const r = await s.page.evaluate(() => window.DaimondPost.round());
		ok(r.ok, 'the collect ran', r);
		const st = await s.page.evaluate(() => ({
			msgs:    window.DaimondPost.list().length,
			notices: window.DaimondPost.notices().length,
			drawnMsgs:    document.querySelectorAll('#social-messages-list .post-msg').length,
			drawnNotices: document.querySelectorAll('#social-messages-list .post-notice').length,
			// The panel's own "not switched on" line, which must be gone once this
			// module has drawn: an empty region and an absent one read alike, and
			// this is what tells them apart.
			offLine: (document.getElementById('social-messages-off') || {}).hidden,
		}));
		// Counted rather than asserted absent: an empty region and a missing region
		// read the same to a locator, so the notice count is what proves the panel
		// drew at all.
		eq(st.msgs, 0, 'the record holds no message for it');
		eq(st.notices, 1, 'the record holds it as a notice');
		eq(st.drawnMsgs, 0, 'nothing was drawn as a message');
		eq(st.drawnNotices, 1, 'and it WAS drawn, as a notice');
		eq(st.offLine, true, 'and the panel has stopped saying messages are not switched on');
	} finally { await s.close(); }
}

// ── 8. The panel's own buttons ───────────────────────────────

/// One collected message from this session's own key, with a distinct body so
/// two rows are two addresses.
async function selfRowText(s, seq, text, opts = {}) {
	return await s.page.evaluate(async ([seq, text, tray]) => {
		await window.DaimondIdentity.ensureSealingKey();
		const to = window.DaimondIdentity.publicKeyB64url();
		const m = await window.DaimondPost.compose({ body: text, to });
		return {
			seq, kind: 'post', addr: m.addr, from_pub: to,
			ts: Math.floor(Date.now() / 1000), bytes: m.envelope.length,
			tray, expired: false, envelope: m.envelope,
		};
	}, [seq, text, !!opts.tray]);
}

async function trayButtons() {
	console.log('\n8. the tray\'s three buttons, pressed the way a person presses them');
	const s = await open({ name: 'post-tray', connect: false });
	try {
		await ready(s);
		const r1 = await selfRowText(s, 1, 'first request', { tray: true });
		const r2 = await selfRowText(s, 2, 'second request', { tray: true });
		const cfg = { rows: [r1, r2] };
		const log = await mockServer(s, cfg);
		await entitle(s);
		log.length = 0;

		// The panel, opened at Messages the way a reference chip opens it. This
		// runs `DaimondSocial.show`, which calls every lane's `watch` -- so the
		// collect below is triggered by the app and not by the test.
		await s.page.evaluate(() => window.DaimondSocial.open('messages'));
		await s.page.waitForTimeout(900);
		const drawn = await s.page.evaluate(() => ({
			reqs: document.querySelectorAll('#social-messages-list .post-req').length,
			msgs: document.querySelectorAll('#social-messages-list .post-msg').length,
		}));
		eq(drawn.reqs, 2, 'both rows are drawn as requests');
		eq(drawn.msgs, 0, 'and neither is in the message list yet');

		// ACCEPT: a real click on a real button, through the delegated listener.
		await s.page.click('#social-messages-list .post-req [data-act="post-accept"]');
		await s.page.waitForTimeout(400);
		const conn = log.filter(e => e.what === 'connect');
		eq(conn.length, 1, 'accepting made exactly one connect request');
		eq(conn[0].body && conn[0].body.action, 'accept', 'and it asked to accept');
		ok(!!(conn[0].body && conn[0].body.peer), 'naming the peer by key', conn[0].body);

		// Accepting is about the PERSON, not the row: both of this sender's
		// requests leave the tray, because what was missing was consent to hear
		// from them at all.
		const accepted = await s.page.evaluate(() => ({
			reqs: document.querySelectorAll('#social-messages-list .post-req').length,
			msgs: document.querySelectorAll('#social-messages-list .post-msg').length,
			tray: window.DaimondPost.tray().length,
		}));
		eq(accepted.tray, 0, 'both of that sender\'s requests left the tray');
		eq(accepted.msgs, 2, 'and both are in the message list');

		// IGNORE: writes nothing, calls nothing, tells nobody. A request here
		// would hand the sender a presence oracle, which is why there is no
		// `ignore` action on the relay at all.
		const r3 = await selfRowText(s, 3, 'third request', { tray: true });
		cfg.rows.push(r3);
		await s.page.evaluate(() => window.DaimondPost.collect());
		await s.page.waitForTimeout(500);
		eq(await s.page.evaluate(() =>
			document.querySelectorAll('#social-messages-list .post-req').length), 1,
			'a fresh request is drawn in the tray');
		log.length = 0;
		await s.page.click('#social-messages-list .post-req [data-act="post-ignore"]');
		await s.page.waitForTimeout(400);
		// NOTHING REACHED THE RELAY. A park is the channel breathing, and a parcel
		// push carries the ignore between this account's OWN devices under its own
		// key -- neither is a thing the sender can observe. Any relay verb would
		// be: a sender who could tell an ignore from a silence has been handed a
		// presence oracle, which is why the relay has no `ignore` action at all.
		const acts = log.filter(e => e.what !== 'park' && e.what !== 'sync-push');
		eq(acts.map(e => e.what), [], 'ignoring reached the relay in no way at all');
		const after = await s.page.evaluate(() => ({
			reqs: document.querySelectorAll('#social-messages-list .post-req').length,
			msgs: document.querySelectorAll('#social-messages-list .post-msg').length,
			tray: window.DaimondPost.tray().length,
		}));
		eq(after.reqs, 0, 'and the tray is empty on screen');
		eq(after.tray, 0, 'and in the record');
		eq(after.msgs, 2, 'and the ignored one is not in the message list either');
		eq(thrown(s), [], 'and the panel threw nothing while doing it');
	} finally { await s.close(); }
}

// ── 9. Sending, through the panel ────────────────────────────

async function sendThroughThePanel() {
	console.log('\n9. a message sent by pressing the panel\'s own button');
	const s = await open({ name: 'post-send', connect: false });
	try {
		await ready(s);
		const log = await mockServer(s, {});
		// Somebody to write to. A's own card into A's own log is the cheapest real
		// person there is, and the message is a note to self.
		await s.page.evaluate(async () => {
			await window.DaimondIdentity.ensureSealingKey();
			await window.DaimondIdentity.mintCard();
			const card = window.DaimondTrust.parse(window.DaimondTrust.cardText());
			await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.PASTE);
		});
		await s.page.evaluate(() => window.DaimondSocial.open('messages'));
		await s.page.waitForTimeout(900);

		const picker = await s.page.$('#post-to');
		ok(!!picker, 'the box offers somebody to write to');
		await s.page.fill('#post-text', 'Sent by pressing the button.');
		await s.page.click('#social-messages-list [data-act="post-send"]');
		await s.page.waitForTimeout(600);

		const sent = log.filter(e => e.what === 'deliver');
		eq(sent.length, 1, 'one envelope was delivered');
		const body = sent[0].body || {};
		ok(!!body.to && !!body.addr && !!body.envelope,
			'and it carried `to`, `addr` and `envelope`', Object.keys(body));
		ok(!/Sent by pressing/.test(JSON.stringify(body)),
			'and the words are NOWHERE in what left the browser');
		const note = await s.page.evaluate(() =>
			(document.getElementById('post-note') || {}).textContent || '');
		ok(/sent/i.test(note), 'the panel says it went', note);
		const box = await s.page.evaluate(() =>
			(document.getElementById('post-text') || {}).value);
		eq(box, '', 'and the box was cleared');
		eq(thrown(s), [], 'and the panel threw nothing while doing it');
	} finally { await s.close(); }
}

// ── 6. A full box ────────────────────────────────────────────

async function fullBoxIsHonest() {
	console.log('\n6. a full box is drawn honestly, and keeps no Sent copy');
	const s = await open({ name: 'post-full', connect: false });
	try {
		await ready(s);
		await mockServer(s, { deliverStatus: 507 });
		const to = await s.page.evaluate(async () => {
			await window.DaimondIdentity.ensureSealingKey();
			return window.DaimondIdentity.publicKeyB64url();
		});
		const r = await s.page.evaluate(async (to) =>
			await window.DaimondPost.send({ body: 'hello', to }), to);
		ok(r.ok === false, 'the send answered that it did not arrive', r);
		ok(/full/i.test(r.why || ''), 'and the sentence says the box is full', r.why);
		const kept = await s.page.evaluate(() => window.DaimondPost.list().length);
		eq(kept, 0, 'no Sent copy was kept for a message that did not arrive');
	} finally { await s.close(); }
}

// ── 7. A park without `waited` ───────────────────────────────

async function parkWithoutWaitedStops() {
	console.log('\n7. a park answer without `waited` stops the parking');
	const s = await open({ name: 'post-park', connect: false });
	try {
		await ready(s);
		// An ordinary collect answer served to a park: what a front door that drops
		// the query string produces. It is `ok`, it is 200, and it has no `waited`.
		const log = await mockServer(s, { park: { ok: true, seq: 0, rows: [], more: false } });
		await s.page.evaluate(() => window.DaimondPost.parkStart());
		await s.page.waitForTimeout(1200);
		const first = await s.page.evaluate(() => window.DaimondPost.parking());
		ok(first.on === false, 'parking turned itself off', first);
		eq(first.off, 'no_park', 'and named the reason');
		const parksThen = log.filter(e => e.what === 'park').length;
		await s.page.waitForTimeout(1500);
		const parksNow = log.filter(e => e.what === 'park').length;
		eq(parksNow, parksThen, 'and made no further parks');
		ok(parksThen <= 2, 'it stopped on the first such answer, not after a run of them',
			parksThen);
	} finally { await s.close(); }
}

// ── Run ──────────────────────────────────────────────────────

const only = process.argv[2] || '';
const all = [
	// FIRST. Everything below is evidence about the shipped app only if the app
	// is what the browser assembled, so the seams are asked about before anything
	// is measured through them.
	['seams',   seamsAreReal],
	['seal',    sealBetweenTwoIdentities],
	['ack',     ackAfterCommit],
	['nocommit', noCommitNoAck],
	['noparcel', notInParcelNoAck],
	['carried',  committedButNotCarriedNoAck],
	['kind',    relayRowIsNeverAMessage],
	['full',    fullBoxIsHonest],
	['park',    parkWithoutWaitedStops],
	['tray',    trayButtons],
	['panelsend', sendThroughThePanel],
];
for (const [name, fn] of all) {
	if (only && only !== name) continue;
	try { await fn(); }
	catch (e) { failures++; console.log(`  FAIL  ${name} threw: ${e && e.stack || e}`); }
}
console.log(failures ? `\n${failures} failure(s)` : '\nall properties hold');
process.exit(failures ? 1 : 0);
