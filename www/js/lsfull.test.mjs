/* Test -- the chat log's place leaves a full localStorage box without being lost, and a full box
   raises no false "conversations are not being saved".
   Walk tab 42BE89E3: the box held 5,242,691 of 5,242,880 characters, 3,337,518 of them
   `daimond.chatlog.place` (one open turn's view 2.3 MB), while IndexedDB used 454 MB of 11.2 GB.
   Every case drives the page's own install (its source, run in a scope) and its unlock, over the
   REAL durable.js and storewait.js on an in-memory IndexedDB (test/kvidb.mjs).
   FULL     that box: install keeps the place, the unlock moves it whole to the database and
            frees the box, and a synced record fits again
   RELOAD   a reload between install and unlock loses nothing
   REFUSE   a copy the database refused stays in the box and is written at the next need
   UNREAD   a read of the stored places that never answers likewise
   NODB     no database at unlock: the box keeps a bounded place (cursor below every open turn
            and every body still arriving in pieces, the ends, no views), the full box is freed,
            and the database takes it later
   SILENT   an open that never answers loses nothing, and readChatLog and the unlock's reads
            come back within the store's wait
   DROP     a read durable.js answered from the box after the connection dropped is not the
            database's, and the next page reads the stored place
   WIN      of the box's and the database's place, the one further on wins
   GROWTH   saves go to the database only, a write changes only its chat, a refused one is
            written again; with no database the box holds the bounded place
   BOOT     readChatLog and the unlock read the stored places first
   MIGRATE  the unlock writes the box's places to the database and reads the stored ones
   FORGET   a destroyed chat's place leaves the database and the box
   CONTRACT durable.js's update takes an op map only and refuses a function, and no page code
            passes one
   BANNER   a refused box says which store refused and that the conversations are still
            being saved; a refused chat store still says they are not; every warning names
            its store; the console line names its source
   node www/js/lsfull.test.mjs */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ': ' + String(detail).slice(0, 200) : '')); }
}
const { liftSource, loadScript } = await import('../../dev/syncprobe.mjs');
const { kvIdb } = await import(join(HERE, 'test', 'kvidb.mjs'));
const TL = await import(join(HERE, 'page', 'turnlog.js'));

const KEY = 'daimond.chatlog.place';
const BOX_CHARS = 5242880;	// fixed: Chrome's per-origin localStorage quota, in UTF-16 units
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const settle = () => new Promise((r) => setTimeout(r, 50));
const within = (p, ms) => Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r(null), ms))]);

/// A localStorage box that refuses a write past its quota, as Chrome's does.
function box(init) {
	const m = new Map();
	const used = () => { let n = 0; for (const [k, v] of m) n += k.length + v.length; return n; };
	const ls = {
		map: m, used,
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => {
			v = String(v);
			const was = m.has(k) ? k.length + m.get(k).length : 0;
			if (used() - was + k.length + v.length > BOX_CHARS) {
				const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e;
			}
			m.set(k, v);
		},
		removeItem: (k) => { m.delete(k); },
	};
	if (init) ls.setItem(KEY, JSON.stringify(init));
	return ls;
}
const boxed = (ls) => JSON.parse(ls.getItem(KEY) || 'null');

const WAIT = 60;	// ms: the policy's store wait for this arm
const MARK = 'daimond-kv-took';	// durable.js's marker: a connection opened on this device
// A browser with no database: private mode refuses IndexedDB outright. Any other open error on
// a device with no marker and no list of stores is, from PAGESTORE r7, a store that took over.
const PRIVATE = { open: 'error', errName: 'InvalidStateError' };

/// A device's IndexedDB, opened by `how.open` ('ok', 'silent', 'error'), refusing a put while
/// `how.quota` is above 0, and stalled while `how.stall` is set (test/kvidb.mjs). Its tabs wait
/// `how.wait` ms for the store, WAIT unless set.
function device(how) {
	how = Object.assign({ open: 'ok', delay: 0 }, how);
	return { how, idb: kvIdb(how) };
}

