// gateway: none
// verify_pickers.mjs — a chat and a Diamond each run on the model chosen for them.
//
// With one provider, "which model" and "whose key" were the same question. With a key per
// provider they are two, and a picker that answers only the first is worse than none: it lets a
// user choose a model on provider B and then sends it, with provider A's key, to provider A.
//
// So the picker is grouped by provider and carries the provider on the option, and the proof is
// not that the right words are on screen. It is that the request lands at the right BASE URL with
// the right KEY — which is checked here by pointing two "providers" at two different mock servers
// and seeing which one the traffic goes to.
import { open, shot, errors, MOCK, PASS, storedChats } from './harness.mjs';
import http from 'node:http';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── Two stand-in providers, each recording what it is asked ────────────
//
// They speak just enough OpenAI to answer /models and /chat/completions.
function provider(port, models, tag) {
	const seen = [];
	const srv = http.createServer((req, res) => {
		let body = '';
		req.on('data', c => (body += c));
		req.on('end', () => {
			const auth = req.headers.authorization || '';
			if (req.url.endsWith('/models')) {
				res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
				return res.end(JSON.stringify({ data: models.map(id => ({ id })) }));
			}
			const j = (() => { try { return JSON.parse(body); } catch { return {}; } })();
			const said = (j.messages || []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join(' | ');
			seen.push({ url: req.url, auth, model: j.model || '', said, n: (j.messages || []).length });
			const words = `answered by ${tag}`;
			// A request that asks to stream is answered as a stream, as a real provider answers
			// it. Answered in one JSON body (as until 2026-10-09) the engine's stream reader finds
			// no `data:` line and drops the reply whole -- nothing on screen, nothing stored, an
			// empty assistant turn in the model's session -- which read as the history losing the
			// first reply. PICKER_REPLY=body keeps that case reachable: it fails today, on the
			// engine, not on anything this file is about.
			if (j.stream && process.env.PICKER_REPLY !== 'body') {
				res.writeHead(200, {
					'content-type': 'text/event-stream',
					'access-control-allow-origin': '*',
					'access-control-allow-headers': '*',
				});
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: words } }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\n`);
				return res.end('data: [DONE]\n\n');
			}
			res.writeHead(200, {
				'content-type': 'application/json',
				'access-control-allow-origin': '*',
				'access-control-allow-headers': '*',
			});
			res.end(JSON.stringify({
				choices: [{ message: { role: 'assistant', content: words }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 5, completion_tokens: 5 },
			}));
		});
	});
	// CORS preflight, or the browser never sends the real request.
	srv.on('request', (req, res) => {});
	const orig = srv.listeners('request')[0];
	srv.removeAllListeners('request');
	srv.on('request', (req, res) => {
		if (req.method === 'OPTIONS') {
			res.writeHead(204, {
				'access-control-allow-origin': '*',
				'access-control-allow-headers': '*',
				'access-control-allow-methods': 'POST, GET, OPTIONS',
			});
			return res.end();
		}
		orig(req, res);
	});
	srv.listen(port, '127.0.0.1');
	return { seen, close: () => srv.close() };
}

// THE PORTS FOLLOW THE WORLD, and did not until 2026-08-14.
//
// They were 9101 and 9102, written as literals. A world's mock provider listens on
// `9099 + N` (dev/world.sh), so 9101 IS world 2's mock and 9102 IS world 3's — and
// world 3 is a lane another agent is told to use. On 2026-08-13 this file died with
// `EADDRINUSE 127.0.0.1:9102` inside the release gate while a six-hour-old world 3
// held the port, and the bare Node stack read as a product failure. Two ports are
// wanted, so the world claims a PAIR, in a band no world's own numbering reaches.
const WORLD = Number(process.env.DAIMOND_PORT || 8777) - 8777;
const PORT_A = Number(process.env.DAIMOND_PICKER_PORT || 9160 + WORLD * 2);
const PORT_B = PORT_A + 1;

const A = provider(PORT_A, ['alpha-large', 'shared-model'], 'ALPHA');
const B = provider(PORT_B, ['beta-small',  'shared-model'], 'BETA');

const URL_A = `http://127.0.0.1:${PORT_A}/v1/chat/completions`;
const URL_B = `http://127.0.0.1:${PORT_B}/v1/chat/completions`;

const s = await open({ name: 'pickers', connect: false });
const p = s.page;
await p.waitForTimeout(1200);

// Seed two providers with keys, and star ALPHA's model as the default.
await p.evaluate(async ({ ua, ub }) => {
	const M = window.DaimondModels;
	M.addProvider('provA', { name: 'Provider A', url: ua });
	M.addProvider('provB', { name: 'Provider B', url: ub });
	await M.setKey('provA', 'key-for-A');
	await M.setKey('provB', 'key-for-B');
	await M.fetchModels('provA');
	await M.fetchModels('provB');
	M.setDefault('provA', 'alpha-large');
}, { ua: URL_A, ub: URL_B });
await p.waitForTimeout(600);

// ── A chat opens on the starred default, and it goes there ─────────────
//
// A chat that can start is started at once (CHAT-01), so it has no pending pulldown on its tile:
// the place a person picks a chat's model is the chat's own cog, the "Chat" row under Models.
// Until 2026-10-09 an ordinary chat had no model control at all, so a chat could only ever run
// on the starred default and the second half of this file had no way to be driven.

await p.evaluate(() => document.getElementById('new-session-btn').click());
await p.waitForTimeout(900);
await p.fill('#chat-input', 'hello');
await p.click('#chat-send', { force: true });
await p.waitForTimeout(3500);
check('a new chat runs on the starred default, provider and all',
	A.seen.length === 1 && B.seen.length === 0 && A.seen[0].model === 'alpha-large'
		&& A.seen[0].auth.includes('key-for-A'),
	`A saw ${A.seen.length}, B saw ${B.seen.length}`);
// What the first reply left on screen and in the store: the words the next model must be handed.
const firstReply = await p.evaluate(() => {
	const els = [...document.querySelectorAll('.chat-msg-assistant')];
	return els.length ? els[els.length - 1].textContent.trim().slice(0, 80) : '(no assistant bubble)';
});
const firstStored = await storedChats(s).then((raw) => {
	const c = raw[0] || {};
	const a = (c.messages || []).filter(m => m && m.role === 'assistant');
	return a.length ? JSON.stringify(a[a.length - 1].content || '') : '(no stored reply)';
});
console.log(`  info first reply: screen=${JSON.stringify(firstReply)} stored=${firstStored}`);
check('the first reply is on screen and in the store',
	firstReply.includes('answered by ALPHA') && firstStored.includes('answered by ALPHA'),
	`screen=${JSON.stringify(firstReply)} stored=${firstStored}`);

// The chat's own cog, on its own tile.
const cogHit = await p.evaluate(() => {
	const box = document.querySelector('#session-list .session-box');
	const cog = box && box.querySelector('.tile-cog');
	if (!cog) return false;
	cog.click();
	return true;
});
check('the chat\'s tile has a cog', cogHit === true);
await p.waitForSelector('.tile-dlg-card', { timeout: 8000 }).catch(() => {});
await p.waitForTimeout(300);

// ── The picker lists every provider, grouped ───────────────────────────

const picker = await p.evaluate(() => {
	const sel = document.querySelector('.tile-dlg-card .tile-dlg-chat-model select');
	if (!sel) return null;
	const wrap = sel.nextElementSibling;
	return {
		groups:   [...sel.querySelectorAll('optgroup')].map(g => g.label),
		opts:     [...sel.querySelectorAll('option')].filter(o => !o.dataset.fav).map(o => ({
			model: o.value, provider: o.dataset.provider,
		})),
		selected: sel.value,
		selProv:  sel.selectedOptions[0] && sel.selectedOptions[0].dataset.provider,
		field:    !!(wrap && wrap.querySelector('input.mp-in')),
	};
});
check('the chat\'s cog has a model row, the same search-filter field as every other',
	!!picker && picker.field, picker ? 'field=' + picker.field : 'no chat model row');
const pk = picker || { groups: [], opts: [] };
check('the picker groups the models under the provider that runs them',
	pk.groups.includes('Provider A') && pk.groups.includes('Provider B'),
	pk.groups.join(' | '));
check('every model carries the provider whose key runs it',
	pk.opts.length === 4 && pk.opts.every(o => o.provider),
	pk.opts.map(o => o.provider + ':' + o.model).join(', '));
check('it shows the model the chat runs on now',
	pk.selected === 'alpha-large' && pk.selProv === 'provA',
	pk.selProv + ':' + pk.selected);

// The same model name sits on both providers. This is the case a bare model id cannot answer.
const dupes = pk.opts.filter(o => o.model === 'shared-model');
check('a model served by two providers appears once under each, not once in total',
	dupes.length === 2 && dupes[0].provider !== dupes[1].provider,
	dupes.map(o => o.provider).join(' + '));

// ── Moved to the NON-default provider, the chat goes to that provider ──
//
// Driven as a person drives it: click the field, type part of the name, Enter, then Change.
const fieldAt = await p.evaluate(() => {
	const sel = document.querySelector('.tile-dlg-card .tile-dlg-chat-model select');
	const inp = sel && sel.nextElementSibling && sel.nextElementSibling.querySelector('input.mp-in');
	if (!inp) return null;
	inp.scrollIntoView({ block: 'center' });
	const r = inp.getBoundingClientRect();
	return { x: r.left + Math.min(40, r.width / 3), y: r.top + r.height / 2 };
});
let changeShown = false, changed = false;
if (fieldAt) {
	await p.mouse.click(fieldAt.x, fieldAt.y);
	await p.waitForTimeout(200);
	await p.keyboard.press('Control+A');
	await p.keyboard.type('beta-sm', { delay: 8 });
	await p.waitForTimeout(150);
	await p.keyboard.press('Enter');
	await p.waitForTimeout(250);
	changeShown = await p.evaluate(() => {
		const b = document.querySelector('.tile-dlg-card .tile-dlg-chat-model .tile-dlg-apply');
		return !!(b && !b.hidden);
	});
	if (changeShown) {
		await p.click('.tile-dlg-card .tile-dlg-chat-model .tile-dlg-apply');
		await p.waitForTimeout(400);
		changed = await p.evaluate(() => {
			const b = document.querySelector('.tile-dlg-card .tile-dlg-chat-model .tile-dlg-apply');
			return !!(b && b.hidden);
		});
	}
}
check('picking another model offers Change, and Change takes it', changeShown && changed,
	`offered=${changeShown} taken=${changed}`);
await p.evaluate(() => { const x = document.querySelector('.tile-dlg-card .tile-dlg-done'); if (x) x.click(); });
await p.waitForTimeout(400);

await p.fill('#chat-input', 'and now?');
await p.click('#chat-send', { force: true });
await p.waitForTimeout(3500);

check('the next turn reaches Provider B, not the default',
	B.seen.length === 1 && A.seen.length === 1,
	`A saw ${A.seen.length}, B saw ${B.seen.length}`);
check('and it is sent with THAT provider\'s key',
	B.seen.length > 0 && B.seen[0].auth.includes('key-for-B'),
	B.seen[0] ? B.seen[0].auth.replace(/Bearer /, '') : '(nothing sent)');
check('and asks for the model that was picked',
	B.seen.length > 0 && B.seen[0].model === 'beta-small',
	B.seen[0] ? B.seen[0].model : '(nothing sent)');
check('and the conversation came with it: the first question AND the first reply\'s words',
	B.seen.length > 0 && B.seen[0].said.includes('hello') && B.seen[0].said.includes('answered by ALPHA')
		&& B.seen[0].n >= 4,
	B.seen[0] ? `${B.seen[0].n} messages; hello=${B.seen[0].said.includes('hello')} ALPHA=${B.seen[0].said.includes('answered by ALPHA')}; tail: ${B.seen[0].said.slice(-160)}` : '(nothing sent)');

// The chat's provider must survive a reload, or the next turn falls back to the default key.
const persisted = await storedChats(s).then((raw) => {
	const c = raw[0] || {};
	return { model: c.model, provider: c.provider, wm: c.workerModel, wp: c.workerProvider };
});
check('the chat records its provider, so a reload does not move it to the default key',
	persisted.provider === 'provB' && persisted.model === 'beta-small',
	persisted.provider + ':' + persisted.model);
// The workers were never moved off the chat's model, so they move with it: a worker pair left on
// the old model would be a separate choice nobody made, and peer routing reads a pair that differs
// from the chat's own as a worker chat.
check('workers that rode the chat\'s model follow it to the new one',
	persisted.wp === 'provB' && persisted.wm === 'beta-small',
	persisted.wp + ':' + persisted.wm);

await shot(s, 'picker-chat');

// ── A Diamond is created on a model the user chose ───────────────────────

const before = { a: A.seen.length, b: B.seen.length };

await p.click('#new-diamond-btn');
await p.waitForSelector('.dlg-select', { state: 'attached', timeout: 8000 });

const dlg = await p.evaluate(() => {
	const sel = document.querySelector('.dlg-select');
	return {
		groups: [...sel.querySelectorAll('optgroup')].map(g => g.label),
		selected: sel.value,
		selProv: sel.selectedOptions[0].dataset.provider,
	};
});
check('New Diamond asks which model it should think with',
	dlg.groups.length === 2, dlg.groups.join(' | '));
check('and offers the starred default first', dlg.selected === 'alpha-large' && dlg.selProv === 'provA',
	dlg.selProv + ':' + dlg.selected);

// Name it, and put it on Provider B — deliberately NOT the default.
await p.fill('.dlg-input:not(.dlg-select)', 'Diamond on B');
await p.evaluate(() => {
	const sel = document.querySelector('.dlg-select');
	[...sel.querySelectorAll('option')]
		.find(o => o.dataset.provider === 'provB' && o.value === 'beta-small').selected = true;
	sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await p.click('.dlg-ok');
await p.waitForTimeout(2000);

// Steering is a paid turn. It must go to the Diamond's OWN provider.
const steered = await p.evaluate(() => {
	const box = document.getElementById('chat-input');
	const go  = document.getElementById('chat-send');
	if (!box || !go) return false;
	box.value = 'tighten it';
	box.dispatchEvent(new Event('input', { bubbles: true }));
	go.click();
	return true;
});
check('the steer control is there to drive', steered === true);
await p.waitForTimeout(6000);

const dA = A.seen.length - before.a, dB = B.seen.length - before.b;
check('a Diamond created on Provider B thinks on Provider B',
	dB > 0 && dA === 0, `A +${dA}, B +${dB}`);
// Only the requests made SINCE the Diamond was created count — the chat's earlier request also
// went to B, and would otherwise let this pass without the Diamond having done anything at all.
const sinceDiamond = B.seen.slice(before.b);
check('with that provider\'s key and model',
	sinceDiamond.length > 0
		&& sinceDiamond.every(r => r.auth.includes('key-for-B') && r.model === 'beta-small'),
	sinceDiamond.length ? sinceDiamond[0].model + ' / ' + sinceDiamond[0].auth.replace('Bearer ', '') : '(no steer request)');

await shot(s, 'picker-focus');

const errs = errors(s).filter(e => !/favicon|404|401|502|Bad Gateway|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 5));
check('nothing throws while all this happens', errs.length === 0, errs[0] || '');

await s.close();
A.close(); B.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
