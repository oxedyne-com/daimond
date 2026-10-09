// gateway: none
// verify_model_filter.mjs — every model pulldown is ONE search-filter list.
//
// Owner, 2026-10-08 (D-20261008-13): a model is chosen from a list that opens below the
// field when it is clicked; typing narrows it by ANY part of the name, the id or the
// provider, not only the start, and a space between words means every word must match;
// the models the person uses most come first among those that match; and the keyboard
// and a finger both work. The same control everywhere -- not a new one per site.
//
// Seven sites draw a model pulldown today, each a native <select>:
//   1 the Models panel, "Drafting model"          .models-draft-sel
//   2 New Diamond, the model and the worker model  .dlg-select (x2)
//   3 a Diamond's settings: daimon, Workers, "Workers, images"
//   4 the pending chat tile, its model and its worker model (rarely reachable: a chat
//     that can start is started, so these two are checked in the source)
//   5 Settings, "Fold with"                        #cfg-fold-model
//   6 the add-provider form, "Default model"       #cfg-model
// The native <select> stays in the page as the STATE (options, value, change event,
// DaimondModels.pick), hidden; the drawn control is an input beside it. So the checks
// below read both: the input and the list are what a person touches, the select is what
// every caller reads.
//
// The usage that orders the matches is the existing 'daimond-model-use' record (per
// account, device-local). It is READ here and never written by opening or choosing.
//
//   node dev/verify_model_filter.mjs        (inside a world: bash dev/world.sh N --up)
import http from 'node:http';
import { open, shot, APP } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null && detail !== '' ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		try { if (await fn()) return true; } catch { /* page mid-navigation */ }
		await sleep(150);
	}
	return false;
};

// ── Two stub providers, one server ──────────────────────────────────
//
// Names no model id contains, so a provider-name query can only match through the
// provider. Ids are listed A to Z by the app, so the order a person sees today is
// alphabetical -- and the usage below puts kimi-k3 FIRST, the reverse of it.
const PORT = Number(process.env.DAIMOND_MOCK2_PORT
	|| 9300 + (Number(process.env.DAIMOND_PORT || 8777) - 8777));
const IDS = {
	a: ['moonshotai/kimi-k3', 'moonshotai/kimi-k2', 'moonshotai/kimi-k1',
		'deepseek/deepseek-v4', 'qwen/qwen3-max'],
	b: ['anthropic/claude-sonnet-5', 'anthropic/claude-opus-5', 'openai/gpt-6', 'google/gemini-3'],
};
const NAME = { a: 'Quillfeather', b: 'Bramblewick' };
const cors = (res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};
const stub = http.createServer((req, res) => {
	cors(res);
	if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
	const which = req.url.startsWith('/b/') ? 'b' : 'a';
	if (req.method === 'GET' && /\/models/.test(req.url)) {
		res.writeHead(200, { 'content-type': 'application/json' });
		return res.end(JSON.stringify({ object: 'list',
			data: IDS[which].map((id) => ({ id, object: 'model' })) }));
	}
	res.writeHead(404); res.end();
});
await new Promise((r) => stub.listen(PORT, '127.0.0.1', r));
const URL_A = `http://127.0.0.1:${PORT}/a/v1/chat/completions`;
const URL_B = `http://127.0.0.1:${PORT}/b/v1/chat/completions`;

const s = await open({ name: 'mfilter' + Date.now(), touch: true });
const p = s.page;

