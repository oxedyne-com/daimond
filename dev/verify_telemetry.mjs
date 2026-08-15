// verify_telemetry.mjs — beta telemetry carries numbers, and never a word of anybody's.
//
// The promise this file defends is the one Daimond is sold on: your content does
// not reach our server. A beta tester agrees to usage and failure counts; they do
// not agree to a chat fragment arriving inside a stack trace, or a Diamond's name
// arriving inside a "what were you doing" box. So the design has no string field
// at all, and this proves that AT THE NETWORK rather than by reading the code.
//
// ── What is proved, and what could fake it ──────────────────────────
//
// A negative check is the easiest kind to fake, and this file's most important
// check is negative. Three things guard against a green for the wrong reason:
//
//   1. THE MARKERS ARE PROVED PRESENT FIRST. A distinctive string is typed into
//      a chat, given to a Diamond as its name, and used as a file path -- and
//      each is then read back out of the running app before anything is asserted
//      about the wire. "No marker on the wire" is worthless if the marker was
//      never in the app.
//
//   2. THE BATCH IS PROVED TO HAVE LEFT. "No content in the telemetry request"
//      is trivially true when there is no telemetry request. The consented pass
//      asserts a batch went, and asserts the codes in it are exactly the ones
//      emitted after consent.
//
//   3. THE CHECK IS PROVED RED IN THE SAME RUN. Two further passes serve a
//      DELIBERATELY BROKEN `telemetry.js` -- one that appends an on-screen chat
//      message to the outgoing body, and one that consents to itself at load --
//      and this file fails unless the leak check fires on the first and the
//      before-consent check fires on the second. Each break is SERVED AT
//      `js/telemetry.js` in place of the file on disk, so nothing is edited and
//      anybody can re-run it -- see `serveModule`, and the incident in its
//      comment for why it is a route and no longer an init script.
//
// ── Running it ──────────────────────────────────────────────────────
//
//	bash dev/world.sh 5 --up
//	eval "$(bash dev/world.sh 5 --env)"
//	node dev/verify_telemetry.mjs
//	bash dev/world.sh 5 --down
//
// Headless. The gateway does NOT need to be running: this is a check on what
// leaves the browser, and a batch that reaches a closed port has still left.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { open, chat, transcript, scratch, APP } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC_JS = path.join(ROOT, 'www/js/telemetry.js');
const SRC_RS = path.join(ROOT, 'gateway/src/handlers/telemetry.rs');

// The two break passes at the end prove the negatives fire, on every run. These
// flags do the same thing the other way round -- they break the build the MAIN
// passes drive -- so the headline checks can be SEEN red rather than only
// inferred red from a later pass going green:
//
//	node dev/verify_telemetry.mjs --break=note     # the no-content check must fail
//	node dev/verify_telemetry.mjs --break=consent  # the before-consent check must fail
//	node dev/verify_telemetry.mjs --break=narrow   # the build-ordinal checks must fail
//	node dev/verify_telemetry.mjs --break=halfway  # the queued-batch check must fail
//	node dev/verify_telemetry.mjs --break=eager    # the withdrawal-survives-a-reload check must fail
//	node dev/verify_telemetry.mjs --break=forget   # the consent-survives-a-reload check must fail
//	node dev/verify_telemetry.mjs --break=inert    # the something-emits check must fail
//	node dev/verify_telemetry.mjs --break=undisclosed  # the policy check must fail
const BREAK = (process.argv.find((a) => a.startsWith('--break=')) || '').split('=')[1] || '';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// Distinctive enough that nothing else in the app or the suite could produce
// them, so a hit is a leak and never a coincidence.
const MARK = {
	chat:    'ZQXJ7731-what-I-typed-in-confidence',
	diamond: 'ZQXJ7731-Diamond-Name',
	file:    'zqxj7731-private-note.md',
	body:    'ZQXJ7731-the-contents-of-my-file',
};
const MARKERS = Object.values(MARK);

// ── The wire, read as a stranger would read it ──────────────────────

/// Is this request going to Daimond's own origin?
///
/// The model provider is deliberately excluded. A prompt reaching the provider
/// the user chose is the product working; a prompt reaching OUR origin is the
/// promise broken, and those are different facts that must not be conflated.
const appOrigin = new URL(APP).origin;
const toApp = (r) => { try { return new URL(r.url).origin === appOrigin; } catch { return false; } };
const toTelemetry = (r) => { try { return toApp(r) && new URL(r.url).pathname === '/api/telemetry'; }
	catch { return false; } };

/// Every place a marker turned up in what left the browser for our origin.
///
/// Both the address and the body: a payload smuggled in a query string is still
/// a payload, which is why the URL is searched too.
function leaks(requests, only) {
	const out = [];
	for (const r of requests.filter(only)) {
		const hay = r.url + '\n' + (r.body || '');
		for (const m of MARKERS) {
			if (hay.indexOf(m) !== -1) out.push(`${m} in ${new URL(r.url).pathname}`);
		}
	}
	return out;
}

/// Is this parsed body numbers all the way down, with no key outside the
/// declared set? Stated here rather than borrowed from the module under test,
/// so a module that redefined its own rules could not redefine the check.
const KEYS = ['v', 'b', 'l', 'w', 't', 'd', 'e'];
function shapeFaults(body) {
	const faults = [];
	let j;
	try { j = JSON.parse(body); } catch (e) { return ['the body is not JSON']; }
	if (!j || typeof j !== 'object' || Array.isArray(j)) return ['the body is not an object'];
	const isInt = (x) => typeof x === 'number' && Number.isInteger(x) && x >= 0;
	for (const k of Object.keys(j)) {
		if (KEYS.indexOf(k) === -1) { faults.push(`the field "${k}" is not one of ${KEYS.join(',')}`); continue; }
		if (k === 'e') {
			if (!Array.isArray(j.e)) { faults.push('"e" is not a list'); continue; }
			j.e.forEach((row, i) => {
				if (!Array.isArray(row) || row.length !== 3 || !row.every(isInt)) {
					faults.push(`event ${i} is not three whole numbers: ${JSON.stringify(row)}`);
				}
			});
		} else if (!isInt(j[k])) {
			faults.push(`"${k}" is ${JSON.stringify(j[k])}, which is not a whole number`);
		}
	}
	return faults;
}

/// The event codes a captured batch carried.
function codesIn(requests) {
	const seen = new Set();
	for (const r of requests.filter(toTelemetry)) {
		try { (JSON.parse(r.body).e || []).forEach((row) => seen.add(row[0])); } catch (e) { /* not ours */ }
	}
	return seen;
}

// ── The breaks, served rather than written to disk ──────────────────

