// verify_pausewidget.mjs — the PPTW, searched for its properties rather than
// walked down a happy path.
//
// The rule the whole control rests on (dev/NOTES2_PLAN.md §1.1):
//
//   A leaf is binary. A branch shows green when every leaf under it plays, red
//   when none does, and amber otherwise. AMBER IS DERIVED AND CAN NEVER BE SET.
//   Pausing a branch pauses all its leaves; resuming it resumes them all.
//
// THE CONTROL IS THREE THINGS, IN THE ORDER ITS NAME GIVES. notes2.txt line 3:
// "Pause/Play/Traffic light widgets (PPTWs) for all spendable functions. Green
// = all spendable functions active, Amber = some are active, Red = all paused."
//
//   a PLAY           a verb
//   a PAUSE          a verb
//   a TRAFFIC LIGHT  a coloured disc, LAST, with NOTHING inside it
//
// It was briefly one button drawn from `data-state`, which put a green PLAY
// triangle on a running node — the colour said "running" while the shape said
// "play" and the only thing pressing it could do was pause. The first rebuild
// then put that same glyph inside the lamp and led with it, which is the same
// confusion one place to the right. Both the ORDER and the EMPTINESS of the
// light are checked below, because both have been got wrong.
//
// Both verbs are always present; the inapplicable one is DISABLED, not hidden.
// On a leaf exactly one is ever live. ON AN AMBER BRANCH BOTH ARE — which is
// the property one button could not have: a single control had to guess, and
// `clickWould` guessed resume-all with nothing on screen to say so.
//
// A test that pauses one thing and reads the flag back confirms the script. So
// this enumerates: every subset of the leaf set is built directly, and then
// EVERY verb of EVERY control on the page is pressed from it, and the result is
// judged against a rule this file computes for itself from a tree it builds for
// itself out of the rail's DOM. `DaimondPause._core` is never consulted —
// checking the module against its own arithmetic would agree with it right up
// to the case that is wrong.
//
// WHAT THIS FILE LOCKS DOWN.
//
//  A. A verb does what it says, from all 2^n leaf states: pause leaves the node
//     red, play leaves it green, neither ever leaves it amber; the leaves under
//     it come out uniform; the leaves outside it do not move; and the light
//     draws what the module says.
//  A2. WHICH VERB IS OFFERED matches the state — pause alone when running, play
//     alone when paused, BOTH when amber — and the light is not a control.
//  B. A branch agrees with its leaves — for the empty case, the all-paused
//     case, the all-playing case, and every mixed case in between.
//  C. The global control IS the root: pausing it pauses every leaf including
//     the worker pump, every tile shows it, and it holds no state of its own.
//  D. The old worker hold migrates. Seeded on a fresh profile, the pump comes
//     up held, the old key is gone, and the hold is enforced AT THE NETWORK —
//     a resumed agent sends nothing while the leaf is set.
//  E. Pause does not pause reading: a paused Diamond still opens, its crystal
//     still renders, and the workspace still lists.
//  F. The verbs are reachable and named: real buttons, in the tab order,
//     answering Enter and Space, each with an accessible name that says which
//     node it governs and which verb it is — and the light beside them is
//     named, unfocusable and inert.
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
							.map((t) => t.id);
					} catch (x) { return []; }
				})(),
			// A Diamond with NO triggered actions is not in the tree at all --
			// not even a `self` leaf. It has nothing that spends without being
			// asked, so there is nothing to hold; the `prompted` action that used
			// to give every Diamond one has been removed as decoration. Filtered
			// here rather than mapped to an empty node, because an empty branch
			// and an absent one are different things to `leavesUnder`.
			})).filter((d) => d.triggers.length > 0),
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

// GIVE THEM SOMETHING TO GOVERN. A Diamond with no triggered actions has no
// pause node and no widget — prompting it is the activation, so a control would
// stand for a decision already made by typing. That is the product rule, and it
// leaves this file, which is about the WIDGET, with nothing to point at. So each
// of these two gets a timer, exactly as the Optimiser ships with one.
await p.evaluate(async () => {
	const ids = [...document.querySelectorAll('.diamond-box')].map((e) => e.dataset.id);
	for (const id of ids) {
		if ((DaimondTriggersOf(id) || []).length) continue;   // the Optimiser has one already
		const ta = DaimondTriggers.blank('activity');
		ta.id = 'activity-1';
		ta.instruction = 'Say one useful thing.';
		await DaimondCore.triggerSet(id, ta);
	}
});
await p.waitForTimeout(700);
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

