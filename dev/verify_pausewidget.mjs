// verify_pausewidget.mjs — the PPTW, searched for its properties rather than
// walked down a happy path.
//
// The rule the whole control rests on (dev/NOTES2_PLAN.md §1.1):
//
//   A leaf is binary. A branch shows green when every leaf under it plays, red
//   when none does, and amber otherwise. AMBER IS DERIVED AND CAN NEVER BE SET.
//   Clicking a branch pauses all its leaves, or resumes them all.
//
// A test that pauses one thing and reads the flag back confirms the script. So
// this enumerates: every subset of the leaf set is built directly, and then
// EVERY control on the page is clicked from it, and the result is judged
// against a rule this file computes for itself from a tree it builds for
// itself out of the rail's DOM. `DaimondPause._core` is never consulted —
// checking the module against its own arithmetic would agree with it right up
// to the case that is wrong.
//
// WHAT THIS FILE LOCKS DOWN.
//
//  A. Amber is unreachable by clicking. From all 2^n leaf states, no click on
//     any single control leaves that control amber; the leaves under it come
//     out uniform; the leaves outside it do not move; and the widget draws what
//     the module says.
//  B. A branch agrees with its leaves — for the empty case, the all-paused
//     case, the all-playing case, and every mixed case in between.
//  C. The global control IS the root: pausing it pauses every leaf including
//     the worker pump, every tile shows it, and it holds no state of its own.
//  D. The old worker hold migrates. Seeded on a fresh profile, the pump comes
//     up held, the old key is gone, and the hold is enforced AT THE NETWORK —
//     a resumed agent sends nothing while the leaf is set.
//  E. Pause does not pause reading: a paused Diamond still opens, its crystal
//     still renders, and the workspace still lists.
//  F. The control is reachable and named: a button, in the tab order, answering
//     Enter and Space, with an accessible name that says which node it governs
//     and what the click will do.
//
// PROVED RED. Two ways. `--unbuilt` neuters the three new pieces before the app
// boots — no widget is built, no tree is registered, and the pump reads the old
// key — which is the page as it stood before this phase; every check above must
// fail there. And the self-test section at the foot breaks each property in the
// live page one at a time and requires the matching check to notice.
//
//   node dev/verify_pausewidget.mjs
//   node dev/verify_pausewidget.mjs --unbuilt     # must fail, loudly
//
// Needs a world: `eval "$(bash dev/world.sh N --up)"`. No gateway.

import fs from 'node:fs';
import { open, newChat, scratch, mockLog, clearMockLog } from './harness.mjs';

const UNBUILT = process.argv.includes('--unbuilt');

