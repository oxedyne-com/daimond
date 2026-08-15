// verify_replylen.mjs — the reply-length cap, and the context meter.
//
// Two defects, one file, and both of them are about a number the app believed
// that was not true.
//
// ── The 4096-token output cap ────────────────────────────────────────────
// Every request carried `max_tokens: 4096`, whatever the model. 4096 OUTPUT
// tokens is about 250 lines of code, so a `file_write` of a 400-line module ran
// out of room part way — and because a tool call's arguments ARE a JSON string,
// what arrived was not a truncated file but a MALFORMED TOOL CALL. Nothing was
// written, and the model was told only that its JSON was bad.
//
// That is not a claim a unit test on a constant can settle, so it is not tested
// that way. `dev/mockcap.mjs` is a provider that HONOURS `max_tokens` and cuts
// the reply when it does not fit, exactly as a real one does, and logs the
// `max_tokens` of every request it is sent. The failure is demonstrated, then
// the fix is demonstrated, against the same 400-line write.
//
// ── The context meter reading ~12x high ──────────────────────────────────
// The tile meter drew `lastPrompt / contextWindow`, and `lastPrompt` was set to
// the turn's CUMULATIVE prompt tokens — the sum of every round. An agentic turn
// sends the whole conversation once per round, so a five-round turn read five
// times high. The per-round figure was tracked in Rust all along
// (`session.last_prompt_tokens`); there was no getter to read it back.
//
// The mock reports a KNOWN, DIFFERENT prompt figure per round — 5000, 10000,
// 15000, … — so "the last one" and "the sum of them" cannot be confused, and
// the number the meter draws is compared against what the provider actually
// sent, not against another part of the app.
//
// Needs `dev/serve.mjs` (`DAIMOND_PORT`, default 8777) and `dev/mockcap.mjs`
// (`DAIMOND_CAP_PORT`, default 9250 + the world number), the latter started here
// if it is not up -- and checked to BE mockcap, see the port note below.
//
// Every write it asks for goes into the chat's own scratch folder. A workspace-
// ROOT path is refused by the chat fence as an ordinary tool result, which reads
// as neither a write nor a cut: see `freshChat`.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, chat, newChat, shot } from './harness.mjs';

const HERE    = path.dirname(fileURLToPath(import.meta.url));
// The cap mock is a world fixture like the LLM mock, so its port and log follow
// the world's.  `dev/world.sh` numbers a world by its offset from port 8777.
const WORLD    = Number(process.env.DAIMOND_PORT || 8777) - 8777;
// 9250, NOT 9098. `9098 + WORLD` is `9099 + (WORLD - 1)`, which is the MOCK LLM
// PORT OF THE WORLD NEXT DOOR: in world 18 the cap mock's port was world 17's
// mockllm. The guard below found something answering /v1/models there, so no
// mockcap was started, and every request in this file went to another agent's
// mock -- which ignores `max_tokens` and does not log, so all eleven checks that
// read `lastAsk()` reported `max_tokens=null` and the two write checks measured
// mockllm's plain reply. Measured 2026-08-14 in world 18, with world 17 live.
// 9250 + WORLD is clear of every other fixture in this tree (compact 9188+N,
// pickers 9160+2N, applications 9400+N).
const CAP_PORT = Number(process.env.DAIMOND_CAP_PORT || 9250 + WORLD);
const CAP_LOG  = process.env.DAIMOND_CAP_LOG
	|| path.join(HERE, WORLD ? `mockcap-${WORLD}.log` : 'mockcap.log');
const CAP_URL = `http://127.0.0.1:${CAP_PORT}/v1/chat/completions`;
const MODEL   = 'cap/plain';

/// What the mock reports as round 0's prompt; round k reports (k+1) times it.
const ROUND_PROMPT = 5000;
/// The default the app should now send when nothing published a smaller ceiling.
const AUTO_MAX = 32768;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The mock ────────────────────────────────────────────────────────────

const up = (url) => new Promise((res) => {
	const r = http.get(url, () => res(true));
	r.on('error', () => res(false));
	r.setTimeout(700, () => { r.destroy(); res(false); });
});

const CAP_MODELS = `http://127.0.0.1:${CAP_PORT}/v1/models`;
let spawned = null;
if (!(await up(CAP_MODELS))) {
	spawned = spawn('node', [path.join(HERE, 'mockcap.mjs'), String(CAP_PORT)],
		{ stdio: 'ignore', detached: false, env: { ...process.env, DAIMOND_CAP_LOG: CAP_LOG } });
	for (let i = 0; i < 20 && !(await up(CAP_MODELS)); i++) {
		await new Promise(r => setTimeout(r, 200));
	}
}

