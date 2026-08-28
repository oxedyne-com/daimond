// verify_deltalog.mjs — crystal version history is a delta log, and every
// version in it still comes back byte for byte.
//
// Until this change every capp page edit wrote a full uncompressed copy of the
// page into `versions/`, and nothing anywhere prunes them: the shipped Log Life
// page is 101,834 bytes, so a hundred edits was 10.2 MB against a per-Diamond
// share of 4 MiB. A version now stores either a full copy — a KEYFRAME — or the
// splices from the snapshot before it, with one keyframe every twenty.
//
// The arithmetic and the chain planning are `src/diamond_delta.rs`'s and are
// tested natively against that same page; `dev/breakproof_deltalog.sh` proves
// each of those checks against broken code. What only a browser can reach is the
// OPFS edge in `src/wasm/diamond.rs` — the directory walk that decides which file
// is which, the chain read, and the proof `write_snapshot` performs before a
// version is allowed to stand. That is what this is for.
//
// What is pinned:
//   * a run of page edits writes patches, not copies, and no version stands on
//     more than nineteen of them;
//   * every version reads back as the exact bytes it was written as, page and
//     memory both;
//   * the whole history weighs a fraction of what the same history cost before;
//   * A CORRUPTED PATCH IS REFUSED, not silently answered with the keyframe under
//     it — which is the failure this whole encoding exists to prevent, and the
//     one that would otherwise be discovered months later;
//   * a patch DELETED from the middle of a chain is refused the same way;
//   * THE DAMAGE IS BOUNDED BY THE INTERVAL: versions before the break read, and
//     so do versions past the next keyframe;
//   * and the Diamond MENDS — a version whose parent cannot be rebuilt records a
//     full copy, so the history continues rather than ending at the break.
//
// Run with dev/serve.mjs (DAIMOND_PORT) up. No gateway, no mock model.
//
//	node dev/verify_deltalog.mjs
import { open, clearDiamonds } from './harness.mjs';

const ok = [], bad = [];
// The store's errors arrive coloured, and a colour code in a verifier's own
// output is a line nobody can read in a log file.
const ESC = String.fromCharCode(27);
const plain = (s) => String(s)
	.split(ESC).map((x, i) => i ? x.replace(/^\[[0-9;]*m/, '') : x).join('')
	.replace(/\\u001b\[[0-9;]*m/g, '');
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + plain(detail) : ''));
};

// How many page edits to make. Enough to cross the keyframe interval twice, so
// a chain is walked in earnest and a keyframe count means something.
const TURNS = 45;
const EVERY = 20;      // src/diamond_delta.rs KEYFRAME_EVERY

const s = await open({ name: 'deltalog', connect: false, defaults: false });
const p = s.page;
await p.waitForTimeout(1500);
await clearDiamonds(s);

await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	window.__d = {
		mod,
		app:  new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true),
		root: await navigator.storage.getDirectory(),
	};
	window.__at = async (path) => {
		let cur = __d.root;
		for (const part of path.split('/')) cur = await cur.getDirectoryHandle(part);
		return cur;
	};
	window.__dir = async (path) => {
		const cur = await __at(path);
		const out = [];
		for await (const [name, h] of cur.entries()) {
			if (h.kind !== 'file') continue;
			out.push({ name, size: (await h.getFile()).size });
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	};
	// The sequence of edits, in one place, so what is written and what it is
	// compared against cannot drift apart.
	window.__page0 = async () => (await (await fetch('/capps/lifelog/crystal.html')).text());
	window.__turn = (page, n) => {
		const lines = page.split('\n');
		if (n % 3 === 0) {
			// A section pasted in, which is what a new lane or a new card is.
			const at = (n * 71 + 3) % lines.length;
			const block = ['<section class="lane lane-' + n + '">'];
			for (let k = 0; k < 6; k++) {
				block.push('  <div class="row" data-k="' + k + '">entry ' + n + '</div>');
			}
			block.push('</section>');
			lines.splice(at, 0, ...block);
		} else {
			// One line changed, which is the commonest turn by far.
			const at = (n * 37 + 11) % lines.length;
			lines[at] = lines[at] + ' <!-- ' + n + ' -->';
		}
		return lines.join('\n');
	};
	window.__data = (n) => JSON.stringify({ title: 'Delta log',
		lanes: Array.from({ length: n }, (_, k) => ({ k, note: 'lane ' + k + ' as at turn ' + n })) });
});

// The real page, and a run of edits of the shape a turn makes.

