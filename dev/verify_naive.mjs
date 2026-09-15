// dev/verify_naive.mjs -- does dev/naive.mjs actually drive a Diamond the way a naive user
// would, and refuse the way the plan says it must?
//
// WHAT THIS IS FOR. `dev/naive.mjs` is the only thing standing between "type this proposal into
// a real Diamond" and the owner's live tab, so every property it is supposed to hold is proved
// here against a HEADLESS, MOCKED world -- never the live tab, never CDP 9222. `runNaive` is
// called directly with a `page` this file opens itself (`dev/harness.mjs`), and the forge, the
// build id and `lens.mjs` are all fixtures passed through `deps`, so nothing here touches the
// real forge, the real jarrah archive, or costs a cent.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST -- a deliberate, single-anchor edit to
// dev/naive.mjs's own source, applied to a throwaway sibling file
// (`dev/.naive.break.mjs`, deleted before this process exits) and imported in place of the real
// module, so `./forge.mjs` still resolves. The checks are unchanged; only which module answers
// them changes.
//
//   node dev/verify_naive.mjs                       # clean
//   node dev/verify_naive.mjs --break blindbusy      # 1 check reddens: the busy refusal
//   node dev/verify_naive.mjs --break noconsent      # the consent dialog is never answered
//
// ── THE BREAKS ───────────────────────────────────────────────────────────────────────────────
//   --break composewrap    the composed text gets extra brackets      -> compose-verbatim
//   --break reportfirst    the verify report reads the FIRST hit      -> verify-report-last
//   --break resendloose    a changed text is sent anyway              -> resend-refuses-changed
//   --break resendblind    --resend with nothing cached is allowed    -> resend-without-prior
//   --break busyblind      deviceBusy() never reports busy            -> device-busy-reads-activity
//   --break turnfirst      newestTurn() picks the FIRST matching row  -> newest-turn-picks-last
//   --break blindbusy      the busy pre-flight never refuses          -> preflight-busy-refuses
//   --break blindbuild     the build pre-flight never refuses         -> preflight-build-mismatch
//   --break blinddiamond   the Diamond pre-flight never refuses       -> preflight-diamond-mismatch
//   --break blinddialogopen  an open dialog is not seen before sending -> preflight-dialog-open
//   --break noclick         selectDiamond never clicks the tile        -> select-diamond-focus
//   --break nobusywait      the send loop never waits on busy()        -> send-awaits-busy
//                           (and publish-dialog-cancelled, which needs the same wait to meet
//                            the card at all -- two reds, one fault)
//   --break noconsent       the consent dialog is never clicked        -> consent-dialog-allowed-once
//   --break noforeignstop   a foreign dialog no longer stops the run   -> foreign-dialog-stops
//   --break nopublishcancel a publication card is left standing        -> publish-dialog-cancelled
//   --break noreport        the reply's verify report is never read    -> score-row-verify-report
//   --break dryrunsends     --dry-run sends anyway                     -> dry-run-sends-nothing
//   --break commentalways   --comment posts with no ORE_VOICE          -> comment-gated-by-ore-voice
//
// Needs dev/serve.mjs and the mock, same as every other browser verifier here:
//   bash dev/world.sh 35 --up; eval "$(bash dev/world.sh 35 --env)"
//   node dev/verify_naive.mjs
//   bash dev/world.sh 35 --down