const out = [];
let bad = 0;
const check = (ok, what, detail) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail != null ? ' — ' + detail : ''}`);
	if (!ok) bad++;
	return ok;
};
const red = (wentRed, what) => check(wentRed, `[self-test] ${what}`);

/// Click a control through the browser's own hit-testing, or say it was not
/// there. Guarded because `--unbuilt` is a page with no controls on it at all,
/// and a throw there would end the run before it could report anything.
async function clickReal(page, sel) {
	const el = await page.$(sel);
	if (!el) return false;
	await el.click({ force: true }).catch(() => {});
	return true;
}

// ── The oracle: a tree and a rule this file owns ────────────────────
//
// Built from the rail's own DOM and the mail store, not from anything the
// module publishes, so "the branch agrees with its leaves" is checked against
// an independent reading of what exists rather than against the module's view
// of itself.

/// The module's id escaping, reimplemented. Two lines, and reimplementing them
/// is the point: a folder called "a/b" must not invent a level of tree.
const idOf = (...parts) => parts.filter((p) => p != null && p !== '')
	.map((p) => String(p).replace(/%/g, '%25').replace(/\//g, '%2F')).join('/');

/// Every leaf id at or under a node of OUR tree. A node with no `children`
/// array is a leaf; one with an empty array is an empty branch.
function leavesOf(node) {
	if (!node.children) return [node.id];
	return node.children.flatMap(leavesOf);
}

/// The rule, stated once, in this file.
function ruleFor(node, paused) {
	const leaves = leavesOf(node);
	if (!leaves.length) return 'play';			// an empty mailbox is not a paused one
	const n = leaves.filter((l) => paused.has(l)).length;
	return n === 0 ? 'play' : n === leaves.length ? 'pause' : 'mixed';
}

/// Walk our tree, node by node.
function* walk(node) {
	yield node;
	for (const kid of node.children || []) yield* walk(kid);
}

/// What is on the rail, read off the rail.
async function expectedTree(p) {
	const seen = await p.evaluate(() => {
		let mail = [];
		try {
			const j = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
			mail = (Array.isArray(j.accounts) ? j.accounts : []).filter((a) => a && a.address)
				.map((a) => ({ address: a.address, folders: Object.keys(a.folders || {}), sel: a.folder || 'INBOX' }));
		} catch (e) { /* none */ }
		return {
			// Each Diamond with the triggered actions it holds. Phase H made a
			// Diamond a branch with more than one leaf under it -- `pause.js`
			// documented that shape long before there were any -- so a file that
			// assumed one leaf per Diamond read every Diamond with a trigger as
			// "mixed" where it wanted "pause", and its click sweep expected a leaf
			// set that was one short.
			diamonds: [...document.querySelectorAll('.diamond-box')].map((e) => ({
				id: e.dataset.id,
				triggers: (() => {
					try {
						return (window.DaimondTriggersOf ? DaimondTriggersOf(e.dataset.id) : [])
							.filter((t) => t.id !== 'prompted').map((t) => t.id);
					} catch (x) { return []; }
				})(),
			})),
			chats:    [...document.querySelectorAll('.chat-box')].map((e) => e.dataset.id),
			mail,
		};
	});
	return {
		id: 'root',
		children: [
			{ id: 'root/diamonds', children: seen.diamonds.map((d) => ({
				id: idOf('root', 'diamonds', d.id),
				children: [{ id: idOf('root', 'diamonds', d.id, 'self') }].concat(
					(d.triggers || []).map((tid) =>
						({ id: idOf('root', 'diamonds', d.id, 'triggers', tid) }))),
			})) },
			{ id: 'root/chats', children: seen.chats.map((c) => ({ id: idOf('root', 'chats', c) })) },
			{ id: 'root/mail', children: seen.mail.map((a) => {
				const names = a.folders.includes(a.sel) ? a.folders.slice() : a.folders.concat([a.sel]);
				return { id: idOf('root', 'mail', a.address), children:
					[{ id: idOf('root', 'mail', a.address, 'self') }]
						.concat(names.sort().map((n) => ({ id: idOf('root', 'mail', a.address, n) }))) };
			}) },
			{ id: 'root/workers' },
			// Not a placement of the widget — the Web panel is phase C's surface —
			// but a leaf all the same, because a page fetch spends. Without it the
			// enforcement falls back to the root, and on an account with no
			// Diamonds the root has no leaves and reads green.
			{ id: 'root/web' },
		],
	};
}

// ── The run ─────────────────────────────────────────────────────────

const profile = scratch('pw', 'pptw-' + process.pid);
const s = await open({ name: 'pptw' + process.pid, profile });
const closeBrowser = s.close;
s.close = async () => {
	await closeBrowser();
	try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* gone */ }
};
const p = s.page;

// The unbuilt page: no widget is built, no tree is registered, and the pump
// reads the key this phase migrated away. Installed by rewriting the script as
// it is served to the page, so it is the OLD code that runs rather than the new
// code with a flag in it.
if (UNBUILT) {
	await p.route('**/js/daimond.js', async (route) => {
		const res = await route.fetch();
		let body = await res.text();
		body = body
			.replace('function pauseWidget(nodeId, name) {',
				'function pauseWidget(nodeId, name) { return document.createTextNode(""); /* UNBUILT */ // eslint-disable-line')
			.replace('DaimondPause.setTree(pauseTree);', '/* UNBUILT: no tree was registered */')
			.replace('function migrateWorkerHold() {', 'function migrateWorkerHold() { return; /* UNBUILT */')
			.replace('function workersHeld() {',
				'function workersHeld() { return localStorage.getItem(WORKERS_PAUSED_KEY) === "1"; /* UNBUILT */');
		await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
	});
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(1500);
	// The reload lands on the unlock screen, because the identity now exists.
	const gate = await p.$('#id-pass');
	if (gate && await gate.isVisible()) {
		await p.fill('#id-pass', 'testpass1234');
		await p.evaluate(() => document.getElementById('id-primary').click());
		await p.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 }).catch(() => {});
	}
	await p.waitForTimeout(2000);
	const broke = s.errs.filter((e) => !/favicon|401|402|502|Unauthorized|Payment|Bad Gateway/i.test(e));
	if (broke.length) console.log('unbuilt page errors:', JSON.stringify(broke.slice(0, 4)));
}

await p.waitForTimeout(800);

// Two Diamonds and two chats, so a section can be genuinely mixed rather than
// merely half of one thing.
async function newDiamond(name) {
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 10000 });
	await p.fill('.dlg-input', name);
	await p.click('.dlg-ok', { force: true });
	await p.waitForTimeout(700);
}
await newDiamond('Alpha');
await newDiamond('Beta');
await newChat(s);
await p.click('#new-session-btn', { force: true });
await p.waitForTimeout(400);
{
	const start = p.locator('.tile-start').first();
	if (await start.count()) await start.click({ force: true });
}
await p.waitForTimeout(900);
{
	const drawer = p.locator('#admin-close');
	if (await drawer.isVisible().catch(() => false)) { await drawer.click({ force: true }); await p.waitForTimeout(300); }
}

const tree   = await expectedTree(p);
const nodes  = [...walk(tree)];
const leaves = nodes.filter((n) => !n.children).map((n) => n.id);
const byId   = new Map(nodes.map((n) => [n.id, n]));

check(leaves.length >= 5, `the page carries enough leaves to search (${leaves.length}: ${leaves.join(', ')})`,
	leaves.length < 5 ? JSON.stringify(leaves) : null);

/// Every control on the page, and the node each governs.
const controls = () => p.evaluate(() => [...document.querySelectorAll('.pptw')].map((b) => ({
	node: b.dataset.pauseNode, name: b.dataset.pauseName,
	state: b.dataset.state, label: b.getAttribute('aria-label'),
	tag: b.tagName.toLowerCase(),
	inTabOrder: b.matches('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])'),
	iconHidden: [...b.querySelectorAll('svg')].every((g) => g.getAttribute('aria-hidden') === 'true'),
	where: b.closest('.diamond-box') ? 'diamond' : b.closest('.chat-box') ? 'chat'
		: b.closest('#pptw-global-row') ? 'global' : 'other',
})));

const ctl = await controls();
check(ctl.length >= 5, `a control is on each placement (${ctl.length} found)`,
	JSON.stringify(ctl.map((c) => c.where + ':' + c.node)));
check(ctl.some((c) => c.where === 'global'), 'one at the top of the rail, above the Diamonds list');
// One per Diamond ON THE RAIL, whatever else the account holds. It used to be the
// literal 2, which was the number of Diamonds this file happens to make -- and
// phase H seeds two more (Daimond Help, Daimond Optimiser), so the constant said
// four were two. A tile's own light is what is under test; the count of tiles is
// the app's business.
const tiles = await p.evaluate(() =>
	document.querySelectorAll('#diamond-list .diamond-box').length);
check(ctl.filter((c) => c.where === 'diamond').length === tiles, 'one on each Diamond tile',
	`${ctl.filter((c) => c.where === 'diamond').length} of ${tiles}`);
check(ctl.filter((c) => c.where === 'chat').length >= 2, 'one on each chat tile',
	`${ctl.filter((c) => c.where === 'chat').length}`);

// ── F. Reachable and named ──────────────────────────────────────────
check(ctl.length > 0 && ctl.every((c) => c.tag === 'button'),
	'every control is a real <button>', JSON.stringify(ctl.map((c) => c.tag)));
check(ctl.length > 0 && ctl.every((c) => c.inTabOrder),
	'every control is in the tab order, like the rest of the rail');
check(ctl.length > 0 && ctl.every((c) => c.iconHidden),
	'its icon is aria-hidden, so it is not read out beside its own label');
check(ctl.length > 0 && ctl.every((c) => c.label && /[\p{L}\p{N}]/u.test(c.label)),
	'every control has an accessible name that is not bare punctuation',
	JSON.stringify(ctl.map((c) => c.label).slice(0, 3)));
// The name has to say WHICH node and WHAT the click does; five lights on a rail
// that all announce "Pause" are five identical controls.
{
	const names = ctl.filter((c) => c.where !== 'global').map((c) => c.label);
	check(names.length > 0 && new Set(names).size === names.length,
		'no two controls announce the same thing', JSON.stringify(names));
	const alpha = ctl.find((c) => c.name === 'Alpha');
	check(!!alpha && /Alpha/.test(alpha.label || '') && /(Pause|Resume)/.test(alpha.label || ''),
		'the name carries the node and the action', JSON.stringify(alpha && alpha.label));
}

// ── A. Amber is unreachable by clicking ─────────────────────────────
//
// Every subset of the leaves, times every control. The leaves are set DIRECTLY
// -- never through a control -- so the starting state is genuinely arbitrary
// rather than something a click could reach.
const sweep = await p.evaluate(({ leaves, nodeIds }) => {
	const rows = [];
	if (!window.DaimondPause) return rows;
	const btnFor = (n) => document.querySelector(`.pptw[data-pause-node="${n}"]`);
	const live = nodeIds.filter(btnFor);
	for (let m = 0; m < (1 << leaves.length); m++) {
		for (const node of live) {
			DaimondPause.set('root', true);
			for (let i = 0; i < leaves.length; i++) if (m & (1 << i)) DaimondPause.set(leaves[i], false);
			const before = leaves.map((l) => DaimondPause.isPaused(l));
			const b = btnFor(node);
			const shown = b.dataset.state;
			b.click();
			rows.push({
				m, node, shown,
				after:   b.dataset.state,
				said:    DaimondPause.state(node),
				beforeL: before,
				afterL:  leaves.map((l) => DaimondPause.isPaused(l)),
			});
		}
	}
	return rows;
}, { leaves, nodeIds: nodes.map((n) => n.id) });

check(sweep.length > 0, `the sweep ran (${sweep.length} clicks over ${1 << leaves.length} leaf states)`);

{
	// Every judgement below requires the sweep to have RUN. A page with no
	// controls on it makes "no click reaches amber" true and meaningless, and a
	// check that cannot fail is not evidence.
	const ran = sweep.length > 0;
	const amber = sweep.filter((r) => r.after === 'mixed' || r.said === 'mixed');
	check(ran && amber.length === 0,
		'NO click on any control, from any of the leaf states, leaves that control amber',
		amber.length ? `${amber.length} did, e.g. ${JSON.stringify(amber[0])}` : null);

	const disagree = sweep.filter((r) => r.after !== r.said);
	check(ran && disagree.length === 0,
		'the widget always draws what the module says the node is',
		disagree.length ? JSON.stringify(disagree[0]) : null);

	// The leaves under the clicked node come out uniform, and everything else
	// is left exactly as it was.
	const smeared = [], bled = [];
	for (const r of sweep) {
		const under = new Set(leavesOf(byId.get(r.node)));
		const inSet  = leaves.filter((l) => under.has(l));
		const outSet = leaves.map((l, i) => [l, i]).filter(([l]) => !under.has(l));
		const vals = inSet.map((l) => r.afterL[leaves.indexOf(l)]);
		if (new Set(vals).size > 1) smeared.push(r);
		for (const [, i] of outSet) if (r.afterL[i] !== r.beforeL[i]) { bled.push(r); break; }
	}
	check(ran && smeared.length === 0,
		'a click sets EVERY leaf under the node it was on, to the same thing',
		smeared.length ? JSON.stringify(smeared[0]) : null);
	check(ran && bled.length === 0,
		'and touches no leaf outside it',
		bled.length ? JSON.stringify(bled[0]) : null);

	// Wholly playing pauses; anything else — including amber — resumes.
	const wrongWay = sweep.filter((r) => r.after !== (r.shown === 'play' ? 'pause' : 'play'));
	check(ran && wrongWay.length === 0,
		'a node wholly playing pauses; a paused OR amber node resumes',
		wrongWay.length ? JSON.stringify(wrongWay[0]) : null);
}

// ── B. A branch agrees with its leaves ──────────────────────────────
//
// Same enumeration, judged against this file's rule rather than the module's.
{
	const asked = await p.evaluate(({ leaves, all }) => {
		const rows = [];
		if (!window.DaimondPause) return rows;
		for (let m = 0; m < (1 << leaves.length); m++) {
			DaimondPause.set('root', true);
			for (let i = 0; i < leaves.length; i++) if (m & (1 << i)) DaimondPause.set(leaves[i], false);
			const said = {};
			for (const id of all) said[id] = DaimondPause.state(id);
			const painted = {};
			for (const b of document.querySelectorAll('.pptw')) painted[b.dataset.pauseNode] = b.dataset.state;
			rows.push({ m, said, painted });
		}
		return rows;
	}, { leaves, all: nodes.map((n) => n.id) });

	let wrongSaid = null, wrongPainted = null, cases = 0, mixedSeen = 0;
	for (const row of asked) {
		const paused = new Set(leaves.filter((l, i) => row.m & (1 << i)));
		for (const n of nodes) {
			const want = ruleFor(n, paused);
			if (want === 'mixed') mixedSeen++;
			cases++;
			if (row.said[n.id] !== want && !wrongSaid) {
				wrongSaid = { node: n.id, want, got: row.said[n.id], paused: [...paused] };
			}
			if (row.painted[n.id] !== undefined && row.painted[n.id] !== want && !wrongPainted) {
				wrongPainted = { node: n.id, want, got: row.painted[n.id], paused: [...paused] };
			}
		}
	}
	check(asked.length === (1 << leaves.length),
		`every leaf state was tried (${asked.length} of ${1 << leaves.length})`);
	check(!wrongSaid, `every node's state matches the rule in all ${cases} node-states`,
		wrongSaid ? JSON.stringify(wrongSaid) : null);
	check(ctl.length > 0 && !wrongPainted, 'and every control on screen is painted that colour',
		wrongPainted ? JSON.stringify(wrongPainted) : `${ctl.length} controls`);
	check(mixedSeen > 0, `amber really was reached by setting leaves directly (${mixedSeen} node-states)`);

	// The empty branch. `root/mail` has no mailbox on this profile, and an empty
	// section reads green: calling it red would open a new account's rail red.
	const empties = nodes.filter((n) => n.children && n.children.length === 0);
	const emptySaid = await p.evaluate((ids) => {
		DaimondPause.set('root', false);		// everything paused, so green here means the RULE
		const o = {};
		for (const id of ids) o[id] = DaimondPause.state(id);
		return o;
	}, empties.map((n) => n.id));
	check(empties.length > 0, `there is an empty branch to test (${empties.map((n) => n.id).join(', ')})`);
	check(empties.every((n) => emptySaid[n.id] === 'play'),
		'an empty branch reads green even with everything else paused',
		JSON.stringify(emptySaid));
	// And it holds no flag of its own: an empty branch emitted as a LEAF would
	// take one, and nothing could ever resume it.
	const stray = await p.evaluate((ids) => DaimondPause.pausedIds().filter((k) => ids.indexOf(k) !== -1),
		empties.map((n) => n.id));
	check(stray.length === 0, 'and pausing the root wrote no phantom id for it', JSON.stringify(stray));
}

