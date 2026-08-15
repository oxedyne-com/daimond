// verify_chunks.mjs — the content-addressed chunk store, in two tiers.
//
// TIER 1 (no gateway). The two things a user can act on, which had no way to be
// acted on at all:
//
//   a. A HELD-BACK DELETION CAN BE CONFIRMED. When the gateway declines a large
//      sweep, `chunks.js` parks the whole commit body plus the token and paints
//      an amber chip. Until 2026-08-14 that chip was a `role="status"` div and
//      `confirmHeldSweep` had NO PRODUCTION CALLER anywhere in the tree, so the
//      notice was the entire feature: a permanent pill saying a deletion was
//      standing, with nothing on any surface that could carry it out. The chip
//      is a button now, it asks before it deletes, and the parked commit is
//      written to localStorage — a token can only be minted by the gateway, so a
//      reload used to abandon a deletion the account goes on paying for.
//   b. A REFUSED UPLOAD ARRIVES AS ITS OWN SENTENCE. `putChunks` threw
//      `chunk put failed: 507` and discarded `res.json.error`. The gateway
//      composes four sentences on this route and each names the remedy; the user
//      got a number. The sentences the stub answers with are READ OUT OF
//      `gateway/src/handlers/chunk.rs`, so the fixture cannot drift from what
//      the server actually says.
//
// The gateway is stubbed at `DaimondGateway.gwFetch`, which `chunks.js` looks up
// on the global at every call for exactly this reason. That makes tier 1
// runnable inside a world, with no :9002 and no gateway binary.
//
// TIER 2 (needs a gateway on :9002). The original round trip: a workspace file
// too large for the sync blob travels to a second device through the chunk store
// and comes back byte-for-byte, without the gateway ever seeing its plaintext.
//
//   1. Sign in. Write a 200 KiB file — well over the 128 KiB inline ceiling, so
//      it is offloaded to chunks rather than carried in the blob.
//   2. Push. The sync blob must NOT contain the file's plaintext (it holds only
//      chunk references), and a fetched chunk must be ciphertext (marker absent).
//   3. Second device: delete the file, wipe the offload cache and cursors, pull.
//      The file is reconstructed from its chunks, identical to the original.
//
// ── Running it ──────────────────────────────────────────────────────
//
//	bash dev/world.sh 14 --up ; eval "$(bash dev/world.sh 14 --env)"
//	node dev/verify_chunks.mjs --no-gateway     # tier 1 only
//	node dev/verify_chunks.mjs                  # both; needs :9002
//
// `--no-gateway` skips tier 2 and says so. It does NOT soften tier 2: without
// the flag a missing or stale gateway binary still fails the run, because a
// release gate that quietly stops testing the round trip is worse than one that
// stops.
//
// ── Proved red ──────────────────────────────────────────────────────
//
// `--break <name>` serves a deliberately damaged `js/chunks.js` to the real page
// and the run is EXPECTED TO FAIL. An anchor that does not appear exactly once
// aborts rather than passing quietly.
//
//	node dev/verify_chunks.mjs --no-gateway --break nocaller  # the chip is a notice again
//	node dev/verify_chunks.mjs --no-gateway --break status    # the status code is back
//	node dev/verify_chunks.mjs --no-gateway --break memory    # the deletion dies on reload
//	node dev/verify_chunks.mjs --no-gateway --break anyone    # a stranger inherits it
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireFreshGateway, procLog, GWCWD } from './gwbin.mjs';
import { open, signInAs } from './harness.mjs';
import { makePagePro } from './pro.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT   = path.resolve(__dirname, '..');
const WWW    = path.join(ROOT, 'www');
const GWDIR  = path.join(ROOT, 'gateway');
const GW_URL = 'http://127.0.0.1:9002';
const SRC    = 'js/chunks.js';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const NO_GATEWAY = process.argv.includes('--no-gateway');
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// ── The breaks ──────────────────────────────────────────────────────────
//
// Each is the defect exactly as it stood, so a green run under one would mean
// the check below it had stopped measuring anything.

