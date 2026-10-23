// The rail's money pools as electric cars (D-20261020-14 EV, variant F Rows, owner
// refinements D-20261022-07), shot in four states -- idle, normal, a fast burst and
// nearly empty -- at 1440x900 or 390x845, Obsidian or Porcelain, in the browser
// DAIMOND_BROWSER names, to sit beside the chosen mock-up's shots
// (evrail/shots2/vf_*). Three stubbed pools: Daimond credits (12.50 of a 20 top-up),
// an OpenRouter key limit (37.18 of 50) and an Anthropic credit (8.40 of 10); the
// pace is real spend in the ledger, so the dial is the app's own reading.
//
//   node dev/shot_credcyl.mjs --out DIR [--phone] [--look obsidian|porcelain]
//
// Writes DIR/ev_<look>_<desk|phone>_<browser>_<state>.png (the window) and
// ..._rail.png (the pools and Today, at twice the size), and prints one line per
// state with what each pool drew.
import fs from 'node:fs';
import path from 'node:path';
import { open, signInAs, BROWSER } from './harness.mjs';

const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const PHONE = argv.includes('--phone'), LOOK = arg('--look') === 'porcelain' ? 'porcelain' : 'obsidian';
const OUT = arg('--out');
if (!OUT) { console.error('--out DIR is required'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const vp = PHONE ? { width: 390, height: 845 } : { width: 1440, height: 900 };

const s = await open({ name: 'evshot' + LOOK + (PHONE ? 'p' : 'd') + (Date.now() % 100000), viewport: vp,
	...(PHONE ? { touch: true, isMobile: BROWSER === 'chromium' } : {}),
	route: async (page) => {
		await page.addInitScript((th) => { try { localStorage.setItem('daimond-skin', 'daylight'); localStorage.setItem('daimond-theme', th); } catch (e) {} }, LOOK);
	} });
const { page } = s;
await page.waitForFunction(() => !!(window.DaimondLedger && window.DaimondModels && window.DaimondGateway), null, { timeout: 30000 });
// Five Diamonds and six Chats, as the mock-up's shots have, so the lists above the
// pools are drawn at their five-tile floor (no OPFS in WebKit: no Diamonds there).
await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	for (const n of ['Daimond', 'Oxegen', 'Hematite', 'Ontheism', 'Reit Hoogland']) { try { await app.create_diamond(n); } catch (e) { /* no OPFS */ } }
	await new Promise((res) => {
		const now = Date.now(), rows = [];
		for (let i = 0; i < 6; i++) rows.push({ id: 'evshot' + i, name: 'New Chat', createdAt: now - i * 6e4, updatedAt: now - i * 6e4, messages: [], msgCount: 2, model: 'mock/fast' });
		const r = indexedDB.open('daimond-chats');
		r.onsuccess = () => {
			let t;
			try { t = r.result.transaction('chats', 'readwrite'); } catch (e) { res(); return; }
			rows.forEach((x) => t.objectStore('chats').put(x));
			t.oncomplete = () => { try { localStorage.setItem('daimond-chats-count', String(rows.length)); } catch (e) {} res(); };
			t.onerror = () => res();
		};
		r.onerror = () => res();
	});
});
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, s.name);
await page.waitForFunction(() => !!(window.DaimondLedger && window.DaimondModels && window.DaimondGateway), null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.evaluate(() => { const c = document.getElementById('settings-close'); if (c && c.offsetParent) c.click(); });
await page.waitForTimeout(300);

const STATES = [
	['idle',   { credits: 1250, or: 37.18, an: 8.4 }, []],
	['normal', { credits: 1250, or: 37.18, an: 8.4 }, [['openrouter', 0.5], ['credits', 0.12]]],
	['burst',  { credits: 1250, or: 37.18, an: 8.4 }, [['openrouter', 0.6], ['anthropic', 0.2]]],
	['empty',  { credits: 40, or: 1.2, an: 0.35 }, [['credits', 0.05]]],
];
let ok = true;
for (const [state, amt, spends] of STATES) {
	const got = await page.evaluate(async ({ amt, spends }) => {
		const now = Date.now();
		window.__ev = amt;
		if (!window.__evGs) {
			window.__evGs = DaimondGateway.state.bind(DaimondGateway);
			DaimondModels.noteTopups([
				{ key: 'credits', mark: { full: 20, at: now - 3600e3, last: 20 } },
				{ key: 'openrouter', mark: { full: 50, at: now - 3600e3, last: 50 } },
				{ key: 'anthropic', mark: { full: 10, at: now - 3600e3, last: 10 } },
			]);
		}
		DaimondGateway.state = () => Object.assign({}, window.__evGs(), { authed: true, credits: window.__ev.credits, currency: 'USD' });
		DaimondModels.providers = () => [
			{ id: 'openrouter', name: 'OpenRouter', hasKey: true, paid: false, credit: { mode: 'auto', usd: window.__ev.or, binds: 'limit' } },
			{ id: 'anthropic', name: 'Anthropic', hasKey: true, paid: false, credit: { mode: 'manual', usd: window.__ev.an } },
		];
		for (const [pv, usd] of spends) DaimondLedger.record({ ts: Date.now(), model: 'mock/fast', promptTokens: 100, completionTokens: 100, costUsd: usd, provider: pv });
		DaimondI18n.setCurrency('USD');
		await new Promise((r) => setTimeout(r, 400));
		return [...document.querySelectorAll('#spend-row .evp')].map((r) => r.dataset.pool + ' '
			+ r.querySelector('svg.evb').dataset.level + ' ' + r.querySelector('svg.evd').dataset.angle + ' ' + r.querySelector('.evmi').textContent);
	}, { amt, spends });
	if (got.length !== 3) ok = false;
	if (PHONE) {
		await page.keyboard.press('Escape'); await page.waitForTimeout(200);
		await page.evaluate(() => window.DaimondShell && DaimondShell.openDrawer());
		await page.waitForTimeout(500);
	}
	// The foot in view: the drawer on a phone, the rail on a short desktop, both scroll.
	await page.evaluate(() => { const r = document.getElementById('rail-scroll'); if (r) r.scrollTop = r.scrollHeight; });
	await page.waitForTimeout(250);
	const base = path.join(OUT, `ev_${LOOK}_${PHONE ? 'phone' : 'desk'}_${BROWSER}_${state}`);
	await page.screenshot({ path: base + '.png', timeout: 8000 }).catch(() => { ok = false; });
	const box = await page.evaluate(() => {
		const a = document.querySelector('#spend-row .evpools'), t = document.querySelector('#spend-row .spend-today');
		if (!a) return null;
		const x = a.getBoundingClientRect(), y = (t || a).getBoundingClientRect();
		return { x: Math.max(0, x.left - 6), y: Math.max(0, x.top - 6), width: x.width + 12, height: Math.max(x.bottom, y.bottom) - x.top + 12 };
	});
	if (box) {
		await page.screenshot({ path: base + '_rail.png', clip: box, scale: 'device', timeout: 8000 }).catch(() => { ok = false; });
	} else ok = false;
	console.log(state.padEnd(7), JSON.stringify(got), base + '.png');
}
await s.browser?.close?.();
try { await s.close?.(); } catch (e) {}
console.log(ok ? 'PASS evshots' : 'FAIL evshots');
process.exit(ok ? 0 : 1);