// ── C. The global control is the root ───────────────────────────────
{
	const g = ctl.find((c) => c.where === 'global');
	check(!!g && g.node === 'root', 'the global control governs `root`, not a setting of its own',
		JSON.stringify(g && g.node));

	const paused = await p.evaluate(() => {
		// Everything explicitly resumed leaf by leaf, NOT through `set('root')`:
		// with no tree registered that call reaches no leaf, and the section
		// would then judge a state left over from the sweep above.
		for (const id of DaimondPause.pausedIds()) DaimondPause.set(id, true);
		const before = DaimondPause.pausedIds();
		const b = document.querySelector('#pptw-global .pptw');
		if (!b) return { before, after: null, tiles: [], keys: [] };
		b.click();
		return {
			before,
			after: DaimondPause.pausedIds(),
			tiles: [...document.querySelectorAll('.pptw')].map((x) => x.dataset.state),
			keys:  Object.keys(localStorage).filter((k) => /pause/i.test(k)),
		};
	});
	const want = leaves.slice().sort();
	check(paused.before.length === 0, 'the tree starts clear for this section',
		JSON.stringify(paused.before));
	check(!!paused.after && JSON.stringify(paused.after) === JSON.stringify(want),
		'pausing it pauses every leaf in the tree, and only those',
		`got ${JSON.stringify(paused.after)} want ${JSON.stringify(want)}`);
	check(paused.tiles.length > 0 && paused.tiles.every((x) => x === 'pause'),
		'and every per-tile control shows it', JSON.stringify(paused.tiles));
	check(!!paused.after && paused.after.indexOf('root/workers') !== -1,
		'including the worker pump, which is a leaf of the same tree and not a second flag');
	check(JSON.stringify(paused.keys) === JSON.stringify(['daimond-pause']),
		'one store holds the whole tree', JSON.stringify(paused.keys));

	const back = await p.evaluate(() => {
		const b = document.querySelector('#pptw-global .pptw');
		if (!b) return null;
		b.click();
		return { ids: DaimondPause.pausedIds(), tiles: [...document.querySelectorAll('.pptw')].map((x) => x.dataset.state) };
	});
	check(!!back && back.ids.length === 0 && back.tiles.length > 0 && back.tiles.every((x) => x === 'play'),
		'and clicking it again resumes everything', JSON.stringify(back));
}

