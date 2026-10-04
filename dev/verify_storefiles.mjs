// gateway: live
// verify_storefiles.mjs -- the app's own store files travel from every device whatever is mounted (D-20260924-28).
// A desktop that mounts a real folder (nothing flagged) and a phone, on the live gateway. Ran as c1probe_u57 it showed the defect:
// a store file written on the folder-mounted desktop never reached the phone. Here each arm asserts what must now hold.
//   CTL  a store file written before the mount reaches the phone;
//   S1   prompts/chat.md written on the folder-mounted desktop reaches the phone;
//   S2   DAIMOND.md (the user's standing instructions) likewise;
//   S3   prompts/worker.md written on the phone reaches the desktop's STORE, and the mounted folder gains nothing;
//   S4   the folder's own unflagged file does NOT reach the phone (the owner's opt-in per folder stands);
//   S5   an OLDER copy on the desktop never replaces a NEWER one on the phone, and the newer one reaches the desktop;
//   S6   a Diamond's own file still travels (the rail that already worked).
// Usage: node dev/verify_storefiles.mjs
import { open, signInAs, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { ok: 0, bad: [] };
const ctl = (arm, pass, what, detail) => { if (pass) tally.ok++; else tally.bad.push(arm);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${arm}  ${what}${detail !== undefined && detail !== '' ? ' -- ' + String(detail).slice(0, 600) : ''}`); };
const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& window.DaimondCloud && DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
async function paired(lead, name, label, extra = {}) {
	const d = await open({ name: name + '-' + label, signIn: false, connect: false, defaults: false, profile: scratch('pw', name + '-' + label), ...extra });
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, name); await ready(d); await sleep(2000);
	return d;
}
const push = (s) => s.page.evaluate(async () => { try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older */ }
	return window.DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push(); }).then(() => sleep(500)).catch((e) => 'threw ' + e);
const pull = (s) => s.page.evaluate(async () => { try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older */ }
	return DaimondSync.pull(); }).then(() => sleep(500)).catch(() => {});
async function rounds(D, P, k) { for (let i = 0; i < k; i++) { await push(D); await pull(P); await push(P); await pull(D); } }
const readStore = (s, p) => s.page.evaluate(async (x) => { const m = await import('/pkg/oxedyne_daimond.js'); try { return await m.store_read(x); } catch (e) { return null; } }, p);
const writeStore = (s, p, body) => s.page.evaluate(async (a) => { const m = await import('/pkg/oxedyne_daimond.js'); await m.store_write(a.p, a.body); }, { p, body });
const mkDiamond = (s, tag, text) => s.page.evaluate(async ({ tag, text }) => {
	const app = DaimondCore.diamondApp(), id = await app.create_diamond(tag);
	await app.write_crystal_data(id, JSON.stringify({ title: tag, summary: 'c1 probe', facts: [{ k: 'n', v: '1' }] }));
	const m = await import('/pkg/oxedyne_daimond.js'); await m.store_write('diamonds/' + id + '/steering.md', text);
	try { await DaimondCore.loadDiamonds(); } catch (e) { /* older */ }
	return { id, packed: (await app.export_diamond(id)).includes(text) };
}, { tag, text });
async function mount(D) {
	await D.page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('mounted', { create: true });
		dir.queryPermission = async () => 'granted'; dir.requestPermission = async () => 'granted'; window.showDirectoryPicker = async () => dir; });
	await D.page.evaluate(() => window.DaimondPanels && DaimondPanels.open && DaimondPanels.open('work'));
	await D.page.waitForTimeout(700);
	await D.page.evaluate(() => { const chips = [...document.querySelectorAll('.files-mode-chip')];
		const m = chips.find((c) => /machine/.test(c.className) || c.querySelector('[data-icon="machine"]')) || chips[1]; if (m) m.click(); });
	await D.page.waitForTimeout(2500);
	return D.page.evaluate(async () => { const mod = await import('/pkg/oxedyne_daimond.js');
		return { chips: [...document.querySelectorAll('.files-mode-chip')].map((c) => c.className.replace(/files-mode-chip ?/, '') + ':' + c.textContent.trim().slice(0, 12)).join(','),
			msg: ((document.querySelector('.files-mode-msg, #files-mode-msg, [class*="mode-msg"]') || {}).textContent || '').trim().slice(0, 120),
			mode: mod.workspace_mode(), handle: !!(window.DaimondFiles && DaimondFiles.folder()), roots: (await DaimondFiles.shareRoots()).length }; });
}

const folderHas = (s, rel) => s.page.evaluate(async (r) => { try { let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('mounted');
	const parts = r.split('/'); for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
	await d.getFileHandle(parts[parts.length - 1]); return true; } catch (e) { return false; } }, rel);
const writeFolder = (s, rel, body) => s.page.evaluate(async (a) => { let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('mounted', { create: true });
	const parts = a.rel.split('/'); for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i], { create: true });
	const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable(); await w.write(a.body); await w.close(); }, { rel, body });
const NAME = 'sf-' + process.pid;
let D = null, P = null;
try {
	D = await open({ name: NAME, connect: false, defaults: false, profile: scratch('pw', NAME + '-d') });
	await ready(D);
	ctl('setup', (await makePagePro(D.page, GWDIR, GW_URL)).pro === true, 'the account holds Pro');
	P = await paired(D, NAME, 'p', { ua: IPHONE, isMobile: true, touch: true });
	await writeStore(D, 'prompts/ctl.md', 'CTL-D');
	await rounds(D, P, 2);
	const c = await readStore(P, 'prompts/ctl.md');
	ctl('CTL', c === 'CTL-D', 'a store file from the not-yet-mounted desktop reaches the phone', JSON.stringify(c));
	const m = await mount(D);
	ctl('mount', m.mode === 'folder' && m.handle === true && m.roots === 0, 'the desktop has a folder open and flags nothing', JSON.stringify(m));
	await writeStore(D, 'prompts/chat.md', 'CHAT-D-MOUNTED');
	await writeStore(D, 'DAIMOND.md', 'STANDING-D-MOUNTED');
	await writeFolder(D, 'proj/secret.txt', 'UNFLAGGED-FOLDER-FILE');
	await rounds(D, P, 3);
	const s1 = await readStore(P, 'prompts/chat.md');
	ctl('S1', s1 === 'CHAT-D-MOUNTED', 'a store file written on the folder-mounted desktop reaches the phone', JSON.stringify(s1));
	const s2 = await readStore(P, 'DAIMOND.md');
	ctl('S2', s2 === 'STANDING-D-MOUNTED', 'DAIMOND.md written on the folder-mounted desktop reaches the phone', JSON.stringify(s2));
	await writeStore(P, 'prompts/worker.md', 'WORKER-P');
	await rounds(D, P, 3);
	const s3 = await readStore(D, 'prompts/worker.md');
	ctl('S3', s3 === 'WORKER-P', 'a store file written on the phone reaches the folder-mounted desktop store', JSON.stringify(s3));
	ctl('S3b', (await folderHas(D, 'prompts/worker.md')) === false && (await folderHas(D, 'prompts/chat.md')) === false, 'the mounted folder gains no prompts');
	const s4 = await readStore(P, 'proj/secret.txt');
	ctl('S4', (s4 === null || s4 === '' || s4 === undefined) && (await folderHas(D, 'proj/secret.txt')) === true, 'the unflagged folder file stays in the folder and does not reach the phone', JSON.stringify(s4));
	await writeStore(D, 'prompts/daimon.md', 'OLD-D');
	await sleep(1500);
	await writeStore(P, 'prompts/daimon.md', 'NEW-P');
	await rounds(D, P, 3);
	const d5 = await readStore(D, 'prompts/daimon.md'), p5 = await readStore(P, 'prompts/daimon.md');
	ctl('S5', d5 === 'NEW-P' && p5 === 'NEW-P', 'the newer copy wins on both and the older never overwrites it', JSON.stringify([d5, p5]));
	const a = await mkDiamond(D, 'sf desk diamond', 'NOTE-D');
	await rounds(D, P, 3);
	const ha = await readStore(P, 'diamonds/' + a.id + '/steering.md');
	ctl('S6', a.packed && ha === 'NOTE-D', 'a Diamond own file still travels from the mounted desktop', JSON.stringify(ha));
} catch (e) { tally.bad.push('threw'); console.log('  FAIL threw -- ' + (e && e.stack || e)); }
finally { for (const s of [D, P]) { try { if (s) await s.close(); } catch (e) { /* closed */ } } }
console.log(`\nverify_storefiles: ${tally.ok} ok, ${tally.bad.length} failed`);
process.exit(tally.bad.length ? 1 : 0);
