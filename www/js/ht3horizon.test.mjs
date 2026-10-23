/* ============================================================
   Test -- a runner says "cannot" only at the asker's horizon
   (HT3, design daimond_handoff_truth_design_20261023 §3; DIAG_BUSY3).
   ------------------------------------------------------------
   THE BUG. A runner judged a handed-off turn's models once, before any
   wait, from its own replica. A provider row or sealed key that had not
   arrived yet read exactly as one that never could ("no usable api key"),
   cause `models`, and the phone ran the turn itself.

   THE FIX. The errand names the stamp of every synced provider it reads
   (`at`); the runner judges inside `peerReady`'s wait, to the same
   deadline, on `DaimondModels.judgeAt` (pure on the stamps held and
   `keyState`): `can`, `never` (refused at once, `models`) or `behind`
   (refused at the deadline, `models-behind`).

     H1  a named row arriving at +4 s: claimed, not refused;
     H2  a key `opening` that opens at +3 s: claimed;
     H3  the row tombstoned at the stamp: `models` within 1 s;
     H4  the key `failed` here: `models`, no wait;
     H5  the app locked: `models`, no wait;
     H6  the row still below its stamp at the deadline: `models-behind`;
     H7  a Daimond credits turn: claimed with no wait, `credits` unnamed;
     H8  a half with an empty provider is never sent;
     H9  an errand without `at` (older asker): today's verdict, at once;
     H10 a catalogue refresh does not bump `touched`;
     H11 each `keyState` transition is logged with its time (L8).

   The REAL models.js and the lifted daimond.js functions, two devices.
   Red proof:  MM_SRC_REV=cfeb63029 node www/js/ht3horizon.test.mjs
   Breaks:     node www/js/ht3horizon.test.mjs --break <name>, names below.
   ============================================================ */
import { source, liftFn } from './testlift.mjs';
import vm from 'node:vm';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : null; })();
// Each break undoes one part of the fix; the arm it names goes red.
const BREAKS = {
	noat:     ['d', 'out.at = at;', ''],																	// H1 H2 H6
	prewait:  ['m', "if (!behind && (!past || h.key !== 'opened')) { behind = line; behind.verdict = 'behind'; }",
		"if (!past || h.key !== 'opened') { line.verdict = 'never'; return line; }"],						// H1 H2 H6
	tomb:     ['m', '|| (h.touched === null && h.tomb > 0 && h.tomb >= named)', ''],							// H3
	failwait: ['m', "|| (past && (!h.keyed || h.key === 'none' || h.key === 'failed'))) {",
		"|| (past && (!h.keyed || h.key === 'none'))) {"],													// H4
	lockwait: ['m', "if (!unlocked()) return 'locked';", "if (!unlocked()) return 'opening';"],				// H5
	credits:  ['m', "if (!id || id === CREDITS || !p) return null;", "if (!id) return null; if (!p) return 0;"],	// H7
	emptyprov:['d', "if (m && !p && M && M.getDefault) p = M.getDefault().provider || '';", '',
		"return (m && p) ? { provider: p, model: m } : { provider: '', model: '' };", 'return { provider: p, model: m };'],	// H8
	oldask:   ['d', "if (!at) {\n", "if (!at) { return { verdict: 'behind', why: 'x', line: '' };\n"],			// H9
	catalog:  ['m', "p.fetched = Date.now();\n", 'p.fetched = Date.now();\n\t\ttouch(id);\n'],				// H10
	keylog:   ['m', "diag('models key', 'provider=' + id + ' ' + k.state + '->'", "(function () {})('models key', 'provider=' + id + ' ' + k.state + '->'"],	// H11
};

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

let SRC  = source('daimond.js');
let MODS = source('models.js');
const STORE = source('store.js');
const STAMP = source('stamp.js');
if (BREAK) {
	const b = BREAKS[BREAK];
	if (!b) { console.log('no such break: ' + BREAK); process.exit(2); }
	for (let i = 1; i < b.length; i += 2) {
		const which = b[0] === 'd' ? SRC : MODS;
		if (!which.includes(b[i])) { console.log('the break text moved: ' + BREAK); process.exit(2); }
		if (b[0] === 'd') SRC = SRC.replace(b[i], b[i + 1]); else MODS = MODS.replace(b[i], b[i + 1]);
	}
}

