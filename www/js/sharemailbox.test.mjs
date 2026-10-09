/* ============================================================
   Test — a large relayed share must not wedge the mailbox (post.js).
   ------------------------------------------------------------
   THE DEFECT (U0, testnet). A share over about 1 MiB arrives through the relay and
   `keepShare` held its sealed envelope WHOLE inside the wrapped record in localStorage,
   which is ~5 MiB for the whole origin and shared with every other tenant. The record
   could not be written, `save()` answered false, `ackThrough` refused to ack, and the
   relay re-sent the same row for ever: no later message or gift reached the device.

   THE FIX. The envelope leaves the record. `save()` shelves it in DaimondDurable
   (IndexedDB, committed BEFORE the record is written and so before any ack) and the
   record keeps metadata plus `envAt:'idb'`. `addShare` reads it back on demand and
   prunes it only after the `taken` save has landed. A failed mailbox write raises a
   banner. The parcel never carries an envelope.

   Drives the REAL collect() / round() / ackThrough(), the REAL durable.js over a fake
   async IndexedDB, and a localStorage with an ORIGIN-WIDE quota that throws exactly as
   the real one does when the sum of every tenant's bytes passes it.

   Proven able to fail:
     node www/js/sharemailbox.test.mjs --break nomig         # no shelving in save/read
     node www/js/sharemailbox.test.mjs --break noprune       # taken envelope never pruned
     node www/js/sharemailbox.test.mjs --break prunefirst    # pruned before the save lands
     node www/js/sharemailbox.test.mjs --break parcelenv     # envelope rides the parcel
     node www/js/sharemailbox.test.mjs --break unlisted      # evidence-less share is listed
     node www/js/sharemailbox.test.mjs --break nowedged      # no banner on a failed write
     node www/js/sharemailbox.test.mjs                       # clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['nomig', 'noprune', 'prunefirst', 'parcelenv', 'unlisted', 'nowedged'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await fn()) return true; await sleep(5); }
	return !!(await fn());
}

const MiB   = 1024 * 1024;
const QUOTA = 2 * MiB;			// the origin's box, scaled down; other tenants hold FILLER of it
const FILLER = 1 * MiB;
const BIG   = 'SHARE:' + 'B'.repeat(Math.floor(1.5 * MiB));		// ~1.5 MiB sealed share
const SMALL = 'SHARE:' + 's'.repeat(900);
const REC_V = 5;

/// localStorage with ONE quota across every key, as the browser keeps it.
function makeLocal() {
	const m = new Map();
	const size = (k, v) => k.length + v.length;
	const used = () => { let n = 0; for (const [k, v] of m) n += size(k, v); return n; };
	const ctl = { failRecord: 0 };
	const api = {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => {
			v = String(v);
			if (k === 'daimond-post' && ctl.failRecord > 0) {
				ctl.failRecord--;
				throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
			}
			const old = m.has(k) ? size(k, m.get(k)) : 0;
			if (used() - old + size(k, v) > QUOTA) {
				throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
			}
			m.set(k, v);
		},
		removeItem: (k) => { m.delete(k); },
	};
	return { m, used, api, ctl };
}

/// An async IndexedDB, from quotamanifest.test.mjs: one store over a Map, transactions
/// that complete a tick later, and `setFailWrites` to make every put abort.
function makeIndexedDB() {
	const dbs = new Map();
	let failWrites = false;
	const soon = (fn) => setTimeout(fn, 0);
	function makeDb(name) {
		if (!dbs.has(name)) dbs.set(name, new Map());
		const stores = dbs.get(name);
		return {
			objectStoreNames: { contains: (s) => stores.has(s) },
			createObjectStore: (s) => { stores.set(s, new Map()); return {}; },
			close: () => {},
			transaction: (sname) => {
				const data = stores.get(sname);
				const tx = { oncomplete: null, onerror: null, onabort: null, objectStore: null };
				let open = 0, over = false;
				const request = (work) => {
					const rq = { onsuccess: null, onerror: null, result: undefined };
					open++;
					soon(() => {
						if (over) return;
						open--;
						if (work(rq) === false) {
							over = true;
							if (rq.onerror) rq.onerror();
							if (tx.onabort) tx.onabort();
							return;
						}
						if (rq.onsuccess) rq.onsuccess();
						soon(() => { if (!over && open === 0) { over = true; if (tx.oncomplete) tx.oncomplete(); } });
					});
					return rq;
				};
				const os = {
					get:    (k) => request((rq) => { rq.result = data.has(k) ? data.get(k) : undefined; }),
					put:    (v, k) => request(() => { if (failWrites) return false; data.set(k, v); }),
					delete: (k) => request(() => { data.delete(k); }),
				};
				tx.objectStore = () => os;
				return tx;
			},
		};
	}
	return {
		dbs,
		api: {
			open: (name) => {
				const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
				soon(() => {
					const fresh = !dbs.has(name) || dbs.get(name).size === 0;
					req.result = makeDb(name);
					if (fresh && req.onupgradeneeded) req.onupgradeneeded();
					if (req.onsuccess) req.onsuccess();
				});
				return req;
			},
		},
		setFailWrites: (v) => { failWrites = v; },
	};
}

/// The relay box: `?since=X` rows above X; `?op=ack` drops through `through`.
function makeBox(rows) {
	const box = {
		rows,
		since: (x) => box.rows.filter((r) => (r.seq | 0) > (x | 0)),
		dropThrough: (t) => { box.rows = box.rows.filter((r) => (r.seq | 0) > (t | 0)); },
	};
	return box;
}

/// A DOM stub that remembers what was drawn, so the banner can be looked for.
function makeDom() {
	const mk = () => {
		const e = { className: '', textContent: '', dataset: {}, style: {}, children: [], childNodes: [],
			setAttribute() {}, addEventListener() {}, removeEventListener() {}, classList: { add() {}, remove() {}, toggle() {} },
			getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
			querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
			insertBefore: (c) => c, removeChild: (c) => c, focus() {}, scrollIntoView() {} };
		e.appendChild = (c) => { e.children.push(c); return c; };
		e.childNodes = e.children;
		return e;
	};
	const host = mk();
	const drawn = (n, cls) => (n.className.split(' ').includes(cls)) || n.children.some((c) => drawn(c, cls));
	return {
		host,
		has: (cls) => drawn(host, cls),
		document: {
			readyState: 'complete', visibilityState: 'hidden', addEventListener() {},
			createElement: mk,
			createTextNode: (t) => Object.assign(mk(), { textContent: String(t) }),
			createDocumentFragment: mk,
			querySelector: () => { host.children.length = 0; return host; },
			querySelectorAll: () => [], getElementById: () => null,
		},
	};
}

/// The row stub. `openEnvelope` is the unseal path this suite is not about, so a SHARE:
/// envelope answers the refusal `takeRow` reads a gift from, and MSG: a message.
const STUB = `
		if (String(b64).slice(0, 6) === 'SHARE:') {
			var __e = new Error('That is not a message; it is a share.');
			__e.kind = 'share';
			__e.reading = { share: { name: 'Gift ' + String(expectAddr), note: 'n', code: false,
				files: [{ bytes: String(b64).length }] }, fingerprint: 'fp-' + String(expectAddr), time: 1700000000000 };
			throw __e;
		}
		if (String(b64).slice(0, 4) === 'MSG:') {
			return { kind: 'post', address: String(expectAddr), author: '00'.repeat(32), fingerprint: 'fp',
				post: { body: 'hello', to: '' }, time: 1700000000000, art: new Uint8Array([1, 2]), ck: new Uint8Array([3]) };
		}
`;

/// Replace `from` by `to` in the post.js source, refusing a miss.
function patch(src, from, to, why) {
	if (src.indexOf(from) < 0) throw new Error('break target not found: ' + why);
	return src.replace(from, to);
}

function makeTab(box, o) {
	o = o || {};
	const local = o.local || makeLocal();
	const idb = o.idb || makeIndexedDB();
	const dom = makeDom();
	const opened = [];
	const bus = new Map();
	const win = {
		addEventListener: (t, fn) => { if (!bus.has(t)) bus.set(t, []); bus.get(t).push(fn); },
		removeEventListener() {}, dispatchEvent: () => true,
		location: { origin: 'https://example.test', href: 'https://example.test/' },
		navigator: { onLine: true },
		localStorage: local.api,
		indexedDB: idb.api,
		DaimondIdentity: {
			isUnlocked: () => true, deviceId: () => 'dev-self',
			publicKeyB64url: () => 'pub-self', publicKeyRaw: async () => new Uint8Array(32),
			sealingKeyRaw: () => null,
			wrap: async (s) => s, unwrap: async (s) => s,
		},
		DaimondGateway: { clientApi: () => 9, gwFetch: (url, init) => {
			const params = new URLSearchParams(String(url).split('?')[1] || '');
			if (params.get('op') === 'ack') {
				box.dropThrough(JSON.parse(init.body).through | 0);
				return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
			}
			if (params.has('since')) {
				const since = Number(params.get('since'));
				return Promise.resolve({ status: 200,
					json: () => Promise.resolve({ ok: true, rows: box.since(since), more: false, seq: 0 }) });
			}
			return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
		} },
		DaimondShare: {
			open: async (env, addr) => { opened.push({ env, addr }); return { free() {} }; },
			accept: async () => ({ ok: true }),
		},
		DEBUG_SHARE: { event: () => {} },
	};
	win.window = win;

	const run = (src) => {
		const fn = new Function('window', 'document', 'localStorage', 'setTimeout', 'clearTimeout',
			'setInterval', 'clearInterval',
			'with (window) {\n' + src + '\n}');
		fn(win, dom.document, local.api, setTimeout, clearTimeout, () => 0, () => {});
	};
	run(readFileSync(join(HERE, 'durable.js'), 'utf8'));

	let src = readFileSync(join(HERE, 'post.js'), 'utf8');
	src = patch(src, 'async function openEnvelope(b64, expectAddr) {\n',
		'async function openEnvelope(b64, expectAddr) {' + STUB, 'openEnvelope');
	if (o.breakArm) src = o.breakArm(src);
	run(src);
	return { win, local, idb, dom, opened, box, P: () => win.DaimondPost, D: () => win.DaimondDurable };
}

/// The plaintext record in storage (pass-through wrap), or null.
function stored(local) {
	const raw = local.m.get('daimond-post');
	if (!raw) return null;
	try { return JSON.parse(raw); } catch (e) { return null; }
}

/// A share record as `keepShare` writes one, for the seeded and adopted cases.
const share = (addr, env, over) => Object.assign({ addr, from: 'sender', fp: 'fp', name: 'Gift', note: '',
	code: false, n: 1, bytes: env ? env.length : 0, ts: 1700000000000, seq: 1, taken: 0, hidden: 0 },
	env ? { env } : {}, over || {});

/// The box's other tenants: ledger, trash, caches. They hold FILLER of the origin's quota.
function crowd(local) { local.m.set('other-tenants', 'x'.repeat(FILLER)); }

/// The patches behind each --break arm.
function arm(name) {
	return (src) => {
		if (name === 'nomig') {
			src = patch(src, 'if (hasInlineEnv(obj)) await shelve(obj);', '/* BROKEN: no shelving at the save door */', 'save-door shelving');
		}
		if (name === 'noprune') {
			src = patch(src, 'await DaimondDurable.del(ENV_KEY + String(addr));', '/* BROKEN: no prune */', 'prune');
		}
		if (name === 'prunefirst') {
			// The store entry goes before the `taken` save, so a failed save leaves a record
			// with nothing to Add from.
			src = patch(src, 'rec.taken = 1;\n', 'rec.taken = 1;\n\t\ttry { await DaimondDurable.del(ENV_KEY + String(addr)); } catch (e) { /* broken */ }\n', 'prune order');
		}
		if (name === 'parcelenv') {
			src = patch(src, 'function stripEnv(rec) {', 'function stripEnv(rec) { return rec; /* BROKEN */', 'parcel strip');
		}
		if (name === 'unlisted') {
			src = patch(src, '.filter(function (s2) { return s2 && !s2.taken && !s2.hidden && (s2.env || s2.envAt); })',
				'.filter(function (s2) { return s2 && !s2.taken && !s2.hidden; })', 'evidence filter');
		}
		if (name === 'nowedged') {
			src = patch(src, 'if (okSaved) flagWedged(false); else if (boxFull) flagWedged(true);', '/* BROKEN: no banner */', 'banner');
		}
		return src;
	};
}

