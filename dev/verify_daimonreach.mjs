// verify_daimonreach.mjs — a daimon reaches what its Diamond holds.
//
// THE DEFECT THIS PINS, and it is the one a user hit on 2026-08-13. A 281-page
// Typst book was attached to a Diamond. The user asked its daimon to set up an
// editing loop over it. The daimon globbed `**/*chap*`, `**/*.typ` and `books/**`,
// found nothing, and reported that the book did not exist — then offered to CREATE
// the manuscript. All of that was correct behaviour from where it was standing:
// `src/wasm/app.rs` gave the steering turn `path_prefix: diamonds/<id>` and
// `root: FileRoot::Opfs`, so `.` was the Diamond's own scaffold in browser storage
// and the user's disk was not the filesystem it was looking at. The attachment had
// always reached the WORKERS (`scopeAgentTo`, www/js/daimond.js) and never the
// daimon that commands them.
//
// So, four properties, and the fourth is the one that turns a wrong answer into a
// destroyed afternoon:
//
//   1. A DAIMON READS WHAT ITS DIAMOND HOLDS, by the path the user would name.
//      Not `diamonds/<id>/books/...`, which is where a prefix put it — `books/...`.
//   2. A DAIMON WRITES WHERE THE USER MARKED, and nowhere else. Reading is free
//      across the workspace (2026-08-13, `diamond_bounds`); writing is the mark.
//   3. ITS OWN CRYSTAL IS STILL ITS OWN. The Diamond's directory lives in OPFS
//      whatever folder is open, and `FileRoot::Workspace` must not follow the real
//      folder for a store path or a daimon loses its memory to gain a book.
//   4. THE DAIMON IS TOLD WHAT IT HOLDS. A model that has to discover an
//      attachment can conclude it is absent; one that is told cannot. This is the
//      check that would have caught the whole incident in one line.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST.
//
//   node dev/verify_daimonreach.mjs --break nomarks   # 2 and 4 fail: the page reports no marks
//   node dev/verify_daimonreach.mjs --break allmarks  # 2 fails: every path is a mark
//   node dev/verify_daimonreach.mjs                   # and then, clean
//
// The breaks go on WHAT THE PAGE ASKS FOR and never on the engine, for the reason
// `dev/verify_chatscope.mjs` gives: the engine is the thing under test, and a break
// that damaged it would prove only that a damaged engine misbehaves.
//
// ONE PROPERTY HAS NO BREAK HERE, AND IT IS PROPERTY 1 — say so rather than let a
// green imply otherwise. What broke it was the PIN, two fields in a Rust struct
// that no page can set, so there is no caller mistake to simulate. Its red proof is
// the previous build, which has the pin: check out the commit before this change,
// build the wasm, and run this file. That is written in the report rather than left
// as an exercise, because a check whose red has never been seen is not evidence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, clearMockLog, mockLog } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// The page-side breaks: a caller that reports no marks, and one that reports
// everything as a mark. Both are mistakes somebody could actually make in
// `steerCrystal` — the first by forgetting the await, the second by handing over
// the paperclip's whole list the way ATTACH_CONTRACT.md §6 warns against.
const BREAKS = {
	nomarks: {
		file: 'js/daimond.js',
		find: 'JSON.stringify(marks.attached  || []),',
		with: 'JSON.stringify([]),',
	},
	allmarks: {
		file: 'js/daimond.js',
		find: 'JSON.stringify(marks.attached  || []),',
		with: 'JSON.stringify((marks.attached || []).concat([\'elsewhere\'])),',
	},
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'daimonreach', signIn: false, connect: false });
const { page } = s;

if (BREAK) {
	const spec = BREAKS[BREAK];
	if (!spec) { console.error(`no such break: ${BREAK}`); process.exit(2); }
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	await page.route('**/' + spec.file, r => r.fulfill({
		status: 200, contentType: 'application/javascript', body,
	}));
}

await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
await signInAs(s, 'daimonreach');
await connectMock(s);
await page.waitForTimeout(1500);

