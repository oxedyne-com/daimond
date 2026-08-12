// verify_typstdriver.mjs — the Typst tool can be reached, and what it writes lands in the right root.
//
// The compiler was wired to a human's Compile button and to nothing else. `window.DaimondTypst` is
// the ONE object the Rust `typst_compile` tool looks for, and it is installed by a MODULE -- so
// until something imported that module the object did not exist, the tool was in the belt and
// could never work, and a model asked to produce a PDF correctly reported that it could not.
//
// Three claims:
//
//   1. The driver is there at boot, with nothing having opened a .typ file. That is the whole of
//      what the tool needs, and it costs only the ~4 KB module: the 30 MB compiler wasm is still
//      built lazily, on the first actual compile.
//   2. It really compiles. A driver that installs and then fails is worse than none, because the
//      tool is now advertised. (This one is slow -- it builds the compiler -- and it is the check
//      that would have caught the local MIME bug that made every compile fail as "compiler failed
//      to load".)
//   3. The bytes go to the workspace through the WASM write, which is what applies the path jail,
//      the real-folder override and the per-account namespace. Asserted by setting a namespace and
//      finding the PDF inside it rather than at the origin root.
//
// WHAT CHANGED WHEN TYPESETTING WAS SOLD. Claims 2 and 3 used to prove the compile worked FOR
// EVERYONE, which is no longer what the app claims: typesetting is a pack now, and an account that
// has not bought it is refused at the driver. Read literally, this file would have gone red on a
// correct build -- and the tempting fix, deleting the compiles, would have thrown away the only
// check that the compiler works at all.
//
// So the three claims stand, and the account they are made about is stated instead of assumed:
// each compile below first makes sure the pack is HELD, which is the condition under which "it
// compiles" was ever true. The refusal is not tested here. It has a file of its own,
// `dev/verify_typstpack.mjs`, which drives all three doors into the compiler; this one goes on
// answering the question it was written for -- is the compiler reachable and does it write to the
// right place -- for the customer who is entitled to an answer.
import { open, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const NS  = 'd~typstdriver';
const SRC = 'paper.typ';
const PDF = 'paper.pdf';

const s = await open({ name: 'typstdriver' });
const p = s.page;
await p.waitForTimeout(1500);

const atBoot = await p.evaluate(() => ({
	installed: !!(window.DaimondTypst && typeof window.DaimondTypst.compile === 'function'),
	// Nothing has opened a .typ file, so if the object is here it was put here at boot.
	opened:    !!document.querySelector('.files-view'),
}));
check('the Typst driver is installed at boot, with no file opened',
	atBoot.installed === true && atBoot.opened === false,
	`installed: ${atBoot.installed}, a file view open: ${atBoot.opened}`);

// The compiles below are the ENTITLED account's, so say so rather than relying on a fresh profile
// happening to have been told nothing. Stated once, and asserted, so this file cannot quietly
// become a test of the refusal and go on calling itself a test of the compiler.
const held = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_locked_packs('');
	return mod.tool_locked('typst_compile');
});
check('the account these claims are made about holds the typesetting pack',
	held === false, `typst_compile locked: ${held}`);

const built = await p.evaluate(async () => {
	const r = await window.DaimondTypst.compile('= A heading\n\nA paragraph, and $x^2 + y^2$.\n');
	return {
		error: r.error || '',
		bytes: r.pdf ? r.pdf.length : 0,
		magic: r.pdf ? String.fromCharCode.apply(null, Array.from(r.pdf.slice(0, 5))) : '',
	};
});
check('and it compiles a real document to real PDF bytes',
	built.error === '' && built.magic === '%PDF-' && built.bytes > 1000,
	built.error || `${built.bytes} bytes, magic "${built.magic}"`);

// The tool's own round trip: source in the workspace, compiled, written back beside it -- under an
// account namespace, which is the thing a hand-rolled OPFS walk in the page could never honour.
await p.evaluate(async ({ ns, src }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_account_ns(ns);
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	await app.run_tool('file_write', JSON.stringify({ path: src, content: '= Written by the tool\n' }));
}, { ns: NS, src: SRC });

const wrote = await p.evaluate(async ({ ns, src, pdf }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const text = await app.run_tool('file_read', JSON.stringify({ path: src }));
	const out  = await window.DaimondTypst.compile(text);
	if (out.error) return { error: out.error };
	await app.write_bytes(pdf, out.pdf);
	const root = await navigator.storage.getDirectory();
	const at = async (d, n) => { try { await d.getFileHandle(n); return true; } catch (e) { return false; } };
	let sub = null;
	try { sub = await root.getDirectoryHandle(ns); } catch (e) { sub = null; }
	return {
		error: '',
		inNamespace: sub ? await at(sub, pdf) : false,
		atRoot:      await at(root, pdf),
	};
}, { ns: NS, src: SRC, pdf: PDF });

check('a compiled PDF is written into the workspace through the wasm',
	wrote.error === '' && wrote.inNamespace === true,
	wrote.error || `in ${NS}/: ${wrote.inNamespace}`);
check("and never into another account's root",
	wrote.atRoot === false, `at the OPFS root: ${wrote.atRoot}`);

await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_account_ns('');
});

await shot(s, 'typstdriver');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
