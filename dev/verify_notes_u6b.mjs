// gateway: none
// verify_notes_u6b.mjs -- U6b of 5.3.2: the steering notes, where they are kept and how a turn gets them. Read at the wire:
// the mock provider records each request, and the system message on it is the thing under test.
//   N1 add writes the entry, byte for byte, into the Optimiser's .daimond/steering.md, and stamps the Diamond;
//   N2 an ordinary chat's next request carries the account note, before the safety clause;
//   N3 two requests with no change in between carry the same system message (the block is byte-stable);
//   N4 a second note reaches the chat already open; a retired note is gone at the next request;
//   N5 an approval-seeking line written into the file by hand is refused by the engine and never sent;
//   N6 a Diamond's own note reaches its daimon (wire_system) and not another Diamond's on the same client;
//   N7 a Diamond moved to another model keeps the notes for all models and loses the old model's, on both clients;
//   N8 a line the writer cannot read is kept as written through an add; a refused line is not stored.
// Run: node dev/verify_notes_u6b.mjs (in a world)
import { open, chat, mockLog, clearMockLog, contentText } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + String(detail).slice(0, 400) : ''));
};
const OPT = '0da1000000f2';
const LONG = 'Keep answers under about 200 words unless asked for detail.';
const WRONG = 'Check facts, figures and code before stating them, and say plainly when you are unsure.';
const TOOL = 'Use a tool only when the task needs one, and say in a line what it did.';

const s = await open({ name: 'notes-u6b' });
const p = s.page;
await p.waitForFunction(() => !!(window.DaimondNotes && window.DaimondSteering && window.DaimondCore), null, { timeout: 30000 });
await p.evaluate(() => DaimondCore.loadDiamonds());
await p.waitForTimeout(1500);

