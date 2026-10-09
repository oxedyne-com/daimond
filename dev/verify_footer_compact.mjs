// gateway: none
// verify_footer_compact.mjs -- the footer above the composer stays compact (D-20261008-04).
//
// The owner, 2026-10-08: "we need to recover more screen real estate at the footer of
// diamonds and ordinary chats with toggleable expansion of the workspace files/folders
// (diamonds do this but then a lot of vertical space is used just for linked diamonds)".
//
// What was wrong, measured on r538 (27d05f87):
//   * a diamond's footer was TWO rows before it said anything: the linked-diamonds header
//     and the workspace strip, one under the other;
//   * an ordinary chat had no toggle at all: its workspace group (head band and tiles) was
//     always open, up to six rows of tiles on a desktop and four on a phone.
//
// What is held here:
//   * the baseline is MEASURED, not remembered: the same fixture is driven twice, once on
//     the page as 27d05f87 served it (every www file this tree changed is answered from
//     `git show 27d05f87:...`) and once on this tree, so the comparison cannot drift from
//     the figures in a commit message. On the base tree itself the two are the same page,
//     which is why this file is RED there by construction;
//   * a chat has a workspace toggle, collapsed by default, and a diamond's two toggles share
//     one row; collapsed, each footer is shorter than r538's by at least the row (diamond)
//     or the list (chat) that went;
//   * the toggle state survives a reload and is shared between a chat and a diamond's
//     workspace strip (one device preference);
//   * the quality bar: one line, nothing past the edge, 44px to press on a phone, the `+`
//     still on the chat's band while it is folded (the control that ends the empty state is
//     reachable from the empty state), and the same in 0 / 1 / 3 / many links, a long
//     name, an empty workspace and the longest locale;
//   * by role: the chat's toggle is an `.arte-strip` and sits where a diamond's footer puts one,
//     its box on the footer's text edge; and on a 390x844 phone the `+` on the band is clear
//     of the floating chevrons (`#chat-end`, `#chat-jump`) with both of them in view.
//
// Both looks, both sizes. Run with the world up (`bash dev/world.sh N --up`); no gateway.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, newChat, markHere, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BASE = '27d05f87';
const SHOTS = process.env.FOOT_SHOTS || '';			// a directory: take before/after shots into it
const SIZES = { desk: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const LOOKS = ['obsidian', 'porcelain'];

let bad = 0;
const check = (ok, what, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  -- ' + detail : ''}`);
	if (!ok) bad++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The base page: every file this tree changed, answered as 27d05f87 had it ──────────
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const changed = git('diff', '--name-only', BASE, '--', 'www').stdout.split('\n').filter(Boolean)
	.map((f) => f.replace(/^www\//, ''))
	.filter((f) => git('cat-file', '-e', `${BASE}:www/${f}`).status === 0);
const MIME = { js: 'application/javascript', css: 'text/css', html: 'text/html', json: 'application/json' };
console.log(`base ${BASE}: ${changed.length} www file(s) differ and are served from it`, changed.join(' '));
const serveBase = async (page) => {
	for (const f of changed) {
		const body = git('show', `${BASE}:www/${f}`).stdout;
		const ext = f.split('.').pop();
		const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		await page.route(new RegExp('/' + esc + '(\\?.*)?$'), (r) =>
			r.fulfill({ status: 200, contentType: MIME[ext] || 'text/plain', body }));
	}
};

// ── The fixture ──────────────────────────────────────────────────────────────────────
const LONG = 'Kitchen renovation for the Leederville house, stage two: joinery, benchtop and splashback';
const NAMES = ['Kitchen renovation', 'Empty one', 'Lone link', 'Crowded', 'Aspen', 'Birch', 'Cedar', LONG];
// name -> [links, workspace items]
const SPEC = { 'Kitchen renovation': [3, 3], 'Empty one': [0, 0], 'Lone link': [1, 1], 'Crowded': [9, 8], [LONG]: [3, 2] };
const TARGETS = ['Aspen', 'Birch', 'Cedar'];

async function seed(s) {
	const { page } = s;
	await page.setViewportSize(SIZES.desk);
	await wait(1500);
	for (const name of NAMES) {
		// The button can be drawn before its handler is bound; ask again until the dialog is up.
		for (let tries = 0; tries < 5; tries++) {
			await page.click('#new-diamond-btn', { force: true });
			if (await page.waitForSelector('.dlg-input', { timeout: 4000 }).then(() => true, () => false)) break;
		}
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', name);
		await page.click('.dlg-ok', { force: true });
		await wait(1000);
	}
	const ids = await page.evaluate(async () => {
		const out = {};
		for (const d of JSON.parse(await DaimondCore.diamondApp().list_diamonds())) out[d.name] = d.id;
		return out;
	});
	for (const [name, [nl, ni]] of Object.entries(SPEC)) {
		for (let i = 0; i < nl; i++) {
			const to = ids[TARGETS[i % TARGETS.length]];
			await page.evaluate(async ({ a, to, rel }) =>
				DaimondCore.diamondApp().add_link(a, 'diamond:' + a, 'diamond:' + to, rel, '', 'user'),
				{ a: ids[name], to, rel: 'informs-' + i });
		}
		for (let i = 0; i < ni; i++) await markHere(s, ids[name], `file:[browser]notes/n${i}.md`, {});
	}
	return ids;
}

async function look(page, theme) {
	await page.evaluate((t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set(t); }, theme);
	await wait(500);
}
async function size(page, k) {
	await page.setViewportSize(SIZES[k]);
	await page.evaluate(() => window.dispatchEvent(new Event('resize')));
	await wait(500);
}
async function openDiamond(page, name) {
	const hit = await page.evaluate((nm) => {
		const t = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find((e) => ((e.querySelector('.session-box-name') || e).textContent || '').trim() === nm);
		if (!t) return false;
		(t.querySelector('.tile-label') || t).click();
		return true;
	}, name);
	if (!hit) throw new Error('no Diamond ' + name + ' in the rail');
	await wait(900);
	// The crystal face: that is where a diamond's footer is.
	await page.evaluate(() => { const b = document.getElementById('dview-crystal'); if (b) b.click(); });
	await wait(500);
}

// What the page shows, read in one place so base and tree are read the same way.
const READ = () => {
	const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
	const vis = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
	const cs = document.getElementById('crystal-controls');
	const crystal = vis(document.getElementById('crystal-view')) && vis(cs);
	const ca = document.getElementById('chat-attachments');
	const chatFoot = !crystal && vis(ca);
	const toggles = (root) => [...root.querySelectorAll('.foot-toggle, .link-strip, .arte-strip')].filter(vis).map((e) => ({
		cls: e.className, id: e.id, text: e.textContent.trim(), exp: e.getAttribute('aria-expanded'), rect: r(e),
		clipped: e.scrollWidth > e.clientWidth + 1, tall: e.scrollHeight > e.clientHeight + 1,
	}));
	const out = {
		scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, innerH: window.innerHeight,
		bar: r(document.querySelector('.chat-input-bar')),
	};
	if (crystal) {
		out.kind = 'diamond';
		out.foot = r(cs);
		out.row = r(document.getElementById('link-sec'));
		out.toggles = toggles(cs);
		out.body = r(document.getElementById('crystal-body'));
		out.linkBody = vis(document.getElementById('link-body'));
		out.list = vis(document.getElementById('arte-list'));
		out.listH = out.list ? r(document.getElementById('arte-list')).h : 0;
	} else if (chatFoot) {
		out.kind = 'chat';
		out.foot = r(ca);
		out.toggles = toggles(ca);
		out.add = r(ca.querySelector('.attach-add'));
		// The footer's text edge: where the strip's content starts, which is where a toggle's box belongs.
		out.edge = ca.getBoundingClientRect().x + parseFloat(getComputedStyle(ca).paddingLeft);
		// The `+` against the two floating chevrons. They are hidden while the thread has nowhere to walk to, so they are shown for
		// the reading (and put back) to answer for the state in which they are there: the layout must not depend on it.
		const add = ca.querySelector('.attach-add'), jumps = ['chat-end', 'chat-jump'].map((i) => document.getElementById(i)).filter(Boolean);
		const was = jumps.map((e) => e.hidden);
		jumps.forEach((e) => { e.hidden = false; });
		out.jumps = jumps.map((e) => ({ id: e.id, rect: r(e) }));
		out.addCover = [];
		if (add) {
			const b = add.getBoundingClientRect();
			for (const [fx, fy] of [[.5, .5], [.1, .1], [.9, .1], [.1, .9], [.9, .9]]) {
				const e = document.elementFromPoint(b.x + b.width * fx, b.y + b.height * fy);
				if (!e || e === add || add.contains(e)) continue;
				out.addCover.push(e.id || e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]);
			}
		}
		jumps.forEach((e, i) => { e.hidden = was[i]; });
		out.view = r(ca.querySelector('.attach-view-btn'));
		out.wsBody = vis(ca.querySelector('.ws-body')) ? r(ca.querySelector('.ws-body')) : null;
		out.out = r(document.getElementById('chat-output'));
	} else {
		out.kind = 'none';
	}
	return out;
};
const read = (page) => page.evaluate(READ);

async function collapse(page, which) {
	// The stored state is the device's: set it the way a person leaves it, then redraw.
	await page.evaluate((w) => {
		for (const k of w) { try { localStorage.removeItem(k); } catch (e) { /* none */ } }
	}, which);
}

// ── One run against one build ────────────────────────────────────────────────────────
async function run(label, route) {
	const s = await open({ name: 'footcompact' + label, defaults: false, route, profile: null });
	const { page } = s;
	const ids = await seed(s);
	const R = { label, diamond: {}, chat: {}, s, ids };
	const store = () => page.evaluate(() => { try { localStorage.removeItem('daimond-foot-ws'); localStorage.removeItem('daimond-foot-links'); } catch (e) { /* none */ } });

	// The diamonds, all of them, at both sizes and both looks, folded as a person first finds them.
	await store();
	for (const name of Object.keys(SPEC)) {
		await size(page, 'desk');
		await openDiamond(page, name);
		for (const lk of LOOKS) {
			await look(page, lk);
			for (const k of Object.keys(SIZES)) {
				await size(page, k);
				R.diamond[`${name}|${lk}|${k}`] = await read(page);
			}
		}
	}
	// Shots of the main diamond, folded.
	if (SHOTS) {
		await size(page, 'desk'); await openDiamond(page, 'Kitchen renovation');
		for (const lk of LOOKS) for (const k of Object.keys(SIZES)) {
			await look(page, lk); await size(page, k);
			await page.screenshot({ path: path.join(SHOTS, `${label}_diamond_folded_${lk}_${k}.png`) });
		}
	}

	// The chats: none held, three held, many held (past the cap). Each is made, filled and read at once.
	const FILL = { none: 0, three: 3, many: 9 };
	for (const [nm, n] of Object.entries(FILL)) {
		await size(page, 'desk');
		const id = await newChat(s);
		for (let i = 0; i < n; i++) {
			if (i === 0) await page.evaluate(({ id }) => DaimondAttach.chatToggle(id, 'dir:[browser]papers', true, 'papers'), { id });
			else await markHere(s, null, `file:[browser]notes/c${i}.md`, { chat: id, path: `notes/c${i}.md`, dir: false });
		}
		await wait(500);
		R.chat[nm] = { id };
		for (const lk of LOOKS) {
			await look(page, lk);
			for (const k of Object.keys(SIZES)) {
				await size(page, k);
				R.chat[nm][`${lk}|${k}`] = await read(page);
			}
		}
		if (SHOTS && nm === 'three') {
			for (const lk of LOOKS) for (const k of Object.keys(SIZES)) {
				await look(page, lk); await size(page, k);
				await page.screenshot({ path: path.join(SHOTS, `${label}_chat_folded_${lk}_${k}.png`) });
			}
		}
	}
	return R;
}

// ── 1. The base page, measured live ──────────────────────────────────────────────────
const B = await run('base', serveBase);
console.log('base diamond Kitchen desk obsidian foot', B.diamond['Kitchen renovation|obsidian|desk']?.foot?.h);
await B.s.close();

// ── 2. This tree ─────────────────────────────────────────────────────────────────────
const N = await run('tree', null);
const { page } = N.s;
const f1 = (x) => Math.round(x * 10) / 10;
const rows = [];

for (const lk of LOOKS) for (const k of Object.keys(SIZES)) {
	const tag = `${lk} ${k}`;
	// Diamond: the main fixture.
	const bd = B.diamond[`Kitchen renovation|${lk}|${k}`], nd = N.diamond[`Kitchen renovation|${lk}|${k}`];
	const strip = bd.toggles.find((t) => /link-strip/.test(t.cls));
	const gone = strip ? strip.rect.h : 0;
	rows.push(`diamond ${tag}: footer ${f1(bd.foot.h)} -> ${f1(nd.foot.h)} px, transcript ${f1(bd.body.h)} -> ${f1(nd.body.h)} px`);
	check(nd.foot.h <= bd.foot.h - gone, `${tag}: a folded diamond footer is shorter than r538's by at least the links row`,
		`${f1(bd.foot.h)} -> ${f1(nd.foot.h)} px, the row was ${f1(gone)}`);
	check(nd.body.h >= bd.body.h + gone, `${tag}: the diamond's transcript region gets that height back`,
		`${f1(bd.body.h)} -> ${f1(nd.body.h)} px`);
	// Chat with workspace items.
	for (const c of ['three', 'many', 'none']) {
		const bc = B.chat[c][`${lk}|${k}`], nc = N.chat[c][`${lk}|${k}`];
		rows.push(`chat(${c}) ${tag}: footer ${f1(bc.foot ? bc.foot.h : 0)} -> ${f1(nc.foot ? nc.foot.h : 0)} px`);
		// An empty chat's sentence sat beside the band on a wide page (r538 draws it inline), so there
		// the list added no height: the claim is then only that the folded row is no taller.
		const list = bc.wsBody && !(c === 'none' && k === 'desk') ? bc.wsBody.h : 0;
		check(!!nc.foot && !!bc.foot && nc.foot.h <= bc.foot.h - list, `${tag}: a folded chat footer (${c}) is shorter than r538's by at least its list`,
			`${f1(bc.foot && bc.foot.h)} -> ${f1(nc.foot && nc.foot.h)} px, the list was ${f1(list)}`);
	}
}
console.log('\nMEASURED (base -> this tree):\n  ' + rows.join('\n  ') + '\n');

// ── 3. The chat has the toggle, folded, with the `+` on its band ────────────────────
for (const c of ['none', 'three', 'many']) for (const lk of LOOKS) for (const k of Object.keys(SIZES)) {
	const x = N.chat[c][`${lk}|${k}`], tag = `chat(${c}) ${lk} ${k}`;
	const tg = x.toggles && x.toggles[0];
	check(!!tg, `${tag}: the workspace toggle exists`);
	if (!tg) continue;
	check(tg.exp === 'false' && !x.wsBody, `${tag}: it starts folded`, `aria-expanded=${tg.exp}, list ${x.wsBody ? 'drawn' : 'not drawn'}`);
	check(!!x.add && x.add.r <= x.innerW && x.add.x > tg.rect.x, `${tag}: the + stays on the band, at the right of the toggle`);
	check(!x.view, `${tag}: the view toggle waits for the list`);
	check(!tg.tall && !tg.clipped, `${tag}: the toggle's words fit on one line`, tg.text);
	check(x.scrollW <= x.innerW, `${tag}: no horizontal page scroll`, `${x.scrollW} <= ${x.innerW}`);
	// By role: the toggle is an `.arte-strip`, and a diamond's footer draws that with its box on the footer's text edge.
	check(Math.abs(tg.rect.x - x.edge) < 0.5, `${tag}: the toggle's box is on the footer's text edge`, `x ${f1(tg.rect.x)} against ${f1(x.edge)}`);
	if (k === 'phone') {
		// At 390x844 the chevrons float over the band's own row; the `+` has to be pressable with them in view.
		const hits = x.jumps.filter((j) => j.rect && x.add && j.rect.x < x.add.r && j.rect.r > x.add.x && j.rect.y < x.add.b && j.rect.b > x.add.y);
		check(x.innerW === 390 && x.innerH === 844 && x.jumps.length === 2 && !hits.length && !x.addCover.length,
			`${tag}: the + is not overlapped by #chat-end or #chat-jump`, `${x.innerW}x${x.innerH}, overlapped by ${hits.map((j) => j.id).join(',') || 'none'}, covered at ${x.addCover.join(',') || 'no point'}`);
		check(tg.rect.h >= 43.5, `${tag}: the toggle is 44px to press`, f1(tg.rect.h) + 'px');
		check(x.add && x.add.h >= 43.5 && x.add.w >= 43.5, `${tag}: the + is 44px to press`, x.add && `${f1(x.add.w)}x${f1(x.add.h)}`);
	}
}

// ── 4. The diamond's two toggles share a row; every slot ────────────────────────────
for (const name of Object.keys(SPEC)) for (const lk of LOOKS) for (const k of Object.keys(SIZES)) {
	const x = N.diamond[`${name}|${lk}|${k}`], tag = `diamond "${name.slice(0, 18)}" ${lk} ${k}`;
	const L = x.toggles.find((t) => /link-strip/.test(t.cls)), A = x.toggles.find((t) => /arte-strip/.test(t.cls));
	check(!!L && !!A, `${tag}: both toggles are drawn`);
	if (!L || !A) continue;
	check(Math.abs(L.rect.y - A.rect.y) < 1.5 && A.rect.x >= L.rect.r - 0.5, `${tag}: the two toggles are one row`,
		`links y ${f1(L.rect.y)}, workspace y ${f1(A.rect.y)}`);
	check(L.exp === 'false' && A.exp === 'false' && !x.linkBody && !x.list, `${tag}: both start folded`);
	check(!L.tall && !A.tall && L.rect.h <= (k === 'phone' ? 46 : 30), `${tag}: each toggle is one line`, `${f1(L.rect.h)}px`);
	check(A.rect.r <= x.innerW && L.rect.x >= 0 && x.scrollW <= x.innerW, `${tag}: nothing past the edge`);
	check(L.rect.w >= 44 && A.rect.w >= 44, `${tag}: neither is squeezed away`, `${f1(L.rect.w)} / ${f1(A.rect.w)}`);
	if (k === 'phone') check(L.rect.h >= 43.5 && A.rect.h >= 43.5, `${tag}: both are 44px to press`, `${f1(L.rect.h)} / ${f1(A.rect.h)}`);
	const [nl, ni] = SPEC[name];
	check(new RegExp(`\\b${nl}\\b`).test(L.text) && (ni ? new RegExp(`\\b${ni}\\b`).test(A.text) : true), `${tag}: the counts are the real ones`, `${L.text} | ${A.text}`);
	if (k === 'desk' || name !== 'Crowded') check(!L.clipped && !A.clipped, `${tag}: the words are not cut`, `${L.text} | ${A.text}`);
}

// ── 5. Opening them: expansion in place, one preference per device, kept over a reload ─
await size(page, 'desk');
await look(page, 'obsidian');
await openDiamond(page, 'Kitchen renovation');
const before = await read(page);
await page.click('#link-strip', { force: true });
await page.click('#arte-strip', { force: true });
await wait(700);
const open1 = await read(page);
check(open1.linkBody && open1.list, 'both open in place on a click', `foot ${f1(before.foot.h)} -> ${f1(open1.foot.h)} px`);
check(open1.toggles.every((t) => t.exp === 'true'), 'both toggles say they are expanded (aria-expanded)');
// The footer sits at the bottom, so it grows upward; the row keeps its place inside it.
check(Math.abs((open1.row.y - open1.foot.y) - (before.row.y - before.foot.y)) < 0.5, 'opening does not move the row itself');
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);
await openDiamond(page, 'Kitchen renovation');
const kept = await read(page);
check(kept.linkBody && kept.list && kept.toggles.every((t) => t.exp === 'true'), 'a reload keeps both open (per device)');
// A chat shares the workspace preference: it opens its list because the diamond's is open.
const cid = await newChat(N.s);
await page.evaluate(({ id }) => DaimondAttach.chatToggle(id, 'dir:[browser]papers', true, 'papers'), { id: cid });
await wait(500);
const chatOpen = await read(page);
check(chatOpen.kind === 'chat' && chatOpen.toggles[0] && chatOpen.toggles[0].exp === 'true' && !!chatOpen.wsBody && !!chatOpen.view,
	'a chat shows its list when the workspace preference is open, view toggle and all');
await page.click('#chat-attachments .foot-toggle', { force: true });
await wait(500);
const chatShut = await read(page);
check(chatShut.toggles[0].exp === 'false' && !chatShut.wsBody, 'folding the chat toggle folds its list');
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);
const chatKept = await read(page);
check(chatKept.kind === 'chat' ? chatKept.toggles[0].exp === 'false' : true, 'a reload keeps the chat folded');
await openDiamond(page, 'Kitchen renovation');
const dShut = await read(page);
const Ad = dShut.toggles.find((t) => /arte-strip/.test(t.cls)), Ld = dShut.toggles.find((t) => /link-strip/.test(t.cls));
check(Ad.exp === 'false' && !dShut.list, 'the diamond follows: one workspace preference for the device');
check(Ld.exp === 'true' && dShut.linkBody, 'the links fold is its own preference and stays as it was left');
// Link form survives a repaint while open; links open with zero links says why and offers the add.
await openDiamond(page, 'Empty one');
const empty = await read(page);
check(empty.linkBody && !!(await page.$('#link-add')), 'an open links section with no links still offers the add');

// ── 6. The longest locale, on the phone ──────────────────────────────────────────────
await page.evaluate(() => { try { localStorage.removeItem('daimond-foot-ws'); localStorage.removeItem('daimond-foot-links'); } catch (e) { /* none */ } });
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);
for (const loc of ['fr', 'de', 'ja', 'en']) {
	await page.evaluate(async (l) => { await window.DaimondI18n.setLocale(l); }, loc);
	await wait(600);
	await size(page, 'desk');
	for (const nm of ['Kitchen renovation', 'Empty one', 'Crowded']) {
		await openDiamond(page, nm);
		await size(page, 'phone');
		const x = await read(page);
		const L = x.toggles.find((t) => /link-strip/.test(t.cls)), A = x.toggles.find((t) => /arte-strip/.test(t.cls));
		const tag = `locale ${loc} phone "${nm}"`;
		check(!!L && !!A && Math.abs(L.rect.y - A.rect.y) < 1.5 && !L.tall && !A.tall && x.scrollW <= x.innerW && A.rect.r <= x.innerW,
			`${tag}: one row, one line each, nothing past the edge`, `${L && L.text} | ${A && A.text}`);
		await size(page, 'desk');
	}
	const cidn = await newChat(N.s);
	await size(page, 'phone');
	const c = await read(page);
	check(c.kind === 'chat' && c.toggles[0] && !c.toggles[0].tall && c.add && c.add.r <= c.innerW && c.scrollW <= c.innerW,
		`locale ${loc} phone chat: the band is one row with the + inside the edge`, c.toggles[0] && c.toggles[0].text);
	await size(page, 'desk');
}
await page.evaluate(async () => { await window.DaimondI18n.setLocale('en'); });