// ── F (continued). Enter and Space ──────────────────────────────────
{
	const node = await p.evaluate(() => {
		const b = document.querySelector('.diamond-box .pptw');
		if (!b) return null;
		b.focus();
		return { node: b.dataset.pauseNode, focused: document.activeElement === b, state: b.dataset.state };
	});
	check(!!node && node.focused, 'a control takes the focus');
	if (node) {
		await p.keyboard.press('Enter');
		await p.waitForTimeout(200);
		const afterEnter = await p.evaluate((n) => DaimondPause.state(n), node.node);
		check(afterEnter !== node.state, 'Enter on it toggles the node', `${node.state} -> ${afterEnter}`);
		await p.keyboard.press(' ');
		await p.waitForTimeout(200);
		const afterSpace = await p.evaluate((n) => DaimondPause.state(n), node.node);
		check(afterSpace === node.state, 'and Space toggles it back', `-> ${afterSpace}`);
	}
	// A real pointer click, through the browser's own hit-testing: the tile
	// underneath opens on click, and the light must not open it.
	const opened = await p.evaluate(() => {
		for (const id of DaimondPause.pausedIds()) DaimondPause.set(id, true);
		const box = document.querySelector('.diamond-box');
		return {
			name: (document.getElementById('current-session-name') || {}).textContent || '',
			id: box.dataset.id, ids: DaimondPause.pausedIds(),
		};
	});
	const hit = await clickReal(p, '.diamond-box .pptw');
	check(hit, 'there is a light on a Diamond tile for a pointer to hit');
	await p.waitForTimeout(400);
	const afterClick = await p.evaluate(() => ({
		name: (document.getElementById('current-session-name') || {}).textContent || '',
		ids: DaimondPause.pausedIds(),
	}));
	check(hit && opened.ids.length === 0 && afterClick.ids.length > 0,
		'a pointer click on the light pauses the Diamond, from nothing paused',
		`${JSON.stringify(opened.ids)} -> ${JSON.stringify(afterClick.ids)}`);
	check(hit && afterClick.name === opened.name,
		'and does NOT open the tile it sits on', `${JSON.stringify(opened.name)} -> ${JSON.stringify(afterClick.name)}`);
}