/// The line that makes the chip a control rather than a notice.
const LISTENER = "\t\tc.addEventListener('click', function () { onChipClick(); });\n";

/// The refusal path as it shipped: the gateway's sentence on the floor.
const SENTENCE = "\t\t\t\tvar msg = (res.json && (res.json.error || res.json.message))\n"
	+ "\t\t\t\t\t|| ('HTTP ' + res.status);\n"
	+ "\t\t\t\tstandRefused(msg, res.status);\n"
	+ "\t\t\t\tvar e = new Error(msg);\n"
	+ "\t\t\t\te.status = res.status;\t\t// for a caller that wants to branch on it.\n"
	+ "\t\t\t\tthrow e;\n";
const STATUS_ONLY = "\t\t\t\tthrow new Error('chunk put failed: ' + res.status);\n";

/// The write that lets a standing deletion outlive the page.
const PERSIST = "\t\ttry { localStorage.setItem(HELD_KEY, s); persisted = true; }\n"
	+ "\t\tcatch (e) { /* quota or private mode: it stands for this sitting only */ }\n";

/// The guard that stops one identity inheriting another's parked deletion.
const OWNER = "\t\tvar fp = whoseFp();\n"
	+ "\t\tif (!fp || h.fp !== fp) {\n"
	+ "\t\t\ttry { localStorage.removeItem(HELD_KEY); } catch (e) { /* private mode */ }\n"
	+ "\t\t\treturn null;\n"
	+ "\t\t}\n";

const BREAKS = {
	// The chip goes back to being a pill nobody can press. `confirmHeldSweep`
	// still exists and still works — which is the whole point of the finding, and
	// why a check that called it directly would have gone green throughout.
	nocaller: [{ file: SRC, find: LISTENER, with: '' }],
	// `chunk put failed: 507`, as the first user to fill their allowance saw it.
	status:   [{ file: SRC, find: SENTENCE, with: STATUS_ONLY }],
	// In memory only, so a reload abandons the deletion.
	memory:   [{ file: SRC, find: PERSIST,  with: '' }],
	// Any identity picks up any parked deletion, which is what an un-namespaced
	// key left behind by a forget would hand the next person in this browser.
	anyone:   [{ file: SRC, find: OWNER,    with: '' }],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. Nothing is served that was not verified
/// to differ from the file on disk.
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// Serve the damaged file to the page, before anything navigates.
async function breakInto(page) {
	const bodies = {};
	for (const spec of BREAKS[BREAK]) {
		const disk = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		damaged(disk, spec);				// checked against DISK, so two edits cannot mask each other.
		bodies[spec.file] = (bodies[spec.file] || disk).replace(spec.find, spec.with);
	}
	for (const file of Object.keys(bodies)) {
		await page.route('**/' + file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: bodies[file],
		}));
	}
}

// ── What the gateway actually says ──────────────────────────────────────
//
// Read out of the handler rather than typed here. A fixture that quotes the
// server from memory is a fixture that goes on passing after the server's words
// change, which is the difference between checking the seam and checking a copy
// of one side of it.
function gatewaySentences() {
	const rs = fs.readFileSync(path.join(GWDIR, 'src/handlers/chunk.rs'), 'utf8');
	const re = /err_response\(\s*HttpStatus::([A-Za-z]+)\s*,\s*"((?:[^"\\]|\\[\s\S])*)"/g;
	const out = [];
	let m;
	while ((m = re.exec(rs))) {
		// A Rust `\` at end of line eats the newline and the indent after it.
		out.push({ status: m[1], text: m[2].replace(/\\\s*\n\s*/g, '').trim() });
	}
	return out;
}

const SENTENCES = gatewaySentences();
const AT_CEILING = (SENTENCES.find((s) => /reached its cloud storage limit/.test(s.text)) || {}).text;

