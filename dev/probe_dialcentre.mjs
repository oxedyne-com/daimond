// probe_dialcentre.mjs -- the failing-first run of owner-eye D1 (owner_eye/dialcentre.mjs, DIALCENTRE,
// D-20261024-17): each credit row's dial on its row's centre at rail widths 300, 360, 445 and 520 px and
// on the phone, in Obsidian and Porcelain. The same record runs in verify_ownereye.mjs after the deploy;
// this probe stands up only what D1 reads (a signed-in rail with the three stood-in pools).
//
//   bash dev/world.sh N --up; eval "$(bash dev/world.sh N --env)"
//   node dev/probe_dialcentre.mjs [--shots <dir>]
// Exit 0 green, 1 a finding, 2 a setup fault.

import { open, signInAs } from './harness.mjs';
import { standInPools } from './ownereye_pools.mjs';
import D from './owner_eye/dialcentre.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const D1 = D.find((r) => r.id === 'D1');
const CELLS = [{ vp: '1440x900', w: 1440, h: 900, phone: false }, { vp: '393x793', w: 393, h: 793, phone: true }];

let red = 0;
for (const cell of CELLS) {
	let s;
	try {
		s = await open({ name: `dc${cell.w}${Date.now() % 100000}`, connect: false, viewport: { width: cell.w, height: cell.h },
			timezoneId: 'Australia/Sydney', ...(cell.phone ? { browser: 'webkit', touch: true, ua: IPHONE } : { browser: 'chromium' }) });
		const p = s.page;
		await p.emulateMedia({ reducedMotion: 'reduce' });
		await p.waitForFunction(() => !!window.DaimondCore, null, { timeout: 30000 });
		await signInAs(s, s.name);
		await standInPools(p);
		if (cell.phone) await p.evaluate(() => window.DaimondShell && DaimondShell.openDrawer());
		await p.waitForFunction(() => document.querySelectorAll('#spend-row .evp').length === 3, null, { timeout: 15000 });
	} catch (e) { console.log(`  FAIL setup ${cell.vp}: ${e.message.split('\n')[0]}`); process.exit(2); }
	for (const theme of ['obsidian', 'porcelain']) {
		await s.page.evaluate((t) => DaimondTheme.set(t), theme);
		await s.page.waitForTimeout(600);
		let f;
		try { f = await D1.check(s.page, { ...cell, state: 'full', theme }); } catch (e) { f = ['threw: ' + e.message.split('\n')[0]]; }
		const where = `${cell.vp} ${theme}`;
		for (const x of f.filter((x) => x.startsWith('NOTE: '))) console.log(`  note D1 [${where}] ${x.slice(6)}`);
		f = f.filter((x) => !x.startsWith('NOTE: '));
		if (f.length) { red++; for (const x of f) console.log(`  FAIL D1 ${D1.name} [${where}] ${x}  (${D1.cite.id})`); }
		else console.log(`  ok   D1 ${D1.name} [${where}]`);
	}
	try { await s.close(); } catch (e) { /* gone */ }
}
console.log(`\nprobe_dialcentre: ${red ? 'RED' : 'green'}`);
process.exit(red ? 1 : 0);
