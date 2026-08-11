// verify_workerconsent.mjs — a worker cannot ask, so the APP asks for it.
//
// `SAFETY_CLAUSE` (src/prompts.rs) tells every tool-holding role: "Never take an
// action the user cannot undo — a purchase, a payment, a message sent, a form
// submitted — without putting it to them first and getting a plain yes."
// `DEFAULT_WORKER` tells a dispatched worker: "You cannot ask questions."
//
// Both sentences are composed onto the same agent. In a Diamond the fence was
// said to contain the contradiction; it does not, and cannot, because the fence
// is a list of PATHS and the acts in that clause are BUTTONS. What actually
// gates them is `egress_needs_consent(mode, tainted)` — false in Guarded, the
// default rung, on a turn that has read nothing. So a dispatched worker can
// click Buy, or submit a form, on a page the user is signed into, and nobody is
// asked at all.
//
// This file proves that hole exists and then proves it closed. THE RED RUN IS
// THE POINT: run it against a build without the fix and checks 1 and 2 fail for
// a Diamond worker as well as a chat one.
//
//   node dev/verify_workerconsent.mjs
//
// The properties:
//
//   1. AN UNSUPERVISED ACTOR'S CLICK IS PUT TO THE USER, in the default rung,
//      on a clean turn. Asserted by the dialog appearing AND by the click never
//      reaching the driver when the answer is no — a gate that asks and acts
//      anyway is worse than no gate.
//   2. THE SAME FOR TYPING INTO A PAGE, which is the form-post channel, and the
//      text is shown so the person deciding can see what would be sent.
//   3. THE USER'S OWN CHAT IS NOT ASKED. Same rung, same clean turn, same host.
//      A gate that fires for everybody is a gate the user learns to wave
//      through, and the whole claim here is that autonomy is what narrows.
//   4. CONSENT IS NOT REMEMBERED FOR AN AUTONOMOUS ACTOR. Acting is remembered
//      per host for a supervised chat, which is right — a run of clicks is not a
//      run of prompts. For a worker it is wrong: "you allowed one click on
//      shop.test" is not a yes to the next one, and the whole clause is about
//      the act, not the host.
//   5. BYPASS IS STILL BYPASS. The rung the user chose deliberately, once, is
//      not quietly re-armed by this.
//
// The Web panel's driver is STUBBED — and only the driver. `window.DaimondWeb`
// is an iframe or the Hands extension in the product, neither of which belongs
// in a consent test; everything below it (the Rust gate, the payload, the real
// `__daimondEgressAllowed` bridge, the real dialog) is the shipped code. The
// stub also RECORDS what reached it, which is how check 1's second half is
// asked at the driver rather than at the model's reply.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'workerconsent', signIn: true, connect: false });
const { page } = s;
await page.waitForFunction(() => !!window.DaimondCore && !!window.__daimondEgressAllowed,
	null, { timeout: 15000 }).catch(() => {});

// ── The driver stub ──────────────────────────────────────────────────
//
// It answers `status` with a page already open, so `current_url()` has a real
// host to name — an empty URL is denied by the bridge without asking anybody,
// which would let every check below pass for the wrong reason.
await page.evaluate(() => {
	window.__drv = { clicks: [], types: [] };
	window.DaimondWeb = {
		status:   async () => ({ driver: 'stub', url: 'https://shop.test/cart', open: true }),
		open:     async (u) => ({ ok: true, url: u }),
		fetch:    async () => 'stub page',
		snapshot: async () => ({ nodes: [] }),
		read:     async () => 'stub page',
		click:    async (ref) => { window.__drv.clicks.push(ref); return { ok: true }; },
		type:     async (ref, text, submit) => { window.__drv.types.push({ ref, text, submit }); return { ok: true }; },
		scroll:   async () => ({ ok: true }),
		close:    async () => ({ ok: true }),
	};
});

/// Build an agent of one kind or the other and hold it on `window`.
///
/// `alone` is what a dispatched worker carries and the user's own chat does not.
/// It is set through the SAME call the app uses at dispatch, so a build where
/// that call does not exist fails here rather than silently testing nothing.
async function mint(key, alone) {
	return await page.evaluate(async ({ key, alone }) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		let marked = false;
		if (alone) {
			if (typeof app.set_unsupervised === 'function') { app.set_unsupervised(); marked = true; }
		}
		window[key] = app;
		return { minted: true, marked,
			// Reported so a red run says WHY it is red: no such call in this build.
			hasSetter: typeof app.set_unsupervised === 'function' };
	}, { key, alone });
}

