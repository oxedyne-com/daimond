/* ============================================================
   Test — a mark counts only on a device where it was pressed (R2).
   ------------------------------------------------------------
   Drives the real markshere.js with no browser: the pure core (the
   sidecar parse, `force`, `settle`, the built-in seeds), the storage
   shell over one localStorage shared by two tabs (P11), and a guard
   over the tree (P10): no frame in www/ runs in the page's origin,
   a capp page cannot write a Diamond's sidecar, and the record's key
   appears nowhere it could join a parcel, a bundle or a backup.

     node www/js/markshere.test.mjs
     node --test www/js/*.test.mjs
   ============================================================ */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = join(HERE, '..');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

/// A localStorage over a plain map, shared by every tab made on it.
function storage() {
	const m = new Map();
	const ls = {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => { if (ls.full) throw new Error('QuotaExceededError'); m.set(k, String(v)); ls.writes.push(k); },
		removeItem: (k) => { m.delete(k); ls.writes.push(k); },
		writes: [], full: false,
	};
	return ls;
}

/// One tab: markshere.js, fresh, over `ls`, with an identity that is unlocked
/// until `lock` says otherwise.
function tab(ls) {
	const on = {};
	let unlocked = true;
	let heard = 0;
	const win = {
		localStorage: ls,
		addEventListener: (type, fn) => { (on[type] = on[type] || []).push(fn); },
		dispatchEvent: () => { heard++; return true; },
		DaimondIdentity: { isUnlocked: () => unlocked },
	};
	new Function('window', 'CustomEvent', readFileSync(join(HERE, 'markshere.js'), 'utf8'))(win,
		function CustomEvent(type) { this.type = type; });
	return {
		M: win.DaimondMarksHere,
		lock: (v) => { unlocked = !v; },
		heard: () => heard,
		storage: (key) => (on.storage || []).forEach((fn) => fn({ key })),
	};
}

const A = 'a1b2c3d4e5f6';
const row = (o) => Object.assign({ owner: A, id: 'L1', from: 'diamond:' + A, to: 'dir:[browser]secret',
	rel: 'holds', by: 'user', share: false }, o || {});
const BR = 'browser', MU = 'machine:usr';

// ── The parse mirrors Link::from_json ──────────────────────────────
{
	const { _core: C, parseSidecar } = tab(storage()).M;
	check('a line without `from` is no row', C.parseRow('{"id":"x","to":"dir:secret","rel":"holds","by":"user"}') === null);
	check('a line without `to` is no row', C.parseRow('{"id":"x","from":"diamond:a","rel":"holds"}') === null);
	check('a line that is not JSON is no row', C.parseRow('{"from":') === null);
	const legacy = C.parseRow('{"id":"x","from":"diamond:a","to":"dir:s","rel":"holds","note":"share","by":"user"}');
	check('the pre-R3 note:"share" form reads as shared', legacy && legacy.share === true);
	const model = C.parseRow('{"id":"x","from":"diamond:a","to":"dir:s","rel":"holds","note":"share","by":"agent:d"}');
	check('a model\'s note saying share is only a note', model && model.share === false);
	check('an explicit share:false beats the note',
		C.parseRow('{"id":"x","from":"diamond:a","to":"dir:s","note":"share","by":"user","share":false}').share === false);
	check('the relation is normalised as the store does', C.parseRow('{"from":"diamond:a","to":"dir:s","rel":"  Holds  "}').rel === 'holds');
	check('a kind is lowercased and the ref trimmed', C.canonRef('  DIR:x ') === 'dir:x' && C.canonRef('bad kind:x') === null);
	const rows = parseSidecar('{"id":"a","from":"facet:a","to":"dir:s"}\n\n  \nnot json\n{"id":"b","from":"diamond:a","to":"file:f"}\n');
	check('facet: reads as diamond:, blank and bad lines skipped', rows.length === 2 && rows[0].from === 'diamond:a', JSON.stringify(rows));
}

