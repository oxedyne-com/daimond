// verify_pending.mjs — the Pending panel is where a worker's question waits.
//
// The panel was built for notes2 ("a new Dock panel, say 'Pending' with tiles
// for each action that must be approved by the user"), it drew, it sorted, it
// had three answers — and NOTHING IN THE SHIPPED APP EVER RAISED A TILE. Every
// caller of `Pending.add` was in `dev/`. A user had never seen one.
//
// What it was missing is the asynchronous half of consent. The gate in
// `egressAllowed` is a DIALOG, and a dispatched worker acts precisely when the
// user is looking at something else — so a worker's question went up behind a
// tab nobody had in front of them, the worker sat on it holding a slot in the
// pool, and the work died when somebody eventually pressed Escape on a dialog
// with no context. `parkConsent` raises a `consent` tile instead and the worker
// WAITS ON THE TILE: the engine is awaiting the promise that ✓ and ✕ resolve.
//
// The properties, each chosen because it would be invisible if it were wrong:
//
//   1. THE TILE SAYS WHAT WAS ASKED. Not "a tile appeared" — the headline names
//      the destination, and the detail quotes the text that would be sent, in
//      full, because that is the thing being authorised.
//   2. NOTHING HAPPENS WHILE IT WAITS. The driver has seen nothing and the tool
//      call has not returned. A panel that raises a tile and lets the act
//      through anyway is worse than no panel.
//   3. ✓ RESUMES THAT ACT. The click reaches the driver with the ref that was
//      parked, at the moment the tick is pressed — the tool call carried on from
//      where it stopped, rather than a fresh one being made.
//   4. ✕ REFUSES IT AND THE MODEL IS TOLD. The tool call returns the refusal
//      naming the destination, and nothing reached the page. A tile that is
//      answered and leaves the turn hanging is the same defect one layer up.
//   5. THE OTHER CLAUSE. `someoneCanAnswer` has two: a dialog already on screen,
//      and a document that is not on screen. Both are load-bearing, so both are
//      driven — 1–4 through the first, 5 through the second.
//   6. THE USER'S OWN TURN IS NOT DIVERTED. Same conditions, a supervised turn:
//      it still gets the dialog. A gate that moves everybody's question off the
//      screen they are looking at is a worse answer than the one being replaced.
//   7. A TILE THAT OUTLIVED ITS PAGE DOES NOT LIE. What it holds is a promise,
//      and a promise does not survive a reload. After one, the same tile says
//      the agent has gone and its tick is disabled — asserted against the SAME
//      tile before the reload, where the tick is live, so "disabled" cannot be
//      a constant.
//
// And the trigger nothing has ever driven:
//
//   8. MAIL ARRIVING IN A WATCHED FOLDER REACHES THE DAIMON. The `mail` kind has
//      shipped since phase H with no verifier at all — `verify_triggers` drives
//      the activity clock and never dispatches `daimond:mail-arrived`.
//   9. AND MAIL IN ANOTHER FOLDER DOES NOT. Driven FIRST, before anything has
//      fired, so it cannot pass because a turn was already running.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a source file to the real page (through
// `page.route`, so the browser loads it as it loads any other script) and the
// run is expected to FAIL. A break whose anchor does not appear exactly once
// aborts rather than passing quietly.
//
//   node dev/verify_pending.mjs --break nopark      # 1–5 fail: the old dialog,
//                                                   # put to an empty room
//   node dev/verify_pending.mjs --break optimistic  # 2 fails: a tile is raised
//                                                   # and the act goes through
//   node dev/verify_pending.mjs --break deaf        # 3 fails: ✓ answers nobody
//   node dev/verify_pending.mjs --break leak        # 4 fails: ✕ takes the tile
//                                                   # away and leaves the turn
//                                                   # waiting for ever
//   node dev/verify_pending.mjs --break blindtab    # 5 fails: only the dialog
//                                                   # clause is consulted
//   node dev/verify_pending.mjs --break alwayspark  # 6 fails: the user's own
//                                                   # question is moved off the
//                                                   # screen they are watching
//   node dev/verify_pending.mjs --break livelie     # 7 fails: a dead tile still
//                                                   # offers to do the thing
//   node dev/verify_pending.mjs --break mute        # 8 fails: mail never fires
//   node dev/verify_pending.mjs --break wideopen    # 9 fails: any folder fires
//   node dev/verify_pending.mjs                     # and then, clean
//
//   eval "$(bash dev/world.sh 5 --up)"
//   node dev/verify_pending.mjs
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both). No
// gateway on :9002, no IMAP: the Web panel's DRIVER is stubbed and nothing else
// is, and the mail half dispatches the arrival event the mail panel dispatches.
//
// ONE BROWSER SIGNAL IS STUBBED, and only for check 5: headless Chromium reports
// every page `visible`, measured — a second tab does not hide the first, and
// `bringToFront` does not either — so `document.visibilityState` is redefined
// for the length of that check. The code under test is untouched; what is faked
// is the browser's report of something this environment cannot produce.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, mockLog, signInAs } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'pending' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it, and each is how
// that piece behaved before the fix or how it could plausibly have been written.
const BREAKS = {
	// The gate as it was: a worker's question is always a dialog, whether or not
	// there is anybody to answer it.
	nopark: [{
		file: 'js/daimond.js',
		find: '\t\tif (req.alone && !someoneCanAnswer()) return await parkConsent(req, host);',
		with: '\t\tif (false && req.alone && !someoneCanAnswer()) return await parkConsent(req, host);',
	}],
	// A tile is raised and the act goes through regardless — the shape somebody
	// reaches for when the panel is treated as a notification rather than a gate.
	optimistic: [{
		file: 'js/daimond.js',
		find: '\t\tif (!id) return Promise.resolve(\'deny\');\n'
			+ '\t\treturn new Promise(function (resolve) { _parked[id] = resolve; });',
		with: '\t\tif (!id) return Promise.resolve(\'deny\');\n'
			+ '\t\treturn Promise.resolve(\'allow\');',
	}],
	// The register is never consulted, so every answer is given to nobody: the
	// tile goes away and the turn waits for ever.
	deaf: [{
		file: 'js/daimond.js',
		find: '\t\tvar go = _parked[id];\n\t\tif (!go) return false;',
		with: '\t\tvar go = _parked[id];\n\t\tif (!go || true) return false;',
	}],
	// Removing a tile does not refuse what was parked on it. This is the leak the
	// deny-on-drop rule exists to close, and it is silent: the panel looks right.
	leak: [{
		file: 'js/daimond.js',
		find: '\t\tdrop: function (id) {\n\t\t\tsettleConsent(id, \'deny\');',
		with: '\t\tdrop: function (id) {',
	}],
	// Only the dialog clause is consulted, so a question raised into a page
	// nobody is looking at still goes on a dialog nobody will see.
	blindtab: [{
		file: 'js/daimond.js',
		find: '\t\t\tif (document.visibilityState === \'hidden\') return false;',
		with: '\t\t\tif (false) return false;',
	}],
	// Everybody's question is parked, the user's own included.
	alwayspark: [{
		file: 'js/daimond.js',
		find: '\t\tif (req.alone && !someoneCanAnswer()) return await parkConsent(req, host);',
		with: '\t\tif (!someoneCanAnswer()) return await parkConsent(req, host);',
	}],
	// A tile survives the reload still claiming to be live, so its tick offers a
	// permission there is nothing left to grant.
	livelie: [{
		file: 'js/daimond.js',
		find: '\t\t\tthis.items.forEach(function (it) {\n'
			+ '\t\t\t\tif (it && it.kind === \'consent\') it.expired = true;\n'
			+ '\t\t\t});',
		with: '',
	}],
	// Mail never matches, so a watched folder fires nothing.
	mute: [{
		file: 'js/triggers.js',
		find: '\t\t\t\treturn t.mailbox === occasion.mailbox && t.folder === occasion.folder;',
		with: '\t\t\t\treturn false;',
	}],
	// Mail always matches, so every folder of every mailbox fires every mail TA.
	wideopen: [{
		file: 'js/triggers.js',
		find: '\t\t\t\treturn t.mailbox === occasion.mailbox && t.folder === occasion.folder;',
		with: '\t\t\t\treturn true;',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. Nothing is served that was not verified
/// to differ from the file on disk.
function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

const routeBreaks = async (page) => {
	if (!BREAK) return;
	for (const spec of BREAKS[BREAK]) {
		const body = damaged(spec);
		await page.route('**/' + spec.file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
};

// ── Driving ──────────────────────────────────────────────────────────

const HOST = 'shop.test';
const PAGE = 'https://shop.test/cart';
// Well past the 300 characters every other body on a consent screen is cut to,
// so "the whole of it is quoted" is a claim with something to fail on.
const CARD = 'x'.repeat(400) + 'card-4111-2222-3333-4444' + 'x'.repeat(400);

const s = await open({ name: 'pending', profile: PROFILE, signIn: true, connect: true,
	route: routeBreaks });
const { page: p } = s;
await p.waitForFunction(() => !!window.DaimondCore && !!window.__daimondEgressAllowed
	&& !!window.DaimondPendingView, null, { timeout: 20000 }).catch(() => {});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// The Web panel's driver, stubbed, and only the driver. Everything below it —
/// the Rust gate, the payload, the real `__daimondEgressAllowed` bridge, the
/// real dialog, the real panel — is the shipped code. It RECORDS what reached
/// it, which is how "nothing happened" is asked at the page rather than at the
/// model's reply.
async function stubDriver() {
	await p.evaluate((url) => {
		window.__drv = { clicks: [], types: [] };
		window.DaimondWeb = {
			status:   async () => ({ driver: 'stub', url, open: true }),
			open:     async (u) => ({ ok: true, url: u }),
			fetch:    async () => 'stub page',
			snapshot: async () => ({ nodes: [] }),
			read:     async () => 'stub page',
			click:    async (ref) => { window.__drv.clicks.push(ref); return { ok: true }; },
			type:     async (ref, text, submit) => {
				window.__drv.types.push({ ref, text, submit }); return { ok: true };
			},
			scroll:   async () => ({ ok: true }),
			close:    async () => ({ ok: true }),
		};
	}, PAGE);
}

/// Build one agent and hold it on `window`, exactly as `Workers.start` builds a
/// worker: `set_unsupervised` is the same call the app makes at dispatch, so a
/// build without it fails here rather than silently testing nothing.
async function mint(key, { alone = false, tainted = false } = {}) {
	return await p.evaluate(async ({ key, alone, tainted }) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		let marked = true;
		if (alone) {
			if (typeof app.set_unsupervised !== 'function') return { hasSetter: false };
			app.set_unsupervised();
			marked = app.is_unsupervised() === true;
		}
		if (tainted) {
			if (typeof app.set_tainted !== 'function') return { hasTainter: false, hasSetter: true };
			app.set_tainted();
		}
		window[key] = app;
		return { hasSetter: true, hasTainter: true, marked };
	}, { key, alone, tainted });
}

/// Start a tool call WITHOUT waiting for it, so the panel can be looked at while
/// the turn is still held open. `slot` is where its answer lands.
const fire = (agent, slot, tool, args) => p.evaluate(({ agent, slot, tool, args }) => {
	window[slot] = { done: false, text: '' };
	window[agent].run_tool(tool, JSON.stringify(args))
		.then((v) => { window[slot] = { done: true, text: String(v) }; })
		.catch((e) => { window[slot] = { done: true, text: 'THREW ' + (e && e.message || e) }; });
}, { agent, slot, tool, args });

const answerOf = (slot) => p.evaluate((k) => window[k], slot);
const drv      = () => p.evaluate(() => ({
	clicks: window.__drv.clicks.slice(), types: window.__drv.types.slice() }));
const resetDrv = () => p.evaluate(() => { window.__drv.clicks = []; window.__drv.types = []; });
const dialogs  = () => p.evaluate(() => document.querySelectorAll('.modal.dlg').length);
const tiles    = () => p.evaluate(() => window.DaimondPendingView.items());

/// Wait for something, time-boxed, so a break that HANGS reports as a failed
/// check rather than as a run that never finished.
async function until(fn, ms = 10000) {
	const end = Date.now() + ms;
	for (;;) {
		try { if (await fn()) return true; } catch (e) { /* the page is mid-navigation */ }
		if (Date.now() > end) return false;
		await sleep(150);
	}
}

/// Answer whatever dialog is up, by class rather than by reading a label: the
/// heading carries a closer as well, and "the first button that is not Cancel"
/// picks it — which dismisses.
const answerDialog = (yes) => p.evaluate((y) => {
	const d = document.querySelector('.modal.dlg');
	if (!d) return false;
	const pick = y ? d.querySelector('.dlg-ok') : (d.querySelector('.dlg-cancel') || d.querySelector('.dlg-ok'));
	if (!pick) return false;
	pick.click();
	return true;
}, yes);

/// Press one of a tile's three answers, on the tile with THIS id.
const answerTile = (id, cls) => p.evaluate(({ id, cls }) => {
	const b = document.querySelector('#pending-list .pend-card[data-id="' + id + '"] .' + cls);
	if (!b) return 'no such button';
	if (b.disabled) return 'disabled';
	b.click();
	return 'clicked';
}, { id, cls });

let failures = 0;
try {
	await stubDriver();
	const rung = await p.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		mod.set_permission_mode('guarded');
		return mod.permission_mode();
	});
	check('the default rung is the one under test', rung === 'guarded', rung);

	const wA = await mint('__wA', { alone: true });
	const wB = await mint('__wB', { alone: true });
	const me = await mint('__me', { tainted: true });
	check('a worker can be marked as acting alone', !!(wA.hasSetter && wA.marked && wB.marked),
		wA.hasSetter ? 'marked' : 'this build has no set_unsupervised');
	check('and a turn can be marked as having read a stranger\'s words',
		me.hasTainter !== false, 'set_tainted');

	await p.evaluate(() => DaimondPanels.show('pending'));
	await sleep(400);
	const emptyText = await p.evaluate(() =>
		(document.getElementById('pending-list') || {}).textContent || '');
	check('Pending starts with nothing on it', /nothing waiting/i.test(emptyText),
		emptyText.trim().slice(0, 60));

	// ══ 1–4: a dialog is already on screen, so the second worker cannot be asked
	//
	// The condition is made the way it happens: TWO workers ask at once. The
	// first gets the dialog; the second arrives at a door that is already
	// occupied. Nothing is stubbed to produce it.
	await resetDrv();
	await fire('__wA', '__rA', 'web_click', { ref: 41 });
	const gotDialog = await until(async () => (await dialogs()) > 0);
	check('a worker\'s question reaches the screen when there is a screen to reach',
		gotDialog, gotDialog ? '' : 'no dialog: nothing put the first worker\'s click to anybody');

	await fire('__wB', '__rB', 'web_type', { ref: 42, text: CARD, submit: true });
	const parked = await until(async () =>
		(await tiles()).some((i) => i.kind === 'consent'));
	const items1 = await tiles();
	const tile1  = items1.find((i) => i.kind === 'consent');
	check('a second worker, arriving at a door that is already occupied, lands on Pending',
		parked && !!tile1, tile1 ? tile1.headline : 'no consent tile was raised');

	check('the tile names the destination and what would happen there',
		!!tile1 && /shop\.test/.test(tile1.headline) && /send text/i.test(tile1.headline),
		tile1 ? tile1.headline : '');
	check('and quotes the whole of what would be sent, not the first 300 characters',
		!!tile1 && tile1.detail.includes(CARD),
		tile1 ? ('carries ' + tile1.detail.length + ' characters of a '
			+ CARD.length + '-character payload') : '');
	check('and says why it is here rather than on a dialog',
		!!tile1 && /not in front of you/i.test(tile1.detail),
		tile1 ? tile1.detail.slice(-160) : '');
	check('and it is raised high, because something is stopped until it is answered',
		!!tile1 && tile1.priority === 'high', tile1 ? tile1.priority : '');

	const drawn1 = await p.evaluate((id) => {
		const card = document.querySelector('#pending-list .pend-card[data-id="' + id + '"]');
		if (!card) return null;
		const go = card.querySelector('.pend-go');
		return {
			line: (card.querySelector('.pend-line') || {}).textContent || '',
			note: (card.querySelector('.pend-consent') || {}).textContent || '',
			goDisabled: !!(go && go.disabled),
		};
	}, tile1 ? tile1.id : '');
	check('the tile is actually on the panel, saying the agent is waiting on it',
		!!drawn1 && drawn1.line === (tile1 || {}).headline && /still waiting/i.test(drawn1.note),
		drawn1 ? drawn1.note.trim() : 'the record exists but nothing was drawn');
	check('and its tick is live, because there is something on the other end of it',
		!!drawn1 && drawn1.goDisabled === false, drawn1 ? String(drawn1.goDisabled) : '');

	// 2. Nothing has happened, and the turn has not been answered either way.
	const beforeTick = await drv();
	const restingB   = await answerOf('__rB');
	check('nothing reaches the page while the tile waits',
		beforeTick.types.length === 0, 'the driver saw ' + beforeTick.types.length + ' type(s)');
	check('and the worker\'s turn is held open rather than refused',
		restingB.done === false, restingB.done ? ('it returned: ' + restingB.text.slice(0, 90)) : 'waiting');

	// The first worker's dialog is answered no, so it is out of the way and its
	// refusal cannot be mistaken for the parked one's.
	await answerDialog(false);
	await until(async () => (await answerOf('__rA')).done);

	// 3. The tick resumes THAT act.
	// The id, or an empty one. A break that raises no tile must leave every check
	// below it reporting red rather than throwing the run out at the first
	// missing record: a red run has to say the whole of what it broke.
	const pressed = await answerTile(tile1 ? tile1.id : '', 'pend-go');
	const resumed = await until(async () => (await answerOf('__rB')).done);
	const afterTick = await drv();
	const resultB   = await answerOf('__rB');
	check('pressing ✓ answers the worker that was waiting', pressed === 'clicked' && resumed,
		pressed === 'clicked' ? (resumed ? '' : 'the turn never resumed') : pressed);
	check('and the act it was holding is the act that happens: this ref, this text',
		afterTick.types.length === 1 && afterTick.types[0].ref === 42
			&& afterTick.types[0].text === CARD,
		JSON.stringify(afterTick.types.map((x) => ({ ref: x.ref, len: (x.text || '').length }))));
	check('and the model is not handed a refusal for something that went through',
		!/did not reach/i.test(resultB.text || ''), (resultB.text || '').slice(0, 90));
	const leftAfterGo = await tiles();
	check('and the tile goes, because the question has been answered',
		!!tile1 && !leftAfterGo.some((i) => i.id === tile1.id), leftAfterGo.length + ' left');

	// 4. ✕ refuses it, and the refusal reaches the model.
	await resetDrv();
	await fire('__wA', '__rC', 'web_click', { ref: 43 });
	await until(async () => (await dialogs()) > 0);
	await fire('__wB', '__rD', 'web_click', { ref: 44 });
	await until(async () => (await tiles()).some((i) => i.kind === 'consent'));
	const tile2 = (await tiles()).find((i) => i.kind === 'consent');
	check('a click a worker cannot ask about lands on Pending too',
		!!tile2 && /click something on shop\.test/i.test(tile2.headline),
		tile2 ? tile2.headline : 'no tile');
	await answerDialog(false);
	await until(async () => (await answerOf('__rC')).done);
	await resetDrv();
	const dropped = await answerTile(tile2 ? tile2.id : '', 'pend-no');
	const toldNo  = await until(async () => (await answerOf('__rD')).done);
	const resultD = await answerOf('__rD');
	const afterNo = await drv();
	check('pressing ✕ tells the waiting worker no, rather than leaving it hanging',
		dropped === 'clicked' && toldNo,
		toldNo ? '' : 'the turn was never answered: the tile went and the worker waits for ever');
	check('the refusal names the destination it did not reach',
		/did not reach/i.test(resultD.text || '') && new RegExp(HOST).test(resultD.text || ''),
		(resultD.text || '').slice(0, 120));
	check('and nothing reached the page', afterNo.clicks.length === 0,
		'the driver saw ' + afterNo.clicks.length + ' click(s)');

	// ══ 5: the other clause — a document that is not on screen
	//
	// `document.visibilityState` is redefined for this check and put back after
	// it. Headless Chromium reports every page visible whatever is done to it
	// (measured: a second tab does not hide the first, nor does bringToFront),
	// so the browser's report is the one thing here that has to be supplied.
	await resetDrv();
	await p.evaluate(() => {
		// An own property over the prototype's getter, and configurable, so
		// deleting it below puts the real one back with nothing to restore.
		Object.defineProperty(document, 'visibilityState',
			{ get: () => 'hidden', configurable: true });
	});
	const hidden = await p.evaluate(() => document.visibilityState === 'hidden');
	check('the document can be made to report that it is not on screen', hidden,
		hidden ? '' : 'the stub did not take, so check 5 below proves nothing');
	const beforeHidden = (await tiles()).length;
	await fire('__wA', '__rE', 'web_click', { ref: 45 });
	const parkedHidden = await until(async () => (await tiles()).length > beforeHidden);
	const tile3 = (await tiles()).find((i) => i.kind === 'consent');
	const dlgHidden = await dialogs();
	check('a worker asking into a page nobody is looking at lands on Pending, with no dialog',
		parkedHidden && !!tile3 && dlgHidden === 0,
		parkedHidden ? (dlgHidden + ' dialog(s) raised') : 'no tile: it went to a dialog nobody would see');

	// 6. The user's own turn is not diverted. Same conditions exactly.
	const beforeMine = (await tiles()).length;
	await fire('__me', '__rF', 'web_click', { ref: 46 });
	const mineAsked = await until(async () => (await dialogs()) > 0, 6000);
	const afterMine = (await tiles()).length;
	check('the user\'s own turn is still asked on the screen they are looking at',
		mineAsked && afterMine === beforeMine,
		mineAsked ? (afterMine > beforeMine ? 'it was parked as well' : '')
			: 'no dialog: their own question was moved off the screen');
	await answerDialog(false);
	await until(async () => (await answerOf('__rF')).done);
	await p.evaluate(() => { delete document.visibilityState; });
	check('and the document reports normally again',
		await p.evaluate(() => document.visibilityState === 'visible'), '');

	await shot(s, 'pending-consent');

	// ══ 7: what a reload leaves behind
	//
	// The tile from check 5 is still parked and is deliberately left unanswered.
	// A reload takes its promise with it, and the tile has to say so.
	const keptId   = tile3 ? tile3.id : '';
	const keptHead = tile3 ? tile3.headline : '';
	await p.reload({ waitUntil: 'domcontentloaded' });
	// A reload lands on the passphrase gate, and nothing behind it -- the panels,
	// the rail, `Pending.load` -- runs until it is answered. Signing in again is
	// what a person returning to the tab does.
	await signInAs(s, 'pending');
	await p.waitForFunction(() => !!window.DaimondPendingView, null, { timeout: 20000 }).catch(() => {});
	await sleep(1500);
	await p.evaluate(() => DaimondPanels.show('pending'));
	await until(async () => (await tiles()).some((i) => i.id === keptId), 8000);
	const after = await tiles();
	const kept  = after.find((i) => i.id === keptId);
	check('a question that was never answered is still on the panel after a reload',
		!!kept && kept.headline === keptHead, kept ? kept.headline : 'it vanished with the page');
	const drawn2 = await p.evaluate((id) => {
		const card = document.querySelector('#pending-list .pend-card[data-id="' + id + '"]');
		if (!card) return null;
		const go = card.querySelector('.pend-go');
		return {
			note: (card.querySelector('.pend-consent') || {}).textContent || '',
			goDisabled: !!(go && go.disabled),
			dimmed: go ? (getComputedStyle(go).opacity) : '',
		};
	}, keptId);
	check('and it says the agent that asked has gone, rather than looking live',
		!!drawn2 && /has gone/i.test(drawn2.note), drawn2 ? drawn2.note.trim() : 'no tile drawn');
	check('and its tick is dead — the same tick that was live before the reload',
		!!drawn2 && drawn2.goDisabled === true, drawn2 ? ('disabled=' + drawn2.goDisabled) : '');
	check('and it is dimmed, so it does not read as a button that simply did nothing',
		!!drawn2 && parseFloat(drawn2.dimmed) < 0.9, drawn2 ? ('opacity ' + drawn2.dimmed) : '');
	const pressDead = await answerTile(keptId, 'pend-go');
	check('and it cannot be pressed', pressDead === 'disabled', pressDead);
	await answerTile(keptId, 'pend-no');
	await sleep(300);

	// ══ 8–9: the mail-arrival trigger, which nothing has ever driven
	//
	// `mail.js` announces an arrival on `daimond:mail-arrived` and never calls the
	// trigger machinery itself, so the event IS the seam. Dispatched here exactly
	// as the mail panel dispatches it.
	const BOX = 'alice@test.local';
	const SAYS = 'MAIL TRIGGER CHECK ' + Date.now().toString(36);
	const help = await p.evaluate(() => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find((b) => /Help/.test(b.textContent || ''));
		return box ? { id: box.dataset.id } : null;
	});
	if (!help) {
		check('a Diamond to hang a mail trigger on', false, 'the rail has no Daimond Help');
	} else {
		const taId = await p.evaluate(async (a) => {
			const T = window.DaimondTriggers;
			const ta = T.blank('mail');
			ta.id = 'mail-' + Date.now().toString(36);
			ta.mailbox = a.box;
			ta.folder = 'INBOX';
			ta.instruction = a.says;
			await DaimondCore.triggerSet(a.id, ta);
			// Said out loud rather than assumed: an unheld leaf reads as playing,
			// and this is a check about the folder, not about the tree.
			DaimondPause.set(T.node(a.id, ta.id), true);
			return ta.id;
		}, { id: help.id, box: BOX, says: SAYS });
		// On screen: a trigger deliberately does not move the centre out from
		// under somebody, so a Diamond that is not selected is refused.
		await p.evaluate((id) => {
			document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`).click();
		}, help.id);
		await sleep(800);

		const said = (from) => mockLog().slice(from).some((r) => JSON.stringify(r).includes(SAYS));

		// The NEGATIVE first, before anything has fired: a refusal that came from
		// a turn already running would look exactly like a refusal from the
		// folder not matching.
		const seen0 = mockLog().length;
		await p.evaluate((box) => window.dispatchEvent(new CustomEvent('daimond:mail-arrived',
			{ detail: { mailbox: box, folder: 'Archive' } })), BOX);
		await sleep(2500);
		check('mail landing in a folder nobody is watching reaches nobody',
			!said(seen0), said(seen0) ? 'the daimon was steered anyway' : 'silent');

		const seen1 = mockLog().length;
		await p.evaluate((box) => window.dispatchEvent(new CustomEvent('daimond:mail-arrived',
			{ detail: { mailbox: box, folder: 'INBOX' } })), BOX);
		const reached = await until(() => Promise.resolve(said(seen1)), 20000);
		check('mail landing in the watched folder sends that TA\'s instruction to the daimon',
			reached, reached ? '' : 'the instruction never reached the wire');
		check('a mail trigger is a leaf of the pause tree, like every other',
			await p.evaluate((a) => !!window.DaimondPause
				&& typeof window.DaimondPause.isPaused(window.DaimondTriggers.node(a.id, a.ta)) === 'boolean',
				{ id: help.id, ta: taId }), '');
	}

	await shot(s, 'pending-final');
} catch (e) {
	check('the run finished', false, String(e && e.message || e));
	try { await shot(s, 'threw'); } catch (e2) { /* the page may be gone */ }
} finally {
	failures = bad.length;
	await s.close();
}

console.log(failures === 0
	? `\nverify_pending: all ${ok.length} checks pass.`
	: `\nverify_pending: ${failures} of ${ok.length + failures} failed:\n  `
		+ bad.join('\n  '));
process.exit(failures === 0 ? 0 : 1);