// WHAT ANSWERS THERE HAS TO BE MOCKCAP. "Something is listening" was the whole
// test, and any OpenAI-compatible mock answers /v1/models -- which is how this
// file spent a run driven by another world's mockllm (see CAP_PORT above).
// `cap/plain` is mockcap's own model id, so asking for it by name is the cheapest
// question that only mockcap can answer.
const capModels = await new Promise((res) => {
	const r = http.get(CAP_MODELS, (m) => {
		let raw = '';
		m.on('data', (c) => { raw += c; });
		m.on('end', () => { try { res(JSON.parse(raw)); } catch { res(null); } });
	});
	r.on('error', () => res(null));
	r.setTimeout(1500, () => { r.destroy(); res(null); });
});
if (!(capModels && (capModels.data || []).some((m) => m.id === MODEL))) {
	console.log(`\nCANNOT START: :${CAP_PORT} does not answer as dev/mockcap.mjs.`);
	console.log(`  It offers ${JSON.stringify((capModels && capModels.data || []).map((m) => m.id))},`);
	console.log(`  and this whole file measures what a provider that HONOURS max_tokens does.`);
	console.log('  Something else is on the port — set DAIMOND_CAP_PORT, or free it.');
	if (spawned) spawned.kill();
	process.exit(2);
}

const clearLog = () => { try { fs.writeFileSync(CAP_LOG, ''); } catch {} };
const capLog = () => {
	if (!fs.existsSync(CAP_LOG)) return [];
	return fs.readFileSync(CAP_LOG, 'utf8').split('\n').filter(Boolean)
		.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
/// The `max_tokens` of the last request the mock was sent.
const lastAsk = () => { const l = capLog(); return l.length ? l[l.length - 1].max_tokens : null; };

// ── The app ─────────────────────────────────────────────────────────────

const s = await open({ name: 'replylen', connect: false });
const p = s.page;
await connectMock(s, { baseUrl: CAP_URL, model: MODEL });
await p.waitForTimeout(600);

/// Force a reply-length setting through the real control, or through the store
/// when the control has not been built (the panel may be closed).
async function setReplyLength(n) {
	await p.evaluate(async (n) => {
		const sel = document.getElementById('cfg-max-tokens');
		if (sel) {
			// The value may not be on the offered ladder; add it so `change` takes.
			if (![...sel.options].some(o => o.value === String(n))) {
				const o = document.createElement('option');
				o.value = String(n); o.textContent = String(n);
				sel.appendChild(o);
			}
			sel.value = String(n);
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			return;
		}
		const raw = JSON.parse(localStorage.getItem('daimond-byok') || '{}');
		raw.maxOut = n;
		localStorage.setItem('daimond-byok', JSON.stringify(raw));
	}, n);
	await p.waitForTimeout(200);
	// A DaimondApp freezes its max_tokens at construction, so a chat built under
	// the old setting must be rebuilt. Reloading is what a user would see anyway.
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'replylen');
	await p.waitForTimeout(900);
}

/// The stored chats, as the app persists them.
///
/// IndexedDB, not localStorage: transcripts moved there when a day of tool results
/// stopped fitting in the origin's five megabytes. Read from outside the app, so
/// what is asserted is what is on disk rather than what the page believes.
const storedChats = () => p.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const db = req.result;
		let t;
		try { t = db.transaction('chats', 'readonly'); } catch (e) { res([]); return; }
		const all = t.objectStore('chats').getAll();
		all.onsuccess = () => res(all.result || []);
		all.onerror   = () => res([]);
	};
	req.onerror = () => res([]);
}));

/// Empty the chat store, so a turn is never metered against a previous one. Both
/// places: the store itself, and the old localStorage key, which would otherwise be
/// migrated straight back in on the next boot.
const clearChats = () => p.evaluate(() => new Promise((res) => {
	try { localStorage.removeItem('daimond-chats'); localStorage.removeItem('daimond-chats-legacy'); } catch (e) { /* full */ }
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const db = req.result;
		let t;
		try { t = db.transaction('chats', 'readwrite'); } catch (e) { res(); return; }
		t.objectStore('chats').clear();
		t.oncomplete = () => res();
		t.onerror    = () => res();
	};
	req.onerror = () => res();
}));