// ── force: the one test of a grant ─────────────────────────────────
{
	const { _core: C } = tab(storage()).M;
	const rec = { v: 1, d: {}, c: {} };
	check('a row with no entry is not in force', C.force(rec, A, row(), BR, []) === null);
	C.putEntry(rec, A, row(), BR, 'holds', false);
	const f = C.force(rec, A, row(), BR, []);
	check('an entry with the same id, to and root brings it into force', f && f.rel === 'holds' && f.share === false);
	check('in another workspace it is not', C.force(rec, A, row(), MU, []) === null);
	check('the same id with another `to` is not', C.force(rec, A, row({ to: 'dir:[browser]other' }), BR, []) === null);
	check('another id with the same `to` is not', C.force(rec, A, row({ id: 'L2' }), BR, []) === null);
	check('a row stored in another Diamond\'s sidecar is not', C.force(rec, A, row({ owner: 'ffff' }), BR, []) === null);
	check('a row whose `from` is not the Diamond is not', C.force(rec, A, row({ from: 'dir:[browser]secret', to: 'diamond:' + A }), BR, []) === null);
	check('a model\'s row is never a mark', C.force(rec, A, row({ by: 'agent:d' }), BR, []) === null);
	check('a fold\'s `produced` row is never a mark', C.force(rec, A, row({ rel: 'produced' }), BR, []) === null);
	check('a row that arrives shared counts for nothing shared here', C.force(rec, A, row({ share: true }), BR, []).share === false);
	check('a row that arrives consulted narrows the grant', C.force(rec, A, row({ rel: 'consulted' }), BR, []).rel === 'consulted');
	C.putEntry(rec, A, row(), BR, 'consulted', true);
	check('an entry that is consulted never widens a holds row', C.force(rec, A, row({ share: true }), BR, []).rel === 'consulted');
	check('a share is counted where both the row and the entry say so', C.force(rec, A, row({ share: true }), BR, []).share === true);
	check('legacy by:"" is a mark, in force under its entry',
		C.force({ v: 1, d: { [A]: [{ id: '', to: 'dir:secret', rel: 'holds', share: false, root: BR }] }, c: {} },
			A, row({ id: '', by: '', to: 'dir:secret' }), BR, []).rel === 'holds');
	const w = { v: 1, d: {}, c: {} };
	check('an unconfirmed mark on a fitting root waits', C.waiting(w, A, row(), BR, []) === true);
	check('one whose root is another workspace does not wait', C.waiting(w, A, row(), MU, []) === false);
	check('a machine ref waits in a folder of its name', C.waiting(w, A, row({ to: 'dir:[machine:usr@0123456789abcdef]b' }), MU, []) === true
		&& C.waiting(w, A, row({ to: 'dir:[machine:home@0123456789abcdef]b' }), MU, []) === false);
	check('a model\'s row never waits', C.waiting(w, A, row({ by: 'agent:d' }), BR, []) === false);
}

// ── The seeds ──────────────────────────────────────────────────────
{
	const { _core: C } = tab(storage()).M;
	const seeds = [{ owner: '0da1000000e1', path: 'system/guide' }];
	const help = (o) => row(Object.assign({ owner: '0da1000000e1', from: 'diamond:0da1000000e1', to: 'dir:[browser]system/guide', rel: 'consulted' }, o));
	const none = { v: 1, d: {}, c: {} };
	const f = C.force(none, '0da1000000e1', help(), BR, seeds);
	check('Help sees the guide with no entry, read-only', f && f.rel === 'consulted' && f.share === false);
	check('under any root', !!C.force(none, '0da1000000e1', help({ to: 'dir:[machine:usr@0123456789abcdef]system/guide' }), MU, seeds));
	check('a forged holds row on the seed is still read-only', C.force(none, '0da1000000e1', help({ rel: 'holds', share: true }), BR, seeds).rel === 'consulted');
	check('a forged share on the seed is not a share', C.force(none, '0da1000000e1', help({ share: true }), BR, seeds).share === false);
	check('the seed covers no other folder', C.force(none, '0da1000000e1', help({ to: 'dir:[browser]secret' }), BR, seeds) === null);
	check('and no other Diamond', C.force(none, A, row({ to: 'dir:[browser]system/guide' }), BR, seeds) === null);
}

