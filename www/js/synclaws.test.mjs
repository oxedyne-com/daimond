/* ============================================================
   Test — every synced register is a law: the same answer whichever
   order two devices' records arrive in (the D-28 state review, A3).
   ------------------------------------------------------------
   THE BUG. Each register kept the side with the later stamp and, at an
   EQUAL stamp, kept whatever it held (or took whatever arrived). Two
   devices meeting at a tie then kept different values for ever and pushed
   at each other: the permission rung, debug-share, graph positions, chats,
   provider rows, mailboxes, a group's state, the chunk-index preview.
   Measured in the review over 300 generated triples each, with stamps
   drawn from three values so ties are common: 7 kinds failed only at ties
   and several more with distinct stamps too.

   THE FIX. One rule, `DaimondStamp.beats` (www/js/stamp.js): the later
   stamp wins, and an equal stamp goes to the canonically greater value,
   or for a safety register to the stricter one (the rung, a scope
   withheld, debug-share off). Plus the per-kind faults the laws found:
   a trash record's kind travels with its stamp (BM-5); a graph position
   takes a later stamp at the same place (BM-1); a mailbox password is a
   register of its own (`passAt`, BM-2); the post record's notes and
   deletion stamps merge by value.

   WHAT IS CHECKED. Each kind's REAL merge, reached through the harness
   in dev/syncprobe.mjs (a classic script run from its own file; a
   daimond.js closure lifted out of the file's own text): idempotent,
   commutative, associative and fixed point, on 300 triples with tied
   stamps and 300 with distinct ones. A kind that holds another lane's
   part still says so in its name:
     - chats: transcript rewrites other than prefix growth (BM-9, the
       transcript's own root);
     - models: the default and draft (SIM-18, another lane), a provider
       row with no key (an empty key is "no statement" and needs a key
       stamp of its own), and tombstones against the model list's own
       stamp;
     - mail: `sel`, the selected mailbox, a per-device choice that rides
       the parcel (SCOPE-1);
     - the chunk index: the preview arm only (its files arm is three-way
       by design; its peer slots are REF-3's).
   A7 is here too: an older post record is upgraded and merged.

   Run:  node www/js/synclaws.test.mjs [--tree <checkout>]
   ============================================================ */
import { makeWindow, loadScript, sliceDaimond, checkKind } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const NOW = 1_000_000_000;
let DISTINCT = false;
const T = (r) => NOW - 1000 * (1 + r.int(DISTINCT ? 1000000 : 3));
const clone = (x) => JSON.parse(JSON.stringify(x));

function win() {
	const w = makeWindow({ now: NOW });
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s, deviceId: () => 'selfdev' };
	return w;
}
function core(names) {
	const w = win();
	return sliceDaimond(w, names, {
		ChatStore: { putTombs: () => Promise.resolve(true), stored: () => [] },
		storageAlarm: () => {}, renderSeatLine: () => {}, tOr: (k, f) => f, t: (k) => k,
		deviceId: () => 'ffffffffffffffff', nudgeSync: () => {},
	}).fns;
}
function tombCore(w) {
	const c = sliceDaimond(w, ['mergeTombMap', 'loadTombMap'], {
		ChatStore: { putTombs: () => Promise.resolve(true) }, storageAlarm: () => {}, tOr: (k, f) => f }).fns;
	w.DaimondCore = { mergeTombs: c.mergeTombMap, loadTombMap: c.loadTombMap, tombs: c.loadTombMap };
}

const chatGen = (r) => {
	const pool = [
		{ mid: 'm1', role: 'user', content: 'hi', ts: 1 },
		{ mid: 'm2', role: 'assistant', content: 'hel', ts: 2 },
		{ mid: 'm2', role: 'assistant', content: 'hello', ts: 2 },			// prefix growth
		{ mid: 'm3', role: 'user', content: 'again', ts: 3, interrupted: true },
		{ mid: 'm3', role: 'user', content: 'again', ts: 3 },
	];
	const msgs = [], seen = {};
	for (const m of pool) if (r.chance(0.4) && !seen[m.mid]) { seen[m.mid] = 1; msgs.push(clone(m)); }
	const c = { id: 'c1', name: r.pick(['Alpha', 'Beta']), model: r.pick(['m1', 'm2']), provider: 'p',
		status: r.pick(['active', 'active', 'archived']), messages: msgs, updatedAt: T(r),
		promptTokens: r.pick([0, 5, 9]), holds: [] };
	if (!r.chance(0.3)) c.metaAt = T(r);
	return c;
};

