// gateway: live -- the world's gateway, so the drawer is an account's and its amounts are the gateway's
// shot_creditsother.mjs -- the Credits drawer, at a computer and a phone, in US and
// Australian dollars (UNBLOCK-19/20: the presets come from the gateway and any other
// amount may be typed). A thing to LOOK at; `SHOT_TAG` names the run (before / after).
//
//   eval "$(bash dev/world.sh N --env)"; SHOT_TAG=after node dev/shot_creditsother.mjs
import { open } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAG = process.env.SHOT_TAG || 'shot';
const OUT = process.env.SHOT_OUT || path.join(os.homedir(), '.cache', 'daimond', process.env.RC_SLOT || 'solo', 'creditsother');
fs.mkdirSync(OUT, { recursive: true });

for (const [form, viewport, touch] of [['desk', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
	const s = await open({ name: 'creditshot-' + form, viewport, touch, connect: false });
	const p = s.page;
	try {
		await p.waitForFunction(() => !!(window.DaimondGateway && DaimondGateway.state().authed), null, { timeout: 30000 });
		for (const ccy of ['USD', 'AUD']) {
			await p.evaluate((c) => DaimondI18n.setCurrency(c), ccy);
			await p.evaluate(() => document.getElementById('user-row').click());
			await p.waitForTimeout(600);
			await p.evaluate(() => DaimondAdmin.credits());
			await p.waitForTimeout(1200);
			// A typed figure, so the dollars it bills are on show.
			const typed = await p.evaluate(() => {
				const i = document.getElementById('credit-other-input');
				if (!i) return false;
				i.value = '20';
				i.dispatchEvent(new Event('input', { bubbles: true }));
				return true;
			});
			await p.waitForTimeout(300);
			const file = path.join(OUT, `${TAG}_${form}_${ccy}.png`);
			// The drawer scrolls: bring the amounts to the middle, then take the drawer as seen.
			await p.evaluate(() => { const w = document.getElementById('credits-packs'); if (w) w.scrollIntoView({ block: 'center' }); });
			await p.waitForTimeout(250);
			// The drawer as seen: the nearest scrolling box that holds the amounts.
			const clip = await p.evaluate(() => {
				let e = document.getElementById('credits-packs');
				while (e && e !== document.body && !/(auto|scroll)/.test(getComputedStyle(e).overflowY)) e = e.parentElement;
				const r = (e || document.body).getBoundingClientRect();
				return { x: r.x, y: Math.max(0, r.y), width: r.width, height: Math.min(r.height, innerHeight - Math.max(0, r.y)) };
			});
			await p.screenshot({ path: file, clip });
			const packs = await p.evaluate(() => [...document.querySelectorAll('#credits-packs .credit-pack')].map((b) => b.textContent));
			console.log(form, ccy, 'typed:', typed, 'buttons:', JSON.stringify(packs), '->', file);
			await p.keyboard.press('Escape');
			await p.waitForTimeout(300);
		}
	} finally {
		await s.close();
	}
}
