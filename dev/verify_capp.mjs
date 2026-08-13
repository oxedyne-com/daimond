// verify_capp.mjs — a crystal page can keep what you tell it, and nothing else.
//
// WHAT THIS IS FOR. A crystal page is HTML, CSS and JavaScript in a frame that is
// `sandbox="allow-scripts"` and nothing else, under `default-src 'none'`. So it has no network,
// and its origin is opaque, which means `localStorage` throws. It could already READ files from
// its own Diamond (the `asset` verb) — so it could draw a chart of data somebody else had put
// there, and it could not record a single thing the person using it did. Every interactive
// crystal was a toy that forgot on reload.
//
// The `save` verb is the other half, and it is deliberately the SAME shape as `asset`: the page
// asks, the app writes. `postMessage` crosses an opaque origin perfectly well, so this needs no
// relaxation of the sandbox at all — which is better than granting the frame storage, because
// the app stays the thing that decides what may be touched.
//
// The properties, and the last three matter more than the first two:
//
//   1. A page can SAVE a file into its own Diamond, and read back what it saved.
//   2. APPEND adds to what is there; two appends in the same tick both survive. A logger that
//      loses a line under a double tap is not a logger. NOTE what this does NOT claim: appends
//      made on two DEVICES do not merge. Sync replaces a Diamond wholesale from whichever copy
//      is fresher, so append buys a whole log on the winning side rather than a union of both.
//      An earlier version of this comment said otherwise and was wrong.
//   3. A page CANNOT WRITE ITSELF. `crystal.html` is the code and `crystal.json` is the memory;
//      a page that could write either could change what it does between one render and the
//      next, and nothing anybody reviewed would stay reviewed.
//   4. A page CANNOT LEAVE ITS DIAMOND. Not by `..`, not by an absolute path, not by a scheme.
//   5. A page CANNOT TOUCH `.daimond/` or `versions/` — the rules about what agents may do, and
//      the crystal's own history.
//   6. A WRITE STAMPS THE DIAMOND, so what a capp logged travels to the other devices. Without
//      this a phone where the user only ever logged into a capp stays the STALE side and its
//      log is replaced wholesale by the other device's copy — the tag-loss shape of
//      2026-08-11, through a new door.
//   7. A RUNAWAY PAGE IS BOUNDED. A click and a timer are indistinguishable from outside the
//      frame, so the loop is capped rather than trusted.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST.
//
//   node dev/verify_capp.mjs --break unfenced   # 3 and 5 fail: the protected-name guard goes
//   node dev/verify_capp.mjs --break escapable  # 4 fails: the path fence goes, in BOTH files
//   node dev/verify_capp.mjs --break unstamped  # 6 fails: the write no longer stamps the Diamond
//   node dev/verify_capp.mjs --break boundless  # 7 fails: the runaway bound comes off
//   node dev/verify_capp.mjs --break clobber    # 2 fails: append becomes replace
//   node dev/verify_capp.mjs --break racy       # 2's second half fails: appends stop serialising
//   node dev/verify_capp.mjs                    # and then, clean
//
// `unfenced` and `escapable` are two breaks and not one because properties 3 and 4 are held by
// DIFFERENT lines: the protected names by `PAGE_NEVER_WRITES`, the escapes by `safePath`. The
// first version of this file claimed one break covered both, and running it showed all four
// escape checks still green -- they were guarded by a line the break never touched. A red run is
// not evidence unless the break reaches every site that guards the property, and property 4 is
// guarded twice over, in `crystal.js` and again in `writeCrystalAsset`.
//
// The breaks go on the app's own guard rather than on the page, because the page is untrusted by
// construction: what is under test is what the APP refuses, and a break in the page would only
// prove that a page which does not ask does not receive.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The guard that stops a page rewriting itself and leaving its Diamond.
	unfenced: {
		file: 'js/crystal.js',
		find: "		if (PAGE_NEVER_WRITES.test(rel)) { toFrame({ id: id, error: 'protected' }); return; }",
		with: "		if (false) { toFrame({ id: id, error: 'protected' }); return; }",
	},
	// Append quietly becoming replace: the shape a logger loses a day's meals to.
	clobber: {
		file: 'js/daimond.js',
		find: "			if (mode === 'append') {",
		with: "			if (false) {",
	},
	// The path fence, in BOTH places that hold it. `unfenced` above does NOT turn the escape
	// checks red -- it removes the protected-name guard, and a `../` is stopped by `safePath`,
	// a different line entirely. That was found by running the break and reading which checks
	// actually moved, which is the only way this kind of gap is ever found.
	escapable: [
		{
			// Anchored on the PAGE_NEVER_WRITES line, which only `onSave` has: the two lines above
			// it are byte-identical in `onAsset`, and the anchor guard caught that rather than
			// letting a break land in the reader and be reported as a fence that did not hold.
			file: 'js/crystal.js',
			find: "\t\tvar rel = safePath(m.path);\n\t\tif (!rel) { toFrame({ id: id, error: 'path' }); return; }\n\t\tif (PAGE_NEVER_WRITES.test(rel))",
			with: "\t\tvar rel = str(m.path);\n\t\tif (PAGE_NEVER_WRITES.test(rel))",
		},
		{
			file: 'js/daimond.js',
			find: "\t\tif (path.indexOf(home) !== 0 || path.indexOf('..') >= 0) {\n\t\t\tthrow new Error('Not a path in this Diamond: ' + String(rel == null ? path : rel));\n\t\t}\n\t\t// One write at a time, per page.",
			with: "\t\t// One write at a time, per page.",
		},
	],
	// The stamp, so what a capp logged never travels. Seen red by accident first -- the check
	// failed while the wasm was a build behind and `Wasm.touch_diamond` was undefined, which the
	// caller's own catch swallowed. That was a true red for the right reason, and it is a break
	// here as well so it stays one.
	unstamped: {
		file: 'js/daimond.js',
		find: "			try { await Wasm.touch_diamond(id); } catch (e) { /* the bytes are down; say nothing */ }",
		with: "			// stamp removed",
	},
	// The bound comes off, so a page with a loop in it writes for ever.
	boundless: {
		file: 'js/crystal.js',
		find: "		if (live.saves > SAVE_BUDGET) { toFrame({ id: id, error: 'too many' }); return; }",
		with: "		if (false) { toFrame({ id: id, error: 'too many' }); return; }",
	},
	// The appends stop queueing, so two in one tick each read the file before either wrote.
	racy: {
		file: 'js/daimond.js',
		find: "		_cappWrite = _cappWrite.then(async function () {",
		with: "		_cappWrite = Promise.resolve().then(async function () {",
	},
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'capp', signIn: false, connect: false });
const { page } = s;