/// Start a fresh chat so a turn is never metered against a previous one, and
/// answer where that chat may write.
///
/// THE PATH IS NOT OPTIONAL. §2 below asked the model for `@write 400 big.js` --
/// a workspace-ROOT path -- and since the chat fence landed on 2026-08-12
/// (5389864) every chat is confined to `chats/<id>/work`: `Tool::guard`
/// (src/tools.rs) refuses anything outside it BEFORE the tool runs, and the
/// refusal comes back as an ORDINARY TOOL RESULT. Nothing throws, the turn
/// finishes, and the transcript holds `Refused: 'big.js' is not in this chat's
/// workspace` -- which contains neither "Wrote N bytes" nor "ran out of room",
/// so 2a passed for the wrong reason and 2b, the only check that says the raised
/// default FIXES a long write, had been measuring an apology. The commit that
/// repaired six other verifiers this way (see dev/harness.mjs) missed this one.
async function freshChat() {
	await clearChats();
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'replylen');
	await p.waitForTimeout(900);
	await newChat(s);
	return await scratchDir();
}

/// `chats/<id>/work` for the chat in focus -- what `scopeChatTo` hands the
/// engine, asked of the app rather than spelled out here, so a change to the
/// fence's shape moves this with it.
async function scratchDir() {
	return await p.evaluate(() => {
		const f = window.DaimondAttach && window.DaimondAttach.focus();
		if (!f || f.kind !== 'chat') return '';
		return window.DaimondAttach.chatScratch(f.id) || '';
	});
}

console.log('\n── 1. The cap that reaches the provider ──');

// ── 1a. The default is no longer 4096 ────────────────────────────────────

clearLog();
await freshChat();
await chat(s, '@text hello');
const ask1 = lastAsk();
check('the request carries the raised default, not 4096',
	ask1 === AUTO_MAX, `max_tokens=${ask1}`);

// ── 1b. A per-model ceiling binds below the default ──────────────────────
//
// claude-opus-4-1 accepts at most 32,000 output tokens, which is BELOW the
// 32,768 default: a request above a model's maximum is an error, not a clamp,
// so the app must ask for the model's figure and not its own.

await clearChats();
await connectMock(s, { baseUrl: CAP_URL, model: 'claude-opus-4-1' });
await p.waitForTimeout(400);
clearLog();
await freshChat();
await chat(s, '@text hello');
const askOpus41 = lastAsk();
check('a model whose published ceiling is lower gets its own figure',
	askOpus41 === 32000, `claude-opus-4-1 → max_tokens=${askOpus41}`);

// ── 1c. A model with a larger ceiling still gets the default ─────────────

await connectMock(s, { baseUrl: CAP_URL, model: 'claude-opus-5' });
await p.waitForTimeout(400);
clearLog();
await freshChat();
await chat(s, '@text hello');
const askOpus5 = lastAsk();
check('a model with a larger ceiling keeps the default',
	askOpus5 === AUTO_MAX, `claude-opus-5 (128k ceiling) → max_tokens=${askOpus5}`);

await connectMock(s, { baseUrl: CAP_URL, model: MODEL });
await p.waitForTimeout(400);

console.log('\n── 2. What the cap does to a 400-line write ──');

// ── 2a. Under the OLD cap the write fails as a malformed tool call ───────

await setReplyLength(4096);
clearLog();
const cutDir = await freshChat();

// A CAN'T-START CHECK, and not one of the checks.
//
// Everything below this line writes into the chat's scratch folder, and a path
// outside it is refused before the tool runs -- silently, as an ordinary tool
// result. If the app cannot say where that folder is, the fixture cannot be
// seeded, and a run that carried on would be measuring the refusal again. It
// exits 2 rather than failing a check, because nothing here was tested.
if (!/^chats\/[^/]+\/work$/.test(cutDir)) {
	console.log(`\nCANNOT START: the chat's scratch folder did not answer — got '${cutDir}'.`);
	console.log('  §2 writes a 400-line file, and only `chats/<id>/work` will take it.');
	await s.close();
	if (spawned) spawned.kill();
	process.exit(2);
}
/// The file §2 asks for, inside the fence. `big.js` on its own is refused.
const BIG   = `${cutDir}/big.js`;
const wrote = (out, file) => new RegExp('Wrote (\\d+) bytes to ' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).exec(out);