// ── 7. Shots: expanded, for the lead ─────────────────────────────────────────────────
if (SHOTS) {
	for (const lk of LOOKS) for (const k of Object.keys(SIZES)) {
		await look(page, lk); await size(page, 'desk');
		await openDiamond(page, 'Kitchen renovation');
		await page.evaluate(() => { try { localStorage.setItem('daimond-foot-ws', '1'); localStorage.setItem('daimond-foot-links', '1'); } catch (e) { /* none */ } });
		await page.reload({ waitUntil: 'domcontentloaded' }); await wait(2500);
		await openDiamond(page, 'Kitchen renovation'); await size(page, k);
		await page.screenshot({ path: path.join(SHOTS, `tree_diamond_open_${lk}_${k}.png`) });
		await size(page, 'desk');		// the rail's New Chat is off screen on the phone
		await newChat(N.s);
		const id = await page.evaluate(() => String(DaimondAttach.focus().id));
		await page.evaluate(({ id }) => DaimondAttach.chatToggle(id, 'dir:[browser]papers', true, 'papers'), { id });
		await markHere(N.s, null, 'file:[browser]notes/c1.md', { chat: id, path: 'notes/c1.md', dir: false });
		await size(page, k); await wait(400);
		await page.screenshot({ path: path.join(SHOTS, `tree_chat_open_${lk}_${k}.png`) });
		await page.evaluate(() => { try { localStorage.removeItem('daimond-foot-ws'); localStorage.removeItem('daimond-foot-links'); } catch (e) { /* none */ } });
		await size(page, 'desk');
	}
}

const errs = errors(N.s);
// 502s are the /api proxy: this verifier is `gateway: none`, so a world has nothing behind it.
const real = errs.filter((e) => !/502 \(Bad Gateway\)/.test(e));
check(real.length === 0, 'no console errors on this tree', real.slice(0, 3).join(' | '));
await N.s.close();
console.log(bad ? `\nverify_footer_compact: ${bad} FAILED.` : '\nverify_footer_compact: all checks pass.');
process.exit(bad ? 1 : 0);
