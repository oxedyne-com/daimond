// gateway: none
// verify_routingrows.mjs — a model's OpenRouter routing is rows of measured hosts, not syntax.
//
// FIRE D-20261018-09 U5b on D-20261020-10. The owner, 20 Oct: "the Providers entry defaults to
// "prefer, -avoid, !" what the fuck am I suppose to do??". Each OpenRouter model now shows one row
// per host measured for it (`DaimondHostSpeed.figures()`), its figures, the host used last, a
// host the measurement is leaving out as "Avoided" with the reason, and Auto / Prefer / Avoid.
//
// The measured window is seeded the way the page keeps it between visits (localStorage
// `daimond.hostspeed.v1`, the engine's own save format): SlowCo answers model M at 4 tok/s over
// twelve rounds, FastCo at 200. Then, through the real page, engine and wasm, with OpenRouter's
// address routed to this world's mock:
//
//   R2a  the model's detail shows SlowCo with its figures and "Avoided"; FastCo is not avoided;
//   R2b  a turn on M leaves SlowCo out (`provider.ignore`, the engine's measured avoid);
//   R2c  Prefer on SlowCo stores "SlowCo", the row shows it pressed and no longer "Avoided";
//   R2d  the next turn on M carries SlowCo first in `provider.order` and not in `ignore`, in the
//        request the mock logged (the person's choice wins over the measurement);
//   R3   "prefer, -avoid, !" is nowhere in the DOM, and no typed routing field is drawn.
//   R4   a second model M2 with no rounds is closed and has asked OpenRouter nothing; opening its
//        routing asks `/models/acme/routing-test-2/endpoints` once (mocked: long host names) and
//        lists those hosts, each with Auto / Prefer / Avoid; Prefer stores the host's name.
//
//   eval "$(bash dev/world.sh 95 --env)" && bash dev/world.sh 95 --up
//   node dev/verify_routingrows.mjs                 # green on the U5b head
//   node dev/verify_routingrows.mjs --rev 90eaed81  # models.js as the record had it: red
//   node dev/verify_routingrows.mjs --break noavoid # the Avoided line never drawn: red
//   node dev/verify_routingrows.mjs --break wrongway # Prefer writes an avoid: red
//   node dev/verify_routingrows.mjs --rev 30975f220 # part 1, no endpoints: R4 red
//   node dev/verify_routingrows.mjs --break nohosts # the endpoints answer is not drawn: red
//   node dev/verify_routingrows.mjs --break eager   # every row asks, open or not: red
//
// Exit 0 when every check passes, 1 on any failure, 2 when the run could not be made.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, chat, mockLog, clearMockLog, MOCK } from './harness.mjs';

const ROOT  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg   = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ''; };
const REV   = arg('--rev');
const BREAK = arg('--break');
const die   = (why) => { console.error('ABORT: ' + why); process.exit(2); };

const OR_BASE = 'https://openrouter.ai/api/v1';
const M       = 'acme/routing-test-1';
const M2      = 'acme/routing-test-2';
const HOSTS2  = ['Extraordinarily Long Inference Host Name Incorporated (EU-West)', 'DeepInfra', 'Novita'];
const PH      = 'prefer, -avoid, !';

// The sources this run serves, so a revision or a break can be put in front of the same page.
let modelsJs = fs.readFileSync(path.join(ROOT, 'www/js/models.js'), 'utf8');
let rowsJs   = fs.readFileSync(path.join(ROOT, 'www/js/routingrows.js'), 'utf8');
if (REV) {
	try {
		modelsJs = execFileSync('git', ['-C', ROOT, 'show', REV + ':www/js/models.js'], { encoding: 'utf8', maxBuffer: 64 << 20 });
	} catch (e) { die(`cannot read www/js/models.js at ${REV}: ${e.message}`); }
	try {
		rowsJs = execFileSync('git', ['-C', ROOT, 'show', REV + ':www/js/routingrows.js'], { encoding: 'utf8', maxBuffer: 64 << 20 });
	} catch (e) { /* no routingrows.js at that revision: serve this tree's, models.js decides */ }
}
const swap = (src, a, b) => { if (!src.includes(a)) die(`break ${BREAK}: its target is gone from the source`); return src.replace(a, b); };
if (BREAK === 'noavoid')  rowsJs = swap(rowsJs, "return !!(row && row.fig && row.fig.slow", "return false && !!(row && row.fig && row.fig.slow");
else if (BREAK === 'wrongway') rowsJs = swap(rowsJs, "if (what === 'prefer') q.order.push(host);", "if (what === 'prefer') q.ignore.push(host);");
else if (BREAK === 'nohosts') modelsJs = swap(modelsJs, "got ? got.hosts : []", "[]");
else if (BREAK === 'eager') modelsJs = swap(modelsJs, "if (disc.open) { ask(); fill(); }\n\t}", "ask(); if (disc.open) fill();\n\t}");
else if (BREAK) die(`unknown break ${BREAK}`);