/// Run `fn` in the page, answering the first dialog that appears with `answer`.
/// Reports whether one appeared at all, and what it said.
///
/// `body` is the dialog's WHOLE text, not a prefix of it: the thing being
/// authorised is quoted inside that text, and a check that read the first 500
/// characters could not tell a full quote from a shortened one — which is the
/// defect being guarded against here. `msg` measures the paragraph as RENDERED,
/// because "it is in the DOM" and "the person can see it" are different claims:
/// an unbroken run wider than the card is present and invisible.
/// `quote` names a substring whose RENDERED position is wanted — the text a
/// consent dialog is quoting — and comes back as `msg.quoteLeft`.
async function withDialog(fn, answer, arg, quote) {
	const seenOut = { asked: false, title: '', body: '', msg: null };
	const runner = page.evaluate(fn, arg);
	for (let i = 0; i < 60; i++) {
		await page.waitForTimeout(100);
		const seen = await page.evaluate((q) => {
			const d = document.querySelector('.dlg, dialog[open], .modal-dialog');
			if (!d) return null;
			const p = d.querySelector('.dlg-msg');
			let msg = null;
			if (p) {
				const box = p.getBoundingClientRect();
				msg = { text: p.textContent || '', scrollW: p.scrollWidth,
					clientW: p.clientWidth, left: box.left,
					quoteLeft: null, drop: null,
					lineH: parseFloat(getComputedStyle(p).lineHeight) || 0 };
				// How far the quote sits BELOW the sentence that introduces it.
				// The string is written with a blank line either side, so a
				// paragraph that keeps them drops two lines; one that folds them
				// into spaces drops none, and a long run that merely wrapped
				// drops one. Measured rather than read off the stylesheet: the
				// question is what the person sees, not what the CSS says.
				const at = q ? msg.text.indexOf(q) : -1;
				if (at >= 0 && p.firstChild) {
					const r = document.createRange();
					r.setStart(p.firstChild, at);
					r.setEnd(p.firstChild, at + 1);
					const qb = r.getBoundingClientRect();
					msg.quoteLeft = qb.left;
					let j = at - 1;
					while (j > 0 && /\s/.test(msg.text[j])) j--;
					if (j > 0) {
						const pr = document.createRange();
						pr.setStart(p.firstChild, j);
						pr.setEnd(p.firstChild, j + 1);
						msg.drop = qb.top - pr.getBoundingClientRect().top;
					}
				}
			}
			return { title: (d.querySelector('h2, .dlg-title')?.textContent || ''),
				body: (d.textContent || ''), msg };
		}, quote || '');
		if (!seen) continue;
		seenOut.asked = true; seenOut.title = seen.title; seenOut.body = seen.body;
		seenOut.msg = seen.msg;
		// BY CLASS, not by reading the button text. The dialog carries a `×` closer in
		// its heading row as well as its two answers, and a "the first button that is
		// not Cancel" heuristic picks the closer — which dismisses. That is how this
		// check reported a refusal for an approval it had just given, and it is the
		// same shape of mistake as asserting on wording: the DOM says which button
		// confirms, so ask the DOM.
		await page.evaluate((yes) => {
			const d = document.querySelector('.dlg, dialog[open], .modal-dialog');
			const okBtn   = d.querySelector('.dlg-ok');
			const cancelB = d.querySelector('.dlg-cancel');
			const pick = yes ? okBtn : (cancelB || okBtn);
			if (!pick) throw new Error('the dialog has no button to answer with');
			pick.click();
		}, answer);
		break;
	}
	const result = await runner;
	return { result, ...seenOut };
}

const setMode = (name) => page.evaluate(async (n) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_permission_mode(n);
	return mod.permission_mode();
}, name);

const drv = () => page.evaluate(() => ({
	clicks: window.__drv.clicks.slice(), types: window.__drv.types.slice() }));
const resetDrv = () => page.evaluate(() => { window.__drv.clicks = []; window.__drv.types = []; });

