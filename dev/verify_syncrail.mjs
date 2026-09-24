// verify_syncrail.mjs -- the rail's one-line status summary follows the sync chip through a stall
// (D072, P1a M7, 2026-09-25).
//
// THE DEFECT. `DaimondSync` carried two `state` keys in one object literal. The later one, the
// engine's facts as an object, replaced the earlier, the chip's one word, so
// `renderStatusSummary` (daimond.js) was handed an object, matched none of its words and drew
// "This device only" with a grey dot whatever sync was doing -- through every stall included. And
// nothing redrew the line when the chip changed, so even a right word would have been only as fresh
// as the last unrelated repaint.
//
// In a REAL page on the REAL gateway, with every content POST to /api/sync answered 500 from the
// middle of the run:
//
//   1. [ctl] a turn lands, and the summary reads synced (green dot);
//   2. [ctl] a push then fails and the work is owed: the chip says so;
//   3. THE SUMMARY SAYS SO TOO, with nothing but the chip having changed: a warning dot and not
//      "This device only";
//   4. once POSTs are answered again the owed work lands and the summary returns to synced.
//
// Run from a tree root with its world and gateway up:  node dev/verify_syncrail.mjs
import path from 'node:path';
const DEV = path.join(process.cwd(), 'dev');
const { open, chat, newChat, connectMock } = await import(path.join(DEV, 'harness.mjs'));
const { makePagePro } = await import(path.join(DEV, 'pro.mjs'));
const { GW_URL } = await import(path.join(DEV, 'ports.mjs'));

let bad = 0, good = 0;
const check = (n, pass, d) => { pass ? good++ : bad++; console.log((pass ? '  ok   ' : '  FAIL ') + n + (d ? ' -- ' + String(d).slice(0, 300) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const railOf = (pg) => pg.evaluate(() => {
	const sum  = document.getElementById('astat-summary');
	const dot  = sum ? sum.querySelector('.astat-dot') : null;
	const val  = sum ? sum.querySelector('.astat-val') : null;
	const chip = document.getElementById('sync-chip');
	const st   = window.DaimondSync.state();
	return {
		dot:   dot ? String(dot.className).replace('astat-dot', '').trim() : '',
		text:  val ? val.textContent : '',
		chip:  chip && chip.style.display !== 'none' ? (chip.dataset.state || '') : '',
		why:   st.stalledWhy,
		model: !!(window.DaimondModels && DaimondModels.ready()),
	};
});

const s = await open({ name: 'syncrail', signIn: true, connect: true, defaults: false });
const pg = s.page;
try {
	await pg.waitForFunction(() => !!window.DaimondSync && !!window.DaimondCore && window.DaimondGateway
		&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	// The summary is a ladder, and a model that cannot run outranks sync: connect one the way
	// the settings form does, so the line is free to talk about sync.
	await connectMock(s);
	const pro = await makePagePro(pg, path.join(process.cwd(), 'gateway'), GW_URL);
	check('[ctl] Pro held, so this device syncs', pro.pro === true, JSON.stringify(pro));
	await pg.evaluate(() => { try { window.DaimondSync.recheck(); } catch (e) { /* */ } });
	await sleep(3000);
	await newChat(s);
	await chat(s, 'first turn so the account has a parcel');
	for (let i = 0; i < 20; i++) {
		const r = await railOf(pg);
		if (r.dot === 'ok' && !r.chip) break;
		await sleep(1000);
	}
	const r0 = await railOf(pg);
	check('[ctl] 1. after a landed round the summary reads synced', r0.dot === 'ok', JSON.stringify(r0));
	const localWord = await pg.evaluate(() => {
		try { return window.DaimondI18n ? DaimondI18n.t('astat.sum_local') : ''; } catch (e) { return ''; }
	});

	// Every content POST to /api/sync answers 500 from here; everything else is real.
	await pg.evaluate(() => {
		const G = window.DaimondGateway;
		const orig = G.gwFetch;
		window.__posts = 0;
		window.__fail = true;
		G.gwFetch = async function (p, o) {
			const q = new URL('http://x' + p).searchParams;
			if (window.__fail && String(p).startsWith('/api/sync') && o && o.method === 'POST'
				&& !q.has('presence') && !q.has('lease') && !q.has('progress')) {
				window.__posts++;
				return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'content-type': 'application/json' } });
			}
			return orig.apply(this, arguments);
		};
	});
	await newChat(s);
	await chat(s, 'owed work: this turn must not strand');
	for (let i = 0; i < 30 && !(await pg.evaluate(() => window.__posts)); i++) await sleep(1000);
	if (!(await pg.evaluate(() => window.__posts))) await pg.evaluate(() => window.DaimondSync.push()).catch(() => {});
	let r1 = null;
	for (let i = 0; i < 20; i++) {
		r1 = await railOf(pg);
		if (r1.chip === 'stalled') break;
		await sleep(500);
	}
	check('[ctl] 2. the push failed and the chip shows the owed work', (await pg.evaluate(() => window.__posts)) >= 1
		&& r1.chip === 'stalled' && r1.why === 'unsent', JSON.stringify(r1));
	// Nothing else is repainted here: the line must have followed the chip on its own.
	await sleep(500);
	const r2 = await railOf(pg);
	check('3. through the stall the summary says so: a warning dot (release 4: grey)', r2.dot === 'warn',
		JSON.stringify(r2));
	check('3. and not "This device only"', !!r2.text && r2.text !== 'This device only'
		&& (!localWord || r2.text !== localWord), JSON.stringify({ text: r2.text, local: localWord }));

	await pg.evaluate(() => { window.__fail = false; });
	await pg.evaluate(() => window.DaimondSync.push()).catch(() => {});
	let r3 = null;
	for (let i = 0; i < 90; i++) {
		r3 = await railOf(pg);
		if (!r3.why && r3.dot === 'ok') break;
		await sleep(1000);
	}
	check('4. once POSTs land again the owed work goes and the summary reads synced', !r3.why && r3.dot === 'ok',
		JSON.stringify(r3));
} finally {
	console.log('\n' + good + ' ok, ' + bad + ' failed');
	try { await s.close(); } catch (e) { /* */ }
	try { await s.browser.close(); } catch (e) { /* */ }
	process.exit(bad ? 1 : 0);
}
