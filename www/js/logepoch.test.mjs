/* Test -- the chat log door names the account's wipe epoch (WL1 gap 2, WL1 exam fault 1, sync.js).
   The gateway answers every log_put, log_get and sync GET with the space's wipe `epoch`, refuses a
   write naming another, or naming none once the space was wiped, with 409 `wiped` {epoch}, and
   answers a chat a wipe buried with 410 `deleted` {epoch}. A row written before a wipe must not
   go under the epoch learnt after it, so the writer binds the epoch when it writes the row.
   SEND   the epoch the rows were bound to (turnwrite.js), never the one known at sending
   ADOPT  every answer names it (append, read, sync GET); kept across a reload; it only rises,
          except as a 409 names it
   GONE   a read answered 410 `deleted` is the chat gone, nothing to fold; any other refusal null
   node www/js/logepoch.test.mjs */
import { source, lift, liftFn } from './testlift.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

const src = source('sync.js');
const L = lift(src, ['logEpochNow', 'noteLogEpoch', 'appendLog', 'readLog'], ['K_LOG_EPOCH', 'logEpoch']);
check('the epoch helpers exist', !L.missing.length, 'missing ' + L.missing.join(', '));

// One tab: its storage outlives the module, as a reload's does.
function tab(store, answer) {
	const posts = [];
	const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
	const call = async (method, body, q) => { posts.push({ method, body, q }); return answer(method, body, q); };
	const F = new Function('localStorage', 'call', [
		'var WAKE_ID = "w1", PULL_TIMEOUT_MS = 1, entitled = true, sessionGone = false, rekeyBehind = false;',
		'function ready() { return true; }',
		L.body,
		'return { appendLog, readLog, logEpochNow, epoch: function () { return logEpoch; } };',
	].join('\n'))(localStorage, call);
	return { F, posts };
}

if (!L.missing.length) {
	const store = {};
	let gw = 0, wiped = false;
	const answer = (method, body, q) => {
		if (method === 'GET') {
			if (q.includes('log=gone')) return { status: 410, json: { ok: false, why: 'deleted', epoch: gw } };
			if (q.includes('log=bad'))  return { status: 403, json: { ok: false } };
			return { status: 200, json: { ok: true, rows: [], head: 0, low: 0, more: false, epoch: gw } };
		}
		if (body.epoch !== undefined ? body.epoch !== gw : gw > 0) return { status: 409, json: { ok: false, why: 'wiped', epoch: gw } };
		if (wiped && q.includes('log=old')) return { status: 410, json: { ok: false, why: 'deleted', epoch: gw } };
		return { status: 200, json: { ok: true, first: 1, head: 1, epoch: gw } };
	};
	let { F, posts } = tab(store, answer);
	await F.appendLog('c1', [{ turn: 't1' }], null);
	check('SEND none for rows bound to none', !('epoch' in posts[0].body), JSON.stringify(posts[0].body));
	check('ADOPT a 200 names it', F.epoch() === 0, String(F.epoch()));
	await F.appendLog('c1', [{ turn: 't1' }], null);
	check('SEND none still, though one is known now', !('epoch' in posts[1].body), JSON.stringify(posts[1].body));
	await F.appendLog('c1', [{ turn: 't3' }], 0);
	check('SEND the epoch the rows were bound to', posts[2].body.epoch === 0, JSON.stringify(posts[2].body));

	// The account is wiped elsewhere; this page reloads with its outbox (rows bound to 0) and its epoch.
	gw = 1; wiped = true;
	({ F, posts } = tab(store, answer));
	check('ADOPT kept across a reload', F.logEpochNow() === 0, String(F.epoch()));
	await F.readLog('c1', 0);
	check('ADOPT a read teaches the new epoch', F.epoch() === 1, String(F.epoch()));
	const r = await F.appendLog('old', [{ turn: 't2' }], 0);
	check('SEND a row from before the wipe still names its old epoch', posts[1].body.epoch === 0, JSON.stringify(posts[1].body));
	check('SEND and is refused 409 wiped', r.status === 409 && r.json.why === 'wiped', String(r.status));
	check('ADOPT the adopted epoch is stored', store['daimond-sync-log-epoch'] === '1', store['daimond-sync-log-epoch']);
	const n = await F.appendLog('c1', [{ turn: 't4' }], null);
	check('SEND a row bound to none is refused once the space was wiped', n.status === 409, String(n.status));
	const d = await F.appendLog('old', [{ turn: 't2' }], 1);
	check('ADOPT 410 deleted for the buried chat at the new epoch', d.status === 410 && F.epoch() === 1, d.status + ' ' + F.epoch());

	// An answer that left before the wipe lands after it: the epoch does not go back; a 409 names the space's own.
	gw = 0;
	await F.readLog('c1', 0);
	check('ADOPT a late read does not move the epoch back', F.epoch() === 1, String(F.epoch()));
	await F.appendLog('c1', [{ turn: 't5' }], 1);
	check('ADOPT a 409 names the space\'s epoch and is taken', F.epoch() === 0, String(F.epoch()));
	gw = 1;

	// A fresh tab learns from a read; a 410 read is the chat gone.
	({ F, posts } = tab({}, answer));
	await F.readLog('c1', 0);
	check('ADOPT a read fills an unknown epoch', F.epoch() === 1, String(F.epoch()));
	const g = await F.readLog('gone', 0);
	check('GONE a 410 read is the chat gone with nothing to fold',
		!!g && g.gone === true && Array.isArray(g.rows) && !g.rows.length && !g.more, JSON.stringify(g));
	check('GONE any other refusal is still a failed read', (await F.readLog('bad', 0)) === null);

	// The sync GET teaches it too, before this device writes a row.
	check('ADOPT the sync GET names it', /noteLogEpoch\(j\b/.test(liftFn(src, 'pullOnce')), 'pullOnce does not adopt the epoch');
}
console.log(failures ? failures + ' failed' : 'logepoch: all passed');
process.exit(failures ? 1 : 0);
