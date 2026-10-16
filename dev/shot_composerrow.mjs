// shot_composerrow.mjs -- the composer row (D-20261014-08) at the three sizes the owner reads it at.
//
// A chat on mock/thinker (a model that lists Effort levels), a few turns so the walk-back pair has
// somewhere to go, and the seat switch drawn with the longest runner name the row has to hold. The
// runner is put there by standing in for `DaimondPeer.seatSwitch`, since a real one needs a paired
// device and a gateway, and the row's layout is the subject here, not the election.
//
//   eval "$(bash dev/world.sh N --env)"
//   DAIMOND_BROWSER=chromium|webkit node dev/shot_composerrow.mjs <outdir> <tag> [phone]
import { open, scratch, connectMock, chat, newChat, BROWSER } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || 'dev/shots';
const TAG = process.argv[3] || 'shot';
const RUNNER = 'Jason’s MacBook Pro (Work, 16-inch, M5 Max, 2026)';
const PHONE = process.argv[4] === 'phone';	// a touch context at a phone's size
const SIZES = PHONE ? [[393, 793]] : [[3440, 1321], [1920, 961]];
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'crshot', touch: PHONE, profile: scratch('pw', 'crshot-' + BROWSER + '-' + process.pid) });
const { page } = s;
try {
	await connectMock(s, { model: 'mock/thinker' });
	await page.evaluate(async () => {
		const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
		await window.DaimondModels.fetchModels((j.def || {}).provider);
	});
	await newChat(s);
	// Tall enough that the thread scrolls, so the walk-back pair has somewhere to go.
	const para = (n) => Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of question ${n} about the kitchen.`).join('\n');
	for (let n = 1; n <= 4; n++) await chat(s, para(n));
	await page.evaluate((name) => {
		const P = window.DaimondPeer;
		P.seatSwitch = () => ({ runner: { deviceId: 'shot-runner', label: name }, choice: 'runner', until: 0 });
		const pres = window.DaimondPresence, was = pres.name;
		pres.name = (id) => (id === 'shot-runner' ? name : was.call(pres, id));
		window.dispatchEvent(new Event('daimond:view'));
	}, RUNNER);
	for (const [w, h] of SIZES) {
		await page.setViewportSize({ width: w, height: h });
		await page.waitForTimeout(900);
		// Scrolled up a little, so the walk-back pair is drawn.
		await page.evaluate(() => {
			const o = document.getElementById('chat-output');
			if (o) { o.scrollTop = 0; o.dispatchEvent(new Event('scroll')); }
		});
		await page.waitForTimeout(600);
		const f = path.join(OUT, `${TAG}_${BROWSER}_${w}x${h}.png`);
		await page.screenshot({ path: f });
		const m = await page.evaluate(() => {
			const r = (sel) => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null;
				const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
			return { row: r('#composer-row'), seat: r('#seat-switch'), effort: r('#effort-step'),
				jump: r('#chat-jump'), end: r('#chat-end'), send: r('#chat-send') };
		});
		console.log(f, JSON.stringify(m));
	}
} finally {
	await s.close();
}