/// The page's REAL DaimondDurable (durable.js over storewait.js) in a tab on `dev`, over the
/// box `ls`. `ops` records each update's argument, `answers` its answer.
function tab(dev, ls) {
	const win = {
		indexedDB: dev.idb.api,
		IDBKeyRange: { bound: (lower, upper, lo, uo) => ({ lower, upper, lowerOpen: !!lo, upperOpen: !!uo }) },
		DaimondPolicy: { storeWaitMs: () => dev.how.wait || WAIT, storePieceBytes: () => 65536 },
		localStorage: ls || box(),
	};
	win.window = win;
	loadScript(win, 'storewait.js');
	win.DaimondStoreWait.tell({ stalled() {}, answered() {}, blocked() {} });
	loadScript(win, 'durable.js');
	const D = win.DaimondDurable, update = D.update, ops = [], answers = [];
	D.update = (k, m) => { ops.push(m); const a = update(k, m); answers.push(a); return a; };
	D.ops = ops;
	D.answers = answers;
	return D;
}

/// The places the device's database holds, read by a tab of its own.
async function stored(dev) {
	const was = dev.how.open;
	dev.how.open = 'ok';
	const v = await tab(dev).get(KEY);
	dev.how.open = was;
	return v || {};
}

/// Write `places` into the device's database.
async function seed(dev, places) {
	const ops = {};
	for (const id of Object.keys(places)) ops[id] = { v: places[id] };
	const r = await tab(dev).update(KEY, ops);
	if (!r.ok) throw new Error('seed refused');
}

/// An open turn's view holding `chars` of row bodies, its rows from seq `from`.
function bigView(turn, chars, from) {
	const rows = [];
	for (let i = 0; i * 4000 < chars; i++) rows.push({ seq: (from || 1) + i, mid: 'm' + i, body: 'x'.repeat(4000) });
	return { turn, last: rows.length, state: 'open', rows };
}

const PLACE_FNS = ['saveLogPlace', 'loadLogPlace', 'chatLogEnded', 'readBoxedLogPlaces', 'readLogPlaces', 'forgetLogPlace',
	'readLogsAtBoot', 'readChatLog'];
const HO = readFileSync(join(HERE, 'page', 'handoff.js'), 'utf8');
const INSTALL = HO.slice(HO.indexOf('export function install()'), HO.indexOf('} // page-split: end install'));
const INSTALL_BODY = INSTALL.slice(INSTALL.indexOf('{') + 1);

/// A fresh page over `ls` and `D`: the page's place functions with their own module state,
/// then the page's install run as written. `unlock()` fires the unlock as the page does.
/// `seen` records the cursor each chat's log was read from.
function page(ls, D, chats) {
	const listeners = {}, seen = {};
	const win = {
		DaimondDurable: D, DaimondSync: { readLog() {} }, DaimondSeal: {}, DaimondIdentity: { unwrapBytesAad() {} },
		addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
	};
	const pg = { chats: chats || [], current: null };
	const env = {
		localStorage: ls, window: win, pg, logCursor: TL.logCursor, turnEnded: TL.turnEnded,
		DaimondSync: win.DaimondSync, DaimondIdentity: win.DaimondIdentity,
		ChatStore: { stored: () => [], stalled: () => false, whenAnswers() {} }, loadChatMessages: async (c) => { c._loaded = true; },
		readChat: async (c) => { seen[c.id] = c.logSeq; return { ok: true }; }, transcriptWhole: () => true,
		logArrivals: () => [], noteArrive() {}, onLogRows() {}, lensToolLog() {}, onLogEnd() {}, msgJoin() {},
		isStateTile: () => false, viewMessages: () => [], _progressView: {}, touchChat() {}, persistChats() {},
		renderHistory() {}, followActivity() {}, followsEnd: () => true, ownsChat: () => true, ARRIVE_FRESH_MS: 0,
		t: (k, f) => f, deps: {}, landed() {},
		chats: pg.chats, current: pg.current,	// the lifted source reads the page's `pg.chats` and `pg.current` bare
	};
	const names = Object.keys(env);
	const have = PLACE_FNS.filter((n) => { try { liftSource([n], names); return true; } catch (e) { return false; } });
	const src = liftSource(have, names).src;
	const F = new Function(...names, src + '\nreturn {' + have.join(',') + '};')(...names.map((k) => env[k]));
	for (const n of PLACE_FNS) if (!F[n]) F[n] = () => undefined;	// a page without it fails the checks, not the run
	const own = Object.assign({}, F, { window: win, localStorage: ls, pg, document: { addEventListener() {} }, readerEnded() {} });
	const scope = new Proxy(own, {
		has: (o, k) => typeof k === 'string' && !(k in globalThis),
		get: (o, k) => (typeof k === 'symbol' ? undefined : (k in o ? o[k] : () => {})),
		set: (o, k, v) => { o[k] = v; return true; },
	});
	try { new Function('scope', 'with (scope) {' + INSTALL_BODY + '}')(scope); }
	catch (e) { console.log('install did not run: ' + e.message); }
	// The unlock's read of the places is the one in flight, so awaiting it awaits the unlock's.
	F.unlock = async () => { (listeners['daimond:unlock'] || []).forEach((fn) => fn()); await F.readLogPlaces(); await settle(); };
	F.seen = seen;
	return F;
}
const knows = (F, id, turn) => F.chatLogEnded(id, turn) === true;
const PLACE = { c1: { seq: 9, views: {}, ends: { T1: 'done' } } };

