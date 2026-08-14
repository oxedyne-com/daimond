// verify_voice.mjs — a voice is held encrypted, and leaves only as a header.
//
// WHAT THIS IS FOR. To write a proposal on the Oregami forge a tester presents a VOICE: a
// per-person secret the forge looks the writer up BY. No name travels with it — the forge
// identifies the voice from the secret alone — so the secret IS the identity, and losing it to a
// log line or an access log is losing the tester's ability to write as themselves and nobody
// else's. `www/js/voice.js` is the only place in the browser that holds one, and this file is the
// proof that it holds it the way `improve_panel_contract.md` §4 says it must:
//
//   the browser holds it, encrypted under the user's passphrase, and sends it with each request;
//   the gateway forwards and stores nothing.
//
// The properties, and the last three carry the weight:
//
//   1.  A voice can be SET, and `header()` then carries EXACTLY it, on `x-daimond-voice` — the
//       name `improve.rs`'s HDR_VOICE reads. Asserted against a real request as well as against
//       the returned map, because a map nothing sends proves nothing.
//   1b. AND IT SURVIVES A RELOAD AND AN UNLOCK. This is what says the secret is at REST rather
//       than in a module variable, and it is the necessary companion to check 3: 3 alone would
//       pass over an empty store, and 1b alone would pass over a store holding the plaintext.
//       Neither is sufficient; together they are the claim.
//   2.  `clear()` REALLY REMOVES IT — asserted on what is IN STORAGE, not on `has()`. A `has()`
//       that answers false over a secret still on disk is the exact failure worth catching:
//       nothing in the interface would ever offer to remove it again.
//   3.  THE SECRET IS NOT IN STORAGE IN PLAINTEXT. Asserted by reading every byte the origin has
//       in localStorage, raw, and searching it for the secret.
//   4.  THE SECRET IS NEVER IN A URL, A QUERY STRING OR A LOG LINE — and a URL that arrives
//       already carrying it is REFUSED rather than quietly cleaned, because code that built one
//       will build another.
//   5.  A PUBLIC READ CARRIES NO VOICE HEADER AT ALL when none is held, and does not fail.
//       Reading a public repository needs no voice; a client that demanded one would put a fence
//       around a public page.
//   6.  VALIDATION IS NOT LOOSER THAN THE GATEWAY'S `check_secret` — non-empty, ASCII graphic,
//       at most 256 bytes. It is STRICTER in one place, a 16-character floor, which the forge's
//       43-character minted secret clears by a mile and a truncated paste does not.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST, and each break is chosen so it survives every
// check except the one it is meant to prove. A break caught by an earlier, cheaper check leaves
// the later check untested — the run goes red for the wrong reason and reads like proof.
//
//   node dev/verify_voice.mjs --break wrongheader  # 1  — the header is spelled differently
//   node dev/verify_voice.mjs --break sessiononly  # 1b — stored in memory, not at rest
//   node dev/verify_voice.mjs --break sticky       # 2  — clear() keeps the ciphertext beside a flag
//   node dev/verify_voice.mjs --break plain        # 3  — stored unwrapped
//   node dev/verify_voice.mjs --break inurl        # 4a — put in the query string as well
//   node dev/verify_voice.mjs --break chatty       # 4b — logged to the console
//   node dev/verify_voice.mjs --break unguarded    # 4c — the URL guard comes off
//   node dev/verify_voice.mjs --break alwayssend   # 5  — an empty header sent when none is held
//   node dev/verify_voice.mjs --break loose        # 6  — validation accepts anything
//   node dev/verify_voice.mjs                      # and then, clean
//
// Every one of those was run, and each reddens ONLY the property it is for — several assertions
// of that one property in three cases, and no assertion of any other. Written down because it is
// the thing that goes wrong: `sessiononly` first turned the URL-guard check red as well, since a
// voice that did not survive the reload is no voice at all by the time the guard is reached, and
// the guard was therefore untested by every run of that break. The fixture is restored after the
// reload for exactly that reason.
//
// Two of those pairs are worth explaining, because each was nearly ONE break covering two checks:
//
// - `sticky` and `sessiononly` both concern storage and are opposite mistakes. `sticky` keeps the
//   ciphertext after a clear; `sessiononly` never writes it at all. A single "storage is wrong"
//   break would turn both checks red at once and neither would have been tested by it.
// - `inurl`, `chatty` and `unguarded` are three breaks for one sentence of the rule, because the
//   sentence is held by three different lines: where the URL is built, whether anything is
//   printed, and the guard that refuses a caller's own bad URL. `unguarded` deliberately does NOT
//   put the secret in a URL — it only removes the refusal — so check 4a stays green under it and
//   is not credited with catching something it never saw.
//
// RUN IT IN A WORLD OF ITS OWN. Without the world env this drives world 0 on :8777 and says
// nothing about it:
//
//   eval "$(bash dev/world.sh 13 --env)"; bash dev/world.sh 13 --up >/dev/null
//   node dev/verify_voice.mjs
//   bash dev/world.sh 13 --down
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

