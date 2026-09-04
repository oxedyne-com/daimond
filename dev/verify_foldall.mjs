// verify_foldall.mjs — the fold never fails in silence.
//
// The bug this exists for: a user selected every turn of a chat, pressed Fold,
// picked a Diamond, and NOTHING happened. Not an error, not a spinner, not a
// diff. Every exit from the fold path was either invisible (a 12px status line
// on a panel the user may have left) or literally a bare `return`, and a throw
// past the one try block left `crystalBusy` true for the rest of the session —
// Steer and Propose dead, with no explanation.
//
// So each check here is one way out of the fold, and what it asserts is that the
// user can SEE it happened. The one that matters most is the last shape of the
// failure: an empty reply from the reducer must NEVER be written to the crystal.
//
// FOLDS COMMIT DIRECTLY NOW (owner decision 2026-09-04): there is no Accept/Reject
// diff. A fold writes straight to the crystal and the version history is the undo.
// So "a visible result" is a committed crystal and a toast, not a diff — and the
// empty-reply guard is proved by the crystal being UNCHANGED, not by an unarmed
// Accept button. The crystal version snapshot on write is what makes a fold the
// owner did not want a rollback rather than a refusal.
//
//   node dev/verify_foldall.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.

import { open, chat, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DIAMOND = 'Fold Target';
const s = await open({ name: 'foldall' });
const p = s.page;

// Toasts are the app's own floating status line; `.err` marks a failure. They
// remove themselves after ~4s, which is shorter than some of the waits here, so
// they are RECORDED as they appear rather than looked for afterwards — a check
// that polls for a live toast passes or fails on the sleep it happened to use.
await p.evaluate(() => {
	window.__toasts = [];
	new MutationObserver(muts => {
		for (const m of muts) for (const n of m.addedNodes) {
			if (n.nodeType === 1 && n.classList && n.classList.contains('daimond-toast')) {
				window.__toasts.push({ text: n.textContent, err: n.classList.contains('err') });
			}
		}
	}).observe(document.body, { childList: true });
});
const toasts = () => p.evaluate(() => window.__toasts.slice());
const clearToasts = () => p.evaluate(() => {
	window.__toasts = [];
	document.querySelectorAll('.daimond-toast').forEach(e => e.remove());
});
// The Diamond's own crystal surface: is a diff on show, and can it be applied?
const diffState = () => p.evaluate(() => {
	const lines = document.querySelectorAll('.diff-lines .diff-line');
	const acc = document.querySelector('.diff-accept');
	let add = 0, del = 0;
	lines.forEach(l => { if (l.classList.contains('add')) add++; if (l.classList.contains('del')) del++; });
	return {
		lines: lines.length, add, del,
		accept: !!acc, acceptEnabled: !!acc && !acc.disabled,
		// The crystal's own delta box and Propose button are gone -- a Diamond
		// has one composer, in the chat face -- so what "not stuck" means now is
		// that the SELECTION path can be used again: `crystalBusy` released, and
		// Fold selected offered.
		foldSel: !!document.getElementById('sel-fold'),
		foldSelDisabled: !!(document.getElementById('sel-fold') || {}).disabled,
	};
});
/// How much of the user's own text a Diamond's crystal holds, read from
/// `crystal.json` through the store.
///
/// IT USED TO MEASURE THE PANEL, and the panel no longer holds it: a crystal with
/// anything in it is drawn by that Diamond's own page inside a sandboxed frame,
/// so `.crystal-body` has no text of its own for `textContent` to count. That
/// probe would not have failed -- it would have returned 0 for every Diamond and
/// turned two preconditions into checks that can never bite, which is the quieter
/// and worse outcome. Both uses below are preconditions of the form "there is
/// something here worth deleting", so what they want is the words, not the
/// markup: the JSON's own braces and key names are not the user's, and are not
/// counted.
///
/// Returns -1 for a Diamond that is not there and -2 for one whose crystal is not
/// JSON, so a broken store reads differently from an empty one.
const crystalWords = (name) => p.evaluate(async (name) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const row = JSON.parse(await app.list_diamonds()).find(r => r.name === name);
	if (!row) return -1;
	const text = await app.read_crystal_data(row.id);
	if (!String(text).trim()) return 0;
	let data;
	try { data = JSON.parse(text); } catch (e) { return -2; }
	let n = 0;
	(function walk(v) {
		if (typeof v === 'string') n += v.length;
		else if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k]));
	})(data);
	return n;
}, name);
const dialogText = () => p.evaluate(() => {
	const c = document.querySelector('.dlg-card');
	return c ? c.textContent : '';
});
const dismissDialog = async () => {
	if (await p.$('.dlg-ok')) { await p.click('.dlg-ok', { force: true }); await sleep(300); }
};

