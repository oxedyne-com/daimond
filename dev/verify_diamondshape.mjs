// gateway: live
// verify_diamondshape.mjs -- a Diamond the phone offloads and the desktop carries inline ends in ONE shape on both
// devices and on the head, without a reload (the shape law, F3; specs/daimond_sync_f1_log.md section 10).
// A computer and a phone, one tab each.
//
// A phone's inline room is a quarter of a desktop's (256 kB against 1 MB), so past the phone's first few ~30 kB
// Diamonds the rest ride as a reference from the phone and inline from the desktop. Equal stamps keep what is here,
// so neither device ever took the other's shape; each stood stable on its own last push and the head was whichever
// pushed last. Only a page reload (which makes every device push once) moved it. The law: at an equal `touched` a
// reference stands over inline, one way and never back until `touched` moves (daimond.js, `diamondRefStands`).
//
//   A   the desktop makes nine ~30 kB Diamonds; the phone takes them and offloads the ones past its room. After
//       calm, every Diamond has the same shape on the desktop, the phone and the head (a reference carrying the
//       same manifest key), the head stays put over further rounds, and the phone's ticks (a new tiny Diamond
//       a round) cost the desktop no chunk read.
//   B   A, then the desktop edits one of the references: its `touched` moves, so the Diamond is a candidate for
//       inline again, travels, and everything settles to one shape once more -- and the edit lands on the phone.
//
//   node dev/verify_diamondshape.mjs [--arms=A,B]
//   node dev/verify_diamondshape.mjs --break nosticky   # a reference may go back to inline at its stamp
//   node dev/verify_diamondshape.mjs --break noadopt    # an equal-stamp reference is not adopted
//   node dev/verify_diamondshape.mjs --break noshape    # both: the build before F3 (05f63268)
import { open, signInAs, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const STICKY = { file: 'js/daimond.js', find: 'return diamondRefStands(diamondManifest(d.id), diamondStamp(d));', with: 'return false;' };
const ADOPT  = { file: 'js/daimond.js', find: '} else if (diamondAdoptsRef(r, diamondManifest(r.id), diamondStamp(mine))) {', with: '} else if (false) {' };
const BREAKS = { nosticky: [STICKY], noadopt: [ADOPT], noshape: [STICKY, ADOPT] };
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'`); process.exit(2); }
const WWW = new URL('../www', import.meta.url).pathname;
const PATCHED = new Map();
for (const spec of (BREAKS[BREAK] || [])) {
	const s0 = PATCHED.get(spec.file) ?? fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	if (s0.split(spec.find).length !== 2) { console.error(`break '${BREAK}': anchor not unique in ${spec.file}`); process.exit(2); }
	PATCHED.set(spec.file, s0.replace(spec.find, spec.with));
}
const route = PATCHED.size ? async (page) => {
	for (const [f, body] of PATCHED) await page.route('**/' + f, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
} : null;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

const ARMS = ((process.argv.find((a) => a.startsWith('--arms=')) || '--arms=A,B').slice(7)).split(',').filter(Boolean);
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { ok: 0, bad: [] };
const ctl = (arm, pass, what, detail) => { if (pass) tally.ok++; else tally.bad.push(arm);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${arm}  ${what}${detail ? ' -- ' + String(detail).slice(0, 1400) : ''}`); };
const note = (t) => console.log('  note ' + String(t).slice(0, 3000));

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& window.DaimondCloud && DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
async function paired(lead, name, label, extra = {}) {
	const d = await open({ name: name + '-' + label, signIn: false, connect: false, defaults: false,
		profile: scratch('pw', name + '-' + label), route, ...extra });
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, name);
	await ready(d);
	await sleep(2000);
	return d;
}
const push = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	const r = window.DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push();
	return r && typeof r === 'object' ? { ok: r.ok, version: r.version } : r;
}).then(async (r) => { await sleep(400); return r; }).catch((e) => 'threw ' + e);
const pull = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	return DaimondSync.pull();
}).then(() => sleep(400)).catch(() => {});

/// What the device would send now, per Diamond id: inline, or the manifest key it names.
const shapes = (s) => s.page.evaluate(async () => {
	const p = await DaimondSync.parcel();
	const out = {};
	for (const e of (p.diamonds || [])) out[e.id] = e.dataRef ? 'ref:' + String(e.dataRef.key).slice(0, 12) : (e.data != null ? 'inline' : 'none');
	return out;
});
/// What the head holds, opened: the latest parcel's Diamonds per id, and its version.
const head = (s) => s.page.evaluate(async () => {
	const r = await DaimondGateway.gwFetch('/api/sync', { method: 'GET', credentials: 'same-origin',
		headers: { 'x-daimond-api': String(DaimondGateway.clientApi()) } });
	const g = await r.json().catch(() => null);
	if (!g || !g.blob) return null;
	const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
	const out = {};
	for (const e of (st.diamonds || [])) out[e.id] = e.dataRef ? 'ref:' + String(e.dataRef.key).slice(0, 12) : (e.data != null ? 'inline' : 'none');
	return { v: g.version | 0, shapes: out };
});
const count = (m, f) => Object.values(m).filter(f).length;
const isRef = (x) => String(x).startsWith('ref:');

/// Make `n` Diamonds of ~30 kB each (a 15 kB crystal and its snapshot), every body distinct.
const makeDiamonds = (s, tag, n, size) => s.page.evaluate(async ({ tag, n, size }) => {
	const app = DaimondCore.diamondApp(), ids = [];
	for (let k = 0; k < n; k++) {
		const id = await app.create_diamond(tag + ' ' + k);
		const body = ((tag + k + ' lorem ipsum dolor sit amet ').repeat(Math.ceil(size / 20))).slice(0, size);
		await app.write_crystal_data(id, JSON.stringify({ title: tag + k, summary: body, facts: [{ k: 'n', v: String(k) }] }));
		ids.push(id);
	}
	try { await DaimondCore.loadDiamonds(); } catch (e) { /* older build */ }
	return ids;
}, { tag, n, size });
const exportHas = (s, id, needle) => s.page.evaluate(async ({ id, needle }) => {
	try { return (await DaimondCore.diamondApp().export_diamond(id)).includes(needle); } catch (e) { return false; }
}, { id, needle });
/// Count the chunk reads a device makes from now on.
const countReads = (s) => s.page.evaluate(() => {
	if (window.__reads === undefined) {
		window.__reads = 0;
		const o = DaimondChunks.materialiseBytes;
		DaimondChunks.materialiseBytes = function () { window.__reads++; return o.apply(this, arguments); };
	}
	return typeof DaimondChunks.materialiseBytes === 'function' && window.__reads === 0;
});
const reads = (s) => s.page.evaluate(() => window.__reads);
async function rounds(D, Ph, k) {
	for (let i = 0; i < k; i++) { await push(D); await pull(Ph); await push(Ph); await pull(D); await push(D); await pull(Ph); }
}
/// The three shapes side by side: where they differ, one line per Diamond.
async function compare(D, Ph) {
	const d = await shapes(D), p = await shapes(Ph), h = await head(D);
	const ids = new Set([...Object.keys(d), ...Object.keys(p), ...Object.keys((h && h.shapes) || {})]);
	const diff = [];
	for (const id of ids) {
		const a = d[id] || '-', b = p[id] || '-', c = ((h && h.shapes) || {})[id] || '-';
		if (a !== b || a !== c) diff.push(`${id.slice(0, 6)}: desk ${a} phone ${b} head ${c}`);
	}
	return { d, p, h, diff, n: ids.size };
}

async function arm(tag) {
	console.log(`\n── ${tag}: ${tag === 'A' ? 'nine ~30 kB Diamonds made on the desktop, the phone offloads what its room cannot hold' : 'the desktop edits a reference: touched moves and the Diamond settles once more'} ──`);
	const NAME = 'dshape' + tag.toLowerCase() + '-' + process.pid;
	let D = null, Ph = null;
	try {
		D = await open({ name: NAME, connect: false, defaults: false, profile: scratch('pw', NAME + '-d'), route });
		await ready(D);
		ctl(tag, (await makePagePro(D.page, GWDIR, GW_URL)).pro === true, 'the account holds Pro');
		Ph = await paired(D, NAME, 'p', { ua: IPHONE, isMobile: true, touch: true });
		ctl(tag, await countReads(D) && await countReads(Ph), 'the chunk reads are counted on both devices');

		const ids = await makeDiamonds(D, 'shape', 9, 15000);
		const own = await shapes(D);
		ctl(tag, ids.every((id) => own[id] === 'inline'), 'setup: the desktop would send all nine inline (its room is 1 MB)', J(own));

		await push(D); await pull(Ph);
		const ph0 = await shapes(Ph);
		const split = Object.keys(ph0).filter((id) => isRef(ph0[id]));
		ctl(tag, split.length >= 1 && count(ph0, (x) => x === 'inline') >= 1,
			'setup: the phone has spent its room -- some Diamonds inline, the rest references (the split)', J(ph0));
		note(`${tag}: the phone offloads ${split.length} of 9; the desktop carries them all inline until it hears otherwise`);

		await rounds(D, Ph, 4);
		let c = await compare(D, Ph);
		ctl(tag, c.n >= 9 && ids.every((id) => c.d[id] !== undefined && c.p[id] !== undefined) && c.diff.length === 0, 'calm: every Diamond has one shape on the desktop, the phone and the head, without a reload', c.diff.slice(0, 6).join(' | '));
		ctl(tag, split.every((id) => isRef(c.d[id]) && c.d[id] === c.p[id] && c.p[id] === ((c.h || {}).shapes || {})[id] && c.p[id] === ph0[id]),
			'calm: each Diamond the phone offloaded is a reference on all three, naming the manifest the phone made',
			split.map((id) => `${id.slice(0, 6)}: ${c.d[id]}/${c.p[id]}/${((c.h || {}).shapes || {})[id]} was ${ph0[id]}`).join(' | '));

		// The head stays where it is: no device owes another a push.
		const v0 = (await head(D)).v;
		await rounds(D, Ph, 2);
		const v1 = (await head(D)).v;
		ctl(tag, v1 === v0, 'calm: two more rounds move the head by nothing (no ping-pong)', `v${v0} -> v${v1}`);

		// The phone ticks; the desktop reads the head each time and must not materialise a Diamond it already stands on.
		const r0 = await reads(D);
		for (let i = 0; i < 3; i++) { await makeDiamonds(Ph, 'tick' + i, 1, 400); await push(Ph); await pull(D); await push(D); await pull(Ph); }
		const dr = (await reads(D)) - r0;
		note(`${tag}: the desktop's chunk reads over three pulls of the phone's tick: ${dr}`);
		ctl(tag, dr === 0, 'the desktop reads no chunk of a reference it already stands on (three pulls)', `${dr} reads`);
		await rounds(D, Ph, 2);
		c = await compare(D, Ph);
		ctl(tag, c.diff.length === 0, 'after the ticks: one shape again on all three', c.diff.slice(0, 6).join(' | '));

		if (tag === 'B') {
			// The desktop edits a Diamond that is a reference everywhere: its stamp moves.
			const id = split[0];
			const mark = 'EDITED-' + process.pid;
			await D.page.evaluate(async ({ id, mark }) => {
				await DaimondCore.diamondApp().write_crystal_data(id, JSON.stringify({ title: 'edited', summary: mark + ' ' + 'x'.repeat(9000), facts: [{ k: 'n', v: 'edit' }] }));
			}, { id, mark });
			const e0 = await shapes(D);
			ctl(tag, e0[id] === 'inline', 'the edit moved touched: the desktop sends the Diamond inline again (a candidate once more)', e0[id]);
			await rounds(D, Ph, 4);
			c = await compare(D, Ph);
			ctl(tag, c.diff.length === 0, 'after the edit: one shape on all three, without a reload', c.diff.slice(0, 6).join(' | '));
			// The edited Diamond is now the freshest, so the phone has room for it inline; whichever it is, both agree.
			note(`${tag}: the edited Diamond settles as ${c.d[id]} on the desktop, ${c.p[id]} on the phone`);
			ctl(tag, await exportHas(Ph, id, mark), 'the edit reached the phone');
		}
	} catch (e) {
		ctl(tag, false, 'the run completes', (e && e.stack) || e);
	} finally {
		for (const d of [Ph, D]) if (d) await d.close().catch(() => {});
	}
}

for (const a of ARMS) await arm(a);
const failed = tally.bad.length;
console.log(failed ? `\n${tally.ok} passed, ${failed} failed (${[...new Set(tally.bad)].join(',')})` : `\nall ${tally.ok} checks passed`);
process.exit(failed ? 1 : 0);