// The header on Daimond's own leg. WRITTEN OUT rather than read from
// `DaimondVoice.HEADER`: a test that asks the code under test what it is called agrees with it by
// construction, and the `wrongheader` break would then pass. This string is `HDR_VOICE` in
// gateway/src/handlers/improve.rs and it is the contract.
const HDR = 'x-daimond-voice';

// A fixture shaped like a real minted voice: the forge mints 32 bytes and prints them in the
// Hematite64 alphabet, so 43 ASCII-graphic characters. Distinctive, so that finding it in a dump
// of storage or a console line is finding THIS and not a coincidence.
// Invented here, never minted, valid nowhere. It exists so the checks below can search storage,
// console lines and request URLs FOR it — a fixture read from the environment could not be
// searched for, which is the one thing this file has to do.
// allowlist secret
const SECRET = 'Vz7Kq3Np9Rw2Ty5Uv8Bd4Fg6Hj1Lm0Qs3Xc5Vb7Nm';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The header the browser sends on. One character out is a 401 nobody can explain, and it is
	// exactly what a rename in one tree and not the other produces.
	wrongheader: {
		file: 'js/voice.js',
		find: "\tvar HDR = 'x-daimond-voice';",
		with: "\tvar HDR = 'x-daimond-voice-1';",
	},
	// Held in memory for the life of the tab and never written down. Everything works until the
	// page reloads, which is the shape of a bug that ships: the developer never closes the tab.
	// Three sites, because `clear()` has to forget the memory too — a `clear()` left broken here
	// would turn check 2 red as well and this break would be credited with catching something it
	// is not about.
	sessiononly: [
		{
			file: 'js/voice.js',
			find: "\t\tlocalStorage.setItem(LS, JSON.stringify({ v: REC_V, s: wrapped, at: Date.now() }));",
			with: "\t\twindow.__voiceMem = { v: REC_V, s: wrapped, at: Date.now() };",
		},
		{
			file: 'js/voice.js',
			find: "\t\tvar raw = null;\n\t\ttry { raw = localStorage.getItem(LS); } catch (e) { return null; }",
			with: "\t\tvar raw = window.__voiceMem ? JSON.stringify(window.__voiceMem) : null;",
		},
		{
			file: 'js/voice.js',
			find: "\t\ttry { localStorage.removeItem(LS); } catch (e) { /* private mode: nothing was stored */ }",
			with: "\t\ttry { delete window.__voiceMem; localStorage.removeItem(LS); } catch (e) {}",
		},
	],
	// `clear()` keeps the ciphertext beside a flag that makes `has()` answer false. The kindest
	// version of this mistake — "in case they come back" — and the one that leaves a secret on a
	// device that nothing will ever offer to remove again.
	sticky: {
		file: 'js/voice.js',
		find: "\t\ttry { localStorage.removeItem(LS); } catch (e) { /* private mode: nothing was stored */ }",
		with: "\t\ttry { var k = rec(); localStorage.setItem(LS, JSON.stringify({ v: 0, keep: k ? k.s : '' })); } catch (e) {}",
	},
	// Stored unwrapped, and read back unwrapped, so that everything else still works. BOTH sites,
	// because a break that only stopped wrapping would break `header()` too and check 1 would go
	// red first — which would leave check 3 exactly as untested as it was before.
	plain: [
		{
			file: 'js/voice.js',
			find: "\t\tvar wrapped = await DaimondIdentity.wrap(tidy(secret));",
			with: "\t\tvar wrapped = tidy(secret);",
		},
		{
			file: 'js/voice.js',
			find: "\t\t\tsecret = await DaimondIdentity.unwrap(rec().s);",
			with: "\t\t\tsecret = rec().s;",
		},
	],
	// The secret goes in the query string AS WELL as the header, so every check that reads the
	// header still passes and only the URL moves. Placed after the guard, which is what a caller
	// appending a parameter downstream would do.
	inurl: {
		file: 'js/voice.js',
		find: "\t\tvar o = Object.assign({}, opts || {});",
		with: "\t\tif (h[HDR]) url += (url.indexOf('?') < 0 ? '?' : '&') + 'voice=' + encodeURIComponent(h[HDR]);\n"
			+ "\t\tvar o = Object.assign({}, opts || {});",
	},
	// One console line, of the kind added while debugging and left in. Nothing else changes.
	chatty: {
		file: 'js/voice.js',
		find: "\t\tvar h = await header();",
		with: "\t\tvar h = await header();\n\t\tconsole.log('voice send ' + url + ' ' + (h[HDR] || ''));",
	},
	// The refusal of a URL that already carries the secret. NOT the same as `inurl`: this file
	// goes on building clean URLs, so check 4a stays green and only the guard against a CALLER's
	// bad URL is gone.
	unguarded: {
		file: 'js/voice.js',
		find: "\t\tif (h[HDR] && url.indexOf(h[HDR]) >= 0) {",
		with: "\t\tif (false) {",
	},
	// An empty header sent when no voice is held. Looks harmless and is not: the gateway's
	// `check_secret` refuses an empty value, so every read of a PUBLIC repository would be turned
	// into a 400 by a client insisting on saying nothing.
	alwayssend: {
		file: 'js/voice.js',
		find: "\t\tif (!has()) return {};",
		with: "\t\tif (!has()) { var e = {}; e[HDR] = ''; return e; }",
	},
	// Validation accepts whatever it is given, so a newline in a secret reaches the gateway — and
	// a header value with a newline in it is how a second header gets written.
	loose: {
		file: 'js/voice.js',
		find: "\tfunction check(secret) {\n\t\tvar s = String(secret == null ? '' : secret).trim();",
		with: "\tfunction check(secret) {\n\t\treturn '';\n\t\tvar s = String(secret == null ? '' : secret).trim();",
	},
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'voice', signIn: false, connect: false });
const { page } = s;