// ── E. Pause does not pause reading ─────────────────────────────────
{
	// Everything paused, then the Diamond is opened the way a person opens it.
	await p.evaluate(() => DaimondPause.set('root', false));
	await p.waitForTimeout(200);
	await p.evaluate(() => document.querySelector('.diamond-box').click());
	await p.waitForTimeout(1200);
	const reading = await p.evaluate(() => {
		const cv = document.getElementById('crystal-view');
		const cb = document.getElementById('crystal-body');
		return {
			name:    ((document.getElementById('current-session-name') || {}).textContent || '').trim(),
			crystal: !!(cv && cv.getClientRects().length),
			body:    !!(cb && cb.innerHTML.length > 0),
			paused:  DaimondPause.pausedIds().length,
		};
	});
	check(reading.paused > 0, 'the tree really is paused for this check', `${reading.paused} leaves`);
	check(!!reading.name, 'a paused Diamond still opens', JSON.stringify(reading.name));
	check(reading.crystal, 'and its crystal view is on screen');
	check(reading.body, 'and the crystal rendered something');

	// And the workspace still lists. Opened through the dock chip a person uses,
	// with a file put in it — writing a file is not spending, so a paused app
	// must still do it, and a tree that says "empty" would prove nothing.
	await p.evaluate(() => {
		const c = document.querySelector('#panel-tags .ptag[data-panel="work"]');
		if (c && !document.getElementById('panel-work').getClientRects().length) c.click();
	});
	await p.waitForTimeout(1200);
	await p.click('#panel-work [data-act="new-file"]', { force: true }).catch(() => {});
	await p.waitForSelector('.dlg-input', { timeout: 8000 }).catch(() => {});
	await p.fill('.dlg-input', 'held.txt').catch(() => {});
	await p.click('.dlg-ok', { force: true }).catch(() => {});
	await p.waitForTimeout(1500);
	const files = await p.evaluate(() => {
		const w = document.getElementById('panel-work');
		const tree = w && w.querySelector('.files-tree');
		return {
			open: !!(w && w.getClientRects().length),
			rows: tree ? tree.children.length : 0,
			text: tree ? (tree.innerText || '').slice(0, 80) : '',
		};
	});
	check(files.open, 'the workspace panel opens while everything is paused');
	check(/held\.txt/.test(files.text), 'a file written while paused is there, and listed',
		`${files.rows} rows: ${JSON.stringify(files.text)}`);
	await p.evaluate(() => DaimondPause.set('root', true));
	await p.waitForTimeout(200);
}

