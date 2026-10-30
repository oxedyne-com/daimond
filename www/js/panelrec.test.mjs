// panelrec.test.mjs — each conversation's panels, kept and put back (UNBLOCK-14).
//
//	node --test www/js/panelrec.test.mjs
//
// The record is a function of a map, so what it keeps per panel kind, what a show
// made off screen does to it, and what deletion and the cap shed are settled here.
// The browser half (a real A→B→A round trip per panel) is `dev/verify_panelstate.mjs`.
//
// The wiring claims at the end read the source: they hold the three old owners
// (the viewer's `deferred`, the Diamond-only "save arrangement", a switch that
// closes without saving) out of the tree, so a second owner cannot come back
// beside the record unnoticed.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => readPage(path.join(HERE, f), 'utf8');
const shim = { window: {} };
// eslint-disable-next-line no-new-func
new Function('window', src('panelrec.js'))(shim.window);
const R = shim.window.DaimondPanelRec;

function mapStore() {
	const m = new Map();
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => { m.set(k, String(v)); },
		raw: m,
	};
}
let tick = 0;
const clock = () => ++tick;

const LAYOUT = {
	open: { ai: true, doc: true, preview: true, web: true, term: true, work: false },
	stage: ['ai', 'doc', 'preview'], dock: [['web', 'term']],
	widths: { rail: 240, dock: 360 }, seats: { 'ai|doc|preview': [0.4, 0.3, 0.3] }, grid: 'auto',
};

test('the module exists and is not one of the paired or synced keys', () => {
	assert.ok(R && typeof R.make === 'function');
	assert.equal(R.KEY, 'daimond-panel-recs');
	assert.ok(!src('pairing.js').includes(R.KEY), 'a paired device must never receive it');
	assert.ok(!src('accounts.js').includes(R.KEY), 'namespaced per account, not device-global');
});

test('every panel kind is kept and put back for its own conversation only', () => {
	const s = R.make(mapStore(), clock);
	s.put('A', {
		layout: LAYOUT,
		doc: { path: 'notes/a.md', top: 412 },
		preview: { path: 'book/main.pdf', page: 7, store: true },
		web: { url: 'https://example.org/a' },
	});
	s.put('chat:B', { layout: { open: { ai: true }, stage: ['ai'], dock: [] } });
	const a = s.get('A');
	assert.deepEqual(a.layout.open, LAYOUT.open, 'which panels, the Terminal among them');
	assert.deepEqual(a.layout.dock, LAYOUT.dock);
	assert.deepEqual(a.layout.seats, LAYOUT.seats);
	assert.deepEqual(a.doc, { path: 'notes/a.md', top: 412 }, 'the Doc file and its aim');
	assert.deepEqual(a.preview, { path: 'book/main.pdf', page: 7, store: true }, 'Preview file, door, page');
	assert.deepEqual(a.web, { url: 'https://example.org/a' }, 'the Web address');
	const b = s.get('chat:B');
	assert.equal(b.doc, undefined, 'a chat does not see a Diamond\'s file');
	assert.equal(b.web, undefined);
	assert.equal(s.get('C'), null, 'a conversation never left has no record');
});

test('a record is a copy: changing the live layout after leaving does not reach it', () => {
	const s = R.make(mapStore(), clock);
	const live = JSON.parse(JSON.stringify(LAYOUT));
	s.put('A', { layout: live });
	live.open.doc = false;
	assert.equal(s.get('A').layout.open.doc, true);
});

test('a show made off screen is written into the record and survives two round trips', () => {
	const s = R.make(mapStore(), clock);
	s.put('A', { layout: LAYOUT });
	// A's daimon shows a file while B is on screen.
	assert.ok(s.fold('A', 'file', { path: 'out/report.md', page: 0 }));
	// Arriving reads it; reading does not take it.
	assert.deepEqual(s.get('A').shows, [{ path: 'out/report.md' }]);
	assert.deepEqual(s.get('A').shows, [{ path: 'out/report.md' }], 'read twice, still there');
	// Leaving A (round trip 1): the panel now HOLDS it, and that is what is recorded.
	s.put('A', { layout: LAYOUT, doc: { path: 'out/report.md' } });
	assert.equal(s.get('A').doc.path, 'out/report.md');
	// Arriving and leaving again (round trip 2): still held.
	s.put('A', s.get('A'));
	assert.equal(s.get('A').doc.path, 'out/report.md');
});

