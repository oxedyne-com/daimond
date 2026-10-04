/* ============================================================
   Test -- THE NOTE WRITER AND WHAT A NOTE CHANGE REACHES (www/js/daimond.js, "The steering notes"),
   round F of 5.3.2 (QA pair 2: Opus A F1, F6; Opus B F2, F3).
   ------------------------------------------------------------
   `daimond.js` is an ES module over the compiled wasm, so it cannot be run here. The REAL `Notes` object, `abortTurn`,
   `stopGeneration`, `rebuildChatApp`, `steerNotes` and `steerStore` are LIFTED from the file's own text and run as
   written, beside the REAL steering.js. Stand-ins: the store (`Wasm.store_read`, `store_write`, `touch_diamond`),
   the Diamonds and the chats, and `bumpDiamonds`.

     1. Stop and a pause act on the app the running turn holds. A note change mid-turn used to set `chat.app = null`
        on every chat whose notes moved, so `stopGeneration` and `abortTurn` (both `if (!c.app) return`) acted on
        nothing and the turn ran to its round cap. The rebuild now waits for the turn to end (`_scopeStale`, as a
        workspace change does), and Stop reads the app the turn was started on (`_runApp`) first.
     2. A Diamond's own thread run as a chat is told that Diamond's notes (`steerFor(model, chat.diamondId)`).
     3. Every note write announces itself (`bumpDiamonds`), so a second tab on the device re-reads the files, and a
        raise or a press asks for them re-read (`list(true)`).
     4. Switch Back closes the review and writes the dismissed switch the cooling rule reads, in ONE file write.

   Run:   node www/js/steernotes.test.mjs
          node www/js/steernotes.test.mjs --break <name>      (each must go red; see KNOWN)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, cases = 0, bad = null;
function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
async function kase(name, fn) {
	cases++; bad = null;
	try { await fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); } else { console.log('  ok   ' + name); }
}

const KNOWN = ['stale', 'runapp', 'diaid', 'bump', 'force', 'back'];
const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', ')); process.exit(2); }

const SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
function lift(marker) {
	const a = SRC.indexOf(marker);
	if (a < 0) { console.log('  (not in daimond.js: ' + marker.trim() + ')'); return ''; }
	const b = SRC.indexOf('\n\t}\n', a);
	return SRC.slice(a, b + 3);
}
function patch(src) {
	function swap(needle, to) {
		const n = src.split(needle).length - 1;
		if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
		src = src.replace(needle, to);
	}
	if (BREAK === 'stale')  swap("if (c._generating) { c._scopeStale = true; return; }\n\t\tc.app = null;", "c.app = null;");
	if (BREAK === 'runapp') swap("var app = c._generating && c._runApp ? c._runApp : c.app;", "var app = c.app;");
	if (BREAK === 'diaid')  swap("if ((c._steer || '') !== self.steerFor(a.model, c.diamondId || '')) rebuildChatApp(c);", "if ((c._steer || '') !== self.steerFor(a.model, '')) rebuildChatApp(c);");
	if (BREAK === 'bump')   swap("bumpDiamonds();\n\t\t\t\treturn all[0];", "return all[0];");
	if (BREAK === 'force')  swap("list: async function (force) {\n\t\t\tawait this.reload(!!force);", "list: async function (force) {\n\t\t\tawait this.reload();");
	if (BREAK === 'back')   swap("return [Object.assign({}, e, { status: 'retired', at: { t: Number(o.at && o.at.t) || 0, n: Number(o.at && o.at.n) || 0 } }),", "return [Object.assign({}, e, { status: 'retired', at: { t: Number(o.at && o.at.t) || 0, n: Number(o.at && o.at.n) || 0 } })]; var unused = [");
	return src;
}

const NOTES = (() => {
	const a = SRC.indexOf('\tvar Notes = {');
	if (a < 0) throw new Error('var Notes not found in daimond.js');
	return SRC.slice(a, SRC.indexOf('\n\t};\n', a) + 5);
})();
const WANT = [lift('\tvar DIAMOND_LOCKS = {};'), NOTES, lift('\tfunction abortTurn(c) {'), lift('\tfunction stopGeneration() {'), lift('\tfunction rebuildChatApp(c) {'),
	lift('\tfunction steerApi(op) {'), lift('\tasync function steerStore(op, a, b) {'), lift('\tasync function steerNotes() {')];
const STEERING = (() => { const win = {}; new Function('window', readFileSync(join(HERE, 'steering.js'), 'utf8'))(win); return win.DaimondSteering; })();

const OPT = 'OPT', D1 = 'D1';
const SEPR = ' \xb7 ';
/// A page: Diamonds D1 and the Optimiser, a store of note files, and the lifted code over them.
function page(o) {
	o = o || {};
	const st = { files: {}, writes: [], touches: [], bumps: 0, stamp: { OPT: 1, D1: 1 }, chats: [], current: null, trail: [], listArgs: [] };
	Object.keys(o.files || {}).forEach((k) => { st.files[k] = o.files[k]; });
	const wasm = {
		async store_read(path) { if (!(path in st.files)) throw new Error('no such file'); return st.files[path]; },
		async store_write(path, text) { st.files[path] = text; st.writes.push([path, text]); },
		async touch_diamond(id) { st.stamp[id] = (st.stamp[id] || 0) + 1; st.touches.push(id); },
	};
	const win = { DaimondSteering: STEERING };
	const src =
		'var window = ctx.window, DaimondSteering = window.DaimondSteering, Wasm = ctx.wasm, st = ctx.st;\n' +
		"var DEFAULT_IDS = { 'Daimond Optimiser': 'OPT' };\n" +
		'var chats = st.chats, current = null, _sharedClients = new WeakSet(), _diamondApps = {};\n' +
		'var diamonds = [{ id: "OPT", get touched() { return st.stamp.OPT; } }, { id: "D1", get touched() { return st.stamp.D1; } }];\n' +
		'var Workers = { cancelAwaits: function () {} };\n' +
		'function trail(a, b) { st.trail.push(a + ": " + b); }\n' +
		'function bumpDiamonds() { st.bumps++; }\n' +
		'function appCfgFor(c) { return { model: c.model || "m1" }; }\n' +
		'function diamondModel(id) { return { provider: "p", model: "m1" }; }\n' +
		'function diamondAppKey(a) { return a.model; }\n' +
		'function setCurrent(c) { current = c; }\n' +
		'var STEER_API = { read: ["DaimondNotes", "list"], back: ["DaimondNotes", "back"] };\n' +
		patch(WANT.join('\n')) + '\n' +
		'window.DaimondNotes = Notes;\n' +
		'return { Notes: Notes, stopGeneration: stopGeneration, abortTurn: abortTurn, setCurrent: setCurrent, steerNotes: steerNotes, rebuildChatApp: typeof rebuildChatApp === "function" ? rebuildChatApp : null };';
	// eslint-disable-next-line no-new-func
	const api = new Function('ctx', src)({ window: win, wasm, st });
	return Object.assign({ st, win }, api);
}

const hdr = (id, status, lvl, cm, tag, t, n, extra) => '## ' + [id, status, lvl, cm, tag + ' ' + t + ' of ' + n].concat(extra || []).join(SEPR);
const FILEPATH = (id) => 'diamonds/' + id + '/.daimond/steering.md';
const ACC = hdr('n-acc', 'active', 'account', 'all', 'long', 1, 2) + '\nKeep answers brief.\n';
const D1NOTE = hdr('n-d1', 'active', 'diamond', 'm1', 'wrong', 1, 2) + '\nCheck every claim.\n';
const app = () => { const a = { aborted: 0, tagged: [], abort() { a.aborted++; }, abort_turn(tag) { a.tagged.push(tag); return true; } }; return a; };
const tick = () => new Promise((r) => setImmediate(r));

// ── 1. Stop and a pause act on the app the running turn holds ──────────────
await kase('Opus A F1: a note change mid-turn leaves the running chat its app, and Stop reaches the turn', async () => {
	const p = page({ files: {} });
	const a = app(), chat = { id: 'c1', model: 'm1', app: a, _generating: true, _turnTag: 't-1', _steer: '' };
	p.st.chats.push(chat); p.setCurrent(chat);
	p.Notes.by[OPT] = { stamp: 1, entries: p.win.DaimondSteering.parse(ACC, OPT, true).entries };
	p.Notes.changed();
	ok(chat.app === a, 'the chat keeps the app its turn runs on');
	ok(chat._scopeStale === true, 'and the rebuild is held for the turn\'s end');
	p.stopGeneration();
	eq(a.tagged, ['t-1'], 'Stop named the turn on that app');
});

await kase('Opus A F1: a chat whose app was dropped mid-turn is still stopped, and still paused, through the app its turn holds', async () => {
	const p = page();
	const a = app(), chat = { id: 'c1', model: 'm1', app: null, _runApp: a, _generating: true, _turnTag: 't-2' };
	p.st.chats.push(chat); p.setCurrent(chat);
	p.stopGeneration();
	eq(a.tagged, ['t-2'], 'Stop');
	const b = app(), paused = { id: 'c2', model: 'm1', app: null, _runApp: b, _generating: true, _turnTag: 't-3' };
	p.abortTurn(paused);
	eq(b.tagged, ['t-3'], 'a pause (abortTurn) reaches it too');
	const idle = { id: 'c3', model: 'm1', app: a, _runApp: b, _generating: false, _turnTag: 't-4' };
	p.abortTurn(idle);
	eq(b.tagged, ['t-3'], 'a turn that is over leaves its old app alone');
	eq(a.tagged, ['t-2', 't-4'], 'and a chat that is not running uses its own app');
});

await kase('a chat that is not mid-turn is rebuilt at once, as before', async () => {
	const p = page();
	const a = app(), chat = { id: 'c1', model: 'm1', app: a, _generating: false, _steer: '' };
	p.st.chats.push(chat);
	p.Notes.by[OPT] = { stamp: 1, entries: p.win.DaimondSteering.parse(ACC, OPT, true).entries };
	p.Notes.changed();
	eq(chat.app, null, 'dropped');
	ok(!chat._scopeStale, 'and no mark held');
});

await kase('a daimon\'s record, on the Diamond\'s shared client, is not dropped from under its turn', async () => {
	const p = page();
	const shared = app(), rec = { id: 'r1', model: 'm1', app: shared, _generating: true, _turnTag: 'dt-1', diamondId: D1 };
	p.st.chats.push(rec);
	p.Notes.by[D1] = { stamp: 1, entries: p.win.DaimondSteering.parse(D1NOTE, D1, false).entries };
	p.Notes.by[OPT] = { stamp: 1, entries: p.win.DaimondSteering.parse(ACC, OPT, true).entries };
	p.Notes.changed();
	ok(rec.app === shared, 'still on the client');
});

await kase('Opus A F1: no setting or key drops every chat\'s app at once under a running turn; the bulk sites go through rebuildChatApp', async () => {
	eq(SRC.split('chats.forEach(function (c) { c.app = null; });').length - 1, 0, 'bulk drops of chat.app left in daimond.js');
	eq(SRC.split('chats.forEach(rebuildChatApp);').length - 1, 9, 'sites through the one door');
});

// ── 2. A Diamond's own thread run as a chat is told that Diamond's notes ─────
await kase('Opus A F6: a chat that carries a Diamond is compared against that Diamond\'s notes, not the account\'s alone', async () => {
	const p = page();
	p.Notes.by[D1] = { stamp: 1, entries: p.win.DaimondSteering.parse(D1NOTE, D1, false).entries };
	const told = p.Notes.steerFor('m1', D1);
	ok(told.indexOf('Check every claim.') >= 0, 'precondition: the Diamond\'s note is told to its thread');
	const a = app(), chat = { id: 'c9', model: 'm1', app: a, _generating: false, diamondId: D1, _steer: told };
	p.st.chats.push(chat);
	p.Notes.changed();
	ok(chat.app === a, 'built with the Diamond\'s notes, so a change that moves nothing for it drops nothing');
	p.Notes.by[D1] = { stamp: 2, entries: [] };
	p.Notes.changed();
	eq(chat.app, null, 'and a change to the Diamond\'s own notes does');
});

await kase('Opus A F6: ensureApp composes a chat\'s prompt with the notes of the Diamond the chat carries, as Notes.changed compares them', async () => {
	eq(SRC.split("Notes.steerFor(a.model, chat.diamondId || '')").length - 1, 1, 'ensureApp tells the chat its Diamond\'s notes');
	eq(SRC.split("Notes.steerFor(a.model, '')").length - 1, 0, 'and nowhere composes a chat with the account\'s alone');
});

// ── 3. Two tabs ────────────────────────────────────────────────────────────
await kase('Opus B F2: every note write announces itself (bumpDiamonds), so another tab re-reads the files', async () => {
	const p = page({ files: { [FILEPATH(D1)]: '', [FILEPATH(OPT)]: '' } });
	await p.Notes.add({ level: 2, scope: D1, cm: 'm1', tag: 'long', line: 'Keep answers brief.', at: { t: 1, n: 2 } });
	eq(p.st.bumps, 1, 'an Add');
	const e = (await p.Notes.list())[0];
	await p.Notes.keep({ level: 2, scope: D1, id: e.id }, 25);
	eq(p.st.bumps, 2, 'a Keep');
	await p.Notes.retire({ level: 2, scope: D1, id: e.id }, { t: 1, n: 30 });
	eq(p.st.bumps, 3, 'a Remove');
	await p.Notes.dismiss({ level: 2, scope: D1, cm: 'm1', tag: 'wrong', at: { t: 1, n: 30 } });
	eq(p.st.bumps, 4, 'a Dismiss');
	await p.Notes.switched({ scope: D1, cm: 'm1', to: 'm2', at: { n: 3 }, was: { provider: 'p', model: 'm1' } });
	eq(p.st.bumps, 5, 'a Switch');
	await p.Notes.keep({ level: 2, scope: D1, id: 'n-nothing' }, 1);
	eq(p.st.bumps, 5, 'a press that wrote nothing announces nothing');
	await p.Notes.unite(D1, '');
	eq(p.st.bumps, 5, 'and a join that wrote nothing');
});

await kase('Opus B F2: a raise or a press asks for the files re-read, which sees a write whose stamp this tab did not take', async () => {
	const p = page({ files: { [FILEPATH(D1)]: D1NOTE, [FILEPATH(OPT)]: '' } });
	eq((await p.Notes.list()).map((e) => e.id), ['n-d1'], 'read once');
	p.st.files[FILEPATH(D1)] = D1NOTE.replace('· active ·', '· retired ·');
	eq((await p.Notes.list()).map((e) => e.status), ['active'], 'the stamp did not move, so an ordinary list trusts its cache (the stale tab)');
	eq((await p.Notes.list(true)).map((e) => e.status), ['retired'], 'a forced list reads the file');
	p.st.files[FILEPATH(D1)] = D1NOTE;
	let asked = null;
	p.win.DaimondNotes = { list: async (force) => { asked = force; return []; } };
	await p.steerNotes();
	eq(asked, true, 'steerNotes (every raise and every press) asks for a forced read');
});

// ── 4. Switch Back ─────────────────────────────────────────────────────────
await kase('Opus B F3: Switch Back closes the review and writes the dismissed switch the cooling rule reads, in one write', async () => {
	const sw = hdr('n-sw', 'switched', 'diamond', 'm1', 'switch', 0, 36, ['to m2', 'was p/m1']) + '\n\n';
	const p = page({ files: { [FILEPATH(D1)]: sw, [FILEPATH(OPT)]: '' } });
	const r = await p.Notes.back({ level: 2, scope: D1, id: 'n-sw' }, { at: { t: 0, n: 52 }, cm: 'm1', to: 'm2', n: 14 });
	ok(r && r.id === 'n-sw' && r.status === 'retired', 'answers the closed entry');
	eq(p.st.writes.length, 1, 'one file write');
	const es = STEERING.parse(p.st.files[FILEPATH(D1)], D1, false).entries;
	eq(es.map((e) => e.status).sort(), ['dismissed', 'retired']);
	const dis = es.find((e) => e.status === 'dismissed');
	eq([dis.tag, dis.level, dis.scope, dis.cm, dis.to, dis.at], ['switch', 2, D1, 'm1', 'm2', { t: 0, n: 14 }], 'cm the model returned to, to the model tried, at.n the returned-to model\'s count');
	eq(es.find((e) => e.status === 'retired').at, { t: 0, n: 52 });
	eq(p.st.bumps, 1);
	const none = await p.Notes.back({ level: 2, scope: D1, id: 'n-gone' }, { at: { t: 0, n: 1 }, cm: 'm1', to: 'm2', n: 1 });
	eq(none, null, 'a switch the file no longer holds writes nothing');
	eq(p.st.writes.length, 1);
});

console.log('\n' + cases + ' cases, ' + failures + ' failed');
if (BREAK) {
	if (failures > 0) { console.log('EXPECTED: ' + failures + ' failure(s) under --break ' + BREAK + '. The guard works.'); process.exit(0); }
	console.log('BUG: --break ' + BREAK + ' changed nothing; the test does not prove the code.'); process.exit(1);
}
process.exit(failures ? 1 : 0);
