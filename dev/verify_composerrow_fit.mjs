// gateway: none
// verify_composerrow_fit.mjs — the phone composer row never draws one control over another (UNBLOCK-81).
//
// The fault: on his phone the row read "OpenRouter ⌄  Here | argonaut  −  High  +", and as the
// row ran short "argonaut" was drawn over "High". Held here BY ROLE, at every phone width from 320
// to 430 px: each control the row holds (the source, both seat segments, the effort step's three
// parts, the walk-back pair) is a box of its own, no two of them meet, and each lies inside the row.
// The row's content is put there by standing in for the switches (as `shot_composerrow.mjs` does):
// the subject is the layout, not the election or the provider list.
//
//   node dev/verify_composerrow_fit.mjs
import { open, connectMock, chat, newChat } from './harness.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const RUNNER = 'argonaut';
const ROLES = ['#source-btn', '#seat-here', '#seat-runner', '#effort-dn', '#effort-val', '#effort-up', '#chat-jump', '#chat-end'];

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const s = await open({ name: 'crfit', touch: true, isMobile: true, ua: IPHONE });
const { page } = s;
try {
	await page.setViewportSize({ width: 393, height: 852 });
	await connectMock(s, { model: 'mock/thinker' });
	await page.evaluate(async () => {
		const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
		await window.DaimondModels.fetchModels((j.def || {}).provider);
	});
	await newChat(s);
	const para = (n) => Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of question ${n}.`).join('\n');
	for (let n = 1; n <= 3; n++) await chat(s, para(n));
	await page.evaluate((name) => {
		const P = window.DaimondPeer;
		P.seatSwitch = () => ({ runner: { deviceId: 'fit-runner', label: name }, choice: 'runner', until: 0 });
		const pres = window.DaimondPresence, was = pres.name;
		pres.name = (id) => (id === 'fit-runner' ? name : was.call(pres, id));
		window.dispatchEvent(new Event('daimond:view'));
	}, RUNNER);
	await page.waitForTimeout(600);

	let worst = null, widths = 0;
	for (let w = 320; w <= 430; w += 10) {
		await page.setViewportSize({ width: w, height: 852 });
		await page.waitForTimeout(350);
		const m = await page.evaluate(({ roles }) => {
			// The source switch as his row has it: a provider named, after any re-render.
			const sw = document.getElementById('source-switch'), nm = document.getElementById('source-name');
			if (sw && nm) { sw.hidden = false; nm.textContent = 'OpenRouter'; }
			const o = document.getElementById('chat-output');
			if (o) { o.scrollTop = 0; o.dispatchEvent(new Event('scroll')); }
			const row = document.getElementById('composer-row');
			const rr = row && row.getBoundingClientRect();
			const boxes = [];
			for (const sel of roles) {
				const e = document.querySelector(sel);
				if (!e || !e.getClientRects().length || e.closest('[hidden]')) continue;
				const b = e.getBoundingClientRect();
				if (b.width < 1 || b.height < 1) continue;
				boxes.push({ sel, l: b.left, r: b.right, t: b.top, b: b.bottom, text: (e.textContent || '').trim().slice(0, 16) });
			}
			const meets = [];
			for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i], c = boxes[j];
				const dx = Math.min(a.r, c.r) - Math.max(a.l, c.l), dy = Math.min(a.b, c.b) - Math.max(a.t, c.t);
				if (dx > 1 && dy > 1) meets.push(a.sel + '(' + a.text + ') over ' + c.sel + '(' + c.text + ') by ' + Math.round(dx) + 'px');
			}
			const out = rr ? boxes.filter(b => b.l < rr.left - 1 || b.r > rr.right + 1)
				.map(b => b.sel + ' [' + Math.round(b.l) + ',' + Math.round(b.r) + '] outside [' + Math.round(rr.left) + ',' + Math.round(rr.right) + ']') : ['no row'];
			return { n: boxes.map(b => b.sel), meets, out };
		}, { roles: ROLES });
		widths++;
		const bad = m.meets.length + m.out.length;
		if (bad && !worst) worst = { w, ...m };
		if (w === 390) check(['#seat-runner', '#effort-val', '#source-btn'].every(r => m.n.includes(r)),
			'the row holds the source, the runner and the effort level at 390', m.n.join(' '));
	}
	check(!worst, 'no control in the composer row meets another or leaves the row, ' + widths + ' widths 320..430',
		worst ? worst.w + 'px: ' + worst.meets.concat(worst.out).join('; ') : null);
} catch (e) {
	console.log('  FAIL threw — ' + (e && e.message));
	failures++;
} finally {
	await s.close();
}
console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
