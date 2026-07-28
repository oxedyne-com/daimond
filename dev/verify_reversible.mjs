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
// Controls that are MEANT to be one-way are named in `LEAVES` per surface --
// submitting the form, skipping, cancelling. A door out is not a trap; a door
// that closes behind you inside the room is.
//
//   node dev/verify_reversible.mjs
//
// Needs dev/serve.mjs on :8777. No gateway and no model: these are gates and
// dialogs only.

import { open } from './harness.mjs';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

// ── The surfaces to search ──────────────────────────────────────────────
//
// `reach` puts the page into the starting state. `LEAVES` are the controls
// whose whole purpose is to leave, so they are not probed.
const SURFACES = [
	{
		name:   'Create your account',
		open:   { name: 'rev-' + Date.now(), connect: false, signIn: false },
		ready:  '#id-primary',
		root:   '#identity-modal',
		leaves: ['id-primary', 'id-skip'],
	},
];

/// What the interface is showing, reduced to something comparable.
///
/// Visibility of every element that carries an id, plus the labels of the
/// controls on offer. Deliberately NOT the field values: typing changes those
/// without changing where the user is, and a signature that moved every
/// keystroke would call every text box a new state.
const SIGNATURE = (rootSel) => {
	const root = document.querySelector(rootSel);
	if (!root) return 'ABSENT';
	const vis = [];
	root.querySelectorAll('[id]').forEach((el) => {
		if (getComputedStyle(el).display !== 'none' && !el.hidden) vis.push(el.id);
	});
	const labels = [];
	root.querySelectorAll('button').forEach((b) => {
		if (getComputedStyle(b).display !== 'none') labels.push((b.textContent || '').trim());
	});
	return JSON.stringify({ vis: vis.sort(), labels: labels.sort() });
};

/// The controls a user could actually press right now.
const CONTROLS = (rootSel) => {
	const root = document.querySelector(rootSel);
	if (!root) return [];
	const out = [];
	root.querySelectorAll('button').forEach((b, i) => {
		if (getComputedStyle(b).display === 'none' || b.disabled) return;
		out.push({ idx: i, id: b.id || '', label: (b.textContent || '').trim() });
	});
	return out;
};

for (const surf of SURFACES) {
	console.log(`\n── ${surf.name}`);

	// A fresh session per probe. `open` seeds a new profile, so each run starts
	// from the same place rather than from wherever the last probe finished.
	const start = async () => {
		const s = await open({ ...surf.open, name: surf.open.name + '-' + Math.random().toString(36).slice(2, 8) });
		await s.page.waitForSelector(surf.ready, { timeout: 15000 });
		await s.page.waitForTimeout(300);
		return s;
	};

	const s0 = await start();
	const base    = await s0.page.evaluate(SIGNATURE, surf.root);
	const initial = await s0.page.evaluate(CONTROLS, surf.root);
	await s0.close();
	console.log(`   ${initial.length} controls on offer: ${initial.map(c => c.label || c.id).join(' | ')}`);

	for (const c of initial) {
		if (surf.leaves.includes(c.id)) continue;

		const s = await start();
		const { page } = s;
		// One argument only: page.evaluate takes a single value, so the selector
		// and the index travel together.
		const clickNth = ({ rootSel, idx }) => {
			const root = document.querySelector(rootSel);
			const btns = root.querySelectorAll('button');
			btns[idx].click();
		};
		await page.evaluate(clickNth, { rootSel: surf.root, idx: c.idx });
		await page.waitForTimeout(250);
		const after = await page.evaluate(SIGNATURE, surf.root);

		if (after === base) { await s.close(); continue; }   // changed nothing; not a door

		// Something changed -- but a control that reports on itself ("Copy" becomes
		// "Copied" for two seconds) changes the screen without moving the user
		// anywhere, and undoes itself on a timer rather than on a click. Give it
		// long enough to put itself back before calling it a door, or every piece
		// of transient feedback in the app reads as a trap.
		await page.waitForTimeout(2600);
		const settled = await page.evaluate(SIGNATURE, surf.root);
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
		const now = await page.evaluate(CONTROLS, surf.root);
		await s.close();

		let home = null;
		for (const back of now) {
			if (surf.leaves.includes(back.id)) continue;
			const t = await start();
			await t.page.evaluate(clickNth, { rootSel: surf.root, idx: c.idx });
			await t.page.waitForTimeout(250);
			await t.page.evaluate(clickNth, { rootSel: surf.root, idx: back.idx });
			await t.page.waitForTimeout(250);
			const sig = await t.page.evaluate(SIGNATURE, surf.root);
			await t.close();
			if (sig === base) { home = back; break; }
		}

		check(home !== null,
			`"${c.label || c.id}" can be undone`,
			home ? `via "${home.label || home.id}"` : 'NOTHING on this screen returns to where the user was');
	}
}

console.log(failures === 0
	? '\nreversible: every door on every surface swings both ways.'
	: `\nreversible: ${failures} one-way door(s).`);
process.exit(failures === 0 ? 0 : 1);
