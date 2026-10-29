// storeask.test.mjs — the Workspace · Browser row is a control only while asking can change something.
//
// THE DEFECT (r569 postgates crawl, #astat-store INERT). The row asked
// `navigator.storage.persist()` on every tap. A browser that refuses answers every
// later ask the same way, so the row redrew identical: a tap that did nothing, on
// every phone since D-20261015-15 shows these rows there.
//
// THE RULE (lead, r569): the row is a control only while the Storage API can ask,
// storage is not yet persistent, and this device has not already been refused. A
// refusal is recorded per device and the row is drawn as plain status. No new text.
//
// `storage()` lives nested inside `www/js/daimond.js`, which cannot be loaded under
// node, so it is cut out by brace matching and run against a stub DOM.

import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readPage(join(HERE, 'daimond.js'), 'utf8');

function cut(src, head) {
	const start = src.indexOf(head);
	if (start < 0) return '';
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

function cutVar(src, name) {
	const m = new RegExp('\\n\\tvar ' + name + '\\s*=[^\\n]*;').exec(src);
	return m ? m[0].trim() : '';
}

const tick = () => new Promise((res) => setImmediate(res));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

// One device: a row element, a local store, and a browser whose answers are set per case.
function rig({ kept = false, grant = false, api = true, stored = {} } = {}) {
	const r = { style: { display: '', cursor: '' }, title: '', onclick: null, dot: null };
	const ls = {
		m: Object.assign({}, stored),
		getItem(k) { return k in this.m ? this.m[k] : null; },
		setItem(k, v) { this.m[k] = String(v); },
		removeItem(k) { delete this.m[k]; },
	};
	const asks = { n: 0 };
	const storage = {
		estimate: async () => ({ usage: 2048, quota: 1 << 30 }),
		persisted: async () => kept,
	};
	if (api) storage.persist = async () => { asks.n++; if (grant) kept = true; return grant; };
	const nav = { storage };
	const doc = { getElementById: (id) => (id === 'astat-store' ? r : null) };
	const row = (id, dot) => { r.dot = dot; };
	const t = (k) => k;
	const body = [
		cutVar(SRC, 'STORE_REFUSED_KEY'),
		cut(SRC, '\n\tfunction storeAskable('),
		'var locked = false; var _storeSeq = 0;',
		cut(SRC, '\n\t\tfunction storage('),
		'return storage;',
	].join('\n');
	const storageFn = new Function('document', 'navigator', 'localStorage', 'row', 't', 'fmtBytes', 'native', body)(
		doc, nav, ls, row, t, (n) => n + ' B', () => {});
	return { r, ls, asks, storageFn };
}

// A control in the crawl's sense: something answers the tap and the cursor says so.
const tappable = (r) => typeof r.onclick === 'function' || r.style.cursor === 'pointer';

test('an unkept store with the API offers the ask', async () => {
	const d = rig();
	d.storageFn(); await settle();
	assert.equal(tappable(d.r), true);
	assert.equal(d.r.dot, 'off');
});

test('a refused ask leaves no tappable #astat-store, and stays so on this device', async () => {
	const d = rig({ grant: false });
	d.storageFn(); await settle();
	await d.r.onclick(); await settle();
	assert.equal(d.asks.n, 1);
	assert.equal(tappable(d.r), false, 'refused: the row must be plain status');
	// The next draw on this device (a reload reads the same store) still offers nothing.
	const again = rig({ grant: false, stored: d.ls.m });
	again.storageFn(); await settle();
	assert.equal(tappable(again.r), false, 'the refusal is remembered per device');
	assert.equal(again.asks.n, 0);
});

test('a granted ask turns the row to kept status', async () => {
	const d = rig({ grant: true });
	d.storageFn(); await settle();
	await d.r.onclick(); await settle();
	assert.equal(tappable(d.r), false);
	assert.equal(d.r.dot, 'ok');
});

test('no persist() in the browser: plain status', async () => {
	const d = rig({ api: false });
	d.storageFn(); await settle();
	assert.equal(tappable(d.r), false);
});

test('already persistent: plain status', async () => {
	const d = rig({ kept: true });
	d.storageFn(); await settle();
	assert.equal(tappable(d.r), false);
	assert.equal(d.r.dot, 'ok');
});

test('plain status does not invite an ask in its tooltip', async () => {
	const d = rig({ api: false });
	d.storageFn(); await settle();
	assert.equal(d.r.title.includes('astat.store_evictable'), false);
});