/// Every control on the page, and the node each governs. A control is now the
/// GROUP — the light and the two verbs — so each is read as its three parts.
const controls = () => p.evaluate(() => [...document.querySelectorAll('.pptw')].map((g) => {
	const lamp = g.querySelector('.pptw-lamp');
	const part = (b) => ({
		act: b.dataset.act,
		tag: b.tagName.toLowerCase(),
		disabled: !!b.disabled,
		label: b.getAttribute('aria-label'),
		// Enabled buttons are in the tab order; a DISABLED one is deliberately
		// not, and must not be counted against it.
		inTabOrder: b.matches('button:not([disabled]),[tabindex]:not([tabindex="-1"])') || b.disabled,
		iconHidden: [...b.querySelectorAll('svg')].every((s) => s.getAttribute('aria-hidden') === 'true'),
	});
	return {
		node: g.dataset.pauseNode, name: g.dataset.pauseName,
		state: g.dataset.state,
		tag: g.tagName.toLowerCase(),
		lamp: lamp ? {
			tag: lamp.tagName.toLowerCase(),
			role: lamp.getAttribute('role'),
			label: lamp.getAttribute('aria-label'),
			// Focusable at all? `tabIndex >= 0` is the browser's own answer, and it
			// is 0 for a <button> even without the attribute.
			focusable: lamp.tabIndex >= 0,
			// EMPTY is the specification. Anything at all inside the lamp -- an
			// svg, a path, a character -- is a glyph, and a glyph in a light is a
			// verb worn as a noun.
			inside: lamp.innerHTML.trim(),
			kids: lamp.childElementCount,
		} : null,
		// The DOM order, which is the reading order and the tab order both.
		order: [...g.children].map((e) => e.dataset.act || (e.classList.contains('pptw-lamp') ? 'lamp' : '?')),
		acts: [...g.querySelectorAll('.pptw-act')].map(part),
		where: g.closest('.diamond-box') ? 'diamond' : g.closest('.chat-box') ? 'chat'
			: g.closest('#pptw-global-row') ? 'global' : 'other',
	};
}));

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
const acts = ctl.flatMap((c) => c.acts);
check(ctl.length > 0 && ctl.every((c) => c.acts.length === 2),
	'every control carries exactly two verbs', JSON.stringify(ctl.map((c) => c.acts.length)));
// THE ORDER IS THE SPECIFICATION, notes2.txt line 3 and the widget's own name.
// Play, pause, then the traffic light on the right. Got this backwards once --
// light first, with a glyph in it -- so it is pinned rather than assumed.
check(ctl.length > 0 && ctl.every((c) => JSON.stringify(c.order) === '["play","pause","lamp"]'),
	'PLAY, PAUSE, THEN THE LIGHT — in that order, at every placement',
	JSON.stringify(ctl.map((c) => c.order)));
check(acts.length > 0 && acts.every((a) => a.tag === 'button'),
	'every verb is a real <button>', JSON.stringify([...new Set(acts.map((a) => a.tag))]));
check(acts.length > 0 && acts.every((a) => a.inTabOrder),
	'every live verb is in the tab order, like the rest of the rail');
check(acts.length > 0 && acts.every((a) => a.iconHidden),
	'its glyph is aria-hidden, so it is not read out beside its own label');
check(acts.length > 0 && acts.every((a) => a.label && /[\p{L}\p{N}]/u.test(a.label)),
	'every verb has an accessible name that is not bare punctuation',
	JSON.stringify(acts.map((a) => a.label).slice(0, 3)));

// THE LIGHT IS NOT A CONTROL. This is what makes "amber can never be set" true
// by construction: there is no press that could set it.
const lamps = ctl.map((c) => c.lamp);
check(lamps.length > 0 && lamps.every((l) => l && l.tag !== 'button'),
	'the light is not a button', JSON.stringify(lamps.map((l) => l && l.tag)));
check(lamps.length > 0 && lamps.every((l) => l && !l.focusable),
	'and it is not focusable — nothing about it says it can be pressed',
	JSON.stringify(lamps.map((l) => l && l.focusable)));