// ── FULL ──
{
	const ls = box(), dev = device();
	const place = { seq: 41, views: { T9: bigView('T9', 2325000, 30) }, ends: { T1: 'done' } };
	const all = { 'cmw7jfhuc-4-vin0a': place, 'cmszd1052-1-qya52': { seq: 12, views: { T4: bigView('T4', 929000, 5) }, ends: {} } };
	ls.setItem(KEY, JSON.stringify(all));
	const rest = 5242691 - ls.used();
	for (let i = 0; rest - i * 100000 > 0; i++) ls.setItem('daimond-filler-' + i, 'y'.repeat(Math.min(100000, rest - i * 100000) - 16));
	check('FULL the fixture is the walk tab\'s box', ls.used() > 5240000 && ls.used() <= BOX_CHARS, String(ls.used()));
	let refused = false;
	try { ls.setItem('daimond-workers', 'z'.repeat(200000)); } catch (e) { refused = e.name === 'QuotaExceededError'; }
	check('FULL a 200 KB record is refused before', refused);
	const F = page(ls, tab(dev, ls));
	const chat = { id: 'cmw7jfhuc-4-vin0a', messages: [] };
	F.loadLogPlace(chat);
	check('FULL this tab knows the place from install', chat.logSeq === 41 && !!chat.logViews.T9 && chat.logEnds.T1 === 'done', String(chat.logSeq));
	check('FULL install keeps the box copy until the database holds it', ls.getItem(KEY) != null);
	await F.unlock();
	const m = await stored(dev);
	check('FULL the unlock moves every place whole to the database', !!(m['cmw7jfhuc-4-vin0a'] && m['cmw7jfhuc-4-vin0a'].views.T9 && m['cmszd1052-1-qya52']), Object.keys(m).join());
	check('FULL the place has left the box', ls.getItem(KEY) == null, 'still ' + String((ls.getItem(KEY) || '').length) + ' chars');
	let landed = false;
	try { ls.setItem('daimond-workers', 'z'.repeat(200000)); landed = true; } catch (e) { landed = false; }
	check('FULL a 200 KB record lands after', landed);
}

// ── RELOAD ──
{
	const ls = box(PLACE), dev = device();
	page(ls, tab(dev, ls));	// install, then the tab reloads at the lock screen
	const F = page(ls, tab(dev, ls));
	await F.unlock();
	const m = await stored(dev);
	check('RELOAD a reload before the unlock: the place is still known', knows(F, 'c1', 'T1'), 'box ' + ls.getItem(KEY) + ', db ' + JSON.stringify(m));
	check('RELOAD the database holds it', !!m.c1);
}

// ── REFUSE (the write refused), UNREAD (the read of the stored places never answers) ──
for (const G of ['REFUSE', 'UNREAD']) {
	const ls = box(PLACE), dev = device();
	if (G === 'REFUSE') dev.how.quota = 1; else dev.how.stall = true;
	const F = page(ls, tab(dev, ls));
	await F.unlock();
	dev.how.stall = false;
	check(G + ' the box keeps the place the database did not take', !!(boxed(ls) || {}).c1, String(ls.getItem(KEY)));
	check(G + ' the database does not hold it', !(await stored(dev)).c1);
	await F.readLogPlaces();	// readChatLog's next need
	check(G + ' the copy is written at the next need', !!(await stored(dev)).c1);
	check(G + ' then the box is freed', ls.getItem(KEY) == null);
	const F2 = page(ls, tab(dev, ls));
	await F2.unlock();
	check(G + ' after a reload the place is still known', knows(F2, 'c1', 'T1'));
}

