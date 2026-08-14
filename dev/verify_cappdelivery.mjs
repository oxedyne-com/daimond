// verify_cappdelivery.mjs — the guide's capp delivery button, and the update path
// that keeps what it delivered current.
//
// Not to be confused with `dev/verify_capp.mjs`, which is about what the app REFUSES
// an untrusted page. The guide's Capps page carries one button that asks the app for
// a furnished Diamond, and this drives that. What is asserted:
//
//   * the ask is answered with a dialog in APP chrome, not silently obeyed;
//   * saying yes leaves a Diamond called "Life log" with the template's page in
//     it, and opens it;
//   * asking twice does not make a second one -- the entries are in the first;
//   * a message from anywhere but the guide frame is ignored;
//   * A NEWER SERVED TEMPLATE REACHES AN INSTANCE THAT HAS NOT BEEN TOUCHED, and
//     `log/` is byte-identical afterwards;
//   * A FILE THE USER HAS CHANGED IS LEFT ALONE while the rest updates, and they
//     are told ONCE;
//   * AN INSTANCE WITH NO DELIVERY RECORD IS NOT SILENTLY REWRITTEN -- it is asked
//     about, and "no" means no.
//
// The template is CODE, so it gets fixes; the lanes are DATA the page rewrites, so
// they are the user's the moment he edits one. One rule covers both, and the rule is
// a measurement: a stored file whose SHA-256 still equals the hash recorded at
// delivery is one nobody has touched. See the "A capp, kept current" section of
// `www/js/daimond.js` and §11 of `dev/CAPP_CONTRACT.md`.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST.
//
//   node dev/verify_cappdelivery.mjs --break stale        # 5 fails: the version is never compared
//   node dev/verify_cappdelivery.mjs --break clobber      # 6 fails: the user's own file is overwritten
//   node dev/verify_cappdelivery.mjs --break pushy        # 7 fails: "no" rewrites the page anyway
//   node dev/verify_cappdelivery.mjs --break logwritable  # 5's log check fails: `log/` becomes writable
//   node dev/verify_cappdelivery.mjs                      # and then, clean
//
// `logwritable` is why the served manifest in this file NAMES a path under `log/`
// and serves bytes for it. A guard nothing ever tries to cross is a guard that
// cannot be seen to hold: without a template that asks to write the user's entries,
// "the log is unchanged" would pass against an app with no log rule at all.
//
// It writes no path down: `harness.mjs` is imported relative to this file, and the
// profile and screenshot go to the harness scratch root — never into `www/`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, connectMock, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const TPL  = path.join(WWW, 'capps', 'lifelog');

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Every break is a line of the APP's own guard, replaced in the file the browser is
// served. The anchor must appear exactly once or nothing was broken and the run
// below would prove nothing.
const BREAKS = {
	// The served version is never compared, so no fix ever reaches an instance —
	// which is the defect this whole path exists to close.
	stale: {
		file: 'js/daimond.js',
		find: '		if (have >= man.v) return out;               // current',
		with: '		if (true) return out;                        // current',
	},
	// The hash comparison goes, so a file the user has edited is overwritten by the
	// template. The silent-overwrite failure, which is the expensive direction.
	clobber: {
		file: 'js/daimond.js',
		find: '				if (!had || !files[rel] || had !== files[rel]) {',
		with: '				if (false) {',
	},
	// The answer to the legacy question is ignored, so an instance nothing is known
	// about is rewritten whatever the person said.
	pushy: {
		file: 'js/daimond.js',
		find: '			if (!go) { await writeCappRecord(id, { capp: key, offered: man.v }); return false; }',
		with: '			if (!go) { await writeCappRecord(id, { capp: key, offered: man.v }); }',
	},
	// `log/` becomes an ordinary template path, so a manifest that names one can lay
	// bytes over the user's entries.
	logwritable: {
		file: 'js/daimond.js',
		find: "		return p === 'capp.json' || /^log(\\/|$)/.test(p);",
		with: "		return p === 'capp.json';",
	},
};

/// The real template on disk, which is what an unbroken run delivers at version 2.
const real = (rel) => fs.readFileSync(path.join(TPL, rel), 'utf8');

/// What the bundle SERVES, when this file wants it to be something else.
///
/// `null` lets every request through to the dev server, which is how the delivery
/// half of this file runs against the shipped template. Setting it is how a new
/// build is put in front of a running app without a reload: the app re-fetches the
/// manifest on every open, deliberately and uncached, so that this is possible.
let plan = null;