const cut = await chat(s, `@write 400 ${BIG}`, { timeout: 60000 });
const askCut = lastAsk();
check('the forced 4096 setting is what is sent', askCut === 4096, `max_tokens=${askCut}`);
// The refusal that used to satisfy this check by accident is now itself a
// failure: it is neither a write nor a length cut, and it must not be either.
check('the fixture reached the tool at all — it was not refused by the chat fence',
	!/is not in this chat's workspace/i.test(cut),
	(cut.match(/Refused:[^\n]*/) || ['no refusal'])[0]);
check('under 4096 the write does NOT complete',
	!wrote(cut, BIG),
	cut.match(/Wrote \d+ bytes[^\n]*/)?.[0] || 'no write recorded');
check('under 4096 the failure is REPORTED as a length cut, not left as bad JSON',
	/ran out of room/i.test(cut), (cut.match(/ran out of room[^\n]*/) || ['(no notice)'])[0]);
await shot(s, 'replylen-cut');

// ── 2b. Under the new default the same write completes ───────────────────

await setReplyLength(0);           // 0 = Automatic
clearLog();
const wholeDir = await freshChat();
const BIG2  = `${wholeDir}/big.js`;
const whole = await chat(s, `@write 400 ${BIG2}`, { timeout: 60000 });
const askWhole = lastAsk();
const said = (wrote(whole, BIG2) || [])[1];
check('Automatic sends the raised default', askWhole === AUTO_MAX, `max_tokens=${askWhole}`);
// Said here as well as in 2a, and it is here that it bites: at 4096 the reply is
// cut before any tool call is made, so there is nothing for the fence to refuse.
// This is the turn that DOES reach the tool, and a refusal is what it used to
// come back with.
check('the write reached the tool at all — it was not refused by the chat fence',
	!/is not in this chat's workspace/i.test(whole),
	(whole.match(/Refused:[^\n]*/) || ['no refusal'])[0]);
check('under the new default the same 400-line write completes',
	!!said, said ? `${said} bytes written` : 'no write recorded');
// The transcript is what the MODEL was told. The file is the thing the user
// keeps, so it is read back through the engine's own door -- not fenced,
// because it is not a chat -- and its size compared with what was claimed.
const onDisk = await p.evaluate(async (f) => {
	try { return (await (await import('/pkg/oxedyne_daimond.js')).read_file(f)).length; }
	catch (e) { return -1; }
}, BIG2);
check('and the file is really there, the size it said',
	said && onDisk === Number(said), `${onDisk} bytes at ${BIG2}`);
check('and nothing is reported as cut', !/ran out of room/i.test(whole));
await shot(s, 'replylen-whole');

// ── 2c. The setting is real: a chosen figure is what is sent ─────────────

await setReplyLength(8192);
clearLog();
await freshChat();
await chat(s, '@text hello');
const askSet = lastAsk();
check('a chosen reply length reaches the provider', askSet === 8192, `max_tokens=${askSet}`);
const persisted = await p.evaluate(() => {
	try { return JSON.parse(localStorage.getItem('daimond-byok') || '{}').maxOut; } catch { return null; }
});
check('and it survives a reload', persisted === 8192, `stored maxOut=${persisted}`);

// The control itself, on screen: a row that says which model it is reading and
// what that model will accept. Read off the DOM and shot, because a setting
// nobody can find is not a setting.
await p.evaluate(() => { document.getElementById('settings-btn')?.click(); });
await p.waitForTimeout(400);
await p.evaluate(() => {
	const row = document.querySelector('.astat-btn#astat-model') || document.getElementById('astat-model');
	if (row) row.click();
});
await p.waitForTimeout(500);
const knob = await p.evaluate(() => {
	const sel = document.getElementById('cfg-max-tokens');
	if (!sel) return null;
	const note = document.getElementById('cfg-max-tokens-note');
	const r = sel.getBoundingClientRect();
	return {
		visible: r.width > 0 && r.height > 0,
		options: [...sel.options].map(o => o.textContent),
		value:   sel.value,
		note:    (note || {}).textContent || '',
	};
});
check('the reply-length control is on screen in the Models panel',
	!!(knob && knob.visible), knob ? `value=${knob.value}` : 'not built');
check('it offers Automatic and a ladder bounded by the model',
	!!(knob && /Automatic/.test(knob.options[0]) && knob.options.length > 2),
	knob ? knob.options.join(' | ') : '');
check('and it names what the model will accept',
	!!(knob && knob.note.length > 20), knob ? knob.note : '');
await shot(s, 'replylen-setting');

// ── 2d. A provider that refuses the length is answered, not reported ─────

