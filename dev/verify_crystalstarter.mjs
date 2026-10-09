// gateway: none
// verify_crystalstarter — the crystal starter page (K4, D-20261008-08) passes the proof when forked unchanged.
//
// WHY THIS EXISTS. The Ontheism daimon could not make a crystal infographic: it forked a hand-built page
// full of earlier hacks (`loadSelf`, a re-ping, a `<pre>` dump of the data) and re-derived the handshake on
// every retry. `DaimondCrystal.STARTER_PAGE` is the page to fork instead, installed by the app at
// `STARTER_PATH` and named in the standing context. This proves, in the real app, that:
//
//   1. the app installed the starter where a daimon is told to look, and `file_read` returns it;
//   2. an UNCHANGED fork, over a crystal shaped like the Ontheism one (~11 KB, sections, a data-URI image),
//      passes the proof judged from OUTSIDE the frame: the frame is up (no fallback), every content key is
//      reported, the rendered text carries the title, a prefix of the summary and every section heading,
//      there is no `<pre>`, no run of JSON, no debug node, and there are graphic parts (svg, bars, rings);
//   3. it does so in Porcelain and Obsidian, at 1440 and at 390, with no sideways scroll at 390;
//   4. a NEW key the starter has never heard of draws, by its shape, and is reported.
//
//   node dev/verify_crystalstarter.mjs [--shots DIR] [--break loadself|nokeys]
//
// --break loadself   the forked page asks the app for its own file (`asset`), as the Ontheism page did: red.
// --break nokeys     the fork forgets to report a key it drew: the coverage check goes red.
import { open } from './harness.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE  = dirname(fileURLToPath(import.meta.url));
const argv  = process.argv.slice(2);
const arg   = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const SHOTS = arg('--shots');
const BREAK = arg('--break');
const DATA  = JSON.parse(readFileSync(join(HERE, 'fixtures', 'crystalstarter', 'ontheism_like.json'), 'utf8'));
const NAME  = 'StarterK4';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true }); } };

const engine = async (page, fn, arg) => page.evaluate(async ({ src, arg }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return (new Function('app', 'arg', 'return (async () => {' + src + '})()'))(app, arg);
}, { src: fn, arg });

async function showCrystal(page) {
	await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
	await page.waitForTimeout(600);
	await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
	let st = null;
	for (let i = 0; i < 40; i++) {
		st = await page.evaluate(() => window.DaimondCrystal ? DaimondCrystal._state() : null);
		if (st && (st.mode === 'fallback' || (st.mode === 'frame' && st.keys.length))) break;
		await page.waitForTimeout(250);
	}
	await page.waitForTimeout(1800); // past FALLBACK_MS, so a late fallback is seen
	return page.evaluate(() => DaimondCrystal._state());
}