// ── Seed: one Diamond and a chat of four turns ───────────────────────
await p.click('#new-diamond-btn', { force: true });
await p.waitForSelector('.dlg-input', { timeout: 10000 });
await p.fill('.dlg-input', DIAMOND);
await p.click('.dlg-ok', { force: true });
await sleep(1000);
for (const m of ['MARK-ONE', 'MARK-TWO', 'MARK-THREE', 'MARK-FOUR']) {
	await chat(s, `@text ${m} and something worth keeping about it.`);
}

/// Select every turn and fold the lot into the Diamond. Returns once the picker
/// item has been clicked; the caller decides how long to wait for the reducer.
async function foldAll({ pickName = DIAMOND } = {}) {
	// Back into the chat, in case a previous check left the centre on a Diamond.
	await p.evaluate(() => {
		const box = document.querySelector('.session-box:not(.diamond-box)');
		if (box) box.click();
	});
	await sleep(600);
	await p.evaluate(() => {
		const c = document.getElementById('collapse-btn');
		if (c && !c.classList.contains('on')) c.click();
	});
	await sleep(400);
	await p.click('#sel-all', { force: true });
	await sleep(200);
	await p.click('#sel-fold', { force: true });
	await p.waitForSelector('.fold-menu', { timeout: 8000 });
	await p.evaluate((name) => {
		const item = [...document.querySelectorAll('.fold-menu-item')]
			.find(b => b.textContent.trim() === name);
		if (item) item.click();
	}, pickName);
}

/// Wait until the fold has visibly resolved one way or the other.
async function settled(timeout = 20000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const d = await diffState();
		if (d.lines > 0) return 'diff';
		if ((await toasts()).length) return 'toast';
		if (await p.$('.dlg-card')) return 'dialog';
		await sleep(250);
	}
	return 'nothing';
}

// ── 1. Folding the whole chat COMMITS a visible change, not silence ──
await clearToasts();
const before1 = await crystalWords(DIAMOND);
await foldAll();
const outcome1 = await settled(20000);
const d1 = await diffState();
check('folding every turn produces a visible result, not silence',
	outcome1 !== 'nothing', `outcome=${outcome1}`);
check('and there is NO Accept/Reject diff — the fold commits directly',
	d1.accept === false && d1.lines === 0, `accept=${d1.accept} diffLines=${d1.lines}`);
await sleep(2000);
const crystalLen = await crystalWords(DIAMOND);
check('the fold WROTE straight into the crystal (something is now there)',
	crystalLen > 20 && crystalLen !== before1, `${before1} → ${crystalLen} chars`);
await shot(s, 'foldall-committed');

// ── 2. A provider failure is shown, and does not wedge the crystal ───
await clearToasts();
await p.route('**/v1/chat/completions', route => route.fulfill({
	status: 400,
	contentType: 'application/json',
	body: JSON.stringify({ error: { message: 'routed: refused' } }),
}));
await foldAll();
await settled(20000);
const t2 = await toasts();
check('a reducer that fails says so, out loud',
	t2.some(x => x.err), JSON.stringify(t2.slice(0, 2)));
await p.unroute('**/v1/chat/completions');
// Back on the Diamond: the controls must be live again. A sticky crystalBusy
// leaves Propose disabled for the rest of the session.
await p.evaluate((name) => {
	const box = [...document.querySelectorAll('.diamond-box')]
		.find(b => (b.querySelector('.session-box-name') || {}).textContent === name);
	if (box) box.click();
}, DIAMOND);
await sleep(1200);
const d2 = await diffState();
check('and the crystal is not left disabled by the failure',
	d2.foldSel && !d2.foldSelDisabled, `fold-selected present=${d2.foldSel} disabled=${d2.foldSelDisabled}`);

// ── 3. A Diamond deleted under the picker is refused loudly ──────────
// The realistic case: another tab deletes it while the picker is open. The rail
// re-reads on the storage event, so the id the menu item holds is stale.
await clearToasts();
await p.evaluate(() => {
	const box = document.querySelector('.session-box:not(.diamond-box)');
	if (box) box.click();
});
await sleep(600);
await p.evaluate(() => {
	const c = document.getElementById('collapse-btn');
	if (c && !c.classList.contains('on')) c.click();
});
await sleep(400);
await p.click('#sel-all', { force: true });
await p.click('#sel-fold', { force: true });
await p.waitForSelector('.fold-menu', { timeout: 8000 });
// Delete it for real, then tell this tab the way another tab would.
await p.evaluate(async (name) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const row = JSON.parse(await app.list_diamonds()).find(r => r.name === name);
	if (row) await app.delete_diamond(row.id);
	window.dispatchEvent(new StorageEvent('storage', { key: 'daimond-diamonds-rev', newValue: String(Date.now()) }));
}, DIAMOND);
await sleep(1500);
await p.evaluate((name) => {
	const item = [...document.querySelectorAll('.fold-menu-item')]
		.find(b => b.textContent.trim() === name);
	if (item) item.click();
}, DIAMOND);
await sleep(1200);
const dlg3 = await dialogText();
check('folding into a Diamond that has gone says so, rather than doing nothing',
	/gone/i.test(dlg3), dlg3 ? dlg3.slice(0, 90) : '(no dialog at all)');