// ── NODB ──
{
	const open = { seq: 41, views: { T9: bigView('T9', 400000, 30) }, ends: { T1: 'done' } };
	// A body still arriving in pieces from seq 14, no row folded yet; and one from 5 under a row at 12.
	const joining = { seq: 20, views: { T4: { rows: [], joining: [{ head: { seq: 14 } }] } }, ends: {} };
	const under = { seq: 20, views: { T5: { rows: [{ seq: 12 }], joining: [{ head: { seq: 5 } }] } }, ends: {} };
	const ls = box({ c1: open, c2: joining, c3: under }), dev = device(PRIVATE);
	const D = tab(dev, ls);
	const F = page(ls, D);
	await F.unlock();
	const b = boxed(ls) || {};
	check('NODB the box keeps the place', !!b.c1, String(ls.getItem(KEY)).slice(0, 200));
	check('NODB bounded: no views, the ends kept', !!b.c1 && Object.keys(b.c1.views || {}).length === 0 && b.c1.ends.T1 === 'done', JSON.stringify(b.c1));
	check('NODB the cursor is below the open turn\'s first row', !!b.c1 && b.c1.seq === 29, b.c1 && String(b.c1.seq));
	check('NODB the cursor is below a body still arriving in pieces', !!b.c2 && b.c2.seq === 13 && !!b.c3 && b.c3.seq === 4, JSON.stringify([b.c2, b.c3]));
	check('NODB the bounded box is small', ls.used() < 1000, String(ls.used()));
	check('NODB the database is not written', D.ops.length === 0 && dev.idb.data.size === 0, JSON.stringify(D.ops));
	dev.how.open = 'ok';
	const F2 = page(ls, tab(dev, ls));
	await F2.unlock();
	const m = await stored(dev);
	check('NODB the store answering on the next page takes the place', !!m.c1 && knows(F2, 'c1', 'T1'), JSON.stringify(m.c1 || null));
	check('NODB then the box is freed', ls.getItem(KEY) == null);
}

// ── SILENT ──
{
	const ls = box(PLACE), dev = device({ open: 'silent' });
	const F = page(ls, tab(dev, ls));
	const r = await within(F.unlock(), WAIT * 6);
	check('SILENT the unlock\'s read comes back within the store\'s wait', !!r);
	check('SILENT the box keeps the place while the store is silent', !!(boxed(ls) || {}).c1);
	const G = page(box(PLACE), tab(dev));
	const c1 = { id: 'c1', messages: [], _loaded: true };
	const rc = await within(Promise.resolve(G.readChatLog(c1)), WAIT * 6);
	check('SILENT readChatLog comes back within the wait and reads from the boxed cursor', !!rc && G.seen.c1 === 9, rc ? JSON.stringify(G.seen) : 'still waiting');
	const H = page(box(PLACE), tab(dev), [{ id: 'c1', messages: [], _loaded: true }]);
	const rb = await within(Promise.resolve(H.readLogsAtBoot()), WAIT * 6);
	check('SILENT readLogsAtBoot comes back within the wait', !!rb, 'still waiting');
	dev.how.open = 'ok';
	const F2 = page(ls, tab(dev, ls));
	await F2.unlock();
	check('SILENT after a reload the place is still known', knows(F2, 'c1', 'T1') && !!(await stored(dev)).c1);
}

// ── DROP ──
{
	const ls = box(), dev = device();
	await seed(dev, PLACE);
	const D = tab(dev, ls);
	await D.ready();
	// The connection drops after the page found the database live, and will not reopen; the box
	// lost the marker (a full box refuses it), so durable.js answers from the box.
	const get = D.get;
	D.get = (k) => { dev.idb.db.onclose(); ls.removeItem(MARK); Object.assign(dev.how, PRIVATE); D.get = get; return get(k); };
	const F = page(ls, D);
	await F.unlock();
	check('DROP a read answered from the box is not taken for the database\'s', !knows(F, 'c1', 'T1') && (await F.readLogPlaces()) === false);
	dev.how.open = 'ok';
	const F2 = page(ls, tab(dev, ls));
	await F2.unlock();
	check('DROP the next page reads the stored place', knows(F2, 'c1', 'T1'));
}