// ── settle: a removal or a narrowing crosses, a widening never does ──
{
	const { _core: C } = tab(storage()).M;
	const base = () => {
		const r = { v: 1, d: {}, c: {} };
		C.putEntry(r, A, row(), BR, 'holds', true);
		C.putEntry(r, A, row({ id: 'L2', to: 'dir:[browser]b' }), BR, 'holds', false);
		return r;
	};
	let r = C.settleRows(base(), A, [row({ share: true }), row({ id: 'L2', to: 'dir:[browser]b' })]);
	check('rows that arrive unchanged leave both entries', r.d[A].length === 2 && r.d[A][0].share === true);
	r = C.settleRows(base(), A, [row({ id: 'L2', to: 'dir:[browser]b' })]);
	check('a row absent from the copy drops its entry', r.d[A].length === 1 && r.d[A][0].id === 'L2');
	r = C.settleRows(base(), A, [row({ share: false }), row({ id: 'L2', to: 'dir:[browser]b', rel: 'consulted' })]);
	check('share off narrows, consulted narrows', r.d[A][0].share === false && r.d[A][1].rel === 'consulted');
	r = C.settleRows(r, A, [row({ share: true }), row({ id: 'L2', to: 'dir:[browser]b', rel: 'holds' })]);
	check('a later widening does not widen', r.d[A][0].share === false && r.d[A][1].rel === 'consulted');
	r = C.settleRows(base(), A, [row({ by: 'agent:d' }), row({ id: 'L2', to: 'dir:[browser]b' })]);
	check('a row that is no longer a mark drops its entry', r.d[A].length === 1);
	r = C.settleRows(base(), A, []);
	check('an empty copy drops every entry under it', !r.d[A]);
}

// ── Chats ──────────────────────────────────────────────────────────
{
	const { _core: C } = tab(storage()).M;
	const h = { ref: 'dir:[browser]secret', path: 'secret', dir: true, ws: true, state: 'read' };
	const rec = { v: 1, d: {}, c: {} };
	check('a chat record claiming a mark and a Read grants neither with no entry', C.chatForce(rec, 'c1', h, BR) === null);
	check('and waits', C.chatWaiting(rec, 'c1', h, BR) === true);
	C.putChat(rec, 'c1', h, BR, { ws: true, read: false });
	check('the mark pressed here grants the mark only', C.chatForce(rec, 'c1', h, BR).ws === true && C.chatForce(rec, 'c1', h, BR).read === false);
	check('and still waits for its Read', C.chatWaiting(rec, 'c1', h, BR) === true);
	C.putChat(rec, 'c1', h, BR, { read: true });
	check('both pressed: both in force, nothing waits', C.chatForce(rec, 'c1', h, BR).read === true && !C.chatWaiting(rec, 'c1', h, BR));
	check('a path that is not the one in the ref grants nothing', C.chatForce(rec, 'c1', Object.assign({}, h, { path: 'other' }), BR) === null);
	check('another chat has no grant from it', C.chatForce(rec, 'c2', h, BR) === null);
	let r = C.settleChatHolds(JSON.parse(JSON.stringify(rec)), 'c1', [Object.assign({}, h, { ws: false })]);
	check('marked out elsewhere: the mark narrows, the Read stays', r.c.c1[0].ws === false && r.c.c1[0].read === true);
	r = C.settleChatHolds(JSON.parse(JSON.stringify(rec)), 'c1', []);
	check('taken off elsewhere: the entry goes', !r.c.c1);
	C.putChat(rec, 'c1', h, BR, { ws: false, read: false });
	check('an entry granting nothing is not kept', !rec.c.c1);
}

