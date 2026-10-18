// gateway: none
// verify_pagewrite.mjs — a crystal page's save is written and stamped as one act, and an append
// records its path as a page log (PLB of the page-log guard).
//
// One context, the real wasm, a real crystal page saving through the frame:
//
//   1. STAMP FAILS, BYTES PUT BACK. With the Diamond's `.daimond/meta.json` gone, the stamp cannot
//      be made; the frame is answered with an error and the page's file is byte-equal to before.
//      Before PLB the save answered ok with the row written and the Diamond unstamped, so the next
//      sync took the other device's copy and the row with it.
//   2. APPEND RECORDS THE PATH, once, in `.daimond/pagelogs`, and the save moves `touched`.
//   3. REPLACE RECORDS NOTHING: a whole-file save is not a page log.
//   4. A `store_write` of a `.jsonl` is not recorded (a control: only the page's append door
//      records, never a guess from a file's name).
//
//   eval "$(bash dev/world.sh 102 --up)"; DBUS_SESSION_BUS_ADDRESS=disabled: node dev/verify_pagewrite.mjs
import { open, signInAs, connectMock } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'pagewrite', signIn: false, connect: false });
const { page } = s;
await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
await signInAs(s, 'pagewrite');
await connectMock(s);
await page.waitForTimeout(1500);

try {
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Pagewrite');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(1800);

	const id = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		window.__free = app;
		window.__m = m;
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Pagewrite');
		return d ? d.id : '';
	});
	check('a Diamond for the page to live in', !!id, id);

	const PAGE = `<!doctype html><meta charset="utf-8"><body><div id="out">idle</div><script>
	var P = 1, seq = 0, waiting = {};
	function send(cmd, extra) {
		var id = 'r' + (++seq);
		var msg = Object.assign({ dc: 1, v: P, cmd: cmd, id: id }, extra || {});
		return new Promise(function (res) { waiting[id] = res; parent.postMessage(msg, '*'); });
	}
	window.addEventListener('message', function (e) {
		var m = e.data;
		if (!m || m.dc !== 1) return;
		if (m.id && waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; return; }
		if (m.cmd === 'data') {
			var d = (m.data && m.data.data) ? m.data.data : (m.data || {});
			var ks = [];
			for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) ks.push(k);
			document.getElementById('out').textContent = ks.join(',');
			parent.postMessage({ dc:1, v:P, cmd:'rendered', keys: ks }, '*');
		}
	});
	window.__capp = { save: function (p, t, mode) { return send('save', { path: p, text: t, mode: mode }); } };
	parent.postMessage({ dc: 1, v: P, cmd: 'ready' }, '*');
	<\/script></body>`;
	await page.evaluate(async (a) => {
		await window.__free.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + a.id + '/crystal.json',
			content: JSON.stringify({ title: 'Pagewrite', summary: 'a page that logs' }),
		}));
		await window.__free.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + a.id + '/crystal.html', content: a.page,
		}));
	}, { id, page: PAGE });
	await page.evaluate(() => DaimondPanels.show('ai'));
	await page.waitForTimeout(400);
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForTimeout(3000);

	const inFrame = async (fn, arg) => {
		const f = page.frames().find(fr => fr.url().indexOf('blob:') === 0);
		if (!f) throw new Error('the crystal frame is not mounted');
		return await f.evaluate(fn, arg);
	};
	const save = (p, t, mode) => inFrame((a) => window.__capp.save(a.p, a.t, a.mode), { p, t, mode });
	const read = (rel) => page.evaluate(async (a) => {
		try { return await window.__m.store_read('diamonds/' + a.id + '/' + a.rel); } catch (e) { return null; }
	}, { id, rel });
	const touched = async () => { const t = await read('.daimond/meta.json'); const m = t && /"touched":(\d+)/.exec(t); return m ? Number(m[1]) : -1; };
	const recorded = async () => String((await read('.daimond/pagelogs')) || '').split('\n').filter(Boolean);

	const alive = await inFrame(() => !!(window.__capp && window.__capp.save));
	check('the page is mounted and talking to the app', alive === true, String(alive));

	// 2. Append records the path, once, and stamps.
	const t0 = await touched();
	const r1 = await save('log.txt', '{"t":"08:01","what":"oats"}', 'append');
	await page.waitForTimeout(50);
	const r2 = await save('log.txt', '{"t":"12:30","what":"eggs"}', 'append');
	const t1 = await touched();
	check('append: both saves are answered ok', !!(r1 && r1.ok && r2 && r2.ok), JSON.stringify([r1, r2]));
	check('append: both rows are in the file', (await read('log.txt')) === '{"t":"08:01","what":"oats"}\n{"t":"12:30","what":"eggs"}', JSON.stringify(await read('log.txt')));
	check('append: the save moves touched', t1 > t0 && t0 > 0, t0 + ' -> ' + t1);
	const rec1 = await recorded();
	check('append records the path, once', rec1.length === 1 && rec1[0] === 'log.txt', JSON.stringify(rec1));

	// 3. Replace records nothing.
	const r3 = await save('state.json', '{"n":1}', 'replace');
	const rec2 = await recorded();
	check('replace records nothing', !!(r3 && r3.ok) && rec2.indexOf('state.json') < 0 && (await read('state.json')) === '{"n":1}', JSON.stringify([r3, rec2]));

	// 4. A store_write .jsonl is not recorded.
	await page.evaluate(async (did) => { await window.__m.store_write('diamonds/' + did + '/meals.jsonl', '{"a":1}\n'); }, id);
	const rec3 = await recorded();
	check('a store_write .jsonl is not recorded', rec3.indexOf('meals.jsonl') < 0, JSON.stringify(rec3));

	// 1. The stamp fails: the Diamond's meta.json is gone (removed through OPFS, the store's own root).
	const before = await read('log.txt');
	const metaText = await read('.daimond/meta.json');
	const removed = await page.evaluate(async (did) => {
		try {
			const root = await navigator.storage.getDirectory();
			const d = await (await (await root.getDirectoryHandle('diamonds')).getDirectoryHandle(did)).getDirectoryHandle('.daimond');
			await d.removeEntry('meta.json');
			return 'removed';
		} catch (e) { return String(e && e.message || e); }
	}, id);
	check('stamp fails: meta.json is removed through the store', removed === 'removed' && (await read('.daimond/meta.json')) === null, removed);
	const r4 = await save('log.txt', '{"t":"19:00","what":"soup"}', 'append');
	const after = await read('log.txt');
	check('stamp fails, bytes put back: the frame gets an error', !!(r4 && r4.error && !r4.ok), JSON.stringify(r4));
	check('stamp fails, bytes put back: the log is byte-equal to before', after === before, JSON.stringify(after));
	const r5 = await save('new.txt', 'first row', 'append');
	check('stamp fails on a new file: the file is not left behind', !!(r5 && r5.error) && (await read('new.txt')) === null, JSON.stringify(r5));
	// Put the Diamond back as it was, for whatever runs after.
	await page.evaluate(async (a) => { await window.__m.store_write('diamonds/' + a.id + '/.daimond/meta.json', a.meta); }, { id, meta: metaText });
} catch (e) {
	check('the run completed', false, String(e && e.stack || e));
}

await s.close?.().catch(() => {});
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