// ── WIN ──
{
	const ls = box({ c1: { seq: 9, views: {}, ends: {} }, c2: { seq: 30, views: {}, ends: { T2: 'done' } } }), dev = device();
	await seed(dev, { c1: { seq: 20, views: { T3: bigView('T3', 4000, 15) }, ends: {} }, c2: { seq: 10, views: {}, ends: {} } });
	const F = page(ls, tab(dev, ls));
	await F.unlock();
	const m = await stored(dev);
	check('WIN the stored place further on keeps its views', m.c1 && m.c1.seq === 20 && !!m.c1.views.T3, JSON.stringify(m.c1));
	check('WIN the boxed place further on is written', m.c2 && m.c2.seq === 30, JSON.stringify(m.c2));
	const c1 = { id: 'c1', messages: [] };
	F.loadLogPlace(c1);
	check('WIN this tab reads the one further on', c1.logSeq === 20, String(c1.logSeq));
	const dev2 = device();
	await seed(dev2, { c3: { seq: 5, views: {}, ends: {} } });
	const ls2 = box(), D2 = tab(dev2, ls2);
	const F2 = page(ls2, D2);
	await D2.ready();
	dev2.how.quota = 1;
	F2.saveLogPlace({ id: 'c3', messages: [], logSeq: 12, logViews: {}, logEnds: {} });
	await settle();
	await F2.readLogPlaces();
	const c3 = { id: 'c3', messages: [] };
	F2.loadLogPlace(c3);
	check('WIN a place this tab saved is not put back by the older stored one', c3.logSeq === 12, String(c3.logSeq));
}

// ── GROWTH ──
{
	// The store runs the six saves one after another, as IndexedDB does, and each waits its turn
	// inside the store's wait, so the wait covers all six.
	const ls = box(), dev = device({ wait: 2000 }), D = tab(dev, ls);
	const F = page(ls, D);
	await F.unlock();
	for (let i = 0; i < 3; i++) {
		const chat = { id: 'c' + i, messages: [], logSeq: 10 + i, logViews: { ['T' + i]: bigView('T' + i, 2000000) }, logEnds: {} };
		F.saveLogPlace(chat);
		chat.logSeq++;
		F.saveLogPlace(chat);
	}
	await Promise.all(D.answers);
	check('GROWTH the box holds no place', ls.getItem(KEY) == null && ls.used() < 1000, String(ls.used()));
	const m = await stored(dev);
	check('GROWTH every place is in the database', ['c0', 'c1', 'c2'].every((id) => m[id] && m[id].views), Object.keys(m).join());
	const saves = D.ops.slice(1);	// after the unlock's
	check('GROWTH a write changes only its chat', saves.length > 0 && saves.every((o) => o && typeof o === 'object' && Object.keys(o).length === 1), JSON.stringify(saves.map((o) => typeof o === 'object' ? Object.keys(o) : typeof o)));
	const n = D.ops.length;
	F.saveLogPlace({ id: 'c0', messages: [], logSeq: 11, logViews: m.c0 && m.c0.views, logEnds: {} });
	check('GROWTH an unmoved cursor writes nothing', D.ops.length === n, String(D.ops.length - n));
	dev.how.quota = 1;
	const r = { id: 'r1', messages: [], logSeq: 5, logViews: {}, logEnds: { T5: 'done' } };
	F.saveLogPlace(r);
	await settle();
	check('GROWTH a refused save is not in the database', !(await stored(dev)).r1);
	F.saveLogPlace(r);
	await settle();
	check('GROWTH a refused save is written again at the next', !!(await stored(dev)).r1);
	const ls2 = box(), dev2 = device(PRIVATE);
	const F2 = page(ls2, tab(dev2, ls2));
	await F2.unlock();
	F2.saveLogPlace({ id: 'n1', messages: [], logSeq: 3, logViews: { T: bigView('T', 2000000, 2) }, logEnds: { T0: 'done' } });
	const b = (boxed(ls2) || {}).n1;
	check('GROWTH with no database the box holds the bounded place', !!b && b.seq === 1 && !Object.keys(b.views).length && ls2.used() < 1000, String(ls2.used()));
	dev2.how.open = 'ok';
	const F3 = page(ls2, tab(dev2, ls2));
	await F3.unlock();
	const n1 = (await stored(dev2)).n1;
	check('GROWTH the database takes the bounded place when it answers', !!(n1 && n1.seq === 1 && n1.ends.T0 === 'done') && ls2.getItem(KEY) == null, JSON.stringify(n1 || null));
}

