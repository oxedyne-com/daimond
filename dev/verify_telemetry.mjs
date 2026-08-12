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
//      before-consent check fires on the second. The breaks are served by
//      `addInitScript`, so nothing on disk is edited and anybody can re-run it.
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

// ── One browser session ─────────────────────────────────────────────

async function runSession({ label, patch, giveConsent }) {
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
			await page.addInitScript({ content: src });
			page.on('request', (r) => {
				requests.push({ url: r.url(), method: r.method(), body: r.postData() || '' });
			});
		},
	});
	const { page } = s;

	const present = { module: false, chat: false, diamond: false, file: false };
	try {
		present.module = await page.evaluate(() => !!window.DaimondTelemetry);

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

// ┌───────────────────────────────────────────────────────────────────┐
// │ 1. The two copies of the vocabulary agree                         │
// └───────────────────────────────────────────────────────────────────┘

const client = createRequire(import.meta.url)(SRC_JS);

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
// The consent moment does not exist yet. If something starts calling it, this
// file should be the thing that notices.
const callers = fs.readdirSync(path.join(ROOT, 'www/js'))
	.filter((f) => f.endsWith('.js') && f !== 'telemetry.js')
	.filter((f) => /DaimondTelemetry\s*\.\s*consent/.test(fs.readFileSync(path.join(ROOT, 'www/js', f), 'utf8')));
check('nothing in the shipped client grants consent yet', callers.length === 0, callers.join(', '));

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