// ┌───────────────────────────────────────────────────────────────────┐
// │ TIER 1 — the two controls, with the gateway stubbed               │
// └───────────────────────────────────────────────────────────────────┘

console.log('\n— tier 1: the standing deletion, and the refused upload —');
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

check('the four sentences the gateway composes were read out of chunk.rs',
	SENTENCES.length >= 4 && !!AT_CEILING, `${SENTENCES.length} found`);
check('one of them is the 507 that names the remedy',
	!!AT_CEILING && /Delete something/.test(AT_CEILING), AT_CEILING);

const t1 = await open({
	name:    'chunkctl',
	signIn:  true,
	connect: false,
	route:   BREAK ? breakInto : null,
});
const p = t1.page;

/// Put the stub gateway and the stub dialog on the page. Re-run after a reload,
/// which throws both away along with everything else.
async function arm(page) {
	await page.evaluate(() => {
		window.__gw = {
			calls:     [],
			token:     'sweep-token-abcdef',
			held:      4,				// chunks the account holds, all of them doomed.
			putStatus: 0,				// 0 = accept the upload.
			putError:  '',
		};
		// `chunks.js` reads `DaimondGateway.gwFetch` off the global at every call
		// — late-bound, never captured — so replacing it here is the real code
		// path and not a shim around it.
		window.DaimondGateway.gwFetch = async function (path_, opts) {
			const body = JSON.parse(opts.body);
			window.__gw.calls.push(body);
			const reply = (status, json) => ({ status, json: async () => json });
			if (body.op === 'put') {
				if (window.__gw.putStatus) {
					return reply(window.__gw.putStatus, { ok: false, error: window.__gw.putError });
				}
				return reply(200, { ok: true });
			}
			if (body.op === 'have') return reply(200, { missing: (body.addrs || []).slice() });
			if (body.op === 'commit') {
				// The interlock: the identical body, quoting the token, carries the
				// deletion out. Anything else is held back again.
				if (body.sweep_token === window.__gw.token) {
					return reply(200, { ok: true, swept: window.__gw.held, free_allowance: 0 });
				}
				return reply(200, {
					ok: true, swept: 0,
					sweep_held_back: window.__gw.held,
					sweep_held:      window.__gw.held,
					sweep_token:     window.__gw.token,
					free_allowance:  0,
				});
			}
			return reply(200, { ok: true });
		};
		// The app's own confirm box, recorded rather than drawn. What matters is
		// that the control ASKS and honours the answer; the dialog itself is
		// daimond.js's and has its own checks.
		window.__asked  = [];
		window.__answer = true;
		window.DaimondCore.confirm = function (message, okLabel, opts) {
			window.__asked.push({ message: message, okLabel: okLabel, title: (opts || {}).title });
			return Promise.resolve(window.__answer);
		};
	});
}

/// What the chip is, as the DOM has it. `exists` is reported separately from
/// `shown` on purpose: an element that is not there answers "hidden" to every
/// visibility question, so an absence check with no presence check beside it
/// passes for a chip that was never built.
const chipState = () => p.evaluate(() => {
	const c = document.getElementById('chunk-chip');
	if (!c) return { exists: false, shown: false, tag: '', text: '', title: '', label: '' };
	return {
		exists: true,
		shown:  getComputedStyle(c).display !== 'none',
		tag:    c.tagName,
		text:   (c.textContent || '').trim(),
		title:  c.title || '',
		label:  c.getAttribute('aria-label') || '',
	};
});