// ── BOOT ──
{
	const dev = device();
	await seed(dev, { c1: { seq: 9, views: {}, ends: {} }, open: { seq: 4, views: { T2: { rows: [] } }, ends: {} } });
	const F = page(box(), tab(dev));
	const c1 = { id: 'c1', messages: [], _loaded: true };
	if (F.readChatLog) await F.readChatLog(c1);
	check('BOOT readChatLog reads from the stored cursor', F.seen.c1 === 9, String(F.seen.c1));
	const chats = [{ id: 'open', messages: [], _loaded: true }, { id: 'idle', messages: [], _loaded: true }];
	const G = page(box(), tab(dev), chats);
	await G.unlock();
	check('BOOT the unlock reads a chat whose open turn only the database names', G.seen.open === 4, JSON.stringify(G.seen));
}

// ── MIGRATE ──
{
	const ls = box({ boxed: { seq: 9, views: {}, ends: { T2: 'stopped' } } }), dev = device();
	await seed(dev, { old: { seq: 5, views: {}, ends: { T7: 'done' } } });
	const F = page(ls, tab(dev, ls));
	await F.unlock();
	const m = await stored(dev);
	check('MIGRATE the box\'s place is written to the database', !!(m.boxed && m.boxed.seq === 9), JSON.stringify(m));
	check('MIGRATE a stored place is read', F.chatLogEnded('old', 'T7') === true);
	check('MIGRATE the box keeps nothing', ls.getItem(KEY) == null);
}

// ── FORGET ──
{
	const dev = device(), ls = box({ gone: { seq: 2, views: {}, ends: {} }, kept: { seq: 3, views: {}, ends: {} } });
	await seed(dev, { gone: { seq: 2, views: {}, ends: {} } });
	const D = tab(dev, ls);
	const F = page(ls, D);
	await D.ready();
	F.saveLogPlace({ id: 'gone', messages: [], logSeq: 4, logViews: {}, logEnds: { T1: 'done' } });
	await settle();
	if (F.forgetLogPlace) F.forgetLogPlace('gone');
	await settle();
	const m = await stored(dev);
	check('FORGET a destroyed chat\'s place leaves', !('gone' in m) && F.chatLogEnded('gone', 'T1') === false, JSON.stringify(m));
	check('FORGET and leaves the box', !('gone' in (boxed(ls) || {})) && !!(boxed(ls) || {}).kept, String(ls.getItem(KEY)));
	const chats = readFileSync(join(HERE, 'page', 'chats.js'), 'utf8');
	const body = chats.slice(chats.indexOf('export async function destroyChat'), chats.indexOf('/// Delete a chat.'));
	check('FORGET destroyChat forgets the place', /forgetLogPlace\(id\)/.test(body));
}

// ── CONTRACT: one update form; the other is refused, so a missed switch leaves the place owed ──
{
	const dev = device();
	await seed(dev, PLACE);
	const D = tab(dev);
	const r = await D.update(KEY, () => ({ c9: { seq: 1, views: {}, ends: {} } }));
	const m = await stored(dev);
	check('CONTRACT durable.js refuses a function, and the stored map is unchanged', r.ok === false && !!m.c1 && !m.c9, JSON.stringify(r));
	const bare = [];
	for (const f of readdirSync(join(HERE, 'page')).filter((n) => n.endsWith('.js'))) {
		const src = readFileSync(join(HERE, 'page', f), 'utf8');
		if (/\.update\(\s*[^,()]+,\s*(function\b|\([^)]*\)\s*=>|\w+\s*=>)/.test(src)) bare.push(f);
	}
	check('CONTRACT no page code passes a function to update', !bare.length, bare.join(' '));
}