test('a show for a conversation never visited makes its record', () => {
	const s = R.make(mapStore(), clock);
	s.fold('chat:X', 'file', { path: 'a.pdf', page: 3 });
	s.fold('chat:X', 'file', { path: 'b.md' });
	s.fold('chat:X', 'file', { path: 'a.pdf', page: 4 });
	assert.deepEqual(s.get('chat:X').shows, [{ path: 'b.md' }, { path: 'a.pdf', page: 4 }],
		'one entry per file, newest last, with its newest aim');
	for (let i = 0; i < 10; i++) s.fold('chat:X', 'file', { path: 'f' + i });
	assert.equal(s.get('chat:X').shows.length, R.MAX_SHOWS);
});

test('a Web page opened off screen is written into the record, and opens the panel', () => {
	const s = R.make(mapStore(), clock);
	s.put('A', { layout: { open: { ai: true, web: false }, stage: ['ai'], dock: [] } });
	assert.ok(s.fold('A', 'web', { url: 'https://example.org/later' }));
	const a = s.get('A');
	assert.deepEqual(a.web, { url: 'https://example.org/later' });
	assert.equal(a.layout.open.web, true);
	assert.equal(s.fold('A', 'web', { url: '' }), false, 'no address, nothing written');
});

test('deletion drops the record; the cap sheds the least recently left', () => {
	const st = mapStore();
	const s = R.make(st, clock);
	s.put('A', { layout: LAYOUT });
	assert.ok(s.drop('A'));
	assert.equal(s.get('A'), null);
	assert.equal(s.drop('A'), false);
	for (let i = 0; i < R.MAX_RECS + 5; i++) s.put('k' + i, { doc: { path: 'x.md' } });
	const keys = s.keys();
	assert.equal(keys.length, R.MAX_RECS);
	for (let i = 0; i < 5; i++) assert.ok(!keys.includes('k' + i), 'the oldest went first');
	assert.ok(keys.includes('k' + (R.MAX_RECS + 4)));
	assert.ok(st.raw.get(R.KEY).length < 100 * 1024, 'the whole stays under 100 KiB');
});

test('a bad or hostile store reads as no record, never as a throw', () => {
	const st = mapStore();
	st.setItem('daimond-panel-recs', '{not json');
	const s = R.make(st, clock);
	assert.equal(s.get('A'), null);
	st.setItem('daimond-panel-recs', JSON.stringify({ A: { doc: { path: 'x'.repeat(5000) }, web: 7 } }));
	assert.deepEqual(s.get('A'), { at: 0 }, 'an over-long path and a non-object are dropped');
});

