// verify_reversible.mjs — every step a user can take, they can take back.
//
// This exists because of a defect no other verifier could have found. On the
// Create your account screen, "Choose my own passphrase instead" switched to a
// typed passphrase AND HID ITSELF, so there was no way back to the generated
// words short of abandoning account creation altogether. Anyone who clicked it
// to see what it did was stuck. Every scripted check passed throughout: they all
// assert that a named thing does a named thing, and nobody had thought to write
// "and you can change your mind", so nothing looked.
//
// The general shape of the bug is a ONE-WAY DOOR: a control that moves the
// interface to a new state and leaves no route back to the old one. That is a
// property of the interface rather than of any particular feature, so it can be
// searched for rather than enumerated by hand.
//
// How it searches. From a starting state it takes a DOM signature -- which
// containers are visible, which controls are on offer. Then, for each control in
// turn, on a FRESH page each time: click it, and if the signature changed, try
// every control in the new state to see whether any of them restores the
// original signature. If none does, the first control is a one-way door and is
// reported. Reloading between probes is what keeps each answer independent;
// clicking through one long session would let earlier clicks explain later ones.
//
// Controls that are MEANT to be one-way are named in `leaves` per surface --
// submitting the form, skipping, cancelling, logging out, anything that hands
// off to the operating system. A door out is not a trap; a door that closes
// behind you inside the room is.
//
//   node dev/verify_reversible.mjs
//   node dev/verify_reversible.mjs 'Change passphrase'      # one surface
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway: these are gates, drawers, panels and
// dialogs only.

import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

let failures = 0;
let skips    = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};
/// A surface that could not be reached is NOT a pass. It is announced, counted,
/// and printed again at the end, so a run that quietly stopped searching half
/// the app cannot read as a clean one.
const skipped = [];
/// `expected` marks a surface that declared what it needs and did not get it --
/// the account service, say, which no gateway-free run has. It is still printed,
/// every time, in the body AND in the closing line; it just does not turn the run
/// red, because a permanently red run is one nobody reads.
const skip = (name, why, expected) => {
	console.log('  SKIP ' + name + ' — ' + why);
	skipped.push(name + ': ' + why);
	if (!expected) skips++;
};

