// phonediamond.test.mjs -- on a phone, a Diamond is a page: Crystal | Chat | Files (Stack A4, frame b4).
//
//	node --test www/js/phonediamond.test.mjs
//
// The segment has three faces, in the mock's order. Chat is the Diamond's ONE conversation
// (owner 30 Oct, "One for now"): `daimonChat(f)`, made on first use and found again after,
// with no count beside it. Files is a face of its own that the view store keeps per Diamond.
// This runs the real view store and `daimonChat` cut out of page/diamonds.js against stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');
const HTML = read('../index.html');
const DIA  = read('page/diamonds.js');
const AP   = read('page/agentspanel.js');
const SUI  = read('page/settingsui.js');
const cut  = (s, from, to) => {
	const a = s.indexOf(from), b = s.indexOf(to, a);
	assert.ok(a >= 0 && b > a, `cannot cut ${JSON.stringify(from)} .. ${JSON.stringify(to)}`);
	return s.slice(a, b);
};

// The view store and the daimon's conversation, live, over a small world.
function world() {
	const store = new Map();
	const pg = { chats: [], currentDiamond: null };
	const ctx = {
		pg, persisted: 0,
		localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
		t: k => k, tabViewSet() {}, newChatId: (() => { let n = 0; return () => 'c' + (++n); })(),
	};
	ctx.readJson = (k, d) => { const v = store.get(k); return v == null ? d : JSON.parse(v); };
	ctx.persistChats = () => { ctx.persisted++; };
	const src = cut(DIA, 'var DIAMOND_VIEW_KEY', '// ── Triggered actions').replace(/^export /gm, '');
	vm.createContext(ctx);
	vm.runInContext(src + '\nthis.api = { diamondView, setDiamondView, daimonChat };', ctx);
	return ctx;
}

