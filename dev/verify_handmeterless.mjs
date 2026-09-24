// verify_handmeterless.mjs — the page's gate for a hand older than the deletion meter, in a
// headless browser, against real hand binaries.
//
// Audit F2 (`daimond_hand_delete_fence_audit_20260923.md`). The page deploys everywhere at once
// and each machine's hand is rebuilt by hand, so a new page talking to an OLD hand is the
// ordinary state of a fleet mid-update. That hand ignores the page's `meter` field and runs a
// daimon's `rm -rf` to its end. The page's answer is `command_fence` (src/tools.rs): a hand whose
// `hello` does not say `meter:deletes` is sent a fence with nothing writable in it, and the
// person is told once, with the update.
//
// `dev/verify_handdelete.mjs` (k) proves the same gate on the wire, with the fence composed by a
// native build of the same function. This file proves it through the PAGE: the wasm engine this
// tree built composes the exec, the relay (www/js/hand.js) carries it, daimond.js draws the
// dialogs, and a real hand under the real kernel fence answers.
//
// THE NOTICE IS A PENDING TILE, NOT A MODAL (2026-09-24). It used to be a dialog raised the
// moment the hand said hello -- mid-turn as often as not -- whose backdrop stood over whatever
// the person was about to press next (`~/usr/code/ai/claude/specs/daimond_handrun_fix_20260924.md`,
// "Left open"). `noteHandStale` in www/js/daimond.js raises it on the Pending panel instead, so
// this file reads `window.DaimondPendingView.items()` for it rather than a `.modal.dlg` selector.
//
//   old hand   the relay's notice is shown, once a page; the exec the engine sends has no
//              writable root; a command runs, reads and reports, and NOTHING under the granted
//              root is written, created, removed or renamed; the result says why. And the FILE
//              TOOLS through the same hand (re-check of 2026-09-23, H1): a write, an edit, a move
//              and a new folder are each refused in words before the hand is sent anything, and
//              every file is as it was; a read still goes, behind a read-only fence
//   new hand   no notice; the exec's fence is the one it always was; a write works, a small
//              removal is counted, and `rm -rf` past the budget is held -- the page's own
//              dialog is answered "stop and put them back" and every file comes back; and a file
//              tool's write through it lands, the control for the old hand's refusals. Last, the
//              SWAP (re-check of 2026-09-23, H3): a command waits on the person's yes, this hand
//              goes and an old one takes its place, and the yes sends the old hand nothing built
//              for this one -- no file is written or removed, and the turn is told why
//
// ── What is real, and what is stood in for ─────────────────────────
//
// Real: the page, its wasm engine, the relay, the dialogs, the hand binaries, the kernel.
//
// Stood in for, both because a headless browser cannot have them:
//
//  * The extension and Chrome's native messaging. A fake `chrome.runtime` in the page hands the
//    relay a port, and this file bridges that port to a hand process it spawned, over the
//    wire's own framing (a 4-byte native-endian length and UTF-8 JSON). Nothing is rewritten in
//    either direction. The extension's own checks only ever refuse MORE, so leaving them out
//    cannot make a write possible that the page and the hand refuse.
//  * `DaimondHand.status`, AFTER the real one has been asked. `hand/REVIEW.md` §1.14 refuses a
//    command unless the page's folder is shown to be the hand's grant, and a page holds a real
//    folder only through a native dialog no harness can answer -- see `settled` in
//    www/js/hand.js and `dev/verify_scope.mjs`. So the real status is asked first (which opens
//    the link, takes the hand's real `hello` and fires the notice), its refusal is asserted,
//    and the stand-in then answers with exactly what the hand reported, marked paired.
//
// Every hand gets FIXTURE roots only -- its grant, journal, trash and scratch under
// ~/.cache/daimond-handdelete/$RC_SLOT/meterless-<run> -- never a real folder. Not under
// ~/.cache/daimond, which the meter treats as a toolchain cache (see verify_handdelete.mjs).
// Keyed by the RUN as well as the slot: two runs sharing a slot wiped each other's fixtures
// mid-run on 2026-09-24, and the retry was part of a fleet OOM at 12:08.
//
// ── Running it ──────────────────────────────────────────────────────
//
//	DAIMOND_PORT=<a free port> node dev/verify_handmeterless.mjs
//
//	  HD_OLD_BINS=<a:b>  hands older than the meter; default BOTH the base build in the slot's
//	                     `lane-bc-base` target and this machine's installed hand
//	                     (~/.local/share/daimond/hand/bin/daimond-hand), which is the one that
//	                     matters. A named hand that is not there FAILS the run: on 2026-09-24 a
//	                     run that drove one hand read 36/0 where two read 58/0, and nothing said so.
//	  HD_NEW_BIN=<path>  the hand with the meter; default this tree's release build
//	  --keep             leave the fixtures behind
//
// The dev server is started here, on DAIMOND_PORT, and a port already in use is REFUSED rather
// than borrowed: a server this file did not start may be serving another tree's page. Headless,
// with DISPLAY dropped by the harness; the wasm bundle must be this tree's (`dev/build-wasm.sh`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open as openApp } from './harness.mjs';
import { whyStaleBinary, whyStaleWasm, refuse } from './staleguard.mjs';
import { plant, fakeExtension, bridge } from './handbridge.mjs';

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const SLOT	= process.env.RC_SLOT || 'solo';
const KEEP	= process.argv.slice(2).includes('--keep');
const TARGETS	= path.join(os.homedir(), '.cache/cargo-targets', SLOT);
const NEW_BIN	= process.env.HD_NEW_BIN || path.join(TARGETS, 'lane-hand/release/daimond-hand');
const INSTALLED	= path.join(os.homedir(), '.local/share/daimond/hand/bin/daimond-hand');
const OLD_BINS	= (process.env.HD_OLD_BINS
	|| [path.join(TARGETS, 'lane-bc-base/release/daimond-hand'), INSTALLED].join(':'))
	.split(':').filter(Boolean);