try {
	// The user's files, laid down through an UNSCOPED app — which is also the
	// reader used below, so "the refusal is real" is asserted against the disk and
	// never against the reply text.
	await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		window.__free = app;
		const put = (p, content) => app.run_tool('file_write', JSON.stringify({ path: p, content }));
		await put('books/CheapThinking/ch05.typ', '= Chapter five\nThe words the user wrote.\n');
		await put('books/CheapThinking/main.typ', '#include "ch05.typ"\n');
		await put('elsewhere/private.md',         'not this Diamond\'s business\n');
	});

	// A Diamond, made the way a person makes one so the rail knows about it.
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Cheap Thinking');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(2000);
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForTimeout(1200);

	const id = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Cheap Thinking');
		return d ? d.id : '';
	});
	check('a Diamond to attach the book to', !!id, id);

	// Attached through its own control, so what is under test is what the PAPERCLIP
	// records and what `Files.bounds` then reports — not a link this file wrote.
	await page.evaluate(() => DaimondPanels.show('work'));
	await page.waitForTimeout(700);
	await page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await page.waitForTimeout(1200);
	let attached = false;
	for (const row of await page.$$('#panel-work .files-row')) {
		const nm = await row.$eval('.files-name', e => e.textContent).catch(() => '');
		if (nm.replace(/^[^A-Za-z0-9._-]+/, '').trim() === 'books') {
			const clip = await row.$('.attach-btn');
			if (clip) { await clip.click({ force: true }); attached = true; }
			break;
		}
	}
	check('the book folder could be attached through the paperclip', attached,
		attached ? '' : 'no books row with an attach control');
	await page.waitForTimeout(1200);

	// ── The engine, driven directly with the marks the page would report ──
	//
	// A real steer turn through the real mock provider: `@tool` makes the daimon
	// call the tool named, so what is measured is a tool running inside a daimon's
	// own context and not a call this file made on its behalf.
	// The world's OWN mock, passed in rather than defaulted: world 0's port is the
	// historical constant, and an app pointed at a mock nobody started fails as an
	// upstream error that reads exactly like a broken engine.
	const MOCKURL = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
	const steer = async (instruction, marks, ro) => await page.evaluate(async (a) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp(a.mock, 'mock-key', 'mock/fast', 4096, '', true);
		const seen = [];
		const after = await app.steer_crystal(a.id, a.instruction,
			JSON.stringify(a.marks), JSON.stringify(a.ro), [],
			(ev) => { seen.push({ type: ev.type, name: ev.name || '', content: ev.content || '' }); });
		return { seen, after: Array.prototype.slice.call(after || []).length };
	}, { id, instruction, marks, ro, mock: MOCKURL });

	const resultOf = (r, name) => (r.seen.find(e => e.type === 'tool_result'
		&& (!name || e.name === name)) || {}).content || '';

	// `books` and not `books/CheapThinking`: the paperclip above was pressed on the
	// `books` row, and the mark is what the control recorded. A verifier that
	// asserted the deeper path would be testing its own idea of the attachment.
	const marks = BREAK === 'nomarks'  ? []
		: BREAK === 'allmarks' ? ['books', 'elsewhere']
		: ['books'];

	// 1. THE READ. By the path the user would name, from outside the Diamond's own
	//    folder. Under the pin this came back as "not found" — the prefix had made
	//    it `diamonds/<id>/books/CheapThinking/ch05.typ`, which nothing ever wrote.
	const r1 = await steer('@tool file_read {"path":"books/CheapThinking/ch05.typ"}', marks, []);
	const got1 = resultOf(r1, 'file_read');
	check('A DAIMON READS THE BOOK ITS DIAMOND HOLDS, by the path the user would name',
		/The words the user wrote/.test(got1), got1.slice(0, 90).replace(/\n/g, ' '));

	// The control beside it, and it is not decoration: a refusal proves something
	// only when the permission beside it shows the mechanism was live. Reading is
	// free across the workspace, so an UNMARKED path reads too — and if this one
	// ever fails, the refusal below is refusing everything rather than refusing
	// that.
	const r2 = await steer('@tool file_read {"path":"elsewhere/private.md"}', marks, []);
	check('reading is free across the workspace, mark or no mark',
		/not this Diamond/.test(resultOf(r2, 'file_read')),
		resultOf(r2, 'file_read').slice(0, 60).replace(/\n/g, ' '));

	// 2. THE WRITE, inside the mark, proved on the disk rather than in the reply.
	await steer('@tool file_write {"path":"books/CheapThinking/notes.md","content":"the daimon was here\\n"}',
		marks, []);
	const wrote = await page.evaluate(() => window.__free
		.run_tool('file_read', JSON.stringify({ path: 'books/CheapThinking/notes.md' })).then(String));
	check('A DAIMON WRITES WHERE THE USER MARKED', /the daimon was here/.test(wrote),
		wrote.slice(0, 60).replace(/\n/g, ' '));

	//    And nowhere else. Asserted against the FILE: a refusal and a write that
	//    silently went somewhere else read the same in a reply.
	await steer('@tool file_write {"path":"elsewhere/private.md","content":"clobbered\\n"}', marks, []);
	const intact = await page.evaluate(() => window.__free
		.run_tool('file_read', JSON.stringify({ path: 'elsewhere/private.md' })).then(String));
	check('AND NOWHERE ELSE — an unmarked file is not written',
		/not this Diamond/.test(intact) && !/clobbered/.test(intact),
		intact.slice(0, 60).replace(/\n/g, ' '));

	// 3. Its own crystal, which is a STORE path and must still resolve in OPFS
	//    however the workspace root is set. This is what `FileRoot::Workspace`
	//    would have cost if `resolve_root` did not carve store paths out of the
	//    override — a daimon that gained a book and lost its memory.
	//    Seeded first, and the check looks for the SEED. It read `crystal.json` on a
	//    fresh Diamond before that, where the answer is "is empty (0 bytes)" — a
	//    sentence that satisfies "no refusal and not nothing" whether the store path
	//    routed correctly or not. An absent subject passes almost any negative
	//    assertion, so the subject is put there and named.
	await page.evaluate((did) => window.__free.run_tool('file_write', JSON.stringify({
		path: 'diamonds/' + did + '/crystal.json',
		content: '{"title":"Cheap Thinking","summary":"the-crystal-marker"}\n',
	})), id);
	const r3 = await steer(`@tool file_read {"path":"diamonds/${id}/crystal.json"}`, marks, []);
	const got3 = resultOf(r3, 'file_read');
	check('ITS OWN CRYSTAL IS STILL ITS OWN', /the-crystal-marker/.test(got3),
		got3.slice(0, 70).replace(/\n/g, ' '));

	// 3b. A PICTURE IS NOT SHOWN BY READING IT, and can be had as bytes for a page.
	//
	// The wasm arm of `file_read` is a different function from the native one the Rust tests
	// cover, and this is the arm the app actually runs. A one-pixel PNG, written as bytes so
	// the sniff sees a real header.
	await page.evaluate(async () => {
		const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nG'
			+ 'P4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		await window.__free.write_bytes('books/CheapThinking/cover.png', bytes);
	});
	const rDesc = await steer('@tool file_read {"path":"books/CheapThinking/cover.png"}', marks, []);
	const desc = resultOf(rDesc, 'file_read');
	check('READING A PICTURE DESCRIBES IT AND DOES NOT SHOW IT',
		/is an image/.test(desc) && /NOT attached/.test(desc) && /image\/png/.test(desc),
		desc.slice(0, 80).replace(/\n/g, ' '));
	const rB64 = await steer(
		'@tool file_read {"path":"books/CheapThinking/cover.png","as":"base64"}', marks, []);
	const b64out = resultOf(rB64, 'file_read');
	check('AND ITS BYTES COME BACK AS A data: URI, which is all a crystal page may load',
		/data:image\/png;base64,iVBORw0KGgo/.test(b64out),
		b64out.slice(0, 80).replace(/\n/g, ' '));

	// 3c. THE DAIMON HOLDS THE TOOLS THAT ACT ON A MACHINE.
	//
	// `run`, `file_show` and `typst_compile` were withheld while the daimon was pinned to
	// browser storage, where a command has nowhere to run. The pin went; they arrived. Asserted
	// through what the model is actually OFFERED -- the mock logs the tool names it was sent --
	// because a tool named in the prompt and absent from the registry is the shape that had the
	// daimon telling its user the app could not show a file (`artefact_add`, same day).
	const offered = (() => {
		const lines = mockLog();
		for (let i = lines.length - 1; i >= 0; i--) {
			const req = lines[i] || {};
			const msgs = req.messages || [];
			const sys = msgs.find(m => m.role === 'system');
			if (sys && /daimon/i.test(String(sys.content || ''))) {
				return (req.tools || []).map(String);
			}
		}
		return [];
	})();
	for (const want of ['run', 'file_show', 'typst_compile', 'artefact_add', 'spawn_agent']) {
		check('the daimon is offered ' + want, offered.indexOf(want) >= 0,
			offered.length ? offered.length + ' tools offered' : 'no daimon request in the log');
	}

	// 4. THE DAIMON IS TOLD. Through the REAL page path — the crystal composer, the
	//    real `Files.bounds`, the real `steerCrystal` — so this is also the check
	//    that the wiring has a production caller at all.
	clearMockLog();
	await page.evaluate(() => DaimondPanels.show('ai'));
	await page.waitForTimeout(400);
	const { steerDiamond } = await import('./harness.mjs');
	await steerDiamond(s, '@text noted').catch(() => {});
	await page.waitForTimeout(2500);
	const sys = (() => {
		const lines = mockLog();
		for (let i = lines.length - 1; i >= 0; i--) {
			const msgs = (lines[i] || {}).messages || [];
			const first = msgs.find(m => m.role === 'system');
			if (first && /daimon/i.test(String(first.content || ''))) return String(first.content);
		}
		return '';
	})();
	check('THE DAIMON IS TOLD WHAT IT HOLDS, in its own system prompt',
		/Attached to this Diamond/.test(sys) && /`books`/.test(sys),
		sys ? 'prompt seen, ' + sys.length + ' chars' : 'no daimon system prompt in the mock log');
	check('and it is told where its own folder is, so it addresses the crystal by a whole path',
		sys.includes('diamonds/' + id), sys ? '' : 'no prompt');

} catch (e) {
	check('the run completed', false, String(e && e.message || e));
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