// ── Self-tests: each check shown going red ──────────────────────────
out.push('');
out.push('--- self-test: breaking each property in the live page');

// (a) A control that kept its markup and lost its listener still LOOKS operable
// and answers nothing, which is the regression the sweep exists to catch.
{
	const r = await p.evaluate(() => {
		DaimondPause.set('root', true);
		const b = document.querySelector('.diamond-box .pptw');
		if (!b) return { was: 'no control', now: 'no control at all' };
		const twin = b.cloneNode(true);
		b.parentNode.replaceChild(twin, b);
		const was = DaimondPause.state(twin.dataset.pauseNode);
		twin.click();
		const now = DaimondPause.state(twin.dataset.pauseNode);
		return { was, now };
	});
	red(r.was === r.now, 'a control that lost its listener fails the toggle rule');
	await p.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:pause')));
	await p.waitForTimeout(200);
}

// (b) A painted state frozen away from the module's answer.
{
	const r = await p.evaluate(() => {
		DaimondPause.set('root', true);
		const b = document.querySelector('.chat-box .pptw');
		if (!b) return { said: 'no control', painted: 'no control' };
		DaimondPause.set(b.dataset.pauseNode, false);		// really paused
		b.dataset.state = 'play';							// but drawn green
		return { said: DaimondPause.state(b.dataset.pauseNode), painted: b.dataset.state };
	});
	red(r.said !== r.painted, 'a widget whose colour stops tracking the module is caught');
	await p.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:pause')));
	await p.waitForTimeout(200);
	const fixed = await p.evaluate(() => {
		const b = document.querySelector('.chat-box .pptw');
		if (!b) return { said: 'no control', painted: 'none' };
		return { said: DaimondPause.state(b.dataset.pauseNode), painted: b.dataset.state };
	});
	red(fixed.said === fixed.painted, 'and it agrees again once the repaint runs');
}

