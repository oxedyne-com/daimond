// verify_workermodel.mjs — a Diamond's workers run on the model the USER chose.
//
// The defect this is built around: a worker was constructed on `cfg.model` — a
// view of the STARRED DEFAULT — however the Diamond that dispatched it was
// pinned. So a Diamond deliberately set to a strong model fanned its workers out
// onto whatever happened to be starred, and the whole fan-out was billed to that
// provider's key. Nothing on screen said so.
//
// Everything here is asserted on the OUTBOUND REQUEST, never on a field the test
// has just set: the question is which model and whose key actually went on the
// wire. Three models are in play at once, so the three answers are told apart —
//
//   mock/fast     the starred default          (the defect's answer)
//   mock/thinker  the Diamond's own model      (a half-fix's answer)
//   mock2/worker  the chosen worker model, on a SECOND provider with its own
//                 key and its own endpoint     (the right answer)
//
// The second provider is a mock served from this file, so "the provider travels
// with the model" is proved by the request arriving at the other endpoint with
// the other key, rather than by reading a variable back.
//
//   node dev/verify_workermodel.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). Starts its own second provider on :9300 and stops
// it at the end.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, clearMockLog, mockLog, shot, errors, MOCK } from './harness.mjs';

// Only so the preflight below can NAME the file it reads. Derived exactly as
// `harness.mjs` derives it, since it does not export the path itself.
const MOCK_LOG_PATH = process.env.DAIMOND_MOCK_LOG
	|| path.join(path.dirname(fileURLToPath(import.meta.url)), 'mockllm.log');

// THE PARCEL CEILING, READ FROM daimond.js RATHER THAN RESTATED.
//
// This was `10 * 1024 * 1024` written out here, under a check that read "still far
// inside its 10 MiB ceiling" -- a sentence that stayed green and stopped being true
// the day `SYNC_PARCEL_MAX` moved. A restated constant is right only until somebody
// changes the real one; `dev/verify_crystalcap.mjs` reads its two the same way.
const PARCEL_MAX = (() => {
	const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
		'..', 'www', 'js', 'daimond.js'), 'utf8');
	const m = /var\s+SYNC_PARCEL_MAX\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)\s*;/.exec(src);
	if (!m) throw new Error('verify_workermodel: SYNC_PARCEL_MAX not found in www/js/daimond.js');
	return Number(m[1]) * Number(m[2]) * Number(m[3]);
})();

// Offset by the world, so two worlds do not fight over one second provider.
//
// IN ITS OWN BAND, not adjacent to the world's. The base was 9097, two below the
// mock base of 9099, so world N's second provider was world N-2's MOCK: world 4
// bound 9101 and took world 2's provider out from under whoever was driving it,
// and the gate's world 9 sits on world 7's. `dev/world.sh` hands out 8777+N and
// 9099+N; 9300+N meets neither for any world worth numbering.
const PORT2  = Number(process.env.DAIMOND_MOCK2_PORT
	|| 9300 + (Number(process.env.DAIMOND_PORT || 8777) - 8777));
const URL2   = `http://127.0.0.1:${PORT2}/v1/chat/completions`;
const KEY2   = 'key-two-only-mock2-holds-this';
const MODEL2 = 'mock2/worker';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