const seeded = await p.evaluate(async ({ ua, ub, na, nb }) => {
	const M = DaimondModels;
	M.addProvider('qfa', { name: na, url: ua });
	await M.setKey('qfa', 'k');
	await M.fetchModels('qfa');
	M.addProvider('bwb', { name: nb, url: ub });
	await M.setKey('bwb', 'k');
	await M.fetchModels('bwb');
	// Use, so the order of a match is told apart from the alphabet: k3 most, then k2,
	// and the Bramblewick sonnet most of all.
	localStorage.removeItem('daimond-model-use');
	for (let i = 0; i < 6; i++) M.noteUse('qfa', 'moonshotai/kimi-k3');
	for (let i = 0; i < 2; i++) M.noteUse('qfa', 'moonshotai/kimi-k2');
	for (let i = 0; i < 9; i++) M.noteUse('bwb', 'anthropic/claude-sonnet-5');
	const sel = document.createElement('select');
	M.fillSelect(sel, '', '');
	return {
		a: M.providers().find((x) => x.id === 'qfa')?.models.length || 0,
		b: M.providers().find((x) => x.id === 'bwb')?.models.length || 0,
		total: sel.querySelectorAll('option').length,
		kimi: [...sel.querySelectorAll('optgroup:not(:first-child) option')]
			.filter((o) => /kimi/.test(o.value)).map((o) => o.value),
	};
}, { ua: URL_A, ub: URL_B, na: NAME.a, nb: NAME.b });
check('the fixture is in: two providers with their lists', seeded.a === 5 && seeded.b === 4,
	JSON.stringify(seeded));
check('and today\'s native order for "kimi" is alphabetical, the reverse of use',
	seeded.kimi.join() === 'moonshotai/kimi-k1,moonshotai/kimi-k2,moonshotai/kimi-k3', seeded.kimi.join());

const useBefore = await p.evaluate(() => ({
	keys: Object.keys(localStorage).sort().join(), use: localStorage.getItem('daimond-model-use') }));

