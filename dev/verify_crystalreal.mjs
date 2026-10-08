// gateway: none
// verify_crystalreal — a daimon's `capture in:"crystal"` draws the REAL crystal of its Diamond, or says why it cannot,
// and no write of a crystal that does not parse is ever kept.
//
// WHY THIS EXISTS. 2026-10-07/08, the Ontheism Diamond: a daimon asked for an infographic drew an EMPTY crystal on every capture
// (the `.empty` card, `title` undefined) while the owner's own panel showed a real one, so a working page and a broken one looked alike
// to it and it spent $3 in 14 minutes debugging a phantom (specs/daimond_ontheism_infographic_20261008.md, fix 1).  The probe read the
// crystal with `read_crystal_data(&id).await.unwrap_or_default()`, which turned every failure into an empty crystal, silently.
//
// The ROOT CAUSE found afterwards (lane K, K0): the crystal the probe read was not a JSON object at all, `crystal.js` took
// `obj(parse(text).data)` of that and drew `{}`, and the panel fell back to `fromMarkdown(rawJSON)`, which is the JSON text the owner
// saw.  Nothing ever told the daimon.  So the fixes are three: a write of invalid JSON is refused with its position (this file's
// WRITE cases), an unreadable or unparseable crystal makes `capture` say so in words and never draw `.empty` (the BROKEN cases), and
// the daimon's own prompt carries a must-fix line while the crystal on disk does not parse (the PROMPT case).
//
// The crystal here is shaped like Ontheism's: about 11.5 KB with a base64 logo of about 9.5 KB inside `summary`.
//
//   node dev/verify_crystalreal.mjs
import { open, steerDiamond, mockLog, clearMockLog, contentText } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const NAME = 'RealCrystal';

// A deterministic ~7 KB incompressible PNG-looking payload, base64'd to about 9.5 KB.
function logoB64() {
	const bytes = Buffer.alloc(7100);
	let x = 12345;
	for (let i = 0; i < bytes.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; bytes[i] = x >> 16 & 255; }
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	return bytes.toString('base64');
}
const CRYSTAL = {
	title: 'Ontheism: the Invitation',
	summary: 'The Invitation sets out the first principles of Ontheism. ![logo](data:image/png;base64,' + logoB64() + ') It is read slowly.',
	sections: [
		{ heading: 'The fabric', body: 'The fabric is divine but no one\'s god.' },
		{ heading: 'The mind', body: 'Mind is the bionous, "quoted", with a back\\slash and a tab\there.\nA second line.' },
		{ heading: 'Θntheon', body: 'Unicode: Θ, é, 日本語, emoji 🙂, and a line separator   inside.' },
	],
	facts: [{ label: 'Founded', value: '2026' }],
};
const JSON_TEXT = JSON.stringify(CRYSTAL, null, 2);

const s = await open({ name: 'crystalreal', signIn: true, connect: true, defaults: false,
	route: async (page) => { await page.setViewportSize({ width: 1280, height: 800 }); } });
const page = s.page;
console.log(`       crystal.json is ${Buffer.byteLength(JSON_TEXT)} bytes`);

await page.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
await page.waitForTimeout(900);
await page.fill('.dlg-input', NAME).catch(() => {});
await page.click('.dlg-ok', { force: true }).catch(() => {});
await page.waitForTimeout(2500);
const id = await page.evaluate(async (name) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.name === name);
	return d ? d.id : '';
}, NAME);
check('a Diamond was made', !!id, id);
const CRYSTAL_PATH = 'diamonds/' + id + '/crystal.json';

// The page's own door, which no tool guards: it plants whatever bytes a crystal might be found holding.
async function plant(text) {
	await page.evaluate(async ({ path, text }) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.write_file(path, text);
	}, { path: CRYSTAL_PATH, text });
}
async function stored() {
	return await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return await app.read_crystal_data(id);
	}, id);
}

// One tool call by the daimon, answered with the text its result carried.
async function daimon(tool, args) {
	clearMockLog();
	await steerDiamond(s, '@tool ' + tool + ' ' + JSON.stringify(args));
	const toolsIn = (r) => ((r && r.messages) || []).filter((m) => m.role === 'tool');
	let text = null;
	for (let i = 0; i < 240 && text === null; i++) {
		await page.waitForTimeout(500);
		const log = mockLog();
		if (!log.length) continue;
		const n0 = toolsIn(log[0]).length;
		const carrying = log.filter((r) => toolsIn(r).length > n0);
		if (carrying.length) { const t = toolsIn(carrying[carrying.length - 1]); text = contentText(t[t.length - 1].content); }
	}
	await page.waitForTimeout(1500);
	return text === null ? '' : text;
}
const show = (t) => console.log(t.split('\n').map((l) => '       | ' + l.slice(0, 220)).join('\n'));
await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
await page.waitForTimeout(900);