// What a person sees, read from outside the page's own claims.
async function outside(page) {
	const h = await page.$('iframe.crystal-frame');
	const fr = h ? await h.contentFrame() : null;
	if (!fr) return null;
	return fr.evaluate(() => ({
		text:    document.body.innerText,
		html:    document.body.innerHTML,
		pre:     document.querySelectorAll('pre').length,
		dbg:     !!document.querySelector('#dbg,[id*=debug i]'),
		svg:     document.querySelectorAll('svg').length,
		bars:    document.querySelectorAll('.bt i').length,
		rings:   document.querySelectorAll('.ring').length,
		tl:      document.querySelectorAll('.tl li').length,
		spec:    document.querySelectorAll('.st i').length,
		imgs:    [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length,
		wide:    document.documentElement.scrollWidth - document.documentElement.clientWidth,
		color:   getComputedStyle(document.body).color,
	}));
}

const verdict = (tag, st, o, data, keysWanted) => {
	check(`${tag}: the page is up, not the fallback`, st && st.mode === 'frame' && st.ready, st && `${st.mode} ${st.reason}`);
	const missing = keysWanted.filter((k) => !(st && st.keys.includes(k)));
	check(`${tag}: every content key is reported drawn`, !missing.length, missing.length ? 'missing ' + missing.join(',') : `${st.keys.length} keys`);
	if (!o) { check(`${tag}: the frame can be read`, false); return; }
	const t = o.text.replace(/\s+/g, ' ');
	check(`${tag}: the title is on screen`, t.includes(data.title));
	check(`${tag}: the summary is on screen`, t.includes(data.summary.slice(0, 60)));
	const lost = data.sections.filter((s) => !t.includes(s.heading)).map((s) => s.heading);
	check(`${tag}: every section heading is on screen`, !lost.length, lost.join(', '));
	check(`${tag}: no <pre>, no JSON run, no debug node`, o.pre === 0 && !/\{"|":\s*["\[{\d]/.test(t) && !o.dbg && !/KEYMAP|DKEYS/.test(o.html),
		`pre ${o.pre} dbg ${o.dbg}`);
	check(`${tag}: graphic parts are drawn`, o.svg >= 3 && o.bars >= 4 && o.rings >= 3 && o.tl >= 3 && o.spec >= 1,
		`svg ${o.svg} bars ${o.bars} rings ${o.rings} timeline ${o.tl} spectrum ${o.spec}`);
	check(`${tag}: the data-URI image loads`, o.imgs >= 1, `${o.imgs} images`);
};

const CONTENT = Object.keys(DATA);
for (const theme of ['porcelain', 'obsidian']) {
	const s = await open({
		name: 'crystalstarter' + theme, signIn: true, connect: true, defaults: false,
		route: async (page) => {
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.addInitScript((th) => {
				try { localStorage.setItem('daimond-skin', 'daylight'); localStorage.setItem('daimond-theme', th); } catch (e) {}
			}, theme);
		},
	});
	const page = s.page;
	await page.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
	await page.waitForTimeout(900);
	await page.fill('.dlg-input', NAME).catch(() => {});
	await page.click('.dlg-ok', { force: true }).catch(() => {});
	await page.waitForTimeout(2500);

	// (1) installed, and readable through the daimon's own tool.
	const got = await engine(page, `
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === arg);
		const r = await app.run_tool('file_read', JSON.stringify({ path: DaimondCrystal.STARTER_PATH }));
		return { id: d ? d.id : '', read: String(r) };`, NAME);
	const starter = await page.evaluate(() => DaimondCrystal.STARTER_PAGE || '');
	check(`${theme}: the app installed the starter and file_read returns it`,
		!!starter && got.read.includes('The Daimond crystal starter') && got.read.includes('cmd:"ready"'),
		`${starter.length} bytes; read ${got.read.length}`);
	check(`${theme}: the starter never reads a file itself`, starter && !/cmd:"asset"|loadSelf\(|fetch\(/.test(starter));

	// (2) an unchanged fork over the Ontheism-shaped crystal.
	let fork = starter;
	if (BREAK === 'loadself') fork = fork.replace('post({cmd:"ready"});', 'post({cmd:"asset",id:"x",path:"crystal.json"});');
	if (BREAK === 'nokeys') fork = fork.replace('keys.push(\'stats\')', '0').replace("keys.push(k); h += head(k) + part[k]", "h += head(k) + part[k]");
	await engine(page, `
		await app.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + arg.id + '/crystal.json', content: JSON.stringify(arg.data) }));
		await app.write_crystal_page(arg.id, arg.fork);`, { id: got.id, data: DATA, fork });
	for (const w of [1440, 390]) {
		await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
		await page.reload(); await page.waitForTimeout(2500);
		await page.evaluate((n) => { const e = [...document.querySelectorAll('*')].find(x => !x.children.length && x.textContent.trim() === n); if (e) e.click(); }, NAME);
		await page.waitForTimeout(1200);
		const st = await showCrystal(page);
		const o = await outside(page);
		verdict(`${theme} ${w}`, st, o, DATA, CONTENT);
		if (w === 390) check(`${theme} 390: no sideways scroll`, o && o.wide <= 1, o && `${o.wide}px`);
		await shot(page, `starter-${theme}-${w}`);
	}

	// (4) a key no part names, in two shapes, draws and is reported.
	const more = Object.assign({}, DATA, {
		influences: [{ label: 'Spinoza', value: 8 }, { label: 'Whitehead', value: 5 }],
		milestones: [{ when: '2026-10', what: 'Infographic page' }],
	});
	await engine(page, `
		await app.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + arg.id + '/crystal.json', content: JSON.stringify(arg.data) }));`,
		{ id: got.id, data: more });
	await page.reload(); await page.waitForTimeout(2500);
	await page.evaluate((n) => { const e = [...document.querySelectorAll('*')].find(x => !x.children.length && x.textContent.trim() === n); if (e) e.click(); }, NAME);
	await page.waitForTimeout(1200);
	const st2 = await showCrystal(page);
	const o2 = await outside(page);
	check(`${theme}: a new key draws and is reported`, st2 && st2.mode === 'frame' && st2.keys.includes('influences') && st2.keys.includes('milestones')
		&& o2 && o2.text.includes('Spinoza') && o2.text.includes('Infographic page') && o2.bars >= 6 && o2.tl >= 4,
		st2 && `${st2.mode} keys ${st2.keys.join(',')}`);
	await s.browser.close().catch(() => {});
}

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