if (BREAK) {
	const spec = BREAKS[BREAK];
	if (!spec) { console.error(`no such break: ${BREAK}`); process.exit(2); }
	const sites = Array.isArray(spec) ? spec : [spec];
	const edited = new Map();
	for (const site of sites) {
		const src = edited.get(site.file) || fs.readFileSync(path.join(WWW, site.file), 'utf8');
		const n = src.split(site.find).length - 1;
		// The anchor guard. A break whose anchor drifted lands nowhere, the run goes green, and
		// the green reads as proof — which is worse than a red for a bad reason.
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${site.file}, `
				+ 'so nothing was broken and the run below would prove nothing.');
			process.exit(2);
		}
		edited.set(site.file, src.replace(site.find, site.with));
	}
	for (const [file, body] of edited) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// Every request the panel would make to the gateway, caught before it leaves and answered as the
// gateway would answer. Caught rather than served, so this file reads what was SENT — the URL and
// the headers — which is the whole of what checks 1, 4 and 5 are about.
let seen = [];
await page.route('**/api/improve**', (route) => {
	const req = route.request();
	seen.push({ url: req.url(), headers: req.headers(), method: req.method() });
	return route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ total: 0, proposals: [] }),
	});
});

await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
await signInAs(s, 'voice');
await page.waitForTimeout(800);

/// Every byte this origin holds in localStorage, read RAW.
///
/// Through the unshimmed `Storage.prototype.getItem`: accounts.js replaces `getItem` on the
/// localStorage INSTANCE to namespace every `daimond-*` key, so a dump taken through the app's own
/// view is a dump of one account's names and not of what is on disk. What check 3 needs is the
/// disk.
const storageDump = () => page.evaluate(() => {
	const raw = Storage.prototype.getItem;
	const out = {};
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		out[k] = raw.call(localStorage, k);
	}
	return out;
});

try {
	const up = await page.evaluate(() => !!(window.DaimondVoice && window.DaimondVoice.set));
	check('voice.js is loaded and attached its global', up === true, String(up));

	// ── 1. A voice is set, and the header carries exactly it.
	const setOk = await page.evaluate(async (sec) => {
		try { await DaimondVoice.set(sec); return 'ok'; } catch (e) { return 'ERR ' + e.message; }
	}, SECRET);
	check('a voice can be set', setOk === 'ok', setOk);
	check('and has() says one is held',
		(await page.evaluate(() => DaimondVoice.has())) === true);

	const hdr = await page.evaluate(async () => {
		try { return await DaimondVoice.header(); } catch (e) { return { ERR: e.message }; }
	});
	check(`HEADER() CARRIES EXACTLY THE SECRET, ON ${HDR}`,
		hdr[HDR] === SECRET && Object.keys(hdr).length === 1,
		JSON.stringify(Object.keys(hdr)) + ' ' + (hdr[HDR] === SECRET ? 'value matches' : 'value differs'));

	seen = [];
	const wrote = await page.evaluate(async () => {
		try {
			const r = await DaimondVoice.send('/api/improve?account=oxedyne&repo=daimond', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'a title', body: 'a body' }),
			});
			return 'HTTP ' + r.status;
		} catch (e) { return 'ERR ' + e.message; }
	});
	check('a write goes out', wrote === 'HTTP 200', wrote);
	const w = seen[0] || { url: '', headers: {} };
	const got = w.headers[HDR];
	check('AND THE REQUEST CARRIED EXACTLY THAT SECRET, ON THAT HEADER',
		got === SECRET,
		got === SECRET ? '' : (got === undefined
			? 'no such header; voice-ish headers sent: '
				+ (Object.keys(w.headers).filter(k => /voice/.test(k)).join(',') || '(none)')
			: 'a different value arrived'));

	// ── 1b. IT IS AT REST, not in a variable. Two assertions, one property: the voice is still
	//        there after the page has been thrown away and unlocked again, and what is on disk is
	//        ciphertext. This is the necessary companion to check 3, which would pass over an
	//        empty store.
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'voice');
	await page.waitForTimeout(600);
	const after = await page.evaluate(async () => {
		try {
			const h = await DaimondVoice.header();
			return Object.keys(h).map(k => h[k]).join('');
		} catch (e) { return 'ERR ' + e.message; }
	});
	check('THE VOICE SURVIVES A RELOAD AND AN UNLOCK, so it is held at rest',
		after === SECRET, after === SECRET ? '' : after.slice(0, 40));

	// The fixture, restored. A build that failed the check above has no voice held any more, and
	// every check below would then be measuring THAT rather than its own property — a red for a
	// borrowed reason reads exactly like proof and is not.
	await page.evaluate(async (sec) => {
		if (!DaimondVoice.has()) { try { await DaimondVoice.set(sec); } catch (e) {} }
	}, SECRET);

	const atRest = await storageDump();
	const held = atRest['daimond-voice'] || '';
	check('and what is at rest is ciphertext, longer than the secret it hides',
		!!held && held.indexOf(SECRET) < 0 && held.length > SECRET.length,
		held ? held.slice(0, 40) : '(nothing was written down)');
	// What was actually written down, so the clear below can be checked against it rather than
	// against a guess at what the record looks like.
	let cipher = '';
	try { cipher = JSON.parse(held).s || ''; } catch (e) { cipher = held; }

	// ── 3. Nothing in storage is the secret. (While it is held: after the clear this would pass
	//       over an empty store and say nothing.)
	const asText = JSON.stringify(atRest);
	check('THE SECRET IS NOT IN STORAGE IN PLAINTEXT',
		asText.indexOf(SECRET) < 0,
		asText.indexOf(SECRET) < 0 ? Object.keys(atRest).length + ' keys scanned'
			: 'found in: ' + Object.keys(atRest).filter(k => String(atRest[k]).indexOf(SECRET) >= 0).join(','));

	// ── 4c. A URL that already carries the secret is refused, and nothing goes out.
	seen = [];
	const refused = await page.evaluate(async (sec) => {
		try {
			await DaimondVoice.send('/api/improve?account=a&repo=b&voice=' + encodeURIComponent(sec), {});
			return 'SENT';
		} catch (e) { return 'refused: ' + e.message; }
	}, SECRET);
	check('A URL THAT ALREADY CARRIES THE SECRET IS REFUSED',
		refused.indexOf('refused:') === 0 && refused.indexOf(SECRET) < 0,
		refused.indexOf(SECRET) >= 0 ? 'REFUSED, BUT THE MESSAGE QUOTES THE SECRET' : refused.slice(0, 60));
	check('and nothing went out carrying it', seen.length === 0,
		seen.map(x => x.url).join(' '));

	// ── 2. clear() really removes it — asserted on storage, not on has().
	await page.evaluate(() => DaimondVoice.clear());
	check('after clear(), has() is false',
		(await page.evaluate(() => DaimondVoice.has())) === false);
	const gone = await storageDump();
	const goneText = JSON.stringify(gone);
	check('CLEAR() REALLY REMOVES IT: no trace of the secret in storage',
		goneText.indexOf(SECRET) < 0,
		goneText.indexOf(SECRET) < 0 ? '' : 'plaintext still stored');
	check('AND THE CIPHERTEXT IS GONE TOO, not merely hidden behind has()',
		!!cipher && goneText.indexOf(cipher) < 0,
		!cipher ? 'nothing was ever written down — see the at-rest check above'
			: (goneText.indexOf(cipher) < 0 ? '' : 'still in: '
				+ Object.keys(gone).filter(k => String(gone[k]).indexOf(cipher) >= 0).join(',')));
	check('and the record itself is gone from storage',
		gone['daimond-voice'] === undefined,
		String(gone['daimond-voice'] || '').slice(0, 40));

	// ── 5. A public read carries no voice at all, and does not fail.
	seen = [];
	const read = await page.evaluate(async () => {
		try {
			const h = await DaimondVoice.header();
			const r = await DaimondVoice.send('/api/improve?account=oxedyne&repo=daimond', { method: 'GET' });
			return { keys: Object.keys(h), status: r.status, ok: r.ok };
		} catch (e) { return { keys: ['ERR'], status: 0, ok: false, err: e.message }; }
	});
	check('header() answers {} when no voice is held',
		read.keys.length === 0, JSON.stringify(read.keys));
	const r0 = seen[0] || { headers: {}, url: '' };
	check('A PUBLIC READ CARRIES NO VOICE HEADER AT ALL',
		Object.prototype.hasOwnProperty.call(r0.headers, HDR) === false,
		Object.prototype.hasOwnProperty.call(r0.headers, HDR)
			? `sent ${HDR}: '${r0.headers[HDR]}'` : '');
	check('AND THE PUBLIC READ IS NOT REFUSED', read.ok === true && read.status === 200,
		'HTTP ' + read.status + (read.err ? ' ' + read.err : ''));

	// ── 4a/4b. Nothing anywhere put it in a URL or printed it.
	const urls = seen.concat(w ? [w] : []).map(x => x.url);
	check('THE SECRET IS NEVER IN A URL OR A QUERY STRING',
		urls.every(u => u.indexOf(SECRET) < 0 && u.indexOf(encodeURIComponent(SECRET)) < 0),
		urls.filter(u => u.indexOf(SECRET) >= 0).join(' ').slice(0, 120));
	const printed = s.logs.filter(l => l.indexOf(SECRET) >= 0);
	const thrown  = s.errs.filter(l => l.indexOf(SECRET) >= 0);
	check('NOR IN A CONSOLE LOG OR AN ERROR',
		printed.length === 0 && thrown.length === 0,
		(printed[0] || thrown[0] || '').slice(0, 90));

	// ── 6. Validation, not looser than the gateway's check_secret. LAST, because a `loose`
	//       build accepts these and would leave rubbish in the store for the checks above.
	const cases = [
		['an empty secret',            ''],
		['a secret of spaces',         '     '],
		['a secret with a space in it', SECRET.slice(0, 20) + ' ' + SECRET.slice(20)],
		['a secret with a newline',    SECRET + '\ninjected: yes'],
		['a secret with a tab',        SECRET.slice(0, 10) + '\t' + SECRET.slice(10)],
		['a non-ASCII secret',         'Vz7Kq3Np9Rw2Ty5Uv8Bd4Fg6Hj1Lm0Qs3Xc5Vb7Né'],
		['a truncated paste',          SECRET.slice(0, 8)],
		['a secret past 256 bytes',    'V'.repeat(257)],
	];
	for (const [what, value] of cases) {
		const r = await page.evaluate(async (v) => ({
			why:   DaimondVoice.check(v),
			threw: await DaimondVoice.set(v).then(() => false, () => true),
		}), value);
		check('VALIDATION REFUSES ' + what,
			!!r.why && r.threw === true,
			r.why ? (r.threw ? '' : 'said why, but set() took it anyway') : 'accepted');
	}
	const good = await page.evaluate(async (sec) => ({
		why: DaimondVoice.check(sec),
		set: await DaimondVoice.set(sec).then(() => 'ok', (e) => 'ERR ' + e.message),
	}), SECRET);
	check('and it accepts a real minted voice, so it is not merely refusing everything',
		good.why === '' && good.set === 'ok', good.why || good.set);
	await page.evaluate(() => DaimondVoice.clear());

} catch (e) {
	check('the run completed', false, String(e && e.message || e));
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