if (BREAK) {
	const spec = BREAKS[BREAK];
	if (!spec) { console.error(`no such break: ${BREAK}`); process.exit(2); }
	// A break may name SEVERAL sites, and one of them has to. `escapable` below neuters the
	// path fence in two files, because the property is guarded in two files -- and a break that
	// reached only one would leave the other holding, go green, and be reported as a check that
	// cannot fail when in truth it was never tested.
	const sites = Array.isArray(spec) ? spec : [spec];
	const edited = new Map();
	for (const site of sites) {
		const src = edited.get(site.file) || fs.readFileSync(path.join(WWW, site.file), 'utf8');
		const n = src.split(site.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${site.file}, `
				+ 'so nothing was broken and the run below would prove nothing.');
			process.exit(2);
		}
		edited.set(site.file, src.replace(site.find, site.with));
	}
	for (const [file, body] of edited) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
await signInAs(s, 'capp');
await connectMock(s);
await page.waitForTimeout(1500);

try {
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Logger');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(1800);
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForTimeout(1200);

	const id = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		window.__free = app;
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Logger');
		return d ? d.id : '';
	});
	check('a Diamond for the capp to live in', !!id, id);

	// A page that logs, written the way a daimon would write one: it asks for what it needs
	// through the protocol and holds nothing of its own.
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
			// Every top-level key of the data that has content must be named, or the app judges
			// the page to have drawn only part of the crystal and falls back to its own
			// rendering -- which tears the frame down and is exactly what a capp must not do.
			var d = (m.data && m.data.data) ? m.data.data : (m.data || {});
			var ks = [];
			for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) ks.push(k);
			document.getElementById('out').textContent = ks.join(',');
			parent.postMessage({ dc:1, v:P, cmd:'rendered', keys: ks }, '*');
		}
	});
	window.__capp = {
		save:  function (p, t, mode) { return send('save', { path: p, text: t, mode: mode }); },
		read:  function (p) { return send('asset', { path: p }); },
	};
	parent.postMessage({ dc: 1, v: P, cmd: 'ready' }, '*');
	<\/script></body>`;

	await page.evaluate(async (a) => {
		await window.__free.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + a.id + '/crystal.json',
			content: JSON.stringify({ title: 'Logger', summary: 'a capp' }),
		}));
		await window.__free.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + a.id + '/crystal.html', content: a.page,
		}));
	}, { id, page: PAGE });

	// Re-select the Diamond so the crystal renders AFTER the page was written; selecting it
	// before would have mounted the stock page and this file would be measuring that.
	await page.evaluate(() => DaimondPanels.show('ai'));
	await page.waitForTimeout(400);
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForTimeout(3000);


	/// Call into the page, through the frame, exactly as a tap would.
	const inFrame = async (fn, arg) => {
		// The crystal page is served from a blob: URL, which is what distinguishes it from the
		// guide frame -- and the guide is a child of the main frame too, so a parent test finds
		// that one first and every check below then measures the guide.
		const f = page.frames().find(fr => fr.url().indexOf('blob:') === 0);
		if (!f) throw new Error('the crystal frame is not mounted');
		return await f.evaluate(fn, arg);
	};

	// The frame really mounted and the page really answered `ready` — asserted before anything
	// is measured through it, because every check below reads a reply from inside it and a
	// frame that never loaded would make all of them fail for one reason that is not theirs.
	const alive = await inFrame(() => !!(window.__capp && window.__capp.save));
	check('the capp page is mounted and talking to the app', alive === true, String(alive));

	// ── 1. It can save, and what it saved is really on disk.
	const r1 = await inFrame(() => window.__capp.save('log/diet.jsonl',
		'{"t":1,"food":"oats","g":80}', 'append'));
	check('A PAGE CAN SAVE INTO ITS OWN DIAMOND', !!(r1 && r1.ok),
		JSON.stringify(r1));
	const onDisk = await page.evaluate((did) => window.__free
		.run_tool('file_read', JSON.stringify({ path: 'diamonds/' + did + '/log/diet.jsonl' }))
		.then(String).catch(e => 'ERR ' + e), id);
	check('and the file is really there, read back outside the page',
		/oats/.test(onDisk), onDisk.slice(0, 60).replace(/\n/g, ' '));

	// ── 2. Append adds. Twice in one tick, both survive.
	await inFrame(async () => {
		await Promise.all([
			window.__capp.save('log/diet.jsonl', '{"t":2,"food":"eggs","g":100}', 'append'),
			window.__capp.save('log/diet.jsonl', '{"t":3,"food":"rice","g":150}', 'append'),
		]);
	});
	const after = await page.evaluate((did) => window.__free
		.run_tool('file_read', JSON.stringify({ path: 'diamonds/' + did + '/log/diet.jsonl' }))
		.then(String).catch(e => 'ERR ' + e), id);
	check('APPEND KEEPS WHAT WAS THERE', /oats/.test(after), after.slice(0, 40).replace(/\n/g, ' '));
	check('AND TWO APPENDS IN ONE TICK BOTH SURVIVE',
		/eggs/.test(after) && /rice/.test(after),
		'eggs:' + /eggs/.test(after) + ' rice:' + /rice/.test(after));

	// ── 3. It cannot write itself. The control beside it is check 1: saving works, so a
	//      refusal here is a refusal of THAT rather than of everything.
	for (const [what, p] of [['crystal.html', 'crystal.html'], ['crystal.json', 'crystal.json']]) {
		const r = await inFrame((pp) => window.__capp.save(pp, 'pwned', 'replace'), p);
		check('A PAGE CANNOT REWRITE ITS OWN ' + what.toUpperCase(),
			!!(r && r.error) && !r.ok, JSON.stringify(r));
	}
	const stillPage = await page.evaluate((did) => window.__free
		.run_tool('file_read', JSON.stringify({ path: 'diamonds/' + did + '/crystal.html' }))
		.then(String).catch(e => 'ERR ' + e), id);
	check('and the page on disk is untouched, not merely the reply refused',
		!/pwned/.test(stillPage) && /__capp/.test(stillPage),
		stillPage.slice(0, 40).replace(/\n/g, ' '));

	// ── 4. It cannot leave the Diamond.
	for (const p of ['../evil.txt', '/etc/passwd', 'https://example.com/x', '..\\evil.txt']) {
		const r = await inFrame((pp) => window.__capp.save(pp, 'out', 'replace'), p);
		check('A PAGE CANNOT WRITE OUTSIDE ITS DIAMOND: ' + p,
			!!(r && r.error) && !r.ok, JSON.stringify(r));
	}

	// ── 5. Nor the rules, nor the history.
	for (const p of ['.daimond/config.json', 'versions/0000.md']) {
		const r = await inFrame((pp) => window.__capp.save(pp, 'no', 'replace'), p);
		check('A PAGE CANNOT WRITE ' + p, !!(r && r.error) && !r.ok, JSON.stringify(r));
	}

	// ── 6. The write stamped the Diamond, so the log will travel.
	const stamped = await page.evaluate(async (did) => {
		const raw = await window.__free.run_tool('file_read', JSON.stringify({
			path: 'diamonds/' + did + '/.daimond/meta.json' })).then(String).catch(() => '');
		const m = /"touched"\s*:\s*(\d+)/.exec(raw);
		return m ? Number(m[1]) : 0;
	}, id);
	const before = stamped;
	await inFrame(() => window.__capp.save('log/diet.jsonl', '{"t":9,"food":"tea"}', 'append'));
	await page.waitForTimeout(600);
	const after2 = await page.evaluate(async (did) => {
		const raw = await window.__free.run_tool('file_read', JSON.stringify({
			path: 'diamonds/' + did + '/.daimond/meta.json' })).then(String).catch(() => '');
		const m = /"touched"\s*:\s*(\d+)/.exec(raw);
		return m ? Number(m[1]) : 0;
	}, id);
	check('A WRITE STAMPS THE DIAMOND, so the log travels to the other devices',
		after2 > 0 && after2 > before, before + ' -> ' + after2);

	// ── 7. A page that writes in a loop is stopped, with the frame still up.
	const runaway = await inFrame(async () => {
		var last = null;
		for (var i = 0; i < 420; i++) {
			last = await window.__capp.save('log/spam.jsonl', 'x', 'append');
			if (last && last.error) return { at: i, error: last.error };
		}
		return { at: -1, error: '' };
	});
	check('A RUNAWAY PAGE IS BOUNDED rather than trusted',
		!!(runaway && runaway.error === 'too many'), JSON.stringify(runaway));
	const stillThere = await inFrame(() => !!(window.__capp && window.__capp.save));
	check('and the frame is still up after the refusal, so the app did not fall over',
		stillThere === true, String(stillThere));

	// And the read half still works, which is what makes a capp worth having: data in, log out.
	const back = await inFrame(() => window.__capp.read('log/diet.jsonl'));
	check('a page reads back its own log, which is how a chart gets drawn',
		!!(back && /oats/.test(String(back.text || ''))),
		String((back && back.text) || back && back.error || '').slice(0, 50));

} catch (e) {
	check('the run completed', false, String(e && e.message || e));
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
