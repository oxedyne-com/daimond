// gateway: none
// verify_u86mem.mjs -- UNBLOCK-86 U86-MEM: the Models panel costs nothing while hidden, and little open.
//
// His tab (1 Nov, Chrome 153, 816-model catalogue) held 438k live Blink nodes; 172k of the 196k in its
// static copy were the hidden Models panel: 42 pulldowns each carrying the whole catalogue, rebuilt
// whole on every save, sync pull and credit probe while nobody looked. Head draws the panel only while
// it is shown and drops its DOM on hide (models.js `watchShown`), and a closed pulldown holds only its
// choice (`trimSelect`). This arm loads a catalogue of his size and measures Blink's own node counter
// (`Memory.getDOMCounters`, after a full GC) at load and over open/close cycles, against the bounds in
// dev/u86mem_bounds.json.
//
//   M1 Hidden after load, #models-list holds no element.
//   M2 Open, the panel stays under its element bound, and every closed pulldown holds one option.
//   M3 A job picker opened lists the whole catalogue and its "Same as daimon"; choosing a row sets the pulldown and fires
//      change; closed again, it holds one option.
//   M4 Over N open/close cycles, with hidden redraws (a sync pull's `render()`) between, Blink nodes
//      grow by no more than the bound.
//   M5 What the hidden panel costs: the nodes freed by emptying the list at the end, under the bound.
//
//   node dev/verify_u86mem.mjs              # head
//   node dev/verify_u86mem.mjs --rev 150aa01d9   # this branch's www files as at the base: red
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, connectMock, scratch, statusRow } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const B    = JSON.parse(fs.readFileSync(path.join(HERE, 'u86mem_bounds.json'), 'utf8'));
const MOCK = process.env.DAIMOND_MOCK || '';
const CAT  = Array.from({ length: B.catalogue }, (_, i) => `u86/model-${String(i).padStart(4, '0')}`);

