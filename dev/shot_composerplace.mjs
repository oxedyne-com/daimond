// shot_composerplace.mjs -- the composer row on a phone, above the box (D-20261016-04), where
// it collapses to nothing when empty and Send holds still. In (a) a chat with a runner and Effort levels, scrolled
// up so the walk-back pair shows, and (b) a short chat on a model with no levels and no runner.
// The runner is a stand-in for `DaimondPeer.seatSwitch`, as in shot_composerrow.mjs.
//
//   eval "$(bash dev/world.sh N --env)"
//   DAIMOND_BROWSER=chromium|webkit node dev/shot_composerplace.mjs <outdir>
import { open, scratch, connectMock, chat, newChat, BROWSER } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || 'dev/shots';
const RUNNER = 'Jason’s MacBook Pro (Work, 16-inch, M5 Max, 2026)';
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'crplace', touch: true, profile: scratch('pw', 'crplace-' + BROWSER + '-' + process.pid) });
const { page } = s;
const rects = () => page.evaluate(() => {
	const r = (sel) => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null;
		const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
	return { row: r('#composer-row'), effort: r('#effort-step'), jump: r('#chat-jump'), send: r('#chat-send') };
});
const setDefault = (m) => page.evaluate(async (model) => {
	const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
	const p = (j.def || {}).provider;
	await window.DaimondModels.fetchModels(p);
	window.DaimondModels.setDefault(p, model);
}, m);
const shoot = async (scene) => {
	await page.waitForTimeout(500);
	if (scene === 'a') await page.evaluate(() => {
		const o = document.getElementById('chat-output');
		if (o) { o.scrollTop = 0; o.dispatchEvent(new Event('scroll')); }
	});
	await page.waitForTimeout(600);
	const f = path.join(OUT, `phone_${scene}_${BROWSER}_393x793.png`);
	await page.screenshot({ path: f });
	console.log(path.basename(f), JSON.stringify(await rects()));
};
try {
	// The rail's New Chat is off screen at a phone's width, so each chat is made wide.
	const wide  = () => page.setViewportSize({ width: 1280, height: 900 });
	const phone = () => page.setViewportSize({ width: 393, height: 793 });
	await connectMock(s, { model: 'mock/thinker' });
	await setDefault('mock/thinker');
	await newChat(s);
	const para = (n) => Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of question ${n} about the kitchen.`).join('\n');
	for (let n = 1; n <= 4; n++) await chat(s, para(n));
	const was = await page.evaluate((name) => {
		const P = window.DaimondPeer;
		window.__seatWas = P.seatSwitch;
		P.seatSwitch = () => ({ runner: { deviceId: 'shot-runner', label: name }, choice: 'runner', until: 0 });
		const pres = window.DaimondPresence, w = pres.name;
		pres.name = (id) => (id === 'shot-runner' ? name : w.call(pres, id));
		window.dispatchEvent(new Event('daimond:view'));
		return true;
	}, RUNNER);
	await phone();
	await shoot('a');

	// (b) Neither: the runner gone, a model with no levels, a chat too short to scroll.
	await page.evaluate(() => {
		window.DaimondPeer.seatSwitch = window.__seatWas;
		window.dispatchEvent(new Event('daimond:view'));
	});
	await setDefault('mock/fast');
	await wide();
	await newChat(s);
	await chat(s, 'Short question.');
	await phone();
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:view')));
	await shoot('b');
	void was;
} finally {
	await s.close();
}