/// The manifest's file list. It NAMES A PATH UNDER `log/`, which the app must
/// refuse whatever else it does — see `logwritable` above.
const MANIFEST = [
	'crystal.html', 'index.json',
	'lanes/diet.json', 'lanes/gym.json', 'lanes/body.json',
	'cat/diet.json', 'cat/gym.json',
	'log/gym/2026-08.jsonl',
];

const s = await open({
	name:    'cappprobe',
	profile: scratch('pw', 'cappprobe-' + process.pid),
	route:   async (page) => {
		if (BREAK) {
			const spec = BREAKS[BREAK];
			if (!spec) { console.error('no such break: ' + BREAK); process.exit(2); }
			const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
			const n = src.split(spec.find).length - 1;
			if (n !== 1) {
				console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
					+ 'so nothing was broken and the run below would prove nothing.');
				process.exit(2);
			}
			const body = src.replace(spec.find, spec.with);
			await page.route('**/' + spec.file, (r) => r.fulfill({
				status: 200, contentType: 'application/javascript', body,
			}));
		}
		await page.route('**/capps/lifelog/**', async (r) => {
			if (!plan) return r.continue();
			const rel = new URL(r.request().url()).pathname.replace(/^.*\/capps\/lifelog\//, '');
			if (rel === 'capp.json') {
				return r.fulfill({
					status: 200, contentType: 'application/json',
					body: JSON.stringify({ v: plan.v, files: MANIFEST }),
				});
			}
			if (plan.files[rel] != null) {
				return r.fulfill({ status: 200, contentType: 'text/plain', body: plan.files[rel] });
			}
			return r.continue();
		});
	},
});
const p = s.page;

/// The Diamonds as the store holds them, and what is inside one.
const diamonds = (p) => p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	try { return JSON.parse(await app.list_diamonds()); } catch (e) { return []; }
});

/// One stored file of an instance, or `null`. The page comes through the app's own
/// reader; everything else straight off the store, so what is asserted on is what is
/// on disk rather than what the app believes it wrote.
const stored = (id, rel) => p.evaluate(async ({ id, rel }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	if (rel === 'crystal.html') {
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		try { return await app.read_crystal_page(id); } catch (e) { return null; }
	}
	try { return await m.store_read('diamonds/' + id + '/' + rel); } catch (e) { return null; }
}, { id, rel });

/// Write a file into an instance, as the user's page does through `save`.
const put = (id, rel, text) => p.evaluate(async ({ id, rel, text }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.store_write('diamonds/' + id + '/' + rel, text);
	return true;
}, { id, rel, text });

/// EVERYTHING under `log/`, path → contents. The user's entries: the one thing here
/// that cannot be re-derived from anything.
const logTree = (id) => p.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const out = {};
	const walk = async (rel) => {
		let lines = '';
		const dir = ('diamonds/' + id + '/' + rel).replace(/\/$/, '');
		try { lines = await m.store_list(dir); } catch (e) { return; }
		for (const ln of String(lines).split('\n').filter(Boolean)) {
			const bits = ln.split('\t');
			if (bits[1] === 'dir') { await walk(rel + bits[0] + '/'); continue; }
			try { out[rel + bits[0]] = await m.store_read('diamonds/' + id + '/' + rel + bits[0]); }
			catch (e) { out[rel + bits[0]] = 'UNREADABLE'; }
		}
	};
	await walk('log/');
	return out;
}, id);

/// Put a file's TRUE hash into the delivery record, as though it had been
/// delivered.
///
/// Used on a path under `log/`, and the fixture is not artificial: the delivery
/// record lives at `diamonds/<id>/capp.json`, which `PAGE_NEVER_WRITES` does not
/// cover, so a capp page can write exactly this. It is also what a corrupted or a
/// half-migrated record looks like.
///
/// It exists because without it the log assertions pass for the WRONG REASON. A log
/// file has no recorded hash, so the divergence rule already refuses to replace it
/// and the `log/` guard is never the thing being tested — running `--break
/// logwritable` against the first version of this file showed every log check still
/// green. Claiming the file puts the path refusal on its own, which is the only way
/// to see it hold.
const claimInRecord = (id, rel) => p.evaluate(async ({ id, rel }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const body = await m.store_read('diamonds/' + id + '/' + rel);
	const rec = JSON.parse(await m.store_read('diamonds/' + id + '/capp.json'));
	rec.files[rel] = await DaimondCloud.sha256(body);
	await m.store_write('diamonds/' + id + '/capp.json', JSON.stringify(rec));
	return rec.files[rel];
}, { id, rel });

