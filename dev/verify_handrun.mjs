// verify_handrun.mjs — a daimon runs a command on the machine, end to end.
//
// `dev/verify_hand.mjs` drives the EXTENSION's relay from a stub page: it proves
// order, attribution, gaps and the several ways a native host can vanish. It
// never loads the app, so it proves nothing about the half a user actually
// meets — the model calling `run`, the page relay carrying it, and the output
// coming back as a tool result the model reads. That is this file.
//
// The whole path, in one browser: sign in, connect the mock provider, ask a
// daimon to run a command, approve the machine hand for real in the extension's
// own window, and then read what the MODEL was shown. The assertions are made
// against the mock provider's log rather than against the screen, because the
// question is not "did something appear" but "did the output and the exit code
// reach the model".
//
// It runs against `hand/install/mock_host.py`, not the Rust binary. The host's
// message loop is being written; more to the point, the failures worth testing —
// a hand that says something meaningless for ever, a hand that says nothing at
// all for a minute, a hand that dies mid-command — are things a correct hand
// will never do, so a correct hand cannot be used to test them.
//
// WHAT THIS DOES NOT PROVE. The mock runs nothing. It invents output on a
// schedule and reports whatever exit status it was configured with, so a pass
// here says the pipeline carries a command's output and status faithfully from
// the host to the model. It does NOT say that `cargo test` ran, or that the
// fence held: nothing in this file executes a process, and the fence is the
// hand's to enforce and `hand/REVIEW.md`'s to argue about.
//
// ── A CHAT HAS A WORKSPACE, and a command runs where the user marked ─
//
// Rewritten on 2026-08-13. From 5389864 a chat's commands run only in the
// folders the user marked into that chat's workspace, and this file drove a
// chat that had marked in nothing — so `Tool::Run` refused every command on the
// `default_cwd` path, in its own words, BEFORE the fence was ever consulted, and
// thirteen checks went red against the world as it used to be rather than
// against a defect. The refusal was right; the fixture was out of date.
//
// So the run now has two halves, and each is worth exactly as much as the other:
//
//   * WITH NOTHING MARKED IN, a command is refused and the sentence says what to
//     do about it — and the host is never asked to exec anything at all.
//   * WITH A FOLDER MARKED IN, through the control a person presses, every
//     command below runs, AND THE HOST'S OWN LOG SAYS IT WAS DISPATCHED INTO
//     THAT FOLDER, with a fence naming it and nothing else.
//
// The second half is what makes the first mean anything. A refusal on its own is
// also what a wholly broken pipeline produces, which is how `verify_scope`'s
// compartment checks stayed green through an outage on 2026-08-12: nothing could
// read anything, so every "it cannot reach that" passed.
//
// The folder is marked in through the `+` in the chat footer's workspace group —
// the app's own control, driven as a person drives it — and the folder it offers
// is a folder that really is in the page's workspace, because the picker lists
// what `Files.entries` lists and nothing else. It mirrors a real directory under
// the folder the hand says it was granted, which is what makes it a place a
// command could actually run. A fixture that instead wrote the holding onto the
// chat record itself would be proving the fence against a world only this file
// ever built, which is the mistake `dev/verify_scope.mjs` made.
//
// EACH HALF IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// damaged `www/js/daimond.js` to the real page through `page.route`; the run is
// then expected to FAIL, and a break whose anchor does not match aborts rather
// than passing quietly. Both breaks damage THE SCOPE THE PAGE ASKS FOR and never
// the engine, which is the thing under test.
//
//   node dev/verify_handrun.mjs --break nomark       # the mark never reaches the engine
//   node dev/verify_handrun.mjs --break inventscope  # the page invents a workspace
//   node dev/verify_handrun.mjs                      # and then, clean
//
// Needs nothing running: the dev server and the mock provider are started here
// if they are not already up. Headed, under xvfb:
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_handrun.mjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open as openApp, newChat, chat, transcript, mockLog, clearMockLog, scratch } from './harness.mjs';
import { whyStaleWasm, refuse } from './staleguard.mjs';

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const WWW	= path.join(ROOT, 'www');
// The SHIPPED extension. `harness.open` hands this to `dev/extdev.mjs`, which
// loads the development build instead: the shipped manifest names one origin,
// `daimond.oxedyne.com`, and a page on localhost cannot reach it at all. The
// loopback origins live in the generated tree and never in the file a release
// is carved from — see extdev.mjs, and `hand/REVIEW.md` §1.6 for why.
const SRC	= path.join(ROOT, 'ext');
const EXTID	= 'mpliijponglmmffjnonahhignkpkhmij';
const INSTALL	= path.join(ROOT, 'hand/install');
const MOCK	= path.join(INSTALL, 'mock_host.py');
const CFG	= path.join(INSTALL, 'mock_cfg.json');
// Everything the mock host was sent and everything it sent back, in its own
// words. It is the only oracle in this file that is not the app talking about
// itself, which is what makes it the right place to ask where a command was
// dispatched to.
const HOSTLOG	= path.join(INSTALL, 'mock_host.log');
const PROFILE	= scratch('verify-handrun');