try {
	const rung = await setMode('guarded');
	check('the default rung is the one under test', rung === 'guarded', rung);

	// The two dispatched workers of the user's own scenario, and the chat that
	// sent them. Both workers are built exactly as `Workers.start` builds one.
	const w1 = await mint('__wChat', true);
	const w2 = await mint('__wDiamond', true);
	const c1 = await mint('__chat', false);
	check('a worker can be marked as acting alone', w1.hasSetter && w1.marked && w2.marked,
		w1.hasSetter ? 'marked' : 'this build has no set_unsupervised — the hole is open');
	check('an agent is minted for each of the three actors', w1.minted && w2.minted && c1.minted);

	// ── 1. A worker's click is put to the user ──
	await resetDrv();
	const wClick = await withDialog(async () => {
		return String(await window.__wChat.run_tool('web_click', JSON.stringify({ ref: 7 })));
	}, false);
	check('a chat-dispatched worker\'s click is put to the user', wClick.asked,
		wClick.asked ? wClick.title : 'no dialog: the click went through unasked');
	const afterNo = await drv();
	check('and declining stops the click reaching the page',
		afterNo.clicks.length === 0, 'driver saw ' + afterNo.clicks.length + ' click(s)');

	await resetDrv();
	const dClick = await withDialog(async () => {
		return String(await window.__wDiamond.run_tool('web_click', JSON.stringify({ ref: 7 })));
	}, false);
	check('a DIAMOND-dispatched worker\'s click is put to the user too', dClick.asked,
		dClick.asked ? dClick.title : 'no dialog: a Diamond worker clicks Buy unasked');

	// ── 2. Typing, and the user can see what would be sent ──
	await resetDrv();
	const wType = await withDialog(async () => {
		return String(await window.__wChat.run_tool('web_type',
			JSON.stringify({ ref: 3, text: 'card-4111-1111-1111-1111', submit: true })));
	}, false);
	check('a worker typing into a page is put to the user', wType.asked, wType.title);
	check('and the person deciding is shown what would be sent',
		/card-4111/.test(wType.body || ''), (wType.body || '').slice(0, 80));
	const typedAfterNo = await drv();
	check('declining stops the text going anywhere',
		typedAfterNo.types.length === 0, JSON.stringify(typedAfterNo.types));

	// ── 2a. A LONG text is shown whole, and shown legibly ──
	//
	// The body used to be cut at 300 characters, with an ellipsis and no sentence
	// saying so: the reader was shown a prefix and told it was "this". A card
	// number sitting past the cut was approved by somebody who had not seen it,
	// which is the exact act this gate exists to put to them. So the payload here
	// is an unbroken run with the number well past 300, and three things are
	// asked of the RENDERED paragraph — the whole of it is there, nothing was
	// elided, and none of it is hidden sideways off a 420px card.
	await resetDrv();
	const pad  = 'x'.repeat(700);
	const long = pad + 'card-4111-2222-3333-4444' + pad;
	const wLong = await withDialog(async (payload) =>
		String(await window.__wChat.run_tool('web_type',
			JSON.stringify({ ref: 5, text: payload, submit: true }))),
		false, long, long.slice(0, 24));
	check('a long text is quoted in full, not to the first 300 characters',
		(wLong.msg?.text || '').includes(long),
		'shown ' + ((wLong.msg?.text || '').length) + ' chars of a '
			+ long.length + '-char payload');
	check('and the number past the old cut is on screen, not elided',
		/card-4111-2222-3333-4444/.test(wLong.msg?.text || '')
			&& !/…/.test(wLong.msg?.text || ''),
		(wLong.msg?.text || '').includes('…') ? 'an ellipsis is still there' : '');
	check('and an unbroken run wraps instead of running off the card',
		!!wLong.msg && wLong.msg.scrollW <= wLong.msg.clientW + 1,
		wLong.msg ? wLong.msg.scrollW + 'px of text in a ' + wLong.msg.clientW + 'px box'
			: 'no message paragraph found');
	check('and the quote is set apart from the sentence, not run into it',
		!!wLong.msg && wLong.msg.drop !== null && wLong.msg.lineH > 0
			&& wLong.msg.drop >= wLong.msg.lineH * 1.5
			&& Math.abs(wLong.msg.quoteLeft - wLong.msg.left) < 2,
		wLong.msg ? 'quote drops ' + Math.round(wLong.msg.drop) + 'px below the sentence, '
			+ 'one line being ' + Math.round(wLong.msg.lineH) + 'px' : '');
	const longAfterNo = await drv();
	check('and declining still stops it', longAfterNo.types.length === 0,
		JSON.stringify(longAfterNo.types).slice(0, 60));

	// ── 3. The user's own chat is not asked ──
	await resetDrv();
	const chatClick = await page.evaluate(async () =>
		String(await window.__chat.run_tool('web_click', JSON.stringify({ ref: 7 }))));
	const chatDrv = await drv();
	check('the user\'s own chat is not asked, and acts',
		chatDrv.clicks.length === 1, 'driver saw ' + chatDrv.clicks.length
			+ ' click(s); result ' + String(chatClick).slice(0, 60));

	// ── 4. A worker's consent is not remembered ──
	// The chat's click above approved shop.test for acting, which is right for a
	// supervised actor. It must not carry to a worker, and a worker's own yes
	// must not carry to its next act.
	await resetDrv();
	const wAgain = await withDialog(async () =>
		String(await window.__wChat.run_tool('web_click', JSON.stringify({ ref: 9 }))), true);
	check('a worker is asked even where the chat already approved the host', wAgain.asked);
	const yesDrv = await drv();
	check('and a plain yes lets that one act through',
		yesDrv.clicks.length === 1, 'driver saw ' + yesDrv.clicks.length);

	await resetDrv();
	const wThird = await withDialog(async () =>
		String(await window.__wChat.run_tool('web_click', JSON.stringify({ ref: 11 }))), false);
	check('and the yes is not remembered: the next act asks again', wThird.asked);

	// ── 5. Bypass is still bypass ──
	await setMode('bypass');
	await resetDrv();
	const byp = await page.evaluate(async () =>
		String(await window.__wChat.run_tool('web_click', JSON.stringify({ ref: 13 }))));
	const bypDrv = await drv();
	check('a rung the user chose deliberately is not re-armed by this',
		bypDrv.clicks.length === 1, 'driver saw ' + bypDrv.clicks.length
			+ '; result ' + String(byp).slice(0, 60));
	await setMode('guarded');
} catch (e) {
	check('no exception during the run', false, String(e && e.message || e));
} finally {
	try { await s.browser.close(); } catch (e) { /* ignore */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