/// The delivery record beside an instance, parsed.
const record = (id) => p.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	let t = '';
	try { t = await m.store_read('diamonds/' + id + '/capp.json'); } catch (e) { return null; }
	try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
}, id);

/// Answer whichever confirm box is on screen.
const answer = async (p, yes) => {
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	const said = await p.evaluate(() => {
		const c = [...document.querySelectorAll('.dlg-card')].filter(x => x.getClientRects().length).pop();
		return c ? (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240) : '';
	});
	await p.evaluate((y) => {
		const c = [...document.querySelectorAll('.dlg-card')].filter(x => x.getClientRects().length).pop();
		const b = c.querySelector(y ? '.dlg-ok' : '.dlg-cancel') || c.querySelector('.dlg-ok');
		b.click();
	}, yes);
	await p.waitForTimeout(1500);
	return said;
};

/// Press the guide's own button, inside the guide frame.
const pressInGuide = async (p) => {
	const f = p.frames().find(fr => /guide\/capps\.html/.test(fr.url()));
	if (!f) throw new Error('the guide frame is not showing capps.html');
	await f.click('#make-lifelog');
};

/// OPEN THE CAPP, the way a person does: off its face and back onto it. Both
/// buttons go through `selectDiamond`, which is the one path to `renderCrystal` —
/// so this is the real open and not a poke at an internal.
const reopen = async () => {
	await p.evaluate(() => { const b = document.getElementById('dview-chat'); if (b) b.click(); });
	await p.waitForTimeout(500);
	await p.evaluate(() => { const b = document.getElementById('dview-crystal'); if (b) b.click(); });
	await p.waitForTimeout(1800);
};

/// The one quiet line that says which files were left as the user has them.
const noteText = () => p.evaluate(() => {
	const els = [...document.querySelectorAll('#capp-note, .capp-note')];
	return { n: els.length, text: els.length ? (els[0].textContent || '').trim() : '' };
});

