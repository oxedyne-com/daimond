// shot_testnet.mjs — the TEST chip, the Testnet sheet and the report box (tn-U2a).
//
// `/api/policy` is stubbed to the gateway's contract with `page.route`, once as
// "test" and once as "live", at the desktop floor (1280×720) and the phone
// (390×845). Live must draw no chip. Each shot is measured as well as taken: the
// chip's drawing and its hit area, and whether the sheet and box fit unscrolled.
//
// Run:  DAIMOND_PORT=<port> node dev/shot_testnet.mjs <out dir>
import { open } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.resolve(process.argv[2] || path.join(process.cwd(), 'dev', 'shots', 'testnet'));
fs.mkdirSync(OUT, { recursive: true });

const POLICY = (network, runner) => ({
	ok: true, chat_expire_days: 30, trash_retain_days: 30, network, capabilities: { runner },
});

const SIZES = [
	{ tag: '1280', viewport: { width: 1280, height: 720 }, phone: false },
	{ tag: '390',  viewport: { width: 390,  height: 845 }, phone: true },
];

async function shoot(net, size) {
	const s = await open({
		name: `tn-${net}-${size.tag}`, connect: false, viewport: size.viewport,
		touch: size.phone, isMobile: size.phone, serviceWorkers: 'block',
		route: async (page) => {
			await page.route('**/api/policy', (r) => r.fulfill({
				status: 200, contentType: 'application/json', body: JSON.stringify(POLICY(net, net !== 'test')),
			}));
		},
	});
	const p = s.page;
	await p.waitForTimeout(1500);
	const name = (k) => path.join(OUT, `${net}_${k}_${size.tag}.png`);
	await p.screenshot({ path: name('bar') });
	const bar = await p.evaluate(() => {
		const c = document.querySelector('.net-chip');
		if (!c) return { chip: false, title: document.title };
		const r = c.getBoundingClientRect(), after = getComputedStyle(c, '::after');
		const bg = document.querySelector('.brand-group').getBoundingClientRect();
		return {
			chip: true, title: document.title,
			draw: { w: Math.round(r.width), h: Math.round(r.height) },
			hit: { w: Math.round(r.width - 2 * parseFloat(after.left)), h: Math.round(r.height - 2 * parseFloat(after.top)) },
			outline: getComputedStyle(c).borderTopWidth,
			inGroup: r.right <= bg.right + 0.5 && r.left >= bg.left - 0.5,
			icon: document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href'),
			manifest: document.querySelector('link[rel="manifest"]').getAttribute('href'),
		};
	});
	console.log(`${net} ${size.tag} bar  ${JSON.stringify(bar)}`);
	if (bar.chip) {
		await p.click('.net-chip');
		await p.waitForSelector('#testnet-sheet .modal-card');
		await p.waitForTimeout(200);
		await p.screenshot({ path: name('sheet') });
		console.log(`${net} ${size.tag} sheet ${JSON.stringify(await p.evaluate(() => {
			const c = document.querySelector('#testnet-sheet .modal-card');
			const row = c.querySelector('.tn-row').getBoundingClientRect();
			return { scroll: c.scrollHeight - c.clientHeight, rowH: Math.round(row.height), copy: !!c.querySelector('.tn-copy') };
		}))}`);
		await p.click('#testnet-sheet .tn-report');
		await p.waitForSelector('#support-sheet textarea');
		await p.fill('#support-sheet textarea', 'The upload stalled at 80% on the second file.');
		await p.waitForTimeout(200);
		await p.screenshot({ path: name('box') });
	}
	await s.close();
}

for (const size of SIZES) {
	await shoot('test', size);
	await shoot('live', size);
}
console.log(`shots in ${OUT}`);