// (c) A branch click that sets only ONE of its leaves: the "uniform" check has
// to notice, because that is exactly how a user-settable amber would arrive.
{
	const r = await p.evaluate(() => {
		DaimondPause.set('root', true);
		const [a, b] = [...document.querySelectorAll('.diamond-box .pptw')];
		if (!a || !b) return null;
		DaimondPause.set(a.dataset.pauseNode, false);		// half the Diamonds section
		return { section: DaimondPause.state('root/diamonds'), root: DaimondPause.state('root') };
	});
	red(!!r && r.section === 'mixed' && r.root === 'mixed',
		'half a section set by hand really does read amber (so the sweep would catch a click that did it)');
}

// (d) The rule itself, applied to a tree with a leaf the module does not know
// about: the state of an unknown id must not silently answer green.
{
	const r = await p.evaluate(() => {
		DaimondPause.set('root', true);
		DaimondPause.seedPaused('root/diamonds/ghost/self');
		const st = DaimondPause.state('root/diamonds');
		DaimondPause.forget('root/diamonds/ghost');
		return { st, after: DaimondPause.state('root/diamonds') };
	});
	red(r.st === 'play' && r.after === 'play',
		'a stale id outside the tree colours nothing, and forget() clears it');
}

// (e) The global control, bound to a section instead of the root — which is
// what "a seventh setting" would look like from the outside. The node is baked
// into the handler's closure, not read off the dataset, so a stand-in with its
// own listener is the only way to express the wrong wiring; that the DATASET
// cannot be edited to change behaviour is itself worth knowing.
{
	const r = await p.evaluate(() => {
		DaimondPause.set('root', true);
		const b = document.querySelector('#pptw-global .pptw');
		if (!b) return null;
		const twin = b.cloneNode(true);
		twin.addEventListener('click', function () { DaimondPause.toggle('root/chats'); });
		b.parentNode.replaceChild(twin, b);
		twin.click();
		const ids = DaimondPause.pausedIds();
		twin.parentNode.replaceChild(b, twin);		// the real control back
		DaimondPause.set('root', true);
		return ids;
	});
	red(!!r && r.indexOf('root/workers') === -1,
		'a global control wired to a section no longer pauses the worker pump');
	await p.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:pause')));
	const good = await p.evaluate(() => {
		const b = document.querySelector('#pptw-global .pptw');
		if (!b) return [];
		b.click();
		const ids = DaimondPause.pausedIds();
		b.click();
		return ids;
	});
	red(good && good.indexOf('root/workers') !== -1, 'and the real one pauses it again');
}

await s.close();

