/* ============================================================
   compileprogress.test.mjs — a crystal compile's progress crosses as device work (REL-1b)

   WHAT IS CHECKED. The runner sent a compile's progress keyed by its compile id, a
   key the gateway now refuses (only `agents.*` is taken), and the refusal was
   swallowed, so the dispatching device never saw the compile move. RULED (30 Oct):
   a compile is device work in progress, so it goes out as a run in the runner's
   `agents.<device>` frame, the channel the workers list reads, and the other
   device shows it as the list shows a worker.

     (a) across   — a compile run framed on A, read on B, is in B's peer list with
                    its kind, its progress line and its state; its ending crosses.
     (b) bounded  — the progress line is cut to its field's length.
     (c) wiring   — the runner's `frame` goes through `PeerAgents.compileFrame`, never
                    `pushProgressFrame(cid, …)`, and a refused frame throws; the
                    dispatcher follows the run through `PeerAgents.onRun`, never
                    `watchProgress(cid, …)`; the publisher carries the compile runs;
                    `take` hands each run to its watcher.
     (d) loud     — the collector's `say` reports a refused frame, never drops it silently.

   RED before REL-1b: (a) kind/tail are not carried, and every wiring arm.

   Run:  node www/js/compileprogress.test.mjs
   ============================================================ */
const { makeWindow, loadScript, TREE } = await import('../../dev/syncprobe.mjs');
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}
const NOW = 1_800_000_000_000;
const w = makeWindow({ now: NOW });
try { loadScript(w, 'peer.js'); } catch (e) { /* the builders are defined before any boot step */ }
const P = w.DaimondPeer || {};
const weigh = (t) => ({ chars: String(t).length, bytes: Buffer.byteLength(JSON.stringify(String(t))) - 2 });
const BUDGET = { chars: 48 * 1024, bytes: 63 * 1024 };
const A = 'dev-argonaut';

// (a) across
const comp = { id: 'c-1234', name: 'book/main.typ', kind: 'compile', status: 'running', tail: 'laying out page 3', deviceId: A };
const got = P.agentsFromFrame(P.agentsFrame([comp], A, NOW, BUDGET, weigh), A);
const list = P.peerRunsList(P.peerRunsMerge({}, got, NOW), [A], [], NOW);
const r = list.find((x) => x.id === 'c-1234');
check('(a) B holds A\'s compile as a run', !!r, list);
check('(a) its kind crosses', r && r.kind === 'compile', r);
check('(a) its progress line crosses', r && r.tail === 'laying out page 3', r);
const done = Object.assign({}, comp, { status: 'done', endedAt: NOW, tail: '12 pages' });
const g2 = P.agentsFromFrame(P.agentsFrame([done], A, NOW, BUDGET, weigh), A);
const r2 = P.peerRunsList(P.peerRunsMerge({}, g2, NOW), [A], [], NOW).find((x) => x.id === 'c-1234');
check('(a) its ending crosses', r2 && r2.status === 'done' && r2.tail === '12 pages', r2);

// (b) bounded
const long = Object.assign({}, comp, { tail: 'x'.repeat(5000) });
const g3 = P.agentsFromFrame(P.agentsFrame([long], A, NOW, BUDGET, weigh), A);
const r3 = g3 && g3.runs[0];
check('(b) the progress line is cut', r3 && !!r3.tail && r3.tail.length > 0 && r3.tail.length <= 240, r3);

// (c) wiring
const FV = readFileSync(join(TREE, 'www', 'js', 'page', 'files_view.js'), 'utf8');
const WK = readFileSync(join(TREE, 'www', 'js', 'page', 'workers.js'), 'utf8');
const frameFn = (FV.match(/frame:\s*async function \(cid, text, final\) \{[\s\S]*?\n\t\t\},/) || [''])[0];
check('(c) the runner\'s frame goes through PeerAgents.compileFrame', /PeerAgents\.compileFrame\(cid/.test(frameFn), frameFn);
check('(c) never a compile-id key on the door', !/pushProgressFrame\(cid/.test(FV));
check('(c) a refused frame throws', /throw /.test(frameFn), frameFn);
const watchFn = (FV.match(/function watchCompile\([\s\S]*?\n\}\n/) || [''])[0];
check('(c) the dispatcher follows the run through PeerAgents.onRun', /PeerAgents\.onRun\(cid/.test(watchFn), watchFn);
check('(c) never watchProgress on a compile id', !/watchProgress\(cid/.test(FV) && !/unwatchProgress\(cid/.test(FV));
check('(c) the publisher carries the compile runs', /agentsFrame\(Workers\.runs\.concat\(this\.compileRuns\(\)\)/.test(WK));
check('(c) take hands each run to its watcher', /take: function[\s\S]{0,600}(this|self)\.watchers\[/.test(WK));

// (d) loud
const PJ = readFileSync(join(TREE, 'www', 'js', 'peer.js'), 'utf8');
const say = (PJ.match(/async function say\(text, final\) \{[\s\S]*?\n\t\t\}/) || [''])[0];
check('(d) say reports a refused frame', /catch \(err\) \{[^}]*diag\(/.test(say), say);

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
