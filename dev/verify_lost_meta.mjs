// gateway: none
// verify_lost_meta.mjs — UNBLOCK-48: a Diamond whose `.daimond/meta.json` went missing while its
// crystal stayed is rebuilt from the crystal's title, lists, and draws.
//
// THE LOSS. An import deletes the old Diamond and lays `meta.json` down last, so an import cut short
// leaves `crystal.json` with no metadata. Every door reads the metadata first, so the Diamond fell out
// of the list and its page could not be drawn ("meta.json does not exist"). The store now rebuilds the
// record from `crystal.json`'s `title`, once, and writes it back.
//
// A synthetic Diamond, never the owner's bytes: made through the app, its meta.json deleted straight
// out of OPFS, its crystal given a title, then the tab reloaded.
//
//   node dev/verify_lost_meta.mjs
import { open, signInAs, clearDiamonds, BROWSER } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
if (BROWSER !== 'chromium') { console.error('Chromium only: the Diamond is laid down in OPFS.'); process.exit(2); }

const NAME = 'Lost Meta Probe';
const s = await open({ name: 'lostmeta', defaults: false });
await clearDiamonds(s);

const id = await s.page.evaluate(async (name) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const id = await app.create_diamond('placeholder');
	let d = await navigator.storage.getDirectory();
	d = await (await d.getDirectoryHandle('diamonds')).getDirectoryHandle(id);
	const w = await (await d.getFileHandle('crystal.json', { create: true })).createWritable();
	await w.write(JSON.stringify({ title: name, summary: 'A probe.' }));
	await w.close();
	await (await d.getDirectoryHandle('.daimond')).removeEntry('meta.json');
	return id;
}, NAME);

await s.page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, s.name);

const got = await s.page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const out = {};
	try { out.list = JSON.parse(await app.list_diamonds()).find((d) => d.id === id) || null; }
	catch (e) { out.list = String(e); }
	try { out.page = 'drawn:' + (await app.read_crystal_page(id)).length; }
	catch (e) { out.page = String(e); }
	try {
		let d = await navigator.storage.getDirectory();
		d = await (await (await d.getDirectoryHandle('diamonds')).getDirectoryHandle(id)).getDirectoryHandle('.daimond');
		out.meta = await (await (await d.getFileHandle('meta.json')).getFile()).text();
	} catch (e) { out.meta = String(e); }
	out.shown = document.body.innerText.includes('Lost Meta Probe');
	return out;
}, id);

check('the Diamond lists under its crystal\'s title', got.list && got.list.name === NAME, JSON.stringify(got.list));
check('its page draws without a metadata error', !/metadata|meta\.json/.test(String(got.page)), String(got.page));
check('meta.json was written back', String(got.meta).includes(NAME), String(got.meta).slice(0, 120));
check('the name is on the page', got.shown === true);

await s.close();
console.log(`verify_lost_meta: ${ok.length} ok, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