try {
	await connectMock(s);
	await p.evaluate(() => DaimondWeb.guide('capps.html'));
	await p.waitForTimeout(2500);
	const framed = p.frames().some(f => /guide\/capps\.html/.test(f.url()));
	check(framed, 'the guide is showing its Capps page');

	// ── A stranger's message is not an instruction.
	await p.evaluate(() => window.postMessage({ daimondGuide: 'make', what: 'lifelog' }, '*'));
	await p.waitForTimeout(900);
	check(!(await p.$('.dlg-card')), 'a message from the page itself is ignored');

	// ── Refused.
	await pressInGuide(p);
	const said = await answer(p, false);
	console.log('  dialog: ' + said);
	check(/Life log/.test(said), 'the ask is answered with a dialog naming what it will make');
	check(!(await diamonds(p)).some(d => d.name === 'Life log'), 'saying no makes nothing');

	// ── Accepted.
	await pressInGuide(p);
	await answer(p, true);
	const made = (await diamonds(p)).filter(d => d.name === 'Life log');
	check(made.length === 1, 'saying yes makes exactly one Life log', made.length + ' found');

	const id = made.length ? made[0].id : '';
	if (id) {
		const inside = await p.evaluate(async (id) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			const out = {};
			try { out.page = (await app.read_crystal_page(id) || '').length; } catch (e) { out.page = 'threw: ' + e; }
			try { out.data = (await app.read_crystal_data(id) || '').length; } catch (e) { out.data = 'threw: ' + e; }
			return out;
		}, id);
		console.log('  inside: ' + JSON.stringify(inside));
		check(typeof inside.page === 'number' && inside.page > 500, 'with the template page in it', inside.page);
		check(typeof inside.data === 'number' && inside.data > 0,
			'AND A CRYSTAL, without which the face never mounts the page', inside.data);
	}

	// It is on screen, which is what "delivered" means.
	const showing = await p.evaluate(() => ({
		name: (document.getElementById('current-session-name') || {}).textContent || '',
		frame: !!document.querySelector('#crystal-frame-wrap'),
	}));
	console.log('  showing: ' + JSON.stringify(showing));
	check(/Life log/.test(showing.name), 'and it is the Diamond on screen');
	check(showing.frame, 'with its page mounted');
	await p.waitForTimeout(1200);
	await p.screenshot({ path: scratch('capp-made.png') });

	// ── Asked again: the first one, not a second.
	await p.evaluate(() => DaimondWeb.guide('capps.html'));
	await p.waitForTimeout(2000);
	await pressInGuide(p);
	const again = await answer(p, true);
	console.log('  second dialog: ' + again);
	check(/already have/i.test(again), 'the second ask offers to OPEN the one that exists');
	check((await diamonds(p)).filter(d => d.name === 'Life log').length === 1,
		'and there is still exactly one');

	// ══ 4. The delivery left a record of exactly what went in ══════════
	//
	// Without it nothing later can tell the template's bytes from the user's, and
	// every update afterwards would have to guess or ask.
	const rec0 = id ? await record(id) : null;
	console.log('  record: ' + JSON.stringify(rec0 && { capp: rec0.capp, v: rec0.v, files: Object.keys(rec0.files || {}) }));
	check(!!rec0 && rec0.capp === 'lifelog', 'delivery writes a record naming the template');
	check(!!rec0 && rec0.v === JSON.parse(real('capp.json')).v,
		'at the version the bundle serves', rec0 ? rec0.v : 'no record');
	check(!!rec0 && !!(rec0.files || {})['crystal.html'] && !!(rec0.files || {})['lanes/gym.json'],
		'with a hash per delivered file');
	check(!!rec0 && !(rec0.files || {})['crystal.json'],
		'and NOT for the seeded crystal, which came from no served file');

	// ══ 5. A newer template reaches an instance nobody has touched ═════
	//
	// And the user's entries do not move. Both halves matter: an update that also
	// took the log would be a worse defect than the one this closes.
	await put(id, 'log/gym/2026-08.jsonl', '{"t":"2026-08-01","lift":"squat","kg":100}\n');
	await put(id, 'log/diet/2026-08.jsonl', '{"t":"2026-08-01","food":"porridge"}\n');
	const logBefore = await logTree(id);
	console.log('  log before: ' + JSON.stringify(Object.keys(logBefore)));
	// The record now CLAIMS one of the user's log files as delivered bytes, so the
	// only thing standing between the template and a year of entries is the `log/`
	// refusal itself. See `claimInRecord`.
	const claimed = await claimInRecord(id, 'log/gym/2026-08.jsonl');
	check(/^[0-9a-f]{64}$/.test(String(claimed)),
		'the record is made to claim a log file, so the path guard stands alone', claimed);

	const GYM3 = JSON.stringify(Object.assign(JSON.parse(real('lanes/gym.json')), { v3: true }));
	plan = {
		v: 3,
		files: {
			'crystal.html':          real('crystal.html') + '\n<!-- delivered v3 -->\n',
			'lanes/gym.json':        GYM3,
			// A template that asks to write the user's entries. It must not be able to.
			'log/gym/2026-08.jsonl': '{"t":"1999-01-01","lift":"OVERWRITTEN"}\n',
		},
	};
	await reopen();

	const page3 = await stored(id, 'crystal.html');
	check(/<!-- delivered v3 -->/.test(String(page3 || '')),
		'a newer served version replaces the page of an untouched instance');
	check(String(await stored(id, 'lanes/gym.json')) === GYM3,
		'and its seeded data, which nobody had edited');
	const rec3 = await record(id);
	check(!!rec3 && rec3.v === 3, 'and the stored version moves with it', rec3 ? rec3.v : 'no record');
	const logAfter = await logTree(id);
	check(JSON.stringify(logAfter) === JSON.stringify(logBefore),
		'THE LOG IS BYTE-IDENTICAL, though the manifest named a path inside it',
		JSON.stringify(logAfter));
	const n3 = await noteText();
	check(n3.n === 0, 'and nothing was said, because nothing was left behind', n3.text);

	// ══ 6. A file the user has changed is left alone, and said so ONCE ══
	const MINE = JSON.stringify({ id: 'diet', mine: true, note: 'the user edited this' });
	await put(id, 'lanes/diet.json', MINE);
	const GYM4 = JSON.stringify(Object.assign(JSON.parse(real('lanes/gym.json')), { v4: true }));
	plan = {
		v: 4,
		files: {
			'crystal.html':   real('crystal.html') + '\n<!-- delivered v4 -->\n',
			'lanes/gym.json': GYM4,
			'lanes/diet.json': JSON.stringify({ id: 'diet', fromTemplate: 'v4' }),
			'log/gym/2026-08.jsonl': '{"t":"1999-01-01","lift":"OVERWRITTEN"}\n',
		},
	};
	await reopen();

	check(String(await stored(id, 'lanes/diet.json')) === MINE,
		'A FILE THE USER CHANGED IS LEFT EXACTLY AS IT IS');
	check(String(await stored(id, 'lanes/gym.json')) === GYM4,
		'while the files nobody touched still update');
	check(/<!-- delivered v4 -->/.test(String(await stored(id, 'crystal.html'))),
		'including the page, which is code and not data');
	const n4 = await noteText();
	console.log('  note: ' + n4.text);
	check(n4.n === 1, 'and the person is told ONCE, not once per file', n4.n + ' notes');
	check(/lanes\/diet\.json/.test(n4.text), 'naming what was kept', n4.text);
	const rec4 = await record(id);
	check(!!rec4 && rec4.v === 4, 'the version moves even though a file did not', rec4 ? rec4.v : 'no record');
	check(JSON.stringify(await logTree(id)) === JSON.stringify(logBefore), 'and the log is still untouched');

	// ══ 7. An instance with NO record is not silently rewritten ════════
	//
	// The owner's own Life log is this case: made before capps carried a version,
	// so nothing is known about what was delivered and no file can be shown to be
	// ours. The only honest move is to ask.
	const LEGACY = real('crystal.html') + '\n<!-- the user\'s own page -->\n';
	await p.evaluate(async ({ id, page }) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.write_crystal_page(id, page);
		// No record at all, which is what an instance made before this existed has.
		try {
			let dir = await DaimondCloud.opfsRoot();
			for (const seg of ['diamonds', id]) dir = await dir.getDirectoryHandle(seg);
			await dir.removeEntry('capp.json');
		} catch (e) { await m.store_write('diamonds/' + id + '/capp.json', ''); }
	}, { id, page: LEGACY });
	check(!(await record(id)), 'the instance now has no delivery record');

	plan = { v: 5, files: { 'crystal.html': real('crystal.html') + '\n<!-- delivered v5 -->\n' } };
	await reopen();
	const asked = await p.$('.dlg-card');
	check(!!asked, 'a record-less instance is ASKED about rather than updated');
	check(String(await stored(id, 'crystal.html')) === LEGACY,
		'and nothing has been written while the question is on screen');
	const legacySaid = asked ? await answer(p, false) : '';
	console.log('  legacy dialog: ' + legacySaid);
	check(/before capps carried a version/i.test(legacySaid),
		'the question says why it is being asked', legacySaid);
	check(String(await stored(id, 'crystal.html')) === LEGACY,
		'SAYING NO LEAVES THE PAGE EXACTLY AS IT WAS');
	const rec5 = await record(id);
	check(!!rec5 && rec5.offered === 5 && !rec5.files,
		'the refusal is remembered, at the version it was offered at', JSON.stringify(rec5));

	await reopen();
	check(!(await p.$('.dlg-card')), 'and it is not asked again at the same version');
	check(String(await stored(id, 'crystal.html')) === LEGACY, 'nor rewritten behind the refusal');

	// Taken, this time: the page moves, everything else stays, and the instance
	// joins the automatic path.
	plan = { v: 6, files: { 'crystal.html': real('crystal.html') + '\n<!-- delivered v6 -->\n' } };
	await reopen();
	const asked6 = await p.$('.dlg-card');
	check(!!asked6, 'something newer asks again');
	if (asked6) await answer(p, true);
	check(/<!-- delivered v6 -->/.test(String(await stored(id, 'crystal.html'))),
		'and saying yes brings the page up to the current one');
	check(String(await stored(id, 'lanes/diet.json')) === MINE,
		'while the lanes it knows nothing about are left alone');
	check(JSON.stringify(await logTree(id)) === JSON.stringify(logBefore),
		'and so are the entries');
	const rec6 = await record(id);
	check(!!rec6 && rec6.v === 6 && !!(rec6.files || {})['crystal.html']
		&& !(rec6.files || {})['lanes/diet.json'],
		'a record is written claiming the PAGE only, so no later version overwrites a lane',
		JSON.stringify(rec6 && { v: rec6.v, files: Object.keys(rec6.files || {}) }));
	await p.screenshot({ path: scratch('capp-updated.png') });
} catch (e) {
	console.log('  FAIL threw — ' + (e && e.message));
	failures++;
} finally {
	const errs = s.errs.filter(e => !/favicon|manifest|502|Bad Gateway|gateway/i.test(e));
	if (errs.length) console.log('  console errors: ' + errs.slice(0, 6).join(' | '));
	await s.close();
}
console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