await setReplyLength(0);
clearLog();
await freshChat();
// Refuses above 20,000: the first ask (32,768) is rejected, the halved one
// (16,384) is not — so the backoff is shown to LAND, not merely to happen.
const refused = await chat(s, '@refuse-cap 20000', { timeout: 60000 });
const asks = capLog().map(e => e.max_tokens);
// The provider's own words never reach the browser -- `wasm_fetch` in src/llm.rs
// builds the error from the status line and drops the body -- so what the app
// has to work from is a bare 400. It answers by asking for half as much, once,
// and believes the smaller figure only because the smaller ask then succeeds.
check('a refused length is retried at half, not surfaced',
	asks.length >= 2 && asks[0] === AUTO_MAX && asks[1] === AUTO_MAX / 2,
	`asked ${asks.join(' then ')}`);
check('and the turn then succeeds',
	/Fine at this length/.test(refused), (refused.split('\n').pop() || '').slice(0, 60));

console.log('\n── 3. The context meter ──');

// A five-round tool loop. The mock reports 5000, 10000, 15000, 20000, 25000
// prompt tokens across the rounds: the LAST is 25000, the SUM is 75000.
//
// On `claude-opus-5`, because a meter needs a DENOMINATOR: a model nobody
// publishes a context window for draws no meter at all, which is the honest
// behaviour and the reason the mock answers to a real model id here. Anthropic
// publishes 1,000,000 tokens for this model, which is what the app's table says
// -- so the denominator is checked against the published figure, not against
// another part of the app.
const METER_MODEL = 'claude-opus-5';
const METER_CTX   = 1000000;
const ROUNDS = 5;
const LAST_ROUND = ROUND_PROMPT * ROUNDS;
const SUM_ROUNDS = ROUND_PROMPT * (ROUNDS * (ROUNDS + 1) / 2);

await setReplyLength(0);
await connectMock(s, { baseUrl: CAP_URL, model: METER_MODEL });
await p.waitForTimeout(400);
clearLog();
await freshChat();
await chat(s, `@rounds ${ROUNDS}`, { timeout: 60000 });
await p.waitForTimeout(600);

const rounds = capLog().length;
check(`the turn really ran ${ROUNDS} rounds`, rounds === ROUNDS, `${rounds} requests`);

const chatRow = (await storedChats())[0] || {};
check('the meter reads the LAST round, not the sum of the rounds',
	chatRow.lastPrompt === LAST_ROUND,
	`lastPrompt=${chatRow.lastPrompt}, last round sent ${LAST_ROUND}, sum is ${SUM_ROUNDS}`);
check('the cumulative counter is still the sum (nothing else was broken to fix it)',
	chatRow.promptTokens === SUM_ROUNDS,
	`promptTokens=${chatRow.promptTokens}`);

// What the tile actually DRAWS, read off the DOM rather than recomputed.
const meter = await p.evaluate(() => {
	const el = document.querySelector('.session-box .tile-ctx');
	if (!el) return null;
	const pct  = (el.querySelector('.tile-ctx-pct') || {}).textContent || '';
	const fill = (el.querySelector('.tile-ctx-fill') || {}).style || {};
	return { title: el.getAttribute('title') || '', pct, width: fill.width || '' };
});
check('the tile draws a context meter at all', !!meter, meter ? meter.pct : 'no .tile-ctx');

if (meter) {
	// The denominator: whatever the app believes this model's window is.
	const ctx = await p.evaluate((m) =>
		(window.DaimondPricing ? DaimondPricing.contextWindow(m, '') : null), METER_MODEL);
	check('the denominator is the model\'s published context window',
		ctx === METER_CTX, `table says ${ctx}, Anthropic publishes ${METER_CTX}`);
	const want = ctx ? Math.min(100, Math.round(LAST_ROUND / ctx * 100)) : null;
	const wrong = ctx ? Math.min(100, Math.round(SUM_ROUNDS / ctx * 100)) : null;
	check('the percentage drawn is the last round over the window',
		ctx ? meter.pct === want + '%' : false,
		`drew ${meter.pct}; truth ${want}%; the old sum would have drawn ${wrong}%`);
	check('and the bar width agrees with the percentage',
		ctx ? meter.width === want + '%' : false, `width=${meter.width}`);
}
await shot(s, 'replylen-meter');

// ── Report ──────────────────────────────────────────────────────────────

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) bad.forEach(b => console.log('  FAIL ' + b));
await s.close();
if (spawned) spawned.kill();
process.exit(bad.length ? 1 : 0);