import fs		from 'node:fs';
import path		from 'node:path';
import { fileURLToPath, pathToFileURL }	from 'node:url';
import { open, scratch }	from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// One real edit to dev/naive.mjs's own source per break, each targeted at the single line that
// carries the property under test -- the same discipline `verify_netchip.mjs` applies to
// www/js/daimond.js, aimed here at the file this suite actually owns.
const BREAKS = {
	composewrap: {
		// `\\n`, not `\n`: this is naive.mjs's SOURCE TEXT, where the template literal's
		// newlines are still the two characters backslash-n, not yet evaluated.
		find: 'return `${t}\\n\\n${b}\\n\\nThis is proposal ${Number(n)} on the forge.`;',
		with: 'return `[${t}]\\n\\n${b}\\n\\nThis is proposal ${Number(n)} on the forge.`;',
	},
	reportfirst: {
		find: 'while ((m = re.exec(text))) last = m;',
		with: 'if ((m = re.exec(text))) last = m;',
	},
	resendloose: {
		find: 'if (prior.hash !== hash) {',
		with: 'if (false) {',
	},
	resendblind: {
		find: 'if (resend) {',
		with: 'if (false) {',
	},
	busyblind: {
		find: 'return { busy: activity === \'busy\' || workerActive, dev };',
		with: 'return { busy: false, dev };',
	},
	turnfirst: {
		find: 'for (let i = rows.length - 1; i >= 0; i--) {',
		with: 'for (let i = 0; i < rows.length; i++) {',
	},
	blindbusy: {
		find: 'if (busy) {',
		with: 'if (false) {',
	},
	blindbuild: {
		find: 'if (!mine || mine !== served) {',
		with: 'if (false) {',
	},
	blinddiamond: {
		find: 'if (!focus || focus.kind !== \'diamond\' || (diamondId && focus.id !== diamondId)) {',
		with: 'if (false) {',
	},
	blinddialogopen: {
		find: 'if (openBefore) {',
		with: 'if (false) {',
	},
	noclick: {
		find: '\t\tel.click();\n\t\treturn true;',
		with: '\t\treturn true;',
	},
	nobusywait: {
		find: 'const busy = await appBusy(page);',
		with: 'const busy = false;',
	},
	noconsent: {
		find: 'if (dlg.isConsent && dlg.hasOkButton) {',
		with: 'if (false) {',
	},
	noforeignstop: {
		find: 'stop = { code: EXIT.stopDialog, message: `naive: stopped on a dialog nobody answers `\n'
			+ '\t\t\t\t+ `(${dlg.kind}${dlg.title ? \': \' + dlg.title : \'\'}).`, transcriptTail: tail };\n'
			+ '\t\t\tbreak;',
		with: 'stop = null;',
	},
	// The publication card is met and left standing again, which is proposal 11 whole: the
	// turn holds on a question nobody is going to answer and the run's record ends there.
	nopublishcancel: {
		find: 'if (dlg.isPublish && dlg.hasCancel) {',
		with: 'if (false) {',
	},
	noreport: {
		find: 'const report = parseVerifyReport(tail);',
		with: 'const report = null;',
	},
	dryrunsends: {
		find: 'if (dryRun) {\n\t\tsaveCacheIfFirst(proposal, resendCheck, text, cacheDir);',
		with: 'if (false) {\n\t\tsaveCacheIfFirst(proposal, resendCheck, text, cacheDir);',
	},
	commentalways: {
		find: 'if (!process.env.ORE_VOICE) {',
		with: 'if (false) {',
	},
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Load the real module, or a patched sibling copy under `--break` -- a sibling and not a temp
/// directory, so `./forge.mjs` still resolves the way it would for the real file.
const BREAK_FILE = path.join(HERE, '.naive.break.mjs');
async function loadNaive() {
	if (!BREAK) return import('./naive.mjs');
	const src = fs.readFileSync(path.join(HERE, 'naive.mjs'), 'utf8');
	const spec = BREAKS[BREAK];
	if (src.split(spec.find).length !== 2) {
		console.error(`break '${BREAK}': its anchor is not in naive.mjs exactly once`);
		process.exit(2);
	}
	fs.writeFileSync(BREAK_FILE, src.replace(spec.find, spec.with));
	return import(pathToFileURL(BREAK_FILE).href + `?t=${Date.now()}`);
}

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
/// Run one check that may throw, folding a throw into a red rather than a crash -- a check that
/// cannot even run is not a pass.
const t = async (name, fn) => {
	try { await fn(); check(true, name); }
	catch (e) { check(false, name, String((e && e.message) || e)); }
};

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

const PROPOSAL = { number: 7, title: 'Fix false "changed on disk" conflict',
	body: 'Steps: open a file, save it, save it again. Expected one save; got a conflict.' };
const forgeReadOk  = async (n) => ({ ok: true, data: { ...PROPOSAL, number: Number(n) } });
const forgeReadDir = (title) => async (n) => ({ ok: true, data: { ...PROPOSAL, number: Number(n), title, body: '' } });
const forgeCommentSpy = () => {
	const calls = [];
	const fn = async (n, said) => { calls.push({ n, said }); return { ok: true, data: {} }; };
	fn.calls = calls;
	return fn;
};

const lensFixture = (busy, turnRow) => ({
	pull: () => {},
	status: () => ({ devices: [{ device: '96a1474abcdef0', name: 'argonaut',
		live: { activity: busy ? 'busy' : 'idle', workerState: { active: 0 } } }] }),
	turns: () => (turnRow ? [turnRow] : []),
});

const REPORT_TEXT = '[world: 35 — app :8812, mock :9134, scratch .scratch/worlds/w35, MemoryMax 4G — '
	+ 'stood for this sequence and torn down]\n[hand: 0.1.0/deadbeef01 at /x/daimond-hand]\n'
	+ '[verify: 9 checks passed, 0 failed, 1 breaks confirmed red, 0 breaks proved nothing]';

async function main() {
	const naive = await loadNaive();
	if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: the check(s) named above are the point ***\n`);

	// ── Pure checks: no browser, fastest to fail ──────────────────────────────────────────────

	await t('compose-verbatim', async () => {
		const text = naive.composeText('  A Title  ', '  A body.  ', 7);
		if (text !== 'A Title\n\nA body.\n\nThis is proposal 7 on the forge.') {
			throw new Error(`got ${JSON.stringify(text)}`);
		}
		if (/file_read|verify|dev\//.test(text)) throw new Error('a hint leaked into the composed text');
	});

	await t('verify-report-last', async () => {
		const twice = 'earlier [world: 1 — x] [hand: 0.1.0/aaa at /a] later '
			+ '[world: 2 — y] [hand: 0.1.0/bbb at /b] '
			+ '[verify: 1 checks passed, 0 failed, 0 breaks confirmed red, 0 breaks proved nothing] '
			+ '[verify: 9 checks passed, 1 failed, 2 breaks confirmed red, 3 breaks proved nothing]';
		const r = naive.parseVerifyReport(twice);
		if (r.world !== '2 — y') throw new Error(`world: got ${r.world}`);
		if (r.hand !== '0.1.0/bbb at /b') throw new Error(`hand: got ${r.hand}`);
		if (r.checksPassed !== 9 || r.failed !== 1 || r.breaksConfirmedRed !== 2 || r.breaksProvedNothing !== 3) {
			throw new Error(`verify counts: got ${JSON.stringify(r)}`);
		}
		const none = naive.parseVerifyReport('nothing bracketed here');
		if (none.found) throw new Error('found a report in plain text');
	});

	await t('resend-refuses-changed', async () => {
		const dir = scratch('naive-cache', 'resend-changed');
		fs.rmSync(dir, { recursive: true, force: true });
		const first = naive.checkResend({ n: 900, text: 'text A', resend: false, cacheDir: dir });
		if (!first.ok) throw new Error('first send was refused');
		naive.saveCache(900, first.hash, 'text A', dir);
		const same = naive.checkResend({ n: 900, text: 'text A', resend: true, cacheDir: dir });
		if (!same.ok) throw new Error('an unchanged resend was refused');
		const changed = naive.checkResend({ n: 900, text: 'text B', resend: true, cacheDir: dir });
		if (changed.ok || changed.code !== naive.EXIT.resendMismatch) {
			throw new Error(`a CHANGED text under the same proposal was allowed: ${JSON.stringify(changed)}`);
		}
	});

	await t('resend-without-prior', async () => {
		const dir = scratch('naive-cache', 'resend-blind');
		fs.rmSync(dir, { recursive: true, force: true });
		const r = naive.checkResend({ n: 901, text: 'text A', resend: true, cacheDir: dir });
		if (r.ok || r.code !== naive.EXIT.resendMismatch) {
			throw new Error(`--resend with nothing cached was allowed: ${JSON.stringify(r)}`);
		}
	});

	await t('device-busy-reads-activity', async () => {
		const busy = naive.deviceBusy({ devices: [{ device: 'abc', name: 'argonaut',
			live: { activity: 'busy' } }] }, 'argonaut');
		if (!busy.busy) throw new Error('activity:"busy" was not read as busy');
		const idle = naive.deviceBusy({ devices: [{ device: 'abc', name: 'argonaut',
			live: { activity: 'idle' } }] }, 'argonaut');
		if (idle.busy) throw new Error('activity:"idle" was read as busy');
		const worker = naive.deviceBusy({ devices: [{ device: 'abc', name: 'argonaut',
			live: { activity: 'idle', workerState: { active: 2 } } }] }, 'argonaut');
		if (!worker.busy) throw new Error('a live worker was not read as busy');
	});

	await t('newest-turn-picks-last', async () => {
		const rows = [
			{ device: 'argonaut', ts: 1, outcome: 'early' },
			{ device: 'gilgamesh', ts: 2, outcome: 'other-device' },
			{ device: 'argonaut', ts: 3, outcome: 'late' },
		];
		const r = naive.newestTurn(rows, 'argonaut');
		if (!r || r.outcome !== 'late') throw new Error(`got ${JSON.stringify(r)}`);
	});

	// ── Browser checks: one headless, mocked session for all of them ────────────────────────

	const s = await open({ name: 'naive', profile: scratch('pw', 'naive' + (BREAK ? '-' + BREAK : '')) });
	try {
		const ids = await s.page.evaluate(() =>
			Array.from(document.querySelectorAll('.diamond-box')).map((e) => e.dataset.id));
		if (ids.length < 1) throw new Error('verify_naive: the seeded rail has no Diamond to select');
		const GOOD_ID = ids[0];
		const BAD_ID  = 'ffffffffffff-not-a-real-diamond';

		// A cache dir of THIS RUN'S OWN, cleared before use -- never the real
		// `~/.cache/daimond-naive/`. Proposal numbers below are reused across checks and across
		// runs of this suite (clean, then every `--break`), and the real cache is where the
		// resend guard's hash lives: a proposal whose text this run composes DIFFERENTLY from an
		// earlier run (exactly what `--break composewrap` does) is then read as "changed since
		// the first send" and refused for the wrong reason, reddening every check downstream of
		// it rather than the one the break targets.
		const CACHE_DIR = scratch('naive-cache', 'browser' + (BREAK ? '-' + BREAK : ''));
		fs.rmSync(CACHE_DIR, { recursive: true, force: true });
		const run = (opts, deps) => naive.runNaive({ cacheDir: CACHE_DIR, ...opts }, deps);

		const REAL_BUILD = await naive.pageBuildId(s.page);
		const fetchOk  = async () => ({ ok: true, json: async () => ({ build: REAL_BUILD }) });
		const fetchBad = async () => ({ ok: true, json: async () => ({ build: 'deadbeefdeadbeef' }) });

		const closeAnyDialog = async () => {
			await s.page.keyboard.press('Escape').catch(() => {});
			await s.page.waitForTimeout(200);
		};

		// A place to select once and reuse: several checks below need SOME Diamond already
		// on screen before they run their own pre-flight, which is what a person driving the
		// app would have anyway.
		await naive.selectDiamond(s.page, GOOD_ID);

		await t('preflight-busy-refuses', async () => {
			const r = await run(
				{ proposal: 71, diamondId: GOOD_ID, deadlineMs: 5000 },
				{ page: s.page, forgeRead: forgeReadOk, lens: lensFixture(true), fetchImpl: fetchOk,
					log: () => {} });
			if (r.code !== naive.EXIT.busy) throw new Error(`got ${JSON.stringify(r)}`);
			const val = await s.page.inputValue('#chat-input').catch(() => '');
			if (val) throw new Error(`the composer was filled despite the busy refusal: ${JSON.stringify(val)}`);
		});

		await t('preflight-build-mismatch', async () => {
			const r = await run(
				{ proposal: 72, diamondId: GOOD_ID, deadlineMs: 5000 },
				{ page: s.page, forgeRead: forgeReadOk, lens: lensFixture(false), fetchImpl: fetchBad,
					log: () => {} });
			if (r.code !== naive.EXIT.buildMismatch) throw new Error(`got ${JSON.stringify(r)}`);
		});

		await t('preflight-diamond-mismatch', async () => {
			const r = await run(
				{ proposal: 73, diamondId: BAD_ID, deadlineMs: 5000 },
				{ page: s.page, forgeRead: forgeReadOk, lens: lensFixture(false), fetchImpl: fetchOk,
					log: () => {} });
			if (r.code !== naive.EXIT.diamondMismatch) throw new Error(`got ${JSON.stringify(r)}`);
			// Left where it was -- the real Diamond, not the one that does not exist.
			const focus = await naive.currentFocus(s.page);
			if (!focus || focus.id !== GOOD_ID) throw new Error(`focus moved to ${JSON.stringify(focus)}`);

			// SECOND SHAPE OF THE SAME REFUSAL: no `--diamond` given at all, and an ordinary
			// chat -- not a Diamond -- on screen. `selectDiamond` is never called on this path
			// (there is no id to look for), so only runNaive's OWN final guard can catch it; the
			// first scenario above, a nonexistent tile, is caught earlier and never reaches that
			// guard, so it alone cannot prove this line holds.
			await s.page.evaluate(() => { const b = document.getElementById('new-session-btn'); if (b) b.click(); });
			await s.page.waitForTimeout(400);
			const loose = await naive.currentFocus(s.page);
			if (loose && loose.kind === 'diamond') throw new Error('a plain "new chat" landed on a Diamond -- nothing to test');
			const r2 = await run(
				{ proposal: 73, diamondId: null, deadlineMs: 5000 },
				{ page: s.page, forgeRead: forgeReadOk, lens: lensFixture(false), fetchImpl: fetchOk,
					log: () => {} });
			if (r2.code !== naive.EXIT.diamondMismatch) throw new Error(`no Diamond selected, no --diamond given: got ${JSON.stringify(r2)}`);
		});

		await t('preflight-dialog-open', async () => {
			await s.page.evaluate(() => { window.__daimondEgressAllowed(JSON.stringify({ tool: 'run', url: 'echo hi' })); });
			await s.page.waitForTimeout(400);
			const before = await naive.readDialog(s.page);
			if (!before) throw new Error('the fixture dialog never appeared -- nothing to test');
			const r = await run(
				{ proposal: 74, diamondId: GOOD_ID, deadlineMs: 5000 },
				{ page: s.page, forgeRead: forgeReadOk, lens: lensFixture(false), fetchImpl: fetchOk,
					log: () => {} });
			if (r.code !== naive.EXIT.dialogOpen) throw new Error(`got ${JSON.stringify(r)}`);
			const after = await naive.readDialog(s.page);
			if (!after) throw new Error('the open dialog was answered rather than left for a person');
			await closeAnyDialog();
		});

		await t('select-diamond-focus', async () => {
			await naive.currentFocus(s.page);	// no-op read, keeps this check symmetrical with the others
			const picked = await naive.selectDiamond(s.page, GOOD_ID);
			if (!picked) throw new Error('selectDiamond answered false for a Diamond that is in the rail');
			const focus = await naive.currentFocus(s.page);
			if (!focus || focus.kind !== 'diamond' || focus.id !== GOOD_ID) {
				throw new Error(`focus is ${JSON.stringify(focus)}, wanted diamond ${GOOD_ID}`);
			}
			const missing = await naive.selectDiamond(s.page, BAD_ID);
			if (missing !== false) throw new Error('selectDiamond did not refuse a Diamond that is not in the rail');
		});

		await t('send-awaits-busy', async () => {
			await naive.selectDiamond(s.page, GOOD_ID);
			const t0 = Date.now();
			const r = await run(
				{ proposal: 75, diamondId: GOOD_ID, deadlineMs: 15000, pollMs: 300 },
				{ page: s.page, forgeRead: forgeReadDir('@slow 3000'), lens: lensFixture(false, null),
					fetchImpl: fetchOk, log: () => {} });
			const elapsed = Date.now() - t0;
			if (r.code !== naive.EXIT.ok) throw new Error(`turn did not finish clean: ${JSON.stringify(r)}`);
			if (elapsed < 2500) {
				throw new Error(`returned after ${elapsed}ms against a 3000ms reply -- the wait was not real`);
			}
		});

		await t('consent-dialog-allowed-once', async () => {
			await naive.selectDiamond(s.page, GOOD_ID);
			const p = run(
				{ proposal: 76, diamondId: GOOD_ID, deadlineMs: 15000, pollMs: 300 },
				{ page: s.page, forgeRead: forgeReadDir('@slow 5000'), lens: lensFixture(false, null),
					fetchImpl: fetchOk, log: () => {} });
			await s.page.waitForTimeout(1200);
			await s.page.evaluate(() => { window.__daimondEgressAllowed(JSON.stringify({
				tool: 'run_net', url: 'cargo fetch', granted: false })); });
			const r = await p;
			if (r.code !== naive.EXIT.ok) throw new Error(`did not finish clean: ${JSON.stringify(r)}`);
			if (!r.row || r.row.consentsAllowed < 1) throw new Error(`consentsAllowed was ${r.row && r.row.consentsAllowed}`);
			// Not remembered: the standing box was never ticked, so the next command would ask again.
			const standing = await s.page.evaluate(() => {
				try { return localStorage.getItem('daimond-net-standing') || ''; } catch (e) { return ''; }
			});
			if (standing === 'allow') throw new Error('the consent was made STANDING though nothing ticked "remember"');
		});

		await t('foreign-dialog-stops', async () => {
			await naive.selectDiamond(s.page, GOOD_ID);
			const p = run(
				{ proposal: 77, diamondId: GOOD_ID, deadlineMs: 6000, pollMs: 300 },
				{ page: s.page, forgeRead: forgeReadDir('@slow 8000'), lens: lensFixture(false, null),
					fetchImpl: fetchOk, log: () => {} });
			await s.page.waitForTimeout(1200);
			await s.page.evaluate(() => { window.__daimondEgressAllowed(JSON.stringify({
				tool: 'run', url: 'rm -rf something' })); });
			const r = await p;
			if (r.code !== naive.EXIT.stopDialog) throw new Error(`got ${JSON.stringify(r)}`);
			const dlg = await naive.readDialog(s.page);
			if (!dlg) throw new Error('the foreign dialog was answered rather than left standing');
			await closeAnyDialog();
		});

		await t('publish-dialog-cancelled', async () => {
			// PROPOSAL 11, 2026-09-15. The daimon called `social_send` with a comment on the
			// forge in the owner's name, the "Publish this?" card rose on a tab he was not
			// looking at, and the run's record ends there: the turn held, and the driver --
			// which correctly answers nothing -- sat beside it. A naive user asked by a machine
			// whether to publish in their name says no, so this card is the one thing the driver
			// answers with a Cancel, and the STOP is the finding.
			//
			// `busy()` is stubbed true for the length of the check so the driver stays in its
			// loop with no daimon turn running -- which is the only state in which the card can
			// be raised at all on this build, since `diamondMayPublish` refuses a daimon's
			// publication before any dialog (see dev/verify_optimiser.mjs, which measures that).
			await naive.selectDiamond(s.page, GOOD_ID);
			await s.page.evaluate(() => {
				window.__busyWas = window.DaimondCore.busy;
				window.DaimondCore.busy = () => true;
			});
			try {
				const p = run(
					{ proposal: 80, diamondId: GOOD_ID, deadlineMs: 20000, pollMs: 300 },
					{ page: s.page, forgeRead: forgeReadDir('@text QUICK'), lens: lensFixture(false, null),
						fetchImpl: fetchOk, log: () => {} });
				// The card is raised only once the daimon's own turn is over, because a
				// daimon's publication never reaches a card at all -- `publishWithheld` denies
				// it before any dialog while that Diamond is steering. What is under test here
				// is the DRIVER, so the card has to exist to be met.
				await s.page.waitForFunction((id) => {
					try { return !window.DaimondCore.diamondBusy(id); } catch (e) { return false; }
				}, GOOD_ID, { timeout: 20000 });
				await s.page.waitForTimeout(500);
				await s.page.evaluate(() => {
					window.__pubVerdict = 'pending';
					window.__daimondEgressAllowed(JSON.stringify({
						tool: 'social_send', url: 'A COMMENT on proposal 11, in your name.' }))
						.then((v) => { window.__pubVerdict = String(v); });
				});
				await s.page.waitForFunction(
					() => !!document.querySelector('.modal.dlg[data-ask="publish"]'),
					null, { timeout: 8000 }).catch(async () => {
						const why = await s.page.evaluate(() => ({
							verdict: window.__pubVerdict,
							diaBusy: (window.DaimondCore.diamondBusy
								? [...document.querySelectorAll('.diamond-box')]
									.map(e => e.dataset.id)
									.filter(id => window.DaimondCore.diamondBusy(id)) : 'n/a'),
						}));
						throw new Error(`no publication card: ${JSON.stringify(why)}`);
					});
				const seen = await naive.readDialog(s.page);
				if (!seen || !seen.isPublish) {
					throw new Error(`the card was not read as a publication: ${JSON.stringify(seen)}`);
				}
				const r = await p;
				if (r.code !== naive.EXIT.stopDialog) throw new Error(`got ${JSON.stringify(r)}`);
				if (!/publication/i.test(r.message)) {
					throw new Error(`the stop does not say what it was: ${JSON.stringify(r.message)}`);
				}
				// CANCELLED, not merely stopped beside: the card is gone and the app was told no.
				const after = await naive.readDialog(s.page);
				if (after) throw new Error('the publication card was left standing');
				const verdict = await s.page.evaluate(() => window.__pubVerdict);
				if (verdict !== 'deny') throw new Error(`the gate answered ${JSON.stringify(verdict)}`);
			} finally {
				await s.page.evaluate(() => {
					if (window.__busyWas) window.DaimondCore.busy = window.__busyWas;
				});
				await closeAnyDialog();
			}
		});

		await t('score-row-verify-report', async () => {
			await naive.selectDiamond(s.page, GOOD_ID);
			const turnRow = { device: 'argonaut', outcome: 'done', rounds: 12, folds: 2, usd: 0.42 };
			const r = await run(
				{ proposal: 78, diamondId: GOOD_ID, deadlineMs: 15000, pollMs: 300 },
				{ page: s.page, forgeRead: forgeReadDir('@text ' + REPORT_TEXT), lens: lensFixture(false, turnRow),
					fetchImpl: fetchOk, log: () => {} });
			if (r.code !== naive.EXIT.ok) throw new Error(`did not finish clean: ${JSON.stringify(r)}`);
			const row = r.row;
			if (!row) throw new Error('no score row was returned');
			if (row.checksPassed !== 9 || row.failed !== 0 || row.breaksConfirmedRed !== 1 || row.breaksProvedNothing !== 0) {
				throw new Error(`verify counts not read back: ${JSON.stringify(row)}`);
			}
			if (!row.world || !row.hand) throw new Error(`world/hand not read back: ${JSON.stringify(row)}`);
			if (row.rounds !== 12 || row.folds !== 2 || row.usd !== 0.42 || row.endedHow !== 'done') {
				throw new Error(`lens turn fields not read back: ${JSON.stringify(row)}`);
			}
			if (!/^\S+ \S+ \S+/.test(row.commit) && !row.commit.startsWith('(git log')) {
				throw new Error(`commit line looks wrong: ${JSON.stringify(row.commit)}`);
			}
		});

		await t('dry-run-sends-nothing', async () => {
			await naive.selectDiamond(s.page, GOOD_ID);
			await s.page.fill('#chat-input', '');
			const r = await run(
				{ proposal: 79, diamondId: GOOD_ID, dryRun: true },
				{ page: s.page, forgeRead: forgeReadOk, lens: lensFixture(false), fetchImpl: fetchOk,
					log: () => {} });
			if (r.code !== naive.EXIT.ok || !r.dryRun) throw new Error(`got ${JSON.stringify(r)}`);
			const val = await s.page.inputValue('#chat-input').catch(() => '');
			if (val) throw new Error(`--dry-run filled the composer: ${JSON.stringify(val)}`);
		});

		await t('comment-gated-by-ore-voice', async () => {
			await naive.selectDiamond(s.page, GOOD_ID);
			const prior = process.env.ORE_VOICE;
			delete process.env.ORE_VOICE;
			const spyOff = forgeCommentSpy();
			await run(
				{ proposal: 80, diamondId: GOOD_ID, comment: true, deadlineMs: 15000, pollMs: 300 },
				{ page: s.page, forgeRead: forgeReadDir('@text ok'), forgeComment: spyOff,
					lens: lensFixture(false, null), fetchImpl: fetchOk, log: () => {} });
			if (spyOff.calls.length) throw new Error('posted a comment with no ORE_VOICE set');

			await naive.selectDiamond(s.page, GOOD_ID);
			process.env.ORE_VOICE = 'mock-voice-grace';
			const spyOn = forgeCommentSpy();
			await run(
				{ proposal: 81, diamondId: GOOD_ID, comment: true, deadlineMs: 15000, pollMs: 300 },
				{ page: s.page, forgeRead: forgeReadDir('@text ok'), forgeComment: spyOn,
					lens: lensFixture(false, null), fetchImpl: fetchOk, log: () => {} });
			if (spyOn.calls.length !== 1 || spyOn.calls[0].n !== 81) {
				throw new Error(`did not post with ORE_VOICE set: ${JSON.stringify(spyOn.calls)}`);
			}
			if (prior === undefined) delete process.env.ORE_VOICE; else process.env.ORE_VOICE = prior;
		});
	} finally {
		await s.close().catch(() => {});
	}

	console.log(`\n${bad === 0 ? 'all' : bad + ' of'} checks ${bad === 0 ? 'passed' : 'failed'}.`);
	return BREAK ? (bad ? 0 : 1) : (bad ? 1 : 0);	// under --break, a break MUST fail something
}

// `process.exit` inside `main` would skip a `.finally` chained onto its promise -- exit ends the
// process there and then, before a queued microtask runs -- so the exit code comes back as a
// plain return instead, and THIS is the one place that calls `process.exit`, after cleanup.
main().then(
	(code) => { try { fs.unlinkSync(BREAK_FILE); } catch (e) { /* never written, or already gone */ } process.exit(code); },
	(e) => { try { fs.unlinkSync(BREAK_FILE); } catch (e2) { /* never written, or already gone */ }
		console.error(String((e && e.stack) || e)); process.exit(1); },
);
