// verify_snapshotmix.mjs — two devices record crystal versions in one Diamond, sync both ways, and
// every version number still reads as one device's memory.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// A crystal version is a data snapshot (`versions/NNNN.json` in full, or `NNNN.jpatch` against the
// snapshot below it) and, where the page moved, a page snapshot (`.html` / `.hpatch`). The number
// is the Diamond's counter, so two devices that each record between syncs take the same numbers,
// and `import_diamond` kept `versions/` and laid the other device's files over it BY NAME (found
// beside R5, audit of 2026-09-23). A local `0002.json` and an incoming `0002.jpatch` then both
// stood at 2 and the reader took the full copy, so version 2 read as this device's memory under
// the other device's record of it; and this device's snapshots above the incoming counter stayed
// in the chains every later version was read through, so later versions stopped rebuilding.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
//   1. The premise: A and B hold one Diamond at version 1 and each records its own versions --
//      B's first a full copy where A's is a patch, a files version on each, and B's run longer
//      than A's.
//   2. B takes A's copy (two-sided): every number the copy carries reads as A's memory and page
//      and holds A's snapshots and nothing of B's; B's versions are in B's History under new
//      numbers and read there as they did on B; B's files version kept its manifest on the same
//      number; the refiled run starts with full copies; the kept-before-sync copy still stands.
//   3. The next edit on B reads back, and every version B holds still rebuilds.
//   4. A, having moved on, takes B's copy: A's own version is refiled, and every number B's copy
//      holds reads on A as it reads on B.
//   5. A copy taken as a one-sided pull over a device that had moved: the same, and the next
//      edit, which is where a chain through the left-over snapshots broke, reads back.
//   6. A refile that cannot be written refuses the import, and the store is as it was.
//   7. A refile whose removal of an old file fails refuses the import, puts back what it had
//      removed, and the store is as it was.
//
// Two browser profiles are two devices: each has its own origin-private store. The copies travel
// as the sync carries them, `export_diamond` into `import_diamond`. The failures are made by the
// browser's own file-system handles refusing, which is where a full disk would refuse.
//
// Needs a world for the app server: `eval "$(bash dev/world.sh N --env)"`.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const short = (v) => String(v === undefined ? 'undefined' : JSON.stringify(v)).slice(0, 240);

const device = async (name) => {
	const s = await open({ name, connect: false,
		route: async (page) => { page.setDefaultNavigationTimeout(180000); } });
	await s.page.waitForTimeout(1500);
	await s.page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		for (let i = 0; i < 200; i++) {
			try { mod.workspace_mode(); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
		}
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		// A memory of forty lines, so a small change is recorded as a patch, as on a real Diamond.
		const memory = (tag, extra) => JSON.stringify({
			title: 'Snapshot mix',
			notes: Array.from({ length: 40 }, (_, i) => 'note ' + i + ' ' + tag),
			extra: extra || '',
		}, null, 1);
		// A memory that shares nothing with the one both hold, so it is recorded in full.
		const other = (extra) => {
			let x = 7, body = '';
			for (let i = 0; i < 400; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; body += x.toString(36); }
			return JSON.stringify({ title: 'B took it over', body, extra: extra || '' });
		};
		const page = (tag) => '<!doctype html>\n<main>\n'
			+ Array.from({ length: 40 }, (_, i) => '<p class="row">row ' + i + ' ' + tag + '</p>').join('\n')
			+ '\n</main>\n';
		const dir = async (id) => {
			const root = await navigator.storage.getDirectory();
			const d = await root.getDirectoryHandle('diamonds');
			const one = await d.getDirectoryHandle(id);
			return one.getDirectoryHandle('versions');
		};
		const hex = async (buf) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
			.map((b) => b.toString(16).padStart(2, '0')).join('');
		// Every file at the top of `versions/`, by name, as a hash of its bytes.
		const listing = async (id) => {
			const out = {};
			const v = await dir(id);
			for await (const [name, h] of v.entries()) {
				if (h.kind !== 'file') continue;
				out[name] = await hex(await (await h.getFile()).arrayBuffer());
			}
			return out;
		};
		const vread = async (id, n) => {
			try { return await app.read_version(id, n); } catch (e) { return 'ERR: ' + String(e && e.message || e); }
		};
		const pread = async (id, n) => {
			try { return await app.read_version_page(id, n); } catch (e) { return 'ERR: ' + String(e && e.message || e); }
		};
		const log = async (id) => JSON.parse(await app.log_read(id));
		const manifests = async (id) => JSON.parse(await app.versions_list(id));
		const counter = async (id) => {
			const d = JSON.parse(await app.list_diamonds()).find((x) => x.id === id);
			return d ? d.crystal_version : null;
		};
		// A files version, as Save a version records one after a file in the Diamond changed.
		const save = async (id, file, text) => {
			await mod.write_file('diamonds/' + id + '/' + file, text);
			return JSON.parse(await app.versions_save_user(id, 'save ' + file));
		};
		const newest = async (id) => {
			const recs = await log(id);
			return recs.reduce((m, r) => Math.max(m, r.crystal_version || 0), 0);
		};
		window.__s = { mod, app, memory, other, page, listing, vread, pread, log, manifests, counter, save, newest };
	});
	return s;
};

