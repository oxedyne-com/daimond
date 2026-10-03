// gateway: live
// verify_linktie.mjs -- three devices of one account, brought up as the soak brings them up, end with ONE Help Diamond:
// the same stamp AND the same bytes, link sidecar included, with no reload (the link tie, F3c; specs/daimond_sync_f1_log.md
// section 16).
//
// Help (`0da1000000e1`) is the one Diamond every device makes for itself: a fixed id, seeded at first boot, and the
// seeding asserts a `consulted` link whose id each device mints at random. So the first sync of a new device meets a
// Diamond it already holds, with a sidecar of its own and a stamp of its own. The soak's heavy seed ended with P holding
// Help at the head's `touched` and different bytes, and two forced rounds left it.
//
//   A   the bootstrap of the soak: the desktop A makes the account, the desktop G and the phone P are paired from it,
//       each signs in. After calm rounds all three hold one Help (stamp, every file of the export) and so does the head.
//   B   A, then G asserts a mark on Help and P another, between two syncs: both land everywhere, still one Help.
//
//   node dev/verify_linktie.mjs [--arms=A,B]
import { open, signInAs, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const ARMS = ((process.argv.find((a) => a.startsWith('--arms=')) || '--arms=A,B').slice(7)).split(',').filter(Boolean);
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const HELP = '0da1000000e1';
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { ok: 0, bad: [] };
const ctl = (arm, pass, what, detail) => { if (pass) tally.ok++; else tally.bad.push(arm);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${arm}  ${what}${detail ? ' -- ' + String(detail).slice(0, 1800) : ''}`); };
const note = (t) => console.log('  note ' + String(t).slice(0, 3000));

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& window.DaimondCloud && DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
async function paired(lead, name, label, extra = {}) {
	const d = await open({ name: name + '-' + label, signIn: false, connect: false, defaults: false,
		profile: scratch('pw', name + '-' + label), ...extra });
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, name);
	await ready(d);
	return d;
}
const push = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	return window.DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push();
}).then(async () => { await sleep(400); }).catch(() => {});
const pull = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	return DaimondSync.pull();
}).then(() => sleep(400)).catch(() => {});
async function rounds(devs, k) {
	for (let i = 0; i < k; i++) for (const d of devs) { await push(d); for (const o of devs) if (o !== d) await pull(o); }
}

/// Help as this device holds it: the stamp, the link rows in order, and a hash of each file of its export.
const helpOf = (s) => s.page.evaluate(async (id) => {
	const h = (t) => { let x = 2166136261; for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x.toString(16); };
	try {
		const ex = JSON.parse(await DaimondCore.diamondApp().export_diamond(id));
		const files = ex.files || {};
		const rows = String(files['.daimond/links.jsonl'] || '').split('\n').filter((l) => l.trim()).map((l) => {
			try { const o = JSON.parse(l); return o.id + (o.share ? '+s' : ''); } catch (e) { return '?'; }
		});
		const fh = {};
		for (const k of Object.keys(files).sort()) fh[k] = h(String(files[k])) + ':' + String(files[k]).length;
		return { here: true, touched: ex.touched, rows, fh };
	} catch (e) { return { here: false, err: String(e).slice(0, 80) }; }
}, HELP);
/// The head's entry for Help, opened: its stamp and the same per-file hashes (an inline entry only).
const headHelp = (s) => s.page.evaluate(async (id) => {
	const h = (t) => { let x = 2166136261; for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x.toString(16); };
	const r = await DaimondGateway.gwFetch('/api/sync', { method: 'GET', credentials: 'same-origin',
		headers: { 'x-daimond-api': String(DaimondGateway.clientApi()) } });
	const g = await r.json().catch(() => null);
	if (!g || !g.blob) return { here: false, v: 0 };
	const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
	const e = (st.diamonds || []).find((x) => x.id === id);
	if (!e) return { here: false, v: g.version | 0 };
	if (e.data == null) return { here: true, v: g.version | 0, ref: true, touched: e.touched };
	const files = (JSON.parse(e.data).files) || {}, fh = {};
	for (const k of Object.keys(files).sort()) fh[k] = h(String(files[k])) + ':' + String(files[k]).length;
	const rows = String(files['.daimond/links.jsonl'] || '').split('\n').filter((l) => l.trim()).map((l) => { try { const o = JSON.parse(l); return o.id + (o.share ? '+s' : ''); } catch (x) { return '?'; } });
	return { here: true, v: g.version | 0, touched: JSON.parse(e.data).touched, rows, fh };
}, HELP);
const addMark = (s, path) => s.page.evaluate(async ({ id, path }) => {
	return await DaimondCore.diamondApp().add_link(id, 'diamond:' + id, 'file:' + path, 'holds', '', 'user');
}, { id: HELP, path });

/// Where two states of Help differ, in words.
function why(a, b) {
	if (!a.here || !b.here) return `present ${a.here}/${b.here}`;
	const out = [];
	if (a.touched !== b.touched) out.push(`touched ${a.touched} vs ${b.touched}`);
	for (const k of new Set([...Object.keys(a.fh || {}), ...Object.keys(b.fh || {})])) {
		if ((a.fh || {})[k] !== (b.fh || {})[k]) out.push(`${k} ${(a.fh || {})[k]} vs ${(b.fh || {})[k]}`);
	}
	if (J(a.rows) !== J(b.rows)) out.push(`rows [${(a.rows || []).join(' ')}] vs [${(b.rows || []).join(' ')}]`);
	return out.join('; ');
}
const show = (tag, st) => note(`${tag}: ` + Object.entries(st).map(([k, v]) => `${k} ${v.here ? v.touched + (v.ref ? ' ref' : '') + ' [' + (v.rows || []).join(' ') + ']' : 'absent'}`).join('  |  '));
async function states(D, G, Ph) {
	return { A: await helpOf(D), G: await helpOf(G), P: await helpOf(Ph), head: await headHelp(D) };
}
const one = (st) => ['G', 'P', 'head'].every((k) => st[k].ref ? st[k].touched === st.A.touched : !why(st.A, st[k]));

async function arm(tag) {
	console.log(`\n── ${tag}: ${tag === 'A' ? 'the soak\'s bootstrap, then calm rounds' : 'two marks asserted between syncs'} ──`);
	const NAME = 'linktie' + tag.toLowerCase() + '-' + process.pid;
	let D = null, G = null, Ph = null;
	try {
		// A signs in with the defaults left in, as the soak's A does: it seeds Help and the Optimiser.
		D = await open({ name: NAME, connect: false, defaults: true, profile: scratch('pw', NAME + '-a') });
		await ready(D);
		ctl(tag, (await makePagePro(D.page, GWDIR, GW_URL)).pro === true, 'the account holds Pro');
		G = await paired(D, NAME, 'g');
		Ph = await paired(D, NAME, 'p', { ua: IPHONE, isMobile: true, touch: true });
		await sleep(3000);
		let st = await states(D, G, Ph);
		show('after the bootstrap, no round yet', st);
		ctl(tag, st.A.here && st.G.here && st.P.here, 'setup: all three devices hold Help', J({ A: st.A.here, G: st.G.here, P: st.P.here }));

		await rounds([D, G, Ph], 4);
		st = await states(D, G, Ph);
		show('after four rounds', st);
		ctl(tag, one(st), 'calm: one Help on A, G, P and the head -- the same stamp and every file of the export the same',
			['G', 'P', 'head'].map((k) => k + ': ' + (why(st.A, st[k]) || 'same')).join(' | '));
		const v0 = st.head.v;
		await rounds([D, G, Ph], 2);
		st = await states(D, G, Ph);
		ctl(tag, st.head.v === v0, 'calm: two more rounds move the head by nothing', `v${v0} -> v${st.head.v}`);
		ctl(tag, one(st), 'still one Help after two more rounds', ['G', 'P', 'head'].map((k) => k + ': ' + (why(st.A, st[k]) || 'same')).join(' | '));

		if (tag === 'B') {
			await addMark(G, 'tie/from-g.md');
			await addMark(Ph, 'tie/from-p.md');
			await rounds([D, G, Ph], 4);
			st = await states(D, G, Ph);
			show('after two marks and four rounds', st);
			ctl(tag, one(st), 'after two marks asserted apart: one Help on all three and the head',
				['G', 'P', 'head'].map((k) => k + ': ' + (why(st.A, st[k]) || 'same')).join(' | '));
			const both = ['A', 'G', 'P'].every((k) => st[k].rows.length >= 2);
			ctl(tag, both, 'both marks are in every sidecar', J({ A: st.A.rows.length, G: st.G.rows.length, P: st.P.rows.length }));
		}
	} catch (e) {
		ctl(tag, false, 'the run completes', (e && e.stack) || e);
	} finally {
		for (const d of [Ph, G, D]) if (d) await d.close().catch(() => {});
	}
}

for (const a of ARMS) await arm(a);
const failed = tally.bad.length;
console.log(failed ? `\n${tally.ok} passed, ${failed} failed (${[...new Set(tally.bad)].join(',')})` : `\nall ${tally.ok} checks passed`);
process.exit(failed ? 1 : 0);