const FNS = ['readJson', 'diamondModels', 'diamondModel', 'modelPicksOf', 'diamondPicks', 'chatPicks',
	'summarisingPick', 'diamondWorkerModel', 'diamondVisionModel', 'turnModelOf', 'chatWorkerModel',
	'turnModelsOfDiamond', 'turnModelsOfChat', 'errandModelOf', 'sentModelsOf', 'diamondCanRun',
	'errandUnrunnable', 'modelsAt', 'peerReady', 'askerReadiness', 'lackedNote', 'withinDeadline'];
const have = FNS.filter((f) => liftFn(SRC, f));
const missing = FNS.filter((f) => !have.includes(f));
const BODY = 'var DIAMOND_MODELS_KEY = "daimond-diamond-models"; var readyBy = new WeakMap();\n'
	+ have.map((f) => liftFn(SRC, f)).join('\n');
const WAIT = 10000;						// THROUGH_WAIT_MS, the real deadline

/// One device: a vm realm with its own storage, identity, models.js and the lifted functions.
async function device(name, keys, def) {
	const store = new Map();
	const id = { unlocked: true, fail: new Set(), gates: {} };
	const diags = [];
	const ctx = vm.createContext({
		console: console, crypto: globalThis.crypto, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
		setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
		atob: atob, btoa: btoa,
		localStorage: {
			getItem:    (k) => (store.has(k) ? store.get(k) : null),
			setItem:    (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
		},
		document: { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' },
		fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }, { id: 'm2' }] }) }),
	});
	vm.runInContext('var window = globalThis; window.addEventListener = function () {}; window.dispatchEvent = function () { return true; };'
		+ 'var tombMap = {}; window.DaimondCore = { tombs: function () { return Object.assign({}, tombMap); },'
		+ ' tombstone: function (k, id, at) { tombMap[id] = at || Date.now(); },'
		+ ' mergeTombs: function (k, inc) { Object.keys(inc || {}).forEach(function (i) { if (!(tombMap[i] >= inc[i])) tombMap[i] = inc[i]; }); return Object.assign({}, tombMap); } };', ctx);
	ctx.DaimondIdentity = {
		isUnlocked: () => id.unlocked,
		wrap:   async (s) => 'enc:' + s,
		unwrap: (enc) => id.fail.has(enc) ? Promise.reject(new Error('not this identity'))
			: id.gates[enc] ? id.gates[enc].promise : Promise.resolve(String(enc).slice(4)),
	};
	ctx.DaimondDiag = { log: (a, b) => diags.push({ t: Date.now(), line: a + ' ' + (b || '') }) };
	for (const s of [STORE, STAMP]) vm.runInContext('(function (window, localStorage) {' + s + '\n})(window, localStorage);', ctx);
	vm.runInContext('var DaimondStamp = window.DaimondStamp, DaimondStore = window.DaimondStore;', ctx);
	vm.runInContext(MODS, ctx);
	const M = ctx.DaimondModels;
	M.init({});
	for (const k of keys) {
		M.addProvider(k, { url: 'https://' + k.replace(/\W/g, '') + '.example/v1', name: k });
		await M.setKey(k, k + '-key');
	}
	M.setDefault(def.provider, def.model);
	const U = new Proxy(function () {}, {
		get: (t, k) => (k === 'then' || k === Symbol.unscopables) ? undefined : k === Symbol.toPrimitive ? () => '' : U,
		apply: () => U, construct: () => U,
	});
	const own = {
		diags: diags, chats: [], diamonds: [], THROUGH_WAIT_MS: WAIT, cfg: {},
		diag: (a, b) => diags.push({ t: Date.now(), line: a + ' ' + (b || '') }),
		DaimondPeer: { threadReadiness: () => ({ ready: true, have: 0, want: 0, lack: 0 }) },
		syncHeld: () => 0,
		diamondCanRun: () => true,
		onChatsChangedElsewhere: async () => {},
	};
	const inner = vm.runInContext('globalThis', ctx);
	const scope = new Proxy(own, {
		has: (t, k) => typeof k === 'string' && (k in t || !(k in inner)),
		get: (t, k) => k === Symbol.unscopables ? undefined : (k in t ? t[k] : U),
		set: (t, k, v) => { t[k] = v; return true; },
	});
	const api = vm.runInContext('(function (scope) { with (scope) { return (function () {\n' + BODY + `
		var lifted = { ` + have.map((f) => f + ': ' + f).join(', ') + ` };
		return function (n) { return lifted[n] || null; };
	})(); } })`, ctx)(scope);
	return { name, M, id, own, diags, fn: api };
}