check(lamps.length > 0 && lamps.every((l) => l && l.role === 'img' && l.label && /[\p{L}\p{N}]/u.test(l.label)),
	'but it is still announced, and says what it is showing',
	JSON.stringify(lamps.map((l) => l && l.label).slice(0, 3)));
// THE LIGHT IS EMPTY. Colour is the whole signal. A glyph inside it is a verb
// worn as a noun — the exact fault the compact single button had, moved one
// place to the right — so "nothing inside" is checked as literally as it reads.
check(lamps.length > 0 && lamps.every((l) => l && l.kids === 0 && l.inside === ''),
	'AND IT CARRIES NOTHING BUT A COLOUR — no glyph, no symbol, nothing inside it',
	JSON.stringify(lamps.map((l) => l && l.inside).slice(0, 3)));

// The names have to say WHICH node; five rails of "Pause" are five identical
// controls. The verb's name says the ACT, the light's says the STATE — never
// the other way round, which is the whole fault this rebuild answers.
{
	const names = ctl.filter((c) => c.where !== 'global').flatMap((c) => c.acts.map((a) => a.label));
	check(names.length > 0 && new Set(names).size === names.length,
		'no two verbs on the page announce the same thing', JSON.stringify(names));
	const alpha = ctl.find((c) => c.name === 'Alpha');
	const aPause = alpha && alpha.acts.find((a) => a.act === 'pause');
	const aPlay  = alpha && alpha.acts.find((a) => a.act === 'play');
	check(!!aPause && /Alpha/.test(aPause.label || '') && /Pause/i.test(aPause.label || ''),
		'the pause verb names the node and says pause', JSON.stringify(aPause && aPause.label));
	check(!!aPlay && /Alpha/.test(aPlay.label || '') && /Resume|Play/i.test(aPlay.label || ''),
		'the play verb names the node and says resume', JSON.stringify(aPlay && aPlay.label));
	check(!!alpha && /Alpha/.test(alpha.lamp.label || '')
		&& /running|paused/i.test(alpha.lamp.label || '')
		&& !/^(Pause|Resume)\b/i.test(alpha.lamp.label || ''),
		'and the light names the node and its STATE, never an action',
		JSON.stringify(alpha && alpha.lamp.label));
}

// ── A. A verb does what it says ─────────────────────────────────────
//
// Every subset of the leaves, times every control, times BOTH verbs. The leaves
// are set DIRECTLY — never through a control — so the starting state is
// genuinely arbitrary rather than something a press could reach.
//
// A disabled button is pressed too, and is expected to do nothing: `click()` on
// a disabled <button> dispatches no event, and that IS the guard against the
// state changing under a verb the page said was unavailable.
const sweep = await p.evaluate(({ leaves, nodeIds }) => {
	const rows = [];
	if (!window.DaimondPause) return rows;
	const grpFor = (n) => document.querySelector(`.pptw[data-pause-node="${n}"]`);
	const live = nodeIds.filter(grpFor);
	for (let m = 0; m < (1 << leaves.length); m++) {
		for (const node of live) {
			for (const act of ['pause', 'play']) {
				DaimondPause.set('root', true);
				for (let i = 0; i < leaves.length; i++) if (m & (1 << i)) DaimondPause.set(leaves[i], false);
				const before = leaves.map((l) => DaimondPause.isPaused(l));
				const g = grpFor(node);
				const b = g.querySelector('.pptw-act.pptw-' + act);
				const shown = g.dataset.state;
				const wasDisabled = !!(b && b.disabled);
				if (b) b.click();
				rows.push({
					m, node, act, shown, wasDisabled,
					after:   g.dataset.state,
					said:    DaimondPause.state(node),
					beforeL: before,
					afterL:  leaves.map((l) => DaimondPause.isPaused(l)),
				});
			}
		}
	}
	return rows;
}, { leaves, nodeIds: nodes.map((n) => n.id) });

check(sweep.length > 0, `the sweep ran (${sweep.length} presses over ${1 << leaves.length} leaf states)`);

