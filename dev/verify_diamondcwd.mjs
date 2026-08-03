// verify_diamondcwd.mjs — where a Diamond's command starts, now that the
// Diamond itself is not on the machine.
//
// A Diamond lives in the browser's storage under `diamonds/<id>` whatever
// workspace root is open (`is_store_path`, src/tools.rs). `default_cwd` used to
// hand `Tool::Run` that very path, and `fence_spec` turned it into
// `<granted-root>/diamonds/<id>` — a directory on the user's disk that Daimond
// no longer writes and that in general does not exist. The hand refuses a `cwd`
// it cannot canonicalise, so every command in a Diamond with no explicit `cwd`
// would have been refused, for ever, with "cannot be resolved to a directory on
// this machine": true, unhelpful, and pointing at a path the user never chose.
//
// What is pinned:
//   * a Diamond's command starts in its first ATTACHED folder, which is a real
//     place on the machine and inside the fence;
//   * a read-only attachment is still somewhere to start;
//   * a Diamond with nothing attached is refused in words that name the thing to
//     do about it, and the hand is never asked;
//   * an explicit `cwd` from the model is still honoured;
//   * an ordinary, unscoped turn still starts at the granted root.
//
// The hand is a stand-in that records what it was sent — the question here is
// which `cwd` the ENGINE composes, and a real hand would answer it by refusing
// a directory that does not exist on this machine, which is a different fact.
// dev/verify_scope.mjs drives the real binary for what the fence contains.
//
// Run with dev/serve.mjs up (:8777).
//
//	node dev/verify_diamondcwd.mjs
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const ROOT = '/home/somebody/project';

const s = await open({ name: 'diamondcwd', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

await p.evaluate(async (root) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	window.__d = { mod, root };
	// A stand-in hand: it says it can fence, and it writes down every spec.
	window.__sent = [];
	window.DaimondHand = {
		status: () => Promise.resolve(JSON.stringify({
			paired: true, transport: 'machine', machine: 'test', os: 'linux',
			root: root, caps: ['fence:linux', 'landlock:abi-8'],
		})),
		run: (spec) => {
			window.__sent.push(JSON.parse(spec));
			return Promise.resolve(JSON.stringify({
				t: 'exec_result', exit: 0, stdout: 'ran', stderr: '',
				out_bytes: 3, err_bytes: 0,
			}));
		},
	};
	window.__app = (scope) => {
		const app = new mod.DaimondApp(
			'http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		if (scope) {
			app.set_diamond_scope(scope.own, JSON.stringify(scope.attached || []),
				JSON.stringify(scope.read_only || []), JSON.stringify(scope.toolkits || []));
		}
		return app;
	};
	// One `run`, and what the hand was sent for it.
	window.__run = async (scope, args) => {
		window.__sent = [];
		const app = __app(scope);
		const said = await app.run_tool('run', JSON.stringify(args));
		return { said: said, sent: window.__sent };
	};
}, ROOT);

const run = (scope, args) => p.evaluate(([sc, a]) => __run(sc, a), [scope, args]);

// ── A Diamond with a folder attached ────────────────────────────────────

const attached = await run(
	{ own: 'diamonds/d1', attached: ['src/api'] }, { argv: ['ls'] });
check('a Diamond with a folder attached runs its command there',
	attached.sent.length === 1 && attached.sent[0].cwd === ROOT + '/src/api',
	JSON.stringify(attached.sent.map((x) => x.cwd)) + ' | ' + attached.said.slice(0, 80));
check('and not in its own directory, which is not on this machine at all',
	!JSON.stringify(attached.sent).includes('diamonds/d1"') || attached.sent[0].cwd !== ROOT + '/diamonds/d1',
	attached.sent.length ? attached.sent[0].cwd : '(nothing was sent)');

const readOnly = await run(
	{ own: 'diamonds/d2', attached: [], read_only: ['refs'] }, { argv: ['ls'] });
check('a read-only attachment is still somewhere to start',
	readOnly.sent.length === 1 && readOnly.sent[0].cwd === ROOT + '/refs',
	JSON.stringify(readOnly.sent.map((x) => x.cwd)) + ' | ' + readOnly.said.slice(0, 80));

// ── A Diamond with nothing attached ─────────────────────────────────────

const bare = await run({ own: 'diamonds/d3', attached: [] }, { argv: ['ls'] });
check('a Diamond with nothing attached is refused',
	/^Refused/.test(bare.said), bare.said.slice(0, 120));
check('and told what to do about it, in the user\'s own vocabulary',
	/attach/i.test(bare.said) && /Workspace panel/i.test(bare.said)
		&& /cwd/.test(bare.said),
	bare.said.slice(0, 200));
check('and the hand was never asked, so nothing ran',
	bare.sent.length === 0, JSON.stringify(bare.sent).slice(0, 120));

// ── What the model asked for still wins ─────────────────────────────────

const named = await run(
	{ own: 'diamonds/d4', attached: ['src/api'] }, { argv: ['ls'], cwd: 'src/api/inner' });
check('a cwd the model named is still honoured',
	named.sent.length === 1 && named.sent[0].cwd === ROOT + '/src/api/inner',
	JSON.stringify(named.sent.map((x) => x.cwd)));

// A Diamond may not name a cwd outside its own workspace, which is a different
// refusal and must not be swallowed by the new one.
const outside = await run(
	{ own: 'diamonds/d5', attached: ['src/api'] }, { argv: ['ls'], cwd: 'elsewhere' });
check('and one outside the Diamond is still refused as out of scope',
	/^Refused/.test(outside.said) && /not in this Diamond's workspace/.test(outside.said)
		&& outside.sent.length === 0,
	outside.said.slice(0, 120));

// ── The ordinary turn is untouched ──────────────────────────────────────

const plain = await run(null, { argv: ['ls'] });
check('an unscoped turn still starts at the granted root',
	plain.sent.length === 1 && plain.sent[0].cwd === ROOT,
	JSON.stringify(plain.sent.map((x) => x.cwd)) + ' | ' + plain.said.slice(0, 80));

const noise = s.errs.filter((e) =>
	!/favicon|ERR_ABORTED|net::ERR|Failed to load resource/i.test(e));
check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));

await s.close();
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