await dismissDialog();

// ── 4. An empty reply is a failure, never a deletion diff ────────────
// A second Diamond, folded once so its crystal is not empty, then the reducer is
// made to answer with nothing at all.
await p.click('#new-diamond-btn', { force: true });
await p.waitForSelector('.dlg-input', { timeout: 10000 });
await p.fill('.dlg-input', 'Empty Reply');
await p.click('.dlg-ok', { force: true });
await sleep(1000);
await clearToasts();
await foldAll({ pickName: 'Empty Reply' });   // a real reducer round, commits directly
await settled(20000);
await sleep(2500);
// The precondition, asserted rather than assumed: an empty reply against an EMPTY
// crystal changes nothing anyway, so the check below would pass without proving
// anything. The first fold committed real content, so now there IS something to risk.
const emptyBase = await crystalWords('Empty Reply');
check('the second Diamond has a crystal worth deleting (the precondition of the next check)',
	emptyBase > 20, `${emptyBase} chars`);

// Now the empty stream: a well-formed SSE turn that says nothing.
const EMPTY_SSE = [
	'data: {"id":"x","object":"chat.completion.chunk","model":"mock/fast","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
	'',
	'data: {"id":"x","object":"chat.completion.chunk","model":"mock/fast","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
	'',
	'data: {"id":"x","object":"chat.completion.chunk","model":"mock/fast","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10}}',
	'',
	'data: [DONE]',
	'',
].join('\n');
await clearToasts();
await p.route('**/v1/chat/completions', route => route.fulfill({
	status: 200,
	headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
	body: EMPTY_SSE,
}));
await foldAll({ pickName: 'Empty Reply' });
await sleep(9000);
const t4 = await toasts();
await p.unroute('**/v1/chat/completions');
const emptyAfter = await crystalWords('Empty Reply');
check('an empty reducer reply is reported as a failure',
	t4.some(x => x.err), JSON.stringify(t4.slice(0, 2)));
check('and is NEVER written to the crystal — the guard refuses to apply it',
	emptyAfter === emptyBase && emptyAfter > 20, `${emptyBase} → ${emptyAfter} chars`);
await shot(s, 'foldall-empty-reply');

// ── 5. A slow fold still COMMITS when it returns, even if you left ───
// The reducer is slow on purpose; the user goes back to the chat while it runs.
// With no accept step the commit needs no second click, so a fold begun before
// the user walked away lands on its own — and says so.
await clearToasts();
const before5 = await crystalWords('Empty Reply');
await p.route('**/v1/chat/completions', async route => {
	await sleep(6000);
	await route.continue();
});
await foldAll({ pickName: 'Empty Reply' });
await sleep(1500);
await p.evaluate(() => {
	const box = document.querySelector('.session-box:not(.diamond-box)');
	if (box) box.click();                       // away from the Diamond, mid-fold
});
await sleep(14000);
await p.unroute('**/v1/chat/completions');
const after5 = await crystalWords('Empty Reply');
const t5 = await toasts();
check('a fold begun before you walked away still commits, on its own, when it returns',
	after5 !== before5 || t5.some(x => /Empty Reply|Folded/.test(x.text)),
	`${before5} → ${after5} chars; toasts ${JSON.stringify(t5.slice(0, 2))}`);
await shot(s, 'foldall-slow-commit');

// ── 6. The floor under the whole class ───────────────────────────────
// Most of this app is started rather than awaited: a click hands a promise to
// nobody. Each of the folds above is one such promise, and the fix for each was
// local — but a rejection escaping ANY of them must reach the user, or the next
// one written without a .catch is the same silence again.
await clearToasts();
await p.evaluate(() => { Promise.reject(new Error('probe: an escaped rejection')); });
await sleep(600);
const t6 = await toasts();
check('a promise rejection nobody handled still reaches the user',
	t6.some(x => x.err), JSON.stringify(t6.slice(0, 2)));

// The gateway is not running for this flow, so its 502s are the absence of a
// server. The routed 400 is this test's own doing.
// The probe rejection above is this test's own doing and is reported to the
// console as a pageerror by design: the app's handler tells the USER, it does not
// swallow the developer's copy.
const errs = errors(s).filter(e => !/favicon|404|401|402|502|Bad Gateway|net::ERR|400|probe: an escaped rejection/.test(e));
console.log('\nconsole errors:', errs.slice(0, 5));
check('nothing throws into the console while all this happens', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