const KINDS = [
	{
		name: 'chats: mergeChatRecords (prefix growth only; BM-9 held)',
		gen: chatGen,
		join: (...xs) => {
			const f = core(['mergeChatRecords']);
			let acc = null;
			for (const x of xs) acc = acc ? f.mergeChatRecords(clone(x), acc, { mtombs: {} }) : f.mergeChatRecords(clone(x), clone(x), { mtombs: {} });
			return acc;
		},
	},
	{
		name: 'permission policy: adoptPolicy',
		gen: (r) => ({ v: 1, mode: r.pick(['ask', 'guarded', 'bypass']), mode_at: T(r), scopes: { reading: { at: T(r), on: r.int(2) } } }),
		join: (...xs) => {
			const w = win(); loadScript(w, 'handmode.js');
			try { w.DaimondHandMode.init({ apply: () => {} }); } catch (e) { /* the DOM half */ }
			for (const x of xs) w.DaimondHandMode.adoptPolicy(clone(x));
			return w.DaimondHandMode.snapshotPolicy();
		},
	},
	{
		name: 'debug-share: adoptSync',
		gen: (r) => ({ on: r.chance(0.5), at: T(r) }),
		join: (...xs) => { const w = win(); loadScript(w, 'debugshare.js'); for (const x of xs) w.DEBUG_SHARE.adoptSync(clone(x)); return w.DEBUG_SHARE.syncSnapshot(); },
	},
	{
		name: 'graph layout: adopt',
		gen: (r) => { const pos = {}; for (const id of ['d1', 'd2']) if (r.chance(0.6)) pos[id] = { x: r.int(3), y: r.int(3), t: T(r) }; return { v: 1, pos }; },
		join: (...xs) => { const w = win(); loadScript(w, 'graph.js'); for (const x of xs) w.DaimondGraph.adopt(clone(x)); return w.DaimondGraph.snapshot(); },
	},
	{
		name: 'trash: adopt',
		gen: (r) => { const items = {}; for (const id of ['c1', 'd1']) if (r.chance(0.6)) items[id] = { k: r.pick(['c', 'd']), at: T(r), back: r.chance(0.5) ? T(r) : 0, a: r.int(2), r: r.pick([30, 60]) }; return { v: 1, items }; },
		join: (...xs) => { const w = win(); loadScript(w, 'trash.js'); for (const x of xs) w.DaimondTrash.adopt(clone(x)); return w.DaimondTrash.snapshot(); },
	},
	{
		name: 'post record: adopt',
		gen: (r) => {
			const msgs = {}, groups = {}, notes = {};
			for (const a of ['m1', 'm2']) if (r.chance(0.6)) msgs[a] = { addr: a, ts: 1, read: r.int(2), tray: r.int(2), hidden: r.int(2), del: r.pick([0, 0, T(r)]) };
			if (r.chance(0.6)) groups.g1 = { gid: 'g1', at: T(r), addr: r.pick(['x', 'y']), members: [r.pick(['p', 'q'])], name: 'G', state: r.pick(['invited', 'joined', 'left']), stateAt: T(r) };
			if (r.chance(0.4)) notes.n1 = { text: r.pick(['a', 'b']) };
			return { v: 5, through: r.int(3), acked: r.int(3), msgs, notes, groups, shares: {}, feed: { since: 0, read: {}, new: {} } };
		},
		join: async (...xs) => {
			const w = win(); loadScript(w, 'post.js');
			await w.DaimondPost.read();
			for (const x of xs) w.DaimondPost.adopt(clone(x));
			return w.DaimondPost.snapshot();
		},
	},
	{
		name: 'providers and models: applySync (default, keyless rows and tombs held)',
		gen: (r) => {
			const providers = {};
			for (const id of ['openai', 'groq']) if (r.chance(0.6)) providers[id] = { name: id, url: 'https://' + id, models: [r.pick(['a', 'b'])],
				fetched: T(r), touched: T(r), keyEnc: r.pick(['kA', 'kB', 'kC']) };
			return { v: 2, def: { provider: '', model: '' }, defAt: 0, draft: { provider: '', model: '' }, draftAt: 0, providers, tombs: {} };
		},
		join: async (...xs) => {
			const w = win(); tombCore(w); loadScript(w, 'models.js');
			for (const x of xs) await w.DaimondModels.applySync(clone(x));
			return w.DaimondModels.exportSync();
		},
	},
	{
		name: 'mail accounts: applySync (sel held: SCOPE-1)',
		gen: (r) => {
			const accounts = [];
			for (const a of ['a@x', 'b@x']) if (r.chance(0.6)) accounts.push({ address: a, host: r.pick(['h1', 'h2']), port: 993, smtpHost: 's', smtpPort: 465,
				user: a, pass: r.pick(['', 'wA', 'wB']), refresh: {}, touched: T(r) });
			const tombs = {}; if (r.chance(0.3)) tombs[r.pick(['a@x', 'b@x'])] = T(r);
			return { v: 1, sel: '', accounts, tombs };
		},
		join: async (...xs) => {
			const w = win(); tombCore(w); loadScript(w, 'mail.js');
			for (const x of xs) await w.DaimondMail.applySync(clone(x));
			const o = w.DaimondMail.exportSync(); delete o.sel; return o;
		},
	},
	{
		name: 'chunk index: the preview arm of DaimondCloud.merge',
		gen: (r) => { const ix = {}; if (r.chance(0.8)) ix['@p/doc'] = { v: 1, size: 2, ts: T(r), chunks: [{ addr: r.pick(['p1', 'p2']), size: 2 }] }; return ix; },
		join: (...xs) => {
			const w = win(); loadScript(w, 'cloud.js');
			for (const x of xs) w.DaimondCloud.merge(clone(x), {}, 'dddddddddddddddd', 'cccccccccccccccc');
			return w.DaimondCloud.index();
		},
	},
];