// ── VALID: the real crystal draws ──────────────────────────────────────────────────────────────
console.log('\nVALID');
await plant(JSON_TEXT);
const back = await stored();
check('the store gives the crystal back whole', back.length === JSON_TEXT.length, `${back.length} chars`);
{
	const t = await daimon('capture', { in: 'crystal', width: 1440 });
	show(t);
	check('a valid crystal, handed to the default page, draws: no `.empty` card', !/\.empty/.test(t));
	check('the outline has a title', /h1|\.title/.test(t));
}

// ── BROKEN: capture says why, and never draws the empty card ───────────────────────────────────
const BROKEN = {
	'a byte order mark':       '﻿' + JSON_TEXT,
	'a truncated file':        JSON_TEXT.slice(0, 2500),
	'a raw newline in a string': JSON_TEXT.replace('"The fabric"', '"The\nfabric"'),
	'a trailing comma':        JSON_TEXT.replace(/\n}$/, ',\n}'),
	'not an object':           '["title", "summary"]',
};
for (const [what, text] of Object.entries(BROKEN)) {
	console.log('\nBROKEN: ' + what);
	await plant(text);
	const t = await daimon('capture', { in: 'crystal', width: 1440 });
	show(t);
	check(`${what}: capture does not draw the empty card`, !/\.empty/.test(t));
	check(`${what}: it names crystal.json and says it is not valid JSON`, /crystal\.json/.test(t) && /not valid JSON|not one JSON object/i.test(t));
	check(`${what}: it gives a position`, /line \d+/.test(t) && /column \d+/.test(t));
}

// ── PROMPT: while the crystal does not parse, the daimon's own prompt says so ─────────────────
console.log('\nPROMPT');
{
	await plant(BROKEN['a truncated file']);
	clearMockLog();
	await steerDiamond(s, 'hello');
	let sys = '';
	for (let i = 0; i < 120 && !sys; i++) {
		await page.waitForTimeout(500);
		const log = mockLog();
		if (!log.length) continue;
		const m = ((log[0] && log[0].messages) || []).filter((x) => x.role === 'system');
		sys = m.map((x) => contentText(x.content)).join('\n');
	}
	await page.waitForTimeout(1500);
	check('the prompt carries the crystal text and a must-fix line naming the parse fault',
		/MUST FIX/.test(sys) && /not valid JSON/.test(sys), `${sys.length} chars of system`);
}

// ── WRITE: a crystal that does not parse is refused, with its position, and nothing changes ───
console.log('\nWRITE');
await plant(JSON_TEXT);
{
	const bad = '{\n  "title": "Ontheism",\n  "summary": "half a cry';
	const t = await daimon('file_write', { path: CRYSTAL_PATH, content: bad });
	show(t);
	check('file_write of truncated JSON is refused, naming line and column', /line \d+/.test(t) && /column \d+/.test(t) && /not valid JSON/.test(t));
	check('the crystal on disk is unchanged', (await stored()) === JSON_TEXT);
}
{
	const t = await daimon('file_write', { path: CRYSTAL_PATH, content: '﻿' + JSON_TEXT });
	show(t);
	check('file_write of a BOM-prefixed crystal is refused', /not valid JSON/.test(t) && /byte order mark/i.test(t));
	check('the crystal on disk is still unchanged', (await stored()) === JSON_TEXT);
}
{
	const t = await daimon('file_edit', { path: CRYSTAL_PATH, old_string: '"title": "Ontheism: the Invitation",', new_string: '"title": "Ontheism: the Invitation"' });
	show(t);
	check('file_edit that drops a comma is refused', /not valid JSON/.test(t) && /line \d+/.test(t));
	check('the crystal on disk is still unchanged after the edit', (await stored()) === JSON_TEXT);
}
{
	const good = JSON.stringify({ ...CRYSTAL, title: 'Ontheism: renamed' }, null, 2);
	const t = await daimon('file_write', { path: CRYSTAL_PATH, content: good });
	show(t);
	check('file_write of a valid crystal is not refused', !/not valid JSON/.test(t));
	check('the valid crystal was kept', (await stored()) === good);
	const c = await daimon('capture', { in: 'crystal', width: 1440 });
	check('and it draws', !/\.empty/.test(c) && /h1|\.title/.test(c));
}

console.log(`\n${ok} ok, ${bad} failed`);
await s.browser?.close?.().catch(() => {});
process.exit(bad ? 1 : 0);