{
	// Every judgement below requires the sweep to have RUN. A page with no
	// controls on it makes "no press reaches amber" true and meaningless, and a
	// check that cannot fail is not evidence.
	const ran = sweep.length > 0;
	const amber = sweep.filter((r) => r.after === 'mixed' || r.said === 'mixed');
	check(ran && amber.length === 0,
		'NO press of either verb, from any of the leaf states, leaves that control amber',
		amber.length ? `${amber.length} did, e.g. ${JSON.stringify(amber[0])}` : null);

	const disagree = sweep.filter((r) => r.after !== r.said);
	check(ran && disagree.length === 0,
		'the light always draws what the module says the node is',
		disagree.length ? JSON.stringify(disagree[0]) : null);

	// The leaves under the pressed node come out uniform, and everything else
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
		'a press sets EVERY leaf under the node it was on, to the same thing',
		smeared.length ? JSON.stringify(smeared[0]) : null);
	check(ran && bled.length === 0,
		'and touches no leaf outside it',
		bled.length ? JSON.stringify(bled[0]) : null);

	// THE VERB, NOT THE STATE, DECIDES. Pause leaves it red and play leaves it
	// green, from wherever it started — which is what one button could not say.
	const wrongWay = sweep.filter((r) => r.after !== (r.act === 'pause' ? 'pause' : 'play'));
	check(ran && wrongWay.length === 0,
		'pause always ends paused and play always ends playing, from every state',
		wrongWay.length ? JSON.stringify(wrongWay[0]) : null);

	// A verb the page had greyed out changed nothing — which is the same thing
	// as saying the disabled attribute is real rather than cosmetic.
	const ghostPress = sweep.filter((r) => r.wasDisabled
		&& JSON.stringify(r.beforeL) !== JSON.stringify(r.afterL));
	check(ran && ghostPress.length === 0,
		'a disabled verb changes nothing when it is pressed',
		ghostPress.length ? JSON.stringify(ghostPress[0]) : null);
	const disabledSeen = sweep.filter((r) => r.wasDisabled).length;
	check(ran && disabledSeen > 0,
		`a disabled verb was really pressed in the sweep (${disabledSeen} times)`);
}

// ── A2. Which verb is offered, and the light offers none ────────────
//
// The fault this rebuild answers is not arithmetic, it is what the control SAYS
// is available. Running offers pause. Paused offers play. Amber offers BOTH —
// with one button a mixed branch had to guess, and it guessed silently.
{
	const offered = await p.evaluate(({ leaves, nodeIds }) => {
		const rows = [];
		if (!window.DaimondPause) return rows;
		const grpFor = (n) => document.querySelector(`.pptw[data-pause-node="${n}"]`);
		const live = nodeIds.filter(grpFor);
		for (let m = 0; m < (1 << leaves.length); m++) {
			DaimondPause.set('root', true);
			for (let i = 0; i < leaves.length; i++) if (m & (1 << i)) DaimondPause.set(leaves[i], false);
			for (const node of live) {
				const g = grpFor(node);
				rows.push({
					node, state: g.dataset.state,
					live: [...g.querySelectorAll('.pptw-act')].filter((b) => !b.disabled).map((b) => b.dataset.act),
				});
			}
		}
		return rows;
	}, { leaves, nodeIds: nodes.map((n) => n.id) });

	// In DOM order — play, pause, light — so a mixed branch reads ['play','pause'].
	const want = { play: ['pause'], pause: ['play'], mixed: ['play', 'pause'] };
	const wrong = offered.filter((r) => JSON.stringify(r.live) !== JSON.stringify(want[r.state]));
	check(offered.length > 0 && wrong.length === 0,
		'the verb offered is the one that can be done: pause when running, play when paused',
		wrong.length ? `${wrong.length} wrong, e.g. ${JSON.stringify(wrong[0])}` : `${offered.length} node-states`);
	const ambers = offered.filter((r) => r.state === 'mixed');
	check(ambers.length > 0,
		`an amber branch was reached in this enumeration (${ambers.length} node-states)`);
	check(ambers.length > 0 && ambers.every((r) => r.live.length === 2),
		'AND AN AMBER BRANCH OFFERS BOTH — the thing one button could not do',
		JSON.stringify(ambers.filter((r) => r.live.length !== 2)[0] || null));

	// The light itself. Pressing it — the way a finger would — must move nothing
	// at all.
	//
	// A DIAMOND TILE's light, which is the hard case: the tile is itself a click
	// target, so a press that is not swallowed opens the Diamond. Aiming at a
	// light and navigating instead is the mis-tap this has to rule out, and it is
	// only visible on a control that sits on something clickable.
	const inert = await p.evaluate(() => {
		DaimondPause.set('root', true);
		const g = document.querySelector('.diamond-box .pptw');
		if (!g) return null;
		const lamp = g.querySelector('.pptw-lamp');
		const before = DaimondPause.pausedIds().join(',');
		const wasOpen = ((document.getElementById('current-session-name') || {}).textContent || '').trim();
		lamp.click();
		lamp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		lamp.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
		return {
			before, after: DaimondPause.pausedIds().join(','),
			cursor: getComputedStyle(lamp).cursor,
			wasOpen, nowOpen: ((document.getElementById('current-session-name') || {}).textContent || '').trim(),
		};
	});
	check(!!inert && inert.before === inert.after,
		'and pressing the LIGHT changes nothing — amber cannot be set because nothing sets it',
		JSON.stringify(inert));
	check(!!inert && inert.wasOpen === inert.nowOpen,
		'nor does it open the tile it sits on, which is what a mis-tap would otherwise do',
		`${JSON.stringify(inert && inert.wasOpen)} -> ${JSON.stringify(inert && inert.nowOpen)}`);
	check(!!inert && inert.cursor !== 'pointer',
		'nor does it dress itself as pressable', JSON.stringify(inert && inert.cursor));
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
		const b = document.querySelector('#pptw-global .pptw-pause');
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
		const b = document.querySelector('#pptw-global .pptw-play');
		if (!b) return null;
		b.click();
		return { ids: DaimondPause.pausedIds(), tiles: [...document.querySelectorAll('.pptw')].map((x) => x.dataset.state) };
	});
	check(!!back && back.ids.length === 0 && back.tiles.length > 0 && back.tiles.every((x) => x === 'play'),
		'and its play verb resumes everything', JSON.stringify(back));
}

