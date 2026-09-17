// verify_daimon_selfheal.mjs — an unclaimed DAIMON dispatch self-heals, instead of
// hanging forever.
//
// #12 removed the daimon exclusion from the DISPATCH decision (autoDispatchDecision),
// but left an identical `chat.diamondId ||` term in the two FALLBACK/RECOVERY guards
// that net an unclaimed dispatch back to a local run: `runDispatchFallback` (the
// ~95s backstop timer, and the undeliverable fast-path that calls straight into it)
// and `peerCollectOnReturn` (recovery on a visibilitychange). So a daimon turn now
// DISPATCHES (the #12 fix), but if the peer it went to never claims it, both nets
// that would have recovered it locally instead early-return on `chat.diamondId` and
// the turn just hangs -- the owner's stall.
//
// This is asserted in pure node against the SHIPPED bodies (literal slice, the
// verify_gatheronrunner method) with every dependency stubbed, so what is proven is
// the shipped guard's own behaviour, not a paraphrase of it:
//
//   (b) an unclaimed daimon dispatch REACHES the recovery call (recoverOneLocally /
//       retryNextDesktopBeforeLocal) in both `runDispatchFallback` and
//       `peerCollectOnReturn` -- was early-returned/continued before the fix.
//
//   node dev/verify_daimon_selfheal.mjs
//   node dev/verify_daimon_selfheal.mjs --break dropped   # reinstates the #12-era
//                                                          # `chat.diamondId ||` term;
//                                                          # must fail (b) both ways.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(join(HERE, '..', 'www/js/daimond.js'), 'utf8');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['dropped'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

// Pull a function out by name, verbatim -- `function NAME(` or `async function NAME(`
// at one-tab indent -- so this tests the shipped body and not a paraphrase.
function slice(name) {
	let start = SRC.indexOf('\tfunction ' + name + '(');
	if (start < 0) start = SRC.indexOf('\tasync function ' + name + '(');
	if (start < 0) throw new Error('could not find ' + name);
	let i = SRC.indexOf('{', start);
	let depth = 0, end = -1;
	for (; i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
	}
	return SRC.slice(start, end);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// `--break dropped` reinstates the exact #12-era term this fix removed, against the
// two guards' actual shipped text, so a green run under the break proves these checks
// exercise the real early-return and not a stand-in for it.
function guarded(name) {
	let body = slice(name);
	if (BREAK !== 'dropped') return body;
	const before = body;
	body = body
		.replace('if (!chat || !chat.messages) return;', 'if (!chat || chat.diamondId || !chat.messages) return;')
		.replace('if (!chat || !chat.messages) continue;', 'if (!chat || chat.diamondId || !chat.messages) continue;');
	if (body === before) throw new Error(`--break dropped found nothing to reinstate in ${name}`);
	return body;
}

const REASON_DISPATCHED = 'dispatched';

// ── (b1) runDispatchFallback: the ~95s backstop timer AND the undeliverable
// fast-path (both call straight into this one function) must reach the recovery
// call for a daimon chat, not early-return on `chat.diamondId`. ──
{
	const chat = {
		id: 'c1', diamondId: 'd1',			// a DAIMON's conversation
		messages: [{ why: REASON_DISPATCHED, iturn: 't1' }],
	};
	const chats = [chat];
	let retriedWith = null, recoveredWith = null;
	const window = {
		DaimondPeer: { recoverDecision: () => true, runErrand: function () {}, REASON_DISPATCHED },
		DaimondPost: { collect: async () => {} },
		DaimondSync: { pull: async () => {} },
		DaimondLease: { record: () => null },
	};
	const factory = new Function(
		'window', 'chats', 'dispatchedChat', 'DaimondLease', 'dispatchedTurnFinished',
		'selfDeviceId', 'retryNextDesktopBeforeLocal', 'recoverOneLocally', 'DaimondPeer',
		guarded('runDispatchFallback') + '\nreturn runDispatchFallback;');
	const runDispatchFallback = factory(
		window, chats,
		/* dispatchedChat            */ () => null,
		window.DaimondLease,
		/* dispatchedTurnFinished    */ () => false,
		/* selfDeviceId              */ () => 'self1',
		/* retryNextDesktopBeforeLocal */ async (c, m) => { retriedWith = { c, m }; return false; },
		/* recoverOneLocally         */ async (c, m) => { recoveredWith = { c, m }; },
		window.DaimondPeer);
	await runDispatchFallback('c1', 't1');
	check('(b1) runDispatchFallback reaches recovery for an unclaimed DAIMON dispatch (retryNextDesktopBeforeLocal tried)',
		!!retriedWith, retriedWith ? 'reached' : 'early-returned before the recovery call');
	check('(b1) and falls to recoverOneLocally when no other desktop took it — the self-heal',
		!!recoveredWith && recoveredWith.c === chat,
		recoveredWith ? 'recovered locally' : 'never recovered — the hang');
}

// ── (b2) peerCollectOnReturn: recovery-on-return (a visibilitychange) must also
// net a daimon's dispatched placeholder rather than skip it. ──
{
	const chat = {
		id: 'c1', diamondId: 'd1',
		messages: [{ why: REASON_DISPATCHED, iturn: 't1' }],
	};
	const chats = [chat];
	const _dispatchedIx = { t1: 'c1' };
	let recovering = false;
	let retriedWith = null, recoveredWith = null;
	const window = {
		DaimondPost: { collect: async () => {} },
		DaimondSync: { pull: async () => {} },
		DaimondPeer: { recoverDecision: () => true, runErrand: function () {}, REASON_DISPATCHED },
		DaimondLease: { record: () => null },
	};
	const factory = new Function(
		'window', 'chats', '_dispatchedIx', 'selfDeviceId', 'dispatchedTurnFinished',
		'retryNextDesktopBeforeLocal', 'recoverOneLocally', 'releaseOwnStaleLeases',
		'DaimondPeer', 'DaimondLease',
		'var _recovering = false;\n'
		+ guarded('peerCollectOnReturn')
		+ '\nreturn peerCollectOnReturn;');
	const peerCollectOnReturn = factory(
		window, chats, _dispatchedIx,
		/* selfDeviceId              */ () => 'self1',
		/* dispatchedTurnFinished    */ () => false,
		/* retryNextDesktopBeforeLocal */ async (c, m) => { retriedWith = { c, m }; return false; },
		/* recoverOneLocally         */ async (c, m) => { recoveredWith = { c, m }; },
		/* releaseOwnStaleLeases     */ async () => {},
		window.DaimondPeer, window.DaimondLease);
	await peerCollectOnReturn();
	check('(b2) peerCollectOnReturn reaches recovery for an unclaimed DAIMON dispatch (retryNextDesktopBeforeLocal tried)',
		!!retriedWith, retriedWith ? 'reached' : 'skipped — the daimon\'s dispatched turn was never even looked at');
	check('(b2) and falls to recoverOneLocally when no other desktop took it — the self-heal',
		!!recoveredWith && recoveredWith.c === chat,
		recoveredWith ? 'recovered locally' : 'never recovered — the hang');
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