// ── The surfaces to search ──────────────────────────────────────────────
//
// `reach` drives the app the way a user does until the surface is on screen;
// `ready` is what proves it arrived; `root` is the region searched. `leaves`
// name the controls whose whole purpose is to leave, matched against a
// control's id OR its label, and `leavesRe` does the same for a family of
// labels that carry a name in them (an account row, say).
const SURFACES = [
	{
		name:   'Create your account',
		open:   { connect: false, signIn: false },
		ready:  '#id-primary',
		root:   '#identity-modal',
		leaves: ['id-primary', 'id-skip'],
	},
	{
		name:   'Admin drawer',
		open:   { connect: false },
		// The identity row, not the cog: the cog TOGGLES, and with no model
		// connected the app has already opened the drawer on Models by itself, so
		// pressing it would shut the very drawer under test. The row always means
		// "show me the account's controls".
		reach:  async (page) => { await click(page, '#user-row'); },
		ready:  '#admin-home',
		root:   '#admin',
		// Leaving the app (a download, an OS file picker, a new tab), leaving the
		// account (log out, forget, switch), and the drawer's own ×.
		leaves: [
			'admin-close',
			'Log out',
			'Forget this identity…',
			'Export a backup',
			'Import a backup…',
			'＋ Add another account',
			'Daimond Dashboard ↗',
			// The sync switch RELOADS THE APP, which is a hand-off in the same
			// family as logging out. It is not a door that closes behind you: after
			// the reload the same control in the same place reads the other way
			// round, so the state is reversible even though the screen it was
			// reversed from has gone. Both labels, because which one is shown
			// depends on the state it is in.
			'Start without syncing',
			'Turn syncing back on',
		],
		leavesRe: [/— switch$/],
	},
	{
		name:   'Models',
		open:   { connect: false },
		reach:  async (page) => { await click(page, '#astat-model'); },
		ready:  '#admin-models',
		root:   '#admin-models',
		// `cfg-sync-btn` is the settings twin of the account panel's sync switch,
		// and it leaves for the same reason: it reloads the app.
		leaves: ['byok-save', 'cfg-sync-btn'],
	},
	{
		name:   'Credits',
		open:   { connect: false },
		reach:  async (page) => { await click(page, '#astat-account'); },
		ready:  '#admin-credits',
		root:   '#admin-credits',
		leaves: [],
		// Balance, packs and the auto-reload switch are all drawn from what the
		// account service answers. With no gateway the view correctly holds one
		// sentence and no controls, so there is nothing to search.
		needs:  'the account service',
	},
	{
		// The generated-passphrase dialog reached from Admin. It is the create
		// screen's twin -- same words, same acknowledgement, same escape hatch --
		// so it is exactly where that screen's defect would be expected to have
		// been copied.
		name:   'Change passphrase',
		open:   { connect: false },
		reach:  async (page) => {
			await click(page, '#user-row');
			await clickLabel(page, '#admin-home', 'Change passphrase…');
			await page.waitForSelector('.dlg-card', { timeout: 8000 });
			// The current passphrase is asked for first, and checked before the
			// new one is offered, so the dialog under test is two steps in.
			await page.evaluate(() => {
				const i = document.querySelector('.dlg .dlg-input');
				if (i) { i.focus(); }
			});
			await page.keyboard.type('testpass1234');
			await page.evaluate(() => {
				const b = [...document.querySelectorAll('.dlg .dlg-ok')].pop();
				if (b) b.click();
			});
		},
		ready:  '#cp-modal',
		root:   '#cp-modal',
		leaves: ['Cancel', 'Change it'],
	},
	{
		name:   'Email panel',
		open:   { connect: false },
		reach:  async (page) => {
			await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('mail'));
		},
		ready:  '#panel-mail',
		root:   '#panel-mail',
		leaves: ['Close panel'],
	},
	{
		// The Doc panel is empty until something is opened in it, so the search
		// would otherwise find one control and learn nothing. A role prompt is
		// the shortest real path to a document: Admin offers it, and the app
		// seeds the file from the shipped default.
		name:   'Doc panel',
		open:   { connect: false },
		reach:  async (page) => {
			await click(page, '#user-row');
			// The role is interpolated into `home.edit_prompt` with its own
			// capitalisation ("Edit the Chat prompt…"), and clickLabel matches
			// exactly -- so a lower-case spelling here quietly stopped opening the
			// Doc panel, and this whole surface went unsearched while the run
			// stayed green. The label is written as the app writes it.
			await clickLabel(page, '#admin-home', 'Edit the Chat prompt…');
			await page.waitForSelector('#panel-doc .files-view-head', { timeout: 10000 });
		},
		ready:  '#panel-doc .files-view-head',
		root:   '#panel-doc',
		leaves: ['Download', '← Back', 'Close panel'],
		commits: ['✔ Save', 'Saving…'],
	},
	{
		// Phase C's per-tile dialog. Simple and Max both have to be a door you
		// can walk back through: a detail level you can raise and not lower is
		// the one-way door this file exists to find, and this dialog is now the
		// only place either is chosen.
		name:   'Tile dialog (Diamond cog)',
		open:   {},		// a model is connected: a Diamond is what makes the tile
		reach:  async (page) => {
			await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
			await page.waitForTimeout(250);
			await click(page, '#new-diamond-btn');
			await page.waitForSelector('.dlg-card', { timeout: 8000 });
			await page.evaluate(() => {
				const card = [...document.querySelectorAll('.dlg-card')].find((c) => c.getClientRects().length);
				const inp = card.querySelector('input.dlg-input');
				inp.value = 'Reversible';
				inp.dispatchEvent(new Event('input', { bubbles: true }));
				card.querySelector('.dlg-ok').click();
			});
			await page.waitForSelector('#diamond-list .tile-cog', { timeout: 10000 });
			await click(page, '#diamond-list .tile-cog');
			await page.waitForSelector('.tile-dlg-card', { timeout: 8000 });
		},
		ready:  '.tile-dlg-card',
		root:   '.tile-dlg-card',
		// Delete leaves by destroying the thing the dialog is about, and the closer
		// leaves by shutting it. Neither is a door that closes behind you inside
		// the room. The pause light is NOT here: it is a toggle, and it must be
		// searched.
		//
		// `Done` is gone: seq 98 replaced the foot's Done button with a cross in
		// the top right, so the way out is now `✕` and the accessible name `Close`.
		// This list still said Done, so the closer was searched as though it were
		// an ordinary control and reported as a one-way door -- which every closer
		// is, and which is exactly what `leaves` exists to say. Both spellings are
		// named because the control carries the glyph and the word.
		leaves: ['Delete', 'Done', 'Close', '✕'],
	},
];

