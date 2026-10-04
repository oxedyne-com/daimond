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

     (b) THE TRUST COLUMN READS RATED ANSWERS (U5b of 5.3.2; it was read-only counts
         from Rating U2). A model's cell is the account-level cell of the rating roll-up,
         built here by the REAL `ratingroll.js` from parts and handed to the panel through
         `useRolls`: "9 up, 3 down of 340 answers" where trusted, "not enough yet, N more"
         where not, a dash where no answer has been rated. The ledger's spelling of a model
         is joined to its cell by the catalogue's id (the REAL `pricing.js`). The old
         `daimond-model-ratings` key is not read or written by this file in any path
         (checked with a spy on `getItem`, `setItem` and `removeItem` across opening,
         redrawing, a period toggle and closing); `ratingsFor`, `loadRatings` and
         `RATINGS_KEY` are gone from its surface, and the import that removes the key
         is `ratingsaccount.test.mjs`'s.

     Each check is proven able to fail:

     node www/js/modeldash.test.mjs --break nosplit    # perModel stops splitting prompt/completion
     node www/js/modeldash.test.mjs --break buttons    # the Trust cell draws a button again
     node www/js/modeldash.test.mjs --break nocounts   # a trusted cell stops showing its counts
     node www/js/modeldash.test.mjs --break nocells    # the column ignores the rating cells
     node www/js/modeldash.test.mjs --break thintrust  # a thin cell is shown as trusted
     node www/js/modeldash.test.mjs --break rawid      # the join uses the ledger's spelling, not the catalogue's
     node www/js/modeldash.test.mjs --break oldkey     # the column reads daimond-model-ratings again
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
const KNOWN = ['nosplit', 'buttons', 'nocounts', 'nocells', 'thintrust', 'rawid', 'oldkey'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

/// The breaks that patch modeldash.js. Each anchor must match exactly once, or the run fails,
/// so a refactor that moves the line cannot leave a break that damages nothing.
function patched(src) {
	function swap(needle, to) {
		const n = src.split(needle).length - 1;
		if (n !== 1) throw new Error('break target matched ' + n + ' times, not once: ' + needle);
		src = src.replace(needle, to);
	}
	if (BREAK === 'buttons') {
		swap("var rateTd = el('td', 'num', trustText(r.trust));",
			"var rateTd = el('td', 'num', trustText(r.trust)); rateTd.appendChild(el('button', 'mdash-rate-btn', '\u25B2'));");
	}
	if (BREAK === 'nocounts') {
		swap("return t('modeldash.trust_counts', { up: tr.up, down: tr.down, made: tr.made });", "return '';");
	}
	if (BREAK === 'nocells') {
		swap("var c = (roll && RR) ? RR.cell(roll, 3, '', 'cm', cmOf(model)) : null;", "var c = null;");
	}
	if (BREAK === 'thintrust') {
		swap("if (c.ok) return { kind: 'trusted'", "if (true) return { kind: 'trusted'");
	}
	if (BREAK === 'rawid') {
		swap("RR.cell(roll, 3, '', 'cm', cmOf(model))", "RR.cell(roll, 3, '', 'cm', String(model || ''))");
	}
	if (BREAK === 'oldkey') {
		swap("return { kind: 'thin', more: c.more };",
			"return { kind: 'thin', more: c.more };\n\t}\n\tfunction oldKey() { try { return localStorage.getItem('daimond-model-ratings'); } catch (e) { return null; }");
		swap("function trustFor(roll, model) {", "function trustFor(roll, model) { oldKey();");
	}
	return src;
}

/// The two modules the Trust cell reads, the real ones: the catalogue that names a model, and the
/// roll-up that makes its cell.
function loadSiblings(win, localStorage) {
	for (const f of ['pricing.js', 'ratingroll.js']) {
		new Function('window', 'localStorage', readFileSync(join(HERE, f), 'utf8'))(win, localStorage);
	}
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
	loadSiblings(win, localStorage);

	let modeldashSrc = readFileSync(MODELDASH_SRC, 'utf8');
	modeldashSrc = patched(modeldashSrc);
	// modeldash.js's DOM half returns early when `document` is undefined
	// (the same guard `dockdrag.js` uses), which is exactly what makes the
	// pure half here safe to load with no DOM at all.
	// eslint-disable-next-line no-new-func
	new Function('window', 'localStorage', modeldashSrc)(win, localStorage);

	return { L: win.DaimondLedger, M: win.DaimondModelDash, RR: win.DaimondRatingRoll, store: store };
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
	const writes = [], reads = [];
	const localStorage = {
		getItem:    (k) => { reads.push(k); return store.has(k) ? store.get(k) : null; },
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
	loadSiblings(win, localStorage);
	const modeldashSrc = patched(readFileSync(MODELDASH_SRC, 'utf8'));
	// `DaimondI18n` is also a bare global in the page, which `onChange` at the foot of the file uses.
	new Function('window', 'document', 'localStorage', 'DaimondI18n', modeldashSrc)(win, document_, localStorage, win.DaimondI18n);

	return { L: win.DaimondLedger, M: win.DaimondModelDash, RR: win.DaimondRatingRoll, host: host, winOn: winOn, localStorage: localStorage, writes: writes, reads: reads, node: node };
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

async function main() {
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
		check('a model never rated carries no Trust figure, and no stored count stands in for one',
			alpha && alpha.trust && alpha.trust.kind === 'none' && !('up' in alpha) && !('down' in alpha), JSON.stringify(alpha));
	}

	console.log('\nmodeldash: aggregation -- an empty ledger reports no rows, not an error');
	{
		const { M } = load(new Map());
		const rows = M.dashboardRows('month');
		check('empty in, empty out', Array.isArray(rows) && rows.length === 0, JSON.stringify(rows));
	}

	// ── The rating cells the column reads, made by the real roll-up from hand-built parts ──
	// One head is { h, mid, ts, s, tags, dims, len, via, cm, fam, cls, role, pv, d, c }, as `chatPart` reduces it.
	const NODIMS = { correct: -1, followed: -1, length: -1, style: -1 };
	function head(cm, i, s) {
		return { h: 'p1:answer:c1/' + cm + i, mid: cm + i, ts: 1000 + i, s: s, tags: [], dims: NODIMS, len: 300, via: '',
			cm: cm, fam: 'fam', cls: 'frontier', role: 'chat', pv: 'pv', d: '', c: 'c1' };
	}
	function made(cm, i) {
		return { h: 'p1:answer:c1/' + cm + i, k: 'answer', cm: cm, fam: 'fam', cls: 'frontier', role: 'chat', pv: 'pv', d: '', c: 'c1' };
	}
	// alpha: 12 rated (9 up, 3 down) of 340 made, a trusted account figure (floor 10). gamma: 2 rated down of 5 made.
	// The ledger below names alpha by a provider's spelling, and the catalogue's id for it is glm-5.2. It names gamma
	// as `gamma/three`, which the catalogue does not know, so a stamp files it under its last segment, `three`.
	function rollOf(RR) {
		const heads = [], mades = [];
		for (let i = 0; i < 12; i++) heads.push(head('glm-5.2', i, i < 9 ? 1 : -1));
		for (let i = 0; i < 340; i++) mades.push(made('glm-5.2', i));
		for (let i = 0; i < 2; i++) heads.push(head('three', i, -1));
		for (let i = 0; i < 5; i++) mades.push(made('three', i));
		return RR.cells([{ heads: heads, made: mades }], { sides: {} });
	}
	const ALPHA_RAW = 'accounts/fireworks/models/glm-5p2';
	const G_LEDGER = () => JSON.stringify([
		entry(Date.now() - 1000, ALPHA_RAW,     100, 50, 0.010),
		entry(Date.now() - 2000, 'beta/two',     40, 10, 0.004),
		entry(Date.now() - 3000, 'gamma/three',  20,  5, 0.002),
	]);
	const tick = () => new Promise((r) => setImmediate(r));
	// The panel opened with the roll source handed in; the cells follow once the promise has settled.
	const seededDom = async (source) => {
		const store = new Map();
		store.set('daimond-ledger', G_LEDGER());
		// The old key, present: nothing may read it, write it or remove it.
		store.set('daimond-model-ratings', JSON.stringify({ [ALPHA_RAW]: { up: 77, down: 66 }, 'beta/two': { up: 55, down: 44 } }));
		const dom = loadDom(store);
		if (source !== null) dom.M.useRolls(source || (() => Promise.resolve({ roll: rollOf(dom.RR), reads: 0 })));
		dom.M.onOpen();
		await tick();
		return dom;
	};

	console.log('\nmodeldash: rating -- the row carries a Trust reading from the cells, joined by the catalogue’s id');
	{
		const store = new Map();
		store.set('daimond-ledger', G_LEDGER());
		const { M, RR } = load(store);
		const roll = rollOf(RR);
		const rows = M.dashboardRows('month', undefined, roll);
		const by = Object.fromEntries(rows.map((r) => [r.model, r.trust]));
		check('the ledger’s spelling reads the cell of the catalogue’s id: trusted, 9 up 3 down of 340',
			JSON.stringify(by[ALPHA_RAW]) === JSON.stringify({ kind: 'trusted', up: 9, down: 3, made: 340 }), JSON.stringify(by[ALPHA_RAW]));
		check('a model with two ratings is thin, and says how many more it needs',
			by['gamma/three'] && by['gamma/three'].kind === 'thin' && by['gamma/three'].more > 0, JSON.stringify(by['gamma/three']));
		check('thin is exactly what the cell says it needs',
			by['gamma/three'] && by['gamma/three'].more === RR.cell(roll, 3, '', 'cm', 'three').more);
		check('a model never rated has none', by['beta/two'] && by['beta/two'].kind === 'none', JSON.stringify(by['beta/two']));
		check('without a roll every row has none', M.dashboardRows('month').every((r) => r.trust.kind === 'none'));
		check('trustFor of nothing is none, never a throw',
			[null, undefined, {}, { L3: {} }, { L3: { '': {} } }].every((x) => M.trustFor(x, 'any').kind === 'none'));

		// The old surface is deleted, not merely unused: a later change cannot call what is not there.
		check('rate, saveRatings, clearRatings, ratingsFor, loadRatings and RATINGS_KEY are gone from the module’s surface',
			['rate', 'saveRatings', 'clearRatings', 'ratingsFor', 'loadRatings', 'RATINGS_KEY'].every((k) => !(k in M)),
			Object.keys(M).join(' '));
		check('the rows carry no up or down of their own',
			rows.every((r) => !('up' in r) && !('down' in r)), JSON.stringify(rows[0]));
	}

	console.log('\nmodeldash: Trust column -- there is no button in the cell');
	{
		const { host } = await seededDom();
		const cells = trustCells(host);
		check('one Trust cell per row', cells.length === 3, String(cells.length));
		check('no cell holds a button or any element at all',
			cells.every(([, td]) => walk(td).length === 0),
			cells.map(([m, td]) => m + ':' + walk(td).map((n) => n.tagName).join('+')).join(' '));
		check('the header is still the Trust column',
			walk(host).some((n) => n.tagName === 'th' && n.textContent === 'Trust'));
	}

	console.log('\nmodeldash: Trust column -- figures from rated answers, as the cell’s own text');
	{
		const { host } = await seededDom();
		const by = Object.fromEntries(trustCells(host).map(([m, td]) => [m, td.textContent]));
		check('a trusted model shows its ups, downs and answers made',
			by[ALPHA_RAW] === '9 up, 3 down of 340 answers', by[ALPHA_RAW]);
		check('a thin model says it is not enough yet, and how many more',
			/^not enough yet, \d+ more$/.test(by['gamma/three']), by['gamma/three']);
		check('a model never rated shows a dash, not a zero it did not earn', by['beta/two'] === '—', by['beta/two']);
		check('none of the old counts (77, 66, 55, 44) is on screen',
			!Object.values(by).some((v) => /77|66|55|44/.test(v)), JSON.stringify(by));
		check('the cell is a figure cell, a td of class num like the columns beside it',
			trustCells(host).every(([, td]) => td.tagName === 'td' && td.className === 'num'),
			trustCells(host).map(([, td]) => td.tagName + '.' + td.className).join(' '));
		check('the Trust head is a num head, so it lines up over its figures',
			walk(host).some((n) => n.tagName === 'th' && n.textContent === 'Trust' && n.className === 'num'));
	}

	console.log('\nmodeldash: Trust column -- drawn at once from the ledger, filled when the cells arrive');
	{
		let release;
		const slow = () => new Promise((r) => { release = r; });
		const dom = await seededDom(slow);
		let by = Object.fromEntries(trustCells(dom.host).map(([m, td]) => [m, td.textContent]));
		check('before the cells arrive the table is there and every Trust cell is a dash',
			Object.keys(by).length === 3 && Object.values(by).every((v) => v === '—'), JSON.stringify(by));
		release({ roll: rollOf(dom.RR), reads: 0 });
		await tick();
		by = Object.fromEntries(trustCells(dom.host).map(([m, td]) => [m, td.textContent]));
		check('when they arrive the cells are drawn', by[ALPHA_RAW] === '9 up, 3 down of 340 answers', JSON.stringify(by));
	}

	console.log('\nmodeldash: Trust column -- a source that fails, throws or is not given leaves dashes and breaks nothing');
	{
		for (const [what, src] of [
			['rejects', () => Promise.reject(new Error('no store'))],
			['throws', () => { throw new Error('boom'); }],
			['answers a plain value', () => 42],
			['answers no roll', () => Promise.resolve({})],
			[null, null],
		]) {
			const { host } = await seededDom(src);
			const by = Object.fromEntries(trustCells(host).map(([m, td]) => [m, td.textContent]));
			check('a source that ' + (what || 'is never given') + ': the three rows stand, all dashes',
				Object.keys(by).length === 3 && Object.values(by).every((v) => v === '—'), JSON.stringify(by));
		}
	}

	console.log('\nmodeldash: Trust column -- the old key is neither read nor written, in any path');
	{
		const { L, M, host, writes, reads } = await seededDom();
		// Press every button the panel offers, then redraw by the ledger's own change event, a refresh
		// and a close: every path that draws or touches this panel.
		const buttons = walk(host).filter((n) => n.tagName === 'button');
		buttons.forEach((b) => (b._listeners.click || []).forEach((fn) => fn({})));
		L.record({ ts: Date.now(), model: 'alpha/one', promptTokens: 1, completionTokens: 1, costUsd: 0.001 });
		M.refresh();
		await tick();
		M.onClose();
		const mineW = writes.filter(([, k]) => k === 'daimond-model-ratings');
		const mineR = reads.filter((k) => k === 'daimond-model-ratings');
		check('the paths above ran (the ledger, a different key, was written to)',
			writes.some(([, k]) => k === 'daimond-ledger') && buttons.some((b) => /mdash-toggle-btn/.test(b.className)),
			JSON.stringify(writes) + ' buttons=' + buttons.length);
		check('no setItem and no removeItem on daimond-model-ratings', mineW.length === 0, JSON.stringify(mineW));
		check('no getItem on daimond-model-ratings either', mineR.length === 0, String(mineR.length) + ' reads');
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

main().catch((e) => { console.log('  FAIL threw ' + (e && e.stack || e)); process.exit(1); });
