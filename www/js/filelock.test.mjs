/* ============================================================
   Test -- one Web Lock per file around every write (filelock.js).
   ------------------------------------------------------------
   THE BUG (OPFS-LOCK, 2026-10-17). A writable's bytes are private
   until `close`, so the restore's compare-and-swap in the wasm saw only
   rivals that had already closed: two restores both won, and a page
   write closing in the gap was overwritten and kept in no version row.

   Asserted, over the REAL www/js/filelock.js and a lock manager that
   queues as the browser's does:
   - the lock's name is the wasm's (`fsname::file_lock_name`), over the
     same table as its Rust test;
   - a writable holds its file from before it opens until it closes, so
     a second writer of that file waits, and a writer of another file
     does not;
   - every early end gives the lock back: a failed open, an abort, a
     failed close -- a writable left holding it would block the file;
   - with no lock manager, writes go ahead unheld;
   - a writer waits at most 60 s, then is refused in the wasm's words
     (check2 D2);
   - a path with `..` is refused, because the page's walks drop it where
     the lock name takes it back (check2 D5);
   - `discard` aborts and removes the stub STILL HOLDING the lock, so a
     failed write's cleanup cannot take a rival's file (check2 D1).

   Run:   node www/js/filelock.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./filelock.js', import.meta.url), 'utf8');
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}

/// A lock manager that grants each name exclusively, in order, as `navigator.locks` does.
function fakeLocks() {
	const held = new Map(); // name -> queue of waiting starters
	const log = [];
	return {
		log,
		holding: (n) => held.has(n),
		request(name, opts, cb) {
			return new Promise((resolve, reject) => {
				let waiting = true;
				if (opts && opts.signal) opts.signal.addEventListener('abort', () => {
					if (!waiting) return;
					const q = held.get(name), i = q ? q.indexOf(start) : -1;
					if (i > 0) { q.splice(i, 1); reject(opts.signal.reason); }
				});
				const start = () => {
					waiting = false;
					log.push('grant ' + name);
					Promise.resolve().then(() => cb({ name })).then((v) => {
						log.push('release ' + name);
						const q = held.get(name);
						q.shift();
						if (q.length) q[0](); else held.delete(name);
						resolve(v);
					}, reject);
				};
				if (held.has(name)) held.get(name).push(start);
				else { held.set(name, [start]); start(); }
			});
		},
	};
}

function load(locks, abortSignal) {
	const win = {};
	new Function('window', 'navigator', 'AbortSignal', SRC)(win, locks ? { locks } : {}, abortSignal || AbortSignal);
	return win.DaimondFileLock;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/// A stand-in writable, recording what was done to it.
function fakeWritable(rec, failClose) {
	return {
		write: async (x) => { rec.push('write ' + x); },
		close: async () => { rec.push('close'); if (failClose) throw new Error('close failed'); },
		abort: async () => { rec.push('abort'); },
	};
}

// 1. The name, over the same table as fsname.rs `file_lock_name_matches_the_page`.
{
	const L = load(fakeLocks());
	const table = [
		['sandbox', 'notes/a.txt',           'daimond-file:sandbox:notes/a.txt'],
		['folder',  'notes/a.txt',           'daimond-file:folder:notes/a.txt'],
		['sandbox', '/notes//./A.TXT',       'daimond-file:sandbox:notes/a.txt'],
		['sandbox', 'x/../notes/a.txt',      'daimond-file:sandbox:notes/a.txt'],
		['sandbox', '../../a.txt',           'daimond-file:sandbox:a.txt'],
		['sandbox', 'm/70074.3.daimond:2,S', 'daimond-file:sandbox:m/70074.3.daimond:2,s'],
	];
	for (const [root, path, want] of table) {
		const got = L.name(root, path);
		check('name ' + root + ' ' + path, got === want, got);
	}
}

// 2. A writable holds its file from open to close; a second writer of it waits; another file does not.
{
	const locks = fakeLocks();
	const L = load(locks);
	const rec = [];
	const w1 = await L.writable('sandbox', 'a.txt', async () => fakeWritable(rec));
	check('held while open', locks.holding('daimond-file:sandbox:a.txt'));
	let second = null;
	const p2 = L.writable('sandbox', 'A.txt', async () => { rec.push('open2'); return fakeWritable(rec); })
		.then((w) => { second = w; });
	let other = null;
	const p3 = L.writable('sandbox', 'b.txt', async () => fakeWritable([]))
		.then((w) => { other = w; });
	await tick(); await tick();
	check('a second writer of the file waits', second === null && !rec.includes('open2'));
	await p3;
	check('a writer of another file does not', other !== null);
	await other.close();
	await w1.write('x');
	await w1.close();
	await p2;
	check('the second opens after the first closes',
		rec.indexOf('close') < rec.indexOf('open2') && second !== null, rec.join(','));
	await second.close();
	await tick();
	check('given back at the end', !locks.holding('daimond-file:sandbox:a.txt'));
}

// 3. Every early end gives the lock back.
{
	const locks = fakeLocks();
	const L = load(locks);
	const n = 'daimond-file:folder:f.txt';
	let threw = false;
	try { await L.writable('folder', 'f.txt', async () => { throw new Error('NoModificationAllowedError'); }); }
	catch (e) { threw = true; }
	await tick();
	check('a failed open throws and gives the lock back', threw && !locks.holding(n));

	const rec = [];
	const w = await L.writable('folder', 'f.txt', async () => fakeWritable(rec));
	await w.abort();
	await tick();
	check('an abort aborts and gives the lock back', rec.includes('abort') && !locks.holding(n));

	const w2 = await L.writable('folder', 'f.txt', async () => fakeWritable([], true));
	let closeThrew = false;
	try { await w2.close(); } catch (e) { closeThrew = true; }
	await tick();
	check('a failed close throws and gives the lock back', closeThrew && !locks.holding(n));

	const v = await L.hold('folder', 'f.txt', async () => { await tick(); return locks.holding(n) ? 7 : 0; });
	await tick();
	check('hold runs under the lock and answers', v === 7 && !locks.holding(n));
}

// 4. No lock manager: writes go ahead unheld.
{
	const L = load(null);
	const rec = [];
	const w = await L.writable('sandbox', 'a.txt', async () => fakeWritable(rec));
	await w.close();
	check('no lock manager: the raw writable, written', rec.includes('close'));
	check('no lock manager: hold runs', (await L.hold('sandbox', 'a.txt', async () => 3)) === 3);
}

// 5. A bounded wait: 60 s, then refused in the wasm's words (D2).
{
	const asked = [];
	const fires = [];
	const FakeSignal = { timeout(ms) { asked.push(ms); const c = new AbortController(); fires.push(() => c.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))); return c.signal; } };
	const locks = fakeLocks();
	const L = load(locks, FakeSignal);
	const w1 = await L.writable('sandbox', 'slow.txt', async () => fakeWritable([]));
	let got = null;
	const p2 = L.writable('sandbox', 'slow.txt', async () => fakeWritable([])).then(() => 'opened', (e) => e.message);
	const p3 = L.hold('sandbox', 'slow.txt', async () => 'ran').then((v) => v, (e) => e.message);
	await tick();
	check('every wait asks for a 60 s signal', asked.length === 3 && asked.every((ms) => ms === 60000), asked.join(','));
	fires[1](); fires[2]();
	got = await p2;
	const want = "'slow.txt' has been held by another write for over 60 seconds, so nothing was written. Try again in a moment.";
	check('a writable that waited 60 s is refused in the wasm words', got === want, got);
	check('a hold that waited 60 s is refused alike', (await p3) === want);
	await w1.close();
	await tick();
	check('and the holder is untouched by it', !locks.holding('daimond-file:sandbox:slow.txt'));
}

// 6. `..` is refused before anything opens (D5).
{
	const L = load(fakeLocks());
	let opened = false;
	const r = await L.writable('sandbox', 'x/../a.txt', async () => { opened = true; return fakeWritable([]); })
		.then(() => 'opened', (e) => e.message);
	check('a writable of x/../a.txt is refused unopened', !opened && /has a '\.\.' in it/.test(r), r);
	const h = await L.hold('folder', '../a.txt', async () => 'ran').then((v) => v, (e) => e.message);
	check('a hold of ../a.txt is refused', /has a '\.\.' in it/.test(h), h);
}

// 7. `discard` aborts, removes under the lock, then gives it back (D1).
{
	const locks = fakeLocks();
	const L = load(locks);
	const n = 'daimond-file:folder:new.txt';
	const rec = [];
	const w = await L.writable('folder', 'new.txt', async () => fakeWritable(rec));
	await w.write('x');
	let heldAtRemove = null;
	await w.discard(async () => { heldAtRemove = locks.holding(n); rec.push('remove'); });
	await tick();
	check('discard aborts, never closes', rec.includes('abort') && !rec.includes('close'), rec.join(','));
	check('discard removes while the lock is held', heldAtRemove === true);
	check('and gives the lock back', !locks.holding(n));
	const rec2 = [];
	const w2 = await L.writable('folder', 'new.txt', async () => fakeWritable(rec2, true));
	try { await w2.close(); } catch (e) { /* the failure discard follows */ }
	let held2 = null;
	await w2.discard(async () => { held2 = locks.holding(n); });
	await tick();
	check('a discard after a failed close removes under a fresh hold', held2 === true && !locks.holding(n));
	const w3 = await L.writable('folder', 'new.txt', async () => fakeWritable([]));
	await w3.discard();
	await tick();
	check('a discard with nothing to remove only aborts', !locks.holding(n));
	const L0 = load(null);
	const rec4 = [];
	const w4 = await L0.writable('sandbox', 'a.txt', async () => fakeWritable(rec4));
	let ran4 = false;
	await w4.discard(async () => { ran4 = true; });
	check('no lock manager: discard aborts and removes', rec4.includes('abort') && ran4);
}

// 8. "Save a copy" may not target the open folder or anything inside it (D4).
{
	const L = load(fakeLocks());
	// A stand-in handle tree: `path` is where it stands on the disk.
	const h = (path) => ({
		path,
		async isSameEntry(o) { return o.path === path; },
		async resolve(o) { return o.path.startsWith(path + '/') ? o.path.slice(path.length + 1).split('/') : null; },
	});
	const open = h('/home/me/p');
	const inside = L && typeof L.inside === 'function' ? L.inside : async () => false;
	check('the open folder itself is refused', await inside(open, h('/home/me/p')));
	check('a folder inside it is refused', await inside(open, h('/home/me/p/sub/deeper')));
	check('a folder beside it is allowed', !(await inside(open, h('/home/me/q'))));
	check('its parent is allowed', !(await inside(open, h('/home/me'))));
	check('no open folder: anything is allowed', !(await inside(null, h('/home/me/p'))));
	check('a handle that cannot answer is refused', await inside({ async isSameEntry() { throw new Error('gone'); } }, h('/x')));
}

if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
console.log('all ok');