/// A `telemetry.js` that appends the user's own on-screen words to the batch.
///
/// This is the leak in its most plausible form -- a "just a little context"
/// field -- and it is placed AFTER the module's own integer check, because a
/// break the module catches for us would prove nothing about the wire.
function breakWithNote(src) {
	const anchor = 'body:        JSON.stringify(body),';
	if (src.indexOf(anchor) === -1) throw new Error('the break anchor is gone from telemetry.js');
	return src.replace(anchor,
		'body: JSON.stringify(Object.assign({}, body, { note: ' +
		'((document.getElementById("chat-output") || {}).textContent || "").slice(0, 400) })),');
}

/// A `telemetry.js` that consents to itself at load, which is what a release
/// that "forgot the check" would look like.
function breakWithSelfConsent(src) {
	return src + '\ntry { window.DaimondTelemetry.consent({ wave: 1 }); } catch (e) {}\n';
}

/// A `telemetry.js` that judges the build ordinal as though it were a count.
///
/// This is the defect exactly as it stood: one ceiling for every field, so an
/// eight-hex-digit build id beginning 8-f -- half of all builds -- is floored to
/// zero on the last step before the wire. It is the break the ordinal checks
/// below are proved red against.
const NARROW_ANCHOR = 'var MAX_BUILD = 4294967295;';
function breakWithNarrowCeiling(src) {
	const n = src.split(NARROW_ANCHOR).length - 1;
	if (n !== 1) {
		console.error(`break 'narrow': the anchor appears ${n} times in telemetry.js, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(NARROW_ANCHOR, 'var MAX_BUILD = MAX_N;');
}

/// How long a session waits for the module's own flush timer, when the timer is
/// the thing under test. The shipped interval is a minute, which is right for a
/// tester's battery and wrong for a check: a withdrawal that is only asserted
/// against a flush nobody waited for is a withdrawal nobody has seen work.
const FAST_FLUSH = 1200;

/// The same module with its flush interval shortened, and nothing else changed.
///
/// Used only by the sessions in section 1c, which have to watch a queued batch
/// either go or not go. The anchor is asserted, so a renamed constant stops the
/// run rather than quietly leaving the sessions waiting on a timer that never
/// comes round -- which would make "no batch left" true for the wrong reason.
const FLUSH_ANCHOR = 'var FLUSH_MS = 60000;';
function withFastFlush(src) {
	const n = src.split(FLUSH_ANCHOR).length - 1;
	if (n !== 1) {
		console.error(`the flush anchor appears ${n} times in telemetry.js, so a `
			+ 'withdrawal session would wait on the shipped minute and prove nothing.');
		process.exit(2);
	}
	return src.replace(FLUSH_ANCHOR, `var FLUSH_MS = ${FAST_FLUSH};`);
}

/// A `withdraw()` that drops the recorder and leaves its timer running.
///
/// THE PLAUSIBLE DEFECT, and the reason the withdrawal check is proved at the
/// network rather than against `armed()`. `rec = null` alone reads exactly like
/// a working withdrawal from outside -- `armed()` false, `emit()` refusing --
/// while the closure's own timer still holds the buffer and sends it a minute
/// later. That is the shape the stub in the incident had, and a check that
/// asked the module how it felt would pass on it.
const CLOSE_ANCHOR = `			close: function () {
				if (timer) { clearTimeout(timer); timer = null; }
				buf.length = 0;
				dropped = 0;
			},`;
function breakWithHalfWithdrawal(src) {
	if (src.split(CLOSE_ANCHOR).length - 1 !== 1) {
		console.error('break \'halfway\': the close() anchor is gone from telemetry.js, '
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(CLOSE_ANCHOR,
		'			close: function () { /* halfway: the recorder goes, its timer does not */ },');
}

/// A `resume()` that re-arms without consulting what was written down.
///
/// The dangerous half of the reload pair, and the one that reads as harmless
/// while it is being written: the gateway says this account is in the beta, so
/// why ask twice? Because "in the beta" is membership and not agreement, and a
/// tester who withdrew is still a member. This is what a withdrawal undone by
/// the next visit looks like from the inside.
const EAGER_ANCHOR = '		if (remembered() !== account) return false;';
function breakWithEagerResume(src) {
	if (src.split(EAGER_ANCHOR).length - 1 !== 1) {
		console.error('break \'eager\': the resume() anchor is gone from telemetry.js.');
		process.exit(2);
	}
	return src.replace(EAGER_ANCHOR, '		/* eager: what was written down is not consulted */');
}

/// A `consent()` that arms without writing the agreement down.
///
/// The harmless-looking half: everything works, for one sitting. This is the
/// state the module was in by design until the gateway could answer for the
/// membership, and the check it fires is the one that says so.
const FORGET_ANCHOR = '		if (account) remember(account);';
function breakWithForgetfulConsent(src) {
	if (src.split(FORGET_ANCHOR).length - 1 !== 1) {
		console.error('break \'forget\': the consent() anchor is gone from telemetry.js.');
		process.exit(2);
	}
	return src.replace(FORGET_ANCHOR, '		/* forget: the agreement is not written down */');
}

/// Which patch each break applies to the module the page loads.
///
/// `inert` and `undisclosed` patch nothing, because what they simulate is not a
/// change to this module: they are the two states the app must never ship in --
/// a loaded client that nothing emits to, and one the published policy does not
/// describe. They replace `grant` and `load`, which simulated the state the tree
/// WAS in (nothing granted consent, nothing loaded the client) and became dead
/// levers the moment it was built: a flag that can no longer make a check fail
/// is a flag that says the check is proved when it is not.
const PATCHES = {
	note:    breakWithNote,
	consent: breakWithSelfConsent,
	narrow:  breakWithNarrowCeiling,
	halfway: breakWithHalfWithdrawal,
	eager:   breakWithEagerResume,
	forget:  breakWithForgetfulConsent,
	inert:       (s) => s,
	undisclosed: (s) => s,
};
if (BREAK && !PATCHES[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(PATCHES).join(', ')}`);
	process.exit(2);
}
/// The module as this run drives it: patched under `--break`, otherwise as it is.
const asDriven = (src) => (BREAK ? PATCHES[BREAK](src) : src);

/// Serve `src` AS `js/telemetry.js`, in place of the file on disk.
///
/// IT USED TO BE `addInitScript`, which ran the module before the page's own
/// scripts -- correct while `index.html` did not load it, and quietly wrong the
/// moment it did: the page's copy then re-ran the IIFE and replaced
/// `window.DaimondTelemetry` with an UNPATCHED module. Every break went missing
/// and every timer session waited 1.2 seconds on a sixty-second flush, so six
/// checks turned red at once and the leak check -- the most important negative
/// in this file -- stopped firing on a build that leaks.
///
/// Serving it at its own address cannot drift that way again: whatever the page
/// loads is what this run patched, because it is the same request.
async function serveModule(page, src) {
	await page.route('**/js/telemetry.js', (r) => r.fulfill({
		status: 200, contentType: 'application/javascript', body: src,
	}));
}

// ── One browser session ─────────────────────────────────────────────

/// # Arguments
/// * `label` - Names the profile and the session.
/// * `patch` - What to do to `telemetry.js` before the page loads it.
/// * `giveConsent` - Mint a recorder, or leave the session unconsented.
/// * `buildId` - Serve this build id from `build.json` instead of the real one,
///   so a property about build ids can be asserted rather than whatever the
///   day's build happens to be.
/// * `quick` - Skip the marker fixture. Only for a session that is not about
///   content leaking; the leak checks need the markers proved present first.
async function runSession({ label, patch, giveConsent, buildId = '', quick = false }) {
	const src = patch(fs.readFileSync(SRC_JS, 'utf8'));
	const requests = [];
	const profile = scratch('telemetry-' + label);
	fs.rmSync(profile, { recursive: true, force: true });

	// Both hooks have to be in place BEFORE the first navigation: the module is
	// injected the way `index.html` will one day carry it, and the capture must
	// not miss a request made during boot.
	const s = await open({
		name:     'tele-' + label,
		profile,
		defaults: false,
		route:    async (page) => {
			if (buildId) {
				// The updater reads the same file. It only reloads a HIDDEN tab
				// (`apply` in js/updater.js), and this one is not hidden, so a
				// substituted id moves the chip and nothing else.
				await page.route('**/build.json', (r) => r.fulfill({
					status: 200, contentType: 'application/json',
					body: JSON.stringify({ build: buildId }),
				}));
			}
			await serveModule(page, src);
			page.on('request', (r) => {
				requests.push({ url: r.url(), method: r.method(), body: r.postData() || '' });
			});
		},
	});
	const { page } = s;

	const present = { module: false, chat: false, diamond: false, file: false };
	try {
		present.module = await page.evaluate(() => !!window.DaimondTelemetry);

		if (quick) {
			const after = giveConsent ? await page.evaluate(() => {
				const T = window.DaimondTelemetry;
				const granted = T.consent({ wave: 3 });
				T.emit('app.open', 830);
				return { granted: granted, armed: T.armed(), wave: T.wave() };
			}) : null;
			const sent = await page.evaluate(() => window.DaimondTelemetry.flush());
			await page.waitForTimeout(800);
			return { requests, present, before: null, after, sent };
		}

		// A Diamond carrying the marker as its NAME, and a file carrying it as
		// its PATH and its CONTENT. Through the real wasm, into the real store.
		const built = await page.evaluate(async (m) => {
			const mod = await import('/pkg/oxedyne_daimond.js');
			const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			const id = await app.create_diamond(m.diamond);
			await app.run_tool('file_write', JSON.stringify({ path: m.file, content: m.body }));
			const names = JSON.parse(await app.list_diamonds()).map((d) => d.name);
			const listing = String(await app.run_tool('file_list', JSON.stringify({ path: '.' })));
			return { id, names, listing };
		}, MARK);
		present.diamond = built.names.indexOf(MARK.diamond) !== -1;
		present.file    = built.listing.indexOf(MARK.file) !== -1;

		// And the marker typed into a chat, sent, and answered.
		await chat(s, MARK.chat);
		present.chat = (await transcript(s)).indexOf(MARK.chat) !== -1;

		// Events emitted BEFORE consent. Nothing should keep them, and nothing
		// should send them when consent arrives later.
		const before = await page.evaluate(() => ({
			emitted: window.DaimondTelemetry.emit('panel.open', 5),
			armed:   window.DaimondTelemetry.armed(),
			flushed: false,
		}));
		await page.evaluate(() => window.DaimondTelemetry.emit('tool.run', 2));
		const flushedBefore = await page.evaluate(() => window.DaimondTelemetry.flush());
		before.flushed = flushedBefore;

		let after = null;
		if (giveConsent) {
			after = await page.evaluate(() => {
				const T = window.DaimondTelemetry;
				const granted = T.consent({ wave: 3 });
				T.emit('app.open', 830);
				T.emit('onboard.step', 6);
				T.emit('chat.new', 1);
				T.emit('turn.send', 1);
				T.emit('error.thrown', 1);
				return { granted: granted, armed: T.armed(), wave: T.wave() };
			});
		}
		// A flush either way: the unconsented session must still send nothing.
		const sent = await page.evaluate(() => window.DaimondTelemetry.flush());
		await page.waitForTimeout(800);

		return { requests, present, before, after, sent };
	} finally {
		try { await s.browser.close(); } catch (e) { /* ignore */ }
	}
}

/// A consenting session that is left to the module's OWN flush timer.
///
/// Everything else in this file makes a batch go by calling `flush()`. That
/// cannot answer the question section 1c asks, which is whether a batch already
/// sitting in the buffer goes when nobody asks it to -- so this one emits, does
/// `act`, and then waits while the timer comes round twice.
///
/// # Arguments
/// * `label` - Names the profile and the session.
/// * `act` - JavaScript run in the page after consent: the withdrawal under
///   test, or nothing at all for the control.
async function timerSession({ label, act }) {
	// `asDriven` first, so a `--break` run drives the same module the Node-side
	// checks above read. A session on the unpatched file under a break flag is a
	// session answering about a different program.
	const src = withFastFlush(asDriven(fs.readFileSync(SRC_JS, 'utf8')));
	const requests = [];
	const profile = scratch('telemetry-' + label);
	fs.rmSync(profile, { recursive: true, force: true });
	const s = await open({
		name:     'tele-' + label,
		profile,
		defaults: false,
		route:    async (page) => {
			await serveModule(page, src);
			page.on('request', (r) => {
				requests.push({ url: r.url(), method: r.method(), body: r.postData() || '' });
			});
		},
	});
	try {
		const armed = await s.page.evaluate(() => {
			const T = window.DaimondTelemetry;
			T.consent({ wave: 3 });
			T.emit('app.open', 830);
			T.emit('panel.open', 2);
			return T.armed();
		});
		if (act) await s.page.evaluate(act);
		await s.page.waitForTimeout(FAST_FLUSH * 3);
		return { armed, batches: requests.filter(toTelemetry).length };
	} finally {
		try { await s.browser.close(); } catch (e) { /* ignore */ }
	}
}

/// Does taking consent back actually stop a batch that is already queued?
///
/// Answered at the network, in two sessions that differ by one line: the control
/// consents and waits, and must SEND -- without that, "nothing was sent" is a
/// statement about a timer that never fired.
///
/// The withdrawal is not a guessed name. Anything the module exports whose name
/// says it takes consent back is called; if it exports nothing of the kind, that
/// is itself the answer, and no session is run for it.
/// A session that agrees, optionally withdraws, and then RELOADS.
///
/// The reload is the point. Consent that does not survive one covers a tester's
/// first sitting and no other; a withdrawal that does not survive one is undone
/// by the next visit, which is worse than never having offered it. Both are
/// answered by the same session with one flag between them.
///
/// The boot path is simulated the way `rearm()` in `www/js/passcode.js` drives
/// it -- `resume()` with the wave and account the gateway would answer on this
/// boot -- because the gateway is not part of a world and the property under
/// test is the browser's, not the server's.
///
/// # Arguments
/// * `label` - Names the profile and the session.
/// * `withdrawFirst` - Take consent back before reloading.
async function reloadSession({ label, withdrawFirst }) {
	const src = withFastFlush(asDriven(fs.readFileSync(SRC_JS, 'utf8')));
	const requests = [];
	const profile = scratch('telemetry-' + label);
	fs.rmSync(profile, { recursive: true, force: true });
	const s = await open({
		name:     'tele-' + label,
		profile,
		defaults: false,
		route:    async (page) => {
			await serveModule(page, src);
			page.on('request', (r) => {
				requests.push({ url: r.url(), method: r.method(), body: r.postData() || '' });
			});
		},
	});
	try {
		await s.page.evaluate((take) => {
			const T = window.DaimondTelemetry;
			T.consent({ wave: 3, account: 'acct-under-test' });
			T.emit('app.open', 830);
			if (take) T.withdraw();
		}, !!withdrawFirst);
		// Everything before this line is discarded with the page; what is being
		// asked is what the NEXT visit does -- so the count starts HERE. Counting
		// from the top of the session would let a batch sent before the reload
		// stand in for one sent after it, and the consent half of the pair would
		// then pass on a build that never resumed at all.
		const beforeReload = requests.length;
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		const back = await s.page.evaluate(() => {
			const T = window.DaimondTelemetry;
			const resumed = T.resume({ wave: 3, account: 'acct-under-test' });
			// `panel.open` and nothing else, because a code is what makes the
			// answer unambiguous. The dying page flushes on `pagehide` -- that is
			// `app.close`, added with the emit sites -- and its request starts
			// during the reload, so COUNTING batches would let the old page's
			// last gasp stand in for the new page's recorder. Code 4 can only
			// have come from a recorder this visit restored.
			T.emit('panel.open', 2);
			return { resumed: resumed, armed: T.armed(), agreed: T.agreed('acct-under-test') };
		});
		await s.page.waitForTimeout(FAST_FLUSH * 3);
		const after = requests.slice(beforeReload);
		return Object.assign(back, {
			batches: after.filter(toTelemetry).length,
			carried: codesIn(after).has(4) });
	} finally {
		try { await s.browser.close(); } catch (e) { /* ignore */ }
	}
}

/// A session that consents FIRST and is then used, with this file emitting
/// nothing at all.
///
/// Every other session here calls `emit()` by hand, which proves the transport
/// and proves nothing whatever about the app: a build with the call sites
/// deleted passes all of them. Here the only thing that can put an event in the
/// buffer is `www/js/daimond.js` doing its own work, so what comes back is what
/// the app actually reports when somebody uses it.
async function realSession(label) {
	const src = withFastFlush(asDriven(fs.readFileSync(SRC_JS, 'utf8')));
	const requests = [];
	const profile = scratch('telemetry-' + label);
	fs.rmSync(profile, { recursive: true, force: true });
	const s = await open({
		name:     'tele-' + label,
		profile,
		defaults: false,
		route:    async (page) => {
			await serveModule(page, src);
			page.on('request', (r) => {
				requests.push({ url: r.url(), method: r.method(), body: r.postData() || '' });
			});
		},
	});
	try {
		// Consent before anything is done, so everything after it is inside the
		// agreement. Nothing else is emitted from here.
		const armed = await s.page.evaluate(() =>
			window.DaimondTelemetry.consent({ wave: 3, account: 'acct-under-test' }));
		// A real turn, through the real composer, answered by the mock provider.
		await chat(s, 'Make a file called notes.md with one line in it.');
		await s.page.waitForTimeout(FAST_FLUSH * 3);
		return { armed, requests, codes: codesIn(requests) };
	} finally {
		try { await s.browser.close(); } catch (e) { /* ignore */ }
	}
}

/// The consent card, driven the way a person drives it.
///
/// The gateway is not part of a world, so the redemption reply is stubbed --
/// with the shape `gateway/src/handlers/passcode.rs` actually answers, `wave`
/// and `account_id` included. Everything else is the app: the real card, the
/// real strings, the real module.
///
/// # Arguments
/// * `answer` - `'yes'`, `'no'`, or `'escape'` for the person who closes it.
async function cardSession(answer) {
	const src = withFastFlush(asDriven(fs.readFileSync(SRC_JS, 'utf8')));
	const requests = [];
	const profile = scratch('telemetry-card-' + answer);
	fs.rmSync(profile, { recursive: true, force: true });
	const s = await open({
		name: 'tele-card-' + answer, profile, defaults: false,
		route: async (page) => {
			await serveModule(page, src);
			page.on('request', (r) => {
				requests.push({ url: r.url(), method: r.method(), body: r.postData() || '' });
			});
		},
	});
	try {
		const shown = await s.page.evaluate(async () => {
			window.DaimondGateway.state = () => ({ authed: false, refused: 'beta_only', refusal: '' });
			window.DaimondGateway.redeemPasscode = async () => ({
				created: true, pro: true, wave: 3, handle: 'quiet-harbour-41',
				authed: true, account: 'acct-under-test' });
			window.DaimondPasscode.show();
			await new Promise((r) => setTimeout(r, 200));
			document.querySelector('.beta-input').value = 'a1b2-c3d4-e5f6';
			// The Redeem button is the last in the entry card's row, whatever it
			// is called in the locale under test.
			const row = document.querySelectorAll('.beta-box .beta-row button');
			row[row.length - 1].click();
			await new Promise((r) => setTimeout(r, 500));
			const box = document.querySelector('.beta-consent');
			if (!box) return { asked: false };
			const link = box.querySelector('a.legal-link');
			const btns = box.querySelectorAll('.beta-row button');
			return {
				asked:   true,
				answers: btns.length,
				// Neither answer may be the bigger one. Read off the rendered
				// boxes rather than off the class names, because a class that
				// stopped meaning what it says is exactly how a "real choice"
				// quietly becomes a nudge.
				sameSize: btns.length === 2
					&& Math.abs(btns[0].getBoundingClientRect().height
						- btns[1].getBoundingClientRect().height) < 2,
				href:    link ? link.getAttribute('href') : '',
				// NAMED APART from the reading taken after the answer. Both were
				// called `armed`, and the merge below silently overwrote this one
				// with that one -- so the check that nothing is armed while the
				// question is still up was reading the state AFTER yes was
				// pressed, and failed on a working app. A check that reports the
				// wrong moment is worse than no check: it sends somebody hunting
				// through the app for a defect that is in the test.
				armedBefore: window.DaimondTelemetry.armed(),
			};
		});
		if (shown.asked) {
			await s.page.evaluate((how) => {
				const btns = document.querySelectorAll('.beta-consent .beta-row button');
				if (how === 'no')  btns[0].click();
				if (how === 'yes') btns[1].click();
			}, answer);
			if (answer === 'escape') {
				// The way out that is not a button: the card's own key handler,
				// which is what a person who wants no part of this presses.
				await s.page.keyboard.press('Escape');
			}
		}
		await s.page.waitForTimeout(FAST_FLUSH * 2);
		const state = await s.page.evaluate(() => ({
			armed:   window.DaimondTelemetry.armed(),
			agreed:  window.DaimondTelemetry.agreed('acct-under-test'),
			cardUp:  !!document.querySelector('.beta-scrim'),
		}));
		return Object.assign(shown, state, { batches: requests.filter(toTelemetry).length });
	} finally {
		try { await s.browser.close(); } catch (e) { /* ignore */ }
	}
}

function withdrawalNames() {
	return Object.keys(client)
		.filter((k) => /withdraw|revoke/i.test(k) && typeof client[k] === 'function');
}

async function withdrawal() {
	const names = withdrawalNames();
	const control = await timerSession({ label: 'wd-control', act: '' });
	const after = names.length
		? await timerSession({ label: 'wd-stop',
			act: `window.DaimondTelemetry.${names[0]}();` })
		: null;
	return { names, control: control.batches, after: after ? after.batches : -1 };
}

// ┌───────────────────────────────────────────────────────────────────┐
// │ 1. The two copies of the vocabulary agree                         │
// └───────────────────────────────────────────────────────────────────┘

// The module AS THIS RUN DRIVES IT. Under `--break` the page is served a
// patched copy, so a Node-side check that read the file on disk would be
// checking a different module from the one in the browser -- and would go green
// while the browser went red, which is the shape of a check that proves nothing.
const nodeCopy = (() => {
	if (!BREAK) return SRC_JS;
	const p = scratch('telemetry-driven-' + BREAK + '.js');
	fs.writeFileSync(p, asDriven(fs.readFileSync(SRC_JS, 'utf8')));
	return p;
})();
const client = createRequire(import.meta.url)(nodeCopy);

/// The gateway's copy, read out of the Rust: variant → code, and variant → name.
function rustVocabulary() {
	const rs = fs.readFileSync(SRC_RS, 'utf8');
	const codes = {}, names = {};
	for (const m of rs.matchAll(/^\s{4}([A-Z][A-Za-z]*)\s*=\s*(\d+),$/gm)) codes[m[1]] = Number(m[2]);
	for (const m of rs.matchAll(/Self::([A-Za-z]+)\s*=>\s*"([a-z.]+)",/g))  names[m[1]] = m[2];
	const out = {};
	for (const v of Object.keys(codes)) if (names[v]) out[codes[v]] = names[v];
	return out;
}

const rust = rustVocabulary();
const js   = {};
client.EVENTS.forEach((e) => { js[e.code] = e.name; });

check('the gateway\'s event list was actually read', Object.keys(rust).length > 0,
	`${Object.keys(rust).length} events found in telemetry.rs`);
check('the client\'s event list was actually read', Object.keys(js).length > 0,
	`${Object.keys(js).length} events found in telemetry.js`);
// Both directions, so neither copy can be a superset of the other unnoticed.
const missingInRust = Object.keys(js).filter((c) => rust[c] !== js[c]);
const missingInJs   = Object.keys(rust).filter((c) => js[c] !== rust[c]);
check('every event the client can send, the gateway knows by the same name',
	missingInRust.length === 0, missingInRust.map((c) => `${c}=${js[c]}`).join(', '));
check('and the gateway knows no event the client does not',
	missingInJs.length === 0, missingInJs.map((c) => `${c}=${rust[c]}`).join(', '));
check('every event says what its number means and what question it answers',
	client.EVENTS.every((e) => e.n && e.n.length > 3 && e.asks && e.asks.length > 20),
	client.EVENTS.filter((e) => !e.asks || e.asks.length <= 20).map((e) => e.name).join(', '));
// The declaration is a user-facing document; a code that moved would silently
// re-label every batch already collected.
check('no two events share a code or a name',
	new Set(client.EVENTS.map((e) => e.code)).size === client.EVENTS.length
		&& new Set(client.EVENTS.map((e) => e.name)).size === client.EVENTS.length);
// ┌───────────────────────────────────────────────────────────────────┐
// │ 1c. The consent moment, and the three things that must come with  │
// │     it. Written as implications, so they hold today and bite on    │
// │     the day somebody builds it                                     │
// └───────────────────────────────────────────────────────────────────┘
//
// AUDITED 2026-08-14, AND NONE OF IT HAS MOVED. Nothing in the shipped app asks
// a beta tester whether they will send usage counts. Passcode redemption is
// built (`www/js/passcode.js`) and carries no such line; `www/js/legal.js` says
// so in its own header, naming "the beta passcode's consent line" as the one
// caller of `link()` that is not built; the published Privacy Policy enumerates
// what the gateway holds without telemetry among it and states "We use no
// analytics, advertising or cross-site tracking cookies".
//
// This section used to assert those two absences flat -- nothing grants consent,
// nothing loads the module -- which is a check that goes red on the FIRST
// correct step towards building the feature and says nothing about whether the
// step was safe. What it should have been asserting is what has to be true
// ALONGSIDE a grant, and the most important of those was never written down at
// all:
//
//   A GRANTED RECORDER CANNOT BE STOPPED FROM OUTSIDE `telemetry.js`.
//
// Measured, not reasoned: with the flush interval shortened and a consenting
// session left to its own timer, replacing `window.DaimondTelemetry` wholesale
// with a stub -- the most a module that may not edit `telemetry.js` can do --
// stops nothing. `armed()` reads FALSE while the queued batch goes anyway
// ({"v":1,"b":2536699389,...,"e":[[1,1,830],[4,1,2]]} left a stubbed page on
// 2026-08-14). A settings pane built on that would show a tester "off" while
// their events were in flight, which is the exact lie this whole file exists to
// make impossible. The recorder holds its buffer, its timer and its `fetch` in
// one closure and exports no way back out: `consent()` mints, and nothing
// un-mints. A withdrawal belongs in that closure, beside `consent()`, and
// nowhere else.
//
// So the three implications below. All three now BITE rather than hold
// vacuously -- consent is granted from `www/js/passcode.js`, the client is
// loaded by `index.html`, and the policy carries the section it links to -- and
// each is proved red by a break: `halfway`, `eager` and `forget` on the first,
// `inert` on the second, `undisclosed` on the third. The vacuous branches are
// kept because they are what a build that UNWIRES this would take, and a check
// that cannot describe that state would simply go quiet.

/// The files under `www/js` -- `telemetry.js` itself excepted, since a module
/// mentioning its own name proves nothing -- that match a pattern.
function scanFor(what) {
	return fs.readdirSync(path.join(ROOT, 'www/js'))
		.filter((f) => f.endsWith('.js') && f !== 'telemetry.js')
		.filter((f) => what.test(fs.readFileSync(path.join(ROOT, 'www/js', f), 'utf8')));
}
const callers  = scanFor(/DaimondTelemetry\s*\.\s*consent/);
const emitters = BREAK === 'inert' ? [] : scanFor(/DaimondTelemetry\s*\.\s*emit/);

const indexHtml = fs.readFileSync(path.join(ROOT, 'www/index.html'), 'utf8');
// Paired with its own presence check: an absence proved against a file that was
// never read is the way both halves of this feature stayed invisible.
check('index.html was actually read, and does load the sibling modules',
	indexHtml.indexOf('js/chunks.js') !== -1, `${indexHtml.length} bytes`);
const loaded = /<script[^>]+telemetry\.js/.test(indexHtml);

// What the published policy would have to carry before the client may be loaded.
// An id and not a sentence: prose is edited and an anchor is not, and this is
// the anchor the consent line links to.
const POLICY = path.join(ROOT, 'www/guide/legal/privacy.html');
const policyHtml = fs.readFileSync(POLICY, 'utf8');
check('the policy the consent line would link to was actually read',
	policyHtml.indexOf('id="cookies"') !== -1, `${policyHtml.length} bytes`);
const disclosed = BREAK !== 'undisclosed' && /id="beta-telemetry"/.test(policyHtml);

// ── 1. Consent granted ⟹ consent can be taken back ──────────────────
//
// The property that matters most, and the only one worth a live session: not
// "checked at startup" but checked against a batch that is already queued.
// STANDING FROM THE MOMENT THE MODULE EXPORTS ONE, rather than from the moment
// something calls `consent()`. Stopping a queued batch is a property of the
// module, and a property nobody has watched hold is a property that stops
// holding: waiting for a caller would have left it unwatched over exactly the
// stretch of work where the withdrawal is written.
if (callers.length === 0 && withdrawalNames().length === 0) {
	check('nothing grants consent, so nothing can be left unable to withdraw it',
		true, 'vacuous: nothing grants consent and the module offers no way back');
} else {
	const wd = await withdrawal();
	check('a consenting session that is left alone DOES send, so the check below is not vacuous',
		wd.control > 0, `${wd.control} batch(es) from the control session`);
	check('the module exports a way to take consent back', wd.names.length > 0,
		wd.names.length ? wd.names.join(', ')
			: `granted by ${callers.join(', ') || 'something'}, and telemetry.js exports `
				+ 'none of it — a recorder is minted by consent() and nothing un-mints it');
	check('AND WITHDRAWING STOPS A BATCH THAT IS ALREADY QUEUED', wd.after === 0,
		wd.after < 0 ? 'never ran: there is nothing to withdraw with'
			: `${wd.after} batch(es) left AFTER consent was withdrawn`);

	// ── And both answers survive the reload that used to lose them ──
	//
	// The pair is the check. A build that never resumed would pass the
	// withdrawal half while covering one sitting per tester, and a build that
	// resumed unconditionally would pass the consent half while sending for
	// somebody who had said stop. Only one build passes both.
	const kept = await reloadSession({ label: 'wd-kept', withdrawFirst: false });
	check('an agreement survives a reload, so the test is not one sitting per tester',
		kept.resumed === true && kept.armed === true && kept.carried === true,
		`resumed ${kept.resumed}, armed ${kept.armed}, the new page's own event `
			+ `${kept.carried ? 'arrived' : 'DID NOT arrive'} (${kept.batches} batch(es))`);

	// ── And the card itself: three ways to say no, one to say yes ──
	//
	// The property the whole design rests on is that silence is a NO. It is
	// structurally true -- nothing but a pressed button calls `consent()` -- and
	// structural truths are exactly the ones that stop being true quietly, so
	// all three refusals are driven rather than argued.
	const said = await cardSession('yes');
	check('the card asks, with both answers and a way to read what is sent',
		said.asked === true && said.answers === 2 && said.sameSize === true
			&& said.href.indexOf('#beta-telemetry') !== -1,
		`asked ${said.asked}, ${said.answers} answer(s), same size ${said.sameSize}, link ${said.href}`);
	check('nothing is armed while the question is still on screen',
		said.armedBefore === false, `armed before answering: ${said.armedBefore}`);
	check('and pressing yes is what arms it, so the refusals below are not vacuous',
		said.agreed === true, `agreed ${said.agreed}`);

	const nope = await cardSession('no');
	check('DECLINING LEAVES THE SAME STATE AS NEVER HAVING BEEN ASKED',
		nope.armed === false && nope.agreed === false && nope.batches === 0,
		`armed ${nope.armed}, agreed ${nope.agreed}, ${nope.batches} batch(es)`);

	const shut = await cardSession('escape');
	check('AND CLOSING THE CARD IS A DECLINE — not a question held open',
		shut.armed === false && shut.agreed === false && shut.batches === 0
			&& shut.cardUp === false,
		`armed ${shut.armed}, agreed ${shut.agreed}, card still up ${shut.cardUp}, `
			+ `${shut.batches} batch(es)`);

	const gone = await reloadSession({ label: 'wd-gone', withdrawFirst: true });
	check('AND A WITHDRAWAL SURVIVES ONE TOO — reopening the app does not start it again',
		gone.resumed === false && gone.armed === false && gone.agreed === false
			&& gone.carried === false && gone.batches === 0,
		`resumed ${gone.resumed}, armed ${gone.armed}, agreed ${gone.agreed}, `
			+ `${gone.batches} batch(es) after reopening, event carried ${gone.carried}`);
}

// ── 2. The client is loaded ⟹ something emits ───────────────────────
//
// A client on the page with no call sites is a consent moment asking for
// permission to send nothing, which is a worse state than not shipping it: the
// tester has agreed to something and the operator has no data to show for it.
check('telemetry.js is loaded only where something actually emits',
	!loaded || emitters.length > 0,
	loaded ? `loaded, and ${emitters.length} file(s) name DaimondTelemetry.emit`
		: 'vacuous: the client is not loaded');

// AND THE CALL SITES ARE DRIVEN, not counted. The check above is satisfied by a
// file that mentions the module; this one uses the app and reads what came out.
// A build whose emits were all deleted passes every other check in this file.
if (emitters.length > 0) {
	console.log('\n— a consenting session that is USED, with this file emitting nothing —');
	const real = await realSession('real');
	check('the session consented, so there was somewhere for an event to go', real.armed === true);
	const sent = [...real.codes].sort((a, b) => a - b);
	// The two the turn itself must produce. Named rather than counted: "some
	// events arrived" would pass on a build that reported only its own startup.
	check('A REAL TURN REPORTS ITSELF — the app emitted turn.send and turn.done',
		real.codes.has(7) && real.codes.has(8), `codes seen: ${sent.join(',') || 'none'}`);
	check('and nothing the app did put a word of anybody\'s content on the wire',
		leaks(real.requests, toApp).length === 0, leaks(real.requests, toApp).join('; '));
	const realFaults = real.requests.filter(toTelemetry).flatMap((r) => shapeFaults(r.body));
	check('and every batch it sent is whole numbers under the declared field names',
		realFaults.length === 0, realFaults.join('; '));
}

// ── 3. The client is loaded ⟹ the policy says so ────────────────────
//
// The order is the point. A build that sends usage counts under a policy that
// says "we use no analytics" has broken a published promise, whatever the
// dialog said.
check('telemetry.js is loaded only where the Privacy Policy describes what it sends',
	!loaded || disclosed,
	loaded ? `policy section id="beta-telemetry": ${disclosed ? 'present' : 'MISSING'}`
		: 'vacuous: the client is not loaded');

// ┌───────────────────────────────────────────────────────────────────┐
// │ 1b. Three ceilings, and two fields that are not counts            │
// └───────────────────────────────────────────────────────────────────┘
//
// `MAX_N` guarded every field at both ends. It is `i32::MAX`, and `b` is eight
// hex digits of the build id read as a number -- a u32. So every build whose id
// begins 8-f (64 of 127 sealed builds, by the transparency log) was floored to
// zero by the client, and would have had its WHOLE BATCH refused by the gateway
// had it not been. `t` is whole seconds since 1970 and would have stopped in
// 2038. The checks below assert the property rather than the day's build id,
// which is what the previous check did and why it could pass on a coin flip.

/// A named integer constant out of the Rust, or NaN.
function rustConst(name) {
	const m = fs.readFileSync(SRC_RS, 'utf8')
		.match(new RegExp('pub const ' + name + ':\\s*i64\\s*=\\s*([0-9_]+)\\s*;'));
	return m ? Number(m[1].replace(/_/g, '')) : NaN;
}
const rustN = rustConst('MAX_N'), rustB = rustConst('MAX_BUILD'), rustT = rustConst('MAX_TIME');
check('the gateway declares all three ceilings',
	Number.isFinite(rustN) && Number.isFinite(rustB) && Number.isFinite(rustT),
	`MAX_N=${rustN} MAX_BUILD=${rustB} MAX_TIME=${rustT}`);
check('the client and the gateway agree on the count ceiling', client.MAX_N === rustN,
	`client ${client.MAX_N}, gateway ${rustN}`);
// The one that matters most: if these two ever differ again, the client either
// zeroes the field or the gateway drops the batch, and both are silent.
check('and on the build ceiling — the pair whose disagreement caused this',
	client.MAX_BUILD === rustB, `client ${client.MAX_BUILD}, gateway ${rustB}`);
check('and on the send-stamp ceiling', client.MAX_TIME === rustT,
	`client ${client.MAX_TIME}, gateway ${rustT}`);
check('the build ceiling covers every eight-hex-digit id', client.MAX_BUILD >= 0xffffffff,
	String(client.MAX_BUILD));
check('the send stamp outlives 2038', client.MAX_TIME > 2147483648, String(client.MAX_TIME));

// The fixture, and the proof that it is not vacuous: an ordinal BELOW the count
// ceiling would pass this check under the broken code too.
const HI_ID  = 'f7bd6f814c2a';
const HI_ORD = client.buildOrdinal(HI_ID);
check('the fixture build id really is over the count ceiling, so this can fail',
	HI_ORD > client.MAX_N, `${HI_ID} -> ${HI_ORD}, MAX_N ${client.MAX_N}`);
check('an eight-hex-digit build id reads as its true ordinal',
	HI_ORD === parseInt(HI_ID.slice(0, 8), 16), String(HI_ORD));

const hiBatch = client.pack(3, HI_ORD, [[1, 0, 830]], 0);
check('and pack() carries it whole rather than flooring it to zero',
	hiBatch.b === HI_ORD, `b=${hiBatch.b}, wanted ${HI_ORD}`);
check('and the module\'s own last gate accepts the batch carrying it',
	client.onlyIntegers(hiBatch) === true);
check('the stamp is a real clock, not a floored one',
	hiBatch.t > 1750000000 && hiBatch.t < client.MAX_TIME, String(hiBatch.t));

// The other half of the property: widening two fields must not have widened the
// one where the capacity actually is. A count is still a count.
const overBatch = client.pack(3, HI_ORD, [[1, 0, client.MAX_N + 1]], client.MAX_N + 1);
check('a count above the count ceiling is still floored to zero',
	overBatch.d === 0 && overBatch.e[0][2] === 0,
	`d=${overBatch.d}, n=${overBatch.e[0][2]}`);
check('and a build id beyond eight hex digits is floored too',
	client.pack(3, client.MAX_BUILD + 1, [], 0).b === 0);

// ┌───────────────────────────────────────────────────────────────────┐
// │ 2. Before consent, nothing leaves                                 │
// └───────────────────────────────────────────────────────────────────┘

console.log('\n— a session that never consents —');
const quiet = await runSession({ label: 'quiet',
	patch: BREAK === 'consent' ? breakWithSelfConsent : (s) => s, giveConsent: false });

check('the module loaded into the page', quiet.present.module);
check('the marker really is in a chat',    quiet.present.chat);
check('the marker really is a Diamond\'s name', quiet.present.diamond);
check('the marker really is a file in the workspace', quiet.present.file);

check('no recorder exists', quiet.before.armed === false);
check('emitting does nothing', quiet.before.emitted === false);
check('and a flush has nothing to send', quiet.before.flushed === false && quiet.sent === false);
const quietBatches = quiet.requests.filter(toTelemetry);
check('nothing was sent to the telemetry endpoint at all', quietBatches.length === 0,
	`${quietBatches.length} request(s)`);
check('and no marker reached our origin by any other route',
	leaks(quiet.requests, toApp).length === 0, leaks(quiet.requests, toApp).join('; '));

// ┌───────────────────────────────────────────────────────────────────┐
// │ 3. After consent, batches leave — carrying numbers only           │
// └───────────────────────────────────────────────────────────────────┘

console.log('\n— a session that consents —');
const live = await runSession({ label: 'live',
	patch: BREAK === 'note' ? breakWithNote : (s) => s, giveConsent: true });

check('the marker really is in a chat',    live.present.chat);
check('the marker really is a Diamond\'s name', live.present.diamond);
check('the marker really is a file in the workspace', live.present.file);
check('a beta grant mints a recorder', live.after && live.after.granted === true && live.after.armed === true);
check('and the wave it was granted is the wave it holds', live.after && live.after.wave === 3);

const batches = live.requests.filter(toTelemetry);
check('a batch actually left the browser', batches.length > 0, `${batches.length} request(s)`);
if (batches.length) console.log('       the batch, verbatim: ' + batches[0].body.slice(0, 300));
check('it was a POST with no query string on the address',
	batches.every((r) => r.method === 'POST' && r.url.indexOf('?') === -1));
// Which build a batch came from is the first thing an operator asks of a beta
// report, and it is read asynchronously -- so the first flush of a session is
// exactly the one a race would rob of it. Proved against `build.json`, not
// against "not zero", so a wrong number could not pass.
const stampedBuild = (() => { try { return JSON.parse(batches[0].body).b; } catch (e) { return -1; } })();
const wantBuild = (() => {
	try { return parseInt(JSON.parse(fs.readFileSync(path.join(ROOT, 'www/build.json'), 'utf8')).build.slice(0, 8), 16); }
	catch (e) { return -2; }
})();
check('and it names the build it came from', stampedBuild === wantBuild,
	`sent ${stampedBuild}, build.json says ${wantBuild}`);

// THE check. Every marker, against every body and address that went to our own
// origin.
const wire = leaks(live.requests, toTelemetry);
check('NO WORD OF THE USER\'S CONTENT IS IN WHAT WAS SENT', wire.length === 0, wire.join('; '));
check('and none of it reached our origin by any other route',
	leaks(live.requests, toApp).length === 0, leaks(live.requests, toApp).join('; '));

const faults = batches.flatMap((r) => shapeFaults(r.body));
check('every batch is whole numbers under the declared field names',
	faults.length === 0, faults.join('; '));

// The batch is the one we asked for, not an empty shell that would make the
// check above true for the wrong reason.
const got  = codesIn(live.requests);
const want = new Set([1, 3, 6, 7, 14]);
check('the batch carries exactly the events emitted after consent',
	got.size === want.size && [...want].every((c) => got.has(c)),
	`sent ${[...got].sort((a, b) => a - b).join(',')}`);
// Emitted before the grant, and never kept: consent is not retroactive.
check('and nothing emitted before consent was kept and sent later',
	!got.has(4) && !got.has(12), `panel.open=${got.has(4)} tool.run=${got.has(12)}`);

// ┌───────────────────────────────────────────────────────────────────┐
// │ 3b. And the same property AT THE NETWORK, on a build id that       │
// │     the old ceiling would have thrown away                         │
// └───────────────────────────────────────────────────────────────────┘
//
// The check above compares against `www/build.json`, so what it proves depends
// on the day's build id: `138e6581` fits under the old ceiling and `9732f5fd`
// does not. A check that passes or fails on one hex digit is a check that will
// report this defect fixed roughly half the time. Here the id is chosen, so the
// property holds whatever has been built.

console.log('\n— a session whose build id begins with f —');
const hi = await runSession({ label: 'hibuild', quick: true, giveConsent: true,
	buildId: HI_ID, patch: BREAK === 'narrow' ? breakWithNarrowCeiling : (s) => s });

const hiBatches = hi.requests.filter(toTelemetry);
check('the high-build session sent a batch, so the check below is not vacuous',
	hiBatches.length > 0, `${hiBatches.length} request(s)`);
const hiSent = (() => { try { return JSON.parse(hiBatches[0].body).b; } catch (e) { return -1; } })();
check('a build id beginning with f arrives whole, not as zero',
	hiSent === HI_ORD, `sent ${hiSent}, wanted ${HI_ORD}`);
check('and the gateway would take it: it is inside the build ceiling both ends declare',
	hiSent > 0 && hiSent <= rustB && hiSent <= client.MAX_BUILD,
	`${hiSent} vs gateway ${rustB}`);
const hiStamp = (() => { try { return JSON.parse(hiBatches[0].body).t; } catch (e) { return -1; } })();
check('and the send stamp is a plausible clock rather than a floored field',
	hiStamp > 1750000000 && hiStamp <= rustT, String(hiStamp));

// ┌───────────────────────────────────────────────────────────────────┐
// │ 4. The leak check, proved red                                     │
// └───────────────────────────────────────────────────────────────────┘

console.log('\n— the same session, with a "note" field added on purpose —');
const leaky = await runSession({ label: 'leaky', patch: breakWithNote, giveConsent: true });

const leakyBatches = leaky.requests.filter(toTelemetry);
check('the broken build still sent a batch, so the check below is not vacuous',
	leakyBatches.length > 0, `${leakyBatches.length} request(s)`);
const caught = leaks(leaky.requests, toTelemetry);
check('THE LEAK CHECK FIRES on a build that adds one string field',
	caught.length > 0, caught.join('; '));
check('and it names the chat the user typed', caught.some((c) => c.indexOf(MARK.chat) === 0),
	caught.join('; '));
check('the shape check fires on it too', leakyBatches.flatMap((r) => shapeFaults(r.body)).length > 0,
	leakyBatches.flatMap((r) => shapeFaults(r.body)).join('; '));

// ┌───────────────────────────────────────────────────────────────────┐
// │ 5. The before-consent check, proved red                           │
// └───────────────────────────────────────────────────────────────────┘

console.log('\n— a build that consents to itself, never having been asked —');
const forward = await runSession({ label: 'forward', patch: breakWithSelfConsent, giveConsent: false });

check('THE BEFORE-CONSENT CHECK FIRES on a build that arms itself',
	forward.requests.filter(toTelemetry).length > 0,
	`${forward.requests.filter(toTelemetry).length} request(s) — the quiet session had ${quietBatches.length}`);

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
