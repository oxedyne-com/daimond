// gateway: none
//
// THE UNDO WINDOW COVERS NOTHING (r545 QA-C2, widened for r547 QA-B F1-F3, 10 Oct 2026). Every
// turn that changes a file offers its copies back for fifteen seconds (`offerTurnUndo`),
// through the one toast in the app that takes presses, so a press meant for anything under it
// reverts the turn's files.
// - r545: at a fixed 96px it stood over Send on a phone.
// - r547 F1: measured above the input bar, it stood over the workspace strip's "+" and
//   "Nothing kept here", and over the band above the composer (mark notice, Retry, Edit).
// - r547 F2: at z-index 9999 it stood over a tall dialog's buttons, and over the Bypass
//   confirm at 360x400.
// - r547 F3: a chat's offer stayed up over another chat, and Undo there reverted the first.
//
// At 6 sizes x 2 themes, in each engine (this file runs itself once per engine): raise the
// window, draw every control the band above the composer can hold (the strip, the mark
// notice, the last message's Retry and Edit, a question card's answers, the phone's ask bar,
// email compose's Send), then open the Bypass confirm, the same card made long, and Settings.
// In every state a press at the centre and the four inset corners of every visible control
// must land on that control, never on Undo. Then the F3 arm: switch chats with a real turn's
// offer up; it is withdrawn, and a press on Undo reverts nothing.
//
//   node dev/verify_undo_clear.mjs            (both engines)
//   DAIMOND_BROWSER=webkit UNDO_CLEAR_ONE=1 node dev/verify_undo_clear.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINES = ['chromium', 'webkit'];

if (!process.env.UNDO_CLEAR_ONE) {
	let fails = 0, passes = 0;
	for (const eng of ENGINES) {
		console.log('\n=== ' + eng + ' ===');
		const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
			env: { ...process.env, DAIMOND_BROWSER: eng, UNDO_CLEAR_ONE: '1' }, encoding: 'utf8', maxBuffer: 64 << 20 });
		const txt = (r.stdout || '') + (r.stderr || '');
		process.stdout.write(txt);
		const m = txt.match(/: (\d+) passed, (\d+) failed\s*$/);
		if (m) { passes += +m[1]; fails += +m[2]; }
		if (!m || (r.status !== 0 && +m[2] === 0)) fails += 1;		// a run that died without its count
	}
	console.log('\nALL ENGINES: ' + passes + ' passed, ' + fails + ' failed');
	process.exit(fails ? 1 : 0);
}

const { open, newChat, chat, BROWSER } = await import('./harness.mjs');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	if (!pass || process.env.UNDO_CLEAR_VERBOSE) console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const VIEWS = [
	['390x844', 390, 844],
	['390x508-kb', 390, 508],		// a keyboard that resizes the layout viewport
	['360x640', 360, 640],
	['360x400-kb', 360, 400],		// a small phone with the keyboard up
	['1440x900', 1440, 900],
	['1440x560', 1440, 560],		// a short desktop window
];
const THEMES = ['obsidian', 'porcelain'];
const phone = BROWSER === 'chromium'
	? { isMobile: true, touch: true }
	: { touch: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };

// Every visible control, and where a press at its centre and inset corners lands.
async function sweep(page) {
	return page.evaluate(() => {
		const toast = document.getElementById('daimond-undo');
		const up = !!toast && !toast.hidden && toast.classList.contains('up');
		// What of a control is drawn: its box cut to the viewport and to every scroller it sits
		// in. A control scrolled out of the thread's box is not under anything; nobody can see it
		// to press it, and a press there lands on whatever is drawn in that place.
		const shownBox = (el) => {
			const r = el.getBoundingClientRect();
			let l = Math.max(r.left, 0), t = Math.max(r.top, 0), rt = Math.min(r.right, innerWidth), b = Math.min(r.bottom, innerHeight);
			for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
				const cs = getComputedStyle(a);
				if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
				const ar = a.getBoundingClientRect();
				l = Math.max(l, ar.left); t = Math.max(t, ar.top); rt = Math.min(rt, ar.right); b = Math.min(b, ar.bottom);
			}
			return { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t };
		};
		const vis = (el) => { const r = shownBox(el); const cs = getComputedStyle(el);
			return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden'; };
		const name = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0]) + ':' +
			String(el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 18);
		const sel = 'button, input:not([type=hidden]), textarea, select, a[href], summary, [role=button]';
		const hits = [];
		let n = 0;
		for (const el of document.querySelectorAll(sel)) {
			if (toast && toast.contains(el)) continue;
			if (!vis(el)) continue;
			n++;
			const r = shownBox(el);
			const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]];
			let undo = 0;
			for (const [x, y] of pts) { const at = document.elementFromPoint(x, y); if (at && toast && toast.contains(at)) undo++; }
			if (undo) hits.push(name(el) + ' ' + JSON.stringify([r.left, r.top, r.right, r.bottom].map(Math.round)) + ' undo=' + undo + '/5');
		}
		const tr = toast && !toast.hidden ? toast.getBoundingClientRect() : null;
		const btn = toast && toast.querySelector('.daimond-undo-btn');
		let reach = false;
		if (btn && tr) { const b = btn.getBoundingClientRect(); const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); reach = !!at && btn.contains(at); }
		return { up, n, hits, toast: tr ? [tr.left, tr.top, tr.right, tr.bottom].map(Math.round) : null, reach, vh: innerHeight };
	});
}

