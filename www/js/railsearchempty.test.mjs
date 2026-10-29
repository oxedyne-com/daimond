// RAIL-SEARCH R1 (16 Oct 2026): a search or tag filter that matches only a built-in left `mine`
// empty, so the rail said "No diamonds yet." to somebody with many, and the one match sat in the
// Built-in group, shut by default. While the view is narrowed the rail never says that, and the
// Built-in group is open for that view without the open state being saved.
//
// The functions live in a 50,000-line IIFE this harness cannot load, so each is cut out of the
// source by its own name and run alone, against a DOM just large enough for them.
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readPage(join(HERE, 'daimond.js'), 'utf8');

function cut(name, optional) {
	const at = src.indexOf('\tfunction ' + name + '(');
	if (at < 0 && optional) return '';
	assert.ok(at >= 0, name + ' is not in daimond.js');
	const end = src.indexOf('\n\t}\n', at);
	return src.slice(at, end + 3);
}

class El {
	constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.textContent = ''; this.open = false; this.on = {}; }
	appendChild(c) { this.children.push(c); return c; }
	addEventListener(k, fn) { (this.on[k] = this.on[k] || []).push(fn); }
	set innerHTML(v) { this.children = []; }
	all() { return this.children.flatMap((c) => [c, ...(c.all ? c.all() : [])]); }
}

function rail({ query = '', tagInc = [], tagExc = [], stored = null }) {
	const store = new Map(stored == null ? [] : [['daimond-builtin-open', stored]]);
	const list = new El('div');
	const diamonds = [
		{ id: '0da1000000f2', name: 'Lucy', tags: [] },
		{ id: '0da1000000e1', name: 'Neil', tags: [] },
		{ id: 'aa', name: 'Thesis', tags: ['work'] },
		{ id: 'bb', name: 'Network notes', tags: ['work'] },
	];
	const deps = {
		diamondList: list,
		diamonds,
		diamondQuery: query,
		tagInc, tagExc,
		document: { createElement: (t) => new El(t) },
		localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
		t: (k) => k,
		renderTagFilter: () => {},
		repaintPause: () => {},
		updateActiveDiamond: () => {},
		diamondBox: (f) => { const e = new El('div'); e.className = 'diamond-box'; e.textContent = f.name; return e; },
		isBuiltInDiamond: (f) => /^0da1/.test(f.id),
		diamondMatches: (f) => (!query || f.name.toLowerCase().includes(query))
			&& (!tagInc.length || tagInc.every((x) => f.tags.includes(x)))
			&& !tagExc.some((x) => f.tags.includes(x)),
		BUILTIN_OPEN_KEY: 'daimond-builtin-open',
	};
	const body = [cut('railNarrowed', true), cut('builtInGroup'), cut('renderDiamondList')].join('\n');
	const render = new Function(...Object.keys(deps), body + '\nreturn renderDiamondList;')(...Object.values(deps));
	render();
	const notes = list.children.filter((c) => c.className === 'rail-note').map((c) => c.textContent);
	const group = list.children.find((c) => c.className === 'rail-builtin');
	return { list, notes, group, store };
}

test('a search matching only a built-in shows it, open, and never "No diamonds yet."', () => {
	const r = rail({ query: 'lucy' });
	assert.deepEqual(r.notes.filter((n) => n === 'rail.no_diamonds'), [], 'the rail said it has no Diamonds');
	assert.ok(r.group, 'no built-in group drawn');
	assert.equal(r.group.open, true, 'the only match is behind a shut group');
	// Opened for the view, not saved: the toggle a browser fires for it must not write either.
	(r.group.on.toggle || []).forEach((fn) => fn());
	assert.equal(r.store.has('daimond-builtin-open'), false, 'the search opened it for good');
});

test('a tag filter matching only built-ins is treated the same way', () => {
	const r = rail({ tagExc: ['work'] });
	assert.deepEqual(r.notes.filter((n) => n === 'rail.no_diamonds'), []);
	assert.equal(r.group.open, true);
});

test('with no search the group keeps its saved state, and an account of built-ins only still says so', () => {
	const shut = rail({ stored: '0' });
	assert.equal(shut.group.open, false, 'the group opened without a search');
	const opened = rail({ stored: '1' });
	assert.equal(opened.group.open, true);
	// The only-built-ins line is unchanged when nothing is narrowing the view.
	const src2 = cut('renderDiamondList');
	assert.match(src2, /t\('rail\.no_diamonds'\)/);
});

test('the person still sets the saved state by hand when nothing narrows the view', () => {
	const r = rail({ stored: '0' });
	r.group.open = true;
	(r.group.on.toggle || []).forEach((fn) => fn());
	assert.equal(r.store.get('daimond-builtin-open'), '1');
});

// R2: the search field's Escape claim, held for the page's life, says when it is live, so a layer
// that opens above it while focus stays in the field takes the Escape first (layers.js `claim`).
test('the railsearch claim carries a live probe: focus in the field and text in it', () => {
	const at = src.indexOf("DaimondLayers.claim('railsearch'");
	assert.ok(at >= 0, 'no railsearch claim');
	const close = src.indexOf('\n\t\t}', at), end = src.indexOf('\n', close + 1);
	// From the probe's own definition where it is named just above the call.
	const def = src.lastIndexOf('var railSearchLive', at);
	const from = def >= 0 && at - def < 400 ? def : at;
	const call = src.slice(from, end);
	const fake = { claims: [] };
	const field = { value: '' };
	const doc = { activeElement: null };
	new Function('DaimondLayers', 'document', 'diamondSearch', 'setDiamondQuery', 'renderDiamondList', call)(
		{ claim: (id, fn, live) => fake.claims.push({ id, fn, live }) }, doc, field, () => {}, () => {});
	const c = fake.claims[0];
	assert.equal(typeof c.live, 'function', 'the claim has no live probe');
	assert.equal(c.live(), false, 'live with no focus and no text');
	doc.activeElement = field;
	assert.equal(c.live(), false, 'live with an empty field');
	field.value = 'lu';
	assert.equal(c.live(), true, 'not live with focus and text');
	doc.activeElement = {};
	assert.equal(c.live(), false, 'live with focus elsewhere');
});