// ── P11: the storage shell over two tabs of one account ─────────────
{
	const ls = storage();
	const T1 = tab(ls), T2 = tab(ls);
	const M1 = T1.M, M2 = T2.M;
	check('with no record the key is absent', M1.absent() === true);
	check('a grant in one tab lands', M1.grant(A, row(), BR) === true);
	check('and is in force in the other with no event', !!M2.force(A, row(), BR));
	check('the key is no longer absent', M2.absent() === false);
	check('a grant in the second tab keeps the first\'s', M2.grant(A, row({ id: 'L2', to: 'dir:[browser]b' }), BR) === true
		&& !!M1.force(A, row(), BR) && !!M1.force(A, row({ id: 'L2', to: 'dir:[browser]b' }), BR));
	check('a drop in the first tab ends it in the second', M1.drop(A, 'L1', row().to) === true && M2.force(A, row(), BR) === null);
	check('and leaves the second tab\'s own grant', !!M2.force(A, row({ id: 'L2', to: 'dir:[browser]b' }), BR));
	check('a confirmation never carries the share flag', M1.grant(A, row({ share: true }), BR) && M1.force(A, row({ share: true }), BR).share === false);
	check('⇄ here turns it on', M1.setShare(A, row({ share: true }), BR, true) && M2.force(A, row({ share: true }), BR).share === true);
	check('⇄ is refused on a mark not in force here', M1.setShare(A, row({ id: 'L9', to: 'dir:[browser]z' }), BR, true) === false);
	const heard = T2.heard();
	T2.storage('daimond-chats');
	check('a write to another key is not ours', T2.heard() === heard);
	T2.storage(M1.KEY);
	check('a write to this key is told to the page', T2.heard() === heard + 1);
	T1.lock(true);
	check('before unlock every mark reads as waiting', M1.force(A, row({ share: true }), BR) === null && M1.waiting(A, row(), BR) === true);
	check('and every write is refused', M1.grant(A, row({ id: 'L3', to: 'dir:[browser]c' }), BR) === false);
	T1.lock(false);
	ls.full = true;
	check('a write that does not land reports failure', M1.grant(A, row({ id: 'L4', to: 'dir:[browser]d' }), BR) === false);
	ls.full = false;
	check('and granted nothing', M1.force(A, row({ id: 'L4', to: 'dir:[browser]d' }), BR) === null);
	ls.setItem(M1.KEY, '{not json');
	check('a record that does not parse reads as empty: every mark waits', M1.force(A, row({ id: 'L2', to: 'dir:[browser]b' }), BR) === null);
	check('and a press still writes a good one', M1.grant(A, row(), BR) && !!M2.force(A, row(), BR));
	check('settle drops an entry absent from the copy', M1.settle(A, '', '') === true && M2.force(A, row(), BR) === null);
	check('the seeds are given once', M1.seeds([{ owner: A, path: 'secret' }]) === true && M1.seeds([]) === false);
	check('a grant is refused on a row that is not the Diamond\'s own', M1.grant(A, row({ owner: 'ffff' }), BR) === false);
	check('a chat grant and its drop', M1.chatGrant('c1', { ref: 'dir:[browser]s', path: 's', ws: true }, BR, { ws: true })
		&& !!M2.chatForce('c1', { ref: 'dir:[browser]s', path: 's', ws: true }, BR)
		&& M2.chatDropAll('c1') && !M1.chatForce('c1', { ref: 'dir:[browser]s', path: 's', ws: true }, BR));
}