for (const d of [false, true]) {
	DISTINCT = d;
	console.log('\nsynclaws: 300 triples each, ' + (d ? 'distinct stamps' : 'stamps from three values, so ties are common'));
	for (const k of KINDS) {
		const res = await checkKind(k, 300, 12345);
		const fails = Object.entries(res.fail).map(([l, n]) => l + ' ' + n + '/' + res.trials).join(', ');
		check(k.name + ': a law', !fails && !res.errors && res.trials === 300,
			fails ? fails + ' -- first ' + JSON.stringify(res.first[Object.keys(res.fail)[0]].at || '')
				: (res.errors ? 'errors ' + res.errors + ': ' + res.firstError : ''));
	}
}

// ── A7: an older post record is upgraded and merged, not refused (MIG-1) ──────
console.log('\nsynclaws: the post record at an older version');
{
	const w = win(); loadScript(w, 'post.js');
	await w.DaimondPost.read();
	w.DaimondPost.adopt({ v: 5, through: 0, acked: 0, msgs: { m1: { addr: 'm1', ts: 1, read: 0, tray: 1 } }, notes: {}, groups: {}, shares: {}, feed: { since: 0, read: {}, new: {} } });
	const moved = w.DaimondPost.adopt({ v: 4, through: 2, acked: 1, msgs: { m1: { addr: 'm1', ts: 1, read: 1, tray: 0, del: 7 } }, notes: {}, groups: {}, shares: {} });
	const s = w.DaimondPost.snapshot();
	check('a v4 record merges into a v5 store', moved === true);
	check('its read, tray and delete flags land', s.msgs.m1.read === 1 && s.msgs.m1.tray === 0 && s.msgs.m1.del === 7, JSON.stringify(s.msgs.m1));
	check('its sequences land', s.through === 2 && s.acked === 1);
	check('the store stays at its own version', s.v === 5);
	check('a NEWER record is still refused', w.DaimondPost.adopt({ v: 6, through: 9, msgs: {} }) === false && w.DaimondPost.snapshot().through === 2);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall synclaws checks passed');
process.exit(failures ? 1 : 0);