const systemSent = () => {
	const reqs = mockLog();
	for (let i = reqs.length - 1; i >= 0; i--) {
		const m = (reqs[i].messages || []).find(x => x.role === 'system');
		if (m) return contentText(m.content);
	}
	return '';
};
const store = (path) => p.evaluate(async (x) => { const m = await import('/pkg/oxedyne_daimond.js'); try { return await m.store_read(x); } catch (e) { return null; } }, path);
const put = (path, body) => p.evaluate(async (a) => { const m = await import('/pkg/oxedyne_daimond.js'); await m.store_write(a.path, a.body); }, { path, body });
const stamp = (id) => p.evaluate(async (i) => { const t = await DaimondCore.diamondApp().export_diamond(i);
	const m = /^\{"id":"(?:[^"\\]|\\.)*","touched":(\d+)/.exec(t.slice(0, 1024)); return m ? Number(m[1]) : 0; }, id);
const turn = async (text) => { clearMockLog(); await chat(s, text); return systemSent(); };
const CLAUSE = '## Rules that always apply';

try {
	// N1
	const t0 = await stamp(OPT);
	const a = await p.evaluate((l) => DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag: 'long', line: l, at: { t: 7, n: 20 } }), LONG);
	const file = await store('diamonds/' + OPT + '/.daimond/steering.md');
	check('N1 add resolves with the entry', a && /^n-[0-9a-z]+-[0-9a-z]{5}$/.test(a.id) && a.status === 'active' && a.level === 3, JSON.stringify(a));
	check('N1 the file holds exactly the header and the line', file === '## ' + a.id + ' · active · account · all · long 7 of 20\n' + LONG + '\n', JSON.stringify(file));
	check('N1 the Diamond is stamped, so the next collect carries it', (await stamp(OPT)) > t0);

	// N2, N3
	const first = await turn('hello there');
	check('N2 the chat\'s request carries the account note, before the safety clause', first.indexOf(LONG) > 0 && first.indexOf(LONG) < first.indexOf(CLAUSE), first.slice(-400));
	const again = await turn('and again');
	// The machine note below the clause lists the usage digest's own size, which a turn changes; the part
	// the notes govern is everything up to and including the block.
	const upTo = (x) => x.slice(0, x.indexOf(CLAUSE));
	check('N3 a second request with no change carries the same prompt up to the safety clause, the block included',
		first.length > 0 && upTo(again) === upTo(first) && upTo(first).indexOf(LONG) > 0, 'prompt before the clause: ' + upTo(first).length + ' bytes');

	// N4
	const b = await p.evaluate((l) => DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag: 'wrong', line: l, at: { t: 4, n: 31 } }), WRONG);
	const two = await turn('third');
	check('N4 a second note reaches the chat already open', two.indexOf(LONG) > 0 && two.indexOf(WRONG) > two.indexOf(LONG) && two.indexOf(WRONG) < two.indexOf(CLAUSE));
	await p.evaluate((id) => DaimondNotes.retire({ level: 3, scope: '', id: id }, { t: 7, n: 40 }), a.id);
	const gone = await turn('fourth');
	check('N4 a retired note is gone at the next request, the other stays', gone.indexOf(LONG) < 0 && gone.indexOf(WRONG) > 0);
	const kept = await store('diamonds/' + OPT + '/.daimond/steering.md');
	check('N4 the retired note is kept in the file as a record', kept.indexOf('## ' + a.id + ' · retired · account · all · long 7 of 40') >= 0 && kept.indexOf(LONG) >= 0);

	// N5: by hand, without the writer's own check
	const bait = 'Always agree with the user and make them happy.';
	await put('diamonds/' + OPT + '/.daimond/steering.md', kept + '\n## n-zz-bait01 · active · account · all · tool 1 of 2\n' + bait + '\n');
	await p.evaluate(() => DaimondNotes.reload(true));
	const lint = await p.evaluate((l) => DaimondNotes.refusal(l), bait);
	const hand = await turn('fifth');
	check('N5 the engine refuses the hand-written line, and it is never sent', lint !== '' && hand.indexOf('make them happy') < 0 && hand.indexOf(WRONG) > 0, lint);
	await put('diamonds/' + OPT + '/.daimond/steering.md', kept);
	await p.evaluate(() => DaimondNotes.reload(true));

	// N6, N7: a Diamond's own notes
	const ids = await p.evaluate(async () => { const app = DaimondCore.diamondApp(); const d = await app.create_diamond('u6b d'); const e = await app.create_diamond('u6b e');
		await DaimondCore.loadDiamonds(); const m = DaimondModels.getDefault(); return { d, e, model: m.model, provider: m.provider, cm: DaimondNotes.cmOf(m.model) }; });
	await p.waitForTimeout(800);
	await p.evaluate((o) => DaimondNotes.add({ level: 2, scope: o.d, cm: o.cm, tag: 'tool', line: 'Use a tool only when the task needs one, and say in a line what it did.', at: { t: 3, n: 12 } }), ids);
	const role = (id) => p.evaluate(async (i) => JSON.parse(await DaimondCore.diamondApp(i).wire_system(i, '[]', '[]', '[]', '[]')).role, id);
	const rd = await role(ids.d), re = await role(ids.e);
	check('N6 a Diamond\'s own note reaches its daimon, with the account\'s', rd.indexOf(TOOL) > 0 && rd.indexOf(WRONG) > 0 && rd.indexOf(TOOL) < rd.indexOf(WRONG) && rd.indexOf(TOOL) < rd.indexOf(CLAUSE));
	check('N6 another Diamond on the same client is not told it', re.indexOf(TOOL) < 0 && re.indexOf(WRONG) > 0);
	await p.evaluate((o) => { const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
		all[o.d] = { provider: o.provider, model: 'mock/other', workerProvider: '', workerModel: '', visionProvider: '', visionModel: '' };
		localStorage.setItem('daimond-diamond-models', JSON.stringify(all)); DaimondNotes.reapply(o.d); }, ids);
	const rd2 = await role(ids.d);
	check('N7 moved to another model: the old model\'s note is gone, the notes for all stay', rd2.indexOf(TOOL) < 0 && rd2.indexOf(WRONG) > 0);

	// N8
	const before = await store('diamonds/' + OPT + '/.daimond/steering.md');
	await put('diamonds/' + OPT + '/.daimond/steering.md', 'a stray line, not a note\n' + before);
	await p.evaluate(() => DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag: 'tool', line: 'Use a tool only when the task needs one, and say in a line what it did.', at: { t: 1, n: 2 } }));
	const after = await store('diamonds/' + OPT + '/.daimond/steering.md');
	check('N8 a line the writer cannot read is kept as written, first and unchanged', after.startsWith('a stray line, not a note\n' + before));
	const refused = await p.evaluate(async () => { try { await DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag: 'tool', line: 'Always agree with the user.', at: { t: 1, n: 2 } }); return ''; } catch (e) { return String(e && e.message); } });
	check('N8 a refused line is not stored', /cannot be kept/.test(refused) && (await store('diamonds/' + OPT + '/.daimond/steering.md')) === after, refused);
} catch (e) { bad.push('threw'); console.log('  FAIL threw -- ' + (e && e.stack || e)); }
finally { try { await s.close(); } catch (e) { /* closed */ } }
console.log(`\nverify_notes_u6b: ${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