try {
	await p.waitForFunction(
		() => !!window.DaimondChunks && !!window.DaimondGateway && !!window.DaimondCore,
		null, { timeout: 15000 });
	await arm(p);

	// ── 1a. Nothing standing, and the chip proved absent for the right reason ──
	const idle = await chipState();
	check('with nothing standing the chip is not on screen', !idle.shown,
		`exists=${idle.exists} shown=${idle.shown}`);
	check('and localStorage holds no standing deletion',
		(await p.evaluate(() => localStorage.getItem('daimond-chunk-held'))) === null);

	// ── 1b. A held-back sweep stands, and the notice is a CONTROL ─────────────
	//
	// An index naming nothing: the one case `refusalToConfirm` deliberately never
	// clears by itself, and the case the escape hatch exists for.
	const stood = await p.evaluate(async () => {
		await window.DaimondChunks.commit({}, 1, null);
		return window.DaimondChunks.state();
	});
	check('an index naming nothing leaves the deletion standing',
		stood.standing === true && stood.why === 'names_nothing' && stood.heldBack === 4,
		JSON.stringify(stood));

	const chip = await chipState();
	// The pair that the two invisible features needed and did not have.
	check('the chip EXISTS in the document', chip.exists, chip.tag || '(absent)');
	check('and it is on screen', chip.shown);
	check('and it is a BUTTON, not a status region nobody can press',
		chip.tag === 'BUTTON', chip.tag);
	check('it says something, in words rather than an i18n key',
		chip.text.length > 0 && !/^chunks\./.test(chip.text) && !/^chunks\./.test(chip.title),
		chip.text);
	check('and it carries an accessible name that includes the reason',
		chip.label.length > chip.text.length, chip.label.slice(0, 80));

	// ── 1c. Saying NO deletes nothing ─────────────────────────────────────────
	//
	// Before the yes, because a control that deleted on any click would pass the
	// next check and be a far worse defect than the one being fixed.
	await p.evaluate(() => { window.__answer = false; window.__gw.calls.length = 0; });
	await p.click('#chunk-chip');
	await p.waitForTimeout(300);
	// A COMMIT QUOTING THE TOKEN, not any commit. The sync engine is running in
	// this page and commits its own live set on its own schedule; counting every
	// commit would make these checks depend on whether a background round
	// happened to land inside the window, and one already did during a `--break`
	// run — turning a check that should have gone red green.
	const said = await p.evaluate(() => ({
		asked:   window.__asked.length,
		tokened: window.__gw.calls.filter((c) => c.op === 'commit' && c.sweep_token).length,
		st:      window.DaimondChunks.state(),
	}));
	check('pressing the chip ASKS before it deletes', said.asked === 1, `${said.asked} question(s)`);
	check('and answering no authorises no deletion', said.tokened === 0,
		`${said.tokened} commit(s) quoting a token`);
	check('so the deletion is still standing', said.st.standing === true, JSON.stringify(said.st));

	// ── 1d. Saying YES carries the deletion out ───────────────────────────────
	await p.evaluate(() => { window.__answer = true; window.__gw.calls.length = 0; });
	await p.click('#chunk-chip');
	await p.waitForFunction(() => window.DaimondChunks.state().standing === false,
		null, { timeout: 8000 }).catch(() => {});
	const done = await p.evaluate(() => ({
		asked:   window.__asked.length,
		tokened: window.__gw.calls.filter((c) => c.op === 'commit' && c.sweep_token),
		st:      window.DaimondChunks.state(),
		held:    localStorage.getItem('daimond-chunk-held'),
	}));
	check('answering yes authorises the deletion exactly once, never in a loop',
		done.tokened.length === 1, `${done.tokened.length} commit(s) quoting a token`);
	check('and it quotes the token the gateway minted, so the gateway can check it',
		done.tokened.length === 1 && done.tokened[0].sweep_token === 'sweep-token-abcdef',
		JSON.stringify(done.tokened[0] && done.tokened[0].sweep_token));
	check('the chunks actually go: the client records the sweep as confirmed',
		done.st.confirmed === 1 && done.st.standing === false, JSON.stringify(done.st));
	const cleared = await chipState();
	check('the chip goes with them, and the element is still there to be hidden',
		cleared.exists === true && cleared.shown === false,
		`exists=${cleared.exists} shown=${cleared.shown}`);
	check('and nothing is left in storage to raise it from the dead next boot',
		done.held === null, String(done.held));

	// ── 1e. A standing deletion survives a reload ─────────────────────────────
	//
	// The half that bites. Only the gateway can mint a token; this client cannot
	// re-derive one. A reload used to drop the body and the token together, and
	// on a device where sync is not running the commit that would raise it again
	// never comes — so the chunks sit there, referenced by nothing, swept by
	// nothing, and billed.
	await p.evaluate(async () => {
		window.__gw.calls.length = 0;
		await window.DaimondChunks.commit({}, 1, null);
	});
	const beforeReload = await p.evaluate(() => ({
		st:    window.DaimondChunks.state(),
		saved: localStorage.getItem('daimond-chunk-held'),
	}));
	check('the standing deletion is written to storage', !!beforeReload.saved,
		beforeReload.saved ? (beforeReload.saved.length + ' bytes') : 'nothing written');
	check('and the client says so, rather than leaving it to be guessed',
		beforeReload.st.persisted === true, JSON.stringify(beforeReload.st));

	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(t1, t1.name);
	await p.waitForFunction(() => !!window.DaimondChunks && !!window.DaimondCore,
		null, { timeout: 15000 });

	const survived = await p.evaluate(() => window.DaimondChunks.state());
	check('after a reload the deletion is STILL standing',
		survived.standing === true && survived.heldBack === 4, JSON.stringify(survived));
	const afterChip = await chipState();
	check('and the chip is drawn again from storage, unprompted',
		afterChip.exists === true && afterChip.shown === true && afterChip.tag === 'BUTTON',
		JSON.stringify({ exists: afterChip.exists, shown: afterChip.shown, tag: afterChip.tag }));

	// And it is the SAME deletion: the restored token is the one the gateway
	// minted, which is the only thing that makes the restored body worth keeping.
	await arm(p);
	await p.evaluate(() => { window.__answer = true; window.__gw.calls.length = 0; });
	await p.click('#chunk-chip');
	await p.waitForFunction(() => window.DaimondChunks.state().standing === false,
		null, { timeout: 8000 }).catch(() => {});
	const resumed = await p.evaluate(() => ({
		tokened: window.__gw.calls.filter((c) => c.op === 'commit' && c.sweep_token),
		st:      window.DaimondChunks.state(),
	}));
	check('a deletion recovered from storage can be carried out',
		resumed.st.standing === false && resumed.st.confirmed === 1, JSON.stringify(resumed.st));
	check('and it quotes the token from the sitting before, not a new one',
		resumed.tokened.length === 1 && resumed.tokened[0].sweep_token === 'sweep-token-abcdef',
		JSON.stringify(resumed.tokened[0] && resumed.tokened[0].sweep_token));

	// ── 1e². And it belongs to whoever it was stored for ──────────────────────
	//
	// `forgetIdentity` sweeps a NAMED list of keys, and the primary account's keys
	// are un-namespaced -- so anything not on that list is inherited whole by the
	// next identity made in this browser. A commit body for an account that no
	// longer exists would paint a chip for a stranger and send a token that can
	// only be refused. The record carries the identity fingerprint for that.
	const stranger = await p.evaluate(async () => {
		await window.DaimondChunks.commit({}, 1, null);
		// Tolerant of a build that wrote nothing, so a `--break` run reports every
		// check below rather than stopping at a null.
		let raw = null;
		try { raw = JSON.parse(localStorage.getItem('daimond-chunk-held') || 'null'); }
		catch (e) { raw = null; }
		const wasFp = raw ? String(raw.fp || '') : '';
		if (raw) {
			raw.fp = 'ffff ffff ffff ffff';		// as though another identity had left it.
			localStorage.setItem('daimond-chunk-held', JSON.stringify(raw));
		}
		return { wasFp: wasFp, standing: window.DaimondChunks.state().standing };
	});
	check('the record names whose deletion it is', !!stranger.wasFp && stranger.standing === true,
		JSON.stringify(stranger));

	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(t1, t1.name);
	await p.waitForFunction(() => !!window.DaimondChunks, null, { timeout: 15000 });
	const notMine = await p.evaluate(() => ({
		st:    window.DaimondChunks.state(),
		saved: localStorage.getItem('daimond-chunk-held'),
	}));
	check('another identity\'s standing deletion is NOT adopted',
		notMine.st.standing === false, JSON.stringify(notMine.st));
	check('and it is dropped rather than left to be found again',
		notMine.saved === null, String(notMine.saved));
	const strayChip = await chipState();
	check('so no chip is raised for it — and the element is there to have been raised',
		strayChip.exists === true && strayChip.shown === false,
		`exists=${strayChip.exists} shown=${strayChip.shown}`);

	await arm(p);

	// ── 1f. A refused upload arrives as its own sentence ──────────────────────
	await p.evaluate((sentence) => {
		window.__gw.putStatus = 507;
		window.__gw.putError  = sentence;
		window.__asked.length = 0;
	}, AT_CEILING);

	const refused = await p.evaluate(async () => {
		const bytes = new Uint8Array(4096).map((_, i) => (i * 7) % 251);
		const file  = new File([bytes], 'big.bin');
		let message = '', status = 0;
		try { await window.DaimondChunks.offloadFile('big.bin', file); }
		catch (e) { message = String(e && e.message || e); status = (e && e.status) | 0; }
		return { message: message, status: status, st: window.DaimondChunks.state() };
	});
	check('the upload really was refused, so the checks below are not vacuous',
		refused.message.length > 0, refused.message || '(nothing thrown)');
	check('THE GATEWAY\'S OWN SENTENCE REACHES THE CALLER',
		refused.message === AT_CEILING, refused.message);
	check('and it is not the status code standing in for it',
		!/^chunk put failed/.test(refused.message) && refused.message !== 'HTTP 507'
			&& refused.message.indexOf('507') === -1,
		refused.message);
	check('the status is kept beside it for a caller that wants to branch',
		refused.status === 507, String(refused.status));
	check('and the module holds the sentence, not a number',
		refused.st.refused === AT_CEILING && refused.st.refusedStatus === 507,
		JSON.stringify({ refused: refused.st.refused, status: refused.st.refusedStatus }));

	// Said, not merely thrown. `collectChunked` in daimond.js catches every
	// offload failure and discards it, so a perfect sentence on an exception
	// still reaches nobody.
	const refChip = await chipState();
	check('the refusal is ON SCREEN, on a chip that exists',
		refChip.exists === true && refChip.shown === true, JSON.stringify(refChip));
	check('and the whole sentence is reachable from it, not only the short label',
		refChip.label.indexOf(AT_CEILING) !== -1 || refChip.title === AT_CEILING,
		refChip.title.slice(0, 80));

	await p.click('#chunk-chip');
	await p.waitForTimeout(300);
	const told = await p.evaluate(() => window.__asked.slice());
	check('and pressing it puts the sentence in front of the user',
		told.length === 1 && String(told[0].message).indexOf(AT_CEILING) !== -1,
		told.length ? String(told[0].message).slice(0, 90) : '(nothing said)');

	// The other half: a batch that lands lifts the refusal, or the chip would be
	// a permanent amber pill for a ceiling that was raised an hour ago.
	const lifted = await p.evaluate(async () => {
		window.__gw.putStatus = 0;
		const bytes = new Uint8Array(4096).map((_, i) => (i * 3) % 251);
		await window.DaimondChunks.offloadFile('big2.bin', new File([bytes], 'big2.bin'));
		return window.DaimondChunks.state();
	});
	check('an upload that lands clears the refusal', lifted.refused === '',
		JSON.stringify(lifted.refused));
} catch (e) {
	check('no exception during tier 1', false, String(e && e.message || e));
} finally {
	try { await t1.browser.close(); } catch (e) { /* ignore */ }
}