// ── F6: a key that is not an id reads as empty and is never written ──
//
// QA 2026-09-24: a chat id from a parcel is not checked, and one named after an
// `Object` member made every read throw (`rec.c[k].push is not a function`), so
// Use here, the notice and every grant threw until site data was cleared.
{
	const { _core: C } = tab(storage()).M;
	const tryIt = (fn) => { try { return { v: fn(), err: '' }; } catch (e) { return { v: null, err: String((e && e.message) || e) }; } };
	const ent = { ref: 'dir:[browser]x', path: 'x', ws: true, read: false, root: BR };
	const dent = { id: 'L1', to: 'dir:[browser]secret', rel: 'holds', share: false, root: BR };
	for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
		const raw = '{"v":1,"d":{"' + k + '":[' + JSON.stringify(dent) + '],"' + A + '":[' + JSON.stringify(dent) + ']},'
			+ '"c":{"' + k + '":[' + JSON.stringify(ent) + '],"c1":[' + JSON.stringify(ent) + ']}}';
		const got = tryIt(() => C.readRecord(raw));
		check('a record keyed "' + k + '" reads without throwing', !got.err, got.err);
		const r = got.v || { d: {}, c: {} };
		check('and reads as empty for that key alone', !Object.prototype.hasOwnProperty.call(r.c, k)
			&& !Object.prototype.hasOwnProperty.call(r.d, k) && !!C.chatForce(r, 'c1', { ref: ent.ref, path: 'x', ws: true }, BR)
			&& !!C.force(r, A, row(), BR, []), JSON.stringify(r));
		check('and grants nothing under it', C.chatForce(r, k, { ref: ent.ref, path: 'x', ws: true }, BR) === null);
	}
	const r0 = C.readRecord('{"v":1,"d":{},"c":{}}');
	check('the maps have no prototype to shadow', Object.getPrototypeOf(r0.d) === null && Object.getPrototypeOf(r0.c) === null);
	for (const raw of ['{"v":1,"d":[[{"id":"L1"}]],"c":"c1"}', '{"v":1,"d":null,"c":7}', '[1]', '"x"', 'null']) {
		const got = tryIt(() => C.readRecord(raw));
		check('a malformed record reads as nothing or empty: ' + raw, !got.err && (got.v === null
			|| (Object.keys(got.v.d).length === 0 && Object.keys(got.v.c).length === 0)), got.err || JSON.stringify(got.v));
	}
	const w = { v: 1, d: {}, c: {} };
	C.putChat(w, 'constructor', { ref: 'dir:[browser]x', path: 'x' }, BR, { ws: true });
	C.putEntry(w, '__proto__', row({ owner: '__proto__', from: 'diamond:__proto__' }), BR, 'holds', false);
	check('a press on a key that is not an id writes nothing', JSON.stringify(w) === '{"v":1,"d":{},"c":{}}'
		&& Object.getPrototypeOf(w.d) === Object.prototype, JSON.stringify(w));
	const ids = typeof C.isChatId === 'function' && typeof C.isDiamondId === 'function';
	check('the ids the store mints are ids', ids && C.isChatId('c' + Date.now().toString(36) + '-1-a9z0q') && C.isChatId('c12')
		&& C.isDiamondId('0da1000000f2') && C.isDiamondId('1a0d1e93a303'));
	check('and nothing else is', ids && !C.isChatId('constructor') && !C.isChatId('__proto__') && !C.isChatId('c') && !C.isChatId('C1')
		&& !C.isDiamondId('constructor') && !C.isDiamondId('') && !C.isDiamondId('0DA1'));

	// The storage shell over a record a forged chat id reached: every door answers, none throws.
	const ls = storage(), T = tab(ls), M = T.M;
	ls.setItem(M.KEY, '{"v":1,"d":{"__proto__":[' + JSON.stringify(dent) + '],"' + A + '":[' + JSON.stringify(dent) + ']},'
		+ '"c":{"constructor":[' + JSON.stringify(ent) + '],"c1":[' + JSON.stringify(ent) + ']}}');
	const h = { ref: 'dir:[browser]x', path: 'x', ws: true, state: 'note' };
	const doors = tryIt(() => [
		M.force(A, row(), BR), M.waiting(A, row(), BR), M.chatForce('constructor', h, BR), M.chatWaiting('constructor', h, BR),
		M.chatForce('c1', h, BR), M.absent(),
		M.chatGrant('constructor', h, BR, { ws: true }), M.grant('__proto__', row({ owner: '__proto__', from: 'diamond:__proto__' }), BR),
		M.chatSettle('constructor', []), M.settle('__proto__', '', ''), M.dropAll('__proto__'), M.chatDropAll(['constructor']),
		M.chatGrant('c2', h, BR, { ws: true }),
	]);
	check('every door answers over a forged key, none throws', !doors.err, doors.err);
	const v = doors.v || [];
	check('the good entries are still in force', !!v[0] && !v[1] && !!v[4], JSON.stringify(v.slice(0, 6)));
	check('the forged chat grants nothing and waits', v[2] === null && v[3] === true, JSON.stringify(v.slice(2, 4)));
	check('a press on the forged ids is refused, and one on a real chat still lands', v[6] === false && v[7] === false && v[12] === true,
		JSON.stringify(v.slice(6, 13)));
	const back = JSON.parse(ls.getItem(M.KEY));
	check('the next write leaves the forged keys out of the record', !Object.prototype.hasOwnProperty.call(back.c, 'constructor')
		&& !Object.prototype.hasOwnProperty.call(back.d, '__proto__') && !!back.c.c1 && !!back.c.c2 && !!back.d[A], JSON.stringify(back));
}

