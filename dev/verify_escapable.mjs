// verify_escapable.mjs — nothing the app puts over the top of itself can trap you.
//
// A sibling of verify_reversible: same method, different property. That one asks
// whether a control can be un-pressed; this one asks whether a thing that COVERS
// the app can be got rid of, by the two means every user already knows —
//
//   1. Escape.
//   2. The control the dialog itself offers for the purpose.
//
// Both, not either. A dialog with a Cancel button but no Escape stops a keyboard
// user dead; a dialog that only answers to Escape leaves a pointer user hunting
// for an X that is not there. And the Escape has to work from wherever the
// pointer left the focus: a handler that only fires while focus is still inside
// the dialog is a handler that stops working the moment the user clicks the
// message text, which is a thing people do while reading it.
//
// Deliberate exceptions are declared, not assumed. The identity gate does NOT
// answer Escape, on purpose: its dismiss control is "Skip for now" when creating
// an account but "Forget this identity…" when unlocking one, and a stray Escape
// must never reach that. So the gate is checked to STAY OPEN — an exception that
// is asserted cannot rot into an accident.
//
//   node dev/verify_escapable.mjs
//   node dev/verify_escapable.mjs 'Change passphrase'      # one dialog
//
// Needs dev/serve.mjs on :8777. No gateway: every dialog here is reachable
// without one, and any that is not is SKIPPED out loud rather than passed.

import fs from 'node:fs';
import { open, scratch, shot } from './harness.mjs';

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

/// Press a control through the DOM. The app's fades keep failing Playwright's
/// actionability check, so a normal click can hang on a perfectly clickable
/// button.
async function press(page, sel) {
	await page.waitForSelector(sel, { timeout: 10000 });
	await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); }, sel);
	await page.waitForTimeout(350);
}

/// Press the control inside `rootSel` whose text is exactly `text`. Exact, not
/// Playwright's `:has-text`, which is a case-insensitive SUBSTRING and would
/// press "Change name…" when asked for "Change passphrase…".
async function pressLabel(page, rootSel, text) {
	await page.waitForSelector(rootSel, { timeout: 10000 });
	const hit = await page.evaluate(({ rootSel, text }) => {
		const root = document.querySelector(rootSel);
		if (!root) return false;
		const b = [...root.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === text);
		if (!b) return false;
		b.click();
		return true;
	}, { rootSel, text });
	if (!hit) throw new Error(`no control labelled "${text}" in ${rootSel}`);
	await page.waitForTimeout(400);
}

/// Is anything matching `sel` actually on screen? Removed, `display:none`,
/// `hidden` and zero-sized all count as gone; a dialog that merely lost its
/// backdrop has not closed.
const IS_OPEN = (sel) => [...document.querySelectorAll(sel)]
	.some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');