// The folder the hand claims it was granted. Nothing is written there — the
// mock runs nothing — but it must be absolute, because `Tool::run` refuses a
// root that is not, and every fence path is built from it.
const GRANT	= scratch('handroot');
// THE FOLDER THE USER MARKS INTO THE CHAT'S WORKSPACE, in two places at once,
// because that is what one folder is in this app: a directory under the granted
// root, which is where a command would run, and an entry in the page's own
// workspace, which is what the picker lists and what the mark is made against.
// A name in only one of the two is a name for nothing.
const MARKED	= 'marked';
const MARKED_ABS = path.join(GRANT, MARKED);

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Both damage the page's answer to "what did the user mark into this chat?", and
// neither touches the engine that acts on it.
const BREAKS = {
	// The mark is made, the footer draws it, and the engine is handed nothing —
	// which is what the app did for every chat before the mark existed, and what a
	// caller does who forgets that `ws` is the field the fence is built from. The
	// refusal half stays green; everything that needs a folder goes red.
	nomark: {
		file: 'js/daimond.js',
		find: `			.filter(function (a) { return !!a.ws; })`,
		with: `			.filter(function (a) { return false && !!a.ws; })`,
	},
	// The other direction, and the dangerous one: the page hands over a folder
	// nobody marked in. Every command then runs, including the ones sent by a chat
	// whose workspace is empty — so the refusal half goes red and nothing else
	// does, which is exactly the check that half is for.
	inventscope: {
		file: 'js/daimond.js',
		find: `		if (trashed(chatId)) return [];`,
		with: `		if (trashed(chatId)) return [];\n\t\treturn ['${MARKED}'];`,
	},
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Serve one deliberately damaged file in place of the real one, before the app
/// is ever loaded. An anchor that does not match exactly once aborts the run: a
/// break that broke nothing would leave a green summary meaning the opposite of
/// what it says.
async function installBreak(page) {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	if (!spec) {
		console.error(`--break ${BREAK}: no such break. One of: ${Object.keys(BREAKS).join(', ')}`);
		process.exit(2);
	}
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	await page.route('**/' + spec.file,
		(r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
}

// ── The two servers ─────────────────────────────────────────────────
//
// Both, or nothing works and the reason is invisible: without the mock provider
// every model turn fails and the transcript says only that Daimond could not
// answer, which reads as a broken app rather than a missing server.

function listening(port) {
	return new Promise((resolve) => {
		const s = net.connect(port, '127.0.0.1');
		s.once('connect', () => { s.destroy(); resolve(true); });
		s.once('error', () => resolve(false));
	});
}

const started = [];
async function serve(name, args, port) {
	if (await listening(port)) { console.log(`  (${name} already up on ${port})`); return; }
	const p = spawn('node', args, { cwd: ROOT, stdio: 'ignore', detached: false });
	started.push(p);
	for (let i = 0; i < 100; i++) {
		if (await listening(port)) { console.log(`  (started ${name} on ${port})`); return; }
		await sleep(100);
	}
	throw new Error(`${name} did not come up on ${port}`);
}

// ── The mock hand ───────────────────────────────────────────────────

const HOSTS = path.join(PROFILE, 'NativeMessagingHosts');

/// Point the profile's native messaging host at the mock, with the behaviour
/// this case needs. The host reads its configuration when it starts, so a fresh
/// link picks up a fresh setting — which is why every case closes the link.
function register(cfg) {
	fs.mkdirSync(HOSTS, { recursive: true });
	fs.writeFileSync(path.join(HOSTS, 'com.oxedyne.daimond.hand.json'), JSON.stringify({
		name:		'com.oxedyne.daimond.hand',
		description:	'Mock hand for verify_handrun.mjs.',
		path:		MOCK,
		type:		'stdio',
		allowed_origins: [`chrome-extension://${EXTID}/`],
	}, null, '\t') + '\n');
	fs.writeFileSync(CFG, JSON.stringify(Object.assign({
		// What a Linux hand with a working fence reports, plus the granted
		// folder. The folder arrives as a CAPABILITY because `wire.rs` has no
		// field for it and the wire is fixed; see ROOT_CAP in www/js/hand.js.
		caps: ['fence:linux', 'landlock:abi-8', 'carve:sealed', `root:${GRANT}`],
	}, cfg || {}), null, '\t') + '\n');
}
function unregister() {
	try { fs.rmSync(path.join(HOSTS, 'com.oxedyne.daimond.hand.json')); } catch (e) { /* gone */ }
}

// ── What the model was shown ────────────────────────────────────────

/// The last tool result the model was sent, which is the whole point of the
/// exercise: a run that draws output on screen and hands the model nothing has
/// achieved nothing.
function toolResult() {
	const reqs = mockLog();
	for (let i = reqs.length - 1; i >= 0; i--) {
		const msgs = reqs[i].messages || [];
		for (let j = msgs.length - 1; j >= 0; j--) {
			if (msgs[j].role === 'tool') return String(msgs[j].content || '');
		}
	}
	return '';
}

// ── What the HOST was asked to do ───────────────────────────────────
//
// The mock appends every frame it receives to `mock_host.log`, which is the one
// record in this run that the app did not write. Two things are asked of it that
// nothing else here can answer: whether a refused command was really never
// dispatched, and which directory a dispatched one was told to run in.
//
// The file is beside the mock and therefore SHARED — every world's runs append to
// the same one — so this reads only what was appended after this run started and
// keeps only the frames naming this run's granted root, which carries the world
// number in its path.
const logFrom = (() => { try { return fs.statSync(HOSTLOG).size; } catch (e) { return 0; } })();

/// Every `exec` the model's own `run` tool caused, as `{ id, cwd, line }`.
///
/// Keyed on the id `Tool::run_id` composes (`run-<n>-<program>`), so the one exec
/// this file drives through the relay by hand at the end — `r-reload`, which never
/// goes near `Tool::Run` — is not counted as one of the model's.
///
/// `cwd` is read with a regex rather than by parsing: the mock truncates each
/// logged frame at 400 characters, and a fence carrying several roots can reach
/// that. The working directory is near the front and always survives.
function execsSent() {
	let text = '';
	try {
		const fd = fs.openSync(HOSTLOG, 'r');
		const size = fs.fstatSync(fd).size;
		const buf = Buffer.alloc(Math.max(0, size - logFrom));
		if (buf.length) fs.readSync(fd, buf, 0, buf.length, logFrom);
		fs.closeSync(fd);
		text = buf.toString('utf8');
	} catch (e) { return []; }
	return text.split('\n')
		.filter((l) => /<- \{"t": "exec"/.test(l) && l.includes(GRANT))
		.map((l) => ({
			id:   (/"id": "([^"]*)"/.exec(l) || [])[1] || '',
			cwd:  (/"cwd": "([^"]*)"/.exec(l) || [])[1] || '',
			line: l,
		}))
		.filter((e) => e.id.indexOf('run-') === 0);
}

// ── The bundle this file is actually asking questions about ─────────
//
// The wasm the browser loads is what composes every `run` request the host is
// sent, decides where a command may start, and writes the refusals asserted
// below. It is as much the code under test as the page's JavaScript is.
//
// This guard was in `verify_handreal.mjs` and NOT here, and the asymmetry was
// the defect: a pair where one half refuses a stale bundle and the other half
// measures it silently means the unguarded half reports on a build nobody
// intended, and reports it green. Three lanes were misled that way on
// 2026-08-12. It is asked before the servers are started, so a refusal costs no
// processes and leaves nothing to clean up.
refuse(whyStaleWasm(path.join(ROOT, 'www/pkg/oxedyne_daimond_bg.wasm'), path.join(ROOT, 'src'), {
	subject: 'What the app asks the hand for',
	holds:   'every tool call this file makes',
}));

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
// The granted root, and inside it the one folder this run's chat will be given.
// It is a real directory: a mark on a folder that is not there would be a mark on
// nothing, and the app would be the only thing that ever believed in it.
fs.mkdirSync(MARKED_ABS, { recursive: true });
register({ chunks: 3 });

// What the children will bind: `serve.mjs` reads DAIMOND_PORT and `mockllm.mjs`
// DAIMOND_MOCK_PORT, so the wait below is asking about the port they chose.
const APP_PORT  = Number(process.env.DAIMOND_PORT || 8777);
const MOCK_PORT = Number(process.env.DAIMOND_MOCK_PORT || 9099);
await serve('dev server', ['dev/serve.mjs'], APP_PORT);
await serve('mock provider', ['dev/mockllm.mjs'], MOCK_PORT);

// Signed in, pointed at the mock provider, with the extension loaded — the app
// as a user meets it. Headed and on a fixed profile, because the host manifest
// above was written into that profile's own NativeMessagingHosts directory,
// which is where a browser started with --user-data-dir looks for it.
const s = await openApp({
	headed: true, name: 'handrun', extension: SRC, profile: PROFILE, route: installBreak,
});
const b = s.browser;
const page = s.page;

/// Find the grant window and click Allow, in the background, while the turn
/// that provoked it is still running. It is the extension's own page, so the
/// click is a real one — and for this question there is no second Chrome prompt
/// behind it: this window IS the approval.
async function allowHand(ms = 20000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const p of b.pages()) {
			if (/grant\.html/.test(p.url())) {
				await p.waitForLoadState('domcontentloaded').catch(() => {});
				await sleep(300);
				const head = await p.evaluate(() =>
					(document.getElementById('head') || {}).textContent || '').catch(() => '');
				await p.click('#allow').catch(() => {});
				return head;
			}
		}
		await sleep(150);
	}
	return null;
}