// ── D. The migration, on its own fresh profile ──────────────────────
//
// A second browser, because the point is what happens on a FIRST load that
// finds the old key: the app must come up held.
{
	const prof2 = scratch('pw', 'pptwmig-' + process.pid);
	const s2 = await open({ name: 'pptwmig' + process.pid, profile: prof2 });
	const p2 = s2.page;
	// A real Diamond for the agent to belong to: a worker for a Diamond that
	// does not exist cannot be scoped, so it would fail on its own account and
	// "nothing reached the provider" would be true for the wrong reason.
	await p2.click('#new-diamond-btn', { force: true });
	await p2.waitForSelector('.dlg-input', { timeout: 10000 });
	await p2.fill('.dlg-input', 'Held');
	await p2.click('.dlg-ok', { force: true });
	await p2.waitForTimeout(900);
	const did = await p2.evaluate(() => (document.querySelector('.diamond-box') || {}).dataset.id);
	check(!!did, 'the migration profile has a Diamond for the held agent to work for', did);

	// Seed the world as a user who paused their workers yesterday: the old key
	// set, and no pause tree at all.
	await p2.evaluate((d) => {
		localStorage.setItem('daimond-workers-paused', '1');
		localStorage.removeItem('daimond-pause');
		// One paused agent, so the pump's hold has something to hold.
		localStorage.setItem('daimond-workers', JSON.stringify([{
			id: 'w1', name: 'yesterday', task: 'Say the word ready.', diamondId: d, diamondName: 'Held',
			model: 'mock/fast', provider: 'custom', status: 'paused', text: 'half done', tools: [],
			promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0,
		}]));
		localStorage.setItem('daimond-agents-revealed', '1');
	}, did);
	if (UNBUILT) {
		await p2.route('**/js/daimond.js', async (route) => {
			const res = await route.fetch();
			let body = await res.text();
			body = body
				.replace('function migrateWorkerHold() {', 'function migrateWorkerHold() { return; /* UNBUILT */')
				.replace('function workersHeld() {',
					'function workersHeld() { return localStorage.getItem(WORKERS_PAUSED_KEY) === "1"; /* UNBUILT */');
			await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
		});
	}
	await p2.reload({ waitUntil: 'domcontentloaded' });
	await p2.waitForTimeout(1200);
	// The reload lands on the unlock screen; get back in the way a person does.
	const gate = await p2.$('#id-pass');
	if (gate && await gate.isVisible()) {
		await p2.fill('#id-pass', 'testpass1234');
		await p2.evaluate(() => document.getElementById('id-primary').click());
		await p2.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 }).catch(() => {});
	}
	await p2.waitForTimeout(2000);

	const mig = await p2.evaluate(() => ({
		ids:    window.DaimondPause ? DaimondPause.pausedIds() : null,
		oldKey: localStorage.getItem('daimond-workers-paused'),
		holding: !!(document.getElementById('agents-ctl') || {}).classList
			&& document.getElementById('agents-ctl').classList.contains('holding'),
		tiles:  [...document.querySelectorAll('.acard')].map((c) => c.className),
	}));
	check(!!mig.ids && mig.ids.indexOf('root/workers') !== -1,
		'a hold set under the OLD key comes up as `root/workers` in the tree', JSON.stringify(mig.ids));
	check(mig.oldKey === null, 'and the old key is gone, so nothing writes two answers again',
		JSON.stringify(mig.oldKey));
	check(mig.holding, 'the Agents panel shows the pump held, which is the hold reaching the UI');

	// And at the NETWORK: resuming that one agent queues it and sends nothing,
	// because the pump reads the leaf. Measured in the mock's log, not in a flag.
	clearMockLog();
	const before = mockLog().length;
	await p2.evaluate(() => {
		const b = [...document.querySelectorAll('.abtn.a-play')][0];
		if (b) b.click();
	});
	await p2.waitForTimeout(3000);
	const sent = mockLog().length - before;
	check(sent === 0, 'resuming an agent while the pump is held sends NOTHING to the provider',
		`${sent} requests reached the mock`);

	// Release it through the GLOBAL CONTROL -- the button, not the module -- and
	// the same agent goes. Measured at the network again, in the other
	// direction: the pump reads the tree, so releasing the tree lets it out.
	const released = await clickReal(p2, '#pptw-global .pptw');
	check(released, 'there is a global control to release the hold with');
	for (let i = 0; i < 40 && mockLog().length - before === 0; i++) await p2.waitForTimeout(300);
	const after = mockLog().length - before;
	const status = await p2.evaluate(() =>
		[...document.querySelectorAll('.acard')].map((c) => c.className).join(' '));
	check(after > 0,
		'and the global control releases it — the held agent reaches the provider',
		`${after} requests, tiles: ${status}`);

	await s2.close();
	try { fs.rmSync(prof2, { recursive: true, force: true }); } catch (e) { /* gone */ }
}

console.log(out.join('\n'));
const total = out.filter((l) => /^(PASS|FAIL)/.test(l)).length;
if (UNBUILT) {
	console.log(`\nUNBUILT RUN: ${bad} of ${total} checks failed. `
		+ (bad > 0 ? 'Good — the checks see the missing control.' : 'BAD — a check that cannot fail is not evidence.'));
	process.exit(bad > 0 ? 0 : 1);
}
console.log(bad === 0 ? `\nALL ${total} CHECKS PASSED` : `\n${bad} of ${total} FAILED`);
process.exit(bad === 0 ? 0 : 1);
