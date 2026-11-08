/* ============================================================
   Test -- versions_link_row: a link's version row in History, and its put-back
   (LINK-VERSIONS LV7, 06 Nov 2026; kimberlite_link_versions_design_20261106.md P9).

   Manifest v3 rows carry a link as `hash: "link:<sha256>"` with its target inline,
   `link` (text) or `linkHex` (any other bytes), and what stood before as
   `was`/`wasLink`/`wasLinkHex`. The row reads "Link to <target>", reads no body, and
   its Restore goes through the UNCHANGED `file_put_back {path, hash}`. A refusal of a
   link row reads `versions.link_here`. A `link:` row carrying no target (an older
   manifest) is "Not on this device" with Restore greyed, as a page before v3 shows it.

   Run:  node --test www/js/versionslink.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const at = (rel) => readPage(new URL('../../' + rel, import.meta.url), 'utf8');
const src = readPage(new URL('./daimond.js', import.meta.url), 'utf8');
const vsrc = at('www/js/versions.js');
const en = at('www/i18n/en.js');

function fn(name) {
	let i0 = src.indexOf('\n\tasync function ' + name + '(');
	if (i0 < 0) i0 = src.indexOf('\n\tfunction ' + name + '(');
	if (i0 < 0) return '';
	let depth = 0, i = src.indexOf('{', i0);
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) break; }
	}
	return src.slice(i0 + 1, i + 1);
}

function makeEl(tag) {
	const el = {
		tagName: tag, className: '', textContent: '', title: '', disabled: false, children: [], dataset: {}, on: {},
		classList: { add() {}, remove() {}, toggle() {} },
		appendChild(c) { el.children.push(c); return c; },
		remove() {},
		querySelector() { return null; },
		addEventListener(k, f) { el.on[k] = f; },
		setAttribute() {},
	};
	return el;
}
const walk = (el, out = []) => { out.push(el); el.children.forEach((c) => walk(c, out)); return out; };
const byClass = (el, c) => walk(el).find((x) => x.className.split(' ').includes(c));
const texts = (el) => walk(el).map((e) => e.textContent).filter(Boolean);

const EN = {};
for (const m of en.matchAll(/^\t'([\w.]+)':\s*'((?:[^'\\]|\\.)*)',?/gm)) {
	EN[m[1]] = JSON.parse('"' + m[2].replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
}
const t = (k, v) => String(EN[k] == null ? k : EN[k]).replace(/\{(\w+)\}/g, (w, n) => (v && v[n] != null ? String(v[n]) : w));
const flush = () => new Promise((r) => setTimeout(r, 0));

/// histFile as the page has it; `V` stands in for DaimondVersions.
function histFile(V) {
	const body = ['histFile', 'shownPath', 'linkShown'].map(fn).join('\n');
	return new Function('document', 't', 'DaimondVersions', 'pg', 'noticeDialog', `
		function diamondTurning() { return false; }
		async function refreshDiamondAfterChange() {}
		` + body + '\nreturn histFile;')({ createElement: makeEl }, t, V, { diamonds: [] }, () => {});
}

/// A stand-in DaimondVersions that records what History asked of it.
function fakeV(refused) {
	const calls = { body: [], restoreFile: [], undoVersion: [] };
	return { calls, V: {
		body: async (id, h) => { calls.body.push(h); return null; },
		diff: async () => null,
		restoreFile: async (...a) => { calls.restoreFile.push(a); return { refused: refused || [] }; },
		undoVersion: async (...a) => { calls.undoVersion.push(a); return { refused: refused || [] }; },
	} };
}

const H = 'link:' + 'a'.repeat(64);
const W = 'link:' + 'b'.repeat(64);

test('versions_link_row: the row reads "Link to <target>", reads no body, and Restore is live', async () => {
	const { calls, V } = fakeV();
	const row = histFile(V)('d1', 4, { path: 'diamonds/d1/cur', hash: H, bytes: 6, link: 'v2/out' });
	await flush();
	assert.ok(texts(row).includes('Link to v2/out'), JSON.stringify(texts(row)));
	assert.deepEqual(calls.body, [], 'no body is read for a link');
	assert.equal(byClass(row, 'hist-file-restore').disabled, false, 'Restore is live');
	assert.equal(byClass(row, 'hist-file-why').textContent, '');
	await byClass(row, 'hist-file-restore').on.click();
	assert.deepEqual(calls.restoreFile, [['d1', 'diamonds/d1/cur', 4, '']]);
});

test('versions_link_row: a target that is not text is shown lossily', async () => {
	const { V } = fakeV();
	const row = histFile(V)('d1', 4, { path: 'diamonds/d1/cur', hash: H, bytes: 4, linkHex: '636166e9' });
	await flush();
	assert.ok(texts(row).includes('Link to caf�'), JSON.stringify(texts(row)));
	assert.equal(byClass(row, 'hist-file-restore').disabled, false);
});

test('versions_link_row: a deleted link reads as its link and is put back', async () => {
	const { calls, V } = fakeV();
	const row = histFile(V)('d1', 5, { path: 'diamonds/d1/cur', hash: '', gone: true, was: W, wasLink: 'v1/out' });
	await flush();
	assert.ok(texts(row).includes('Link to v1/out'), JSON.stringify(texts(row)));
	assert.deepEqual(calls.body, []);
	assert.equal(byClass(row, 'hist-file-restore').disabled, false);
	await byClass(row, 'hist-file-restore').on.click();
	assert.deepEqual(calls.undoVersion, [['d1', 5, ['diamonds/d1/cur']]]);
});

test('versions_link_row: a refusal of a link reads in the row', async () => {
	const why = t('versions.link_here');
	const { V } = fakeV([{ path: 'diamonds/d1/cur', why, said: 'This link was not seen on this machine' }]);
	const row = histFile(V)('d1', 4, { path: 'diamonds/d1/cur', hash: H, link: 'v2/out' });
	await flush();
	await byClass(row, 'hist-file-restore').on.click();
	assert.equal(byClass(row, 'hist-file-why').textContent, 'A link; put back on the machine that has it');
});

test('versions_link_row: a link row with no target (an older manifest) is not on this device, Restore greyed', async () => {
	const { V } = fakeV();
	const row = histFile(V)('d1', 4, { path: 'diamonds/d1/cur', hash: H, bytes: 6 });
	await flush();
	assert.equal(byClass(row, 'hist-file-restore').disabled, true);
	assert.equal(byClass(row, 'hist-file-why').textContent, 'Not on this device');
});

/// The real versions.js in a simulated tab; `door` answers each tool call.
function tab(opened, door, closed) {
	const tools = [];
	const engine = {
		versions_list: () => '[]',
		versions_restore_open: async () => JSON.stringify(opened),
		versions_restore_hold: async () => '{}',
		versions_restore_answer: async () => '{}',
		versions_restore_close: async () => JSON.stringify(closed
			|| { version: 9, recorded: 9, restored: [], missing: [], refused: [] }),
		versions_restore_end: async () => '{}',
		run_diamond_tool(id, tool, args, ticket) {
			tools.push({ tool, args: JSON.parse(args), ticket });
			return Promise.resolve(door(tool));
		},
	};
	const win = {
		DaimondCore: { diamondApp: () => engine, plainError: (x) => String(x) },
		DaimondI18n: { t: (k) => 'T:' + k },
	};
	win.window = win;
	win.addEventListener = () => {};
	new Function('window', 'with (window) {\n' + vsrc + '\n}')(win);
	return { tools, V: win.DaimondVersions };
}

test('versions_link_row: the put-back is file_put_back {path, hash}, nothing more', async () => {
	const s = tab({ ticket: 7, machine: [{ path: '/h/cur', hash: H, link: 'v2/out' }] }, () => ({ outcome: 'done' }));
	await s.V.restoreFile('d1', '/h/cur', 4, '');
	assert.deepEqual(s.tools, [{ tool: 'file_put_back', args: { path: '/h/cur', hash: H }, ticket: 7 }]);
});

test('versions_link_row: a device or runner that refuses the link is worded as the link sentence', async () => {
	for (const text of ['This link was not seen on this machine, so it cannot be put back here',
		'links are not made in this browser']) {
		const s = tab({ ticket: 7, machine: [{ path: '/h/cur', hash: H, link: 'v2/out' }] },
			() => ({ outcome: 'refused', text }));
		const res = await s.V.restoreFile('d1', '/h/cur', 4, '');
		const ref = res.refused.find((x) => x.path === '/h/cur');
		assert.equal(ref && ref.why, 'T:versions.link_here', JSON.stringify(res.refused));
		assert.equal(ref.said, text);
	}
});

test('versions_link_row: the store close leaving a link is worded as the link sentence', async () => {
	const said = 'a link is put back only on the machine that has it';
	const s = tab({ ticket: 7, machine: [] }, () => ({ outcome: 'done' }),
		{ version: 9, recorded: 9, restored: [], missing: [], refused: [{ path: 'diamonds/d1/cur', why: said }] });
	const res = await s.V.restoreFile('d1', 'diamonds/d1/cur', 4, '');
	assert.deepEqual(res.refused, [{ path: 'diamonds/d1/cur', why: 'T:versions.link_here', said }]);
});

test('versions_link_row: every locale has the two sentences', () => {
	for (const loc of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans']) {
		const tab = at('www/i18n/' + loc + '.js');
		for (const k of ['versions.link', 'versions.link_here']) {
			assert.ok(tab.includes("'" + k + "':"), loc + ' lacks ' + k);
		}
		const m = tab.match(/'versions\.link':\s*'([^']*)'/);
		assert.ok(m && m[1].includes('{target}'), loc + ' versions.link names {target}');
	}
});
