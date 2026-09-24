/* ============================================================
   Test — the reach-marks toggle resolves its link AUTHORITATIVELY.
   ------------------------------------------------------------
   Root fix for the folder-mark data-loss bug: seq 291 shipped a live
   patch (a diamond-id guard in `toggleAttachHold`, refusing rather than
   repairing a stale cache row from another Diamond). This is the
   DURABLE fix that follows it -- the toggle no longer reads `attached`
   (the on-screen cache `loadAttached` fills) at all for its remove/add
   decision. It asks `linkTo` for the CURRENT diamond's own link, every
   time, so correctness never depends on the cache being fresh.

   Two cases, driven against the REAL `toggleAttachHold` extracted from
   www/js/daimond.js (no browser, no wasm -- a store and a spied
   `diamondApp()` stand in):

     CASE A  Diamond A is focused; the on-screen cache still holds a
             stale row for Diamond B under the SAME reference (exactly
             the state a missed `onDiamondChanged` reload leaves
             behind). The toggle must resolve A's own link from the
             store via `linkTo` and touch only A's link -- B's is never
             named in a `remove_link`/`add_link` call, and the stale
             cache is never even read.

     CASE B  A normal toggle on the focused diamond, cache fresh: add
             when there is no link, remove when there is -- the
             ordinary round trip must keep working.

   Run:  node www/js/verify_attach.test.mjs
         node www/js/verify_attach.test.mjs --break stale  # pre-root-fix code back
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(join(HERE, 'daimond.js'), 'utf8');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['stale'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

// ── Pull the body of `async function NAME(args) { ... }` out of the source ──
//
// Brace-matched from the opening `{`, exactly as workerfinish.test.mjs's
// `funcBody` does for a plain one -- `toggleAttachHold` carries no
// brace-bearing string or regex literal, so a naive count is exact.
function asyncFuncBody(name) {
	const head = new RegExp('async\\s+function\\s+' + name + '\\s*\\(([^)]*)\\)\\s*\\{');
	const m = head.exec(SRC);
	if (!m) throw new Error('async function not found: ' + name);
	let i = m.index + m[0].length - 1, depth = 0, start = i;
	for (; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) break; }
	}
	return { args: m[1], body: SRC.slice(start + 1, i) };
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The body of a plain (non-async) `function NAME(args) { ... }`, brace-matched
// the same way `asyncFuncBody` matches an async one -- `markWaiting` carries
// no brace-bearing string or regex literal either.
function funcBody(name) {
	const head = new RegExp('function\\s+' + name + '\\s*\\(([^)]*)\\)\\s*\\{');
	const m = head.exec(SRC);
	if (!m) throw new Error('function not found: ' + name);
	let i = m.index + m[0].length - 1, depth = 0, start = i;
	for (; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) break; }
	}
	return { args: m[1], body: SRC.slice(start + 1, i) };
}

// The REAL `markWaiting`, added by `fix/delete-open-paths` to gate the
// `toggleAttachHold` click on a mark not yet in force here. It reaches
// `parseRef`/`refConfirmable`/`refReachable` only past its own early `rel`
// guard, and every link this suite hands it fails that guard (none carries
// `rel: 'holds'|'consulted'`) -- exactly the plain, already-in-force links
// CASE A/B model -- so those three are never actually called and need no
// stand-in; only `link` is a free name.
function buildMarkWaiting() {
	const { args, body } = funcBody('markWaiting');
	return new Function(args, body);
}

// The BREAK: put the pre-root-fix code back -- the cache record `rec` decides
// the link when present, guarded only by the diamond-id check seq 291 added.
// `rec` and `attachedOf` are supplied as extra free variables, reached only
// here; the fixed source never mentions either.
function toggleBody() {
	const body = asyncFuncBody('toggleAttachHold').body;
	if (BREAK !== 'stale') return body;
	return body.replace(
		'var link = await linkTo(id, ref);',
		'var rec = attachedOf(ref);\n' +
		'\t\t\tif (rec && rec.link && rec.link.owner !== id) return;\n' +
		'\t\t\tvar link = rec ? rec.link : await linkTo(id, ref);'
	);
}

// Free names close over the module state `toggleAttachHold` reads in the real
// file (`currentDiamond`) and the sibling functions it calls
// (`rootedRef`, `linkTo`, `diamondApp`, `signalLinksChanged`); `attachedOf` is
// passed through too, so the SAME build works under `--break stale`, which is
// the only path that ever calls it.
function buildToggle() {
	const args = asyncFuncBody('toggleAttachHold').args;
	const freeNames = ['currentDiamond', 'rootedRef', 'linkTo', 'diamondApp', 'signalLinksChanged', 'attachedOf',
		'markWaiting', 'confirmMarkHere'];
	const params = freeNames.concat(args.split(',').map(s => s.trim()).filter(Boolean));
	return new AsyncFunction(...params, toggleBody());
}

// ── Source-level checks: the cache is gone from the resolution path ──────
{
	const body = asyncFuncBody('toggleAttachHold').body;
	check('toggleAttachHold resolves the link with an unconditional linkTo call',
		body.includes('var link = await linkTo(id, ref);'));
	check('the old cache-trusting guard is gone from source',
		!body.includes('rec.link.owner !== id') && !body.includes('attachedOf'));
}

// ── Harness: a spied diamondApp() and a stub store ───────────────────────
function makeApp(state) {
	return function diamondApp() {
		return {
			async remove_link(owner, id) { state.removed.push({ owner, id }); },
			async add_link(id, self, ref, rel, note, by) {
				state.added.push({ id, self, ref, rel, note, by });
			},
		};
	};
}

async function toggle(diamondId, links, attachedOfImpl, path, dir) {
	const run = buildToggle();
	const state = { removed: [], added: [] };
	const app = makeApp(state);
	let signalled = false;
	let attachedOfCalls = 0;
	let confirmMarkHereCalls = 0;
	const attachedOf = (ref) => { attachedOfCalls++; return attachedOfImpl ? attachedOfImpl(ref) : null; };
	const linkTo = async (id, ref) => links[id] || null;
	const rootedRef = (kind, p) => kind + ':' + p;
	// The REAL markWaiting -- see buildMarkWaiting -- so `toggleAttachHold`'s own
	// gate is exercised, not stubbed away. `confirmMarkHere` is never expected to
	// run for any link this suite hands it (markWaiting fails its `rel` guard
	// first), so it is a spy rather than the real door-opening act; a call to it
	// would mean markWaiting answered YES for a plain, already-in-force link.
	const markWaiting = buildMarkWaiting();
	const confirmMarkHere = async () => { confirmMarkHereCalls++; return false; };
	await run(
		{ id: diamondId },		// currentDiamond
		rootedRef,
		linkTo,
		app,
		() => { signalled = true; },	// signalLinksChanged
		attachedOf,
		markWaiting,
		confirmMarkHere,
		path, dir);
	return { state, signalled, attachedOfCalls, confirmMarkHereCalls };
}

// ── CASE A: a stale cache row for another Diamond must not steer this one ──
{
	// The store's truth: Diamond A holds a link on this ref; Diamond B does
	// not appear here at all -- if the toggle ever asked for B's answer
	// instead of A's, or refused because of B, the assertions below catch it.
	const links = { 'D-A': { owner: 'D-A', id: 'link-A1' } };
	// The stale cache: a row left over from when Diamond B was focused,
	// naming the SAME reference -- exactly what a missed reload leaves.
	const staleRec = () => ({ link: { owner: 'D-B', id: 'link-B1' } });

	const { state, signalled, attachedOfCalls, confirmMarkHereCalls } =
		await toggle('D-A', links, staleRec, 'notes', true);

	if (BREAK === 'stale') {
		check('--break stale: the guard refuses the click outright',
			state.removed.length === 0 && state.added.length === 0 && !signalled,
			JSON.stringify(state));
		check('--break stale: the stale cache WAS consulted (that is the bug)',
			attachedOfCalls > 0);
	} else {
		check('CASE A: the cache is never even read',
			attachedOfCalls === 0, `attachedOf called ${attachedOfCalls} time(s)`);
		check('CASE A: only Diamond A\'s link is removed',
			state.removed.length === 1 && state.removed[0].owner === 'D-A'
				&& state.removed[0].id === 'link-A1',
			JSON.stringify(state.removed));
		check('CASE A: Diamond B is never named in any store call',
			!state.removed.some(r => r.owner === 'D-B') && !state.added.some(a => a.id === 'D-B'),
			JSON.stringify(state));
		check('CASE A: nothing is added (A already held a link, so this is a remove)',
			state.added.length === 0);
		check('CASE A: the repaint signal still fires', signalled === true);
		// The REAL markWaiting correctly reads a plain, already-in-force link as
		// not waiting -- the toggle goes straight to remove_link, never through
		// confirmMarkHere's door.
		check('CASE A: markWaiting never routes a plain link to confirmMarkHere',
			confirmMarkHereCalls === 0);
	}
}

// ── CASE B: a normal add-then-remove round trip, cache fresh ────────────
if (BREAK !== 'stale') {
	// Add: the store holds nothing for A yet.
	{
		const { state, signalled } = await toggle('D-A', {}, () => null, 'plans', true);
		check('CASE B add: add_link is called for the focused diamond',
			state.added.length === 1 && state.added[0].id === 'D-A', JSON.stringify(state.added));
		check('CASE B add: the link is written as a holds/user link on the right ref',
			state.added[0].self === 'diamond:D-A' && state.added[0].rel === 'holds'
				&& state.added[0].by === 'user' && state.added[0].ref === 'dir:plans');
		check('CASE B add: nothing is removed', state.removed.length === 0);
		check('CASE B add: the repaint signal fires', signalled === true);
	}
	// Remove: the store now holds A's link from the add above.
	{
		const links = { 'D-A': { owner: 'D-A', id: 'link-A9' } };
		const { state, signalled, confirmMarkHereCalls } = await toggle('D-A', links, () => null, 'plans', true);
		check('CASE B remove: remove_link is called with the store\'s own link',
			state.removed.length === 1 && state.removed[0].owner === 'D-A'
				&& state.removed[0].id === 'link-A9', JSON.stringify(state.removed));
		check('CASE B remove: nothing is added', state.added.length === 0);
		check('CASE B remove: the repaint signal fires', signalled === true);
		check('CASE B remove: markWaiting never routes a plain link to confirmMarkHere',
			confirmMarkHereCalls === 0);
	}
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${failures} check(s) failed`
		+ (failures ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(failures ? 0 : 1);
}
console.log(failures === 0
	? `\nverify_attach: all ${checks} checks passed`
	: `\nverify_attach: ${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