const built = await p.evaluate(async (turns) => {
	const page0 = await __page0();
	const id = await __d.app.create_diamond('Delta log');
	let page = page0, full = 0;
	// Version 0 is the empty crystal `create_diamond` lays down, so the first
	// write is version 1 and version N holds turn N - 1.
	for (let n = 0; n <= turns; n++) {
		if (n > 0) page = __turn(page, n);
		await __d.app.write_crystal_both(id, __data(n), page);
		full += new Blob([page]).size + new Blob([__data(n)]).size;
	}
	return { id, bytes: new Blob([page0]).size, full };
}, TURNS);

check('the fixture is the real shipped Log Life capp page',
	built.bytes === 101834, String(built.bytes));

const files = await p.evaluate(async (id) => __dir('diamonds/' + id + '/versions'), built.id);
const count = (ext) => files.filter(f => f.name.endsWith(ext)).length;
const weight = files.reduce((a, f) => a + f.size, 0);

/// The deepest run of patches standing on one full copy, which is what the
/// interval is for: it bounds both what one bad splice can invalidate and what
/// the history view has to read to answer a question about an old version.
const deepest = (kf, patch) => {
	const rows = files
		.map(f => ({ v: parseInt(f.name, 10),
			kf: f.name.endsWith(kf), pt: f.name.endsWith(patch) }))
		.filter(r => !isNaN(r.v) && (r.kf || r.pt))
		.sort((a, b) => a.v - b.v);
	let run = 0, worst = 0;
	for (const r of rows) {
		run = r.kf ? 0 : run + 1;
		worst = Math.max(worst, run);
	}
	return { worst, rows: rows.length };
};

check('the page is stored as splices, not as a copy per version',
	count('.hpatch') > TURNS - 5, count('.hpatch') + ' patches, ' + count('.html') + ' full copies');
check('and the memory beside it is too',
	count('.jpatch') > TURNS - 8, count('.jpatch') + ' patches, ' + count('.json') + ' full copies');

const pageDeep = deepest('.html', '.hpatch');
const dataDeep = deepest('.json', '.jpatch');
check('no page version stands on more than nineteen patches',
	pageDeep.worst > 0 && pageDeep.worst <= EVERY - 1,
	pageDeep.worst + ' deep over ' + pageDeep.rows + ' snapshots');
check('and no memory version does either',
	dataDeep.worst > 0 && dataDeep.worst <= EVERY - 1,
	dataDeep.worst + ' deep over ' + dataDeep.rows + ' snapshots');
check('the interval is really the interval, not a keyframe on everything',
	pageDeep.worst >= EVERY - 1, String(pageDeep.worst));
check('the whole history weighs a fraction of what the copies weighed',
	weight * 4 < built.full,
	Math.round(weight / 1024) + ' KiB against ' + Math.round(built.full / 1024) + ' KiB');

// What the sync budget is spent against.  `collectDiamonds` weighs each Diamond
// with `export_diamond_size` BEFORE materialising it, and a Diamond that estimate
// rejects is never built -- so that answer has to hold, and nothing in a browser
// had ever checked it.  The estimate weighed every file as though it travelled
// base64; most of a Diamond is valid UTF-8 and travels as itself.

const weighed = await p.evaluate(async (id) => {
	// The whole directory, which is what `export_size` walks -- the crystal, the
	// page, every snapshot, the metadata, the log and the sidecars.
	const walk = async (dir, rel, out) => {
		for await (const [name, h] of dir.entries()) {
			const child = rel ? rel + '/' + name : name;
			if (h.kind === 'directory') await walk(h, child, out);
			else out.push({ path: child, size: (await h.getFile()).size });
		}
		return out;
	};
	const all = await walk(await __at('diamonds/' + id), '', []);
	return {
		pre:   await __d.app.export_diamond_size(id),
		exact: (await __d.app.export_diamond(id)).length,
		// What the same Diamond weighed before this: four bytes for three of
		// EVERY file plus its path, which is what `export_size` did for every
		// kind alike.
		old:   all.reduce((a, f) => a + Math.floor(f.size * 4 / 3) + f.path.length, 0),
	};
}, built.id);
const oldWay = weighed.old;

check('the size estimate is never under what the pack really costs, which is the '
	+ 'direction a refusal points',
	weighed.pre >= weighed.exact,
	weighed.pre + ' estimated, ' + weighed.exact + ' real');
check('and it is closer than weighing every file as base64 was',
	weighed.pre < oldWay,
	Math.round(weighed.pre / 1024) + ' KiB against the old ' + Math.round(oldWay / 1024)
		+ ' KiB, real ' + Math.round(weighed.exact / 1024) + ' KiB');

// Every version reads back as itself.  Compared inside the page: a hundred
// kilobytes per version is not something to carry across the bridge forty-six
// times.