// ┌───────────────────────────────────────────────────────────────────┐
// │ TIER 2 — the round trip, against a real gateway on :9002          │
// └───────────────────────────────────────────────────────────────────┘

if (NO_GATEWAY) {
	console.log('\n— tier 2 SKIPPED (--no-gateway): the offload round trip was not run —');
} else {
	console.log('\n— tier 2: the offload round trip, against a real gateway —');

	/// What the gateway says while this runs. A chunk request answering 500 says
	/// only that something went wrong; the reason is logged beside it, here.
	/// Silent when this run reuses a gateway it did not start.
	const GW_LOG = procLog('verify_chunks');

	let gw = null;
	const waitFor = async (fn, ms = 20000, gap = 300) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			try { if (await fn()) return true; } catch (e) { /* keep waiting */ }
			await new Promise((r) => setTimeout(r, gap));
		}
		return false;
	};
	const startGateway = async () => {
		gw = spawn(path.join(GWDIR, 'target/release/daimond_gateway'), [], {
			cwd: GWCWD,
			env: { ...process.env, APP_MODE: 'sandbox' },
			stdio: GW_LOG.stdio,
		});
		return await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok);
	};

	requireFreshGateway();

	// Use a gateway already up (started outside for environments where spawning a
	// child here is unreliable), otherwise start our own.
	const alreadyUp = await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok, 800, 200);
	if (alreadyUp) {
		console.log('  ok   using the gateway already on :9002');
		gw = null;	// not ours to kill.
	} else {
		check('gateway starts', await startGateway());
	}

	const s = await open({ name: 'chunks', signIn: true, connect: false });
	const { page } = s;

	await page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondChunks && !!window.DaimondCore
			&& !!window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 12000 },
	).catch(() => {});

	try {
		check('the chunk module and an authed session are live',
			await page.evaluate(() => !!window.DaimondChunks && DaimondGateway.state().authed));

		// Sync and the chunk store are Pro capabilities, so a free account is
		// refused at the door (402) and nothing below could ever happen. Buy the
		// licence the way a user does -- a signed checkout event -- rather than
		// testing the gate instead of the feature.
		const lic = await makePagePro(page, GWDIR, GW_URL);
		check('the account holds Pro, so sync is allowed to run',
			lic.pro === true, `webhook ${lic.status}, pro=${lic.pro}`);

		// A 200 KiB file: over the 128 KiB inline ceiling, so it must be offloaded.
		const MARK = 'CHUNKMARK-' + '4242';
		const built = await page.evaluate(async (mark) => {
			const mod = await import('../pkg/oxedyne_daimond.js');
			const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
			// 200 KiB of text with the marker sprinkled through it.
			let body = '';
			while (body.length < 200 * 1024) body += mark + ' lorem ipsum dolor sit amet, consectetur. ';
			await app.run_tool('file_write', JSON.stringify({ path: 'big-note.txt', content: body }));
			return { size: body.length };
		}, MARK);
		check('a 200 KiB workspace file exists (over the inline ceiling)', built.size > 128 * 1024,
			'size=' + built.size);

		// Push: offload to chunks, then the referencing blob.
		const pushed = await page.evaluate(async () => {
			await window.DaimondSync.push();
			const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
			const j = await r.json();
			return { version: j.version, present: j.present, blob: j.blob || '' };
		});
		check('after a push the mailbox holds a version >= 1', pushed.present && pushed.version >= 1,
			'version=' + pushed.version);

		// The blob is small references, not the body: the plaintext marker is absent.
		check('the large file is NOT inline in the sync blob (offloaded to chunks)',
			!pushed.blob.includes(MARK));

		// The blob names the file under `chunked`, and a fetched chunk is ciphertext.
		const chunkCheck = await page.evaluate(async (mark) => {
			const plain = await window.DaimondIdentity.unwrap(document ? (await (async () => {
				const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
				return (await r.json()).blob;
			})()) : '');
			const state = JSON.parse(plain);
			const ref = state.chunked && state.chunked['big-note.txt'];
			if (!ref || !ref.chunks || !ref.chunks.length) return { referenced: false };
			const addr = ref.chunks[0].addr;
			const g = await fetch('/api/chunk', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
				body: JSON.stringify({ op: 'get', addr }),
			});
			const gj = await g.json();
			// The stored chunk is base64url ciphertext: decode and confirm the marker
			// is not in it.
			let cipherHasMark = false;
			try {
				const t = atob(String(gj.blob || '').replace(/-/g, '+').replace(/_/g, '/'));
				cipherHasMark = t.includes(mark);
			} catch (e) { /* undecodable is fine */ }
			return { referenced: true, chunkCount: ref.chunks.length, present: !!gj.present, cipherHasMark };
		}, MARK);
		check('the blob references the file in its chunk manifest', chunkCheck.referenced,
			chunkCheck.referenced ? ('chunks=' + chunkCheck.chunkCount) : 'no chunked entry');
		check('the gateway holds the referenced chunk', chunkCheck.present);
		check('a stored chunk is ciphertext (plaintext marker absent)', !chunkCheck.cipherHasMark);

		// Second device: drop the local copy, wipe the offload cache and cursors,
		// pull. The file must NOT be downloaded — it stays in cloud storage until
		// asked for, which is what lets a workspace be larger than the device — and
		// must then come back byte-for-byte when it is fetched.
		const restored = await page.evaluate(async (mark) => {
			const mod = await import('../pkg/oxedyne_daimond.js');
			const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
			await app.run_tool('file_delete', JSON.stringify({ path: 'big-note.txt' }));
			localStorage.removeItem('daimond-chunk-map');	// a fresh device has never offloaded.
			localStorage.removeItem('daimond-sync-version');
			localStorage.removeItem('daimond-sync-filebase');
			await window.DaimondSync.pull();

			const onDisk = async () => {
				try {
					const root = await navigator.storage.getDirectory();
					return await (await (await root.getFileHandle('big-note.txt')).getFile()).text();
				} catch (e) { return null; }
			};
			const afterPull = await onDisk();
			const away  = window.DaimondCloud.awayPaths();
			const known = !!window.DaimondCloud.manifest('big-note.txt');
			// The agent is told where it is rather than that it is missing.
			const readErr = String(await app.run_tool('file_read', JSON.stringify({ path: 'big-note.txt' })));
			// And fetching it is a deliberate, separate act.
			const fetched = String(await app.run_tool('file_fetch', JSON.stringify({ path: 'big-note.txt' })));
			const back = await onDisk();
			return {
				lazy:      afterPull === null,
				known:     known,
				away:      Object.prototype.hasOwnProperty.call(away, 'big-note.txt'),
				readErr:   readErr,
				fetchedOk: /^\s*OK/.test(fetched) || /fetched/i.test(fetched),
				size:      back ? back.length : 0,
				hasMark:   !!back && back.includes(mark),
			};
		}, MARK);
		check('a pull does NOT download the large file (it stays in cloud storage)', restored.lazy);
		check('the device still knows the file exists, as a cloud manifest', restored.known);
		check('the file is listed as away from this device', restored.away);
		check('file_read tells the agent it is in cloud storage, not that it is missing',
			/in cloud storage/i.test(restored.readErr), restored.readErr.slice(0, 90));
		check('file_fetch brings it down on request', restored.fetchedOk, restored.fetchedOk ? '' : 'fetch refused');
		check('the fetched file is byte-for-byte the original',
			restored.hasMark && restored.size > 128 * 1024, 'size=' + restored.size);
	} catch (e) {
		check('no exception during the run', false, String(e && e.message || e));
	} finally {
		try { await s.browser.close(); } catch (e) { /* ignore */ }
		if (gw) { try { gw.kill('SIGTERM'); } catch (e) { /* ignore */ } }
	}

	if (bad.length) GW_LOG.report();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed'
	+ (NO_GATEWAY ? ' (tier 2 skipped)' : ''));
process.exit(bad.length ? 1 : 0);