// --rev SHA: serve every www file this branch changed as it stood at SHA (the red run on the base).
const served = {};
const RI = process.argv.indexOf('--rev');
const REV = RI >= 0 ? (process.argv[RI + 1] || '') : '';
if (REV) {
	const { execFileSync } = await import('node:child_process');
	const root = path.join(HERE, '..');
	const files = execFileSync('git', ['diff', '--name-only', REV, 'HEAD', '--', 'www'], { cwd: root, encoding: 'utf8' })
		.split('\n').filter(f => f && !/\.test\.mjs$/.test(f));
	for (const f of files) {
		try { served[f.replace(/^www\//, '')] = execFileSync('git', ['show', REV + ':' + f], { cwd: root, encoding: 'utf8' }); }
		catch (e) { /* new on this branch: served as is */ }
	}
	console.log(`  ..   serving ${Object.keys(served).length} www file(s) as at ${REV}`);
}

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const s = await open({
	name: 'u86mem', profile: scratch('pw', 'u86mem-' + process.pid),
	serviceWorkers: 'block', connect: false,
	route: async (page) => {
		for (const f of Object.keys(served)) {
			await page.route('**/' + f, r => r.fulfill({ status: 200,
				contentType: f.endsWith('.css') ? 'text/css' : (f.endsWith('.html') ? 'text/html' : 'application/javascript'), body: served[f] }));
		}
		// The mock's model list, made his size.
		await page.context().route(u => !!MOCK && u.origin === new URL(MOCK).origin && /\/models$/.test(u.pathname), async r => {
			const res  = await r.fetch();
			const body = await res.json().catch(() => ({ data: [] }));
			body.data = (body.data || []).concat(CAT.map(id => ({ id, object: 'model' })));
			await r.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' });
		});
	},
});
const { page: p } = s;
const cdp = await p.context().newCDPSession(p);
await cdp.send('HeapProfiler.enable');

/// Blink's live node and document counts after a full GC, and what the list holds.
async function sample(label) {
	await cdp.send('HeapProfiler.collectGarbage');
	await cdp.send('HeapProfiler.collectGarbage');
	const c = await cdp.send('Memory.getDOMCounters');
	const ml = await p.evaluate(() => {
		const el = document.getElementById('models-list');
		return el ? el.getElementsByTagName('*').length : -1;
	});
	const row = { label, nodes: c.nodes, docs: c.documents, listeners: c.jsEventListeners, list: ml };
	console.log('  ..   SAMPLE ' + JSON.stringify(row));
	return row;
}

const shown = () => p.evaluate(() => { const e = document.getElementById('models-list'); return !!e && e.getClientRects().length > 0; });

async function openPanel() {
	await statusRow(p, '#astat-model');
	await p.evaluate(() => document.getElementById('astat-model').click());
	await p.waitForSelector('#models-list .models-jobs', { timeout: 15000 });
	await p.waitForTimeout(300);
}

async function closePanel() {
	await p.evaluate(() => {
		const c = document.getElementById('admin-close');
		if (c && c.getClientRects().length) c.click();
		else if (window.DaimondAdmin && DaimondAdmin.home) DaimondAdmin.home();
	});
	for (let t0 = Date.now(); Date.now() - t0 < 5000 && await shown(); ) await p.waitForTimeout(100);
	await p.waitForTimeout(300);
}

/// The most options any model pulldown in the panel holds while its picker is closed. The Image editing row is
/// a plain select over the image catalogue (the few models that take a picture), not the 816, so it is apart.
const maxOptions = async () => {
	const r = await p.evaluate(() => [...document.querySelectorAll('#models-list select:not([data-job="imageEditing"])')]
		.map(x => ({ n: x.options.length, who: x.className + (x.dataset.job ? '[' + x.dataset.job + ']' : '') + (x.disabled ? ' disabled' : '') }))
		.sort((a, b) => b.n - a.n)[0] || { n: 0, who: 'none' });
	return Object.assign(r, { toString() { return r.n + ' (' + r.who + ')'; } });
};

try {
	await connectMock(s, { model: 'mock/fast' });
	const got = await p.evaluate(async () => {
		const M = window.DaimondModels;
		const P = M.getDefault().provider;
		await M.fetchModels(P);
		return (M.providers().find(x => x.id === P) || {}).count || 0;
	});
	check(got >= B.catalogue, `the catalogue is his size (${B.catalogue})`, got + ' models');
	await closePanel();

	// ══ M1 ══════════════════════════════════════════════════════════════
	const s0 = await sample('load');
	check(s0.list <= B.hidden_panel_elements_max, 'M1 hidden after load, the Models list holds nothing',
		`${s0.list} elements (bound ${B.hidden_panel_elements_max})`);

	// ══ M2, M3 ══════════════════════════════════════════════════════════
	await openPanel();
	const open1 = await sample('open');
	check(open1.list > 0 && open1.list <= B.open_panel_elements_max, 'M2 open, the panel stays under its element bound',
		`${open1.list} elements (bound ${B.open_panel_elements_max})`);
	const mo = await maxOptions();
	check(mo.n <= 1, 'M2 every closed pulldown holds one option', `largest holds ${mo}`);

	const sel = 'select[data-job="drafting"]';
	const before = await p.evaluate((q) => {
		const x = document.querySelector('#models-list ' + q);
		window.__u86change = 0;
		if (x) x.addEventListener('change', () => { window.__u86change++; });
		return x ? x.value : null;
	}, sel);
	const inp = p.locator(`#models-list .models-job:has(${sel}) input.mp-in`).first();
	await inp.scrollIntoViewIfNeeded();
	await inp.click();
	await p.waitForSelector('#mp-pop', { state: 'visible', timeout: 5000 });
	const rows = await p.locator('#mp-pop .mp-row').count();
	check(rows >= B.open_picker_rows_min, 'M3 the opened picker lists the whole catalogue', `${rows} rows (bound ${B.open_picker_rows_min})`);
	const lead = await p.locator('#mp-pop .mp-row[data-value=""]').count();
	check(lead === 1, 'M3 the opened picker still offers "Same as daimon" first', `${lead} such row(s)`);
	const row = p.locator('#mp-pop .mp-row[data-value="u86/model-0007"]').first();
	await row.scrollIntoViewIfNeeded();
	await row.click();
	await p.waitForTimeout(500);
	const after = await p.evaluate((q) => {
		const x = document.querySelector('#models-list ' + q);
		return { value: x ? x.value : null, change: window.__u86change || 0, options: x ? x.options.length : -1 };
	}, sel);
	check(after.value !== before && /model-0007/.test(after.value || ''), 'M3 choosing a row sets the pulldown', `${before} → ${after.value}`);
	check(after.change >= 1, 'M3 choosing fires change', `${after.change} change event(s)`);
	const mo2 = await maxOptions();
	check(mo2.n <= 1, 'M3 closed again, every pulldown holds one option', `largest holds ${mo2}`);
	await closePanel();

	// ══ M4 ══════════════════════════════════════════════════════════════
	const first = await sample('cycle 0');
	let last = first;
	for (let i = 1; i <= B.cycles; i++) {
		await openPanel();
		await closePanel();
		// A day's sync pulls and saves redraw the panel while it is hidden.
		await p.evaluate(() => { for (let k = 0; k < 3; k++) window.DaimondModels.render(); });
		last = await sample('cycle ' + i);
	}
	const grew = last.nodes - first.nodes;
	check(grew <= B.cycle_growth_nodes_max, `M4 ${B.cycles} open/close cycles grow Blink nodes within the bound`,
		`${first.nodes} → ${last.nodes} (+${grew}, bound ${B.cycle_growth_nodes_max}); hidden list ${last.list} elements`);

	// ══ M5 ══════════════════════════════════════════════════════════════
	await p.evaluate(() => { document.getElementById('models-list').textContent = ''; });
	const bare = await sample('bare');
	const cost = last.nodes - bare.nodes;
	check(cost <= B.load_nodes_over_bare_max, 'M5 the hidden panel costs Blink nodes within the bound',
		`${cost} nodes (bound ${B.load_nodes_over_bare_max})`);
	console.log('  ..   FIGURES ' + JSON.stringify({ catalogue: got, load: s0.nodes, open: open1.nodes, cycle0: first.nodes,
		last: last.nodes, bare: bare.nodes, hiddenCost: cost, docs: last.docs }));
} catch (e) {
	check(false, 'the run finished', e && e.stack || String(e));
} finally {
	await s.browser.close().catch(() => {});
}
console.log(failures ? `FAIL verify_u86mem: ${failures} check(s) failed` : 'PASS verify_u86mem');
process.exit(failures ? 1 : 0);