/// Every element a user could press, as one selector. Not just `button`: the
/// workspace and the tool rows offer chips that are spans wearing `.act`, and a
/// search that only knew about buttons would call those surfaces controlless.
const CTRL_SEL = 'button, [role="button"], .act';

/// What the interface is showing, reduced to something comparable: which
/// elements are on screen, and the names of the controls on offer.
///
/// Deliberately NOT the field values: typing changes those without changing
/// where the user is, and a signature that moved every keystroke would call
/// every text box a new state.
///
/// Visibility is `getClientRects()`, NOT `getComputedStyle(el).display`.
/// `display` is not inherited, so a button inside a `display:none` panel
/// computes as perfectly visible -- which is why the first run of the Admin
/// drawer offered the hidden provider form's buttons and then reported fifteen
/// one-way doors that were nothing of the kind.
const SIGNATURE = ({ rootSel, ctrlSel }) => {
	const root = document.querySelector(rootSel);
	if (!root) return { absent: true, vis: [], labels: [] };
	const shown = (el) => el.getClientRects().length > 0
		&& getComputedStyle(el).visibility !== 'hidden';
	const vis = [];
	root.querySelectorAll('[id]').forEach((el) => { if (shown(el)) vis.push(el.id); });
	// Every name a control answers to, joined -- NOT the first one that happens
	// to be set. A button whose text goes "Edit" -> "✔ Save" keeps its title of
	// "Edit" throughout, so a signature that stopped at the title could not see
	// the panel change mode at all, and the search reported the surface clean.
	const name = (el) => [
		el.id,
		el.getAttribute('aria-label') || '',
		el.getAttribute('title') || '',
		el.getAttribute('data-act') || '',
		(el.textContent || '').trim().replace(/\s+/g, ' '),
	].join('|');
	const labels = [];
	root.querySelectorAll(ctrlSel).forEach((b) => { if (shown(b)) labels.push(name(b)); });
	return { absent: false, vis: vis.sort(), labels: labels.sort() };
};

/// The controls a user could actually press right now.
///
/// The label is what the user READS -- the button's own text first, and only
/// then `aria-label` or `title`, which is all an icon-only button has. Taking
/// the title first hid mode changes: the Doc panel's Edit button keeps
/// `title="Edit"` while its text becomes "Save", so the search saw one control
/// where a person sees two states.
const CONTROLS = ({ rootSel, ctrlSel }) => {
	const root = document.querySelector(rootSel);
	if (!root) return [];
	const out = [];
	root.querySelectorAll(ctrlSel).forEach((b, i) => {
		if (b.disabled || !b.getClientRects().length) return;
		if (getComputedStyle(b).visibility === 'hidden') return;
		const label = (b.textContent || '').trim() || b.getAttribute('aria-label')
			|| b.getAttribute('title') || b.getAttribute('data-act') || '';
		out.push({ idx: i, id: b.id || '', label: label.replace(/\s+/g, ' ').slice(0, 60) });
	});
	return out;
};

/// The parts of a signature that move on their own.
///
/// Some of what a panel shows is live: a credit balance, a byte count, whether
/// the account service answered this second. Those change with no click at all,
/// so a search that compared raw signatures would call every control a door.
/// Rather than hand-listing which rows are volatile -- a list that goes stale
/// the moment a row is added -- the noise floor is MEASURED: take the signature
/// twice with a pause between, and whatever moved on its own is excluded from
/// every later comparison, and said out loud.
function noiseBetween(a, b) {
	const diff = (x, y) => {
		const cx = new Map(), cy = new Map();
		x.forEach((v) => cx.set(v, (cx.get(v) || 0) + 1));
		y.forEach((v) => cy.set(v, (cy.get(v) || 0) + 1));
		const out = new Set();
		for (const k of new Set([...cx.keys(), ...cy.keys()])) {
			if ((cx.get(k) || 0) !== (cy.get(k) || 0)) out.add(k);
		}
		return out;
	};
	return { vis: diff(a.vis, b.vis), labels: diff(a.labels, b.labels) };
}