// ── What the page offers the checks ─────────────────────────────────
const install = () => p.evaluate(() => {
	if (window.__vf) return;
	const wrapOf = (sel) => (sel && sel.nextElementSibling && sel.nextElementSibling.classList.contains('mp'))
		? sel.nextElementSibling : null;
	const shown = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
	window.__vf = {
		sel: (tag) => document.querySelector('select[data-vsite="' + tag + '"]'),
		wrapOf,
		info(tag) {
			const sel = this.sel(tag);
			if (!sel) return { err: 'no select' };
			const w = wrapOf(sel);
			const inp = w && w.querySelector('input.mp-in');
			const pop = document.querySelector('.mp-pop');
			const open = shown(pop);
			const rect = (e) => { const r = e.getBoundingClientRect();
				return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
			const o = sel.selectedOptions[0];
			return {
				nativeShown: shown(sel),
				hasInput:    !!inp,
				inputShown:  shown(inp),
				inputRect:   inp ? rect(inp) : null,
				inputVal:    inp ? inp.value : '',
				open,
				popRect:     open ? rect(pop) : null,
				rows:        open ? [...pop.querySelectorAll('.mp-row')].map((r) => ({
					text: r.textContent, value: r.dataset.value || '', provider: r.dataset.provider || '',
					sel: r.getAttribute('aria-selected') === 'true',
					act: r.classList.contains('mp-act'), h: r.getBoundingClientRect().height,
					r: rect(r) })) : [],
				grps:        open ? pop.querySelectorAll('.mp-grp').length : 0,
				none:        open ? ((pop.querySelector('.mp-none') || {}).textContent || '') : '',
				nopts:       sel.options.length,
				ngroups:     sel.querySelectorAll('optgroup').length,
				selValue:    sel.value,
				selProvider: o ? (o.dataset.provider || '') : '',
				selText:     o ? o.textContent.trim() : '',
				chg:         sel.__chg || 0,
				vp:          { w: window.innerWidth, h: window.innerHeight },
				dialog:      !!document.querySelector('.dlg-card, .tile-dlg-card'),
			};
		},
		watch(tag) {
			const sel = this.sel(tag);
			sel.__chg = 0;
			sel.addEventListener('change', () => { sel.__chg++; });
		},
		centre(tag) {
			const w = wrapOf(this.sel(tag));
			const inp = w && w.querySelector('input.mp-in');
			if (!inp) return null;
			inp.scrollIntoView({ block: 'center' });
			const r = inp.getBoundingClientRect();
			return { x: r.left + Math.min(40, r.width / 3), y: r.top + r.height / 2 };
		},
		focus(tag) {
			const w = wrapOf(this.sel(tag));
			const inp = w && w.querySelector('input.mp-in');
			if (inp) { inp.scrollIntoView({ block: 'center' }); inp.focus(); }
			return !!inp;
		},
	};
});
await install();

// A row the filter always keeps ("Other…") is not a match: set it aside, in `kept`.
const keepRow = {};
const info = async (tag) => {
	const i = await p.evaluate((t) => window.__vf.info(t), tag);
	if (i.rows) {
		i.allRows = i.rows;
		i.kept = i.rows.filter((r) => r.value === keepRow[tag]);
		i.rows = i.rows.filter((r) => r.value !== keepRow[tag]);
	}
	return i;
};
const openedBy = async (tag, how) => {
	if (how === 'key') {
		await p.evaluate((t) => window.__vf.focus(t), tag);
		await p.keyboard.press('ArrowDown');
	} else if (how === 'tap') {
		const c = await p.evaluate((t) => window.__vf.centre(t), tag);
		if (!c) return false;	// no filter field to tap: the check that says so has already failed
		await p.touchscreen.tap(c.x, c.y);
	} else {
		const c = await p.evaluate((t) => window.__vf.centre(t), tag);
		if (!c) return false;
		await p.mouse.click(c.x, c.y);
	}
	return until(async () => (await info(tag)).open, 2500);
};
const typed = async (tag, text) => {
	await p.keyboard.press('Control+A');
	await p.keyboard.type(text, { delay: 8 });
	await sleep(120);
	return info(tag);
};
const texts = (i) => i.rows.map((r) => r.value);

/// Drive one pulldown the way a person does and say what came of each step.
async function exercise(tag, o = {}) {
	const L = (n) => tag + ': ' + n;
	// A pulldown whose change redraws the whole panel (the drafting model) is a NEW
	// select afterwards: find it again, and count its changes from nought.
	const retag = async () => {
		if (!o.rerender) return;
		await sleep(350);
		await tagSite(tag, o.finder);
		await p.evaluate((t) => window.__vf.watch(t), tag);
	};
	await install();
	keepRow[tag] = o.keepRow || null;
	await p.evaluate((t) => window.__vf.watch(t), tag);
	const h0 = await info(tag);
	const present = !h0.err && h0.hasInput && h0.inputShown && !h0.nativeShown
		&& h0.inputRect.w > 40 && h0.inputRect.h > 14;
	check(L('the pulldown is a filter field: input drawn, native select hidden'), present,
		h0.err || `input=${h0.hasInput} shown=${h0.inputShown} nativeStillShown=${h0.nativeShown}`);
	if (!present) return false;

	// Click: the full list, below the field.
	const opened = await openedBy(tag, 'click');
	let i = await info(tag);
	check(L('a click opens the list'), opened);
	if (!opened) return false;
	check(L('with every option of the pulldown in it'), i.allRows.length === i.nopts,
		`${i.allRows.length} rows, ${i.nopts} options`);
	check(L('grouped as the pulldown groups them'), i.grps === i.ngroups, `${i.grps} headings, ${i.ngroups} groups`);
	const below = i.popRect.t >= i.inputRect.b - 1;
	const clear = below || i.popRect.b <= i.inputRect.t + 1;
	const room = i.vp.h - i.inputRect.b;
	check(L('below the field, or above only where there is no room below'),
		below || (clear && room < i.popRect.h), `pop ${Math.round(i.popRect.t)}..${Math.round(i.popRect.b)} field ${Math.round(i.inputRect.t)}..${Math.round(i.inputRect.b)} room ${Math.round(room)}`);
	check(L('inside the window'), i.popRect.l >= 0 && i.popRect.r <= i.vp.w + 0.5
		&& i.popRect.t >= 0 && i.popRect.b <= i.vp.h + 0.5);
	const marked = i.rows.filter((r) => r.sel);
	check(L('the chosen model is marked, once'),
		marked.length === 1 && marked[0].value === i.selValue, marked.map((r) => r.value).join());

	// Any part of a name, not only the start.
	i = await typed(tag, 'imi-k3');
	check(L('"imi-k3" finds kimi-k3 from the middle of its name'),
		i.open && i.rows.length === 1 && i.rows[0].value === 'moonshotai/kimi-k3', texts(i).join());
	i = await typed(tag, 'k3 kimi');
	check(L('"k3 kimi" -- both words, any order -- finds only kimi-k3'),
		i.rows.length === 1 && i.rows[0].value === 'moonshotai/kimi-k3', texts(i).join());
	i = await typed(tag, 'kimi k3');
	check(L('and "kimi k3" the same'), i.rows.length === 1 && i.rows[0].value === 'moonshotai/kimi-k3', texts(i).join());
	i = await typed(tag, 'moonshotai k2');
	check(L('a word of the id and a word of the name together'),
		i.rows.length === 1 && i.rows[0].value === 'moonshotai/kimi-k2', texts(i).join());
	if (!o.noProvider) {
		i = await typed(tag, 'QuillFeather');
		check(L('a provider\'s name finds all of its models, whatever the case'),
			i.rows.length === 5 && i.rows.every((r) => r.provider === 'qfa'),
			`${i.rows.length} rows: ${[...new Set(i.rows.map((r) => r.provider))].join()}`);
		i = await typed(tag, 'bramblewick claude');
		check(L('a provider\'s name and a word of the model together'),
			i.rows.length === 2 && i.rows.every((r) => r.provider === 'bwb' && /claude/.test(r.value)), texts(i).join());
	}
	i = await typed(tag, 'zzzqq');
	check(L('no match says so and lists nothing'), i.rows.length === 0 && i.none.trim().length > 2
		&& !/^models\./.test(i.none.trim()), JSON.stringify(i.none));
	const before = i.selValue, chg0 = i.chg;
	await p.keyboard.press('Enter');
	await sleep(120);
	i = await info(tag);
	check(L('and Enter on nothing chooses nothing'), i.selValue === before && i.chg === chg0);

	// Used first.
	i = await typed(tag, 'kimi');
	if (o.rank) {
		check(L('"kimi": the most used first -- k3, k2, k1, the reverse of the alphabet'),
			texts(i).join() === 'moonshotai/kimi-k3,moonshotai/kimi-k2,moonshotai/kimi-k1', texts(i).join());
		i = await typed(tag, 'claude');
		check(L('across providers too: the used sonnet before the unused opus'),
			i.rows.length === 2 && /sonnet/.test(i.rows[0].value), texts(i).join());
		i = await typed(tag, 'kimi');
	} else {
		check(L('"kimi" lists the three kimi models'), i.rows.length === 3, texts(i).join());
	}

	// The keyboard: Down, Enter.
	const second = i.rows[1];
	await p.keyboard.press('ArrowDown');
	await sleep(80);
	const mid = await info(tag);
	check(L('ArrowDown moves the highlight to the second match'),
		mid.rows.length === 3 && mid.rows[1].act && !mid.rows[0].act, mid.rows.map((r) => r.act).join());
	await p.keyboard.press('Enter');
	await sleep(200);
	await retag();
	i = await info(tag);
	check(L('Enter chooses it: the select holds it and said so'),
		!!second && i.selValue === second.value && i.selProvider === second.provider
			&& (o.rerender || i.chg === chg0 + 1),
		`${i.selValue} change x${i.chg - chg0}`);
	check(L('the list closes and the field shows the choice'),
		!i.open && i.inputVal.trim() === i.selText, JSON.stringify(i.inputVal) + ' / ' + JSON.stringify(i.selText));

	// Escape keeps what was there, and keeps a dialog under it open.
	const kept = i.selValue, keptText = i.selText;
	await openedBy(tag, 'click');
	await typed(tag, 'qqq');
	await p.keyboard.press('Escape');
	await sleep(150);
	i = await info(tag);
	check(L('Escape closes the list, keeps the value and puts the field\'s words back'),
		!i.open && i.selValue === kept && i.inputVal.trim() === keptText, JSON.stringify(i.inputVal));
	if (o.dialog) check(L('and the dialog under it stays open'), i.dialog);

	// The keyboard alone opens it.
	await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
	const kopen = await openedBy(tag, 'key');
	check(L('ArrowDown on the focused field opens it'), kopen);
	await p.keyboard.press('Escape');
	await sleep(120);

	// A click on a row.
	await openedBy(tag, 'click');
	i = await typed(tag, 'kimi-k1');
	const row = i.rows[0];
	// What the pointer will land on, named when the check fails.
	const hit = row ? await p.evaluate(({ x, y }) => {
		const e = document.elementFromPoint(x, y);
		const name = (n) => n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : '') : 'nothing';
		return name(e) + ' < ' + name(e && e.parentElement) + ' act=' + (document.activeElement && document.activeElement.className);
	}, { x: row.r.l + 30, y: row.r.t + row.r.h / 2 }) : 'no row';
	if (row) await p.mouse.click(row.r.l + 30, row.r.t + row.r.h / 2);
	await sleep(250);
	await retag();
	i = await info(tag);
	check(L('a click on a row chooses it'), !!row && i.selValue === 'moonshotai/kimi-k1' && !i.open,
		i.selValue + (i.open ? ' (still open)' : '') + ' — under the pointer: ' + hit);
	return true;
}

