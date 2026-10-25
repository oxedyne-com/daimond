/* ============================================================
   Test -- a runner turn's network on its History row (U8h HISTORY-NET, 24 Oct 2026).

   A turn handed to a runner reaches the network through the run's proxy, and the report's
   `turnRec.net` lists each destination: `registry` (allowed), `outside` (it tripped the
   latch, so later commands ran offline) or `refused` (with its `why`). The engine keeps
   them on the version's `away`; the History row lists them under the files, one line each,
   in plain words, and `netMore` adds "and N more". Nothing is asked and no button is added.

   The page code is lifted from daimond.js by a brace-balanced scan and judged in the
   English it ships with.

   Run:  node --test www/js/historynet.test.mjs
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');
const en = readFileSync(new URL('../i18n/en.js', import.meta.url), 'utf8');

/// A function declared at the IIFE's top level, by a brace-balanced scan; '' when absent.
function fn(name) {
	let at = src.indexOf('\n\tasync function ' + name + '(');
	if (at < 0) at = src.indexOf('\n\tfunction ' + name + '(');
	if (at < 0) return '';
	let depth = 0, i = src.indexOf('{', at);
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) break; }
	}
	return src.slice(at + 1, i + 1);
}

// A just-enough element tree.
function makeEl(tag) {
	const el = {
		tagName: tag, className: '', textContent: '', title: '', children: [], dataset: {},
		classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, toggle() {} },
		appendChild(c) { el.children.push(c); return c; },
		replaceChildren(...n) { el.children = n; },
		addEventListener() {},
		setAttribute() {},
	};
	return el;
}
const walk = (el, out = []) => { out.push(el); el.children.forEach((c) => walk(c, out)); return out; };
const texts = (el) => walk(el).map((e) => e.textContent).filter(Boolean);
const buttons = (el) => walk(el).filter((e) => e.tagName === 'button');

// English, read from the real table.
const EN = {};
for (const m of en.matchAll(/^\t'([\w.]+)':\s*'((?:[^'\\]|\\.)*)',?/gm)) EN[m[1]] = m[2].replace(/\\'/g, "'");
const t = (k, v) => String(EN[k] == null ? k : EN[k]).replace(/\{(\w+)\}/g, (w, n) => (v && v[n] != null ? String(v[n]) : w));
const tn = (k, n, v) => t(k + (n === 1 ? '.one' : '.other'), v);

/// histRow as daimond.js has it, with the runner Undo stubbed to an empty box.
function histRow() {
	const names = ['histRow', 'histAwayNet', 'fmtBytes', 'isRestoreRow', 'shownPath'];
	const body = names.map(fn).join('\n');
	const make = new Function('document', 't', 'tn', body + `
		function histAwayUndo() { return document.createElement('div'); }
		function relTime() { return ''; }
		return histRow;`);
	return make({ createElement: makeEl }, t, tn);
}

const away = { on: 'ARGO', onName: 'argonaut', run: 'e-5', since: 0, until: 0, more: 0 };
const NET = [
	{ host: 'pypi.org', port: 443, up: 1234, down: 1258291, v: 'registry' },
	{ host: 'pypi-mirror.example', port: 443, up: 10, down: 20, v: 'outside' },
	{ host: '127.0.0.1', port: 9222, up: 0, down: 0, v: 'refused', why: 'a local address' },
];

test('U8h-b (b): the three kinds read as three sentences, and "and 2 more"', () => {
	const r = { v: 3, cause: 'turn', ts: 0, note: '', files: [], truncated: 0,
		away: Object.assign({}, away, { net: NET, netMore: 2 }) };
	const before = buttons(histRow()('d1', Object.assign({}, r, { away }), true, null)).length;
	const row = histRow()('d1', r, true, null);
	const got = texts(row);
	for (const want of [
		'Downloaded from pypi.org · 1.2 MB',
		'Read pypi-mirror.example (outside content): later commands ran offline',
		'Blocked: 127.0.0.1:9222 (a local address)',
		'and 2 more',
	]) assert.ok(got.includes(want), want + ' not in ' + JSON.stringify(got));
	assert.equal(buttons(row).length, before, 'no button is added');
});

test('U8h-b (b): the rows sit under the files, before the actions', () => {
	const files = [{ path: '/home/jason/x/out.mp3', hash: 'a'.repeat(64) }];
	const r = { v: 4, cause: 'turn', ts: 0, note: '', files, truncated: 0,
		away: Object.assign({}, away, { net: NET.slice(0, 1) }) };
	const row = histRow()('d1', r, true, null);
	const kids = row.children.map((c) => c.className);
	const at = kids.indexOf('hist-net');
	assert.ok(at > kids.indexOf('hist-files') && at < kids.indexOf('hist-acts'), JSON.stringify(kids));
	assert.ok(!texts(row).some((x) => /more$/.test(x) && /^and /.test(x)), 'no "and N more" at netMore 0');
});

test('U8h-b (b): a runner row with no net, and a row of this device, list none', () => {
	for (const r of [
		{ v: 5, cause: 'turn', ts: 0, note: '', files: [], truncated: 0, away },
		{ v: 6, cause: 'turn', ts: 0, note: '', files: [], truncated: 0, away: null },
	]) {
		const row = histRow()('d1', r, true, null);
		assert.ok(!row.children.some((c) => c.className === 'hist-net'), JSON.stringify(texts(row)));
	}
});

test('U8h-b (b): every locale has the four sentences', () => {
	for (const loc of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans']) {
		const tab = readFileSync(new URL('../i18n/' + loc + '.js', import.meta.url), 'utf8');
		for (const k of ['versions.net_registry', 'versions.net_outside', 'versions.net_refused', 'versions.net_more']) {
			assert.ok(tab.includes("'" + k + "':"), loc + ' lacks ' + k);
		}
	}
});