const A = await device('smixA');
const B = await device('smixB');

// Each number's memory and page on one device, for 0..top.
const reads = (s, id, top) => s.page.evaluate(async ({ id, top }) => {
	const out = {};
	for (let n = 0; n <= top; n++) out[n] = { m: await __s.vread(id, n), p: await __s.pread(id, n) };
	return out;
}, { id, top });
// The data-snapshot numbers a device holds.
const dataNumbers = (listing) => Object.keys(listing)
	.map((n) => /^(\d+)\.(json|jpatch)$/.exec(n)).filter(Boolean).map((m) => Number(m[1]))
	.filter((n, i, a) => a.indexOf(n) === i).sort((x, y) => x - y);
const crystalAt = (listing, n) => Object.keys(listing)
	.filter((k) => new RegExp('^0*' + n + '\\.(json|jpatch|html|hpatch)$').test(k)).sort()
	.map((k) => k + '=' + listing[k]).join(',');
const maxNumber = (listing) => Object.keys(listing)
	.map((k) => /^(\d+)\./.exec(k)).filter(Boolean).reduce((m, x) => Math.max(m, Number(x[1])), 0);

// ── 1. One Diamond, two devices, each recording its own versions ─────────────
const id = await A.page.evaluate(async () => {
	const id = await __s.app.create_diamond('snapshot mix');
	await __s.app.write_crystal_both(id, __s.memory('shared'), __s.page('shared'));
	return id;
});
const e0 = await A.page.evaluate((id) => __s.app.export_diamond(id), id);
await B.page.evaluate(async (e0) => { await __s.app.import_diamond(e0, false); }, e0);

const aRec = await A.page.evaluate(async (id) => {
	await __s.app.write_crystal_data(id, __s.memory('shared', 'A adds a line'));
	const saved = await __s.save(id, 'notes-a.md', 'A wrote this');
	await __s.app.write_crystal_page(id, __s.page('shared').replace('row 3 shared', 'row 3 A'));
	return { saved, counter: await __s.counter(id), listing: await __s.listing(id), log: await __s.log(id) };
}, id);
const bRec = await B.page.evaluate(async (id) => {
	await __s.app.write_crystal_data(id, __s.other());
	await __s.app.write_crystal_page(id, __s.page('shared').replace('row 5 shared', 'row 5 B'));
	const saved = await __s.save(id, 'notes-b.md', 'B wrote this');
	await __s.app.write_crystal_data(id, __s.other('B five'));
	await __s.app.write_crystal_data(id, __s.other('B six'));
	return { saved, counter: await __s.counter(id), listing: await __s.listing(id), log: await __s.log(id) };
}, id);
const aReads = await reads(A, id, aRec.counter);
const bReads = await reads(B, id, bRec.counter);
check('1. A records versions 2..4, B versions 2..6, on one Diamond',
	aRec.counter === 4 && bRec.counter === 6, JSON.stringify({ A: aRec.counter, B: bRec.counter }));