function gate(dev, enc) {
	let open, fail;
	const promise = new Promise((a, b) => { open = a; fail = b; });
	dev.id.gates[enc] = { promise, open, fail };
	return dev.id.gates[enc];
}

const CHAT = () => ({ id: 'c1', name: 'Chat', model: '', provider: '', messages: [] });
const A = { provider: 'custom:a', model: 'm' };
const R = { provider: 'custom:r', model: 'm' };

/// An asker holding provider A and a runner holding only its own R.
async function pair() {
	const asker  = await device('asker',  [A.provider], A);
	const runner = await device('runner', [R.provider], R);
	return { asker, runner };
}

function errandOf(asker, chat) {
	return { chatId: 'c1', turnId: 't1', model: JSON.parse(JSON.stringify(asker.fn('errandModelOf')(chat || CHAT()))) };
}

/// `peerReady` on the runner, timed: `{ rd, ms }`.
async function ready(runner, errand) {
	const t0 = Date.now();
	let rd;
	try { rd = await runner.fn('peerReady')(errand, false, WAIT); }
	catch (e) { rd = { ok: false, cause: 'threw', why: String(e && e.message || e) }; }
	return { rd, ms: Date.now() - t0 };
}
const say = (x) => (x.rd.ok ? 'claimed' : 'refused ' + x.rd.cause) + ' after ' + x.ms + 'ms';