// ── The second provider ─────────────────────────────────────────────
//
// Every request it receives is kept whole: the model asked for, the key it was
// sent with, and the transcript, so a worker can be recognised by its task.
const seen = [];
const cors = (res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};
const mock2 = http.createServer((req, res) => {
	if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
	if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
		const body = JSON.stringify({ object: 'list', data: [{ id: MODEL2, object: 'model' }] });
		cors(res);
		res.writeHead(200, { 'content-type': 'application/json' });
		return res.end(body);
	}
	let raw = '';
	req.on('data', (c) => { raw += c; });
	req.on('end', async () => {
		let payload = {};
		try { payload = JSON.parse(raw); } catch { payload = {}; }
		seen.push({
			url:      req.url,
			model:    payload.model,
			auth:     req.headers.authorization || '',
			messages: payload.messages || [],
		});
		cors(res);
		res.writeHead(200, {
			'content-type':  'text/event-stream',
			'cache-control': 'no-cache',
			'connection':    'keep-alive',
		});
		const frame = (delta, finish = null) => ({
			id: 'chatcmpl-mock2', object: 'chat.completion.chunk', created: 1700000000,
			model: payload.model || MODEL2,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
		const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
		send(frame({ role: 'assistant', content: '' }));
		for (const w of ['Worker', 'reporting', 'from', 'the', 'second', 'provider.']) {
			send(frame({ content: w + ' ' }));
			await new Promise((r) => setTimeout(r, 5));
		}
		send(frame({}, 'stop'));
		send({ id: 'chatcmpl-mock2', object: 'chat.completion.chunk', model: payload.model || MODEL2,
			choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
		res.write('data: [DONE]\n\n');
		res.end();
	});
});
await new Promise((r) => mock2.listen(PORT2, '127.0.0.1', r));
console.log(`second provider on ${URL2}`);

// ── The shared mock must write the log this file reads ──────────────
//
// Half of what follows is asserted on the SHARED mock's log, and an empty log
// reads exactly like a model that was never called. So the two are proved to be
// one pair before anything is measured: a probe request goes to the mock this
// run drives, and the log this run reads has to grow by it.
//
// The 99c838e gate failed here and it was read as a product defect for a day.
// `dev/world.sh N --up` reuses a world that is already listening, so world 9 was
// still the mock an EARLIER gate had started in ITS worktree -- appending to
// `.wt/gate-b536d60/dev/mockllm-9.log` while every verifier in the newer
// worktree read its own, permanently empty, copy. `mockLog()` returned nothing,
// and the two checks that ask what the daimon ran on said the daimon ran on
// nothing. This refuses instead, and names the two paths, because a suite that
// measures a log nobody writes cannot say anything about the app at all.
const PROBE = 'workermodel-preflight-probe';
let live = '';
try {
	const before = mockLog().length;
	const r = await fetch(MOCK, {
		method:  'POST',
		headers: { 'content-type': 'application/json' },
		body:    JSON.stringify({ model: 'mock/fast', stream: false,
			messages: [{ role: 'user', content: PROBE }] }),
	});
	if (!r.ok) live = `the mock answered ${r.status}`;
	else {
		await r.text();
		if (mockLog().length <= before) live = 'the probe was not written to the log';
	}
} catch (e) {
	live = 'the mock could not be reached: ' + e.message;
}
if (live) {
	console.log('  REFUSED ' + live);
	console.log(`  driving:  ${MOCK}`);
	console.log(`  reading:  ${MOCK_LOG_PATH}`);
	console.log('  These are not one world. Everything below would measure an empty');
	console.log('  log and blame the app. `bash dev/world.sh N --down` then --up.');
	mock2.close();
	process.exit(2);
}
clearMockLog();

// ── Helpers ─────────────────────────────────────────────────────────

/// Wait for a condition, polling. Returns whether it came true.
const until = async (fn, ms = 20000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
};

/// Whether a logged request is a WORKER's turn on `task`, rather than the
/// daimon's own turn about it.
///
/// Mentioning the task is not enough to tell them apart: the daimon's transcript
/// carries its `spawn_agent` call, arguments and all, so every round of the
/// dispatching turn quotes the task too. A worker's turn is the one where the
/// task IS the user message — that distinction is the whole point, since a check
/// that cannot make it passes against the defect it is meant to catch.
const isWorkerTurn = (e, task) => (e.messages || []).some(
	(m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim() === task);

/// The WORKER turns the shared mock received for `task` — the ones that should
/// never exist when the worker model belongs to another provider.
const sharedFor = (task) => mockLog().filter((e) => isWorkerTurn(e, task));
/// Same, for the second provider.
const mock2For = (task) => seen.filter((e) => isWorkerTurn(e, task));

/// Choose one option of a `<select>` by model AND provider, then fire `change`
/// the way a user's click does. The same model id can sit under two providers,
/// so `sel.value = m` is not enough — it takes whichever comes first.
const chooseIn = (page, selector, nth, model, provider) => page.evaluate(
	({ selector, nth, model, provider }) => {
		const sel = [...document.querySelectorAll(selector)][nth];
		if (!sel) return 'no such select';
		const opt = [...sel.querySelectorAll('option')]
			.find((o) => o.value === model && o.dataset.provider === provider);
		if (!opt) return 'no such option';
		opt.selected = true;
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		return '';
	}, { selector, nth, model, provider });

/// Press the OK of the dialog that is ON SCREEN.
///
/// `.dlg-ok` is worn by more than one control -- a tile dialog's Delete carries
/// it too -- and a bare `page.click('.dlg-ok')` takes whichever comes first in
/// the document, which is a button belonging to a dialog that is shut. Playwright
/// then waits thirty seconds for it to become visible and fails on a timeout that
/// says nothing about the real fault.
///
/// Two things decide which one that is, and both had to be learnt the hard way.
///
/// The test is the BUTTON's own visibility, never its card's: a tile dialog keeps
/// Delete inside a collapsed Advanced disclosure, so that card has layout boxes
/// while the button in it has none, and asking the card picks it regardless.
///
/// And dialogs STACK -- a fold prompt opens over the tile dialog that raised it --
/// so it is the LAST visible one that is on top and being answered, not the first.
/// `refocus` in daimond.js walks the same list backwards for the same reason.
const clickOk = (page) => page.evaluate(() => {
	const btns = [...document.querySelectorAll('.modal .dlg-ok')]
		.filter((b) => b.getClientRects().length);
	const btn = btns[btns.length - 1];
	if (!btn) return 'no visible OK';
	btn.click();
	return '';
});

const s = await open({ name: 'wmodel' + Date.now() });
const p = s.page;

// ── The second provider, as the app sees it ─────────────────────────
const added = await p.evaluate(async ({ url, key }) => {
	DaimondModels.addProvider('mock2', { name: 'Mock Two', url: url });
	await DaimondModels.setKey('mock2', key);
	await DaimondModels.fetchModels('mock2');
	const r = DaimondModels.resolve('mock2', 'mock2/worker');
	const d = DaimondModels.getDefault();
	return { resolved: !!r, url: r && r.baseUrl, defProv: d.provider, defModel: d.model };
}, { url: URL2, key: KEY2 });
// The first provider's id is minted from its URL, so it is read rather than guessed.
const DEF = added.defProv;
check('a second provider is configured, with its own key and endpoint',
	added.resolved && added.url === URL2, added.url);
check('the starred default is still the FIRST provider\'s model',
	added.defModel === 'mock/fast' && DEF !== 'mock2', DEF + ' ' + added.defModel);

// ── The New Diamond dialog ──────────────────────────────────────────
await p.click('#new-diamond-btn');
await p.waitForSelector('.dlg-select', { timeout: 8000 });
const dlg = await p.evaluate(() => {
	const sels = [...document.querySelectorAll('.dlg-select')];
	const labs = [...document.querySelectorAll('.cfg-fieldlabel')].map((l) => l.textContent);
	return {
		count: sels.length,
		// The worker pulldown is BELOW the model pulldown: same parent, later in it.
		below: sels.length === 2
			&& sels[0].compareDocumentPosition(sels[1]) === Node.DOCUMENT_POSITION_FOLLOWING,
		labelled: sels.length === 2 && !!sels[1].getAttribute('aria-label'),
		labs,
	};
});
check('the New Diamond dialog has a worker-model pulldown below the model one',
	dlg.count === 2 && dlg.below, JSON.stringify(dlg.labs));
check('the worker pulldown says what happens if it is left alone', dlg.labelled);

await p.fill('.dlg-input', 'Worker Model Test');
// Move the Diamond's OWN model, and the worker pulldown should follow it: that
// is what "defaults to the main model" means while the dialog is still open.
const chose = await chooseIn(p, '.dlg-select', 0, 'mock/thinker', DEF);
check('the Diamond model can be chosen', chose === '', chose);
const followed = await p.evaluate(() =>
	[...document.querySelectorAll('.dlg-select')][1].value);
check('the worker pulldown follows the Diamond\'s model until it is moved',
	followed === 'mock/thinker', followed);
// Now move it off, onto the second provider's model.
const chose2 = await chooseIn(p, '.dlg-select', 1, MODEL2, 'mock2');
check('the worker model can be chosen from another provider', chose2 === '', chose2);
await shot(s, 'workermodel-1-dialog');
await clickOk(p);
await p.waitForTimeout(1500);

const stored = await p.evaluate(() => {
	const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
	const ids = Object.keys(all);
	return { id: ids[ids.length - 1], rec: all[ids[ids.length - 1]] };
});
check('the Diamond records both pairs',
	!!stored.rec && stored.rec.model === 'mock/thinker'
		&& stored.rec.workerModel === MODEL2 && stored.rec.workerProvider === 'mock2',
	JSON.stringify(stored.rec));

// ── The behavioural check: what actually goes on the wire ───────────
const TASK1 = 'INSPECT-THE-LEDGER-ALPHA';
clearMockLog();
seen.length = 0;
await p.fill('#chat-input',
	`@tools spawn_agent {"name":"alpha","task":"${TASK1}"}`);
await p.keyboard.press('Enter');
const ran1 = await until(async () => mock2For(TASK1).length > 0, 30000);
await p.waitForTimeout(1200);
await shot(s, 'workermodel-2-dispatched');

const w1 = mock2For(TASK1)[0];
check('the worker turn reached the chosen model\'s provider', ran1 && !!w1,
	ran1 ? '' : 'nothing arrived at the second provider');
check('the worker ran on the model the user chose for workers',
	!!w1 && w1.model === MODEL2, w1 && w1.model);
check('the worker carried THAT provider\'s key, not the default provider\'s',
	!!w1 && w1.auth === 'Bearer ' + KEY2, w1 && (w1.auth || '').slice(0, 16) + '…');
// The defect, stated as the thing that must not happen: the worker's task never
// went to the starred default's endpoint at all — on any model.
check('the worker never went to the starred default\'s provider',
	sharedFor(TASK1).length === 0,
	sharedFor(TASK1).map((e) => e.model).join(','));
// And the daimon itself still ran on the DIAMOND's model, so a fix that simply
// moved everything onto the worker model would be caught too.
const steer1 = mockLog().filter((e) => JSON.stringify(e.messages || []).includes('spawn_agent'));
check('the daimon still ran on the Diamond\'s own model',
	steer1.length > 0 && steer1.every((e) => e.model === 'mock/thinker'),
	steer1.map((e) => e.model).join(','));

// ── A Diamond that predates the setting ─────────────────────────────
//
// Its record carries a model and NOTHING about workers. Absent has to mean the
// Diamond's own model; reading it as the starred default is the defect, kept.
await p.click('#new-diamond-btn');
await p.waitForSelector('.dlg-select', { timeout: 8000 });
await p.fill('.dlg-input', 'Legacy Diamond');
await chooseIn(p, '.dlg-select', 0, 'mock/thinker', DEF);
await clickOk(p);
await p.waitForTimeout(1500);
const legacy = await p.evaluate(() => {
	const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
	const ids = Object.keys(all);
	const id  = ids[ids.length - 1];
	// Exactly what an older build wrote: the two fields it knew about.
	all[id] = { provider: all[id].provider, model: all[id].model };
	localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
	return { id, rec: all[id] };
});
check('a Diamond written by an older build carries no worker model',
	!('workerModel' in legacy.rec), JSON.stringify(legacy.rec));

const TASK2 = 'INSPECT-THE-LEDGER-BETA';
clearMockLog();
seen.length = 0;
await p.fill('#chat-input', `@tools spawn_agent {"name":"beta","task":"${TASK2}"}`);
await p.keyboard.press('Enter');
const ran2 = await until(async () => sharedFor(TASK2).length > 0, 30000);
await p.waitForTimeout(1200);
const w2 = sharedFor(TASK2)[0];
check('an existing Diamond\'s workers run on the Diamond\'s own model',
	ran2 && !!w2 && w2.model === 'mock/thinker', w2 && w2.model);
check('an existing Diamond\'s workers do NOT fall back to the starred default',
	sharedFor(TASK2).every((e) => e.model !== 'mock/fast'),
	sharedFor(TASK2).map((e) => e.model).join(','));

// ── The chat a person really gets ───────────────────────────────────
//
// THE PENDING TILE HAS GONE, AND SO HAS EVERYTHING THIS BLOCK USED TO DRIVE.
// CHAT-01 made `renderPendingCentre` start a startable chat at once, so a chat
// created while a provider resolves is ACTIVE by the time the rail has drawn
// it: `.session-box.pending` matches nothing, and `.tile-start` is not in
// www/js/daimond.js at all any more. The old block asked for two pulldowns on
// a tile that no longer draws them, failed on the selector, and then threw
// reading `sels[0].value` — a red that said nothing whatever about worker
// models, and which took the persistence and parcel checks below down with it.
//
// It is not restored against a manufactured pending chat. The two pulldowns
// were the only place a CHAT's worker model was ever chosen by hand, and with
// the tile gone that choice is not in the product; a check that drove a state
// the app no longer reaches would assert a feature nobody has. What is left is
// the property this file is actually about — a chat carries a worker model of
// its own, it is the one it started on, and it survives the save and the
// parcel — and that is asserted on a chat the app really made.
await p.click('#new-session-btn', { force: true });
await p.waitForTimeout(1500);
const tile = await p.evaluate(() => {
	const box = document.querySelector('#session-list .session-box');
	return {
		pending: document.querySelectorAll('.session-box.pending').length,
		// -1 rather than 0 for "there was no tile at all", so an empty rail cannot
		// pass this as "no pulldowns".
		sels:    box ? box.querySelectorAll('select.tile-model').length : -1,
	};
});
check('a chat that CAN start is started, not left pending on its tile (CHAT-01)',
	tile.pending === 0 && tile.sels === 0, JSON.stringify(tile));
const chatWorker = await p.evaluate(async () => {
	const st = await DaimondCore.chatStore().stored();
	// The chat just made, not a Diamond's daimon: a daimon's record carries the
	// Diamond's worker pair and would answer a different question.
	const c = (Array.isArray(st) ? st : []).filter((x) => x && !x.diamondId)[0];
	return c ? { model: c.model, worker: c.workerModel, prov: c.workerProvider } : null;
});
check('and it carries a worker model of its own, seeded from its own model',
	!!chatWorker && !!chatWorker.worker && chatWorker.worker === chatWorker.model,
	JSON.stringify(chatWorker));
await shot(s, 'workermodel-3-tile');
// ── Persisted, and carried in the parcel ────────────────────────────
const persisted = await p.evaluate(async () => {
	const st = await DaimondCore.chatStore().stored();
	const c  = (Array.isArray(st) ? st : []).filter((x) => x && !x.diamondId && x.workerModel)[0];
	return c ? { model: c.model, worker: c.workerModel, prov: c.workerProvider } : null;
});
// The pair it STARTED ON, not a hand-picked one: see the block above for why
// there is no longer a hand to pick it with. The property is that the pair is
// written down at all -- a chat whose worker model lived only in memory would
// dispatch its next fan-out to whatever the starred default happened to be.
check('a started chat persists the worker model it was given',
	!!persisted && persisted.worker === persisted.model && !!persisted.prov,
	JSON.stringify(persisted));

const parcel = await p.evaluate(async () => {
	const j = await DaimondCore.collectSync();
	const chats = (j.chats || []).filter((c) => c.workerModel);
	const dias  = (j.diamonds || []).filter((d) => d.model && d.model.workerModel);
	return {
		bytes:      JSON.stringify(j).length,
		chatWorker: chats.length ? chats[0].workerModel : '',
		diaWorker:  dias.length ? dias[0].model.workerModel : '',
		diaProv:    dias.length ? dias[0].model.workerProvider : '',
	};
});
check('the parcel\'s CHAT section carries the chat\'s worker model',
	!!parcel.chatWorker, parcel.chatWorker);
check('the parcel\'s DIAMOND section carries the Diamond\'s worker model',
	parcel.diaWorker === MODEL2 && parcel.diaProv === 'mock2',
	parcel.diaWorker + ' / ' + parcel.diaProv);
check('the parcel is still far inside the ceiling daimond.js sets itself',
	parcel.bytes < PARCEL_MAX, parcel.bytes + ' of ' + PARCEL_MAX + ' bytes');

// ── A Diamond cut from a chat inherits both ─────────────────────────
//
// The fold picker refuses an empty chat, so the chat says something first.
await p.fill('#chat-input', '@text something worth keeping');
await p.click('#chat-send', { force: true });
await p.waitForTimeout(3000);
// "Fold all" moved off the row and into the cog (CHAT-15): the cog opens
// first, then the fold button `mountChatFoldKeep` draws inside it.
await p.evaluate(() => {
	const box = document.querySelector('.session-box.active');
	const cog = box && box.querySelector('.tile-cog');
	if (cog) cog.click();
});
await p.waitForTimeout(300);
await p.evaluate(() => {
	const card = [...document.querySelectorAll('.modal.dlg .dlg-card')]
		.find((c) => c.getClientRects().length);
	const b = card && card.querySelector('.tile-fold');
	if (b) b.click();
});
await p.waitForTimeout(400);
const opened = await p.evaluate(() => {
	const item = document.querySelector('.fold-menu-item.new');
	if (!item) return false;
	item.click();
	return true;
});
if (opened) {
	await p.waitForSelector('.dlg-input', { timeout: 8000 });
	await p.fill('.dlg-input', 'Cut From Chat');
	await clickOk(p);
	await p.waitForTimeout(2500);
}
const cut = await p.evaluate(() => {
	const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
	const ids = Object.keys(all);
	return all[ids[ids.length - 1]] || null;
});
// THE CHAT'S pair, read back rather than named. This asked for `MODEL2` until
// 2026-09-15, which is the DIAMOND's worker model: the chat seeds its own from
// its own model (`mock/fast`), as the check three blocks up states, so the
// expectation named a pair the chat never carried. The check could not say so
// because it never ran -- `page.click('.dlg-ok')` was pressing a shut dialog's
// Delete, and the run died on that timeout before reaching here.
check('a Diamond cut from a chat inherits that chat\'s worker model',
	opened && !!cut && !!persisted
		&& cut.workerModel === persisted.worker && cut.workerProvider === persisted.prov,
	JSON.stringify(cut) + ' from chat ' + JSON.stringify(persisted));

console.log('\nconsole errors:', errors(s).slice(0, 4).join(' | ') || '(none)');
console.log(`\nworker model: ${ok.length} ok, ${bad.length} failed.`);
if (bad.length) console.log('failed: ' + bad.join(' | '));
await s.close();
mock2.close();
process.exit(bad.length ? 1 : 0);