// ── The turn's network question ─────────────────────────────────────
//
// A chat that has read a command's output is TAINTED from that moment, so the
// engine asks before the NEXT command may reach the network (`hand/REVIEW.md`
// §1.13, `Tool::run`'s `NetStep::Ask`) and holds the turn on a modal until
// somebody answers. Nothing in this file answered it. So from the second
// command on, every turn stopped on that dialog until `chat`'s own 60-second
// timeout expired, `chat` returned with the turn still running, and the check
// below read the tool result of THE COMMAND BEFORE — one whole command out of
// step. That is the whole of what "a non-zero exit reaches the model as itself"
// was reporting on 2026-08-17: not an exit code carried wrongly, but the exit
// code of the previous run, read a minute too early. The turn after it lost its
// user message as well, to a click that landed on the modal's backdrop, so the
// gap case measured `make`'s output under `patchy`'s configuration.
//
// The answer is NO, which is the fence every run below has always been measured
// against: they carry the engine's "no network" note, and a yes would silently
// change what each of them ran with.
// READ FROM THE APP, not copied out of it. This was the literal string, and on
// 2026-08-19 `permmode.net_title` changed -- it said "this turn" and meant this
// chat -- which would have left the watcher below never recognising the dialog
// and therefore never answering it. That is not a red: it is the failure of
// 2026-08-18, where an unanswered network dialog made `chat()` time out with the
// turn still running and every assertion after it read ONE COMMAND LATE. A
// verifier that silently measures the wrong command is worse than one that stops.
//
// `t()` falls back to the key's own name if the key is gone, which no dialog will
// ever match, so a DELETED key stops this loudly instead of quietly.
const netTitle = async (page) => await page.evaluate(() =>
	(window.DaimondI18n ? DaimondI18n.t('permmode.net_title') : 'permmode.net_title'));