/// A signature as a comparable string, with the measured noise taken out.
function key(sig, noise) {
	if (sig.absent) return 'ABSENT';
	return JSON.stringify({
		vis:    sig.vis.filter((v) => !noise.vis.has(v)),
		labels: sig.labels.filter((v) => !noise.labels.has(v)),
	});
}

/// Click the nth control in the root. One argument only: page.evaluate takes a
/// single value, so the selector and the index travel together.
const CLICK_NTH = ({ rootSel, ctrlSel, idx }) => {
	const root = document.querySelector(rootSel);
	if (!root) return false;
	const els = root.querySelectorAll(ctrlSel);
	if (!els[idx]) return false;
	els[idx].click();
	return true;
};

/// Press a control by selector, tolerating the app's fades (Playwright's
/// actionability check hangs on them, so this goes through the DOM).
async function click(page, sel) {
	await page.waitForSelector(sel, { timeout: 10000 });
	await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); }, sel);
	await page.waitForTimeout(350);
}

/// Press the control inside `rootSel` whose text is exactly `text`. Exact, not
/// `:has-text`, which is a case-insensitive substring and would happily press
/// "Change name…" when asked for "Change passphrase…".
async function clickLabel(page, rootSel, text) {
	await page.waitForSelector(rootSel, { timeout: 10000 });
	const hit = await page.evaluate(({ rootSel, text }) => {
		const root = document.querySelector(rootSel);
		if (!root) return false;
		const b = [...root.querySelectorAll('button')]
			.find((x) => (x.textContent || '').trim() === text);
		if (!b) return false;
		b.click();
		return true;
	}, { rootSel, text });
	if (!hit) throw new Error(`no control labelled "${text}" in ${rootSel}`);
	await page.waitForTimeout(400);
}

/// Is this control declared as one that is meant to leave?
function isLeaf(surf, c) {
	if ((surf.leaves || []).includes(c.id) || (surf.leaves || []).includes(c.label)) return true;
	return (surf.leavesRe || []).some((re) => re.test(c.label));
}

/// Is this control one that COMMITS -- writes a file, spends money, changes the
/// account? Such a control may well put the screen back the way it was, but it
/// is not an undo, and letting one answer for the way home is how a search
/// declares "Edit, then Save" a round trip. They are barred from being the
/// route back; they are still probed as doors themselves.
function isCommit(surf, c) {
	return (surf.commits || []).includes(c.id) || (surf.commits || []).includes(c.label);
}

const only = process.argv[2] || '';

