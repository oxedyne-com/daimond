// verify_pickers.mjs — a chat and a Diamond each run on the model they were started with.
//
// With one provider, "which model" and "whose key" were the same question. With a key per
// provider they are two, and a picker that answers only the first is worse than none: it lets a
// user choose a model on provider B and then sends it, with provider A's key, to provider A.
//
// So the picker is grouped by provider and carries the provider on the option, and the proof is
// not that the right words are on screen. It is that the request lands at the right BASE URL with
// the right KEY — which is checked here by pointing two "providers" at two different mock servers
// and seeing which one the traffic goes to.
import { open, shot, errors, MOCK, PASS } from './harness.mjs';
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
			seen.push({ url: req.url, auth, model: (() => { try { return JSON.parse(body).model; } catch { return ''; } })() });
			res.writeHead(200, {
				'content-type': 'application/json',
				'access-control-allow-origin': '*',
				'access-control-allow-headers': '*',
			});
			res.end(JSON.stringify({
				choices: [{ message: { role: 'assistant', content: `answered by ${tag}` }, finish_reason: 'stop' }],
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

const A = provider(9101, ['alpha-large', 'shared-model'], 'ALPHA');
const B = provider(9102, ['beta-small',  'shared-model'], 'BETA');

const URL_A = 'http://127.0.0.1:9101/v1/chat/completions';
const URL_B = 'http://127.0.0.1:9102/v1/chat/completions';

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

// ── The picker lists every provider, grouped ───────────────────────────

const picker = await p.evaluate(() => {
	document.getElementById('new-session-btn').click();
	return new Promise(r => setTimeout(() => {
		const sel = document.querySelector('.tile-model');
		const groups = [...sel.querySelectorAll('optgroup')].map(g => g.label);
		const opts = [...sel.querySelectorAll('option')].map(o => ({
			model: o.value, provider: o.dataset.provider,
		}));
		r({ groups, opts, selected: sel.value, selProv: sel.selectedOptions[0].dataset.provider });
	}, 700));
});
check('the picker groups the models under the provider that runs them',
	picker.groups.length === 2 && picker.groups.includes('Provider A') && picker.groups.includes('Provider B'),
	picker.groups.join(' | '));
check('every model carries the provider whose key runs it',
	picker.opts.length === 4 && picker.opts.every(o => o.provider),
	picker.opts.map(o => o.provider + ':' + o.model).join(', '));
check('a new chat opens on the starred default, provider and all',
	picker.selected === 'alpha-large' && picker.selProv === 'provA',
	picker.selProv + ':' + picker.selected);

// The same model name sits on both providers. This is the case a bare model id cannot answer.
const dupes = picker.opts.filter(o => o.model === 'shared-model');
check('a model served by two providers appears once under each, not once in total',
	dupes.length === 2 && dupes[0].provider !== dupes[1].provider,
	dupes.map(o => o.provider).join(' + '));

// ── A chat started on the NON-default provider goes to that provider ───

await p.evaluate(() => {
	const sel = document.querySelector('.tile-model');
	// Choose Provider B's own model, which is not the default.
	const want = [...sel.querySelectorAll('option')]
		.find(o => o.dataset.provider === 'provB' && o.value === 'beta-small');
	want.selected = true;
	sel.dispatchEvent(new Event('change', { bubbles: true }));
	document.querySelector('.tile-start').click();
});
await p.waitForTimeout(900);
await p.fill('#chat-input', 'hello');
await p.click('#chat-send', { force: true });
await p.waitForTimeout(3500);

check('a chat started on Provider B reaches Provider B, not the default',
	B.seen.length === 1 && A.seen.length === 0,
	`A saw ${A.seen.length}, B saw ${B.seen.length}`);
check('and it is sent with THAT provider\'s key',
	B.seen.length > 0 && B.seen[0].auth.includes('key-for-B'),
	B.seen[0] ? B.seen[0].auth.replace(/Bearer /, '') : '(nothing sent)');
check('and asks for the model that was picked',
	B.seen.length > 0 && B.seen[0].model === 'beta-small',
	B.seen[0] ? B.seen[0].model : '(nothing sent)');

// The chat's provider must survive a reload, or the next turn falls back to the default key.
const persisted = await p.evaluate(() => {
	const raw = JSON.parse(localStorage.getItem('daimond-chats') || '[]');
	const c = raw[0] || {};
	return { model: c.model, provider: c.provider };
});
check('the chat records its provider, so a reload does not move it to the default key',
	persisted.provider === 'provB' && persisted.model === 'beta-small',
	persisted.provider + ':' + persisted.model);

await shot(s, 'picker-chat');

// ── A Diamond is created on a model the user chose ───────────────────────

const before = { a: A.seen.length, b: B.seen.length };

await p.click('#new-diamond-btn');
await p.waitForSelector('.dlg-select', { timeout: 8000 });

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
	const box = document.getElementById('steer-input');
	const go  = document.getElementById('steer-send');
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