// A SIBLING of ~/.cache/daimond, never a child of it -- see verify_handdelete.mjs.
const RUN	= process.pid.toString(36) + '-' + Date.now().toString(36);
const FIX	= path.join(os.homedir(), '.cache/daimond-handdelete', SLOT, 'meterless-' + RUN);
const PORT	= Number(process.env.DAIMOND_PORT || 0);
const PLANTED	= 100;
const EXT_ID	= 'fake-ext-verify-handmeterless';
const LE	= os.endianness() === 'LE';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listening(port) {
	return new Promise((resolve) => {
		const s = net.connect(port, '127.0.0.1');
		s.once('connect', () => { s.destroy(); resolve(true); });
		s.once('error', () => resolve(false));
	});
}

// ── Fixtures ──────────────────────────────────────────────────────────
//
// `plant`, `fakeExtension` and `bridge` moved out to `dev/handbridge.mjs`
// (2026-09-24) so `dev/verify_handnotice.mjs` can pair a real, deliberately
// UNMETERED hand to an ordinary chat page without a second copy of the
// native-messaging wire: this file's own fixture stays a stand-in that DOES
// say `meter:deletes` throughout (see the header), so it never raises the
// notice that other file drives.

function filesUnder(dir) {
	let n = 0;
	let names;
	try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
	for (const d of names) {
		const p = path.join(dir, d.name);
		if (d.isSymbolicLink()) continue;
		if (d.isDirectory()) n += filesUnder(p);
		else if (d.isFile()) n += 1;
	}
	return n;
}

/// Every name under `dir` and what it holds: its type, and for a file its size and a hash of its
/// bytes. What a command could destroy, and nothing a read-only fence leaves to the filter.
function names(dir) {
	const out = {};
	const walk = (d) => {
		let list = [];
		try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
		for (const e of list) {
			const p = path.join(d, e.name);
			const rel = path.relative(dir, p);
			if (e.isSymbolicLink()) out[rel] = 'link:' + fs.readlinkSync(p);
			else if (e.isDirectory()) { out[rel] = 'dir'; walk(p); }
			else if (e.isFile()) {
				let body = Buffer.alloc(0);
				try { body = fs.readFileSync(p); } catch (x) { /* a mode tightened */ }
				out[rel] = `file:${body.length}:` + crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
			} else out[rel] = 'other';
		}
	};
	walk(dir);
	return out;
}