// ── The things that cover the app ───────────────────────────────────────
//
// `reach` opens it, `sel` is what proves it is open, `close` is the control it
// offers for getting rid of it (a selector, or `{ label, in }` for one found by
// its words). `escape: false` declares a deliberate exception and must say why.
const DIALOGS = [
	{
		name:   'Identity gate (create)',
		open:   { connect: false, signIn: false },
		reach:  async () => {},
		sel:    '#identity-modal',
		close:  '#id-skip',
		// The gate's dismiss control is "Skip for now" while creating an account
		// and "Forget this identity…" while unlocking one. Wiring Escape to it
		// would put an irreversible erase one keystroke from a person who pressed
		// Escape out of habit.
		escape: false,
		why:    'its dismiss control is destructive on the unlock screen',
	},
	{
		name:   'Prompt (Change name)',
		open:   { connect: false },
		reach:  async (page) => {
			await press(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Change name…');
		},
		sel:    '.modal.dlg',
		close:  '.modal.dlg .dlg-cancel',
		escape: true,
	},
	{
		name:   'Confirm (Forget this identity)',
		open:   { connect: false },
		reach:  async (page) => {
			await press(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Forget this identity…');
		},
		sel:    '.modal.dlg',
		close:  '.modal.dlg .dlg-cancel',
		escape: true,
	},
	{
		name:   'Change passphrase',
		open:   { connect: false },
		reach:  async (page) => {
			await press(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Change passphrase…');
			await page.waitForSelector('.dlg-card', { timeout: 8000 });
			await page.evaluate(() => { const i = document.querySelector('.dlg .dlg-input'); if (i) i.focus(); });
			await page.keyboard.type('testpass1234');
			await page.evaluate(() => { const b = [...document.querySelectorAll('.dlg .dlg-ok')].pop(); if (b) b.click(); });
			await page.waitForSelector('#cp-modal', { timeout: 8000 });
		},
		sel:    '#cp-modal',
		close:  { label: 'Cancel', in: '#cp-modal' },
		escape: true,
	},
	{
		// Not a modal, but it covers the rail and holds a form, and the same two
		// ways out are the ones a user reaches for.
		name:   'Admin form (Add a mailbox)',
		open:   { connect: false },
		reach:  async (page) => {
			await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('mail'));
			await page.waitForTimeout(300);
			await press(page, '#panel-mail [data-act="mail-add"]');
			await page.waitForSelector('#admin-form .dlg-input', { timeout: 8000 });
		},
		sel:    '#admin-form .dlg-actions',
		close:  { label: 'Cancel', in: '#admin-form' },
		escape: true,
	},
	{
		name:   'Pairing (Link another device)',
		open:   { connect: false },
		reach:  async (page) => {
			await page.evaluate(() => window.DaimondPairing && DaimondPairing.showLink());
			await page.waitForSelector('.pair-scrim', { timeout: 8000 });
		},
		sel:    '.pair-scrim',
		close:  { label: 'Done', in: '.pair-scrim' },
		escape: true,
	},
	{
		name:   'Command palette',
		open:   { connect: false },
		reach:  async (page) => {
			await page.keyboard.press('Control+k');
			await page.waitForSelector('#palette', { state: 'visible', timeout: 8000 });
		},
		sel:    '#palette',
		close:  null,          // it offers none; the check below says so out loud
		escape: true,
	},
	{
		name:   'Panel gallery',
		open:   { connect: false },
		// The ⋯ tag, which is only in the row when a panel did not fit in it — and
		// the row only fills up once the panels that wait for something to hold
		// (Doc, Message, Compose) have joined it. So they are marked used first,
		// which is what using them would do, and then the row is narrowed until it
		// overflows. Without this the gallery is unreachable and the check would
		// have nothing to say.
		reach:  async (page) => {
			await page.evaluate(() => {
				['doc', 'msg', 'compose'].forEach((p) => {
					try { DaimondPanels.markUsed(p); } catch (e) { /* not built yet */ }
				});
				try { DaimondPanels.reflow(); } catch (e) { /* nothing to reflow */ }
			});
			await page.waitForTimeout(500);
			await press(page, '#panel-more');
			await page.waitForSelector('#panel-gallery', { state: 'visible', timeout: 8000 });
		},
		sel:      '#panel-gallery',
		close:    null,
		escape:   true,
		viewport: { width: 900, height: 820 },
	},
	{
		name:   'Appearance menu',
		open:   { connect: false },
		reach:  async (page) => {
			await press(page, '#settings-menu-btn');
			await page.waitForSelector('#settings-menu', { state: 'visible', timeout: 8000 });
		},
		sel:    '#settings-menu',
		close:  null,
		escape: true,
	},
];

const only = process.argv[2] || '';

for (const d of DIALOGS) {
	if (only && d.name !== only) continue;
	console.log(`\n── ${d.name}`);

	// One session per probe: a dialog that was dismissed in an earlier check must
	// not be able to explain a later one.
	const start = async () => {
		const dir = scratch('pw', 'esc-' + Math.random().toString(36).slice(2, 10));
		const s = await open({ ...d.open, name: 'escapable', profile: dir });
		// Some surfaces only exist at a size that forces them. The panel gallery is
		// the overflow of the tag row, so a window wide enough to show every tag
		// has no gallery at all.
		if (d.viewport) { await s.page.setViewportSize(d.viewport); await s.page.waitForTimeout(400); }
		const inner = s.close;
		s.close = async () => {
			await inner();
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
		};
		await d.reach(s.page);
		await s.page.waitForTimeout(300);
		const up = await s.page.evaluate(IS_OPEN, d.sel);
		if (!up) throw new Error(`${d.sel} did not open`);
		return s;
	};

	// ── 1. Escape ──
	try {
		const s = await start();
		await s.page.keyboard.press('Escape');
		await s.page.waitForTimeout(500);
		const stillUp = await s.page.evaluate(IS_OPEN, d.sel);
		if (d.escape) {
			check(!stillUp, 'Escape closes it', stillUp ? 'still on screen after Escape' : null);
		} else {
			check(stillUp, 'Escape deliberately does NOT close it', d.why);
		}
		if (stillUp && d.escape) await shot(s, 'escapable-' + d.name.replace(/\W+/g, '-').toLowerCase());
		await s.close();
	} catch (e) {
		skip(d.name + ' / Escape', String(e && e.message ? e.message : e).split('\n')[0]);
	}

	// ── 2. Escape after the pointer has moved the focus ──
	//
	// Reading a dialog means clicking about in it. A key handler scoped to "focus
	// is still inside the form" quietly stops working the moment that happens,
	// and the dialog that answered Escape a second ago no longer does.
	if (d.escape) {
		try {
			const s = await start();
			// A REAL pointer click on the dialog's own body text. Not a synthetic
			// focus() -- that would land focus on the element clicked and prove
			// nothing. Clicking prose that cannot take focus leaves `activeElement`
			// on the document body, which is exactly the state a handler scoped to
			// "focus is still inside my form" stops firing in.
			const box = await s.page.evaluate((sel) => {
				const root = document.querySelector(sel);
				const host = (root && root.closest('.modal, .pair-scrim, .admin-view')) || root;
				const txt = host && (host.querySelector('.dlg-msg, p, h2, h3, .admin-title') || host);
				if (!txt) return null;
				const r = txt.getBoundingClientRect();
				if (!r.width || !r.height) return null;
				return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
			}, d.sel);
			if (!box) throw new Error('no text to click inside ' + d.sel);
			await s.page.mouse.click(box.x, box.y);
			await s.page.waitForTimeout(200);
			const where = await s.page.evaluate(() => {
				const a = document.activeElement;
				return a ? (a.tagName + (a.id ? '#' + a.id : '')) : '(none)';
			});
			await s.page.keyboard.press('Escape');
			await s.page.waitForTimeout(500);
			const stillUp = await s.page.evaluate(IS_OPEN, d.sel);
			check(!stillUp, 'Escape still closes it after clicking its text',
				stillUp ? `focus was on ${where}, and the key handler only listens while the dialog holds it` : null);
			await s.close();
		} catch (e) {
			skip(d.name + ' / Escape after click', String(e && e.message ? e.message : e).split('\n')[0]);
		}
	}

	// ── 3. A way out for the pointer ──
	//
	// Either a control that says so, or dismissal by clicking away from it. A
	// popover is not obliged to carry an X — clicking elsewhere is how everyone
	// already dismisses one — but SOMETHING has to work, or a user with no
	// keyboard is stuck looking at it.
	try {
		const s = await start();
		let by = null;
		if (d.close) {
			if (typeof d.close === 'string') await press(s.page, d.close);
			else await pressLabel(s.page, d.close.in, d.close.label);
			await s.page.waitForTimeout(500);
			if (!(await s.page.evaluate(IS_OPEN, d.sel))) by = 'its own close control';
		}
		if (!by) {
			// Away from it, low and to the left, where a dialog never is.
			await s.page.mouse.click(20, 900);
			await s.page.waitForTimeout(500);
			if (!(await s.page.evaluate(IS_OPEN, d.sel))) by = 'clicking away from it';
		}
		check(by !== null, 'a pointer can get rid of it', by
			|| 'no close control, and clicking away leaves it on screen');
		if (!by) await shot(s, 'escapable-stuck-' + d.name.replace(/\W+/g, '-').toLowerCase());
		await s.close();
	} catch (e) {
		skip(d.name + ' / pointer', String(e && e.message ? e.message : e).split('\n')[0]);
	}
}

if (skipped.length) console.log('\nskipped: ' + skipped.join('; '));
console.log(failures === 0
	? `\nescapable: everything that covers the app can be got rid of${skips ? ` (${skips} SKIPPED)` : ''}.`
	: `\nescapable: ${failures} failure(s)${skips ? `, ${skips} SKIPPED` : ''}.`);
process.exit(failures === 0 && skips === 0 ? 0 : 1);