const closeAll = async () => {
	await p.keyboard.press('Escape');
	await p.evaluate(() => {
		document.querySelectorAll('.tile-dlg .tile-dlg-done, .dlg-card .dlg-cancel')
			.forEach((b) => { try { b.click(); } catch { /* gone */ } });
	});
	await sleep(250);
};
const tagSite = (name, finder) => tag(name, finder);
const tag = (name, finder) => p.evaluate(({ name, finder }) => {
	const sel = (new Function('return (' + finder + ')'))()();
	if (!sel) return false;
	sel.setAttribute('data-vsite', name);
	return true;
}, { name, finder });

// ── Site 1 and 6: the Models panel ──────────────────────────────────
await p.evaluate(() => document.getElementById('astat-model').click());
const panel = await until(() => p.evaluate(() => !!document.querySelector('.models-draft-sel')), 8000);
check('draft: the Models panel opens with its drafting-model pulldown', panel);
if (panel) {
	await tag('draft', "() => document.querySelector('.models-draft-sel')");
	await exercise('draft', { rank: true, rerender: true,
		finder: "() => document.querySelector('.models-draft-sel')" });
	await closeAll();
}

// ── Site 7: add a provider ──────────────────────────────────────────
// The panel was closed above, so open it again and wait for the add button to
// be drawn before pressing it; the form must then be drawn too, or the model
// field cannot be reached at all.
for (const b of ['astat-model', 'settings-btn']) {
	await p.evaluate((id) => { const e = document.getElementById(id); if (e) e.click(); }, b);
	if (await until(() => p.evaluate(() => {
		const a = document.getElementById('models-add');
		return !!a && a.getClientRects().length > 0;
	}), 4000)) break;
}
const added = await p.evaluate(async ({ ua }) => {
	const btn = document.getElementById('models-add');
	if (!btn) return 'no add button';
	if (!btn.getClientRects().length) return 'the add button is not drawn';
	if (!document.getElementById('byok-form').getClientRects().length) btn.click();
	if (!document.getElementById('byok-form').getClientRects().length) return 'the add-provider form did not open';
	const prov = document.getElementById('cfg-provider');
	prov.value = 'custom';
	prov.dispatchEvent(new Event('change', { bubbles: true }));
	await new Promise((r) => setTimeout(r, 200));
	const url = document.getElementById('cfg-base-url');
	url.value = ua;
	url.dispatchEvent(new Event('input', { bubbles: true }));
	url.dispatchEvent(new Event('change', { bubbles: true }));
	const key = document.getElementById('cfg-api-key');
	key.value = 'kk-filter-test';
	key.dispatchEvent(new Event('input', { bubbles: true }));
	key.dispatchEvent(new Event('change', { bubbles: true }));
	for (let i = 0; i < 60; i++) {
		const m = document.getElementById('cfg-model');
		if (m && [...m.options].some((o) => o.value === 'moonshotai/kimi-k3')) {
			m.scrollIntoView({ block: 'center' });
			return '';
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	return 'the model list never loaded';
}, { ua: URL_A });
check('addprov: the add-provider form loads the provider\'s model list', added === '', added);
if (added === '') {
	await tag('addprov', "() => document.getElementById('cfg-model')");
	const drawn = await exercise('addprov', { noProvider: true, keepRow: '__other__' });
	// "Other..." has to stay reachable whatever was typed: it is the way out for a
	// provider that does not list the model wanted.
	if (drawn) await openedBy('addprov', 'click');
	const other = drawn ? await typed('addprov', 'zzzqq') : { rows: [], allRows: [], none: '' };
	check('addprov: "Other…" stays in the list whatever is typed, so a model that is not listed can still be entered',
		other.allRows.length === 1 && other.allRows[0].value === '__other__'
			&& other.none.trim().length > 2, other.allRows.map((r) => r.value).join());
	// Nothing matched, so nothing is lit: Down lights "Other…", Enter chooses it.
	if (drawn) { await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter'); await sleep(200); }
	const shownCustom = await p.evaluate(() => {
		const c = document.getElementById('cfg-model-custom');
		return !!c && c.style.display !== 'none';
	});
	check('addprov: and choosing it shows the box for typing a model id', shownCustom);
	await closeAll();
}

// ── Site 5: Settings, Fold with ─────────────────────────────────────
let foldReach = false;
for (const btn of ['settings-btn', 'astat-model']) {
	await p.evaluate((b) => { const e = document.getElementById(b); if (e) e.click(); }, btn);
	foldReach = await until(() => p.evaluate(() => {
		const f = document.getElementById('cfg-fold-model');
		if (!f) return false;
		const w = f.nextElementSibling && f.nextElementSibling.classList.contains('mp') ? f.nextElementSibling : f;
		return w.getClientRects().length > 0;
	}), 4000);
	if (foldReach) break;
}
check('fold: Settings shows the "Fold with" pulldown', foldReach);
if (foldReach) {
	await tag('fold', "() => document.getElementById('cfg-fold-model')");
	await exercise('fold', { rank: true });
	await closeAll();
}

// ── Site 2: New Diamond ─────────────────────────────────────────────
await p.evaluate(() => document.getElementById('new-diamond-btn').click());
const dlgUp = await until(() => p.evaluate(() => document.querySelectorAll('.dlg-select').length === 2), 8000);
check('dlg: New Diamond shows its model and worker-model pulldowns', dlgUp);
if (dlgUp) {
	await p.evaluate(() => document.querySelectorAll('.dlg-card details').forEach((d) => { d.open = true; }));
	await tag('dlg-model', "() => document.querySelectorAll('.dlg-select')[0]");
	await tag('dlg-worker', "() => document.querySelectorAll('.dlg-select')[1]");
	await exercise('dlg-model', { rank: true, dialog: true });
	// The worker pulldown follows the Diamond's model until it is moved: the list is
	// rebuilt under the field, and the field has to say what the select now holds.
	const follow = await p.evaluate(() => {
		const sels = document.querySelectorAll('.dlg-select');
		const w = sels[1], m = sels[0];
		const inp = w.nextElementSibling && w.nextElementSibling.querySelector('input.mp-in');
		return { same: w.value === m.value, text: inp ? inp.value.trim() : null,
			want: (w.selectedOptions[0] || {}).textContent };
	});
	check('dlg: the worker field follows the Diamond\'s model, and shows it',
		follow.same && follow.text !== null && follow.text === (follow.want || '').trim(), JSON.stringify(follow));
	await exercise('dlg-worker', { rank: true, dialog: true });
	await closeAll();
}

// ── Site 3: a Diamond's settings ────────────────────────────────────
const cogUp = await p.evaluate(async () => {
	const box = document.querySelector('#diamond-list .diamond-box');
	const cog = box && box.querySelector('.tile-cog');
	if (!cog) return false;
	cog.click();
	return true;
});
const cogCard = cogUp && await until(() => p.evaluate(() =>
	document.querySelectorAll('.tile-dlg-card .tile-dlg-model select').length === 3), 8000);
check('cog: a Diamond\'s settings show the daimon, Workers and Workers-images pulldowns', cogCard);
if (cogCard) {
	await p.evaluate(() => document.querySelectorAll('.tile-dlg-card details').forEach((d) => { d.open = true; }));
	const names = ['cog-daimon', 'cog-workers', 'cog-images'];
	for (let k = 0; k < 3; k++) {
		await tag(names[k], `() => document.querySelectorAll('.tile-dlg-card .tile-dlg-model select')[${k}]`);
	}
	await exercise('cog-daimon', { rank: true, dialog: true });
	// The Change button is the daimon pulldown's own: choosing a model by the list
	// has to raise it exactly as the native change did.
	const change = await p.evaluate(() => {
		const b = document.querySelector('.tile-dlg-card .tile-dlg-apply');
		return !!b && !b.hidden;
	});
	check('cog: choosing a different daimon model raises the Change button', change);
	await exercise('cog-workers', { rank: true, dialog: true });
	await exercise('cog-images', { rank: true, dialog: true });

	// Touch, in a phone's window: a finger opens it, rows are finger-high, and it
	// stays inside the screen.
	await p.setViewportSize({ width: 390, height: 844 });
	await sleep(500);
	await p.evaluate(() => document.querySelectorAll('.tile-dlg-card details').forEach((d) => { d.open = true; }));
	const topen = await openedBy('cog-daimon', 'tap');
	check('touch: a tap on the field opens the list', topen);
	let i = await info('cog-daimon');
	check('touch: every row is finger-high (44px)', i.rows.length > 0 && i.rows.every((r) => r.h >= 43.5),
		`min ${Math.round(Math.min(...i.rows.map((r) => r.h)))}px`);
	check('touch: the list is inside the 390px window',
		i.open && i.popRect.l >= 0 && i.popRect.r <= i.vp.w + 0.5 && i.popRect.t >= 0 && i.popRect.b <= i.vp.h + 0.5,
		i.popRect ? `${Math.round(i.popRect.l)}..${Math.round(i.popRect.r)} x ${Math.round(i.popRect.t)}..${Math.round(i.popRect.b)}` : '');
	await p.keyboard.type('claude', { delay: 8 });
	await sleep(150);
	i = await info('cog-daimon');
	const target = i.rows.find((r) => /opus/.test(r.value));
	if (target) await p.touchscreen.tap(target.r.l + 30, target.r.t + target.r.h / 2);
	await sleep(300);
	i = await info('cog-daimon');
	check('touch: a tap on a row chooses it', !!target && /opus/.test(i.selValue) && !i.open, i.selValue);
	await shot(s, 'model-filter-phone');
	await p.setViewportSize({ width: 1500, height: 950 });
	await closeAll();
}

// ── Site 4: the pending chat tile -- read in the source ─────────────
//
// A chat that can start is started, so this tile is rarely on screen (see
// verify_workermodel). What is certain is the source: both of its pulldowns are
// drawn by the one control, and a click on it does not switch the chat.
const src = await p.evaluate(() => fetch('/js/daimond.js').then((r) => r.text()));
const near = (anchor, needle, span) => {
	const at = src.indexOf(anchor);
	return at >= 0 && src.slice(at, at + span).includes(needle);
};
check('tile: the pending tile\'s chat-model pulldown is the shared filter field',
	near("ctrls.className = 'tile-pending';", 'picker(sel', 1800));
check('tile: and its worker-model pulldown',
	near("wsel.className = 'tile-model tile-worker-model';", 'picker(wsel', 2200));
check('tile: a click on either does not switch the chat',
	near("ctrls.className = 'tile-pending';", ".el.addEventListener('click'", 1900)
	&& near("wsel.className = 'tile-model tile-worker-model';", ".el.addEventListener('click'", 2600));

// ── Nothing was written by looking ──────────────────────────────────
const useAfter = await p.evaluate(() => ({
	keys: Object.keys(localStorage).sort().join(), use: localStorage.getItem('daimond-model-use') }));
check('opening, filtering and choosing wrote no use record and no new store',
	useAfter.use === useBefore.use, useAfter.keys === useBefore.keys ? '' : 'keys moved');

stub.close();
await s.close?.();
console.log(`\n${ok.length} ok, ${bad.length} FAIL`);
if (bad.length) console.log('FAILED: ' + bad.join(' | '));
process.exit(bad.length ? 1 : 0);
