/* ============================================================
   Test — the private per-model dashboard (modeldash.js), pure half.
   ------------------------------------------------------------
   Two claims, proved against the REAL `ledger.js` and `modeldash.js`
   source, run under node with no browser and no network:

     (a) AGGREGATION. `DaimondModelDash.dashboardRows(period, L)` reports
         the right tokens (in AND out, separately), cost and turn count
         per model, for fixture entries seeded straight into the
         `daimond-ledger` store `ledger.js` itself reads -- proving this
         file reads the ledger the design calls `daimond-ledger`, not a
         private copy of it.

     (b) THE TRUST COLUMN IS READ ONLY (Rating U2, plan unit G). The one-tap
         per-model buttons are gone. The column draws the counts this device
         already holds, as the cell's own text, until U5 replaces them with
         figures from rated answers; and NOTHING writes `daimond-model-ratings`
         any more -- checked with a spy on `setItem` and `removeItem` across
         opening, redrawing, a period toggle and closing, and by the removed
         functions being gone from the module's surface.

     Each check is proven able to fail:

     node www/js/modeldash.test.mjs --break nosplit    # perModel stops splitting prompt/completion
     node www/js/modeldash.test.mjs --break buttons    # the Trust cell draws a button again
     node www/js/modeldash.test.mjs --break nocounts   # the Trust cell stops showing the stored counts
     node www/js/modeldash.test.mjs --break writes     # reading the store writes it back
     node www/js/modeldash.test.mjs                     # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_SRC    = join(HERE, 'ledger.js');
const MODELDASH_SRC = join(HERE, 'modeldash.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['nosplit', 'buttons', 'nocounts', 'writes'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

/// The three breaks that patch modeldash.js. Each anchor must match exactly once, or the run fails,
/// so a refactor that moves the line cannot leave a break that damages nothing.
function patched(src) {
	function swap(needle, to) {
		const n = src.split(needle).length - 1;
		if (n !== 1) throw new Error('break target matched ' + n + ' times, not once: ' + needle);
		src = src.replace(needle, to);
	}
	if (BREAK === 'buttons') {
		swap("var rateTd = el('td', null, fmtCounts(r.up, r.down));",
			"var rateTd = el('td', null, fmtCounts(r.up, r.down)); rateTd.appendChild(el('button', 'mdash-rate-btn', '\u25B2'));");
	}
	if (BREAK === 'nocounts') {
		swap("return t('modeldash.rating_counts', { up: up, down: down });", "return '';");
	}
	if (BREAK === 'writes') {
		swap('var obj = JSON.parse(raw);', 'var obj = JSON.parse(raw); localStorage.setItem(RATINGS_KEY, raw);');
	}
	return src;
}

/// A fresh `{ L, M, store }` -- `DaimondLedger` and `DaimondModelDash` loaded
/// from the real source (optionally patched for `--break`) into ONE shared
/// stand-in `window`, backed by an in-memory localStorage `store` (a Map, so
/// two calls to `load()` sharing the same `store` is what re-reading the
/// module after a reload means here). Neither file is ever `require`d from
/// node_modules or touches the real browser localStorage.
function load(store) {
	store = store || new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); },
	};
	const win = {};

	let ledgerSrc = readFileSync(LEDGER_SRC, 'utf8');
	if (BREAK === 'nosplit') {
		// perModel goes back to summing only the combined `tokens` figure --
		// exactly the shape it had before this build needed "in vs out".
		const needle = "if (!by[m]) by[m] = { model: m, usd: 0, tokens: 0, prompt: 0, completion: 0, turns: 0, reportedUsd: 0 };";
		if (!ledgerSrc.includes(needle)) throw new Error('break target not found (nosplit)');
		ledgerSrc = ledgerSrc
			.replace(needle, "if (!by[m]) by[m] = { model: m, usd: 0, tokens: 0, turns: 0, reportedUsd: 0 };")
			.replace('by[m].prompt += e.p || 0;\n\t\t\tby[m].completion += e.c || 0;\n', '');
	}
	// eslint-disable-next-line no-new-func
	loadStore(win, localStorage);
	new Function('window', 'localStorage', ledgerSrc)(win, localStorage);

	let modeldashSrc = readFileSync(MODELDASH_SRC, 'utf8');
	modeldashSrc = patched(modeldashSrc);
	// modeldash.js's DOM half returns early when `document` is undefined
	// (the same guard `dockdrag.js` uses), which is exactly what makes the
	// pure half here safe to load with no DOM at all.
	// eslint-disable-next-line no-new-func
	new Function('window', 'localStorage', modeldashSrc)(win, localStorage);

	return { L: win.DaimondLedger, M: win.DaimondModelDash, store: store };
}

/// The DOM half, for the live-redraw claim (S-UI #2): a minimal fake
/// document (just enough for `render()`'s table to build) plus a REAL
/// `window.addEventListener`/`dispatchEvent` pair -- not stubs that record
/// calls, an actual pub-sub -- so `ledger.js`'s own `notifyChanged()` and
/// `modeldash.js`'s own subscription are what is under test, not a rewrite
/// of either.
function loadDom(store) {
	store = store || new Map();
	// Every write and removal, by key: the spy the read-only claim is judged by.
	const writes = [];
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => { writes.push(['set', k]); store.set(k, String(v)); },
		removeItem: (k) => { writes.push(['remove', k]); store.delete(k); },
	};

	function node(tag) {
		const n = {
			tagName: tag, className: '', textContent: '', type: '', title: '', disabled: false,
			children: [], _listeners: {},
			set innerHTML(v) { this.children = []; },	// render() only ever clears with ''
			get innerHTML() { return ''; },
			appendChild(c) { this.children.push(c); return c; },
			addEventListener(k, fn) { (this._listeners[k] = this._listeners[k] || []).push(fn); },
		};
		return n;
	}
	const host = node('div');
	host.id = 'modeldash-view';
	const document_ = {
		readyState: 'complete',
		createElement: (tag) => node(tag),
		getElementById: (id) => (id === 'modeldash-view' ? host : null),
		addEventListener() {},
	};

	const winOn = {};
	const win = {
		addEventListener(k, fn) { (winOn[k] = winOn[k] || []).push(fn); },
		removeEventListener(k, fn) {
			if (!winOn[k]) return;
			const i = winOn[k].indexOf(fn);
			if (i !== -1) winOn[k].splice(i, 1);
		},
		dispatchEvent(ev) { (winOn[ev.type] || []).slice().forEach((fn) => fn(ev)); },
	};

	// The REAL English table behind a stand-in `t`, so the Trust cell is judged on the words the
	// person reads ("3 up · 1 down") and not on a key name, and a missing key shows as itself.
	let en = {};
	{
		const box = { window: { DaimondI18n: { register: (c, t2) => { en = t2; } } } };
		vm.createContext(box);
		vm.runInContext(readFileSync(join(HERE, '..', 'i18n', 'en.js'), 'utf8'), box, { timeout: 5000 });
	}
	win.DaimondI18n = {
		t: (k, v) => String(k in en ? en[k] : k).replace(/\{(\w+)\}/g, (m, n) => (v && n in v ? v[n] : m)),
		money: (n) => '$' + n,
		onChange() {},
	};

	const ledgerSrc = readFileSync(LEDGER_SRC, 'utf8');
	loadStore(win, localStorage);
	new Function('window', 'localStorage', ledgerSrc)(win, localStorage);
	const modeldashSrc = patched(readFileSync(MODELDASH_SRC, 'utf8'));
	// `DaimondI18n` is also a bare global in the page, which `onChange` at the foot of the file uses.
	new Function('window', 'document', 'localStorage', 'DaimondI18n', modeldashSrc)(win, document_, localStorage, win.DaimondI18n);

	return { L: win.DaimondLedger, M: win.DaimondModelDash, host: host, winOn: winOn, localStorage: localStorage, writes: writes, node: node };
}

/// The rendered table's rows, `[[model, turns], ...]`, read back out of the
/// fake host the same shape `table()` builds it in -- a `<table><tbody>` of
/// `<tr>` each starting `[model-td, turns-td, ...]`. Empty when the panel is
/// showing its "no usage" placeholder instead of a table.
function readRows(host) {
	function find(n, tag) {
		var out = [];
		(n.children || []).forEach((c) => {
			if (c.tagName === tag) out.push(c);
			out = out.concat(find(c, tag));
		});
		return out;
	}
	const tbody = find(host, 'tbody')[0];
	if (!tbody) return [];
	return find(tbody, 'tr').map((tr) => [tr.children[0].textContent, tr.children[1].textContent]);
}

/// Every node under `n`, depth first.
function walk(n) {
	let out = [];
	(n.children || []).forEach((c) => { out.push(c); out = out.concat(walk(c)); });
	return out;
}

/// The Trust cell of each rendered row, `[[model, cell], ...]`: the eighth `td`.
function trustCells(host) {
	const tbody = walk(host).find((n) => n.tagName === 'tbody');
	if (!tbody) return [];
	return tbody.children.map((tr) => [tr.children[0].textContent, tr.children[7]]);
}

/// A minimal ledger entry, the shape `ledger.js` stores and `record()`
/// writes: epoch-ms, model, prompt/completion/cached tokens, USD.
function entry(t, m, p, c, u) {
	return { t: t, m: m, p: p, c: c, ca: 0, u: u };
}

function main() {
	console.log('modeldash: aggregation -- reads the real daimond-ledger key and splits tokens correctly');
	{
		const store = new Map();
		const now = Date.now();
		const fixtures = [
			entry(now - 1000, 'alpha/one', 100, 50, 0.010),
			entry(now - 2000, 'alpha/one', 200, 80, 0.020),
			entry(now - 3000, 'beta/two',  40,  10, 0.004),
		];
		store.set('daimond-ledger', JSON.stringify(fixtures));
		const { M } = load(store);

		const rows = M.dashboardRows('month');
		const alpha = rows.find((r) => r.model === 'alpha/one');
		const beta  = rows.find((r) => r.model === 'beta/two');

		check('both models are reported', !!alpha && !!beta, JSON.stringify(rows));
		check('alpha turns = 2', alpha && alpha.turns === 2, alpha && alpha.turns);
		check('alpha tokens in (prompt) = 300', alpha && alpha.promptTokens === 300, alpha && alpha.promptTokens);
		check('alpha tokens out (completion) = 130', alpha && alpha.completionTokens === 130, alpha && alpha.completionTokens);
		check('alpha total tokens = 430', alpha && alpha.tokens === 430, alpha && alpha.tokens);
		check('alpha cost = 0.03 (within float tolerance)',
			alpha && Math.abs(alpha.usd - 0.03) < 1e-9, alpha && alpha.usd);
		check('beta turns = 1, tokens in = 40, tokens out = 10',
			beta && beta.turns === 1 && beta.promptTokens === 40 && beta.completionTokens === 10,
			JSON.stringify(beta));
		check('a model never rated reports zero ratings',
			alpha && alpha.up === 0 && alpha.down === 0, JSON.stringify(alpha));
	}

	console.log('\nmodeldash: aggregation -- an empty ledger reports no rows, not an error');
	{
		const { M } = load(new Map());
		const rows = M.dashboardRows('month');
		check('empty in, empty out', Array.isArray(rows) && rows.length === 0, JSON.stringify(rows));
	}

	console.log('\nmodeldash: rating -- read only: the stored counts are read back, and nothing can write them');
	{
		const store = new Map();
		store.set('daimond-model-ratings', JSON.stringify({ 'delta/four': { up: 2, down: 1 } }));
		const { M } = load(store);
		check('an unrated model reads as zero', JSON.stringify(M.ratingsFor('gamma')) === JSON.stringify({ up: 0, down: 0 }));
		check('a stored count reads back, from the same key across a reload',
			JSON.stringify(M.ratingsFor('delta/four')) === JSON.stringify({ up: 2, down: 1 }),
			JSON.stringify(M.ratingsFor('delta/four')));

		// The dashboard row carries the same figures, so the contribution preview and the Trust
		// column never disagree.
		store.set('daimond-ledger', JSON.stringify([entry(Date.now(), 'delta/four', 10, 10, 0.001)]));
		const { M: second } = load(store);
		const row = second.dashboardRows('month').find((r) => r.model === 'delta/four');
		check('dashboardRows carries the stored rating', row && row.up === 2 && row.down === 1, JSON.stringify(row));

		// The writers are deleted, not merely unused: a later change cannot call what is not there.
		check('rate, saveRatings and clearRatings are gone from the module\u2019s surface',
			['rate', 'saveRatings', 'clearRatings'].every((k) => !(k in M)),
			Object.keys(M).join(' '));
	}

	console.log('\nmodeldash: a corrupt rating store degrades to empty rather than throwing');
	{
		const store = new Map();
		store.set('daimond-model-ratings', 'not json{{{');
		const { M } = load(store);
		check('corrupt store reads as no ratings', JSON.stringify(M.ratingsFor('x')) === JSON.stringify({ up: 0, down: 0 }));
	}

	// The three claims of unit G, each with a break of its own.
	const G_LEDGER = () => JSON.stringify([
		entry(Date.now() - 1000, 'alpha/one',   100, 50, 0.010),
		entry(Date.now() - 2000, 'beta/two',     40, 10, 0.004),
		entry(Date.now() - 3000, 'gamma/three',  20,  5, 0.002),
	]);
	const G_RATINGS = () => JSON.stringify({ 'alpha/one': { up: 3, down: 1 }, 'gamma/three': { up: 0, down: 2 } });
	const seededDom = () => {
		const store = new Map();
		store.set('daimond-ledger', G_LEDGER());
		store.set('daimond-model-ratings', G_RATINGS());
		const dom = loadDom(store);
		dom.M.onOpen();
		return dom;
	};

	console.log('\nmodeldash: Trust column -- there is no button in the cell');
	{
		const { host } = seededDom();
		const cells = trustCells(host);
		check('one Trust cell per row', cells.length === 3, String(cells.length));
		check('no cell holds a button or any element at all',
			cells.every(([, td]) => walk(td).length === 0),
			cells.map(([m, td]) => m + ':' + walk(td).map((n) => n.tagName).join('+')).join(' '));
		check('the header is still the Trust column',
			walk(host).some((n) => n.tagName === 'th' && n.textContent === 'Trust'));
	}

	console.log('\nmodeldash: Trust column -- the stored counts are shown, as the cell\u2019s own text');
	{
		const { host } = seededDom();
		const by = Object.fromEntries(trustCells(host).map(([m, td]) => [m, td.textContent]));
		check('a model rated up and down shows both counts', by['alpha/one'] === '3 up \u00B7 1 down', by['alpha/one']);
		check('a model rated only down shows zero up', by['gamma/three'] === '0 up \u00B7 2 down', by['gamma/three']);
		check('a model never rated shows a dash, not a zero it did not earn', by['beta/two'] === '\u2014', by['beta/two']);
		check('the cell is a figure cell, a td of class num like the columns beside it',
			trustCells(host).every(([, td]) => td.tagName === 'td' && td.className === 'num'),
			trustCells(host).map(([, td]) => td.tagName + '.' + td.className).join(' '));
		check('the Trust head is a num head, so it lines up over its figures',
			walk(host).some((n) => n.tagName === 'th' && n.textContent === 'Trust' && n.className === 'num'));
	}

	console.log('\nmodeldash: Trust column -- nothing writes daimond-model-ratings, in any path');
	{
		const { L, M, host, writes } = seededDom();
		// Press every button the panel offers, then redraw by the ledger's own change event, a refresh
		// and a close: every path that draws or touches this panel.
		const buttons = walk(host).filter((n) => n.tagName === 'button');
		buttons.forEach((b) => (b._listeners.click || []).forEach((fn) => fn({})));
		L.record({ ts: Date.now(), model: 'alpha/one', promptTokens: 1, completionTokens: 1, costUsd: 0.001 });
		M.refresh();
		M.onClose();
		const mine = writes.filter(([, k]) => k === 'daimond-model-ratings');
		check('the paths above ran (the ledger, a different key, was written to)',
			writes.some(([, k]) => k === 'daimond-ledger') && buttons.some((b) => /mdash-toggle-btn/.test(b.className)),
			JSON.stringify(writes) + ' buttons=' + buttons.length);
		check('no setItem and no removeItem on daimond-model-ratings', mine.length === 0, JSON.stringify(mine));
	}

	console.log('\nmodeldash: DOM half -- the panel redraws live while open, and stops once closed (S-UI #2)');
	{
		const { L, M, host, winOn, localStorage } = loadDom();
		M.onOpen();
		check('opens with no usage recorded yet', readRows(host).length === 0, JSON.stringify(readRows(host)));
		check('onOpen subscribed exactly one ledger-change listener',
			(winOn['daimond:ledger'] || []).length === 1, (winOn['daimond:ledger'] || []).length);

		console.log('    revert: before the fix, record() raises nothing and this table never moves');
		L.record({ ts: Date.now(), model: 'alpha/one', promptTokens: 10, completionTokens: 5, costUsd: 0.01 });
		let rows = readRows(host);
		check('a turn recorded WHILE THE PANEL SITS OPEN redraws it without a manual refresh',
			rows.length === 1 && rows[0][0] === 'alpha/one' && rows[0][1] === '1', JSON.stringify(rows));

		// A live merge (a sync apply/backup restore) writes the store DIRECTLY --
		// exactly what `daimond.js`'s two `mergeLedgers` call sites do -- and
		// cannot call `save()`, so it raises the same signal by hand
		// (`DaimondLedger.notifyChanged`, which those call sites now also call).
		const mine = JSON.parse(localStorage.getItem('daimond-ledger') || '[]');
		const merged = L.merge(mine, [
			{ t: Date.now() + 1, m: 'beta/two', p: 4, c: 2, ca: 0, pv: '', u: 0.002 },
		], Date.now() + 1000);
		localStorage.setItem('daimond-ledger', JSON.stringify(merged));
		L.notifyChanged();
		rows = readRows(host);
		check('a MERGED entry (the sync/backup path) redraws it too, not just a locally recorded one',
			rows.some((r) => r[0] === 'beta/two'), JSON.stringify(rows));

		M.onClose();
		check('onClose released the subscription', (winOn['daimond:ledger'] || []).length === 0,
			(winOn['daimond:ledger'] || []).length);

		L.record({ ts: Date.now() + 2000, model: 'gamma/three', promptTokens: 1, completionTokens: 1, costUsd: 0.001 });
		rows = readRows(host);
		check('once closed, a further ledger change does NOT keep drawing into the old host (no leak)',
			!rows.some((r) => r[0] === 'gamma/three'), JSON.stringify(rows));
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

main();