let netAsked = 0;
let netStop  = false;
let netWatch = null;

/// Say no to the network question for as long as this run lasts, and count how
/// often it was put.
async function answerNet(page) {
	while (!netStop) {
		const asked = await page.evaluate((title) => {
			for (const card of document.querySelectorAll('.dlg-card')) {
				const h = card.querySelector('h2');
				if (h && h.textContent.indexOf(title) >= 0) return true;
			}
			return false;
		}, await netTitle(page)).catch(() => false);
		// PRESSED, rather than resolved from inside the page: the button is what
		// a user has, and a question answered by reaching past it proves nothing
		// about the one they are actually shown.
		if (asked) {
			const said = await page.click('.dlg-card .dlg-cancel', { timeout: 2000 })
				.then(() => true, () => false);
			if (said) netAsked++;
		}
		await sleep(200);
	}
}

try {
	await sleep(500);

	check('the extension announced itself to the app',
		await page.evaluate(() => !!document.documentElement.dataset.daimondHands));
	check('the page relay is loaded and wired',
		await page.evaluate(() => !!(window.DaimondHand && window.DaimondHand.run)));

	/// The waits are tens of seconds by design; a test cannot spend them.
	async function waits(o) {
		return await page.evaluate((x) => window.DaimondHand._setWaitsForTest(x), o);
	}
	/// Let go of the link, so the next case gets a fresh host with fresh
	/// configuration. The relay keeps one port for the life of the page.
	async function relink() {
		await page.evaluate(() => window.DaimondHand.close());
		await sleep(400);
	}

	await waits({ grace: 4000, slack: 2000, hello: 15000 });
	netWatch = answerNet(page);

	// The chat every turn below is sent to, and therefore the chat whose workspace
	// decides where its commands may run. Opened before anything is asked of it,
	// because the folder is marked into THIS chat and a second one would have an
	// empty workspace of its own.
	await newChat(s);
	await sleep(400);
	const focus = await page.evaluate(() => window.DaimondAttach.focus());
	const chatId = focus && focus.id;
	check('a chat is in focus, so there is a workspace to mark a folder into',
		!!chatId && focus.kind === 'chat', JSON.stringify(focus));

	// The other half of the folder. `MARKED_ABS` is a directory on the machine;
	// this is the same folder in the workspace the PAGE holds, which in a harness
	// is OPFS — no browser can be made to answer `showDirectoryPicker()`. It is
	// laid down through the tool door, which is how a turn would have made it, and
	// it is what puts the folder in front of the picker below: `Files.entries` is
	// the panel's own listing and lists nothing that is not there.
	await page.evaluate(async (dir) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.run_tool('dir_create', JSON.stringify({ path: dir }));
	}, MARKED);

	// ── Half one: nothing marked in, and the model is told why ──────
	//
	// The first turn, so it is also the turn that provokes the grant window. The
	// chat's workspace holds its own scratch and nothing else, its scratch is in
	// the browser's storage and not a place on this computer, and there is
	// therefore nowhere for a command to run. `Tool::Run` says so on the
	// `default_cwd` path, above the fence and above the hand.
	clearMockLog();
	const grant = allowHand();
	await chat(s, '@tool run {"argv":["cargo","test"],"timeout_ms":20000}', { timeout: 60000 });
	const head = await grant;
	check('running a command asks the user first, in the extension\'s own window',
		!!head && /computer/i.test(head), String(head));

	// The belt the model was actually offered, taken from what the provider was
	// sent rather than from a list in the page.
	const belt = (mockLog()[0] || {}).tools || [];
	check('`run` is in the toolbelt the model is offered', belt.includes('run'), belt.join(' '));

	let r = toolResult();
	check('WITH NOTHING MARKED IN, a command is refused rather than run',
		/^Refused: /.test(r) && /holds nothing on this computer/.test(r), r.slice(0, 200));
	check('and the sentence says what to do about it, and where',
		// The CONTROL, and the right one. `/paperclip/` was green while the
		// paperclip attaches for READING and grants no writing -- so the sentence
		// sent the user to a button that changed nothing. The negative half is the
		// one that matters: naming the right control is no use while the wrong one
		// is still named beside it.
		/\+ in the Workspace group/.test(r) && !/paperclip/.test(r)
			&& /mark it into this chat's workspace/.test(r), r.slice(0, 400));
	// The refusal a chat gets and the refusal a Diamond gets are different
	// sentences on purpose (`ToolContext::is_chat_scoped`), and a model handed the
	// wrong one is sent to a panel that is not where a chat's workspace is changed.
	// Asserted as a property OF THE REFUSAL — `!/Diamond/` is also true of a
	// command's output, so a check that only looked for the absence of the word
	// would pass in exactly the case where there is no refusal to describe.
	check('and it is the CHAT\'s words: no Diamond, no Workspace panel',
		/^Refused: /.test(r) && !/Diamond/.test(r), r.slice(0, 300));
	check('and nothing was dispatched — the host was never asked to run anything',
		execsSent().length === 0, JSON.stringify(execsSent().map((e) => e.cwd)));

	// ── The user marks a folder in, with the control that does it ───
	//
	// The `+` in the footer's workspace group: the one control whose whole job is
	// to put a folder into this chat's workspace, driven through its dialog as a
	// person drives it. Not `DaimondAttach.chatWs`, which would set the field and
	// prove only that the field exists — the press is the permission, and a press
	// that reached nothing is one of the two defects this app was rebuilt over.
	await page.click('#chat-attachments .ws-group [data-act="attach-add"]', { force: true });
	await page.waitForSelector('.attach-pick-row', { timeout: 10000 });
	const ticked = await page.evaluate((name) => {
		const row = [...document.querySelectorAll('.attach-pick-row')]
			.find((x) => ((x.querySelector('.attach-pick-name') || {}).textContent || '').indexOf(name) >= 0);
		if (!row) return [...document.querySelectorAll('.attach-pick-name')]
			.map((x) => x.textContent).join(', ') || 'the picker listed nothing';
		row.querySelector('input').click();
		return 'ticked';
	}, MARKED);
	check('the folder is in the page\'s own workspace, for the picker to offer',
		ticked === 'ticked', ticked);
	await page.click('.dlg-ok', { force: true });
	await sleep(1000);
	const scope = await page.evaluate((id) => window.DaimondAttach.chatScope(id), chatId);
	check('MARKING IT IN is what the engine is handed as this chat\'s workspace',
		Array.isArray(scope) && scope.indexOf(MARKED) >= 0, JSON.stringify(scope));

	// ── Half two: a command runs, and its output reaches the model ──
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('the command\'s output reached the model',
		/line 1 of cargo test/.test(r) && /line 3 of cargo test/.test(r), r.slice(0, 200));
	check('so did what it wrote on standard error',
		/\[stderr\] a word from standard error/.test(r), r.slice(0, 300));
	check('and the exit code', /\[exit code: 0\]/.test(r), r.slice(-120));
	check('the output is marked as a stranger\'s words, naming the command',
		/untrusted content begins — run: cargo test/.test(r), r.slice(0, 120));
	check('the person watching saw it too, as it arrived',
		/line 1 of cargo test/.test(await transcript(s)), '');

	// ── And it ran WHERE THE USER MARKED, which is the whole claim ──
	//
	// Asked of the host's own log rather than of the app: "output came back" is
	// true of a command dispatched anywhere, and of a pipeline that carries
	// invented text between two halves of the same page. The working directory and
	// the fence are the two fields that say the mark reached the wire.
	const sent = execsSent();
	check('the command was dispatched into the folder the user marked in',
		sent.length > 0 && sent.every((e) => e.cwd === MARKED_ABS),
		JSON.stringify(sent.map((e) => e.cwd)));
	check('and fenced to that folder, not to the whole granted root',
		sent.length > 0 && sent.every((e) => e.line.includes(`"fence": {"rw": ["${MARKED_ABS}"]`)),
		(sent[sent.length - 1] || {}).line || 'nothing was sent');

	// ── A failure is reported as a failure ──────────────────────────
	await relink();
	register({ chunks: 1, exit: 3 });
	clearMockLog();
	await chat(s, '@tool run {"argv":["make"],"timeout_ms":20000}', { timeout: 60000 });
	// A COMMAND FENCED WHERE NOTHING UNTRUSTED LIVES KEEPS THE TURN'S NETWORK, and that is
	// the owner's decision of 2026-08-24, not a defence being dropped.
	//
	// This check asserted the opposite until then, because every `run` tainted the turn
	// unconditionally: the envelope round a command's output and the loss of the network
	// were one call, and only the envelope was ever argued for. What that cost was measured
	// on a real development run -- 26 of 30 tool results carried `[no network: …]`, 18.5% of
	// the bytes the daimon read, and the turn lost its network to its own first `grep` of
	// the owner's own source, while `egress_check` fired ZERO times because a daimon doing
	// source work calls no web tool at all. The permission dialog was never the cost; the
	// withheld network was.
	//
	// So the taint now follows the FENCE: a command whose fence could reach a stranger's
	// words costs the turn its network, and one fenced to a folder the user marked does not.
	// The fence here is that marked folder, so no question is right. The other half -- a
	// fence with the mailbox in it still costing the network -- is held in Rust by
	// `test_a_command_whose_fence_reaches_the_mailbox_still_takes_the_network_away`
	// (src/tools.rs) and in the browser by `dev/verify_daimonreach.mjs`.
	check('a command fenced where nothing untrusted lives does NOT cost the turn its network',
		netAsked === 0, 'the question was put ' + netAsked + ' time(s)');
	r = toolResult();
	check('a non-zero exit reaches the model as itself',
		/\[exit code: 3\]/.test(r) && !/exit code: 0/.test(r), r.slice(-160));

	// ── A hole in the stream is shown to the model ──────────────────
	//
	// The first chunk of a stream sets the baseline — where a hand starts
	// counting is its own business — so this is what proves the marker still
	// fires when there is a real hole rather than merely a different origin.
	await relink();
	register({ chunks: 3, gap: true });
	clearMockLog();
	await chat(s, '@tool run {"argv":["patchy"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('a hole in the output is shown to the model, not stitched over',
		/output missing: expected chunk/.test(r), r.slice(0, 300));
	await relink();
	register({ chunks: 2 });
	clearMockLog();
	await chat(s, '@tool run {"argv":["tidy"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('and an ordinary run carries no such marker', !/output missing/.test(r), r.slice(0, 200));

	// ── §4.4 The output is bounded, and says where it was cut ───────
	await relink();
	register({ chunks: 3000 });
	await waits({ keep: 400 });
	clearMockLog();
	await chat(s, '@tool run {"argv":["flood"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('a command that prints too much does not go unbounded into the tab',
		r.length < 20000, `${r.length} chars`);
	check('and the hole is named where it happened, not smoothed over',
		/characters of output are missing here/.test(r), r.slice(0, 200));
	check('both ends of the output are kept: the start …',
		/line 1 of flood/.test(r), '');
	check('… and the end, which is where a build says why it failed',
		/line 3000 of flood/.test(r), r.slice(-200));
	await waits({ keep: 262144 });

	// ── §4.3 A quiet command is not a dead one ──────────────────────
	//
	// The grace is four seconds here and the host says nothing for six after
	// `started`. Under the old rule — the wait refreshed only by output — this
	// was rejected as "stopped part-way through the command" while the process
	// was still running, which is exactly the `cargo test` case.
	await relink();
	register({ chunks: 2, quiet_ms: 6000 });
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"],"timeout_ms":30000}', { timeout: 90000 });
	r = toolResult();
	check('a command that says nothing for longer than the grace still finishes',
		/line 1 of cargo test/.test(r) && /\[exit code: 0\]/.test(r), r.slice(0, 200));

	// ── §4.2 Noise is not proof of life ─────────────────────────────
	//
	// The host sends a message the page does not understand, three times a
	// second, and nothing else at all. Anything that refreshes the wait on
	// receipt of a message rather than on receipt of a MEANINGFUL one waits for
	// ever here, and the daimon never speaks again.
	await relink();
	register({ noise_ms: 300 });
	clearMockLog();
	const t0 = Date.now();
	await chat(s, '@tool run {"argv":["noisy"],"timeout_ms":600000}', { timeout: 60000 });
	const took = Date.now() - t0;
	r = toolResult();
	check('a host that says only meaningless things does not hold the model for ever',
		took < 30000, `${took} ms, grace 4000`);
	check('and the daimon is told what happened, in one plain sentence',
		/^Refused: /.test(r) && /did not acknowledge/.test(r), r.slice(0, 200));
	check('nothing was invented about a command that never started',
		!/exit code/.test(r), r.slice(0, 200));

	// ── §1.16 A hand that dies is not a hand that was never there ───
	await relink();
	register({ crash: true });
	clearMockLog();
	await chat(s, '@tool run {"argv":["boom"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('a hand that crashes mid-command says so',
		/disconnected|stopped|crash/i.test(r), r.slice(0, 300));
	check('and does NOT tell the user to install what they have already installed',
		!/not installed/i.test(r), r.slice(0, 300));

	// ── Gate 1: a hand that cannot fence is refused ─────────────────
	await relink();
	register({ chunks: 1, caps: ['mock', `root:${GRANT}`] });
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"]}', { timeout: 60000 });
	r = toolResult();
	check('a hand that does not say it can fence is refused',
		/^Refused:/.test(r) && /fence/i.test(r), r.slice(0, 200));
	check('and nothing ran', !/line 1 of/.test(r), r.slice(0, 200));

	await relink();
	register({ chunks: 1, caps: ['fence:none', `root:${GRANT}`] });
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"]}', { timeout: 60000 });
	r = toolResult();
	check('a hand that says it CANNOT fence is refused in its own words',
		/^Refused:/.test(r) && /cannot fence/i.test(r), r.slice(0, 200));

	// ── No root, no fence to express ────────────────────────────────
	await relink();
	register({ chunks: 1, caps: ['fence:linux', 'landlock:abi-8'] });
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"]}', { timeout: 60000 });
	r = toolResult();
	check('a hand that will not name the granted folder is refused',
		/folder/i.test(r) && !/line 1 of/.test(r), r.slice(0, 240));

	// ── Nothing installed at all ────────────────────────────────────
	await relink();
	unregister();
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"]}', { timeout: 60000 });
	r = toolResult();
	check('a missing host is reported as a missing host',
		/not installed/i.test(r), r.slice(0, 240));
	check('and the sentence says exactly what to install',
		/install\.sh/.test(r) && /com\.oxedyne\.daimond\.hand/.test(r), r.slice(0, 400));

	// ── §1.16 again, where it actually bites ────────────────────────
	//
	// The crash above is announced BY the extension, which writes its own
	// sentence, so it does not discriminate between the two behaviours. This
	// does: the link dies with nobody saying anything, which is what an
	// extension reload, an evicted worker or a lost pipe looks like from the
	// page. Every disconnect used to be answered with "the hand is not
	// installed" — advice to install software the user has already installed.
	//
	// Driven through the relay rather than the model, because the model's turn
	// would have to be held open across the reload for no gain.
	await relink();
	register({ chunks: 5, delay_ms: 1500 });
	// The same shape `Tool::run` composes — the extension vets the fence now
	// (`hand/REVIEW.md` §1.5), and rightly refuses one that names no root.
	await page.evaluate((grant) => {
		window.__handrun = window.DaimondHand.run(JSON.stringify({
			t: 'exec', id: 'r-reload', argv: ['sleep'], cwd: grant, env: [], stdin: null,
			timeout_ms: 60000, capture: 'both',
			fence: { rw: [grant], ro: [], deny: [], net: false },
		})).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
	}, GRANT);
	await sleep(1500);
	const sw = b.serviceWorkers()[0];
	if (sw) await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
	const lost = await page.evaluate(() => window.__handrun);
	check('a link that dies with nobody saying why is reported as a hand that STOPPED',
		!!lost.err && /answered earlier and has now gone/.test(lost.err), JSON.stringify(lost).slice(0, 300));
	check('and not as one that was never installed',
		!!lost.err && !/is not installed|it is not installed/i.test(lost.err),
		JSON.stringify(lost).slice(0, 300));

	// 502s are the gateway proxy answering for a gateway nobody started; the
	// browser-only tiers carry on without it, which is what `dev/serve.mjs` says.
	const noise = s.errs.filter((e) => !/favicon|ERR_ABORTED|502|Bad Gateway/i.test(e));
	check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));
} finally {
	netStop = true;
	if (netWatch) await netWatch.catch(() => {});
	await b.close().catch(() => {});
	for (const p of started) { try { p.kill(); } catch (e) { /* already gone */ } }
	try { fs.rmSync(CFG); } catch (e) { /* never written */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