async function main() {
	console.log('share mailbox — a 1.5 MiB relayed share under a quota-limited box\n');

	// ── 1. The wedge, driven through the real collect ────────────────────
	{
		console.log('1. relayed 1.5 MiB share, then a small share and a message');
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'big1', envelope: BIG, from_pub: 'sender' }]);
		const tab = makeTab(box, { breakArm: BREAK ? arm(BREAK) : null });
		crowd(tab.local);
		await sleep(10);
		const P = tab.P();
		const D = tab.D();
		check('the module loaded', !!P && typeof P.round === 'function');
		check('the record with the inline envelope would NOT fit the box',
			FILLER + BIG.length > QUOTA);

		const r1 = await P.round();
		check('1a. the round succeeded', r1.ok === true, JSON.stringify(r1));
		check('1b. the relay was told to let the big row go', r1.acked === 1 && box.rows.length === 0,
			'acked=' + r1.acked + ' rows left=' + box.rows.length + ' why=' + r1.why);
		const rec1 = stored(tab.local);
		check('1c. the record is on disk with the share listed',
			!!rec1 && !!rec1.shares && !!rec1.shares.big1, rec1 ? Object.keys(rec1.shares || {}).join(',') : 'no record');
		check('1d. and the envelope has left the record',
			!!rec1 && !!rec1.shares && !!rec1.shares.big1 && rec1.shares.big1.env === undefined
			&& rec1.shares.big1.envAt === 'idb');
		check('1e. the envelope is in IndexedDB, whole', (await D.get('shenv/big1')) === BIG);
		check('1f. the share is on the tray', P.shares().length === 1);
		check('1g. no banner', (typeof P.wedged === 'function' ? P.wedged() : false) === false);

		box.rows.push({ seq: 2, kind: 'post', addr: 'small2', envelope: SMALL, from_pub: 'sender' });
		box.rows.push({ seq: 3, kind: 'post', addr: 'msg3', envelope: 'MSG:hi', from_pub: 'sender' });
		const r2 = await P.round();
		check('1h. the next round collects both and acks the top', r2.ok === true && r2.acked === 3
			&& box.rows.length === 0, JSON.stringify(r2) + ' rows left=' + box.rows.length);
		check('1i. the mailbox still works: two gifts and a message', P.shares().length === 2 && P.list().length === 1,
			'shares=' + P.shares().length + ' list=' + P.list().length);
		check('1j. the small envelope is shelved too', (await D.get('shenv/small2')) === SMALL);

		const a = await P.addShare('big1');
		check('1k. Add hands the exact 1.5 MiB envelope to the opener', a && a.ok === true
			&& tab.opened.length === 1 && tab.opened[0].env === BIG && tab.opened[0].addr === 'big1',
			JSON.stringify(a) + ' opened=' + tab.opened.length);
		const rec2 = stored(tab.local);
		const sh = rec2 && rec2.shares && rec2.shares.big1;
		check('1l. the taken share is marked and keeps no envelope',
			!!sh && sh.taken === 1 && sh.env === undefined && sh.envAt === undefined, JSON.stringify(sh && { t: sh.taken, e: sh.envAt }));
		check('1m. and IndexedDB no longer holds it', (await D.get('shenv/big1')) === null);
		check('1n. the other gift is untouched', (await D.get('shenv/small2')) === SMALL && P.shares().length === 1);
	}

	// ── 2. A device already wedged heals on read ─────────────────────────
	{
		console.log('\n2. a legacy record with a 1.5 MiB inline envelope heals on its first save');
		const box = makeBox([]);
		const tab = makeTab(box, { breakArm: BREAK ? arm(BREAK) : null });
		crowd(tab.local);
		const legacy = { v: REC_V, through: 5, seen: 5, acked: 5, tries: 0, holds: [], msgs: {}, notes: {}, groups: {},
			shares: { old1: share('old1', BIG), done1: share('done1', BIG, { taken: 1 }) },
			feed: { since: 0, read: {}, new: {} } };
		tab.local.m.set('daimond-post', JSON.stringify(legacy));		// written when it fitted
		check('the legacy record is over the quota already', tab.local.used() > QUOTA);
		await sleep(10);
		const P = tab.P(), D = tab.D();
		// THE FIRST SAVE HEALS IT, and a collect always saves. No write is made at read time:
		// a tab that wrote a record it had only just read could lay an older one over a sibling's.
		await P.round();
		const rec = stored(tab.local);
		check('2a. the record shrank under the quota', tab.local.used() <= QUOTA, 'used=' + tab.local.used());
		check('2b. the waiting share kept its place, its envelope moved',
			!!rec && rec.shares.old1.env === undefined && rec.shares.old1.envAt === 'idb' && (await D.get('shenv/old1')) === BIG);
		check('2c. a taken share simply loses its envelope',
			!!rec && rec.shares.done1.env === undefined && rec.shares.done1.envAt === undefined
			&& (await D.get('shenv/done1')) === null);
		check('2d. the tray lists the waiting share', P.shares().length === 1 && P.shares()[0].addr === 'old1');
	}

	// ── 3. An older build's device pushes an inline envelope ─────────────
	{
		console.log('\n3. mixed versions: a parcel from an older build carries a 1.5 MiB envelope');
		const box = makeBox([]);
		const tab = makeTab(box, { breakArm: BREAK ? arm(BREAK) : null });
		crowd(tab.local);
		await sleep(10);
		const P = tab.P(), D = tab.D();
		await P.hideShare('nothing');
		const moved = P.adopt({ v: REC_V, msgs: {}, notes: {}, groups: {}, shares: { far1: share('far1', BIG) } });
		check('3a. the parcel moved this device', moved === true);
		await until(async () => { const r = stored(tab.local); return r && r.shares && r.shares.far1; });
		const rec = stored(tab.local);
		check('3b. the record landed under the quota', !!rec && !!rec.shares.far1 && tab.local.used() <= QUOTA,
			'used=' + tab.local.used());
		check('3c. the inline envelope was shelved', !!rec && rec.shares.far1.env === undefined
			&& rec.shares.far1.envAt === 'idb' && (await D.get('shenv/far1')) === BIG);
		check('3d. and it can be Added from here', P.shares().length === 1);
	}

	// ── 4. The parcel, and a gift this device holds no evidence for ──────
	{
		console.log('\n4. the parcel carries no envelope; an evidence-less share is not offered');
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'held1', envelope: SMALL, from_pub: 'sender' }]);
		const tab = makeTab(box, { breakArm: BREAK ? arm(BREAK) : null });
		await sleep(10);
		const P = tab.P();
		await P.round();
		const snap = P.snapshot();
		const refs = await P.snapshotRefs();
		const clean = (x) => !!x && Object.keys(x.shares).length === 1
			&& Object.keys(x.shares).every((k) => x.shares[k].env === undefined && x.shares[k].envAt === undefined);
		check('4a. snapshot() shares carry no env or envAt', clean(snap), JSON.stringify(snap && Object.keys(snap.shares.held1 || {})));
		check('4b. snapshotRefs() shares carry no env or envAt', clean(refs));
		check('4c. the local record still knows where its envelope is', P.shares().length === 1);
		P.adopt({ v: REC_V, msgs: {}, notes: {}, groups: {}, shares: { nowhere: share('nowhere', null) } });
		await sleep(30);
		check('4d. a share adopted with no evidence is not offered', P.shares().length === 1
			&& P.shares()[0].addr === 'held1', 'listed=' + P.shares().map((s) => s.addr).join(','));
	}

	// ── 5. The failure arm: IndexedDB refuses the envelope ───────────────
	{
		console.log('\n5. IndexedDB refuses the write: nothing is acked, the banner shows, a retry heals');
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'big5', envelope: BIG, from_pub: 'sender' }]);
		const tab = makeTab(box, { breakArm: BREAK ? arm(BREAK) : null });
		crowd(tab.local);
		await sleep(10);
		const P = tab.P(), D = tab.D();
		tab.idb.setFailWrites(true);
		const r1 = await P.round();
		check('5a. no ack went out, the relay still holds the gift', box.rows.length === 1 && (r1.acked | 0) === 0,
			JSON.stringify(r1) + ' rows=' + box.rows.length);
		check('5b. the wedge is flagged', typeof P.wedged === 'function' && P.wedged() === true);
		check('5c. the banner is drawn', tab.dom.has('post-bad'));
		tab.idb.setFailWrites(false);
		const r2 = await P.round();
		check('5d. a retry shelves it, saves and acks', r2.ok === true && r2.acked === 1 && box.rows.length === 0,
			JSON.stringify(r2) + ' rows=' + box.rows.length);
		check('5e. the banner is lowered', typeof P.wedged === 'function' && P.wedged() === false && !tab.dom.has('post-bad'));
		check('5f. the envelope is safe in IndexedDB', (await D.get('shenv/big5')) === BIG);
	}

	// ── 6. Add whose save fails keeps the envelope ───────────────────────
	{
		console.log('\n6. a failed taken-save keeps the envelope, so Add can be pressed again');
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'g6', envelope: SMALL, from_pub: 'sender' }]);
		const tab = makeTab(box, { breakArm: BREAK ? arm(BREAK) : null });
		await sleep(10);
		const P = tab.P(), D = tab.D();
		await P.round();
		tab.local.ctl.failRecord = 1;
		await P.addShare('g6');
		check('6a. the envelope is still in IndexedDB after the failed save', (await D.get('shenv/g6')) === SMALL);
		const a2 = await P.addShare('g6');
		check('6b. a second Add opens it again', a2 && a2.ok === true && tab.opened.length === 2
			&& tab.opened[1].env === SMALL, 'opened=' + tab.opened.length);
		await sleep(30);
		check('6c. and now the envelope is pruned', (await D.get('shenv/g6')) === null);
	}

	// ── 7. No IndexedDB: the old behaviour, and the banner is the tell ───
	{
		console.log('\n7. a device with no IndexedDB keeps the envelope inline and says so when it cannot save');
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'big7', envelope: BIG, from_pub: 'sender' }]);
		const idb = makeIndexedDB();
		idb.api.open = () => { const rq = { onerror: null }; setTimeout(() => rq.onerror && rq.onerror(), 0); return rq; };
		const tab = makeTab(box, { idb, breakArm: BREAK ? arm(BREAK) : null });
		crowd(tab.local);
		await sleep(10);
		const P = tab.P();
		const r = await P.round();
		check('7a. nothing acked: the gift stays on the relay', box.rows.length === 1 && (r.acked | 0) === 0);
		check('7b. the banner shows', typeof P.wedged === 'function' && P.wedged() === true && tab.dom.has('post-bad'));
		check('7c. nothing was written into the box as a fallback key',
			![...tab.local.m.keys()].some((k) => k.startsWith('shenv/')));
	}

	console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
	if (BREAK) {
		// A broken arm must fail something: the exit is inverted so the gate proves it can fail.
		if (failures) { console.log('break arm ' + BREAK + ' failed as it should'); process.exit(0); }
		console.log('break arm ' + BREAK + ' did NOT fail anything: the gate cannot see this fix');
		process.exit(1);
	}
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