test('the segment has three faces, Crystal | Chat | Files, and Chat carries no count', () => {
	const sw = cut(HTML, 'id="diamond-view"', '</div>');
	const ids = [...sw.matchAll(/id="dview-([a-z]+)"/g)].map(m => m[1]);
	assert.deepEqual(ids, ['crystal', 'chat', 'files']);
	const keys = [...sw.matchAll(/data-i18n="([a-z_.]+)"/g)].map(m => m[1]);
	assert.deepEqual(keys, ['crystal.view_crystal', 'crystal.view_chat', 'diamond.files']);
	assert.match(sw, /data-i18n="crystal\.view_chat">Chat<\/button>/, 'the Chat face is a word, no count');
	// Each face is a press that selects it.
	assert.match(SUI, /\['crystal', 'chat', 'files'\]\.forEach\(function \(which\) \{\s*var b = document\.getElementById\('dview-' \+ which\)/);
});

test('each Diamond keeps its own face, Files among them; anything else reads as the crystal', () => {
	const { api } = world();
	assert.equal(api.diamondView('d1'), 'crystal', 'absent is the crystal');
	api.setDiamondView('d1', 'files');
	api.setDiamondView('d2', 'chat');
	assert.equal(api.diamondView('d1'), 'files');
	assert.equal(api.diamondView('d2'), 'chat');
	api.setDiamondView('d1', 'bogus');
	assert.equal(api.diamondView('d1'), 'crystal');
});

test('Chat opens the one conversation: daimonChat(f), made once, found again', () => {
	const w = world();
	const f = { id: 'd1', name: 'Tax 2026' };
	const a = w.api.daimonChat(f);
	const b = w.api.daimonChat(f);
	assert.equal(a, b, 'the same record both times');
	assert.equal(w.pg.chats.filter(c => c.diamondId === 'd1').length, 1);
	assert.equal(a.name, 'Tax 2026');
	// The Chat face points `current` at that record and nothing else.
	const sel = cut(AP, 'export async function selectDiamond', "	if (want === 'chat') {");
	assert.match(sel, /view === 'files'/, 'selectDiamond takes the Files face');
	const chat = cut(AP, "	if (want === 'chat') {", 'return;\n\t}');
	assert.match(chat, /var rec = daimonChat\(f\);\s*setCurrent\(rec\);/);
});

test('the Files face is the Workspace card moved onto the page, not a second tree', () => {
	const FT = read('page/files_tree.js');
	const seat = cut(FT, 'export function seatOnDiamond', '\n}\n');
	assert.match(seat, /treeEl\.closest\('\.files-card'\)/);
	assert.match(seat, /host\.appendChild\(card\)/);
	assert.match(seat, /panel\.appendChild\(card\)/);
	assert.match(HTML, /<div class="diamond-files" id="diamond-files" hidden><\/div>/);
	assert.match(AP, /seatOnDiamond\(filesOn\)/);
});

// The bar's ⋯ menu, run live over a stub DOM: `DaimondLayers.done` only takes a menu off the
// layer stack, so a pick that called it alone left the menu drawn over the head (A4b, 30 Oct).
test('the bar\'s ⋯ menu is gone after a pick, and after a second press of ⋯', () => {
	const CR = read('page/crystal.js');
	const src = cut(CR, 'function paintStackActs', '\n}\n') + '\n}\n';
	const el = (tag) => {
		const e = { tag, kids: [], on: {}, attrs: {}, style: {}, parent: null, removed: false,
			appendChild(k) { k.parent = e; e.kids.push(k); return k; },
			addEventListener(t, f) { e.on[t] = f; }, setAttribute(k, v) { e.attrs[k] = v; }, getAttribute(k) { return e.attrs[k]; },
			remove() { e.removed = true; }, contains(x) { for (let n = x; n; n = n.parent) if (n === e) return true; return false; },
			getBoundingClientRect: () => ({ bottom: 40, right: 380 }), focus() {}, click() { (e.on.click || (() => {}))({ stopPropagation() {} }); } };
		Object.defineProperty(e, 'firstChild', { get: () => e.kids[0] || null });
		Object.defineProperty(e, 'textContent', { get: () => e.text || '', set: (v) => { e.text = v; if (v === '') e.kids = []; } });
		return e;
	};
	const acts = el('div'), full = el('button'); full.text = 'Full screen';
	let fulls = 0; full.on.click = () => { fulls++; };
	const pops = [], layer = [];
	const ctx = {
		PENCIL_SVG: '', DOTS_SVG: '', t: (k) => k, window: { innerWidth: 390 }, setTimeout: (f) => f(),
		document: {
			getElementById: (id) => id === 'stack-acts' ? acts : id === 'crystal-full-btn' ? full : null,
			createElement: (tag) => { const e = el(tag); if (tag === 'div') pops.push(e); return e; },
			querySelector: () => pops.find((p) => p.parent === 'body' && !p.removed) || null,
			addEventListener() {}, removeEventListener() {},
		},
		DaimondLayers: { hang(p, id) { p.parent = 'body'; layer.push(id); }, done(id) { const i = layer.indexOf(id); if (i >= 0) layer.splice(i, 1); } },
	};
	vm.createContext(ctx);
	vm.runInContext(src + '\nthis.paint = paintStackActs;', ctx);
	ctx.paint(null, []);
	const more = acts.kids[acts.kids.length - 1];
	more.click();
	const pop = pops.find((p) => p.parent === 'body');
	assert.ok(pop && !pop.removed, 'the menu opens');
	pop.kids[pop.kids.length - 1].click();
	assert.equal(fulls, 1, 'the pick is made');
	assert.ok(pop.removed, 'the menu is removed after a pick');
	assert.deepEqual(layer, [], 'and is off the layer stack');
	more.click();
	const pop2 = pops.filter((p) => p.parent === 'body').pop();
	assert.ok(pop2 !== pop && !pop2.removed, 'it opens again');
	more.click();
	assert.ok(pop2.removed, 'a second press of ⋯ closes it');
	assert.equal(more.attrs['aria-expanded'], 'false');
});