function changed(a, b) {
	const out = [];
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (a[k] !== b[k]) out.push(`${k} (${a[k] || 'absent'} -> ${b[k] || 'absent'})`);
	}
	return out;
}

// ── One hand, through one page ──────────────────────────────────────

const HELD   = '.modal.dlg[data-ask="hand-held"]';

/// The stale-hand Pending tile, if one is on the panel right now — `{ id, headline, detail }`,
/// or null. Polled rather than waited-for-a-selector, since a Pending tile mounts no new DOM
/// under a fixed selector the way a dialog does: `render()` rebuilds `#pending-list` on every
/// `Pending.save()`, so the tile is read from the model `DaimondPendingView` exposes, which is
/// the same data the panel draws from and is there the instant `Pending.add` runs.
async function staleNotice(page) {
	return page.evaluate(() => {
		const items = window.DaimondPendingView ? window.DaimondPendingView.items() : [];
		const title = window.DaimondI18n ? window.DaimondI18n.t('hand.stale_title') : '';
		const it = items.find((x) => x.kind === 'notice' && x.headline === title);
		return it ? { id: it.id, headline: it.headline, detail: it.detail } : null;
	});
}

/// Wait up to `ms` for `staleNotice` to answer non-null, or give up and return null.
async function waitStaleNotice(page, ms) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
		const n = await staleNotice(page);
		if (n) return n;
		await sleep(200);
	}
	return null;
}