// ── The wiring: one owner, the old three gone ──────────────────────────
test('the viewer folds an off-screen show into the record rather than keeping it to take once', () => {
	const v = src('viewer.js');
	assert.ok(!/takeDeferred/.test(v), 'no take-once path left');
	assert.ok(!/deferred\[owner\]/.test(v), 'no private table of deferred shows');
	assert.ok(/DaimondPanelRec\.fold\(/.test(v), 'the show is written into its conversation\'s record');
});

test('the Web panel is owner-gated and folds an off-screen page into the record', () => {
	const w = src('web.js');
	assert.ok(/async function open\(url, owner, turn\)/.test(w));
	assert.ok(/mayTakeScreen\(String\(owner\)\)/.test(w));
	assert.ok(/DaimondPanelRec\.fold\(String\(owner\), 'web'/.test(w));
});

test('"save arrangement" is gone; a switch saves the record before it closes anything', () => {
	const d = src('daimond.js');
	const ws = src('workspace.js');
	for (const name of ['saveArrangement', 'restoreArrangement', 'forgetArrangement', 'hasArrangement', 'takeDeferred']) {
		assert.ok(!d.includes(name), 'daimond.js still has ' + name);
		assert.ok(!ws.includes(name), 'workspace.js still has ' + name);
	}
	const fc = d.slice(d.indexOf('function followConversation'));
	const body = fc.slice(0, fc.indexOf('\n\t\t}\n'));
	const save = body.indexOf('leaveConversation(');
	const shut = body.indexOf('shutView(');
	assert.ok(save !== -1, 'followConversation records what is left');
	assert.ok(shut === -1 || save < shut, 'and records it before anything is shut');
	assert.ok(/DaimondPanelRec\.drop\(id\)/.test(d), 'a deleted Diamond\'s record goes with it');
	assert.ok(/DaimondPanelRec\.drop\('chat:' \+/.test(d), 'a deleted chat\'s record goes with it');
});

test('the page loads the record before the modules that use it', () => {
	const html = readPage(path.join(HERE, '..', 'index.html'), 'utf8');
	const tag = (f) => html.indexOf('<script src="js/' + f + '"></script>');
	assert.ok(tag('panelrec.js') !== -1);
	assert.ok(tag('panelrec.js') < tag('viewer.js') && tag('panelrec.js') < tag('web.js'));
});

// ── Round 3 (the C0 check's four findings) ─────────────────────────────
test('a page a remote turn opens goes to the asking device, never into this device\'s record', async () => {
	// D-20261006-27, as `showToUser` answers it: the asker first, before any fold.
	const g = globalThis, folds = [];
	const had = { v: g.DaimondViewer, r: g.DaimondPanelRec, w: g.DaimondWeb };
	g.DaimondViewer = {
		askerOf: (owner, turn) => (turn === 'remote' ? { label: 'Phone' } : null),
		mayTakeScreen: () => false,
	};
	g.DaimondPanelRec = { fold: (...a) => { folds.push(a); return true; } };
	try {
		// eslint-disable-next-line no-new-func
		new Function('window', 'document', src('web.js'))(g, {});
		const r = await g.DaimondWeb.open('https://example.org/r', 'A', 'remote');
		assert.equal(r.shown, false);
		assert.equal(r.asker, 'Phone');
		assert.deepEqual(folds, [], 'nothing written into this device\'s record');
		// A turn asked here, for a conversation off screen, is still kept for it.
		await g.DaimondWeb.open('https://example.org/l', 'A', 'local');
		assert.deepEqual(folds, [['A', 'web', { url: 'https://example.org/l' }]]);
	} finally {
		g.DaimondViewer = had.v; g.DaimondPanelRec = had.r; g.DaimondWeb = had.w;
	}
});

test('the turn reaches the Web panel, and a page intent travels to the asker and opens there', () => {
	const rs = src('../../src/wasm/web.rs');
	assert.ok(/fn open\(this: &Driver, url: &str, owner: &str, turn: &str\)/.test(rs), 'the driver is given the turn');
	assert.ok(/pub async fn open\(url: &str, owner: &str, turn: &str\)/.test(rs));
	const tools = src('../../src/tools.rs');
	// Through the Host (U3a, GATE H1): the tool hands the turn to the host's web port, which hands it to the driver.
	assert.ok(/host\(\)\.web\(\)\.open\(&url, &owner, &ctx\.turn_tag\(\)\)/.test(tools), 'web_open passes its turn tag');
	assert.ok(/web::open\(url, owner, turn\)/.test(src('../../src/wasm/host/web.rs')), 'the wasm host passes the turn on');
	assert.ok(/askerOf:\s+askerOf/.test(src('viewer.js')), 'the viewer publishes the routing question');
	const d = src('daimond.js');
	// The runner names the asker and queues nothing (P2.3d: no frame carries an intent).
	const ra = d.slice(d.indexOf('function runnerAsker('), d.indexOf('function runnerDeaf'));
	assert.ok(/return \{ label: deviceLabelFor\(rc\.dispatchedBy\) \}/.test(ra) && !/rc\.ui/.test(d), 'the runner names the asker, no intent queue');
	// The asker derives it from the tool row the log holds (P2.3a5), not off a frame.
	const tl = fs.readFileSync(path.join(HERE, 'page/turnlog.js'), 'utf8');
	const pi = tl.slice(tl.indexOf('function panelIntent'), tl.indexOf('function drawTurn'));
	assert.ok(/m\.name === 'web_open'/.test(pi) && /uiWebUrl\(a\.url\)/.test(pi), 'the asker reads a page intent off the web_open row');
	assert.ok(/panelIntent\(m\)/.test(d.slice(d.indexOf('function onLogRows'), d.indexOf('function openIntent'))), 'for each row the log drew first');
	assert.ok(/if \(u\.web\) return .*DaimondWeb\.open\(u\.web, owner\)/.test(d), 'and opens it through the Web panel');
});

test('the path limit is in bytes, and a record is capped at MAX_REC bytes serialised', () => {
	assert.equal(R.bytes('aé€😀'), 1 + 2 + 3 + 4);
	const st = mapStore();
	const s = R.make(st, clock);
	// 1000 characters, 3000 bytes: under the old character count, over the byte limit.
	const wide = '€'.repeat(1000);
	s.put('A', { doc: { path: wide }, web: { url: 'https://e.org/' + wide } });
	assert.equal(s.get('A').doc, undefined, 'a path over 2048 bytes is not kept');
	assert.equal(s.get('A').web, undefined);
	// Every field at the limit: the record still fits.
	const p = (c) => c.repeat(2000);
	s.put('B', {
		layout: LAYOUT, doc: { path: p('d') }, preview: { path: p('p') },
		web: { url: 'https://e.org/' + p('w') }, shows: ['1', '2', '3', '4'].map((c) => ({ path: p(c) })),
	});
	for (let i = 0; i < 6; i++) s.fold('B', 'file', { path: p(String(i)) });
	const raw = JSON.parse(st.raw.get(R.KEY));
	for (const k of Object.keys(raw)) assert.ok(R.bytes(JSON.stringify(raw[k])) <= R.MAX_REC, k + ' over MAX_REC');
	assert.ok(s.get('B').layout, 'the layout, which is shed last, survives the cut');
	// Shows go oldest first: two at the limit fit beside a layout, the older two do not.
	s.put('C', { layout: LAYOUT });
	for (const c of ['1', '2', '3']) s.fold('C', 'file', { path: p(c) });
	const shows = s.get('C').shows.map((f) => f.path[0]);
	assert.ok(shows.length >= 1 && shows[shows.length - 1] === '3', 'the newest show is kept');
	assert.ok(!shows.includes('1'), 'the oldest is shed');
});

test('a layout is bounded: an overgrown seats table is shed, an overgrown layout dropped', () => {
	const s = R.make(mapStore(), clock);
	const seats = {};
	for (let i = 0; i < 200; i++) seats['p' + i + '|q' + i] = [0.5, 0.5];
	s.put('A', { layout: Object.assign({}, LAYOUT, { seats }) });
	const a = s.get('A').layout;
	assert.ok(a && a.open.doc, 'the panels open are kept');
	assert.equal(a.seats, undefined, 'the seats that would not fit are not');
	const open = {};
	for (let i = 0; i < 300; i++) open['panel' + i] = true;
	s.put('B', { layout: { open, stage: [], dock: [] } });
	assert.equal(s.get('B').layout, undefined, 'a layout that cannot fit is not kept');
});

test('arriving fills only the panels the record holds something for', () => {
	const back = R.arrival({ layout: LAYOUT, doc: { path: 'a.md' } });
	assert.deepEqual(back.filled, ['doc']);
	assert.equal(back.layout.open.preview, false, 'Preview names nothing: closed, not opened empty');
	assert.equal(back.layout.open.web, false, 'Web names nothing (a blob or guide page): closed');
	assert.equal(back.layout.open.term, true, 'the Terminal is the layout\'s');
	assert.equal(LAYOUT.open.web, true, 'the record itself is not changed');
	const full = R.arrival({ layout: LAYOUT, preview: { path: 'b.pdf' }, web: { url: 'https://e.org' } });
	assert.deepEqual(full.filled, ['preview', 'web']);
	assert.equal(full.layout.open.doc, true, 'the Doc keeps its own open hook');
	assert.deepEqual(R.arrival({ layout: LAYOUT, shows: [{ path: 'x.md' }] }).filled, ['doc']);
	assert.equal(R.arrival({ doc: { path: 'a.md' } }), null, 'no layout, nothing to restore');
	const d = src('daimond.js');
	const ac = d.slice(d.indexOf('function arriveConversation'), d.indexOf('function followConversation'));
	assert.ok(/PR\(\)\.arrival\(rec\)/.test(ac), 'arriveConversation restores through arrival');
	assert.ok(!/\['doc', 'preview', 'web'\]/.test(ac), 'no fixed list of filled panels');
});

test('on a Diamond switch the arriving layout owns the Terminal; its handler starts nothing first', () => {
	const d = src('daimond.js');
	const at = d.indexOf('onDiamondChanged: onDiamondChanged,');
	const h = d.slice(d.lastIndexOf('function onDiamondChanged', at), at);
	const tear = h.indexOf('teardown()');
	const defer = h.indexOf('Promise.resolve().then');
	const start = h.indexOf('onOpen()');
	assert.ok(tear !== -1, 'the fenced session still ends at once');
	assert.ok(defer !== -1 && defer < start, 'a restart waits until the switch has put its layout back');
	assert.ok(/!sid && !term\) onOpen\(\)/.test(h), 'and starts only a panel the layout left open and empty');
});