// The band above the composer, drawn whole: the mark notice with its press, and the
// transcript's last row (a question card's answers, a last message's Retry and Edit, drawn
// as the hover draws them). The workspace strip and Send are the app's own.
async function drawBand(page) {
	return page.evaluate(() => {
		const mn = document.getElementById('mark-notice');
		if (mn && !mn.querySelector('.qa-mark')) {
			mn.innerHTML = '<p class="mark-notice-head">1 mark is not in force here</p><button type="button" class="qa-mark">Use here</button>';
			mn.hidden = false;
		}
		const out = document.getElementById('chat-output');
		if (out && !out.querySelector('.qa-ask')) {
			const c = document.createElement('div'); c.className = 'ask-card qa-ask';
			c.innerHTML = '<p>Which one?</p><button type="button">First answer</button> <button type="button">Second answer</button>';
			out.appendChild(c);
			const r = document.createElement('div'); r.className = 'ctile qa-last';
			r.innerHTML = '<div class="ctile-lbl"><span class="ctile-ctl"><button type="button" class="ctile-retry" style="opacity:1">Retry</button>'
				+ '<button type="button" class="ctile-edit" style="opacity:1">Edit</button></span></div>';
			out.appendChild(r);
		}
		if (out) out.scrollTop = out.scrollHeight;
		const has = (q) => { const el = document.querySelector(q); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
		return { strip: has('#chat-attachments button'), mark: has('#mark-notice .qa-mark'), ask: has('.qa-ask button'),
			retry: has('.qa-last .ctile-retry') && has('.qa-last .ctile-edit'), send: has('#chat-send') };
	});
}

const raise = (page) => page.evaluate(() => DaimondUndo.able({ text: 'Copies kept of the files this turn changed: 2', ms: 120000,
	revert: () => { window.__qaReverted = (window.__qaReverted || 0) + 1; } }));

function judge(tag, m, expectUp) {
	check(tag + ': no press on a control lands on Undo (' + m.n + ' controls)', m.hits.length === 0, m.hits.slice(0, 6).join('; ') + ' toast ' + JSON.stringify(m.toast));
	if (expectUp) check(tag + ': Undo is up and its button takes its own press', m.up && m.reach && m.toast && m.toast[1] >= 0 && m.toast[3] <= m.vh, 'toast ' + JSON.stringify(m.toast) + ' reach ' + m.reach);
}

for (const kind of ['phone', 'desk']) {
	const s = await open(kind === 'phone' ? phone : {});
	const page = s.page;
	try {
		await newChat(s);
		if (BROWSER === 'chromium') {
			// The real path: a turn that replaces a file offers its copies back.
			const dir = await page.evaluate(() => DaimondAttach.chatScratch(DaimondAttach.focus().id));
			await chat(s, `@tool file_write {"path":"${dir}/a.txt","content":"one"}`);
			await chat(s, `@tool file_write {"path":"${dir}/a.txt","content":"two"}`);
			check(kind + ': a turn that changed a file offers Undo', !!(await page.evaluate(() => DaimondUndo.pending())));
		} else {
			await chat(s, 'hello');		// WebKit has no file store: the window is raised by hand below
		}
		for (const theme of THEMES) {
			await page.evaluate((t) => DaimondTheme.set(t), theme);
			for (const [vn, w, h] of VIEWS) {
				if ((kind === 'phone') !== (w < 800)) continue;
				await page.setViewportSize({ width: w, height: h });
				await page.waitForTimeout(400);
				const tag = `${BROWSER} ${kind} ${theme} ${vn}`;
				await raise(page);
				const band = await drawBand(page);
				await page.waitForTimeout(400);
				for (const k of ['strip', 'mark', 'ask', 'retry', 'send'])
					check(tag + ': the band draws ' + k, band[k]);
				judge(tag + ' composer', await sweep(page), true);
				// The phone's ask bar and email compose's Send, through the panel itself.
				await page.evaluate((ph) => { try { if (ph && window.DaimondSheet) DaimondSheet.open('compose'); else DaimondPanels.show('compose'); } catch (e) { window.__qaCompose = String(e); } }, kind === 'phone');
				await page.waitForTimeout(600);
				await page.evaluate(() => {
					// The ask bar stands under every sheet guest that has one; compose's own is
					// hidden, so it is drawn here to measure the bar's band all the same.
					const a = document.getElementById('msheet-ask'); if (a && window.DaimondSheet && DaimondSheet.isOpen()) a.classList.remove('hidden');
					const b = document.getElementById('compose-send'); if (b) b.scrollIntoView({ block: 'nearest' });
				});
				await page.waitForTimeout(300);
				const drawn = await page.evaluate(() => { const v = (id) => { const el = document.getElementById(id); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < innerHeight; };
					return { compose: v('compose-send'), ask: v('msheet-ask-send') }; });
				check(tag + ': compose Send is drawn', drawn.compose);
				if (kind === 'phone') check(tag + ': the phone ask bar is drawn', drawn.ask);
				judge(tag + ' compose', await sweep(page), false);
				await page.evaluate((ph) => { try { if (ph && window.DaimondSheet) DaimondSheet.close(); else DaimondPanels.hide('compose'); } catch (e) { /* gone */ } }, kind === 'phone');
				await page.waitForTimeout(300);
				// A real dialog(): the Bypass consent, then the same card made long.
				await raise(page);
				await page.evaluate(() => { window.__qaBypass = DaimondHandMode.set('bypass'); });
				await page.waitForTimeout(500);
				judge(tag + ' bypass-confirm', await sweep(page), false);
				await page.evaluate(() => {
					const m = [...document.querySelectorAll('.modal.dlg')].pop(); if (!m) return;
					const msg = m.querySelector('.dlg-msg') || m.querySelector('.modal-card');
					const pad = document.createElement('div'); pad.style.height = '1400px'; pad.textContent = 'long body';
					msg.appendChild(pad);
					const card = m.querySelector('.modal-card'); card.scrollTop = card.scrollHeight;
				});
				await page.waitForTimeout(300);
				judge(tag + ' long-confirm', await sweep(page), false);
				await page.evaluate(() => { [...document.querySelectorAll('.modal.dlg')].forEach((m) => { const c = m.querySelector('.dlg-cancel'); if (c) c.click(); }); });
				await page.waitForTimeout(300);
				// Settings.
				await raise(page);
				await page.evaluate(() => { try { DaimondAdmin.settings(); } catch (e) { window.__qaSetErr = String(e); } });
				await page.waitForTimeout(600);
				judge(tag + ' settings', await sweep(page), false);
				await page.evaluate(() => { const b = document.getElementById('settings-close'); if (b) b.click(); });
				await page.waitForTimeout(300);
				const rev = await page.evaluate(() => window.__qaReverted || 0);
				check(tag + ': nothing was reverted by a press', rev === 0, 'reverted ' + rev + 'x');
				await page.evaluate(() => DaimondUndo.flush());
			}
		}
		// F3: a real turn's offer, then another chat on screen. On the desk, where the rail
		// that opens a new chat is on screen.
		if (BROWSER === 'chromium' && kind === 'desk') {
			await page.setViewportSize({ width: 1440, height: 900 });
			const dir = await page.evaluate(() => DaimondAttach.chatScratch(DaimondAttach.focus().id));
			await chat(s, `@tool file_write {"path":"${dir}/a.txt","content":"three"}`);
			const before = await page.evaluate(() => {
				window.__qaUndoV = 0;
				const o = DaimondVersions.undoVersion;
				DaimondVersions.undoVersion = function () { window.__qaUndoV++; return o.apply(this, arguments); };
				return !!DaimondUndo.pending();
			});
			check(kind + ' F3: the turn offers Undo in its own chat', before);
			await newChat(s);
			await page.waitForTimeout(400);
			const after = await page.evaluate(() => {
				const t = document.getElementById('daimond-undo');
				const shown = !!t && !t.hidden && t.getBoundingClientRect().height > 0;
				const pend = !!DaimondUndo.pending();
				DaimondUndo.undo();		// a press, were it still there
				return { shown, pend, reverted: window.__qaUndoV };
			});
			check(kind + ' F3: on another chat, Undo is not offered', !after.shown && !after.pend, JSON.stringify(after));
			check(kind + ' F3: the first chat is never reverted from another', after.reverted === 0, JSON.stringify(after));
		}
	} catch (e) {
		check(kind + ': verifier ran', false, String(e && e.stack || e).slice(0, 800));
	} finally {
		try { await s.close(); } catch (e) { /* gone */ }
	}
}
console.log('\n' + BROWSER + ': ' + ok.length + ' passed, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
