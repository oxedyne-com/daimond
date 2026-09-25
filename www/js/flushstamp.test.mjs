/* ============================================================
   Test: a version is stamped only where a flush confirmed it (D-20260924-28,
   the delivery record's open item 5).

   `flush()` pushes until the live parcel is on the server and answers the
   version that holds it. Where it could not confirm (too large, over a live
   turn, the mailbox kept moving), its callers fell back to `push()` +
   `version()`, which is the version the mailbox stood at BEFORE the refusal:
   a version that does not hold what the caller had just added.

   The load-bearing caller is the dispatcher's dropped-seed path (daimond.js
   `dispatchToPeer`, 2b). Its errand names `parcelVersion` for the runner to
   pull to, and the runner's catch-up (`reconstructFromErrand`) pulls while
   `have < want`, so a stale `want` let it pull once, read itself caught up,
   and stop pulling for the chat it was waiting on. 0 is the errand's "no
   target version", on which the runner keeps pulling until the chat arrives.

   The real `dispatchToPeer` and the runner's `pushResult` are lifted from
   daimond.js with a brace-balanced scan and run over stubs of the transport.

     DISPATCH  the dropped-seed errand is sealed at 0 when flush cannot confirm
               (1640b9a0: at the pre-refusal version, 4); [ctl] at the flushed
               version when it can, and at 0 when flush throws.
     RESULT    the runner's pushResult answers 0 when flush cannot confirm
               (1640b9a0: 4); [ctl] the flushed version when it can.

   Run:  node www/js/flushstamp.test.mjs
         DAIMOND_JS=<tree>/www/js/daimond.js node www/js/flushstamp.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = process.env.DAIMOND_JS || join(HERE, 'daimond.js');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const src = readFileSync(SRC, 'utf8');

/// Lifts `function name(...) { ... }` (or `async function`) by counting braces
/// from its opening one. As in tailwiring.test.mjs.
function extractFn(name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found in daimond.js: ' + name);
	return balanced(start + 1);
}

/// The text from `from` to the close of the first brace block after it.
function balanced(from) {
	let depth = 0, i = src.indexOf('{', from);
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(from, i);
}

/// A sync stub whose mailbox stands at v4 and whose flush answers `fl`.
function syncStub(fl) {
	const calls = { push: 0, flush: 0 };
	return {
		calls,
		push:    async () => { calls.push++; },
		version: () => 4,
		flush:   async () => { calls.flush++; if (fl instanceof Error) throw fl; return fl; },
	};
}

// ── DISPATCH ────────────────────────────────────────────────────
const dispatchSrc = extractFn('dispatchToPeer');

/// Runs the real `dispatchToPeer` over a dropped seed; answers the version the
/// posted errand was sealed at.
async function dispatchWith(fl) {
	const S = syncStub(fl);
	let sealedAt = null, posted = null;
	const plan = {
		mark:   {},
		fields: { seed: null },
		errand: (v) => ({ parcelVersion: v }),
	};
	const Peer = {
		REASON_DISPATCHED: 'dispatched',
		buildDispatch: () => plan,
		sealFittingErrand: async () => ({ body: { envelope: 'seedless-v0' }, seedDropped: true, plan }),
		sealForSelf: async (errand) => { sealedAt = errand.parcelVersion; return { envelope: 'sealed-v' + errand.parcelVersion }; },
	};
	const Post = { post: async (body) => { posted = body; return { ok: true }; } };
	const win = { DaimondPeer: Peer, DaimondPost: Post, DaimondSync: S };
	const noop = () => {};
	const make = new Function('window', 'DaimondPeer', 'DaimondPost', 'DaimondSync', 'DaimondModels',
		'diag', 'turnHold', 'selfDeviceId', 'markTurnDispatched', 't', 'touchChat', 'persistChats',
		'ownsChat', 'renderHistory', 'recoverOneLocally',
		dispatchSrc + '\nreturn dispatchToPeer;');
	const fn = make(win, Peer, Post, S, {}, noop, () => null, () => 'dev-a', noop, (k) => k, noop, noop,
		() => false, noop, noop);
	const chat = { id: 'c1', messages: [], provider: '', model: '' };
	const out = await fn(chat, 'turn-1', 'hello', [], {});
	return { out, sealedAt, posted, calls: S.calls };
}

console.log('\nDISPATCH: the dropped-seed errand names only a version a flush confirmed\n');
{
	const r = await dispatchWith({ ok: false, version: 4, why: 'too_large' });
	check('flush refused for size: the errand is sealed at v0, no target (1640b9a0: v4, the pre-refusal version)',
		r.sealedAt === 0, 'sealed at v' + r.sealedAt);
	check('[ctl] the errand was posted', !!r.posted && r.out && r.out.ok === true, JSON.stringify(r.out));
}
{
	const r = await dispatchWith({ ok: false, version: 4, why: 'not_confirmed' });
	check('flush could not confirm (the mailbox kept moving): sealed at v0 (1640b9a0: v4)',
		r.sealedAt === 0, 'sealed at v' + r.sealedAt);
}
{
	const r = await dispatchWith({ ok: true, version: 7 });
	check('[ctl] a confirmed flush: sealed at its version, v7', r.sealedAt === 7, 'sealed at v' + r.sealedAt);
}
{
	const r = await dispatchWith(new Error('offline'));
	check('[ctl] a flush that throws: sealed at v0', r.sealedAt === 0, 'sealed at v' + r.sealedAt);
}

// ── RESULT ──────────────────────────────────────────────────────
const at = src.indexOf('\t\t\tpushResult: async function () {');
if (at < 0) throw new Error('pushResult not found in daimond.js');
const resultSrc = balanced(src.indexOf('async function', at));

async function resultWith(fl) {
	const S = syncStub(fl);
	const make = new Function('DaimondSync', 'ctx', 'captureSession', 'return (' + resultSrc + ');');
	const fn = make(S, null, () => {});
	return { v: await fn(), calls: S.calls };
}

console.log('\nRESULT: the runner\'s pushResult answers only a version a flush confirmed\n');
{
	const r = await resultWith({ ok: false, version: 4, why: 'busy' });
	check('flush over a live turn: pushResult answers v0 (1640b9a0: v4)', r.v === 0, 'v' + r.v);
}
{
	const r = await resultWith({ ok: true, version: 9 });
	check('[ctl] a confirmed flush: pushResult answers its version, v9', r.v === 9, 'v' + r.v);
}

console.log('\n' + (checks - failures) + '/' + checks + ' passed');
if (failures) { console.log('FAILURES: ' + failures); process.exit(1); }