const same = await p.evaluate(async (arg) => {
	let page = await __page0();
	const wrong = [];
	for (let n = 0; n <= arg.turns; n++) {
		if (n > 0) page = __turn(page, n);
		const data = __data(n);
		let gotP, gotD;
		try {
			gotP = await __d.app.read_version_page(arg.id, n + 1);
			gotD = await __d.app.read_version(arg.id, n + 1);
		} catch (e) {
			wrong.push({ v: n + 1, err: String(e).slice(0, 60) });
			continue;
		}
		if (gotP !== page) wrong.push({ v: n + 1, what: 'page', got: gotP.length, want: page.length });
		if (gotD !== data) wrong.push({ v: n + 1, what: 'data', got: gotD.length, want: data.length });
	}
	// And the version the Diamond was created at, which has an empty crystal and
	// no page at all.
	const zero = { page: await __d.app.read_version_page(arg.id, 0),
		data: await __d.app.read_version(arg.id, 0) };
	return { wrong, zero };
}, { id: built.id, turns: TURNS });

check('every version reads back as the exact bytes it was written as',
	same.wrong.length === 0,
	same.wrong.length ? JSON.stringify(same.wrong.slice(0, 3)) : (TURNS + 1) + ' versions');
check('and version 0 is still the empty crystal it was created with',
	same.zero.page === '' && same.zero.data === '', JSON.stringify(same.zero));

// A corrupted patch is refused, not answered with the keyframe.  This is the one
// failure the whole encoding exists to prevent: a splice list bent by a bit is
// still structurally valid -- the offsets fit, the file is the right length --
// so a reader with no checksum returns a page nobody ever wrote, and nothing
// says so until somebody notices months later that an old version is wrong.

const hpatches = files.filter(f => f.name.endsWith('.hpatch'))
	.map(f => parseInt(f.name, 10)).sort((a, b) => a - b);
const victim = hpatches.filter(v => v % EVERY > 2 && v % EVERY < EVERY - 2)[0];
const nextKf = files.filter(f => f.name.endsWith('.html'))
	.map(f => parseInt(f.name, 10)).filter(v => v > victim).sort((a, b) => a - b)[0];

const bent = await p.evaluate(async (arg) => {
	const dir = await __at('diamonds/' + arg.id + '/versions');
	const name = String(arg.v).padStart(4, '0') + '.hpatch';
	const fh = await dir.getFileHandle(name);
	const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
	const keep = Array.from(buf);
	// One bit, in the payload rather than the header: the crudest damage a
	// storage layer can do, and the one a length check cannot see.
	buf[buf.length - 1] ^= 0x20;
	let w = await fh.createWritable();
	await w.write(buf); await w.close();
	const at = async (v) => {
		try { return { v, len: (await __d.app.read_version_page(arg.id, v)).length }; }
		catch (e) { return { v, err: String(e).slice(0, 40) }; }
	};
	const before = await at(arg.v - 1);
	const broken = [await at(arg.v), await at(arg.v + 1)];
	const past = arg.nextKf ? await at(arg.nextKf) : null;
	// Put it back, and require the version to be readable again: a check that
	// cannot tell damage from a reader that refuses everything is not a check.
	w = await fh.createWritable();
	await w.write(new Uint8Array(keep)); await w.close();
	const healed = await at(arg.v);
	return { before, broken, past, healed };
}, { id: built.id, v: victim, nextKf });

check('a version standing on a corrupted patch is REFUSED, not answered',
	bent.broken.every(a => a.err !== undefined), JSON.stringify(bent.broken));
check('the damage stops under it: the version before the break still reads',
	bent.before.len > 90000, JSON.stringify(bent.before));
check('and it stops at the next keyframe, so the loss is bounded by the interval',
	bent.past && bent.past.len > 90000, JSON.stringify(bent.past));
check('putting the patch back makes the version readable again',
	bent.healed.len > 90000, JSON.stringify(bent.healed));

// A patch missing from the middle of a chain.  The two files answer this
// differently, and the difference is the sparse page snapshot rule rather than
// anything the delta log introduced.
//
// The MEMORY is snapshotted at every version, so a gap in it is a gap: the
// version whose file has gone is refused, and so is every version over it.
//
// The PAGE is snapshotted only where it changed, so a version with no page
// snapshot has always meant "the page did not move here" and is answered with
// the last one that did.  A deleted page patch is indistinguishable from that,
// and nothing in the file system can tell them apart.  What it CANNOT do is
// spread: the version after it was made against bytes that are no longer under
// it, its checksum says so, and it is refused.

