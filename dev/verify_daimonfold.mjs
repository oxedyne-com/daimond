// verify_daimonfold.mjs — the daimon-chat Fold button: absorb into the crystal,
// commit it, and start a fresh session. One click, no accept/reject.
//
// OWNER DECISIONS 2026-09-04.
//  * "Fresh daimon" was removed; its clear-conversation capability moved onto Fold.
//  * "Fold means fold, done": a fold COMMITS the crystal directly — no diff prompt,
//    no Accept/Reject. The crystal's version history is the undo path.
// So clicking Fold on a daimon's chat must:
//   1. update the crystal from the CURRENT transcript (the reducer round), commit
//      it as a new version (the previous version stays readable = rollback-able),
//   2. clear the conversation to a fresh session — empty thread, updated crystal,
// with NO diff shown. Two guards survive because they are not the review: an empty
// reducer reply is NOT written (and then the transcript is NOT cleared either), and
// the 2026-08-14 data-loss guard (clearing one daimon must not shorten another).
//
//   eval "$(bash dev/world.sh N --up)" ; eval "$(bash dev/world.sh N --env)"
//   node dev/verify_daimonfold.mjs
import { open, connectMock, scratch, errors, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

const s = await open({ name: 'daimonfold', profile: scratch('pw', 'daimonfold-' + process.pid) });
const { page: p } = s;
await connectMock(s, { model: 'deepseek/deepseek-v4-pro' });

// A raw DaimondApp reads the same OPFS store the UI writes — crystal content, the
// version counter, and any past version's snapshot (the rollback target).
await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	window.__vf = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
});
const crystalOf = (id) => p.evaluate((i) => window.__vf.read_crystal_data(i), id);
const versionOf = (id) => p.evaluate(async (i) => {
	const r = JSON.parse(await window.__vf.list_diamonds()).find((x) => x.id === i);
	return r ? (r.crystal_version || 0) : -1;
}, id);
const versionSnapshot = (id, v) => p.evaluate((a) => window.__vf.read_version(a.id, a.v), { id, v });
const toastsSetup = () => p.evaluate(() => {
	window.__t = [];
	new MutationObserver((muts) => { for (const mu of muts) for (const n of mu.addedNodes) {
		if (n.nodeType === 1 && n.classList && n.classList.contains('daimond-toast'))
			window.__t.push({ text: n.textContent, err: n.classList.contains('err') });
	} }).observe(document.body, { childList: true });
});
const toasts = () => p.evaluate(() => (window.__t || []).slice());
await toastsSetup();

async function makeDiamond(name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm; inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await p.waitForTimeout(1400);
	return p.evaluate((nm) => {
		const box = [...document.querySelectorAll('.diamond-box')].find((b) => (b.textContent || '').includes(nm));
		return box ? box.dataset.id : '';
	}, name);
}
const openChat = async (id) => {
	await p.evaluate((i) => { document.querySelector(`.diamond-box[data-id="${i}"]`).click(); }, id);
	await p.waitForTimeout(600);
	await p.click('#dview-chat', { force: true });
	await p.waitForTimeout(600);
};
const say = async (text, ms = 4000) => { await p.fill('#chat-input', text); await p.click('#chat-send'); await p.waitForTimeout(ms); };
const msgCount = (id) => p.evaluate((i) => {
	const c = window.DaimondDiamond && window.DaimondDiamond.conversation(i);
	return c ? (c.messages || []).length : -1;
}, id);
const sessCount = (id) => p.evaluate((i) => {
	const c = window.DaimondDiamond && window.DaimondDiamond.conversation(i);
	return c ? (((c.session || {}).msgs) || []).length : -1;
}, id);
const diffShown = () => p.evaluate(() => ({
	accept: !!document.querySelector('.diff-accept'),
	reject: !!document.querySelector('.diff-reject'),
	lines:  document.querySelectorAll('.diff-lines .diff-line').length,
}));

// Two daimons, each with a conversation of its own.
const dee = await makeDiamond('Dee');
await openChat(dee);
await say('remember the word ORTOLAN for me');
const dum = await makeDiamond('Dum');
await openChat(dum);
await say('and you should remember RANUNCULUS');

const deeBefore = await msgCount(dee);
const dumBefore = await msgCount(dum);
const v0 = await versionOf(dee);
const c0 = await crystalOf(dee);
check('both daimons hold a conversation before the fold',
	deeBefore > 0 && dumBefore > 0, `Dee=${deeBefore} Dum=${dumBefore}`);

// Fold Dee's chat into its own Diamond, by a REAL click on the header Fold button.
await openChat(dee);
const foldVisible = await p.evaluate(() => {
	const b = document.getElementById('chat-fold-btn');
	return b && getComputedStyle(b).display !== 'none';
});
check('the Fold button is offered on the daimon chat', foldVisible);
await p.click('#chat-fold-btn', { force: true });
await p.waitForTimeout(4000);   // the reducer round + the commit + the clear

// 1. The crystal was COMMITTED as a new version — no diff prompt anywhere.
const v1 = await versionOf(dee);
const c1 = await crystalOf(dee);
const dshow = await diffShown();
check('1a. NO Accept/Reject diff is shown — the fold committed directly',
	dshow.accept === false && dshow.reject === false && dshow.lines === 0, JSON.stringify(dshow));