// ── F (continued). Enter and Space ──────────────────────────────────
//
// The verbs, one at a time and in both directions, because two buttons means
// the keyboard has to reach the RIGHT one — a Tab order that skips the live
// verb is a control a keyboard cannot work.
{
	await p.evaluate(() => DaimondPause.set('root', true));
	const node = await p.evaluate(() => {
		const g = document.querySelector('.diamond-box .pptw');
		if (!g) return null;
		const b = g.querySelector('.pptw-pause');
		b.focus();
		return { node: g.dataset.pauseNode, focused: document.activeElement === b, state: g.dataset.state };
	});
	check(!!node && node.focused, 'the pause verb takes the focus');
	if (node) {
		await p.keyboard.press('Enter');
		await p.waitForTimeout(200);
		const afterEnter = await p.evaluate((n) => DaimondPause.state(n), node.node);
		check(afterEnter === 'pause', 'Enter on it pauses the node', `${node.state} -> ${afterEnter}`);
		// The pause verb is now disabled, so the focus has to be moved to the
		// other one by hand — which is exactly what a person does.
		const onPlay = await p.evaluate(() => {
			const b = document.querySelector('.diamond-box .pptw .pptw-play');
			b.focus();
			return { focused: document.activeElement === b, disabled: b.disabled };
		});
		check(onPlay.focused && !onPlay.disabled,
			'and the play verb beside it is live and takes the focus', JSON.stringify(onPlay));
		await p.keyboard.press(' ');
		await p.waitForTimeout(200);
		const afterSpace = await p.evaluate((n) => DaimondPause.state(n), node.node);
		check(afterSpace === 'play', 'Space on THAT one resumes it', `-> ${afterSpace}`);
	}
	// A real pointer press, through the browser's own hit-testing: the tile
	// underneath opens on click, and a verb must not open it.
	const opened = await p.evaluate(() => {
		for (const id of DaimondPause.pausedIds()) DaimondPause.set(id, true);
		const box = document.querySelector('.diamond-box');
		return {
			name: (document.getElementById('current-session-name') || {}).textContent || '',
			id: box.dataset.id, ids: DaimondPause.pausedIds(),
		};
	});
	const hit = await clickReal(p, '.diamond-box .pptw .pptw-pause');
	check(hit, 'there is a pause verb on a Diamond tile for a pointer to hit');
	await p.waitForTimeout(400);
	const afterClick = await p.evaluate(() => ({
		name: (document.getElementById('current-session-name') || {}).textContent || '',
		ids: DaimondPause.pausedIds(),
	}));
	check(hit && opened.ids.length === 0 && afterClick.ids.length > 0,
		'a pointer press on it pauses the Diamond, from nothing paused',
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
		const g = document.querySelector('.diamond-box .pptw');
		if (!g) return { was: 'no control', now: 'no control at all' };
		const twin = g.cloneNode(true);
		g.parentNode.replaceChild(twin, g);
		const was = DaimondPause.state(twin.dataset.pauseNode);
		twin.querySelector('.pptw-pause').click();
		const now = DaimondPause.state(twin.dataset.pauseNode);
		return { was, now };
	});
	red(r.was === r.now, 'a verb that lost its listener fails the "pause ends paused" rule');
	await p.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:pause')));
	await p.waitForTimeout(200);
}