const gone = await p.evaluate(async (arg) => {
	const dir = await __at('diamonds/' + arg.id + '/versions');
	const at = async (v) => {
		try {
			return { v, page: (await __d.app.read_version_page(arg.id, v)).length,
				data: (await __d.app.read_version(arg.id, v)).length };
		} catch (e) { return { v, err: String(e).slice(0, 40) }; }
	};
	const take = async (name) => {
		const fh = await dir.getFileHandle(name);
		const keep = Array.from(new Uint8Array(await (await fh.getFile()).arrayBuffer()));
		await dir.removeEntry(name);
		return keep;
	};
	const put = async (name, keep) => {
		const fh = await dir.getFileHandle(name, { create: true });
		const w = await fh.createWritable();
		await w.write(new Uint8Array(keep)); await w.close();
	};
	const n = String(arg.v).padStart(4, '0');
	const before = await at(arg.v - 1);

	const hkeep = await take(n + '.hpatch');
	const noPage = [await at(arg.v), await at(arg.v + 1)];
	await put(n + '.hpatch', hkeep);

	const jkeep = await take(n + '.jpatch');
	const noData = [await at(arg.v), await at(arg.v + 1)];
	await put(n + '.jpatch', jkeep);

	return { before, noPage, noData, healed: await at(arg.v) };
}, { id: built.id, v: victim });

check('a memory patch DELETED from the middle of a chain is refused, not skipped over',
	gone.noData.every(a => a.err !== undefined), JSON.stringify(gone.noData));
check('a deleted PAGE patch cannot spread: the version over it is refused',
	gone.noPage[1].err !== undefined, JSON.stringify(gone.noPage[1]));
check('though the version itself reads as the last one that changed the page, which is what \
a version with no page snapshot has always meant',
	gone.noPage[0].page === gone.before.page, JSON.stringify(gone.noPage[0]));
check('and putting both back makes the chain whole again',
	gone.healed.page > 90000 && gone.healed.page !== gone.before.page,
	JSON.stringify(gone.healed));

// ...and the Diamond mends itself on the next write.  A parent that cannot be
// rebuilt is not a reason to refuse the write in front of the user.  It is a
// reason to record a full copy, which is both the safe answer and the one that
// gives the version after it something to build on.

const mended = await p.evaluate(async (arg) => {
	// Break a patch the HEAD stands on, so the next write's parent is the one
	// that cannot be rebuilt.
	const dir = await __at('diamonds/' + arg.id + '/versions');
	const rows = [];
	for await (const [name, h] of dir.entries()) if (h.kind === 'file') rows.push(name);
	const kf = Math.max(...rows.filter(n => n.endsWith('.html')).map(n => parseInt(n, 10)));
	const inChain = rows.filter(n => n.endsWith('.hpatch') && parseInt(n, 10) > kf)
		.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
	const name = inChain[0];
	const fh = await dir.getFileHandle(name);
	const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
	buf[buf.length - 1] ^= 0x20;
	const w = await fh.createWritable();
	await w.write(buf); await w.close();
	// The page FILE is untouched, so the store still knows what the page is; it
	// is the chain behind it that has gone.
	const page = await __d.app.read_crystal_page(arg.id);
	const next = page + '\n<!-- mended -->\n';
	let wrote = null;
	try {
		await __d.app.write_crystal_both(arg.id,
			JSON.stringify({ title: 'Delta log', mended: true }), next);
	} catch (e) { wrote = String(e).slice(0, 60); }
	const now = [];
	for await (const [n2, h] of dir.entries()) if (h.kind === 'file') now.push(n2);
	const top = Math.max(...now.map(n2 => parseInt(n2, 10)).filter(n2 => !isNaN(n2)));
	let got = null, err = null;
	try { got = (await __d.app.read_version_page(arg.id, top)).length; }
	catch (e) { err = String(e).slice(0, 60); }
	return { broke: name, top, wrote, kinds: now.filter(n2 => parseInt(n2, 10) === top),
		got, want: next.length, err };
}, { id: built.id });

check('a chain the store cannot walk does not refuse the write in front of the user',
	mended.wrote === null, String(mended.wrote));
check('a version whose parent cannot be rebuilt is recorded as a full copy',
	mended.kinds.some(k => k.endsWith('.html')),
	'broke ' + mended.broke + ', v' + mended.top + ' is ' + JSON.stringify(mended.kinds));
check('so the history continues from there rather than ending at the break',
	mended.err === null && mended.got === mended.want,
	JSON.stringify({ got: mended.got, want: mended.want, err: mended.err }));

console.log('');
console.log('  ' + ok.length + ' ok, ' + bad.length + ' failed');
await s.close();
process.exit(bad.length ? 1 : 0);