check('1. B\'s version 2 is a full copy where A\'s is a patch (the collision)',
	'0002.json' in bRec.listing && '0002.jpatch' in aRec.listing && !('0002.json' in aRec.listing),
	JSON.stringify({ A: Object.keys(aRec.listing).filter((k) => k.startsWith('0002')),
		B: Object.keys(bRec.listing).filter((k) => k.startsWith('0002')) }));
check('1. each device recorded a files version with a manifest',
	!!(aRec.saved && aRec.saved.version === 3) && !!(bRec.saved && bRec.saved.version === 4),
	JSON.stringify({ A: aRec.saved, B: bRec.saved }));
const bOwn = bRec.log.filter((r) => (r.crystal_version || 0) >= 2);

// ── 2. B takes A's copy, as a two-sided sync ──────────────────────────────────
const ea = await A.page.evaluate((id) => __s.app.export_diamond(id), id);
const b2 = await B.page.evaluate(async ({ id, ea }) => {
	let imported = true;
	try { await __s.app.import_diamond(ea, true); } catch (e) { imported = 'THREW ' + String(e && e.message || e); }
	return { imported, listing: await __s.listing(id), log: await __s.log(id),
		manifests: await __s.manifests(id), counter: await __s.counter(id),
		live: await __s.app.read_crystal_data(id), livePage: await __s.app.read_crystal_page(id) };
}, { id, ea });
check('2. B takes A\'s copy of the Diamond', b2.imported === true, String(b2.imported));
const b2Reads = await reads(B, id, 4);
const wrongAt = [];
for (let n = 0; n <= 4; n++) {
	if (b2Reads[n].m !== aReads[n].m || b2Reads[n].p !== aReads[n].p) wrongAt.push(n);
}
check('2. every number A\'s copy carries reads as A\'s memory and A\'s page on B',
	wrongAt.length === 0, 'wrong at ' + JSON.stringify(wrongAt)
		+ (wrongAt.length ? ' e.g. v' + wrongAt[0] + ' reads ' + short(b2Reads[wrongAt[0]].m.slice(0, 80)) : ''));
const leftAt = [];
for (let n = 0; n <= 6; n++) if (crystalAt(b2.listing, n) !== crystalAt(aRec.listing, n)) leftAt.push(n);
check('2. no snapshot of B\'s is left among the numbers of A\'s copy',
	leftAt.length === 0, 'differs at ' + JSON.stringify(leftAt)
		+ (leftAt.length ? ': ' + crystalAt(b2.listing, leftAt[0]).replace(/=[0-9a-f]+/g, '') : ''));
// B's own versions: its log records, found by id, under their new numbers.
const moved = bOwn.map((r) => {
	const now = b2.log.find((x) => x.id === r.id);
	return { id: r.id, kind: r.kind, from: r.crystal_version, to: now ? now.crystal_version : null };
});
check('2. every version of B\'s is in its History, under a number above both histories',
	moved.length === 5 && moved.every((m) => m.to !== null && m.to > 6),
	JSON.stringify(moved.map((m) => [m.kind, m.from, m.to])));
const b2Own = await B.page.evaluate(async ({ id, moved }) => {
	const out = [];
	for (const m of moved) {
		if (m.to === null) { out.push(null); continue; }
		out.push({ m: await __s.vread(id, m.to), p: await __s.pread(id, m.to) });
	}
	return out;
}, { id, moved });
const ownWrong = moved.filter((m, i) => !b2Own[i]
	|| b2Own[i].m !== bReads[m.from].m || b2Own[i].p !== bReads[m.from].p);
check('2. each of B\'s versions reads under its new number as it read on B, memory and page',
	ownWrong.length === 0, JSON.stringify(ownWrong.map((m) => [m.from, m.to])));
const bFiles = moved.find((m) => m.kind === 'files');
const bManifest = bFiles ? b2.manifests.find((m) => m.version === bFiles.to) : null;
check('2. B\'s files version kept its manifest, on the same number as its memory and its record',
	!!bManifest && JSON.stringify(bManifest.files || []).indexOf('notes-b.md') !== -1
		&& !b2.manifests.some((m) => m.version === 4 && JSON.stringify(m.files || []).indexOf('notes-b.md') !== -1),
	JSON.stringify({ record: bFiles ? bFiles.to : null,
		manifests: b2.manifests.map((m) => [m.version, (m.files || []).map((f) => f.path.split('/').pop())]) }));