async function drive(label, bin, meters) {
	console.log(`\n── ${label}: ${bin} (${meters ? 'meters removals' : 'older than the meter'}) ──`);
	const root = path.join(FIX, label);
	fs.rmSync(root, { recursive: true, force: true });
	const grant = path.join(root, 'grant');
	const proj = path.join(grant, 'proj');
	const nonce = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	plant(proj, PLANTED);
	fs.writeFileSync(path.join(grant, 'nonce.txt'), nonce + '\n');
	fs.writeFileSync(path.join(grant, 'top.txt'), 'top\n');

	let br = null;
	const s = await openApp({
		name: `meterless-${label}-${SLOT}-${RUN}`, connect: false,
		route: async (page) => {
			br = bridge(page, bin, root);
			await page.exposeBinding('__toHand', (src, raw) => br.fromPage(raw));
			await page.addInitScript(fakeExtension, EXT_ID);
		},
	});
	const page = s.page;
	try {
		await page.evaluate((id) => window.DaimondHand.setExtId(id), EXT_ID);

		// ── The real status: the link opens, the hand says hello, the relay adopts it ──
		const real = JSON.parse(await page.evaluate(() => window.DaimondHand.status()));
		const caps = Array.isArray(real.caps) ? real.caps : [];
		check(`${label}: the relay took the real hand's hello, granted root and all`,
			caps.includes(`root:${grant}`) && real.root === grant, JSON.stringify(real).slice(0, 240));
		// A hand granted anything but the fixture -- one that ignored DAIMOND_HAND_ROOT and fell
		// back to its installed grant -- is sent no command at all.
		if (!caps.includes(`root:${grant}`) || real.root !== grant) return;
		check(`${label}: the hand ${meters ? 'says' : 'does not say'} meter:deletes`,
			caps.includes('meter:deletes') === meters, caps.filter((c) => /^(fence|meter):/.test(c)).join(' '));
		// The §1.14 refusal, which is why the stand-in below exists at all. A hand too old to
		// publish a folder token is passed by the relay's own compatibility seam instead
		// (`folderVerdict`), and that is said rather than asserted either way.
		if (caps.some((c) => c.startsWith('ws:'))) {
			check(`${label}: and, headless, the relay refuses the unproven folder as §1.14 says it must`,
				real.paired === false && /folder/i.test(String(real.reason || '')),
				String(real.reason || '').slice(0, 160));
		} else {
			note(`${label}: this hand publishes no folder token, so §1.14's check passes it (paired ${real.paired})`);
		}

		// ── The notice ────────────────────────────────────────────────
		const notice = await waitStaleNotice(page, meters ? 3000 : 15000);
		if (!meters) {
			const txt = notice ? notice.detail : '';
			const host = (caps.find((c) => c.startsWith('host:')) || 'host:').slice(5);
			check(`${label}: the person is told this machine's hand is older than the meter`,
				!!notice && /needs updating/i.test(notice.headline)
					&& /older than the deletion meter/.test(txt),
				JSON.stringify(notice).slice(0, 200));
			check(`${label}: naming the machine and the update, word for word`,
				!!notice
					&& txt.includes(host || 'this computer')
					&& txt.includes('cargo build --release --manifest-path hand/Cargo.toml')
					&& txt.includes('hand/install/install.sh') && /reload this page with nothing running/.test(txt),
				JSON.stringify(txt).slice(-240));
			// The tick and the `✕` both just take a notice tile down (see `Pending`'s header in
			// www/js/daimond.js) — dropping it is what a person acting on it does either way.
			if (notice) await page.evaluate((id) => window.DaimondPendingView.drop(id), notice.id);
			// Once a page: the link goes, comes back, and the hand says hello again. `status`
			// would answer from what the relay remembers without reopening anything, so the link
			// is reopened by a question only the hand can answer.
			await page.evaluate(() => window.DaimondHand.close());
			await sleep(300);
			await page.evaluate(() => window.DaimondHand.runs().catch(() => null));
			const again = await waitStaleNotice(page, 3000);
			// Told at all, first: a page that never says it is not saying it "once", and without
			// that half this check passed on the page from before the gate.
			check(`${label}: and told once a page, not on every hello`,
				!!notice && !again && br.procs >= 2,
				`${br.procs} hand processes, notice first: ${!!notice}, notice again: ${!!again}`);
		} else {
			check(`${label}: a hand that meters brings no notice`, !notice, notice ? JSON.stringify(notice) : '');
		}

		// ── The stand-in: what the hand reports, marked paired ────────
		// Passed through from the relay each time, as verify_handreal.mjs does, with only the
		// folder verdict lifted: the link the answer names is the one the relay holds NOW, which is
		// what every request is bound to (H3). A snapshot would name a link since reopened.
		await page.evaluate(() => {
			const real = window.DaimondHand.status;
			window.DaimondHand.status = () => real.call(window.DaimondHand).then((raw) => {
				const said = Object.assign({}, JSON.parse(raw), { paired: true, workspace: 'ok' });
				delete said.reason;
				delete said.workspace_reason;
				return JSON.stringify(said);
			});
		});
		await page.evaluate(async () => {
			const mod = await import('/pkg/oxedyne_daimond.js');
			// A URL nothing answers: no tool below reaches a model.
			window.__plain = new mod.DaimondApp('http://127.0.0.1:9/v1/chat/completions', 'k', 'mock', 256, '', true);
			window.__marked = new mod.DaimondApp('http://127.0.0.1:9/v1/chat/completions', 'k', 'mock', 256, '', true);
			window.__marked.set_diamond_scope('diamonds/verify', '["proj"]', '[]', '[]');
		});
		const tool = (app, argv) => page.evaluate(([a, v]) =>
			window[a].run_tool('run', JSON.stringify({ argv: v })), [app, argv]);
		const lastExec = () => [...br.sent].reverse().find((m) => m.t === 'exec') || null;

		if (!meters) {
			const before = names(grant);
			// Each step its own subshell: a failed redirection on `:` ends a POSIX shell, and
			// the steps after it would never be tried (see `battery` in verify_handdelete.mjs).
			const a = await tool('__plain', ['/bin/sh', '-c', [
				`cat ${grant}/nonce.txt`, `echo x > ${grant}/new.txt`, `rm -f ${grant}/top.txt`,
				`mv ${proj}/src ${grant}/moved`, `mkdir ${grant}/newdir`, `: > ${proj}/docs/f001.txt`,
				`truncate -s 0 ${grant}/top.txt`, `echo t > "$TMPDIR/t" && echo scratch-ok`, 'echo done',
			].map((c) => `( ${c} ) 2>/dev/null`).join('; ')]);
			const ea = lastExec();
			const b = await tool('__plain', ['rm', '-rf', proj]);
			const eb = lastExec();
			const c = await tool('__marked', ['rm', '-rf', 'src', 'docs', 'sub']);
			const ec = lastExec();
			const after = names(grant);
			for (const [what, e] of [['unscoped', ea], ['rm -rf', eb], ['marked', ec]]) {
				check(`${label}: the engine's ${what} exec has no writable root, and still carries its meter field`,
					!!e && Array.isArray(e.fence.rw) && e.fence.rw.length === 0 && e.fence.ro.length > 0 && !!e.meter,
					e ? JSON.stringify({ rw: e.fence.rw, ro: e.fence.ro, meter: e.meter }) : 'no exec was sent');
			}
			check(`${label}: the unscoped fence is the whole granted root, for reading`,
				!!ea && ea.fence.ro.includes(grant), ea ? JSON.stringify(ea.fence.ro) : '');
			check(`${label}: the command ran: it read the grant and wrote its own scratch`,
				a.includes(nonce) && a.includes('scratch-ok') && a.includes('done'), a.slice(0, 300));
			check(`${label}: and each result says why nothing was writable`,
				[a, b, c].every((r) => r.includes('[read-only:')), [a, b, c].map((r) => r.slice(-160)).join(' | '));
			check(`${label}: and nothing was held, because nothing could be removed`,
				!br.got.some((m) => m.t === 'held'), '');
			const lost = changed(before, after);
			check(`${label}: NOTHING under the granted root was written, created, removed or renamed`,
				lost.length === 0 && filesUnder(proj) === PLANTED, lost.slice(0, 6).join('; ') || `${filesUnder(proj)}/${PLANTED} in proj`);

			// ── The file tools, through the same hand (H1) ──────────────────
			// The gate was a command's until the re-check: the file door built its own writable
			// fence, and this hand took a daimon's writes one named file at a time. Every change a
			// file tool can make is tried on files planted before the turn.
			const sentAt = br.sent.length;
			const fBefore = names(grant);
			const ft = (name, args) => page.evaluate(([n, a]) =>
				window.__marked.run_tool(n, JSON.stringify(a)), [name, args]);
			const fw = await ft('file_write', { path: 'proj/docs/f004.txt', content: 'overwritten\n' });
			const fe = await ft('file_edit', { path: 'proj/src/f003.txt', old_string: 'file 3', new_string: 'edited' });
			const fm = await ft('file_move', { path: 'proj/sub/deep/f005.txt', to: 'proj/sub/deep/moved.txt' });
			const fd = await ft('dir_create', { path: 'proj/newdir' });
			const fr = await ft('file_read', { path: 'proj/src/f000.txt' });
			const fAfter = names(grant);
			const fileOps = br.sent.slice(sentAt).filter((m) => m.t === 'file');
			const changes = fileOps.filter((m) => !['read', 'list', 'search', 'glob'].includes(m.op));
			const said = { file_write: fw, file_edit: fe, file_move: fm, dir_create: fd };
			for (const [tool, r] of Object.entries(said)) {
				check(`${label}: a file tool's change through this hand is refused, and says why -- ${tool}`,
					/^Refused/.test(r) && /older than the deletion meter/.test(r), String(r).slice(0, 200));
			}
			check(`${label}: and the hand was sent no change at all`,
				changes.length === 0, JSON.stringify(changes.map((m) => ({ op: m.op, path: m.path, rw: m.fence && m.fence.rw }))));
			const fLost = changed(fBefore, fAfter);
			check(`${label}: every file the file tools were pointed at is as it was`,
				fLost.length === 0 && filesUnder(proj) === PLANTED, fLost.slice(0, 6).join('; ') || `${filesUnder(proj)}/${PLANTED} in proj`);
			const read = fileOps.find((m) => m.op === 'read');
			check(`${label}: a read still goes to the hand, behind a fence with nothing writable, and comes back`,
				/file 0/.test(fr) && !!read && Array.isArray(read.fence.rw) && read.fence.rw.length === 0
					&& read.fence.ro.length > 0,
				(read ? JSON.stringify({ rw: read.fence.rw, ro: read.fence.ro }) : 'no read was sent') + ' | ' + String(fr).slice(0, 80));
		} else {
			const w = await tool('__marked', ['/bin/sh', '-c',
				'echo made > made.txt && rm -f src/f000.txt docs/f001.txt && cat made.txt']);
			const ew = lastExec();
			check(`${label}: the engine's fence for this hand is the one it always had`,
				!!ew && ew.fence.rw.includes(proj) && !!ew.meter, ew ? JSON.stringify({ rw: ew.fence.rw, meter: ew.meter }) : '');
			check(`${label}: a command writes, and removes under the budget, unasked`,
				w.includes('made') && w.includes('removed 2 file(s)') && !w.includes('[read-only:')
					&& fs.existsSync(path.join(proj, 'made.txt')), w.slice(-300));
			// Past the budget: the relay puts the page's own question, and it is answered the way a
			// person answers it -- by pressing "Stop and put them back". The allowance is the
			// TURN's, so the two files above have spent two of it and the hold comes at 62.
			const left = 64 - 2;
			const running = tool('__marked', ['rm', '-rf', 'src', 'docs', 'sub']);
			const held = await page.waitForSelector(HELD, { timeout: 60000 }).catch(() => null);
			const heldText = held ? await held.innerText() : '';
			check(`${label}: past the turn's allowance the page asks, in its own dialog`,
				!!held && heldText.includes(`removed ${left} files`), JSON.stringify(heldText).slice(0, 200));
			// R6's guard, which every other question a running turn raises takes: focus on Stop,
			// and no key typed as it appears lets the command go on removing files.
			const g0 = await page.evaluate((sel) => {
				const c = document.querySelector(sel);
				const a = document.activeElement;
				const yes = c && c.querySelector('.dlg-ok');
				return { stop: !!(a && a.classList && a.classList.contains('dlg-cancel')),
					yesHeld: !!(yes && yes.disabled) };
			}, HELD);
			if (held) { await page.keyboard.press('Space'); await page.keyboard.press('Enter'); }
			await sleep(200);
			const stillAsked = !!(await page.$(HELD));
			check(`${label}: and the question takes no stray key -- focus on Stop, its yes held for a moment, a Space and an Enter answer nothing`,
				!!held && g0.stop && g0.yesHeld && stillAsked, JSON.stringify({ ...g0, stillAsked }));
			if (stillAsked) await page.click(`${HELD} .dlg-cancel`, { force: true });
			const r = await running;
			// Put back is by turn, so the two removed unasked come back with the rest: every
			// planted file, and the one the command made.
			const whole = PLANTED + 1;
			let back = 0;
			for (let i = 0; i < 40 && back !== whole; i++) { await sleep(250); back = filesUnder(proj); }
			check(`${label}: and "stop and put them back" stops it and puts back every file the turn took`,
				back === whole && r.includes(`removed ${left} file(s)`), `${back}/${whole} in proj; ${r.slice(-200)}`);
			// The control for the old hand's refusals: the same file tool, through a hand that
			// meters, writes -- so a refusal there is the gate and not a door that never opened.
			const cw = await page.evaluate(() => window.__marked.run_tool('file_write',
				JSON.stringify({ path: 'proj/docs/f004.txt', content: 'overwritten\n' })));
			let body = '';
			try { body = fs.readFileSync(path.join(proj, 'docs/f004.txt'), 'utf8'); } catch (e) { /* gone */ }
			check(`${label}: a file tool's write through a hand that meters lands`,
				/^Wrote /.test(cw) && body === 'overwritten\n', String(cw).slice(0, 160) + ' | now ' + JSON.stringify(body));

			// ── A hand swapped in while a command waits (H3) ─────────────
			// The engine reads this hand's status, builds a writable fence from it, and waits on
			// the person's yes. Before the yes, this hand goes and one older than the meter comes
			// back on the next link. The yes must send the old hand nothing built for this one.
			const was = await page.evaluate(async () => (await import('/pkg/oxedyne_daimond.js'))
				.set_permission_mode('ask'));
			const swapAt = br.sent.length;
			await page.evaluate(() => {
				window.__h3 = window.__marked.run_tool('run', JSON.stringify({ argv: ['/bin/sh', '-c',
					'echo swapped > h3.txt && rm -f docs/f007.txt && echo ran'] }))
					.then((r) => String(r), (e) => 'THREW: ' + String((e && e.message) || e));
				return true;
			});
			const ASK = '.modal.dlg[data-kind="confirm"]:not([data-ask])';
			const asked = await page.waitForSelector(ASK, { timeout: 30000 }).catch(() => null);
			br.swapTo(OLD_BINS[0]);
			await sleep(500);
			// Every question the turn puts from here is answered yes, as a person who did not
			// notice the swap would answer it. The old hand's notice is a Pending tile now and
			// blocks nothing, so it is dropped for tidiness rather than because anything here
			// waits on it being gone.
			await page.evaluate(() => { window.__h3done = false; window.__h3.then(() => { window.__h3done = true; }); });
			for (let i = 0; i < 120 && asked && !(await page.evaluate(() => window.__h3done)); i++) {
				if (await page.$(ASK + ' .dlg-ok:not([disabled])')) await page.click(ASK + ' .dlg-ok', { force: true });
				const swapNotice = await staleNotice(page);
				if (swapNotice) await page.evaluate((id) => window.DaimondPendingView.drop(id), swapNotice.id);
				await sleep(250);
			}
			const h3 = await page.evaluate(() => Promise.race([window.__h3,
				new Promise((r) => setTimeout(() => r('NO ANSWER: the command never came back'), 60000))]));
			const sentOld = br.sent.slice(swapAt).filter((m) => m.t === 'exec');
			const madeIt = fs.existsSync(path.join(proj, 'h3.txt'));
			const keptIt = fs.existsSync(path.join(proj, 'docs/f007.txt'));
			check(`${label}: a command waiting on the person's yes when an old hand took this one's place sends it nothing`,
				!!asked && sentOld.length === 0 && !madeIt && keptIt,
				JSON.stringify({ asked: !!asked, execs: sentOld.map((m) => ({ rw: m.fence && m.fence.rw })), made: madeIt, kept: keptIt }));
			check(`${label}: and the turn is told the hand changed while it waited`,
				/hand changed while this waited/.test(h3), h3.slice(0, 220));
			await page.evaluate(async (m) => (await import('/pkg/oxedyne_daimond.js'))
				.set_permission_mode(m), was);
			// The old hand's notice, which its hello brought with it.
			const late = await staleNotice(page);
			if (late) await page.evaluate((id) => window.DaimondPendingView.drop(id), late.id);
		}
	} finally {
		if (br) br.close();
		await s.close();
		if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
	}
}