// The window as `src/hostspeed.rs` saves it: model, host, at, first_ms, gen_ms, out, stalled.
const now = Date.now();
const lines = [];
for (let i = 0; i < 12; i++) {
	lines.push([M, 'SlowCo', now - (i + 2) * 60000, 9000, 100000, 400, 0].join('\t'));	// 4 tok/s
	lines.push([M, 'FastCo', now - (i + 3) * 60000, 800, 2000, 400, 0].join('\t'));		// 200 tok/s
}
const WINDOW = lines.join('\n') + '\n';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const sent = [];		// every chat body the page sent OpenRouter, as JSON
const asked = [];		// every endpoints path the page asked OpenRouter for

const s = await open({
	name: 'routingrows', connect: false,
	route: async (pg) => {
		await pg.route('**/js/models.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: modelsJs }));
		await pg.route('**/js/routingrows.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: rowsJs }));
		await pg.route(`${OR_BASE}/models`, (r) => r.fulfill({ status: 200, headers: CORS,
			contentType: 'application/json', body: JSON.stringify({ data: [{ id: M, name: 'Acme: Routing Test 1' }, { id: M2, name: 'Acme: Routing Test 2' }] }) }));
		// OpenRouter's hosts per model: M2's list, and nothing for any other model.
		await pg.route(`${OR_BASE}/models/**/endpoints`, (r) => {
			const u = new URL(r.request().url()).pathname;
			asked.push(u);
			if (u.endsWith('/models/acme/routing-test-2/endpoints')) return r.fulfill({ status: 200, headers: CORS,
				contentType: 'application/json', body: JSON.stringify({ data: { id: M2,
					endpoints: HOSTS2.map(h => ({ name: h + ' | ' + M2, provider_name: h, status: 0 })) } }) });
			return r.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{"error":{"code":404}}' });
		});
		await pg.route(`${OR_BASE}/chat/completions`, async (r) => {
			const body = r.request().postData() || '';
			try { sent.push(JSON.parse(body)); } catch (e) { sent.push({ unparsed: body.slice(0, 200) }); }
			const res = await fetch(MOCK, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
			return r.fulfill({ status: res.status, headers: CORS, body: await res.text(),
				contentType: res.headers.get('content-type') || 'text/event-stream' });
		});
		// The credit probes are not this run's business.
		await pg.route(`${OR_BASE}/credits`, (r) => r.abort());
		await pg.route(`${OR_BASE}/key`, (r) => r.abort());
	},
});
const p = s.page;
const bad = [];
const check = (name, pass, detail) => {
	console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
	if (!pass) bad.push(name);
};

try {
	// The window goes in before the engine boots, which is when the page hands it back.
	await p.evaluate((w) => localStorage.setItem('daimond.hostspeed.v1', w), WINDOW);
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'routingrows');
	await p.waitForTimeout(1500);
	await connectMock(s, { baseUrl: `${OR_BASE}/chat/completions`, model: M, apiKey: 'rr-key' });
	const figs = await p.evaluate((m) => (window.DaimondHostSpeed ? DaimondHostSpeed.figures() : []).filter(f => f.model === m), M);
	const slow = figs.find(f => f.host === 'SlowCo');
	if (!slow || !slow.slow) die(`the seeded window did not reach the engine: ${JSON.stringify(figs)}`);
	const prov = await p.evaluate(() => {
		const d = window.DaimondModels.defaultModel ? DaimondModels.defaultModel() : null;
		const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
		return (d && d.provider) || (j.def && j.def.provider) || '';
	});
	if (!prov) die('no default provider after connecting');

	// R2b first: a turn on M before any choice, so the measured avoid is what the engine sends.
	clearMockLog();
	const reqs = [];
	if (process.env.RR_DEBUG) { p.on('request', (q) => { if (!/\.(js|css|svg|png|woff2?|wasm|json)(\?|$)/.test(q.url())) reqs.push(q.method() + ' ' + q.url()); });
		p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') reqs.push('console ' + m.text().slice(0, 160)); }); }
	const tx1 = await chat(s, 'Hello before choosing.');
	if (process.env.RR_DEBUG) console.log('  transcript: ' + JSON.stringify(tx1).slice(0, 400) + '\n  requests: ' + reqs.slice(0, 40).join('\n    '));
	const first = sent.filter(b => b.model === M).pop();
	if (!first) console.log(`  sent to OpenRouter: ${JSON.stringify(sent.map(b => b.model || b))}; mock saw `
		+ JSON.stringify(mockLog().map(e => e.model)) + '; default ' + prov + ' / '
		+ await p.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('daimond-models-v2') || '{}').def)));
	check('R2b a turn on M leaves the slow host out', !!first && first.provider
		&& (first.provider.ignore || []).includes('SlowCo') && !(first.provider.ignore || []).includes('FastCo'),
		JSON.stringify(first && first.provider));

	/// Open the Models panel at the provider's row, and read the routing block under M.
	const readRows = async () => {
		await p.evaluate((pid) => {
			const st = document.getElementById('astat-model');
			if (st && !(document.getElementById('admin-models') || {}).offsetParent) st.click();
			window.DaimondModels.render();
			const h = document.querySelector(`[data-prov="${pid}"] .models-prov-head`);
			if (h && h.getAttribute('aria-expanded') !== 'true') h.click();
		}, prov);
		await p.waitForTimeout(500);
		return p.evaluate(({ PH }) => {
			const rows = [...document.querySelectorAll('.models-route-row')].map(r => ({
				host:    r.dataset.host,
				text:    r.textContent,
				figs:    (r.querySelector('.models-route-figs') || {}).textContent || '',
				why:     (r.querySelector('.models-route-why') || {}).textContent || '',
				last:    !!r.querySelector('.models-route-last'),
				pressed: ([...r.querySelectorAll('.models-route-btn')].find(b => b.getAttribute('aria-pressed') === 'true') || {}).dataset?.choice || '',
				shown:   r.getClientRects().length > 0,
			}));
			const html = document.documentElement.outerHTML;
			const phIn = [...document.querySelectorAll('input,textarea')].some(i => (i.placeholder || '') === PH || i.value === PH);
			return { rows, ph: html.includes(PH) || phIn, typed: document.querySelectorAll('.models-routing-input').length };
		}, { PH });
	};

	let v = await readRows();
	const sr = v.rows.find(r => r.host === 'SlowCo'), fr = v.rows.find(r => r.host === 'FastCo');
	check('R2a SlowCo has its row, shown, with its figures', !!sr && sr.shown && /4\s*tok\/s/.test(sr.figs) && /12/.test(sr.figs),
		sr ? sr.figs : `rows: ${JSON.stringify(v.rows.map(r => r.host))}`);
	check('R2a SlowCo is Avoided, with the reason in words', !!sr && /^Avoided: slow, 4 tok\/s over 12 rounds/.test(sr.why), sr && sr.why);
	check('R2a FastCo is listed and not avoided', !!fr && !/Avoided/.test(fr.text), fr && fr.text);
	check('R2a both hosts start on Auto', !!sr && !!fr && sr.pressed === 'auto' && fr.pressed === 'auto');
	check('R3 "prefer, -avoid, !" is nowhere in the DOM', !v.ph);
	check('R3 no typed routing field is drawn', v.typed === 0, `${v.typed} field(s)`);

	// R2c: Prefer on SlowCo, by a click on the row's own control.
	await p.evaluate(() => {
		const r = document.querySelector('.models-route-row[data-host="SlowCo"]');
		const b = r && r.querySelector('.models-route-btn[data-choice="prefer"]');
		if (b) b.click();
	});
	await p.waitForTimeout(400);
	const stored = await p.evaluate(({ pid, m }) => window.DaimondModels.routing(pid, m), { pid: prov, m: M });
	check('R2c Prefer on SlowCo stores "SlowCo"', stored === 'SlowCo', JSON.stringify(stored));
	v = await readRows();
	const sr2 = v.rows.find(r => r.host === 'SlowCo');
	check('R2c the row shows Prefer pressed and no longer Avoided', !!sr2 && sr2.pressed === 'prefer' && !/Avoided/.test(sr2.why),
		sr2 && `${sr2.pressed} / ${sr2.why}`);

	// R2d: the next turn on M asks for SlowCo first, and the mock's own log says so.
	clearMockLog();
	await chat(s, 'Hello after preferring.');
	const next = sent.filter(b => b.model === M).pop();
	const pv = (next && next.provider) || {};
	check('R2d the next turn carries SlowCo first in provider.order', Array.isArray(pv.order) && pv.order[0] === 'SlowCo', JSON.stringify(pv));
	check('R2d and does not ignore it: the person\'s choice wins', !(pv.ignore || []).includes('SlowCo'), JSON.stringify(pv.ignore));
	const logged = mockLog().filter(e => e.model === M);
	check('R2d the mock logged that request with the order', logged.some(e => e.provider && Array.isArray(e.provider.order) && e.provider.order[0] === 'SlowCo'),
		`${logged.length} logged request(s) for ${M}`);

	// R4: M2 has no rounds. Closed, it has asked nothing; opened, it lists OpenRouter's hosts.
	await readRows();	// the turn above left the chat in front: open the Models panel at the provider again
	const m2Asked = () => asked.filter(u => u.includes('routing-test-2')).length;
	const m2 = () => p.evaluate((key) => [...document.querySelectorAll('details.models-routing')].find(d => d.dataset.routeKey === key) ? true : false, prov + '\n' + M2);
	check('R4 M2 has a routing detail, closed, that has asked nothing', await m2() && m2Asked() === 0
		&& await p.evaluate((key) => { const d = [...document.querySelectorAll('details.models-routing')].find(d => d.dataset.routeKey === key); return !!d && !d.open; }, prov + '\n' + M2),
		`asked: ${JSON.stringify(asked)}`);
	await p.evaluate((key) => {
		const d = [...document.querySelectorAll('details.models-routing')].find(d => d.dataset.routeKey === key);
		if (d) d.querySelector('summary').click();
	}, prov + '\n' + M2);
	await p.waitForTimeout(800);
	const r4 = await p.evaluate((key) => {
		const d = [...document.querySelectorAll('details.models-routing')].find(d => d.dataset.routeKey === key);
		if (!d) return null;
		return [...d.querySelectorAll('.models-route-row')].map(r => ({ host: r.dataset.host, shown: r.getClientRects().length > 0,
			btns: [...r.querySelectorAll('.models-route-btn')].map(b => b.dataset.choice).join(','),
			pressed: ([...r.querySelectorAll('.models-route-btn')].find(b => b.getAttribute('aria-pressed') === 'true') || {}).dataset?.choice || '' }));
	}, prov + '\n' + M2);
	check('R4 opening M2 asks for its endpoints once', m2Asked() === 1, `asked: ${JSON.stringify(asked)}`);
	check('R4 M2 lists every host OpenRouter named, shown, on Auto with three choices',
		!!r4 && HOSTS2.every(h => r4.some(r => r.host === h && r.shown && r.pressed === 'auto' && r.btns === 'auto,prefer,avoid')),
		JSON.stringify(r4));
	await p.evaluate(({ key, h }) => {
		const d = [...document.querySelectorAll('details.models-routing')].find(d => d.dataset.routeKey === key);
		const r = d && [...d.querySelectorAll('.models-route-row')].find(x => x.dataset.host === h);
		const b = r && r.querySelector('.models-route-btn[data-choice="prefer"]');
		if (b) b.click();
	}, { key: prov + '\n' + M2, h: HOSTS2[0] });
	await p.waitForTimeout(400);
	const stored2 = await p.evaluate(({ pid, m }) => window.DaimondModels.routing(pid, m), { pid: prov, m: M2 });
	check('R4 Prefer on the long-named host stores its name', stored2 === HOSTS2[0], JSON.stringify(stored2));
	check('R4 the redraw did not ask again (cached)', m2Asked() === 1, `asked: ${JSON.stringify(asked)}`);
} catch (e) {
	bad.push('run: ' + e.message);
	console.log('FAIL  run — ' + e.message);
}
await s.close();
const tag = REV ? ` (models.js at ${REV})` : BREAK ? ` (--break ${BREAK})` : '';
if (bad.length) { console.log(`\nFAILED${tag}:\n  ` + bad.join('\n  ')); process.exit(1); }
console.log(`\nrouting rows: measured hosts, plain choices, the choice reaches OpenRouter${tag}`);
process.exit(0);