// ── BANNER ──
function el(tag) {
	const e = { tag, className: '', textContent: '', style: {}, children: [], parentNode: null,
		setAttribute() {}, addEventListener() {},
		appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
		removeChild(c) { e.children = e.children.filter((x) => x !== c); c.parentNode = null; },
		querySelector(sel) {
			const cls = sel.replace(/^\./, '');
			for (const c of e.children) {
				if (c.className.split(' ').includes(cls)) return c;
				const d = c.querySelector(sel); if (d) return d;
			}
			return null;
		} };
	return e;
}
{
	const doc = { body: el('body'), createElement: el };
	const win = { DaimondDurable: { durable: () => true } };
	const tOr = (k, f, v) => String(f).replace(/\{(\w+)\}/g, (_, n) => (v && n in v ? v[n] : '{' + n + '}'));
	let A = null;
	try {
		A = new Function('document', 'window', 'tOr', 'downloadChatsNow', 'ChatStore', [
			liftSource(['storageAlarm', 'storageAlarmClear', 'noteCloudIndexStuck'], ['document', 'window', 'tOr', 'downloadChatsNow', 'ChatStore']).src,
			'return { storageAlarm, storageAlarmClear, noteCloudIndexStuck };',
		].join('\n'))(doc, win, tOr, () => {}, { retry() {} });
	} catch (e) { console.log(e.message); }
	check('BANNER storageAlarm lifts', !!A);
	if (A) {
		const box = () => doc.body.children[0];
		const text = () => { const b = box(); return b ? ['head', 'why', 'advice'].map((c) => (b.querySelector('.storage-alarm-' + c) || {}).textContent || '') : []; };
		const cs = readFileSync(join(HERE, 'page', 'chatstore.js'), 'utf8');
		const owedWhy = (/tOr\('store\.records_owed',\s*('(?:[^'\\]|\\.)*')\s*\+\s*('(?:[^'\\]|\\.)*')/.exec(cs) || []).slice(1, 3).map((s) => eval(s)).join('');
		A.storageAlarm(owedWhy, 'owed');
		let [head, why, advice] = text();
		check('BANNER a refused box does not say the conversations are unsaved', !!head && !/conversations are not being saved/i.test(head), head);
		check('BANNER it names local storage', /localStorage/.test(why), why);
		check('BANNER it says the conversations are still saved', /conversations are still being saved/i.test(advice), advice);
		A.noteCloudIndexStuck();
		[head, why] = text();
		check('BANNER the cloud index names the database that refused', /IndexedDB/.test(why) && /sync is paused/i.test(head), head + ' | ' + why);
		A.storageAlarm('this browser’s database for this site (IndexedDB) has no room left');
		[head] = text();
		check('BANNER a refused chat store says the conversations are unsaved', /conversations are not being saved/i.test(head), head);
		A.storageAlarmClear('store');
		[head, , advice] = text();
		check('BANNER the chat store cleared, the sync words again', /sync is paused/i.test(head) && /still being saved/i.test(advice), head + ' | ' + advice);
		check('BANNER the en string carries the store', /localStorage/.test(readFileSync(join(HERE, '..', 'i18n', 'en.js'), 'utf8').match(/'store\.records_owed':.*$/m)[0]));
		const said = [], cerr = console.error;
		console.error = (m) => said.push(String(m));
		A.storageAlarm(owedWhy, 'owed');
		A.storageAlarm('this browser’s database for this site (IndexedDB) has no room left', 'files');
		console.error = cerr;
		check('BANNER the console line names the source that refused', /\(owed\)/.test(said[0] || '') && /\(files\)/.test(said[1] || ''), said.join(' | '));
		const bare = [];
		for (const f of ['agentspanel', 'chats', 'chatstore', 'parcel_collect', 'send']) {
			const src = readFileSync(join(HERE, 'page', f + '.js'), 'utf8');
			const re = /tOr\('store\.(full|delete_unrecorded|taint_unrecorded)'/g;
			let m, n = 0;
			while ((m = re.exec(src))) { n++; if (!/\{ store: /.test(src.slice(m.index, m.index + 400))) bare.push(f + ':' + m[1]); }
			if (!n && f !== 'send') bare.push(f + ': none');
		}
		check('BANNER every refusal warning names the store that refused', !bare.length, bare.join(' '));
	}
}

console.log(failures ? failures + ' failed' : 'lsfull: all passed');
process.exit(failures ? 1 : 0);