const lowest = moved.reduce((m, x) => (x.to !== null && x.to < m ? x.to : m), Infinity);
const pad = (n) => String(n).padStart(4, '0');
check('2. B\'s refiled run starts with full copies of its memory and its page',
	(pad(lowest) + '.json') in b2.listing && (pad(lowest) + '.html') in b2.listing,
	JSON.stringify(Object.keys(b2.listing).filter((k) => k.startsWith(pad(lowest)))));
check('2. the live Diamond on B is A\'s, and the version it is at reads as it',
	b2.live === aReads[4].m && b2.counter === 4,
	JSON.stringify({ counter: b2.counter, live: b2.live === aReads[4].m }));
check('2. the copy kept before sync still stands',
	b2.manifests.some((m) => /kept before sync/.test(m.note || '')));

// ── 3. The next edit on B, and every version it holds ────────────────────────
const b3 = await B.page.evaluate(async (id) => {
	await __s.app.write_crystal_data(id, __s.memory('after the import on B'));
	const v = await __s.newest(id);
	const listing = await __s.listing(id);
	return { v, m: await __s.vread(id, v), p: await __s.pread(id, v), listing,
		want: __s.memory('after the import on B') };
}, id);
check('3. the next edit on B reads back, with the live page',
	b3.m === b3.want && b3.p === aReads[4].p, 'v' + b3.v + ' ' + short(b3.m.slice(0, 60)));
const b3Reads = await B.page.evaluate(async ({ id, ns }) => {
	const bad = [];
	for (const n of ns) { const m = await __s.vread(id, n); if (/^ERR/.test(m)) bad.push(n + ': ' + m.slice(0, 80)); }
	return bad;
}, { id, ns: dataNumbers(b3.listing) });
check('3. every version B holds still rebuilds', b3Reads.length === 0, JSON.stringify(b3Reads));

// ── 4. A moves on, then takes B's copy ────────────────────────────────────────
const a4 = await A.page.evaluate(async ({ id }) => {
	await __s.app.write_crystal_data(id, __s.memory('shared', 'A after it exported'));
	const v = await __s.counter(id);
	const own = (await __s.log(id)).find((r) => r.crystal_version === v);
	return { v, own: own ? own.id : null, m: await __s.vread(id, v) };
}, { id });
const eb = await B.page.evaluate((id) => __s.app.export_diamond(id), id);
const bNow = await B.page.evaluate(async (id) => ({ listing: await __s.listing(id), counter: await __s.counter(id) }), id);
const bNowReads = await reads(B, id, maxNumber(bNow.listing));
const a4b = await A.page.evaluate(async ({ id, eb, own }) => {
	let imported = true;
	try { await __s.app.import_diamond(eb, true); } catch (e) { imported = 'THREW ' + String(e && e.message || e); }
	const rec = (await __s.log(id)).find((r) => r.id === own);
	const to = rec ? rec.crystal_version : null;
	return { imported, to, m: to === null ? null : await __s.vread(id, to), listing: await __s.listing(id),
		live: await __s.app.read_crystal_data(id) };
}, { id, eb, own: a4.own });
check('4. A takes B\'s copy after moving on', a4b.imported === true, String(a4b.imported));
check('4. A\'s own version is refiled above B\'s copy and reads as it did',
	a4b.to !== null && a4b.to > maxNumber(bNow.listing) && a4b.m === a4.m,
	JSON.stringify({ from: a4.v, to: a4b.to }));
const a4Reads = await reads(A, id, maxNumber(bNow.listing));
const aWrong = dataNumbers(bNow.listing).filter((n) =>
	a4Reads[n].m !== bNowReads[n].m || a4Reads[n].p !== bNowReads[n].p);
check('4. every number B\'s copy holds reads on A as it reads on B',
	aWrong.length === 0, JSON.stringify(aWrong));
check('4. the live Diamond on A is B\'s', a4b.live === b3.want);

