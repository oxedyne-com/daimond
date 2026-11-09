// RAIL-STUCK (UNBLOCK-95): force the IndexedDB connection lost after home renders, as iOS WebKit
// does when a suspended tab resumes, then walk at 390x844: New Chat -> back -> row -> back, and check a write lands.
// LOSE=close  : 'error' + 'close' events fire, every later transaction() throws InvalidStateError (WebKit connectionToServerLost)
// LOSE=throw  : no event, every transaction() throws UnknownError (connection lost, page not told)
// LOSE=hang   : no event, every new transaction never answers (the 'stall' of his 9 Nov trace)
// LOSE=dead   : as throw, and every later open is refused too (only a reload helps); the write check is skipped
// Exit 0 = walk passed, 1 = failed.
import { chromium, webkit } from './pw.mjs';
const URL = process.argv[2] || 'https://daimond.oxedyne.com/';
const ENG = process.env.ENG || 'webkit', LOSE = process.env.LOSE || 'close';
const OUT = (process.env.SHOTS || '/home/jason/.cache/train34') + '/lost_' + ENG + '_' + LOSE + '_';
const b = await (ENG === 'webkit' ? webkit : chromium).launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
	userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
await ctx.addInitScript((LOSE) => {
	const dbs = []; window.__t34dbs = dbs; window.__t34opens = 0;
	const open = IDBFactory.prototype.open;
	IDBFactory.prototype.open = function () { window.__t34opens++;
		if (LOSE === 'dead' && window.__t34dead) { const f = new EventTarget(); f.result = undefined; f.error = new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
			setTimeout(() => { if (f.onerror) f.onerror(new Event('error')); }, 10); return f; }
		const r = open.apply(this, arguments);
		r.addEventListener('success', () => dbs.push(r.result)); return r; };
	const tx = IDBDatabase.prototype.transaction;
	IDBDatabase.prototype.transaction = function () {
		if (this.__lost && LOSE === 'hang') { const st = () => ({ get: rq, getAll: rq, getAllKeys: rq, openCursor: rq, put: rq, add: rq, delete: rq, count: rq, clear: rq, index: st });
			const rq = () => ({}); return { objectStore: st, abort() {}, commit() {}, db: this, mode: arguments[1] || 'readonly' }; }
		if (this.__lost) throw LOSE === 'close'
			? new DOMException('The database connection is closing.', 'InvalidStateError')
			: new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
		return tx.apply(this, arguments); };
	window.__t34lose = () => { let n = 0; if (LOSE === 'none') return 0; window.__t34dead = true; for (const d of dbs) { if (d.__lost) continue; d.__lost = true; n++;
		if (LOSE === 'close') { d.dispatchEvent(new Event('error')); d.dispatchEvent(new Event('close')); } } return n; };
}, LOSE);
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error' && !/401/.test(m.text())) errs.push(m.text().slice(0, 200)); });
p.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 200)));
let ok = true;
const st = async (tag) => { await p.waitForTimeout(2000); await p.screenshot({ path: OUT + tag + '.png' });
	const s = await p.evaluate(() => ({ stack: (document.body.dataset.mpanel || '') + '|' + ((document.querySelector('#stack-back') && getComputedStyle(document.querySelector('#stack-back')).display) || ''),
		rows: document.querySelectorAll('.session-box:not(.diamond-box)').length, opens: window.__t34opens,
		alarm: (document.querySelector('.storage-alarm') || {}).innerText || '' }));
	console.log(tag, JSON.stringify(s).slice(0, 400)); return s; };
const tap = async (loc, tag) => { const bb = await loc.boundingBox().catch(() => null); if (!bb) { console.log(tag, 'NOBOX'); return null; }
	await p.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2); return st(tag); };
await p.goto(URL, { waitUntil: 'load', timeout: 60000 }); await p.waitForTimeout(6000);
await p.getByText('Skip for now').click();
await tap(p.locator('#new-session-btn'), 'seed'); await tap(p.locator('#stack-back'), 'seedback');
const h0 = await st('home0');
console.log('lost', await p.evaluate(() => window.__t34lose()));
await p.waitForTimeout(1500);
// A store that answers nothing is only known silent once the page's wait runs out.
if (LOSE === 'hang') { const ms = await p.evaluate(() => window.DaimondPolicy.storeWaitMs()); console.log('waitMs', ms); await p.waitForTimeout(ms + 3000); }
// The warning must not stand between the person and their chats: it says so, and can be put aside.
const hide = p.locator('.storage-alarm button', { hasText: 'Hide' });
const hideIf = async () => { if (await p.locator('.storage-alarm').isVisible().catch(() => false)) {
	if (await hide.count()) { await hide.first().tap(); console.log('alarm hidden'); } else console.log('alarm stands, no Hide'); } };
await hideIf();
const s1 = await tap(p.locator('#new-session-btn'), 'newchat');
await hideIf();
if (!s1 || !/flex$/.test(s1.stack)) { ok = false; console.log('FAIL newchat did not reach a chat'); }
const s2 = await tap(p.locator('#stack-back'), 'back1');
if (!s2 || !/none$/.test(s2.stack)) { ok = false; console.log('FAIL back did not return home'); }
await hideIf();
const s3 = await tap(p.locator('.session-box:not(.diamond-box)').first(), 'rowtap');
if (!s3 || !/flex$/.test(s3.stack)) { ok = false; console.log('FAIL row tap did not reach a chat'); }
await tap(p.locator('#stack-back'), 'back2');
await p.waitForTimeout(LOSE === 'hang' ? 8000 + await p.evaluate(() => window.DaimondPolicy.storeWaitMs()) : 8000);
// A write lands after the loss: the chats on disk (fresh connection, outside the page's) include the ones made after it.
const disk = await p.evaluate(() => new Promise((res) => { const names = []; indexedDB.databases().then((ds) => {
	const d = ds.find((x) => /^daimond-chats/.test(x.name)); if (!d) return res(-1);
	const r = indexedDB.open(d.name); r.onsuccess = () => { const db = r.result; const t = db.transaction('chats', 'readonly');
		const c = t.objectStore('chats').count(); c.onsuccess = () => { res(c.result); db.close(); }; c.onerror = () => res(-2); };
	r.onerror = () => res(-3); }); }));
const page = await p.evaluate(() => document.querySelectorAll('.session-box:not(.diamond-box)').length);
console.log('disk chats', disk, 'page rows', page, 'home0 rows', h0.rows);
if (LOSE !== 'dead' && !(disk >= page && page > h0.rows)) { ok = false; console.log('FAIL write after loss did not land on disk'); }
console.log('errors', errs.length, JSON.stringify(errs.slice(0, 6)));
console.log(ok ? 'WALK PASS' : 'WALK FAIL');
await b.close(); process.exit(ok ? 0 : 1);