// (a2) THE REGRESSION THIS REBUILD ANSWERS, planted: a control that offers the
// verb it is ALREADY in — a running node offering play. That is one button's
// whole failure mode, drawn as two.
{
	const r = await p.evaluate(() => {
		DaimondPause.set('root', true);
		const g = document.querySelector('.diamond-box .pptw');
		if (!g) return null;
		const play = g.querySelector('.pptw-play');
		play.disabled = false;			// running, and yet play is on offer
		const live = [...g.querySelectorAll('.pptw-act')].filter((b) => !b.disabled).map((b) => b.dataset.act);
		return { state: g.dataset.state, live };
	});
	// In DOM order — play, pause, light — so a mixed branch reads ['play','pause'].
	const want = { play: ['pause'], pause: ['play'], mixed: ['play', 'pause'] };
	red(!!r && JSON.stringify(r.live) !== JSON.stringify(want[r.state]),
		'a running node that offers play is caught by the offered-verb rule');
	await p.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:pause')));
	await p.waitForTimeout(200);
}

// (a3) And the other half of it: a light dressed as a button. If the lamp were
// focusable it would be pressable, and amber would stop being unreachable by
// construction.
{
	const r = await p.evaluate(() => {
		const lamp = document.querySelector('.diamond-box .pptw .pptw-lamp');
		if (!lamp) return null;
		lamp.tabIndex = 0;
		const bad = lamp.tabIndex >= 0;
		lamp.removeAttribute('tabindex');
		return { bad, restored: lamp.tabIndex >= 0 };
	});
	red(!!r && r.bad && !r.restored, 'a focusable light is a light that can be pressed, and is caught');
}

// (b) A painted state frozen away from the module's answer.
{
	const r = await p.evaluate(() => {
		DaimondPause.set('root', true);
		const g = document.querySelector('.chat-box .pptw');
		if (!g) return { said: 'no control', painted: 'no control' };
		DaimondPause.set(g.dataset.pauseNode, false);		// really paused
		g.dataset.state = 'play';							// but drawn green
		return { said: DaimondPause.state(g.dataset.pauseNode), painted: g.dataset.state };
	});
	red(r.said !== r.painted, 'a light whose colour stops tracking the module is caught');
	await p.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:pause')));
	await p.waitForTimeout(200);
	const fixed = await p.evaluate(() => {
		const g = document.querySelector('.chat-box .pptw');
		if (!g) return { said: 'no control', painted: 'none' };
		return { said: DaimondPause.state(g.dataset.pauseNode), painted: g.dataset.state };
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
		const g = document.querySelector('#pptw-global .pptw');
		if (!g) return null;
		const twin = g.cloneNode(true);
		twin.querySelector('.pptw-pause')
			.addEventListener('click', function () { DaimondPause.set('root/chats', false); });
		g.parentNode.replaceChild(twin, g);
		twin.querySelector('.pptw-pause').click();
		const ids = DaimondPause.pausedIds();
		twin.parentNode.replaceChild(g, twin);		// the real control back
		DaimondPause.set('root', true);
		return ids;
	});
	red(!!r && r.indexOf('root/workers') === -1,
		'a global control wired to a section no longer pauses the worker pump');
	await p.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:pause')));
	const good = await p.evaluate(() => {
		const g = document.querySelector('#pptw-global .pptw');
		if (!g) return [];
		g.querySelector('.pptw-pause').click();
		const ids = DaimondPause.pausedIds();
		g.querySelector('.pptw-play').click();
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
	const released = await clickReal(p2, '#pptw-global .pptw-play');
	check(released, 'there is a global play verb to release the hold with');
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