// ── 5. A one-sided pull over a device that had moved ──────────────────────────
const d2 = await A.page.evaluate(async () => {
	const id = await __s.app.create_diamond('one-sided');
	await __s.app.write_crystal_data(id, __s.memory('two'));
	return { id, e: await __s.app.export_diamond(id) };
});
await B.page.evaluate(async (e) => { await __s.app.import_diamond(e, false); }, d2.e);
await A.page.evaluate(async (id) => { await __s.app.write_crystal_data(id, __s.memory('two', 'A')); }, d2.id);
const b5pre = await B.page.evaluate(async (id) => {
	for (const x of ['B one', 'B two', 'B three']) await __s.app.write_crystal_data(id, __s.memory('two', x));
	return { log: await __s.log(id), counter: await __s.counter(id) };
}, d2.id);
const b5preReads = await reads(B, d2.id, b5pre.counter);
const ea2 = await A.page.evaluate((id) => __s.app.export_diamond(id), d2.id);
const a5Reads = await reads(A, d2.id, 2);
const b5 = await B.page.evaluate(async ({ id, ea2 }) => {
	let imported = true;
	try { await __s.app.import_diamond(ea2, false); } catch (e) { imported = 'THREW ' + String(e && e.message || e); }
	await __s.app.write_crystal_data(id, __s.memory('two', 'B after the pull'));
	const v = await __s.newest(id);
	return { imported, v, m: await __s.vread(id, v), want: __s.memory('two', 'B after the pull'),
		log: await __s.log(id), listing: await __s.listing(id) };
}, { id: d2.id, ea2 });
check('5. B takes a copy as a one-sided pull', b5.imported === true, String(b5.imported));
const b5Reads = await reads(B, d2.id, 2);
check('5. the numbers the copy carries read as A\'s',
	[0, 1, 2].every((n) => b5Reads[n].m === a5Reads[n].m), JSON.stringify([0, 1, 2].map((n) => b5Reads[n].m === a5Reads[n].m)));
const b5Moved = b5pre.log.filter((r) => r.crystal_version >= 2).map((r) => {
	const now = b5.log.find((x) => x.id === r.id);
	return { from: r.crystal_version, to: now ? now.crystal_version : null };
});
const b5Own = await B.page.evaluate(async ({ id, moved }) => {
	const out = [];
	for (const m of moved) out.push(m.to === null ? null : await __s.vread(id, m.to));
	return out;
}, { id: d2.id, moved: b5Moved });
check('5. B\'s versions are kept, and read as they did',
	b5Moved.length === 3 && b5Moved.every((m, i) => m.to !== null && m.to > 3 && b5Own[i] === b5preReads[m.from].m),
	JSON.stringify(b5Moved));
check('5. the next edit on B reads back (a chain through B\'s old snapshots broke it)',
	b5.m === b5.want, 'v' + b5.v + ' ' + short(b5.m.slice(0, 80)));

// ── 6 and 7. A refile that fails refuses the import ───────────────────────────
// A fresh Diamond each, parted the same way, and the browser's handles made to refuse.
const parted = async (name) => {
	const d = await A.page.evaluate(async (name) => {
		const id = await __s.app.create_diamond(name);
		await __s.app.write_crystal_data(id, __s.memory(name));
		return { id, e: await __s.app.export_diamond(id) };
	}, name);
	await B.page.evaluate(async (e) => { await __s.app.import_diamond(e, false); }, d.e);
	await A.page.evaluate(async ({ id, name }) => {
		await __s.app.write_crystal_data(id, __s.memory(name, 'A'));
	}, { id: d.id, name });
	await B.page.evaluate(async ({ id, name }) => {
		await __s.app.write_crystal_data(id, __s.memory(name, 'B one'));
		await __s.app.write_crystal_data(id, __s.memory(name, 'B two'));
	}, { id: d.id, name });
	return { id: d.id, e: await A.page.evaluate((id) => __s.app.export_diamond(id), d.id) };
};
// What a failed import must leave exactly as it found: `versions/`, the log, the counter and the
// live crystal.
const state = (id) => B.page.evaluate(async (id) => ({
	listing: await __s.listing(id), log: await __s.app.log_read(id), counter: await __s.counter(id),
	live: await __s.app.read_crystal_data(id),
}), id);
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