// ── Run ───────────────────────────────────────────────────────────────

if (!PORT) {
	console.log('  refusing to run: set DAIMOND_PORT to a free port. This file starts its own dev server '
		+ 'there, so that the page under test is this tree\'s.');
	process.exit(2);
}
refuse(whyStaleWasm(path.join(ROOT, 'www/pkg/oxedyne_daimond_bg.wasm'), path.join(ROOT, 'src'), {
	subject: 'The page\'s gate for an old hand',
	holds:   '`command_fence` and the read-only note',
}));
refuse(whyStaleBinary(NEW_BIN, {
	subject: 'The metering hand',
	what:    'hand',
	rebuild: 'cargo build --release --manifest-path hand/Cargo.toml',
}));
check('the metering hand is there', fs.existsSync(NEW_BIN), NEW_BIN);
for (const b of OLD_BINS) check(`the old hand ${b} is there`, fs.existsSync(b), b);

if (await listening(PORT)) {
	console.log(`  refusing to run: something is already listening on ${PORT}, and it may be serving `
		+ 'another tree\'s page. Pick a free DAIMOND_PORT.');
	process.exit(2);
}
const server = spawn('node', ['dev/serve.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env } });
let up = false;
for (let i = 0; i < 100 && !up; i++) { await sleep(100); up = await listening(PORT); }
check(`this tree's dev server is up on ${PORT}`, up, '');

try {
	if (up) {
		for (const [i, b] of OLD_BINS.entries()) {
			if (fs.existsSync(b)) await drive(OLD_BINS.length > 1 ? `old${i + 1}` : 'old', b, false);
		}
		if (fs.existsSync(NEW_BIN)) await drive('new', NEW_BIN, true);
	}
} finally {
	server.kill('SIGTERM');
	if (!KEEP) fs.rmSync(FIX, { recursive: true, force: true });
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
