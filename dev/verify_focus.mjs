// verify_focus.mjs — the keyboard can always find where it is, and cannot fall
// out of a dialog that is covering the app.
//
// The third of the property searches, after verify_reversible (can a step be
// taken back?) and verify_escapable (can a cover be got rid of?). This one asks
// where the FOCUS is, which is the whole interface for anyone driving by
// keyboard and half of it for everyone else:
//
//   1. When a dialog opens, focus lands inside it. Otherwise the first Tab goes
//      to the browser's own bar, and the second into the page BEHIND the modal.
//   2. While it is open, Tab cannot leave it. A modal that lets Tab walk into
//      the app underneath is a modal only to the mouse: the caret ends up typing
//      into a chat box the user cannot see, behind a scrim they cannot click.
//   3. When it closes, focus goes back to something. Left on <body>, the next
//      Tab starts again from the top of the document, and a keyboard user has to
//      walk the whole app to get back to the control they just used.
//
// Each is checked on its own, on a fresh session, so one failure does not
// explain the next. A surface that cannot be reached is SKIPPED out loud.
//
//   node dev/verify_focus.mjs
//   node dev/verify_focus.mjs 'Change passphrase'
//
// Needs dev/serve.mjs on :8777. No gateway.

import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

let failures = 0, skips = 0;
const skipped = [];
const check = (cond, msg, detail) => {
	console.log((cond ? '    ok   ' : '    FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};
const skip = (name, why) => {
	console.log('  SKIP ' + name + ' — ' + why);
	skipped.push(name + ': ' + why);
	skips++;
};

/// Where a control is on screen, having scrolled it into view. Returns null
/// when it is not there or has no box.
const BOX_OF = ({ rootSel, text }) => {
	const root = rootSel ? document.querySelector(rootSel) : document;
	if (!root) return null;
	const el = text
		? [...root.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === text)
		: root;
	if (!el) return null;
	el.scrollIntoView({ block: 'center', inline: 'center' });
	const r = el.getBoundingClientRect();
	if (!r.width || !r.height) return null;
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/// Press a control with the MOUSE, at its coordinates.
///
/// Not `element.click()`, which every other verifier here uses to get past the
/// app's fades. A scripted `.click()` fires the handler but never moves the
/// focus, so `document.activeElement` stays on the body -- and a dialog that
/// dutifully restores the focus it found on opening then restores the body, and
/// reads as broken. In a check ABOUT focus, only a real click will do.
async function press(page, sel) {
	await page.waitForSelector(sel, { timeout: 10000 });
	const box = await page.evaluate(BOX_OF, { rootSel: sel, text: '' });
	if (!box) throw new Error(`${sel} has no box to click`);
	await page.mouse.click(box.x, box.y);
	await page.waitForTimeout(400);
}

/// Press the control inside `rootSel` whose text is exactly `text`. Exact, not
/// `:has-text`, which is a case-insensitive substring.
async function pressLabel(page, rootSel, text) {
	await page.waitForSelector(rootSel, { timeout: 10000 });
	const box = await page.evaluate(BOX_OF, { rootSel, text });
	if (!box) throw new Error(`no control labelled "${text}" in ${rootSel}`);
	await page.mouse.click(box.x, box.y);
	await page.waitForTimeout(450);
}

/// Where the focus is, as something readable, and whether it is inside `sel`.
const WHERE = (sel) => {
	const a = document.activeElement;
	const root = document.querySelector(sel);
	const name = !a ? '(none)'
		: a.tagName + (a.id ? '#' + a.id : '')
			+ (a.className && typeof a.className === 'string' ? '.' + a.className.trim().split(/\s+/)[0] : '');
	return {
		name,
		inside: !!(root && a && root.contains(a)),
		onBody: !a || a === document.body || a === document.documentElement,
	};
};

/// How many things inside the dialog can take focus. Tab is pressed a couple
/// more times than that, so a trap that merely takes a long way round is still
/// caught going past the end.
const FOCUSABLE = (sel) => {
	const root = document.querySelector(sel);
	if (!root) return 0;
	return root.querySelectorAll(
		'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),'
		+ ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').length;
};

// ── The dialogs, and what each is entitled to ───────────────────────────
//
// `trap: false` declares a surface that is deliberately NOT a focus trap, and
// must say why. The Admin form is the one that earns it: the whole point of
// putting Daimond's forms in the rail rather than in a modal is that the chat
// stays live beside them, so a user can ask what an app password is and read the
// answer while the box asking for one is on screen. Trapping focus in it would
// undo exactly that.
const DIALOGS = [
	{
		name:  'Identity gate (create)',
		open:  { connect: false, signIn: false },
		reach: async () => {},
		sel:   '#identity-modal',
		close: '#id-skip',
		trap:  true,
	},
	{
		name:  'Prompt (Change name)',
		open:  { connect: false },
		reach: async (page) => {
			await press(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Change name…');
		},
		sel:   '.modal.dlg .dlg-card',
		close: '.modal.dlg .dlg-cancel',
		trap:  true,
		// The control that opened it, which is where focus should come back to.
		opener: 'Change name…',
	},
	{
		name:  'Confirm (Forget this identity)',
		open:  { connect: false },
		reach: async (page) => {
			await press(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Forget this identity…');
		},
		sel:   '.modal.dlg .dlg-card',
		close: '.modal.dlg .dlg-cancel',
		trap:  true,
		opener: 'Forget this identity…',
	},
	{
		name:  'Change passphrase',
		open:  { connect: false },
		reach: async (page) => {
			await press(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Change passphrase…');
			await page.waitForSelector('.dlg-card', { timeout: 8000 });
			await press(page, '.dlg .dlg-input');
			await page.keyboard.type('testpass1234');
			await press(page, '.dlg .dlg-ok');
			await page.waitForSelector('#cp-modal', { timeout: 8000 });
		},
		sel:   '#cp-modal .dlg-card',
		close: { label: 'Cancel', in: '#cp-modal' },
		trap:  true,
	},
	{
		name:  'Pairing (Link another device)',
		open:  { connect: false },
		reach: async (page) => {
			await page.evaluate(() => window.DaimondPairing && DaimondPairing.showLink());
			await page.waitForSelector('.pair-scrim', { timeout: 8000 });
			await page.waitForTimeout(600);
		},
		sel:   '.pair-box',
		close: { label: 'Done', in: '.pair-scrim' },
		trap:  true,
	},
	{
		name:  'Command palette',
		open:  { connect: false },
		reach: async (page) => {
			await page.keyboard.press('Control+k');
			await page.waitForSelector('#palette', { state: 'visible', timeout: 8000 });
		},
		sel:   '#palette',
		close: null,          // dismissed by clicking away; nothing to press
		trap:  true,
	},
	{
		name:  'Admin form (Add a mailbox)',
		open:  { connect: false },
		reach: async (page) => {
			await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('mail'));
			await page.waitForTimeout(300);
			await press(page, '#panel-mail [data-act="mail-add"]');
			await page.waitForSelector('#admin-form .dlg-input', { timeout: 8000 });
		},
		sel:   '#admin-form',
		close: { label: 'Cancel', in: '#admin-form' },
		trap:  false,
		why:   'the chat stays reachable beside it on purpose — that is why forms open in the rail',
	},
];

const only = process.argv[2] || '';

for (const d of DIALOGS) {
	if (only && d.name !== only) continue;
	console.log(`\n── ${d.name}`);

	const start = async () => {
		const dir = scratch('pw', 'foc-' + Math.random().toString(36).slice(2, 10));
		const s = await open({ ...d.open, name: 'focus', profile: dir });
		const inner = s.close;
		s.close = async () => {
			await inner();
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
		};
		await d.reach(s.page);
		await s.page.waitForSelector(d.sel, { timeout: 10000 });
		await s.page.waitForTimeout(400);
		return s;
	};

	// ── 1. Focus lands inside it ──
	try {
		const s = await start();
		const w = await s.page.evaluate(WHERE, d.sel);
		check(w.inside, 'focus lands inside it when it opens',
			w.inside ? w.name : `focus is on ${w.name}, outside the dialog`);
		await s.close();
	} catch (e) {
		skip(d.name + ' / opens focused', String(e && e.message ? e.message : e).split('\n')[0]);
	}

	// ── 2. Tab cannot walk out of it ──
	try {
		const s = await start();
		const n = await s.page.evaluate(FOCUSABLE, d.sel);
		let escapedAt = -1, escapedTo = '';
		for (let i = 0; i < n + 3; i++) {
			await s.page.keyboard.press('Tab');
			await s.page.waitForTimeout(60);
			const w = await s.page.evaluate(WHERE, d.sel);
			if (!w.inside) { escapedAt = i + 1; escapedTo = w.name; break; }
		}
		if (d.trap) {
			check(escapedAt === -1, `Tab stays inside it (${n} focusable, ${n + 3} presses)`,
				escapedAt === -1 ? null : `Tab ${escapedAt} landed on ${escapedTo}, behind the dialog`);
		} else {
			check(escapedAt !== -1, 'Tab deliberately reaches the app behind it', d.why);
		}
		await s.close();
	} catch (e) {
		skip(d.name + ' / tab trap', String(e && e.message ? e.message : e).split('\n')[0]);
	}

	// ── 3. Closing gives the focus back ──
	if (!d.close) {
		console.log('    ---- focus on close: not checked, it has no close control');
	} else {
		try {
			const s = await start();
			if (typeof d.close === 'string') await press(s.page, d.close);
			else await pressLabel(s.page, d.close.in, d.close.label);
			await s.page.waitForTimeout(500);
			const w = await s.page.evaluate(WHERE, d.sel);
			check(!w.onBody, 'closing puts the focus back on something',
				w.onBody ? 'focus was left on the document body, so the next Tab starts from the top of the app'
					: `focus returned to ${w.name}`);
			// Where it went is worth saying even when it went somewhere: back to the
			// control that opened it is right, anywhere else is merely not wrong.
			if (!w.onBody && d.opener) {
				const back = await s.page.evaluate(() =>
					((document.activeElement || {}).textContent || '').trim());
				if (back !== d.opener) {
					console.log(`    ---- note: focus returned to "${back}", not to "${d.opener}" which opened it`);
				}
			}
			await s.close();
		} catch (e) {
			skip(d.name + ' / focus on close', String(e && e.message ? e.message : e).split('\n')[0]);
		}
	}
}

if (skipped.length) console.log('\nskipped: ' + skipped.join('; '));
console.log(failures === 0
	? `\nfocus: nothing strands the keyboard${skips ? ` (${skips} SKIPPED)` : ''}.`
	: `\nfocus: ${failures} failure(s)${skips ? `, ${skips} SKIPPED` : ''}.`);
process.exit(failures === 0 && skips === 0 ? 0 : 1);