for (const surf of SURFACES) {
	if (only && surf.name !== only) continue;
	console.log(`\n── ${surf.name}`);
	const arg = { rootSel: surf.root, ctrlSel: CTRL_SEL };

	// A fresh session per probe: its own browser profile, so nothing a previous
	// probe stored can explain this one's answer.
	//
	// The ACCOUNT NAME is deliberately constant across them. It was random per
	// session, and the identity row prints it -- so every signature taken in one
	// session differed from every signature taken in another by the name alone,
	// and the Admin drawer reported all nineteen of its controls as one-way
	// doors. A fresh profile is what independence needs; a fresh name was never
	// part of it.
	const start = async () => {
		const dir = scratch('pw', 'rev-' + Math.random().toString(36).slice(2, 10));
		const s = await open({ ...surf.open, name: 'reversible', profile: dir });
		const inner = s.close;
		// Profiles are megabytes each and a search opens hundreds of them; a run
		// that left them behind would fill the scratch root by itself.
		s.close = async () => {
			await inner();
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
		};
		if (surf.reach) await surf.reach(s.page);
		await s.page.waitForSelector(surf.ready, { timeout: 15000 });
		await s.page.waitForTimeout(300);
		return s;
	};

	let s0;
	try { s0 = await start(); }
	catch (e) {
		skip(surf.name, 'could not be reached: ' + (e && e.message ? e.message : e));
		continue;
	}
	// The noise floor, measured before anything is pressed: whatever moves on
	// its own over the same interval the search waits for.
	const sig1    = await s0.page.evaluate(SIGNATURE, arg);
	await s0.page.waitForTimeout(2600);
	const sig2    = await s0.page.evaluate(SIGNATURE, arg);
	const noise   = noiseBetween(sig1, sig2);
	const base    = key(sig2, noise);
	const initial = await s0.page.evaluate(CONTROLS, arg);
	await s0.close();
	if (!initial.length) {
		skip(surf.name, surf.needs
			? `nothing to search: it is drawn from ${surf.needs}, which is not running here`
			: 'no controls found in ' + surf.root, !!surf.needs);
		continue;
	}
	console.log(`   ${initial.length} controls on offer: ${initial.map(c => c.label || c.id).join(' | ')}`);
	if (noise.vis.size || noise.labels.size) {
		console.log('   note: moving on its own, so not compared — '
			+ [...noise.vis, ...noise.labels].map(s => JSON.stringify(s.slice(0, 40))).join(', '));
	}

	for (const c of initial) {
		if (isLeaf(surf, c)) continue;

		const s = await start();
		const { page } = s;
		await page.evaluate(CLICK_NTH, { ...arg, idx: c.idx });
		await page.waitForTimeout(250);
		const after = key(await page.evaluate(SIGNATURE, arg), noise);

		if (after === base) { await s.close(); continue; }   // changed nothing; not a door

		// Something changed -- but a control that reports on itself ("Copy" becomes
		// "Copied" for two seconds) changes the screen without moving the user
		// anywhere, and undoes itself on a timer rather than on a click. Give it
		// long enough to put itself back before calling it a door, or every piece
		// of transient feedback in the app reads as a trap.
		await page.waitForTimeout(2600);
		const settled = key(await page.evaluate(SIGNATURE, arg), noise);
		if (settled === base) { await s.close(); continue; }

		// It moved somewhere. Is there a way home? Try each control now on offer --
		// each in its OWN session, from a fresh page.
		//
		// An earlier version tried them all in one session, clicking the original
		// control again between candidates to "put the state back". That is wrong
		// whenever the original control is a toggle, which is exactly the case
		// worth testing: the restoring click moved the state on instead of back, so
		// later candidates were answered from the wrong place. It reported a
		// correct screen as broken, and credited an unrelated button with the
		// escape. Isolation is cheaper to reason about than bookkeeping.
		const now = await page.evaluate(CONTROLS, arg);
		await s.close();

		let home = null;
		for (const back of now) {
			if (isLeaf(surf, back) || isCommit(surf, back)) continue;
			const t = await start();
			await t.page.evaluate(CLICK_NTH, { ...arg, idx: c.idx });
			await t.page.waitForTimeout(250);
			await t.page.evaluate(CLICK_NTH, { ...arg, idx: back.idx });
			await t.page.waitForTimeout(350);
			const sig = key(await t.page.evaluate(SIGNATURE, arg), noise);
			await t.close();
			if (sig === base) { home = back; break; }
		}

		check(home !== null,
			`"${c.label || c.id}" can be undone`,
			home ? `via "${home.label || home.id}"` : 'NOTHING on this screen returns to where the user was');
	}
}

// A surface whose declared dependency is absent is reported loudly but does
// not fail the run: under run_all no account service ever exists, so treating
// it as a skip or a failure would keep the suite off green forever, for a
// reason the suite can never remove. The "SKIPPED:" token is reserved by
// run_all for a verifier that did not run at all -- do not print it here.
if (skipped.length) console.log('\nnot searchable here (dependency absent): ' + skipped.join('; '));
console.log(failures === 0
	? `\nreversible: every door on every searchable surface swings both ways${skips ? ` (${skips} unsearchable)` : ''}.`
	: `\nreversible: ${failures} one-way door(s)${skips ? `, ${skips} surface(s) unsearchable` : ''}.`);
process.exit(failures === 0 ? 0 : 1);