// ── P10: the guard over the tree ────────────────────────────────────
{
	const files = [];
	(function walk(d) {
		for (const n of readdirSync(d)) {
			const p = join(d, n), rel = relative(WWW, p);
			if (/^(pkg|vendor|assets)(\/|$)/.test(rel)) continue;
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (/\.(js|html|mjs)$/.test(n) && !/\.test\.mjs$/.test(n)) files.push(rel);
		}
	})(WWW);
	const sandboxes = [];
	for (const f of files) {
		const src = readFileSync(join(WWW, f), 'utf8');
		for (const m of src.matchAll(/setAttribute\(\s*['"]sandbox['"]\s*,\s*(['"])(.*?)\1/g)) sandboxes.push([f, m[2]]);
		for (const m of src.matchAll(/<iframe\b[^>]*?\bsandbox\s*=\s*"([^"]*)"/gs)) sandboxes.push([f, m[1]]);
		for (const m of src.matchAll(/\.sandbox\s*(?:=|\.add\()\s*['"]([^'"]*)['"]/g)) sandboxes.push([f, m[1]]);
	}
	check('every frame\'s sandbox was found (crystal, viewer, web panel)', sandboxes.length >= 3, JSON.stringify(sandboxes));
	const same = sandboxes.filter(([, v]) => /allow-same-origin/.test(v));
	check('no frame in www/ runs in the page\'s origin', same.length === 0, JSON.stringify(same));
	const iframes = files.filter((f) => /createElement\(\s*['"]iframe['"]\s*\)|<iframe\b/.test(readFileSync(join(WWW, f), 'utf8')));
	const bare = iframes.filter((f) => !sandboxes.some(([g]) => g === f));
	check('every file that makes a frame sandboxes it', bare.length === 0, JSON.stringify(bare));
	const crystal = readFileSync(join(HERE, 'crystal.js'), 'utf8');
	const m = /var PAGE_NEVER_WRITES = (\/.*\/);/.exec(crystal);
	const re = m ? new Function('return ' + m[1])() : null;
	check('a capp page may never write a Diamond\'s sidecar', !!re && re.test('.daimond/links.jsonl') && re.test('.daimond/meta.json'));
	const key = 'daimond-marks-' + 'here';
	const hits = files.filter((f) => readFileSync(join(WWW, f), 'utf8').includes(key));
	check('the record\'s key is named only in markshere.js and daimond.js', hits.sort().join(',') === 'js/daimond.js,js/markshere.js', hits.join(','));
	const dsrc = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const list = /var FORGET_CLEARS = \[([\s\S]*?)\n\t\];/.exec(dsrc);
	const inList = list ? list[1].split(key).length - 1 : 0;
	check('and in daimond.js only in FORGET_CLEARS', inList === 1 && dsrc.split(key).length - 1 === 1,
		'in list ' + inList + ', in file ' + (dsrc.split(key).length - 1));
}

console.log(failures === 0
	? `\nmarkshere: all ${checks} checks passed`
	: `\nmarkshere: ${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