check('1b. the crystal was written a NEW version (committed, not proposed)',
	v1 > v0, `version ${v0} → ${v1}`);
check('1c. and the live crystal is the folded content, mentioning what was said',
	c1 !== c0 && /ORTOLAN/.test(c1), `changed=${c1 !== c0}, mentions ORTOLAN=${/ORTOLAN/.test(c1)}`);
await shot(s, 'daimonfold-1-crystal-committed');

// 1d. The version history holds the PRE-fold crystal — the rollback target.
const snap = await versionSnapshot(dee, v0);
check('1d. the previous version is still readable in history — the fold is rollback-able',
	String(snap).trim() === String(c0).trim(), `v${v0} snapshot matches the pre-fold crystal: ${String(snap).trim() === String(c0).trim()}`);

// 2. Dee's transcript is now FRESH — empty thread and empty (not null) session.
const deeAfter = await msgCount(dee);
const deeSess = await sessCount(dee);
check('2a. Dee\'s transcript RESET to empty (fresh session)',
	deeAfter === 0, `messages now ${deeAfter} (was ${deeBefore})`);
check('2b. and its session is EMPTY, not absent (so the store cannot bring it back)',
	deeSess === 0, `session msgs ${deeSess}`);

// 3. THE DATA-LOSS GUARD: Dum's conversation is untouched.
const dumAfter = await msgCount(dum);
check('3. folding Dee did NOT shorten Dum — the guard holds', dumAfter === dumBefore && dumAfter > 0, `Dum ${dumBefore} → ${dumAfter}`);

// 4. Switching back to Dee's chat face shows an empty thread. (ORTOLAN is now in
// the crystal — the System tile shows it — so the thread is measured by its OWN
// tiles: the conversation's user/reply tiles are gone.)
await openChat(dee);
const threadOnScreen = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	return {
		convoTiles: out.querySelectorAll('.ctile[data-t="user"], .ctile[data-t="reply"]').length,
		emptyState: !!out.querySelector('.empty-state'),
	};
});
check('4. Dee\'s chat face draws an empty thread — the conversation tiles are gone',
	threadOnScreen.convoTiles === 0, JSON.stringify(threadOnScreen));
await shot(s, 'daimonfold-2-chat-fresh');

/// Wait until Dee's daimon is idle, so a fold actually runs the reducer rather
/// than being refused for a turn still in flight.
const waitIdle = async (id, ms = 20000) => {
	const t0 = Date.now();
	for (;;) {
		const gen = await p.evaluate((i) => {
			const c = window.DaimondDiamond && window.DaimondDiamond.conversation(i);
			return !!(c && c._generating);
		}, id);
		if (!gen) return true;
		if (Date.now() - t0 > ms) return false;
		await p.waitForTimeout(300);
	}
};

// 5. AN EMPTY REDUCER REPLY IS NOT WRITTEN, AND DOES NOT CLEAR THE TRANSCRIPT.
// Give Dee a fresh conversation, then make the reducer answer with nothing.
await say('now remember MARJORAM as well');
await waitIdle(dee);            // so the fold RUNS the reducer, not refused for busy
const beforeEmpty = await msgCount(dee);
const vBeforeEmpty = await versionOf(dee);
const EMPTY_SSE = [
	'data: {"id":"x","object":"chat.completion.chunk","model":"mock/fast","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
	'',
	'data: {"id":"x","object":"chat.completion.chunk","model":"mock/fast","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
	'',
	'data: [DONE]',
	'',
].join('\n');
await p.route('**/v1/chat/completions', (route) => route.fulfill({
	status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: EMPTY_SSE,
}));
await p.evaluate(() => { window.__t = []; });
await p.click('#chat-fold-btn', { force: true });
await p.waitForTimeout(6000);
await p.unroute('**/v1/chat/completions');
const tEmpty = await toasts();
const dlgEmpty = await p.evaluate(() => {
	const d = document.querySelector('.dlg-card, .modal.dlg');
	return d ? (d.textContent || '').slice(0, 120) : '';
});
const vAfterEmpty = await versionOf(dee);
const afterEmpty = await msgCount(dee);
// The user is TOLD, whether by a toast or a dialog; both surface a failed fold.
const reported = tEmpty.some((x) => x.err) || /empty|nothing|could not|fold/i.test(dlgEmpty);
check('5a. an empty reducer reply is NOT written to the crystal (no new version) and is reported',
	vAfterEmpty === vBeforeEmpty && reported,
	`version ${vBeforeEmpty} → ${vAfterEmpty}, toasts ${JSON.stringify(tEmpty.slice(0, 2))}, dialog ${JSON.stringify(dlgEmpty)}`);
check('5b. and the transcript is NOT cleared — a bad round does not lose the conversation',
	afterEmpty === beforeEmpty && afterEmpty > 0, `messages ${beforeEmpty} → ${afterEmpty}`);

// 6. After a reload the reset STICKS and Dum stays whole.
await p.reload({ waitUntil: 'domcontentloaded' });
const { signInAs } = await import('./harness.mjs');
await p.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'daimonfold').catch(() => {});
await p.waitForTimeout(1200);
const dumReload = await msgCount(dum);
check('6. after a reload Dum stays whole', dumReload === dumBefore, `Dum=${dumReload}/${dumBefore}`);

const errs = errors(s).filter((e) => !/502|\/api\//.test(e));
check('7. nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