async function main() {
	console.log('ht3horizon: "cannot" only at the asker\'s horizon (real models.js' + (BREAK ? ', --break ' + BREAK : '') + ')');
	if (missing.length) console.log('  (this revision lacks: ' + missing.join(', ') + ')');

	// H1: the row arrives at +4 s.
	{
		const { asker, runner } = await pair();
		const e = errandOf(asker);
		check('H1 the errand names the asker\'s stamp for its provider',
			!!(e.model.at && e.model.at[A.provider] > 0), JSON.stringify(e.model.at || null));
		setTimeout(() => { runner.M.applySync(asker.M.exportSync()); }, 4000);
		const x = await ready(runner, e);
		check('H1 a named row arriving at +4 s: claimed, not refused', x.rd.ok === true && x.ms >= 3900, say(x));
	}
	// H2: row here, its key opening; opens at +3 s.
	{
		const { asker, runner } = await pair();
		const g = gate(runner, 'enc:' + A.provider + '-key');
		const merged = runner.M.applySync(asker.M.exportSync());
		await new Promise((r) => setTimeout(r, 50));
		const ks = runner.M.keyState(A.provider);
		check('H2 a merged key not yet unwrapped reads opening', ks === 'opening', ks);
		setTimeout(() => g.open(A.provider + '-key'), 3000);
		const x = await ready(runner, errandOf(asker));
		await merged;
		check('H2 a key opening that opens at +3 s: claimed', x.rd.ok === true && x.ms >= 2900, say(x));
		const t = runner.diags.filter((d) => /^models key provider=custom:a /.test(d.line)).map((d) => d.line);
		check('H11 each keyState transition is logged with its time',
			t.some((l) => /none->opening at=\d+/.test(l)) && t.some((l) => /opening->opened at=\d+ took=\d+ms/.test(l)), t.join(' | '));
		const v = runner.diags.find((d) => /^ready models-can /.test(d.line));
		check('H11 the verdict line names provider/model, the named and held stamps and the key',
			!!v && /model=custom:a\/m pid=custom:a named=\d+ held=\d+ key=opened/.test(v.line), v ? v.line : 'none');
	}
	// H3: the runner holds the row tombstoned at or past the named stamp.
	{
		const { asker, runner } = await pair();
		const e = errandOf(asker);
		await runner.M.applySync(asker.M.exportSync());
		runner.M.removeProvider(A.provider);
		const x = await ready(runner, e);
		check('H3 the row tombstoned at the stamp: models within 1 s', x.rd.ok === false && x.rd.cause === 'models' && x.ms < 1000, say(x));
	}
	// H4: the key does not open here.
	{
		const { asker, runner } = await pair();
		runner.id.fail.add('enc:' + A.provider + '-key');
		await runner.M.applySync(asker.M.exportSync());
		const ks = runner.M.keyState(A.provider);
		check('H4 a seal that does not open here reads failed', ks === 'failed', ks);
		const x = await ready(runner, errandOf(asker));
		check('H4 key failed: models with no wait', x.rd.ok === false && x.rd.cause === 'models' && x.ms < 600, say(x));
	}
	// H5: the app is locked.
	{
		const { asker, runner } = await pair();
		await runner.M.applySync(asker.M.exportSync());
		runner.id.unlocked = false;
		runner.M.lock();
		const ks = runner.M.keyState(A.provider);
		check('H5 a sealed key on a locked app reads locked', ks === 'locked', ks);
		const x = await ready(runner, errandOf(asker));
		check('H5 app locked: models with no wait', x.rd.ok === false && x.rd.cause === 'models' && x.ms < 600, say(x));
	}
	// H6: nothing arrives before the deadline.
	{
		const { asker, runner } = await pair();
		const x = await ready(runner, errandOf(asker));
		check('H6 row below its stamp at the deadline: models-behind', x.rd.ok === false && x.rd.cause === 'models-behind'
			&& x.ms >= WAIT - 100, say(x));
		const v = runner.diags.find((d) => /^ready MODELS-BEHIND /.test(d.line));
		check('H6 the verdict line names the held stamp as none', !!v && /named=\d+ held=none key=none/.test(v.line), v ? v.line : 'none');
	}
	// H7: a turn on Daimond credits.
	{
		const { asker, runner } = await pair();
		const C = { provider: 'credits', model: 'daimond/fast' };
		asker.M.effective = () => ({ provider: C.provider, model: C.model, from: 'def' });
		const real = runner.M.resolve;
		runner.M.resolve = (p, m) => (p === 'credits' ? { provider: p, model: m, apiKey: 'minted' } : real(p, m));
		const e = errandOf(asker);
		check('H7 credits is never named in the horizon', !(e.model.at && 'credits' in e.model.at), JSON.stringify(e.model.at || null));
		const x = await ready(runner, e);
		check('H7 a Daimond credits turn: claimed with no wait', x.rd.ok === true && x.ms < 600, say(x));
	}
	// H8: a half whose provider is empty.
	{
		const { asker } = await pair();
		// A pick that names no provider and does not resolve here as it stands (its key still
		// opening, say): `chatWorkerModel` passes it on as it found it, provider ''.
		const eff = asker.M.effective, res = asker.M.resolve;
		asker.M.effective = (who, slot) => (slot === 'workers' || slot === 'images')
			? { provider: '', model: 'w', from: 'own' } : eff(who, slot);
		asker.M.resolve = (p, m) => (!p && m === 'w' ? null : res(p, m));
		const chat = Object.assign(CHAT(), { workerProvider: '', workerModel: 'w' });
		const m = errandOf(asker, chat).model;
		const halves = [m, m.workers, m.images].filter((h) => h && h.model);
		check('H8 a half with an empty provider is never sent', halves.every((h) => !!h.provider),
			halves.map((h) => (h.provider || '(empty)') + '/' + h.model).join(' '));
	}
	// H9: an older asker's errand, no `at`.
	{
		const { asker, runner } = await pair();
		const e = errandOf(asker);
		delete e.model.at;
		const x = await ready(runner, e);
		check('H9 an errand without at: today\'s verdict (models, at once)', x.rd.ok === false && x.rd.cause === 'models' && x.ms < 600, say(x));
	}
	// H10: a catalogue refresh.
	{
		const { asker } = await pair();
		const before = asker.M.stampAt ? asker.M.stampAt(A.provider) : JSON.parse(JSON.stringify(asker.M.exportSync())).providers[A.provider].touched;
		await new Promise((r) => setTimeout(r, 5));
		await asker.M.fetchModels(A.provider);
		const after = asker.M.exportSync().providers[A.provider];
		check('H10 a catalogue refresh does not bump touched', after.touched === before && after.models.includes('m2'),
			'touched ' + before + ' -> ' + after.touched);
	}

	console.log(failures ? '\n' + failures + ' of ' + checks + ' FAILED' : '\nall ' + checks + ' passed');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(1); });