const d6 = await parted('write refused');
const s6 = await state(d6.id);
const r6 = await B.page.evaluate(async ({ id, e, listing }) => {
	// The highest number either side holds: a write to a `versions/` file above it is a refile.
	const theirs = Object.keys(JSON.parse(e).files || {}).map((k) => /^versions\/(\d+)\./.exec(k))
		.filter(Boolean).map((m) => Number(m[1]));
	const top = Math.max(0, ...theirs, ...Object.keys(listing).map((k) => Number((/^(\d+)\./.exec(k) || [0, 0])[1])));
	const P = FileSystemDirectoryHandle.prototype;
	const get = P.getFileHandle;
	let refused = 0;
	P.getFileHandle = function (name, opts) {
		const m = /^(\d+)\./.exec(String(name));
		if (opts && opts.create && this.name === 'versions' && m && Number(m[1]) > top) {
			refused++;
			return Promise.reject(new DOMException('The disk is full (verify_snapshotmix).', 'QuotaExceededError'));
		}
		return get.call(this, name, opts);
	};
	let threw = null;
	try { await __s.app.import_diamond(e, true); } catch (err) { threw = String(err && err.message || err); }
	P.getFileHandle = get;
	return { threw, refused, top };
}, { id: d6.id, e: d6.e, listing: s6.listing });
check('6. a refile that cannot be written refuses the import',
	r6.threw !== null && r6.refused > 0, short(r6));
const s6b = await state(d6.id);
check('6. and B\'s store is as it was: versions/, log, counter and live crystal',
	same(s6, s6b), JSON.stringify({ listing: same(s6.listing, s6b.listing), log: s6.log === s6b.log,
		counter: [s6.counter, s6b.counter], live: s6.live === s6b.live }));

const d7 = await parted('removal refused');
const s7 = await state(d7.id);
const r7 = await B.page.evaluate(async ({ e }) => {
	// B's own versions are 2 and 3. The refile removes their old files once the new ones stand:
	// the first removal is let through, and a later one refused, so what was removed has to be
	// put back.
	const P = FileSystemDirectoryHandle.prototype;
	const rm = P.removeEntry;
	const seen = [];
	let refused = 0;
	P.removeEntry = function (name, opts) {
		const m = /^(\d+)\./.exec(String(name));
		if (this.name === 'versions' && m && (Number(m[1]) === 2 || Number(m[1]) === 3)) {
			seen.push(String(name));
			if (seen.length > 1) {
				refused++;
				return Promise.reject(new DOMException('The file is locked (verify_snapshotmix).', 'NoModificationAllowedError'));
			}
		}
		return rm.call(this, name, opts);
	};
	let threw = null;
	try { await __s.app.import_diamond(e, true); } catch (err) { threw = String(err && err.message || err); }
	P.removeEntry = rm;
	return { threw, refused, seen };
}, { e: d7.e });
check('7. a refile whose removal fails refuses the import',
	r7.threw !== null && r7.refused > 0, short(r7));
const s7b = await state(d7.id);
check('7. and B\'s store is as it was, the removed file put back',
	same(s7, s7b), JSON.stringify({ listing: same(s7.listing, s7b.listing), log: s7.log === s7b.log,
		counter: [s7.counter, s7b.counter], live: s7.live === s7b.live,
		gone: Object.keys(s7.listing).filter((k) => !(k in s7b.listing)),
		extra: Object.keys(s7b.listing).filter((k) => !(k in s7.listing)) }));
// And with the handles back, the same import goes through.
const r7c = await B.page.evaluate(async ({ id, e }) => {
	try { await __s.app.import_diamond(e, true); } catch (err) { return 'THREW ' + String(err && err.message || err); }
	return await __s.app.read_crystal_data(id);
}, { id: d7.id, e: d7.e });
const a7 = await A.page.evaluate((id) => __s.app.read_crystal_data(id), d7.id);
check('7. and once the disk takes it, the same import lands', r7c === a7, short(r7c).slice(0, 80));

for (const s of [A, B]) {
	await s.page.evaluate(async (ids) => {
		for (const id of ids) { try { await __s.app.delete_diamond(id); } catch (e) { /* tidy */ } }
	}, [id, d2.id, d6.id, d7.id]);
}
const errs = [...A.errs, ...B.errs].filter(e => !/favicon|404|401|net::ERR|Failed to load resource/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await A.close();
await B.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
