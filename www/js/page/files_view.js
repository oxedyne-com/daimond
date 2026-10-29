// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { Wasm, kindName, noteFolderLost } from './wasm.js';
import { convKey, ownPanel, pg } from './state.js';
import { esc, friendlyError, stripAnsi, t, tn } from './util.js';
import { nudgeSync, trashed } from './chatstore.js';
import { filesSyncable, nominatedDeviceId, parseSyncListing } from './parcel_collect.js';
import { deviceLabelFor, isMobileDeviceSelf, peerSyncShim, selfDeviceId } from './handoff.js';
import { tools } from './workers.js';
import { attachedTruly, attachedTrulyAll, attachmentsOf, bind, clear, closePop, closePreview, curDir,
	docFilling, fmtFileBytes, folderFid, folderHandle, isOpen, joinPath, list, listNote, listed,
	modeReconnect, openFile, parseListing, pickListing, pvEl, reknow, relabelListing, renderCrumbs,
	renderFocus, renderMode, rootHandle, showLineNos, showModeMsg, showViewedFile, toggleAttach,
	tryReconnect, underPath, viewEl } from './files_tree.js';
import { DaimondPanels } from './layout.js';
import { placeOpts, selfHoldsFolder, selfHoldsHand, toolReason } from './sourcemenu.js';
import { annotatePresence } from './turns.js';
import { confirmDialog, promptDialog, runnerAskerOf } from './consent.js';
import { versionsPath } from './chats.js';
import { INSTRUCTIONS_FILE, Instructions, Prompts, instructionsSeed } from './pending.js';
import { diamondApp } from './diamonds.js';
import { showDoc, watchedPath } from './agentspanel.js';
import { markInForce } from './marks.js';
// page-split: end imports
export let Files; // page-split: hoisted

// ── THE PICTURES AND THE FONTS, BEFORE THE COMPILE ──────────
//
// A device that has never had native access holds the heavy half of a book as
// references: the shared folder sends what fits inline and offloads the rest, so
// on the phone `assets/**` and `fonts/**` are ☁ rows and nothing else.
//
// The gatherer (`gather`, src/wasm/typst.rs) reads the workspace, and a path that
// is not there is SKIPPED. What then happens is a refusal, twice over: a picture
// the compiler cannot read is named by the compiler, and a font FAMILY the source
// asks for and the walk did not find is named by the pre-flight in js/typst.js,
// which refuses before compiling for exactly the reason this is about -- Typst
// substitutes a missing family silently, so the PDF would print with different
// line breaks and a different page count and nothing would say so.
//
// THE HOLE THE PRE-FLIGHT CANNOT SEE is the other half of the same fault, and it
// is why the fetch is not left to a button on a refusal. That check is by FAMILY:
// a book whose `Cormorant Garamond` regular rode inline and whose italic and bold
// did not passes it, and the substitution it describes then happens for the two
// faces it never asked about.
//
// So they are fetched first. A device that has the files compiles the book it has
// rather than reading a refusal about a book it could have had.

/// Every folder the gatherer searches for pictures and fonts, from the document's
/// own outward -- `chain(main_dir, floor, MAX_UP)` in src/wasm/typst.rs, and the
/// same four levels.
function projectSearchDirs(main) {
	var d = main.indexOf('/') < 0 ? '' : main.slice(0, main.lastIndexOf('/'));
	var out = [d];
	for (var up = 0; up < 4 && d; up++) {
		var cut = d.lastIndexOf('/');
		d = cut < 0 ? '' : d.slice(0, cut);
		out.push(d);
	}
	return out;
}

/// The ☁ rows a compile of `main` will look for and not find.
///
/// UNDER THIS DOCUMENT'S OWN CHAIN AND NO WIDER. `awayPaths` is the whole
/// account's cloud-only set; fetching all of it to compile a chapter would be a
/// phone pulling down somebody's photo library. `assets` and `fonts` are the two
/// names the gatherer itself looks under (`FONT_DIRS`, and the `assets` tree every
/// picture in the author's book sits in).
function projectCloudRows(main) {
	if (!window.DaimondCloud || !DaimondCloud.awayPaths) return [];
	var pre = [];
	projectSearchDirs(main).forEach(function (d) {
		['assets/', 'fonts/'].forEach(function (w) { pre.push(d ? d + '/' + w : w); });
	});
	var away = DaimondCloud.awayPaths(), out = [];
	Object.keys(away).forEach(function (q) {
		for (var i = 0; i < pre.length; i++) {
			if (q.indexOf(pre[i]) === 0) { out.push({ path: q, size: away[q] | 0 }); return; }
		}
	});
	out.sort(function (a, b) { return a.path < b.path ? -1 : 1; });
	return out;
}

/// The most a press of Compile brings down on its own.
///
/// The fixture book's fonts are 13 MB and its pictures another 11, which is the
/// price of typesetting that book on a phone and is worth paying once. A tree an
/// order of magnitude past that is not a book's assets, and the person is told
/// the size rather than billed for it.
var HYDRATE_MAX = 64 * 1024 * 1024;

/// Fetch them, saying what it is doing while it does.
///
/// Answers true when the compile may proceed. Never silent: the message line
/// carries the count and the total before the first byte moves, because this is a
/// metered download on the device least able to afford one.
async function hydrateProject(main, msgEl) {
	var want = projectCloudRows(main);
	if (!want.length) return true;
	var bytes = want.reduce(function (n, w) { return n + w.size; }, 0);
	if (bytes > HYDRATE_MAX) {
		msgEl.classList.add('err');
		msgEl.textContent = t('files.compile_fetch_too_big',
			{ size: fmtFileBytes(bytes), max: fmtFileBytes(HYDRATE_MAX) });
		return false;
	}
	for (var i = 0; i < want.length; i++) {
		msgEl.textContent = t('files.compile_fetching',
			{ size: fmtFileBytes(bytes), path: want[i].path });
		var res = await DaimondCloud.fetch(want[i].path);
		// ONE FILE, NOT THE COMPILE. A picture cloud storage has lost is a compiler
		// error naming it a moment later, which is a better place to read it than
		// here; a font it has lost is the silent case above, and nothing this side
		// can do about it either. Both are said to the console and the compile goes
		// on, so a book missing one picture still draws.
		if (String(res).indexOf('OK') !== 0) console.warn('compile: ' + want[i].path + ': ' + res);
	}
	return true;
}
// page-split: install 46
// ══════════════════════════════════════════════════════════
// WHERE THIS DOCUMENT IS LAID OUT
// ----------------------------------------------------------
// Compile assumed "here", and on a phone that assumption is the fault: the
// author's 48-page book is 29 files the phone may not hold and 306 MB of wasm
// heap it may not have. What is here is measured -- the files by their stamps,
// the heap by the last build's own growth -- and the answer is the election's,
// so the machine a compile goes to is the machine a turn would go to.
// ══════════════════════════════════════════════════════════

// The synchronous dispatch guard. A button press, a retry and a take-back must
// not each post an errand for one document, and an async check between the
// intention and the post is exactly the window in which they can
// (`reference_daimond_dispatch_election`: the guard has to be set in the same
// tick as the decision, never after an await).
var _placing  = Object.create(null);	// cid -> true while an errand is in flight
var _builtFor = Object.create(null);	// cid -> the report, so a finished compile is not re-run
var _shaMemo  = Object.create(null);	// path + '\0' + stamp -> sha, so drawing the buttons is one read

/// This workspace's own identity, as the hand and the page both see it: the
/// first real line of `.daimond/workspace.id` in the folder, hashed short.
///
/// '' where this device cannot read one, and '' means ANY FOLDER on the wire --
/// the check narrows as both ends come to hold the file, and never widens. A
/// device holding only a replica genuinely does not know which machine's folder
/// its copy came from, and asserting one would be worse than saying nothing.
var _wsidMemo = null;
async function wsidNow() {
	if (_wsidMemo != null) return _wsidMemo;
	_wsidMemo = '';
	try {
		var b = await Wasm.read_bytes('.daimond/workspace.id', 0, 4096);
		var text = new TextDecoder().decode(b || new Uint8Array(0));
		var lines = text.split(/\r?\n/), tok = '';
		for (var i = 0; i < lines.length; i++) {
			var ln = lines[i].trim();
			if (!ln || ln.charAt(0) === '#') continue;
			tok = ln; break;
		}
		if (tok) _wsidMemo = (await DaimondPeer.docKeyFor('', tok)).slice(0, 16);
	} catch (e) { _wsidMemo = ''; }
	return _wsidMemo;
}

/// The index key this document's live preview is stored under.
async function docKeyOf(main) {
	return await DaimondPeer.docKeyFor(await wsidNow(), String(main || ''));
}

/// What the last successful build of this document said about it, from whichever
/// device made it: the import set, each import's hash, the heap the layout cost
/// and the artifact's chunk addresses. Null before anything has compiled it.
async function sidecarFor(main) {
	try {
		if (!window.DaimondCloud || !DaimondCloud.contentGet) return null;
		return DaimondCloud.contentGet('@p/' + (await docKeyOf(main))) || null;
	} catch (e) { return null; }
}

/// Write it, after a build that worked. One record per document per folder, so
/// the next device to open it knows what it will cost before it tries.
///
/// `ref` is the artifact's manifest where this device offloaded it (the runner
/// does; a device compiling for itself has no reason to upload two megabytes
/// nobody asked for) and an empty chunk list otherwise -- the numbers and the
/// hashes are the half that is always worth having.
async function writeSidecar(main, f) {
	var o = f || {};
	try {
		if (!window.DaimondCloud || !DaimondCloud.contentSet) return null;
		var imports = (o.imports || []).map(String);
		var hashes  = o.hashes || (await hashImports(imports));
		var ref = o.ref || null;
		var rec = {
			v:      ref ? ref.v : 2,
			size:   ref ? ref.size : 0,
			key:    ref ? ref.key : '',
			chunks: ref ? ref.chunks : [],
			kind:   'vector',			// the wire form; an 'svg' alternative would say so here
			main:   String(main || ''),
			wsid:   await wsidNow(),
			imports: imports,
			hashes: hashes,
			heapMB:   o.growth | 0,
			headroom: o.headroom | 0,
			pages:    o.pages | 0,
			by:     selfDeviceId(),
			name:   deviceLabelFor(selfDeviceId()) || '',
			ms:     o.ms | 0,
			ts:     Date.now(),
		};
		DaimondCloud.contentSet('@p/' + (await docKeyOf(main)), rec);
		return rec;
	} catch (e) { return null; }
}

/// The WHOLE of a workspace file, for taking its hash.
///
/// `read_bytes(path, 0, 0)` reads ZERO bytes: the range is
/// `min(offset + len, size)` (`read_file_range`, src/wasm/opfs.rs), so a length of
/// nothing is nothing. Every hash taken that way was the SHA-256 of the empty
/// string -- the SAME digest for every file in the book -- and two of those
/// compare equal, so a file that had moved under an errand was written over and
/// reported as current. The size is what `typst_watch_stamps` already answers
/// ("mtime:size"), so passing it in costs no second call where a stamp is in hand.
async function readWhole(path, size) {
	var n = size | 0;
	if (!(n > 0)) {
		try {
			var st = String((await Wasm.typst_watch_stamps([String(path)]))[0] || '');
			n = parseInt(st.split(':')[1], 10) | 0;
		} catch (e) { n = 0; }
	}
	if (!(n > 0)) return new Uint8Array(0);		// absent, or genuinely empty
	return await Wasm.read_bytes(String(path), 0, n);
}

/// `{ path: sha }` over an import set, memoised on `(path, stamp)`.
///
/// About two megabytes of source read once per draw of the buttons on the
/// author's book, and not again until a file's stamp moves -- which is what
/// makes it affordable to ask "is my copy the one that was compiled" every time
/// the panel redraws, rather than once and then hopefully.
async function hashImports(paths) {
	var list = (paths || []).map(String);
	if (!list.length) return {};
	var stamps = [];
	try { stamps = Array.from(await Wasm.typst_watch_stamps(list)).map(String); }
	catch (e) { stamps = []; }
	var out = {};
	for (var i = 0; i < list.length; i++) {
		var st = stamps[i] || '';
		if (st === '0:-1') continue;					// not here: nothing to hash
		var memo = list[i] + '\0' + st;
		if (_shaMemo[memo]) { out[list[i]] = _shaMemo[memo]; continue; }
		try {
			var b = await readWhole(list[i], parseInt(String(st).split(':')[1], 10));
			var h = await DaimondChunks._sha256Hex(b);
			_shaMemo[memo] = h;
			out[list[i]] = h;
		} catch (e) { /* unreadable is not "unchanged": simply unanswered */ }
	}
	return out;
}

/// THE DEVICE LEDGER: this device's own answer about itself, decided from real
/// signals and never from its name.
///
/// `files.missing` is the cheap probe -- `typst_watch_stamps` answers `0:-1` for
/// a path that is not there, 29 of them in about six milliseconds -- and it is
/// the only file question the placement asks. A file that is HERE but different
/// from the one compiled is not missing: it is changed, and changed files ride
/// the errand.
async function capabilityLedger(imports) {
	var W = window.DaimondTypstWatch;
	var st = null;
	try { st = W && W.state ? W.state() : null; } catch (e) { st = null; }
	var missing = [];
	var list = (imports || []).map(String);
	if (list.length) {
		try {
			var got = Array.from(await Wasm.typst_watch_stamps(list)).map(String);
			for (var i = 0; i < list.length; i++) if (got[i] === '0:-1') missing.push(list[i]);
		} catch (e) { missing = []; }		// a question that could not be asked is not an answer
	}
	var heap = 0;
	try { heap = (window.DaimondTypst && DaimondTypst.heapMB) ? DaimondTypst.heapMB() : 0; }
	catch (e) { heap = 0; }
	return {
		deviceId: selfDeviceId(),
		hand:     selfHoldsHand(),
		folder:   selfHoldsFolder(),
		mobile:   isMobileDeviceSelf(),
		budgetMB: st ? (st.budget | 0) : (isMobileDeviceSelf() ? 768 : 2500),
		heapMB:   heap | 0,
		headroom: st ? (st.headroom | 0) : 128,
		files:    { missing: missing },
	};
}

/// What one task needs, declared at the moment the button is drawn -- and again
/// at the click, because files change between the two.
async function taskNeeds(kind, main, side) {
	var car = side !== undefined ? side : await sidecarFor(main);
	var imports = (car && Array.isArray(car.imports) && car.imports.length)
		? car.imports.map(String) : [String(main)];
	// THE HEAP THIS DOCUMENT LAST COST, plus the headroom that build recorded.
	// A desktop's measurement of the same document is a FLOOR for a phone's,
	// which is the safe direction to be wrong in: it can only move a compile
	// away, never let one through that would end the tab.
	var mem = car ? ((car.heapMB | 0) + (car.headroom | 0)) : 0;
	return {
		kind:     kind,
		person:   kind === 'edit' || kind === 'view' || kind === 'terminal',
		files:    imports.map(function (x) { return { path: x, sha: (car && car.hashes && car.hashes[x]) || '' }; }),
		memoryMB: mem,
		hand:     ['publish', 'dev', 'run', 'verify', 'serve', 'terminal'].indexOf(kind) >= 0,
		network:  kind === 'publish',
		main:     String(main || ''),
	};
}

/// The placement for one kind over this document, right now.
async function placeFor(kind, main) {
	var car = await sidecarFor(main);
	var need = await taskNeeds(kind, main, car);
	var ledger = await capabilityLedger(need.files.map(function (f) { return f.path; }));
	var presence = annotatePresence((window.DaimondPresence && DaimondPresence.snapshot()) || {});
	return DaimondPeer.placeTask(need, ledger, presence, placeOpts(), Date.now());
}

/// The words a placement puts on a button and on its tooltip. Lifted out of the
/// render so the wording is testable without a DOM, as the seat switch's is.
function placeText(place) {
	if (!place || !place.key) return null;
	var nm = place.label || '';
	var sub = { name: nm || t('devices.unknown'), n: place.n,
		need: place.needMB, room: place.roomMB };
	// NO NAME, NO REASON. `place.why_needs_hand` names the machine that holds the
	// hand, and the app's only fallback label is `devices.unknown` -- which reads
	// "This device", the one machine the sentence is certainly not about. With
	// nothing on the roster it produced "Needs the machine hand, which This device
	// holds" under a button saying no device can do this. Where no machine is
	// known the answer in `key` stands on its own.
	return {
		text:  t(place.key, sub),
		title: (place.titleKey && (nm || place.why !== 'needs-hand'))
			? t(place.titleKey, sub) : '',
		can:   !!place.can,
	};
}

/// Label the Doc panel's two buttons with where they would run, and put the
/// reason on the hover. Cheap and idempotent, so it can be called on every
/// presence beat without thought.
var _docSeatFor = '';		// the document the buttons were last labelled for
export async function renderDocSeat() {
	if (!viewEl || !pg.curFile || !/\.typ$/i.test(pg.curFile)) return;
	var cBtn = viewEl.querySelector('[data-act="compile"]');
	var pBtn = viewEl.querySelector('[data-act="publish"]');
	if (!cBtn && !pBtn) return;
	var main;
	try { main = await mainFor(pg.curFile); } catch (e) { return; }
	// The document may have been closed, or another opened, while the awaits
	// above were in flight; labelling the new one from the old one's placement is
	// how a button comes to name a machine for a file nobody is looking at.
	if (!viewEl.querySelector('[data-act="compile"]')) return;
	_docSeatFor = main;
	for (var i = 0; i < 2; i++) {
		var btn = i === 0 ? cBtn : pBtn;
		if (!btn || btn.disabled) continue;
		var place;
		try { place = await placeFor(i === 0 ? 'compile' : 'publish', main); }
		catch (e) { continue; }
		if (_docSeatFor !== main) return;
		var txt = placeText(place);
		if (!txt) continue;
		btn.textContent = txt.text;
		if (txt.title) btn.title = txt.title; else btn.removeAttribute('title');
		// NOBODY IS A REFUSAL, AND IT SAYS WHOSE. A button that would post an
		// errand no machine can take is worse than one that will not be pressed.
		btn.classList.toggle('files-btn-off', !txt.can);
		btn.disabled = !txt.can;
		btn._place = place;
	}
}

/// Post one compile errand, and follow it. Answers `{ ok, why }`.
///
/// The ORDER is the errand's alone: nothing this runner needs is in the parcel
/// -- the changed files ride the envelope and the rest is already in the folder
/// it holds -- so there is no flush in front of the post, which is the 23-second
/// wait the turn's dispatcher had to be redesigned to remove.
async function dispatchCompile(main, place, msgEl, want) {
	var cid = 'cmp-' + (await docKeyOf(main));
	// SET IN THE SAME TICK AS THE DECISION. Everything below is async, and the
	// button, the retry and a take-back all reach here.
	if (_placing[cid]) return { ok: false, why: 'in-flight' };
	_placing[cid] = true;
	try {
		var car = await sidecarFor(main);
		var imports = (car && Array.isArray(car.imports) && car.imports.length)
			? car.imports.map(String) : [String(main)];
		var mine = await hashImports(imports);
		// WHAT IS COMPILED IS WHAT IS SAVED. An unsaved draft lives in browser
		// storage and on no disk anywhere, so it cannot be hashed, sent or laid
		// out -- and the message says so rather than letting the reader wonder why
		// the pages did not change.
		if (pg.editing) fileMsg(t('files.compile_unsaved'));
		var changed = [];
		for (var i = 0; i < imports.length; i++) {
			var pth = imports[i];
			if (!mine[pth]) continue;						// not here: the runner holds it
			if (car && car.hashes && car.hashes[pth] === mine[pth]) continue;
			var text = '';
			try { text = await readRaw(pth); } catch (e) { continue; }
			changed.push({ path: pth, sha: mine[pth], text: text });
		}
		var plan = DaimondPeer.compilePlan(changed);
		// The ONE refusal the plan can make, written as the literal key it is so
		// `dev/i18ncheck.mjs` can read it. A second refusal would want a second
		// sentence anyway, and a key in a variable is a sentence nothing checks.
		if (plan.refused) {
			if (msgEl) {
				msgEl.classList.add('err');
				msgEl.textContent = t('files.compile_too_many_changed', { n: plan.n });
			}
			return { ok: false, why: plan.why };
		}
		// A file too big to ride inline goes as chunks, the same door a Diamond's
		// bytes take. A device that cannot offload at all says so rather than
		// sending a truncated set, which would be a layout of a book that is not
		// the one on screen.
		var refs = [];
		if (plan.offload.length) {
			if (!filesSyncable() || !window.DaimondChunks || !DaimondChunks.offloadBytes) {
				if (msgEl) { msgEl.classList.add('err'); msgEl.textContent = t('files.compile_toolarge_to_send'); }
				return { ok: false, why: 'files.compile_toolarge_to_send' };
			}
			for (var j = 0; j < plan.offload.length; j++) {
				var f = plan.offload[j];
				var ref = await DaimondChunks.offloadBytes('compile:' + f.path,
					new TextEncoder().encode(f.text));
				refs.push({ path: f.path, sha: f.sha, ref: ref });
			}
		}
		var errand = DaimondPeer.makeCompileErrand({
			cid:    cid,
			main:   main,
			want:   want || 'vector',
			wsid:   await wsidNow(),
			docKey: await docKeyOf(main),
			files:  plan.inline,
			refs:   refs,
			expect: { imports: imports, hashes: mine },
			deadline: Date.now() + DaimondPeer.COMPILE_DEADLINE_MS,
			dispatchedBy: selfDeviceId(),
		});
		var body = await DaimondPeer.sealForSelf(errand);
		var res = await DaimondPost.post(body);
		if (!res || !res.ok) {
			if (msgEl) { msgEl.classList.add('err'); msgEl.textContent = t('files.compile_failed',
				{ reason: (res && res.why) || 'the relay would not take it' }); }
			return { ok: false, why: (res && res.why) || 'relay' };
		}
		if (msgEl) {
			msgEl.classList.remove('err');
			msgEl.textContent = t('files.compiling_on', { name: place.label || t('devices.unknown') });
		}
		watchCompile(cid, msgEl, place);
		return { ok: true, cid: cid };
	} catch (e) {
		if (msgEl) { msgEl.classList.add('err'); msgEl.textContent = t('files.compile_failed',
			{ reason: friendlyError(e) }); }
		return { ok: false, why: String((e && e.message) || e) };
	} finally {
		// Held until the report lands, not until the post returns: the guard is
		// about one compile in flight, not one post in flight.
		if (!_placing[cid]) delete _placing[cid];
	}
}

/// Follow one compile's progress door and stream it onto the panel's message
/// line -- through the same progress watch the hand-off tile uses, so a compile
/// holds nothing open at the gateway either. Bounded by the compile's own
/// deadline, past which no runner starts it.
function watchCompile(cid, msgEl, place) {
	var stop = function () {
		try { DaimondSync.unwatchProgress(cid); } catch (e) { /* sync gone with the page */ }
	};
	setTimeout(stop, DaimondPeer.COMPILE_DEADLINE_MS + 60000);
	DaimondSync.watchProgress(cid, function (frame) {
		if (!_placing[cid]) { stop(); return; }
		if (frame.tail && msgEl && msgEl.isConnected) {
			msgEl.textContent = t('files.compiling_on',
				{ name: (place && place.label) || t('devices.unknown') })
				+ ' ' + String(frame.tail);
		}
		if (frame.final) stop();
	});
}

/// A runner's account of a compile, collected here. The pages are drawn from the
/// artifact it offloaded; the sidecar it wrote is already in the index this
/// device merged, and this device's commit is what keeps the runner's chunks
/// alive (a folder-mounted machine never commits one).
async function onBuiltReport(report) {
	var r = report || {};
	var cid = String(r.cid || '');
	_builtFor[cid] = r;				// every device: a runner's `finished` reads it
	// ONLY THE DEVICE THAT ASKED DRAWS IT (R3 QA Q2). Everything below -- the
	// download, the preview that replaces whatever document was being watched, the
	// sheet pulled to Preview, the sidecar and the push -- is the dispatcher's.
	if (!DaimondPeer.builtIsOurs(r, selfDeviceId(), _placing[cid])) return;
	delete _placing[cid];
	try { DaimondSync.unwatchProgress(cid); } catch (e) { /* sync gone with the page */ }
	var msgEl = viewEl && viewEl.querySelector('.files-view-msg');
	var nm = deviceLabelFor(r.by) || t('devices.unknown');
	function say(text, isErr) {
		if (!msgEl || !msgEl.isConnected) return;
		msgEl.classList.toggle('err', !!isErr);
		msgEl.textContent = text;
		msgEl.style.display = '';
	}
	// TRAINING WHEELS — remove with the DEBUG_SHARE module. The debug feed's
	// `compile` row for a build THIS device did not do: `via:'runner'` marks it
	// apart from the button's own local compile above, so a reader of the lens
	// never mistakes one device's build for another's. The runner's `compile()`
	// (this file, `compileDeps`) always answers through `Wasm.typst_compile_project`
	// or `_vector` -- never the Austenite delta -- so `producer` is always `typst`
	// here, the same real-producer rule as the local branch. `ok` is the same
	// floor as the PDF path's, in the vector shape it actually has: a real draw
	// PLUS at least one page, since a report carries no PDF bytes to inspect.
	function reportCompileEvent(ok, bytes) {
		try {
			if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
				DEBUG_SHARE.event('compile', {
					main: r.main, producer: 'typst', via: 'runner', by: r.by,
					ok: !!ok, ms: r.ms | 0, bytes: bytes | 0,
					err: r.why ? String(r.why).slice(0, 120) : '', retried: false,
				});
			}
		} catch (e) { /* the feed must never break a report */ }
	}
	if (r.status === 'refused') {
		reportCompileEvent(false, 0);
		say(t('files.runner_refused', { name: nm, reason: r.why || '' }), true); return;
	}
	if (r.status === 'error') { reportCompileEvent(false, 0); say(String(r.why || ''), true); return; }
	if (!r.vector || !r.vector.chunks || !r.vector.chunks.length) {
		reportCompileEvent(false, 0);
		say(t('files.built_on', { name: nm, secs: ((r.ms | 0) / 1000).toFixed(1) }));
		return;
	}
	var W = window.DaimondTypstWatch;
	if (!W || !W.given) return;
	var drew = false;
	try {
		drew = await W.given(r.vector, { main: r.main, imports: r.imports,
			pages: r.pages, by: r.by, name: nm, ts: r.ts });
	} catch (e) { drew = false; }
	reportCompileEvent(drew && (r.pages | 0) >= 1, (r.vector && r.vector.size) | 0);
	if (!drew) { say(t('files.compile_failed', { reason: t('files.runner_refused',
		{ name: nm, reason: '' }) }), true); return; }
	try { if (window.DaimondSheet && DaimondSheet.tab) DaimondSheet.tab('preview'); } catch (e) { /* desktop has no sheet */ }
	say(t('files.built_on', { name: nm, secs: ((r.ms | 0) / 1000).toFixed(1) }));
	// FILES THAT MOVED under the errand: the runner compiled what it was sent
	// and said which of them had already changed again. Named, not hidden --
	// the pages on screen are of a copy one save behind.
	if (r.status === 'stale' && (r.moved || []).length) {
		say(t('files.compile_stale', { name: nm, n: r.moved.length }));
	}
	// The account of the build goes in the index whether or not this device made
	// it, so the NEXT press knows what the document costs. The runner wrote one
	// too; the freshest stamp wins, and this one is ours.
	await writeSidecar(r.main, { imports: r.imports, hashes: r.hashes,
		growth: (r.heap && r.heap.growth) | 0, headroom: (r.heap && r.heap.headroom) | 0,
		pages: r.pages, ms: r.ms, ref: r.vector });
	// AND THE COMMIT THAT KEEPS THE CHUNKS ALIVE. The runner uploaded them and
	// cannot name them; without this push the orphan collector is the only thing
	// standing between the pages on screen and addresses nothing refers to.
	nudgeSync();
	renderDocSeat();
}

/// The runner's side, as `runCompileErrand` takes it.
function compileDeps() {
	// DID THIS ERRAND PAUSE THE WATCH? Held per errand rather than per module,
	// because the pause belongs to the writes below and the resume to the compile
	// that follows them, and nothing else may put the loop back.
	var _held = false;
	return {
		selfId:    selfDeviceId(),
		selfName:  deviceLabelFor(selfDeviceId()),
		cas:       DaimondPeer.syncCas(peerSyncShim()),
		nominatedId:   nominatedDeviceId(),
		presence:      (window.DaimondPresence && DaimondPresence.snapshot()) || {},
		freshWindowMs: DaimondPeer.DISPATCH_FRESH_MS,
		finished:  async function (e) { return !!_builtFor[String(e.cid || '')]; },
		/// CAN THIS MACHINE LAY THIS DOCUMENT OUT AT ALL?
		///
		/// Two questions, and deliberately not a third. The workspace identity,
		/// where BOTH ends can read one, must match -- a runner that laid out a
		/// book from another tree would write the bytes into the wrong project
		/// and hand back pages of a document nobody asked for. An errand carrying
		/// none is accepted: the dispatcher is holding a replica and genuinely
		/// does not know whose folder its copy came from, and asserting one would
		/// be worse than saying nothing.
		///
		/// And the main has to BE here -- either already on this device or among
		/// the files the errand carries. What is NOT asked is whether this device
		/// holds a real mounted folder: that is what the PLACEMENT requires of a
		/// runner, and it is about where the preview PDF lands and what `run` may
		/// touch. A machine holding the whole book in its own storage can lay it
		/// out perfectly well, and refusing it here would refuse the phone's own
		/// compile by the same rule.
		check:     async function (e) {
			var mine = await wsidNow();
			if (e.wsid && mine && e.wsid !== mine) {
				return { ok: false, why: t('files.compile_failed', { reason: e.main }) };
			}
			var carried = (e.files || []).concat(e.refs || [])
				.some(function (f) { return f && f.path === e.main; });
			if (!carried) {
				var st = '';
				try { st = String((await Wasm.typst_watch_stamps([e.main]))[0] || ''); }
				catch (e2) { st = ''; }
				if (st === '0:-1') {
					return { ok: false, why: t('files.compile_failed', { reason: e.main }) };
				}
			}
			return { ok: true, why: '' };
		},
		/// EVERY CARRIED FILE BEFORE ANY COMPILE. `write_file` raises
		/// `daimond-file-written`, which the watch hears as `touched` and debounces
		/// into one rebuild -- so writing them in a batch is what keeps a hand-off
		/// to a device that has this document open at ONE layout rather than one
		/// per file.
		write:     async function (e) {
			var wrote = [], moved = [];
			// ONE LAYOUT FOR THE WHOLE ERRAND. Every `file_write` tells the watch
			// (`touched`), so a runner whose watch holds this document laid the book
			// out for the carried files AND again for the errand itself -- measured
			// as builds 1 → 4 on the author's book, three heap growths of about
			// 10 MB each on a heap that only ever grows. Paused, the writes are
			// REMEMBERED (`S.dirty`) and the errand's own rebuild below is the single
			// layout they get; `resume` in the compile step puts the loop back.
			try {
				var Wp = window.DaimondTypstWatch;
				var stp = (Wp && Wp.state) ? Wp.state() : null;
				if (stp && stp.path === e.main && Wp.pause) {
					_held = !!Wp.pause(t('files.compiling_path', { path: e.main }));
				}
			} catch (e2) { _held = false; }
			var all = (e.files || []).slice();
			for (var i = 0; i < (e.refs || []).length; i++) {
				var rf = e.refs[i];
				var bytes = await DaimondChunks.materialiseBytes(rf.ref);
				if (!bytes) continue;
				all.push({ path: rf.path, sha: rf.sha, text: new TextDecoder().decode(bytes) });
			}
			for (var j = 0; j < all.length; j++) {
				var f = all[j];
				var cut = String(f.path).lastIndexOf('/');
				if (cut > 0) {
					try { await tools().run_tool_outcome('dir_create',
						JSON.stringify({ path: String(f.path).slice(0, cut) })); } catch (e2) {}
				}
				// WHAT WAS HERE BEFORE, so a file that moved under the errand is named
				// rather than silently overwritten and compiled as if it were current.
				var was = '';
				try { was = await DaimondChunks._sha256Hex(await readWhole(f.path)); }
				catch (e2) { was = ''; }
				try {
					await tools().run_tool_outcome('file_write',
						JSON.stringify({ path: f.path, content: f.text }));
					wrote.push(f.path);
					if (was && f.sha && was !== f.sha && _movedSince(f.path, was)) moved.push(f.path);
				} catch (e2) { /* a file that would not write shows as a compile error */ }
			}
			return { wrote: wrote, moved: moved };
		},
		/// THROUGH THE WATCH where the watch holds this document, so the writes
		/// above and this errand are ONE layout and one heap growth. Two would be
		/// two, on a heap that only ever grows.
		compile:   async function (main, want) {
			if (!window.DaimondTypst) await import('../typst.js' /* page-split: rebased */);
			var before = (window.DaimondTypst && DaimondTypst.heapMB) ? DaimondTypst.heapMB() : 0;
			var t0 = Date.now();
			var W = window.DaimondTypstWatch;
			var st = null;
			try { st = W && W.state ? W.state() : null; } catch (e) { st = null; }
			var out;
			if (want === 'pdf') {
				out = await Wasm.typst_compile_project(main);
				if (out && out.pdf) await writeWorkspaceBytes(previewPdfPath(main), out.pdf);
			} else if (st && st.path === main && W.rebuild) {
				// The watch's own rebuild: it draws the runner's pages too, so the
				// machine doing the work sees what it built.
				var was = st.drawn | 0;
				W.rebuild();
				for (var w = 0; w < 600; w++) {
					var now = W.state();
					if (now.drawn > was || now.failed > (st.failed | 0)) break;
					await new Promise(function (r) { setTimeout(r, 200); });
				}
				out = await Wasm.typst_compile_project_vector(main);
			} else {
				out = await Wasm.typst_compile_project_vector(main);
			}
			// AND THE LOOP GOES BACK, whatever the compile answered. The writes paused
			// it so that they and this layout were one; leaving it paused would leave
			// the runner's own pages frozen for the next edit its author makes. The
			// rebuild above spent the remembered dirt, so this costs no second layout.
			if (_held) {
				_held = false;
				try { if (W && W.resume) await W.resume(); } catch (e2) { /* a dead loop is not resumable */ }
			}
			var after = (window.DaimondTypst && DaimondTypst.heapMB) ? DaimondTypst.heapMB() : 0;
			if (!out) return { error: t('files.compile_failed', { reason: 'no compiler' }) };
			if (out.error) return { error: String(out.error), ms: Date.now() - t0,
				watch: Array.from(out.watch || []).map(String),
				heap: { before: before, after: after, growth: after - before, headroom: 0 } };
			var watch = Array.from(out.watch || []).map(String);
			return {
				vector: out.vector || null,
				pdf:    out.pdf || null,
				pages:  out.pages | 0,
				ms:     Date.now() - t0,
				watch:  watch,
				hashes: await hashImports(watch),
				heap:   { before: before, after: after, growth: after - before,
					headroom: (st && st.headroom) | 0 },
			};
		},
		offload:   async function (bytes, docKey) {
			try { return await DaimondChunks.offloadBytes('@p/' + docKey, bytes); }
			catch (e) { return null; }
		},
		frame:     async function (cid, text, final) {
			if (!DaimondSync || !DaimondSync.pushProgressFrame) return;
			await DaimondSync.pushProgressFrame(cid, String(text || ''), !!final);
		},
		post:      async function (env) {
			await DaimondPost.post(await DaimondPeer.sealForSelf(env));
		},
		ack:       async function () { /* the collector acks the row it routed */ },
	};
}

/// Did `path` really move under us, or is this the first time it was written?
///
/// A path the runner did not hold at all reads as an empty hash, which is not a
/// file that changed -- it is a file that arrived.
function _movedSince(path, was) { return !!was; }

/// Hand the compile handlers to the collector, and tell the watch where to take
/// a rebuild of pages it did not lay out.
function wireCompileHandoff() {
	if (!window.DaimondPeer || !DaimondPeer.onCompile) return false;
	DaimondPeer.onCompile(async function (errand) {
		return await DaimondPeer.runCompileErrand(errand, compileDeps());
	});
	// RECORDED NOW, DRAWN AFTER. The collector folds this note under the mailbox
	// lock and waits for the handler, and the draw fetches the pages' chunks and
	// lays them out, for as long as the link and the layout take -- all of it
	// holding the lock every errand and report waits on (E-R4). `onBuiltReport`
	// records the account before its first await, so `_builtFor` is set when this
	// returns.
	DaimondPeer.onBuilt(function (report) {
		try { onBuiltReport(report).catch(function () { /* the panel keeps its last line */ }); }
		catch (e) { /* the panel keeps its last line */ }
	});
	if (window.DaimondTypstWatch && DaimondTypstWatch.placeWith) {
		DaimondTypstWatch.placeWith(async function (o) {
			var main = String((o && o.main) || '');
			if (!main) return false;
			var place;
			try { place = await placeFor('compile', main); } catch (e) { return false; }
			if (place.where !== 'runner') return false;
			var msgEl = viewEl && viewEl.querySelector('.files-view-msg');
			var res = await dispatchCompile(main, place, msgEl);
			return !!(res && res.ok);
		});
	}
	// EVERY GOOD BUILD ON THIS DEVICE WRITES THE SIDECAR, wherever it came from:
	// the button, the watch's own loop, the daimon's tool. One mechanism for "what
	// does this document cost", so a phone asking the question gets an answer
	// whichever machine happened to answer it last.
	try {
		window.addEventListener('daimond-typst-built', function (ev) {
			var d = (ev && ev.detail) || {};
			if (!d.path) return;
			writeSidecar(d.path, { imports: d.files, pages: d.pages, ms: d.ms,
				growth: d.growth, headroom: d.headroom });
		});
	} catch (e) { /* no window */ }
	return true;
}

/// The two compiler wordings that mean "a file this build needed was not here",
/// as `explainDiag` composes them (typst.js), and the trapped-compiler pair.
/// A press retries on one of these and on nothing else.
var LOCAL_MISS = /which was not among the \d+ files gathered|failed to load file|access denied/i;
var TYPST_TRAPPED = /recursive use of an object|unreachable/i;

/// The compiler's sentence, cut to a clause a message line can carry.
function shortReason(text) {
	var one = String(text || '').split('\n')[0].trim();
	return one.length > 120 ? one.slice(0, 117) + '\u2026' : one;
}

/// The placement, taken again with the missing set FORCED non-empty -- because
/// the compiler has just proved it. Without this the retry would re-ask a probe
/// that has already answered wrongly once and get the same answer.
async function placeForMissing(kind, main) {
	var car = await sidecarFor(main);
	var need = await taskNeeds(kind, main, car);
	var ledger = await capabilityLedger(need.files.map(function (f) { return f.path; }));
	if (!ledger.files.missing.length) ledger.files.missing = [String(main)];
	var presence = annotatePresence((window.DaimondPresence && DaimondPresence.snapshot()) || {});
	return DaimondPeer.placeTask(need, ledger, presence, placeOpts(), Date.now());
}

/// Did a PDF compile actually produce a page, or only the compiler's empty
/// shell? `Wasm.typst_compile_project` answers `ok` (no `error`) on a 108-byte
/// PDF with zero pages just as readily as on a real book, so `ev compile`'s
/// `ok` is set from THIS, never from the mere absence of an error. Cheap and
/// approximate on purpose -- a `/Count N` with N >= 1 anywhere in the object
/// graph, after the `%PDF` signature, is enough to tell a real document from
/// an empty one without writing a PDF parser for a debug counter.
function pdfHasPages(bytes) {
	if (!bytes || bytes.length < 5) return false;
	if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) return false; // %PDF
	var text;
	try { text = new TextDecoder('latin1').decode(bytes); } catch (e) { return false; }
	var m = /\/Count\s+(\d+)/.exec(text);
	return !!m && Number(m[1]) >= 1;
}

export async function compileTypst(path, btn) {
	var msgEl = viewEl.querySelector('.files-view-msg');
	if (!msgEl) return;
	// ONCE PER PRESS. The flag lives in this call, so a second press is a second
	// chance and a single press can hop at most once.
	var retried = false;
	var label = btn ? btn.textContent : '';
	if (btn) { btn.disabled = true; btn.textContent = '… ' + t('files.compiling'); }
	msgEl.style.display = ''; msgEl.classList.remove('err');
	msgEl.textContent = t('files.compiling_path', { path: path });   // escaped
	try {
		// A CHAPTER IS NOT A DOCUMENT, and pressing Compile on one used to be
		// refused: three `label <…> does not exist` errors, because the
		// cross-references a chapter makes are resolved by the book around it.
		// The author's own `dev` script has known the rule for years -- a
		// document is a file holding `#show: doc.with(`, `select_typst_file` at
		// ~/usr/books/ontheism/dev:39 -- so the same rule is applied here and
		// the MAIN is compiled, with the chapter's own page brought into view.
		var main = await mainFor(path);
		// ── WHERE THIS GOES ──────────────────────────────────────
		//
		// Asked again at the click, not trusted from the draw: files change
		// between a panel being labelled and a button being pressed, and the
		// whole of what the placement measures is files.
		var place = null;
		try { place = await placeFor('compile', main); } catch (e) { place = null; }
		if (place && place.where === 'runner') {
			var sent = await dispatchCompile(main, place, msgEl);
			if (sent && sent.ok) return;			// the report draws the pages
			// A relay that would not take it is not a reason to give up on the
			// document: fall through and try here, where the local guard still
			// holds and the failure will at least be the compiler's own.
		}
		if (place && place.where === 'nobody') {
			msgEl.classList.add('err');
			var nb = placeText(place);
			msgEl.textContent = nb ? nb.text : t('place.nobody_generic');
			return;
		}
		// THE BYTES BEFORE THE COMPILER. On a device holding the book's pictures and
		// fonts as ☁ rows -- which is every device that has never had native access
		// -- the gatherer would skip them and typeset the wrong book. See
		// `hydrateProject`, which says why a missing font is worse than a missing
		// picture.
		if (!(await hydrateProject(main, msgEl))) return;
		msgEl.textContent = t('files.compiling_path', { path: path });   // escaped
		// One driver, one memo. `typst.js` installs `window.DaimondTypst` and holds the
		// compiler promise itself, so the button and the agent's `typst_compile` tool
		// build the 30 MB wasm once between them; a private memo here would have been a
		// second one the tool could not reach.
		if (!window.DaimondTypst) await import('../typst.js' /* page-split: rebased */);
		// The PROJECT door, not the single-file one. A book is a closure of
		// imports, pictures and fonts, and the gathering happens in Rust so the
		// button and the model's `typst_compile` cannot disagree about what a
		// project is -- and so every byte is read under the OPFS path jail.
		//
		// This was `DaimondTypst.compile(readBytes(path))`, which hands the
		// compiler ONE source: the gatherer shipped in seq 116 with no production
		// caller at all, so a 63-file book compiled here came back "only the one
		// source was given to the compiler" and the daimon reading that concluded
		// the compiler could not resolve imports.
		var _compileT0 = Date.now();
		var out = await Wasm.typst_compile_project(main);
		if (!out) { out = { error: t('files.compile_failed', { reason: 'no compiler' }) }; }
		if (out.error) {
			// ── THE RETRY, ONCE ──────────────────────────────────
			//
			// A missing file or a heap trip is exactly what the placement would
			// have handed off for, had this device known in advance. It did not
			// -- no sidecar yet, a stamp that misjudged, a growth larger than the
			// estimate -- so the answer is the same one, taken late and said out
			// loud. NEVER a second time: a failure that repeats is the document's,
			// and a second automatic hop is how a double compile starts.
			var retriable = LOCAL_MISS.test(out.error) || TYPST_TRAPPED.test(out.error);
			if (retriable && !retried && place && place.deviceId && place.where !== 'nobody') {
				var late = null;
				try { late = await placeForMissing('compile', main); } catch (e) { late = null; }
				if (late && late.where === 'runner') {
					retried = true;
					msgEl.textContent = t('files.retrying_on',
						{ reason: shortReason(out.error), name: late.label });
					var again = await dispatchCompile(main, late, msgEl);
					if (again && again.ok) return;
				}
			}
			// TRAINING WHEELS — remove with the DEBUG_SHARE module. The debug feed's
			// `compile` row, error half: producer, elapsed ms and the error's first
			// 120 chars. Never the document's own content. Lifts out in one grep of
			// `DEBUG_SHARE`.
			//
			// `producer` names the REAL producer, never the live-view flag: this
			// button always compiles through typst.ts (`Wasm.typst_compile_project`),
			// never through Austenite, whatever `DaimondTypst.engine()` says the LIVE
			// VIEW is set to -- the flag gates a different door entirely (see
			// typst.js). This field used to be called `engine` and carry that flag;
			// it is `producer` now, on purpose, so an old archived row (wrong
			// meaning, old name) can never be read as a new one (right meaning) by
			// accident -- see `dev/lens.mjs`'s reader for the one-line fallback that
			// exists only to display those old rows.
			try {
				if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
					DEBUG_SHARE.event('compile', {
						main: main,
						producer: 'typst',
						ok: false,
						ms: Date.now() - _compileT0,
						bytes: 0,
						err: out.error ? String(out.error).slice(0, 120) : '',
						retried: retried,
					});
				}
			} catch (e) { /* the feed must never break a compile */ }
			msgEl.classList.add('err');
			msgEl.textContent = out.error;               // escaped
			return;
		}
		// TRAINING WHEELS — remove with the DEBUG_SHARE module. The debug feed's
		// `compile` row, success half: producer, elapsed ms and the PDF's byte
		// size. Never the document's own content. Lifts out in one grep of
		// `DEBUG_SHARE`.
		//
		// `ok` is NOT "no error" -- the compiler answers with no error on a
		// 108-byte PDF holding zero pages just as readily as on a real book, and
		// that used to log `ok=true`. `pdfHasPages` is the floor: `ok` is true
		// only when a page actually came back. `producer` is the real producer,
		// always `typst` here (see the error half's comment).
		try {
			if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
				DEBUG_SHARE.event('compile', {
					main: main,
					producer: 'typst',
					ok: pdfHasPages(out.pdf),
					ms: Date.now() - _compileT0,
					bytes: out.pdf.length,
					err: '',
					retried: retried,
				});
			}
		} catch (e) { /* the feed must never break a compile */ }
		var pdfPath = previewPdfPath(main);
		await writeWorkspaceBytes(pdfPath, out.pdf);
		// Render from a blob URL (same-origin) in the CENTRE panel, where
		// there is room to actually read the page.
		if (pg._pdfUrl) { URL.revokeObjectURL(pg._pdfUrl); pg._pdfUrl = null; }
		// A BLOB URL HOLDS ITS BYTES UNTIL IT IS REVOKED, and on a phone
		// nothing is ever going to read this one: `showDoc` leaves the
		// `<embed>` empty there and the live pages draw the layout instead.
		// 1.7 MB of a book held for a reader who cannot be shown it is exactly
		// the kind of thing an iOS tab is ended for.
		if (!(window.DaimondShell && DaimondShell.isPhone())) {
			var blob = new Blob([out.pdf], { type: 'application/pdf' });
			pg._pdfUrl = URL.createObjectURL(blob);
		}
		showDoc(pdfPath, pg._pdfUrl);
		msgEl.textContent = t('files.compiled',
			{ path: pdfPath, size: fmtFileBytes(out.pdf.length) });
		if (main !== path) {
			msgEl.textContent += ' ' + t('files.compiled_main', { main: main });
			// The book is 48 pages and the chapter is somewhere in the middle of
			// it, so landing on the title page is landing nowhere. Not awaited:
			// the sections are located a build after the pages are drawn, and the
			// message above must not wait for them.
			showChapterPage(path);
		}
	} catch (e) {
		msgEl.classList.add('err');
		msgEl.textContent = t('files.compile_failed', { reason: (e && e.message ? e.message : e) });
	} finally {
		if (btn) { btn.disabled = false; btn.textContent = label || t('files.compile'); }
	}
}

// ── The main of a project, the preview's own name, and Publish ──
//
// Three things a person editing a book needs that a one-file Compile button
// could not give: pressing Compile on a CHAPTER must build the book, the PDF
// it writes must not be the one the publishing pipeline owns, and the
// pipeline itself must be reachable from here.

/// What `dev` calls a document: a file that sets up its own page.
///
/// Verbatim from `select_typst_file` in the author's script -- "a document sets
/// up its own page with `#show: doc.with(`; a chapter or section file is
/// included by one". One rule in two places is one rule; a second spelling here
/// would be a second answer to "what is the book".
var MAIN_MARK = '#show: doc.with(';

/// How much of a sibling is read while looking for that mark.
///
/// A document's `#show` is in its preamble, within a few lines of the imports,
/// and reading whole chapters to find out they are chapters is a megabyte of
/// OPFS per press. The book this was measured on puts the mark at line 4.
var MAIN_HEAD = 64 * 1024;

/// The document to compile when the user pressed Compile on `path`.
///
/// The file itself where it is a document; otherwise the one beside it that is,
/// remembered per directory so the search happens once. Where nothing in the
/// directory says so -- a document built some other way -- the answer is the
/// file itself, which is `dev`'s own fallback and keeps the button doing what
/// it always did.
async function mainFor(path) {
	var p = String(path || '');
	if (!p || pg.storeFile) return p;
	if (await isMain(p)) return p;
	var cut = p.lastIndexOf('/');
	var dir = cut >= 0 ? p.slice(0, cut) : '';
	var key = 'daimond-typst-main:' + dir;
	var kept = '';
	try { kept = localStorage.getItem(key) || ''; } catch (e) { kept = ''; }
	// A remembered answer is re-checked rather than trusted: the file may have
	// been renamed, or the mark taken out of it, since it was written down.
	if (kept && kept !== p && await isMain(kept)) return kept;
	var names = [];
	try {
		var res = await tools().run_tool_outcome('file_list',
			JSON.stringify({ path: dir || '.' }));
		if (res && res.outcome === 'done') {
			names = parseSyncListing(res.text)
				.filter(function (e) { return !e.dir && /\.typ$/i.test(e.name); })
				.map(function (e) { return e.name; })
				.sort();
		}
	} catch (e) { names = []; }
	for (var i = 0; i < names.length; i++) {
		var full = dir ? (dir + '/' + names[i]) : names[i];
		if (full === p) continue;
		if (!(await isMain(full))) continue;
		try { localStorage.setItem(key, full); } catch (e) { /* private window */ }
		return full;
	}
	return p;
}

/// Does this file set up its own page?
async function isMain(path) {
	try {
		var b = await Wasm.read_bytes(String(path), 0, MAIN_HEAD);
		if (!b || !b.length) return false;
		return new TextDecoder().decode(b).indexOf(MAIN_MARK) >= 0;
	} catch (e) { return false; }
}

/// Where the in-app compile writes, which is NEVER where the pipeline writes.
///
/// `~/usr/books/ontheism/dev` composes `<name>.pdf` out of typst's own output
/// through Ghostscript (CMYK, for print) and a pikepdf metadata scrub; the
/// bytes this button produces are RGB, unscrubbed and from a different compiler
/// version. Writing them to `<name>.pdf` replaced the FINAL of a book with a
/// draft of it, silently, and the only tell was the size -- 1.7 MB against the
/// pipeline's 408 KB.
function previewPdfPath(mainPath) {
	return String(mainPath || '').replace(/\.typ$/i, '') + '-preview.pdf';
}

var PUBLISH_CAP    = '3G';
var PUBLISH_SCRIPT = 'dev';
/// How long Publish waits on the machine before it stops listening.
///
/// `dev` is a WATCHER, not a one-shot: it starts `typst watch`, a colour
/// watcher and a scrub watcher, opens the PDF and waits. The final PDF is
/// written by the first pass through all three -- about a minute on the
/// author's book -- and everything after that is the watch. So this waits long
/// enough for the first pass and says, in as many words, that the script goes
/// on running.
var PUBLISH_MS = 240000;

/// The command Publish runs, as `{ argv, cwd }`.
///
/// Composed rather than executed here so that what is sent to the machine can
/// be asserted -- and read by the person before they allow it, since `run`
/// shows the command line in its own dialog.
///
/// UNDER A MEMORY CAP, because a full book costs ~2.9 GB resident and
/// `typst watch` PARKS at that peak for as long as it runs (measured
/// 2026-08-07, memory `reference_typst_compile_memory`). Two of them is more
/// than the machine has. The scope is the user's own, so nothing here needs
/// root and a runaway kills itself rather than the session.
///
/// THROUGH `bash`, and that is not decoration. `run` has no shell, and
/// `systemd-run` wants a program it can find on PATH -- `./dev` is neither.
/// Handing the script to `bash` as an argument resolves it against `cwd`, which
/// is where the project is.
function publishCommand(mainPath) {
	var m = String(mainPath || '');
	var cut = m.lastIndexOf('/');
	return {
		argv: ['systemd-run', '--user', '--scope', '--quiet',
			'-p', 'MemoryMax=' + PUBLISH_CAP,
			'bash', './' + PUBLISH_SCRIPT, cut >= 0 ? m.slice(cut + 1) : m],
		cwd:  cut >= 0 ? m.slice(0, cut) : '.',
	};
}

/// The last command Publish composed, for a verifier to read back.
var _lastPublish = null;

/// Run the project's own publishing script on the machine.
///
/// It is the only place Ghostscript and pikepdf exist, so this is a `run` and
/// not something reimplemented in the page. The machine hand is a program the
/// user installs; without one the tool refuses in its own words and those are
/// what the panel shows.
export async function publishViaDev(path, btn) {
	var msgEl = viewEl.querySelector('.files-view-msg');
	if (!msgEl) return;
	var label = btn ? btn.textContent : '';
	if (btn) { btn.disabled = true; btn.textContent = '… ' + t('files.publishing'); }
	msgEl.style.display = ''; msgEl.classList.remove('err');
	try {
		var main = await mainFor(path);
		// PUBLISH IS A `run`, so only a device with the machine hand may do it.
		// Where this one has not got it the answer is a sentence naming a machine
		// that has, not a tool refusal the reader has to interpret. Phase 2 sends
		// the errand; phase 1 says where it would have to go.
		var place = null;
		try { place = await placeFor('publish', main); } catch (e) { place = null; }
		if (place && place.where !== 'here') {
			msgEl.classList.add('err');
			var pt = placeText(place);
			// THE ANSWER, NOT THE REASON BEHIND IT. `key` is the sentence written for
			// a reader -- "Publish on argonaut", or "No device that can do this is
			// awake" -- and `titleKey` is the measurement under it. The reason for a
			// publish is `place.why_needs_hand`, "Needs the machine hand, which {name}
			// holds", which names a holder: put in front of somebody whose answer was
			// NOBODY it asserts a machine that does not exist.
			msgEl.textContent = (pt && pt.text) ? pt.text : t('place.nobody_generic');
			return;
		}
		var cmd = publishCommand(main);
		_lastPublish = cmd;
		msgEl.textContent = t('files.publishing_cmd',
			{ cmd: cmd.argv.join(' '), cwd: cmd.cwd });
		var res = await tools().run_tool_outcome('run', JSON.stringify({
			argv: cmd.argv, cwd: cmd.cwd, timeout_ms: PUBLISH_MS }));
		if (!res || res.outcome !== 'done') {
			msgEl.classList.add('err');
			msgEl.textContent = t('files.publish_failed', { reason: toolReason(res) });
			return;
		}
		// The script's own output, verbatim: it names each stage as it finishes
		// and says whether the metadata scrub found a leak, and a paraphrase
		// would lose the one line the author acts on.
		msgEl.textContent = t('files.published',
			{ path: String(main).replace(/\.typ$/i, '.pdf') })
			+ '\n' + stripAnsi(String(res.text || ''));
	} catch (e) {
		msgEl.classList.add('err');
		msgEl.textContent = t('files.publish_failed', { reason: friendlyError(e) });
	} finally {
		if (btn) { btn.disabled = false; btn.textContent = label || ('⇪ ' + t('files.publish')); }
	}
}

// ── What the watch says, where the author is looking ────────────
//
// The pages are one panel and the source is another, and everything the loop
// has to say happens while the person is in the SOURCE: the build broke, the
// pages went off screen and stopped rebuilding. `js/typstwatch.js` raises those
// as events carrying a path and a line and nothing Typst-shaped; this is the
// half that puts them on the panel holding that path.

/// Is this diagnostic about the file on screen?
///
/// The compiler names a file as it saw it -- root-relative, leading slash --
/// and the panel holds a workspace-relative path, so neither is a prefix of the
/// other. Matched at a segment boundary, so `chap.typ` does not answer for
/// `rev_chap.typ`.
function noteIsMine(path) {
	var a = String(path || '').replace(/^\/+/, '');
	var b = String(pg.curFile || '');
	if (!a || !b) return false;
	if (a === b) return true;
	return b.length > a.length && b.slice(-a.length) === a
		&& b.charAt(b.length - a.length - 1) === '/';
}

/// Put a standing word from the loop on the note line, or take it away.
function noteLine(text, isErr, jump) {
	var el = viewEl && viewEl.querySelector('.files-view-note');
	if (!el) return;
	if (!text && !jump) { el.style.display = 'none'; el.textContent = ''; return; }
	el.textContent = '';
	el.classList.toggle('err', !!isErr);
	if (jump) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'files-jump';
		b.textContent = jump.label;
		b.title = t('files.go_to_line', { line: jump.line });
		b.addEventListener('click', function () { goToLine(jump.line); });
		el.appendChild(b);
	}
	// The space is in the TEXT and not only in the margin: a reader with a
	// screen reader hears the two run together without it, and so does a check.
	el.appendChild(document.createTextNode((jump && text ? ' ' : '') + (text || '')));
	el.style.display = '';
}

/// Move the caret to line `n` of the open file, opening the editor to do it.
///
/// Through the Edit button rather than beside it, so the caret, the Cancel that
/// backs out and the Save that writes are the ones every other edit gets.
function goToLine(n) {
	var line = Math.max(1, Math.floor(Number(n) || 1));
	var ta = viewEl && viewEl.querySelector('.files-edit');
	if (!ta) {
		var eb = viewEl && viewEl.querySelector('[data-act="edit"]');
		if (!eb || pg.editing) return false;
		eb.click();
		ta = viewEl.querySelector('.files-edit');
		if (!ta) return false;
	}
	var lines = ta.value.split('\n');
	if (line > lines.length) line = lines.length;
	var at = 0;
	for (var i = 0; i < line - 1; i++) at += lines[i].length + 1;
	ta.focus();
	ta.setSelectionRange(at, at + (lines[line - 1] || '').length);
	// A textarea does not scroll to its own selection, so the line is put where
	// it can be read -- the middle of the box, not its last row.
	var lh = parseFloat(getComputedStyle(ta).lineHeight);
	if (!(lh > 0)) lh = 16;
	ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2);
	ta.scrollLeft = 0;
	return true;
}

/// The first heading in a chapter, as words, or ''.
function firstHeading(text) {
	var m = /^=+[ \t]+(.+)$/m.exec(String(text || ''));
	if (!m) return '';
	// The label a heading carries -- `= Practice <practice>` -- is markup, and
	// the rail has only what was typeset.
	return m[1].replace(/<[^>]*>\s*$/, '').trim();
}

/// Bring the chapter's own page into view.
///
/// The book is 48 pages and the chapter is somewhere in the middle, so landing
/// on the title page is landing nowhere. `goToSection` finds where the heading
/// was typeset -- the compiler answers `[]` for a heading's location, so it has
/// to be read off the laid-out pages -- and scrolls there.
async function showChapterPage(chapterPath) {
	var W = window.DaimondTypstWatch;
	if (!W || !W.goToSection) return 0;
	var want = '';
	try { want = firstHeading(await readRaw(chapterPath)); } catch (e) { return 0; }
	if (!want) return 0;
	return await W.goToSection(want);
}

// Write binary bytes into the ACTIVE workspace root: a compiled PDF, a saved message, an
// upload from the machine. Everything else in this panel goes through `run_tool`, which
// carries text; this is the one door for bytes.
//
// Rust owns the write. It applies the path jail, the real-folder override AND the
// per-account namespace, and it is the last of those that matters here: this function used
// to walk the origin OPFS root itself, so a secondary account's compiled PDFs and saved
// mail landed in the PRIMARY account's workspace, readable by whoever else uses this
// browser. A hand-rolled walk cannot know about an account; the wasm edge already does.
async function writeWorkspaceBytes(path, bytes) {
	await tools().write_bytes(String(path),
		bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

// Briefly flash a status line in the open file's header (Saved / error).
//
// `host` says WHICH header: the document's by default, the preview's when
// the preview is the one that failed. Without it a picture that would not
// decode reported itself in the header of an unrelated text file.
export function fileMsg(text, isErr, host) {
	var into = host || viewEl;
	var el = into && into.querySelector('.files-view-msg');
	if (!el) {
		// No file is open (e.g. a delete from the tree), so there is no
		// header to flash. Say it where the user is actually looking.
		showModeMsg(text, !!isErr);
		return;
	}
	el.textContent = stripAnsi(text); el.style.display = '';
	el.classList.toggle('err', !!isErr);
	// An error stays until the next action; a success fades.
	clearTimeout(el._t);
	if (!isErr) el._t = setTimeout(function () { el.style.display = 'none'; }, 2500);
}

/// Where a new file, folder or upload lands.
///
/// The directory being shown, except at the top of a Diamond's workspace,
/// which is a composed view rather than a directory: there, new work goes
/// into the Diamond's own directory, which is the one place its daimon can
/// always write. Without this it landed at the workspace ROOT -- outside
/// the very Diamond the panel was showing.
function writeDir() {
	return curDir;
}

/// Where a write lands right now, in the mode row's own words.
///
/// Borrowed rather than restated: the Workspace panel's Machine chip already
/// carries the folder's name and its Browser chip already carries the word for
/// the sandbox, and two surfaces naming one place differently is how a reader
/// comes to believe there are three.
export function placeName() {
	return folderHandle ? folderHandle.name : t('files.mode_browser');
}

/// A name for a new document that can be found again tomorrow.
///
/// Dated, so a folder of them sorts into the order they were written, and
/// numbered from the second of a day onwards so opening the panel twice cannot
/// put one document on top of another. It is a PROPOSAL: nothing is on disk
/// until Save, and Save's own conflict check guards the case where something
/// arrived at the path in between.
async function freeNotePath() {
	var into = writeDir();
	var d = new Date();
	var stamp = d.getFullYear() + '-'
		+ String(d.getMonth() + 1).padStart(2, '0') + '-'
		+ String(d.getDate()).padStart(2, '0');
	var here = [];
	try {
		var res = await tools().run_tool_outcome('file_list',
			JSON.stringify({ path: into || '.' }));
		if (res && res.outcome === 'done') {
			here = parseListing(res.text).map(function (e) { return e.name; });
		}
	} catch (e) { /* an unreadable folder is not a reason to refuse a name */ }
	for (var n = 1; n < 1000; n++) {
		var name = 'notes-' + stamp + (n === 1 ? '' : '-' + n) + '.md';
		if (here.indexOf(name) === -1) return joinPath(into, name);
	}
	return joinPath(into, 'notes-' + stamp + '-' + Date.now() + '.md');
}

/// What the Doc panel shows when it is asked for and holds nothing.
///
/// It held NOTHING AT ALL: `#doc-view` starts empty and `display:none`, and
/// `DaimondPanels.show` carried a hook for the Workspace, Mail, Spending, the
/// Terminal, the Trash and Social and none for this one -- so the chip opened a
/// rectangle with a close button in it and no other mark. Worse after a
/// document had been closed, since `closeView` empties the body and leaves the
/// title naming the file that is no longer there.
///
/// A document already up is left alone: this is the EMPTY case and nothing
/// else. `curFile` is the panel's own record of what it holds and `closeView`
/// clears it, so a panel closed and reopened is empty again and gets another
/// new document rather than the last one silently back.
async function onDocOpen() {
	if (docFilling > 0 || pg.curFile) return;
	try { await openFile(await freeNotePath(), { blank: true }); }
	catch (e) { fileMsg(t('files.create_failed', { reason: friendlyError(e) }), true); }
}

/// Make an empty file called `name` in the folder on screen, and open it to edit.
export async function newFile(name) {
	var into = writeDir();
	var p = joinPath(into, name);
	// ONE seed text, from the wasm, so the file a user makes by hand and the file the
	// app seeds are the same file. They were two strings saying different things.
	var seed = (p === INSTRUCTIONS_FILE) ? instructionsSeed() : '';
	try {
		var w = await tools().run_tool_outcome('file_write',
			JSON.stringify({ path: p, content: seed }));
		// The result used to be thrown away, so a refused create opened an editor
		// on a file that was never made.
		if (!w || w.outcome !== 'done') {
			fileMsg(t('files.create_failed', { reason: toolReason(w) }), true);
			return;
		}
		await list(curDir);
		await Instructions.refresh();
		await Prompts.refresh();
		nudgeSync();	// a new file outside a turn pushes on its own
		openFile(p);
	} catch (e) { fileMsg(t('files.create_failed', { reason: friendlyError(e) }), true); }
}

/// Create a folder. Only an agent could make one before — and only as a
/// side effect of writing a file into it. The user had no way at all.
export async function newDir(name) {
	var res = await tools().run_tool_outcome('dir_create',
		JSON.stringify({ path: joinPath(writeDir(), name) }));
	if (!res || res.outcome !== 'done') {
		fileMsg(t('files.create_folder_failed', { reason: toolReason(res) }), true);
	}
	await list(curDir);
}

/// Rename or move an entry. `to` may carry a path, so this is also how a
/// file is moved into another folder.
///
/// `from` is the entry's own path, which is not always under `curDir`: a
/// Diamond's workspace shows its own directory at the top of a composed
/// tree, where `curDir` is not a directory at all.
export async function renameEntry(e, from) {
	from = from || joinPath(curDir, e.name);
	var parent = from.slice(0, Math.max(0, from.lastIndexOf('/')));
	var name = await promptDialog(t('rail.rename'), {
		message: t('files.rename_hint'),
		value: e.name, okLabel: t('rail.rename'),
		validate: function (v) { return v ? '' : t('files.err_name'); },
	});
	if (name === null) return;
	name = name.trim();
	if (!name || name === e.name) return;
	var to = name.indexOf('/') === -1 ? joinPath(parent, name) : name;
	var res = await tools().run_tool_outcome('file_move', JSON.stringify({ path: from, to: to }));
	if (!res || res.outcome !== 'done') {
		fileMsg(t('files.rename_failed', { reason: toolReason(res) }), true);
	} else nudgeSync();	// a rename or move outside a turn pushes on its own
	await list(curDir);
}

/// Bring files in from the machine. The workspace could only ever be
/// filled by an agent writing into it.
export function uploadFiles() {
	var inp = document.createElement('input');
	inp.type = 'file';
	inp.multiple = true;
	inp.addEventListener('change', async function () {
		var files = Array.prototype.slice.call(inp.files || []);
		if (!files.length) return;
		for (var i = 0; i < files.length; i++) {
			var f = files[i];
			try {
				var buf = new Uint8Array(await f.arrayBuffer());
				await writeWorkspaceBytes(joinPath(writeDir(), f.name), buf);
			} catch (err) {
				fileMsg(t('files.upload_failed', { name: f.name, reason: friendlyError(err) }), true);
			}
		}
		await list(curDir);
		fileMsg(tn('files.uploaded', files.length));
	});
	inp.click();
}

/// Show or hide the PREVIEW panel's PDF embed, and the other renderings of
/// that panel with it.
///
/// One panel, three renderings -- the embed, whatever the viewer draws in
/// `#pv-view`, and the live typeset pages -- and whichever is showing, the
/// others are not. Releasing the blob URL when the embed goes away keeps a
/// long session from holding every PDF it has ever compiled.
export function docEmbed(on) {
	var e = document.getElementById('doc-embed');
	if (!e) return;
	e.style.display = on ? '' : 'none';
	if (!on) {
		e.removeAttribute('src');
		if (pg._pdfUrl) { URL.revokeObjectURL(pg._pdfUrl); pg._pdfUrl = null; }
	}
}

/// Put the header's line-number toggle where the panel is: on and pressed
/// only over a text file being READ, since a binary, the cloud view and the
/// editor's textarea have no lines to number, and a control that cannot do
/// anything is one the reader has to rule out.
///
/// IT ASKS ABOUT THE DOC PANEL AND NOTHING ELSE, and that is what the split
/// of the preview out of this panel bought. The predicate used to carry a
/// `#doc-view` display term, because a PDF and the live typeset pages could
/// each stand in front of the text view inside the SAME panel, and it carried
/// a written argument for why `#typst-live` needed no term of its own. Both
/// are gone with the cause: the pages are a different panel now, nothing
/// stands in front of the document, and a toggle that belongs to the file in
/// the editor is decided by the file in the editor.
///
/// `docEmbed` no longer calls this either, for the same reason: the embed's
/// coming and going says nothing about the document.
export function syncLineNo() {
	var btn = document.getElementById('doc-lineno');
	if (!btn) return;
	var text = !!pg.curFile && typeof pg.curContent === 'string' && !pg.editing;
	btn.style.display = text ? '' : 'none';
	btn.classList.toggle('on', showLineNos);
	btn.setAttribute('aria-pressed', showLineNos ? 'true' : 'false');
}
// page-split: install 47

export async function readRaw(path, viaStore) {
	// The door is PASSED, not read off the module flag (S-HAND #4): `openFile` commits
	// `storeFile` only AFTER a read has succeeded, so a read that throws cannot leave
	// the flag flipped for the NEXT open (a store picture opened over a workspace text
	// file used to flip it, sending the following read/conflict-check/save to the wrong
	// root). A caller that is not choosing a door omits the argument and gets the
	// current `storeFile`, exactly as before. A read straight at the wasm, so a
	// withdrawn grant fails here and `noteFolderLost` carries it to the one handler;
	// OPFS (the store door) is not a grant and cannot be revoked, so it is left out.
	var s = (arguments.length > 1) ? !!viaStore : pg.storeFile;
	if (s) return await Wasm.store_read(path);
	try { return await Wasm.read_file(path); }
	catch (e) { noteFolderLost(e); throw e; }
}

// ── WHAT IS TYPED BUT NOT SAVED ──────────────────────────────
//
// An iOS tab is ended, not suspended: the system reclaims a backgrounded page
// by killing it, and everything in a textarea goes with it. The author edits a
// chapter on the phone, takes a call, comes back to a reloaded app and a file
// exactly as it was before he started typing -- with no message, because
// nothing failed. Nothing in the app knew there had been anything to lose.
//
// So every keystroke lands in browser storage, keyed by path, and opening the
// file again offers it back. It is NOT an autosave: the file on disk is
// untouched, the explicit Save is still the only thing that writes, and the
// daimon's own `file_edit` and the three-way sync merge are therefore
// unaffected -- which is the reason an autosaving textarea was refused when
// this was first proposed.
var DRAFT_KEY = 'daimond-doc-draft:';

/// Keep what is in the editor, without touching the file.
export function draftKeep(path, text, base) {
	if (!path) return;
	try {
		localStorage.setItem(DRAFT_KEY + path,
			JSON.stringify({ text: text, base: base, at: Date.now() }));
	} catch (e) { /* private mode, or full: the edit is still on screen */ }
}

/// What was typed into `path` and never saved, or null.
///
/// A draft that says exactly what the file says is not a draft: it is what
/// Save already wrote, or what the reader typed and then undid, and offering
/// to "restore" it would put a notice over a file nothing had happened to.
export function draftRead(path, disk) {
	if (!path) return null;
	try {
		var raw = localStorage.getItem(DRAFT_KEY + path);
		if (!raw) return null;
		var d = JSON.parse(raw);
		if (!d || typeof d.text !== 'string') return null;
		if (d.text === disk) { draftDrop(path); return null; }
		return d;
	} catch (e) { return null; }
}

/// Let a draft go: it was saved, or thrown away on purpose.
export function draftDrop(path) {
	if (!path) return;
	try { localStorage.removeItem(DRAFT_KEY + path); } catch (e) { /* nothing kept */ }
}

/// Write the file the Doc panel has open, through whichever door it came from.
///
/// Both doors answer `{ outcome, text }`, because they report a failure differently
/// and the caller must not have to know which one it used: `store_write` REJECTS,
/// while a tool call RESOLVES whatever became of it. So a refused save resolved,
/// took the success branch, and told the user the file was saved -- while the fence
/// had stopped the write and the edit existed nowhere but in the textarea.
export function writeOpenFile(path, content) {
	// THE USER'S OWN WRITE DOOR (contract §2), so the file is marked dirty
	// and the next turn snapshots what is on disk NOW -- before the daimon
	// touches it. Marked BEFORE the write and not after: the drain re-hashes
	// against the index, so a mark for a write that then failed costs one
	// hash and records nothing. AND THE MARK KEEPS WHAT THE FILE HOLDS NOW as
	// the row's `was`, and the write waits for it (2026-09-25): a file the
	// store had never seen was recorded as created, and a Restore to before
	// the edit offered to delete it rather than put it back.
	var vp = versionsPath(path);
	var marked = Promise.resolve();
	if (vp && window.DaimondVersions) {
		if (DaimondVersions.dirtyBefore) marked = DaimondVersions.dirtyBefore(vp.id, vp.rel);
		else DaimondVersions.dirty(vp.id, vp.rel);
	}
	if (pg.storeFile) {
		return marked.then(function () { return Wasm.store_write(path, content); })
			.then(function () { return { outcome: 'done', text: '' }; });
	}
	// THE SEEN-CACHE ANCHOR CAN GO STALE UNDER A DOOR THE GUARD CANNOT SEE. The guard inside
	// file_write compares disk bytes against what the last TOOL call saw of this path -- an
	// anchor drifted by every non-tool write (the raw store branch above, sync materialising
	// the file, a Restore) and never refreshed by this panel, whose own reads are raw. One
	// stale anchor then refuses every save forever -- the panel cannot "re-read and reapply"
	// because nothing in its flow ever re-anchors. The panel holds the current bytes (readRaw,
	// and its soft conflict check already ran against them), so its save is anchored to what
	// the user actually saw: one tool-layer read refreshes the anchor, then the write passes
	// the guard honestly. Forge proposal #14.
	return marked.then(function () {
		return tools().run_tool_outcome('file_read',
			JSON.stringify({ path: path })).then(function () {
			return tools().run_tool_outcome('file_write',
				JSON.stringify({ path: path, content: content }));
		});
	});
}

export function renderFileBody() {
	syncLineNo();
	var body = viewEl.querySelector('.files-view-body');
	if (!body) return;
	if (showLineNos) {
		var lines = pg.curContent.split('\n');
		var html = '';
		for (var i = 0; i < lines.length; i++) {
			// Each numbered line is its own block, so that a long line
			// wrapping continues past the gutter instead of returning to
			// the margin. A hanging indent needs a block to hang from,
			// and `text-indent` on the <pre> indents only the first line
			// of the whole file -- which is what it was doing.
			html += '<span class="lnrow"><span class="ln">' + (i + 1) + '</span>'
				+ esc(lines[i]) + '</span>';
		}
		body.innerHTML = html;        // only line numbers + escaped text
		body.classList.add('with-lineno');
	} else {
		body.textContent = pg.curContent;
		body.classList.remove('with-lineno');
	}
}

/// Close the document. Typed work is never thrown away in silence: leaving
/// the view mid-edit used to discard it without a word, which made Back the
/// only exit from edit mode AND a destructive one.
///
/// It closes the DOCUMENT and not the preview. Backing out of a source file
/// leaves the pages it was typeset into on screen, which is the point of
/// their being two panels; `closePreview` is the other half.
export async function closeView() {
	var ta = viewEl.querySelector('.files-edit');
	if (pg.editing && ta && ta.value !== pg.curContent) {
		var go = await confirmDialog(
			t('files.unsaved_close', { path: pg.curFile || t('files.this_file') }),
			t('files.discard'),
			{ title: t('files.discard_title'), danger: true, cancelLabel: t('files.keep_editing') });
		if (!go) return;
		// He said discard, so there is nothing to offer back next time. A
		// draft kept past an explicit discard would put the words he threw
		// away back in front of him the moment he reopened the file.
		draftDrop(pg.curFile);
	}
	shutView();
}

/// Put the document away without asking: what was typed is already kept as a draft
/// (`draftKeep`, every keystroke), and opening the file again offers it back.
function shutView() {
	viewEl.style.display = 'none';
	pg.curFile = null; pg.editing = false;
	pg.docRelabel = null;                   // no view, no words of its own to put right
	syncLineNo();                        // after the file is let go, not before
	DaimondPanels.hide('doc');
}

// ── A CONVERSATION'S PANELS GO AND COME BACK WITH IT (UNBLOCK-14) ──
//
// The Work panel follows the open conversation, and since CAPTURE-FENCE (rc-b's
// ruling (2), 2026-10-12) the Doc and Preview leave the screen with theirs, so
// Diamond A's document never sits beside B's thread for B's capture to save.
//
// That fence used to CLOSE them and remember nothing, so a file was lost on
// every round trip (D-20261015-17: *"panel state is not kept when switching
// between daimons and chats"*). Now leaving a conversation writes its PANEL
// RECORD (js/panelrec.js) first -- layout, Doc file and aim, Preview, Web
// address, the Terminal as a panel of the layout -- and arriving puts the
// arriving one's record back, with any file its turns showed while it was off
// screen. One owner: this replaced the Diamond-only "save arrangement" and the
// viewer's take-once `deferred`.
//
// The first conversation of the session only claims the panels, so what the
// tab's boot put back stays.
var panelsOwner = null;		// convKey() the panels were last claimed for
/// Panels whose content belongs to a conversation: they leave with it.
var CONV_PANELS = ['doc', 'preview', 'web', 'term'];

function PR() { return window.DaimondPanelRec || null; }

/// What this conversation's panels hold now, as its record.
function captureRecord() {
	var rec = { layout: DaimondPanels.snapshot() };
	// What a CLOSED panel last held is not what it holds: a Doc the person
	// closed keeps `curFile` behind it, and recording that would open it again
	// on the way back.
	if (pg.curFile && DaimondPanels.isOpen('doc') && viewEl.style.display !== 'none') {
		var body = viewEl.querySelector('.files-edit, .files-view-body');
		rec.doc = { path: pg.curFile, store: pg.storeFile, top: body ? Math.round(body.scrollTop) : 0 };
	}
	if (pg.pvFile && DaimondPanels.isOpen('preview')) rec.preview = { path: pg.pvFile, store: pg.pvStore };
	if (DaimondPanels.isOpen('web') && window.DaimondWeb) {
		try {
			var st = DaimondWeb.status();
			// A blob page is this tab's and dies with it; the guide is no address.
			if (st && st.url && st.driver !== 'guide' && !/^blob:/i.test(st.url)) rec.web = { url: st.url };
		} catch (e) { /* no page is the ordinary case */ }
	}
	return rec;
}

/// Write the record of the conversation being left.
function leaveConversation(key) {
	if (key && PR()) PR().put(key, captureRecord());
}

/// Put the arriving conversation's panels back, or, with no record, leave the
/// layout as it is less the panels that held the last one's things.
function arriveConversation(key) {
	var rec = (key && PR()) ? PR().get(key) : null;
	// A Doc already open is not opened again, so its hook does not run: the
	// note it starts is started here instead.
	var wasDoc = DaimondPanels.isOpen('doc');
	var shows = (rec && rec.shows) || [];
	// Only the panels the record fills are put back by hand; one it names open
	// but holds nothing for stays closed rather than opening empty.
	var back = (rec && PR() && PR().arrival) ? PR().arrival(rec) : null;
	if (back) {
		DaimondPanels.restoreLayout(back.layout, back.filled);
	} else {
		CONV_PANELS.forEach(function (id) { DaimondPanels.hide(id); });
	}
	if (!rec) return;
	// One after another, and only while this is still the conversation on
	// screen: a fast second switch must not open A's file over C.
	var still = function () { return convKey() === key; };
	var chain = Promise.resolve();
	var openOne = function (f, after) {
		chain = chain.then(function () {
			if (!still()) return;
			if (f.page) DaimondViewer.at(f.path, f.page);
			return Promise.resolve(openFile(f.path, f.store ? { store: true } : undefined))
				.then(function () { if (after && still()) after(); });
		}).catch(function () { /* moved or deleted since; nothing to say */ });
	};
	if (rec.doc) openOne(rec.doc, function () {
		var body = viewEl.querySelector('.files-edit, .files-view-body');
		if (body && rec.doc.top) body.scrollTop = rec.doc.top;
	});
	if (rec.preview) openOne(rec.preview);
	shows.forEach(function (f) { openOne(f); });
	if (back && back.filled.indexOf('doc') === -1 && back.layout.open.doc && wasDoc) {
		chain = chain.then(function () { if (still()) return onDocOpen(); }).catch(function () {});
	}
	if (rec.web && window.DaimondWeb) {
		chain = chain.then(function () {
			if (!still()) return;
			var st = null;
			try { st = DaimondWeb.status(); } catch (e) { st = null; }
			// The page already in the panel is not loaded again.
			if (st && st.url === rec.web.url) { DaimondPanels.show('web'); return; }
			return DaimondWeb.open(rec.web.url);
		}).catch(function () { /* the page can say why itself */ });
	}
}

export function followConversation() {
	var k = convKey();
	if (panelsOwner !== null && k !== panelsOwner) {
		leaveConversation(panelsOwner);
		if (pg._pdfUrl || pg._docPdf || pg.pvFile || watchedPath()) closePreview();
		if (pg.curFile || viewEl.style.display !== 'none') shutView();
		arriveConversation(k);
	}
	panelsOwner = k;
	ownPanel('doc');
	ownPanel('preview');
}
// ── The System section: Daimond's own store ──────────────────
//
// Notes2: *"When I choose the Browser workspace, I see only a mail folder
// and a test.md, where are all the system files like DAIMOND.md??"*
//
// They are where they always were — at the OPFS root — and `renderTree`
// filters them out on purpose, because a `×` beside `diamonds/` would
// delete every Diamond the user has. That answered the wrong question: the
// ask is to SEE the store, not to be able to destroy it from a file row.
//
// So it gets its own section, and the section is read-and-edit but never
// delete or rename. It also resolves against a DIFFERENT ROOT — always
// OPFS, whatever folder is open — which is the reason it is not simply
// unhidden in the tree above. `dev/ROOT_SEPARATION.md` §2.1: a single tree
// quietly spanning two roots is exactly the confusion that document exists
// to prevent.
export var sysDir = '';
var sysSeq = 0, sysDrawn = null;

/// One directory of the store, listed through the OPFS-pinned door.
export async function sysList(dir) {
	var tree = document.getElementById('sys-tree');
	var path = document.getElementById('sys-path');
	if (!tree) return;
	sysDir = dir || '';
	renderCrumbs(path, t('sys.head'), sysDir, sysList);
	// Only the latest reading draws: an older one that lands late would put its
	// rows (or its failure) over the answer the person is waiting for.
	var mine = ++sysSeq;
	// The same folder read again keeps its rows until the new ones are ready.
	if (sysDrawn !== sysDir || !tree.querySelector('.files-row')) {
		sysDrawn = null;
		tree.innerHTML = '';
		tree.appendChild(listNote('loading', t('files.loading')));
	}
	var raw = '';
	try { raw = await Wasm.store_list(sysDir); }
	catch (e) {
		if (mine !== sysSeq) return;
		sysDrawn = null;
		tree.innerHTML = ''; tree.appendChild(listNote('fail', friendlyError(e))); return;
	}
	if (mine !== sysSeq) return;
	var rows = String(raw || '').split('\n').filter(Boolean).map(function (line) {
		var bits = line.split('\t');
		return { name: bits[0], dir: bits[1] === 'dir', size: parseInt(bits[2], 10) || 0 };
	}).filter(function (e) {
		// `.daimond` and friends stay hidden here too: they are the store's own
		// bookkeeping, not files anybody edits, and a user who opens one and
		// saves it has broken a Diamond rather than configured one.
		return e.name && e.name.charAt(0) !== '.';
	});
	rows.sort(function (a, b) { return (b.dir - a.dir) || a.name.localeCompare(b.name); });
	tree.innerHTML = '';
	// The way back out is the breadcrumb above the tree now, not a folder-
	// shaped row mixed in with real ones -- so there is nothing to prepend
	// here even when `sysDir` is set.
	if (!rows.length) { tree.appendChild(sysNote(t('sys.empty'))); return; }
	rows.forEach(function (e) {
		var full = sysDir ? (sysDir + '/' + e.name) : e.name;
		var row = document.createElement('div');
		row.className = 'files-row sys-row' + (e.dir ? ' dir' : '');
		row.dataset.path = full;
		var nm = document.createElement('span');
		nm.className = 'files-name';
		kindName(nm, e.dir ? 'dir' : 'file', e.name);   // escaped
		row.appendChild(nm);
		if (!e.dir) {
			var sz = document.createElement('span');
			sz.className = 'files-size';
			sz.textContent = fmtFileBytes(e.size);
			row.appendChild(sz);
		}
		sysRowAsButton(row, e.name, function () {
			if (e.dir) sysList(full); else openFile(full, { store: true });
		});
		tree.appendChild(row);
	});
	sysDrawn = sysDir;
}

/// Make a row behave as the button it already is.
///
/// A `<div>` with a click handler is reachable by pointer and by nothing else.
/// `verify_a11y_keyboard` keeps a census of the ones this app already has and
/// fails on a NEW one, which is how the store rows were caught the hour they
/// were written. The workspace tree was the grandfathered one this comment
/// used to point at; it is grandfathered no longer, and uses this too.
///
/// Focusing the ROW also settles the name beside it: the detector skips
/// anything inside a focusable ancestor, so `.files-name` stops being a
/// keyboard-invisible clickable of its own without needing a rule about spans.
export function sysRowAsButton(row, name, onGo) {
	row.setAttribute('role', 'button');
	row.setAttribute('tabindex', '0');
	row.setAttribute('aria-label', name);
	row.addEventListener('click', onGo);
	row.addEventListener('keydown', function (ev) {
		if (ev.key !== 'Enter' && ev.key !== ' ') return;
		// Not when the press belongs to something INSIDE the row. A store
		// row has no inner controls, so this never mattered there; a
		// workspace row carries delete, rename and the residency buttons,
		// and without this Space on the delete cross would also open the
		// file it had just been asked to remove.
		if (ev.target !== row) return;
		ev.preventDefault();
		onGo();
	});
}

function sysNote(words) {
	var d = document.createElement('div');
	d.className = 'files-empty';
	d.textContent = words;
	return d;
}

/// Wire the System section's disclosure, once.
function bindSystem() {
	var head = document.getElementById('sys-head');
	var body = document.getElementById('sys-body');
	if (!head || !body || head.dataset.bound) return;
	head.dataset.bound = '1';
	head.addEventListener('click', function () {
		var open = head.getAttribute('aria-expanded') === 'true';
		head.setAttribute('aria-expanded', open ? 'false' : 'true');
		body.hidden = open;
		if (!open) sysList(sysDir);
	});
}

function onOpen() {
	// UNBLOCK-24 r3: a panel shown again is drawn again, so a menu left open on its last
	// showing is put away first. It hangs on the body, not in the panel, and so outlived
	// a switch to the chat and back, covering the rows under it (the r570s crawls).
	closePop();
	bindSystem();
	if (!pg.curFile) list(curDir);
	// Listed whether or not the section is expanded: it is cheap, it is local,
	// and a `<details>` that shows a spinner the first time it is opened is a
	// section people learn not to open.
	sysList(sysDir);
}
/// Re-sync the panel with the workspace after a turn or a worker may have
/// changed it. With the tree showing, re-list. With a file open, reload it
/// to the agent's latest so the viewer is never stale -- unless the user is
/// editing, in which case their text is left untouched and they are only
/// warned that the base has moved, so a later save cannot silently erase
/// the agent's work.
export async function refresh() {
	if (!isOpen() || !listed) return;
	// The store moves for reasons the workspace tree never sees — a Diamond
	// made, a role prompt seeded, a sync landing — so it is relisted on every
	// refresh rather than only when the panel opens. `onOpen` fires once, and
	// a section listed at boot showed an empty store for the rest of the
	// session.
	sysList(sysDir);
	if (!pg.curFile) { list(curDir); return; }
	var disk = null;
	try { disk = await readRaw(pg.curFile); }
	catch (e) { return; }   // gone or unreadable; leave the view as it is
	if (disk === pg.curContent) return;
	if (pg.editing) {
		fileMsg(t('files.changed_while_editing'), true);
	} else {
		pg.curContent = disk;
		renderFileBody();
		fileMsg(t('files.reloaded'));
	}
}
// page-split: install 48

export function install() { // page-split: install
	// page-split: install 46

	// Compile the currently open `.typ` file to a PDF in the
	// browser, write it next to the source in OPFS, and render it
	// inline.  The heavy compiler wasm is imported lazily on first
	// use so opening non-Typst files stays light.
	/* var */ pg._pdfUrl = null;   // live blob URL for the shown PDF
	// page-split: install 47

	/// The file as it is ON DISK, for the viewer and the editor.
	///
	/// NOT `file_read`. That tool renders a file FOR A MODEL: it numbers every line
	/// (`1\t`), it says so when it truncates, and it explains itself when the bytes are in
	/// cloud storage. All three are right for an agent and none of them is the file. The
	/// viewer showed that rendering as though it were the document -- two columns of numbers
	/// once the line-number toggle was on -- and, far worse, the editor was seeded with it, so
	/// OPENING A FILE AND PRESSING SAVE WITHOUT TYPING ANYTHING WROTE THE LINE NUMBERS INTO
	/// IT, compounding on every repeat. A truncated read would have written the truncation in
	/// the same way.
	///
	/// `Wasm.read_file` resolves against the same active root the tools use, so a folder on
	/// the machine and the sandbox both work, and the store still pins itself.
	///
	/// # Arguments
	/// * `path` - Workspace-relative path.
	/// Which door is currently open in the Doc panel: the store's, or the
	/// workspace's. Set by `openFile` and read by every path that goes back to
	/// disk for the same file — the read, the conflict check and the save.
	/* var */ pg.storeFile = false;

	/// The PREVIEW panel's own file, and its own door. Separate variables and
	/// not a second use of the two above: the panels hold different files at the
	/// same time, which is the whole reason there are two of them.
	/* var */ pg.pvFile  = null;
	/* var */ pg.pvStore = false;
	// page-split: install 48

	// ── What the loop says, wired once ─────────────────────────────
	//
	// Registered here rather than on the first `.typ` opened: a build can fail
	// while the panel holds nothing, and a listener wired lazily is a listener
	// that misses the event it exists for.

	// A BUILD BROKE, and the file and the line are the only part anybody acts on.
	// The panel used to say "Saved." over a source that no longer compiled, with
	// typst's words at the foot of a panel the author was not looking at.
	window.addEventListener('daimond-build-error', function (ev) {
		var d = (ev && ev.detail) || {};
		if (!d.text) { noteLine('', false, null); return; }
		if (!noteIsMine(d.path)) return;
		var first = String(d.text).split('\n')[0];
		// The head is `error at <path>:<line>: …`; the link says the path and the
		// line, so the sentence after it starts where the compiler's own does.
		var said = first.replace(/^\s*\w+ at [^\s:]+:\d+:\s*/, '');
		noteLine(said || first, true,
			d.line ? { label: String(d.path || '') + ':' + d.line, line: d.line } : null);
	});
	// THE PAGES WENT OFF SCREEN. Two seats and a third panel asked for is an
	// eviction, and the loop stopping was silent: state read `live` for a second,
	// then `idle`, and Save never rebuilt again.
	window.addEventListener('daimond-typst-paused', function () {
		noteLine(t('files.pages_paused'), false, null);
	});
	window.addEventListener('daimond-typst-resumed', function () {
		noteLine(t('files.pages_live'), false, null);
		// It is news, not a state: the pages are back and nothing is wrong.
		var el = viewEl && viewEl.querySelector('.files-view-note');
		if (el) setTimeout(function () {
			if (el.textContent === t('files.pages_live')) noteLine('', false, null);
		}, 4000);
	});
	window.addEventListener('daimond-typst-stopped', function () {
		noteLine('', false, null);
	});

	/* var */ Files = {
		init:          bind,
		onOpen:        onOpen,
		/// The DOC panel was asked for. Its own hook, not `onOpen`: that one is the
		/// WORKSPACE panel's, and the two panels are opened separately.
		onDocOpen:     onDocOpen,
		refresh:       refresh,
		// Repaint what the Cloud chip claims, after a sync has moved residency.
		tryReconnect:  tryReconnect,
		clear:         clear,
		// The open folder, for the status row that reports on it. Null on the sandbox.
		folder:        function () { return folderHandle; },
		// Whether a machine folder is remembered here, open or not (the sandbox after a
		// lost grant keeps it to reconnect to). See `syncIndexOwed`.
		remembersFolder: function () { return !!(folderHandle || rootHandle); },
		// Its id on this device, which the record of marks keys it by. Empty on the sandbox.
		folderId:      function () { return folderFid; },
		// The engine's list of known folders read again; see `reknow`.
		reknow:        reknow,
		// ── What the `+` picker borrows ────────────────────────────
		//
		// The picker in the attachment footer browses the SAME tree this
		// panel does (ATTACH_CONTRACT.md §5: a supplement to the Workspace
		// panel, not a replacement), so it borrows the panel's listing, its
		// breadcrumb and its attach action rather than growing a second
		// answer to any of the three. A second listing parser is how two
		// views of one folder come to disagree about what is in it.

		/// One directory as data: no dotfiles, and no `diamonds/` at the root,
		/// which is Daimond's own store and is not the user's to browse.
		///
		/// This used to say "filtered exactly as the tree filters it", and since
		/// the tree learnt to show hidden files that is no longer true and is no
		/// longer wanted. The tree is the owner LOOKING at his workspace and must
		/// conceal nothing; this is a picker choosing what a chat may reach, and
		/// an `.env` or a `.git` offered for attachment is a different question
		/// from one shown in a list. The panel is where he goes to see them.
		entries:       async function (dir) {
			return (await pickListing(dir)).rows;
		},
		/// `entries`, saying whether the listing was had at all: `{ ok, rows, why }`.
		/// A folder that could not be read is not an empty folder, and a picker
		/// that drew "Nothing here." for both told the reader a falsehood.
		listing:       pickListing,
		/// The app's own breadcrumb, so a path reads the same in the picker
		/// as it does in the panel.
		crumbs:        renderCrumbs,
		/// Is this already attached to whatever is in focus?
		///
		/// Asked of the STORE for a Diamond, not of this panel's cached
		/// list: that cache is filled when the tree is listed, so a picker
		/// opened before the Workspace panel has ever been shown would be
		/// told nothing is attached -- and `attachAdd` would then toggle,
		/// which on an attachment that really is there means DETACH. The
		/// `+` must never take something off.
		attached:      attachedTruly,
		attachedAll:   attachedTrulyAll,
		/// Attach it, unless it is attached already. The picker only ever
		/// ADDS: a tick that could also detach would make one press of OK
		/// both give and take away, and nothing on the row says which.
		attachAdd:     async function (path, dir) {
			if (await attachedTruly(path, !!dir)) return;
			await toggleAttach(path, !!dir);
		},
		/// Let go of the preview panel, for something else to take its turn.
		///
		/// The compiled PDF and the live typeset pages are both put on that panel
		/// from OUTSIDE this module, and both need the viewer's rendering out of
		/// the way first — the bytes it is holding released with it.
		previewAside: function () {
			if (pvEl) { pvEl.style.display = 'none'; pvEl.innerHTML = ''; }
			DaimondViewer.close();
			pg.pvFile = null;
		},
		// Mail arrives as bytes, not text: a message with a JPEG attached is
		// not a string, and writing it as one silently corrupts it.
		writeBytes:    writeWorkspaceBytes,
		open:          openFile,
		/// Show a NON-editable file (a picture, a PDF, bytes) in the Preview panel,
		/// reading it through `store_read_bytes` when `opts.store`. `opts.label` names it
		/// for the reader when `path` is an internal store path (a version-store body
		/// opened from a changed-files tile -- S-HAND #4). The caller has already probed.
		view:          function (path, info, opts) {
			return showViewedFile(path, info, !!(opts && opts.store), opts && opts.label);
		},
		/// Draw this file again, but ONLY if it is the one on screen and the
		/// reader is not part-way through editing it.
		///
		/// The guard is the whole of it. `openFile` is not idempotent from the
		/// reader's seat -- it resets the editor -- so calling it for every write
		/// the app makes would throw away unsaved characters and jump the scroll
		/// of a document nobody had asked to move.
		reshow:        async function (path) {
			if (!pg.curFile || String(path || '') !== pg.curFile) return;
			if (pg.editing) return;
			// A WRITE THAT CHANGED NOTHING IS NOT AN EDIT, and redrawing for one
			// is worse than not: the panel's own Save writes the file, so without
			// this every Save bounced the reader out of the editor and back to the
			// top of the document they had just been typing in. `typstwatch.touched`
			// keeps the same rule for the same reason -- "a Save that wrote back
			// exactly what was there is a write, not an edit".
			var disk;
			try { disk = await readRaw(pg.curFile); }
			catch (e) { return; }   // unreadable now; the redraw would only say so twice
			if (disk === pg.curContent) return;
			// OFF SCREEN IT IS REFRESHED, NOT BROUGHT BACK (PDF-PANEL, 12 Oct 2026).
			// `curFile` outlives the panel being on screen: open `hachiko.pdf` and the
			// Preview takes the seat the source had, with the source still named here.
			// A write to `hachiko.typ` then brought its editor forward and pushed the
			// PDF the reader had just opened off the screen. The text is still redrawn,
			// so the source is current when it is next looked at.
			var seen = !!(viewEl && viewEl.getClientRects().length);
			return openFile(pg.curFile, { store: pg.storeFile, quiet: !seen });
		},
		/// Which file the document panel is holding, or ''. The answer only this
		/// closure has, and the question a follower has to ask before it writes.
		showing:       function () { return pg.curFile || ''; },
		// Show the store section, and put it back at a given directory.
		systemList:    sysList,
		// Show a directory in the tree, whichever tree is showing.
		browse:        function (p) { return list(p || ''); },
		// ── The Typst seams, published so a check reads the app's own answer ──
		//
		// `publishCommand` especially: it composes a command that will run on the
		// user's machine under a memory cap, and a verifier asserting a string it
		// built itself would be asserting nothing.
		mainFor:       mainFor,
		previewPdf:    previewPdfPath,
		chapterPage:   showChapterPage,
		publishCommand: publishCommand,
		lastPublish:   function () { return _lastPublish; },
		goToLine:      goToLine,
		// Say the panel's own words again in a new language. The focus section
		// is on screen the whole time the panel is, so it cannot wait for the
		// next time something rebuilds it.
		relabel:       function () {
			renderFocus();
			// The mode row too: Browser / Machine / Cloud and the two transfer
			// buttons beside them are built from strings once, and they are on
			// screen for as long as the panel is.
			renderMode(modeReconnect);
			// The relist is still refused while a document is open -- `list` closes
			// one -- but the tree's OWN words no longer wait for it. That guard is
			// why the breadcrumb stayed in the language the panel was opened in from
			// the moment there was a document at cold start to hold it there.
			relabelListing();
			if (listed && !pg.curFile) list(curDir);
		},
		// The open document's toolbar, said again where it stands. Registered
		// through `DaimondI18n.surface` rather than called from `relabel`, so the
		// "is it on screen" half is the engine's and not a second guess here.
		relabelDoc:    function () { if (pg.docRelabel) pg.docRelabel(); },
		// The focus section, redrawn on every focus change and when a ring is written.
		renderFocus:   function () { return renderFocus(); },
		/// THE COMPILE HAND-OFF, reached from outside this module: register the two
		/// envelope handlers (the collector's door), re-label the Doc panel's buttons
		/// with where they would run, and -- for a verifier -- the placement itself
		/// and the runner deps it would be run with.
		wireCompileHandoff: wireCompileHandoff,
		renderDocSeat:      renderDocSeat,
		placeFor:           placeFor,
		placeForMissing:    placeForMissing,
		placeText:          placeText,
		compileDeps:        compileDeps,
		docKeyOf:           docKeyOf,
		sidecarFor:         sidecarFor,
		/// What the open Diamond's workspace is made of, as the three lists
		/// `diamond_bounds` in src/tools.rs takes: its own directory, what the
		/// user attached, and which of those were attached to be consulted
		/// rather than worked on.
		///
		/// This is the INPUT to a fence and not a fence. The bounds, and the
		/// compartment built from them, are computed in Rust; a page that
		/// composed either would be a second opinion about what a command may
		/// touch, free to drift from the one the hand enforces.
		///
		/// Read here because this module already keeps the attachments — the
		/// panel lists them on every open — and a second reader of the same
		/// links would be a second answer to the same question.
		/// # Arguments
		/// * `id` - Which Diamond, or nothing for the one on screen. A worker is
		///   scoped to the Diamond it works FOR, which is not always the one the
		///   user is looking at.
		/// The ☁ rows a compile of this document would look for and not find, and the
		/// fetch of them. Published because `dev/verify_foldershare.mjs` asserts what
		/// a device without native access sees, and a verifier that recomputed which
		/// paths those are would be a second answer to the question the panel decides.
		compileCloudRows: function (main) { return projectCloudRows(main); },
		hydrateProject:   async function (main) {
			var el = viewEl && viewEl.querySelector('.files-view-msg');
			return await hydrateProject(main, el || document.createElement('div'));
		},
		/// Every workspace path FLAGGED for sharing on a Diamond, deduped and sorted.
		///
		/// THE SHARED FOLDER'S WHOLE DEFINITION, and what travels is exactly what the
		/// user FLAGGED. A mark is the grant a daimon works under -- permission to
		/// READ the folder (`dev/ATTACH_CONTRACT.md` §2) -- and it is not permission
		/// to copy the folder onto every device of the account. Reading the two as
		/// one, which this did until 2026-09-14, put some twenty-six gigabytes of the
		/// owner's marks up for replication and cost every round a walk of all of it.
		/// So the copy grant is a second, explicit act: `share` on the attachment,
		/// worded generically about devices, off until somebody turns it on.
		///
		/// A FOLDER NOBODY FLAGGED COSTS NOTHING. An empty answer here is the ordinary
		/// state, and `syncWalkPlan` returns before it walks anything at all.
		///
		/// EVERY Diamond'S marks, not the one on screen. `currentDiamond` is a piece of
		/// UI state, and a parcel that changed when the user clicked a different Diamond
		/// would be a parcel that is never the same twice -- which is the one thing sync
		/// cannot survive (`dev/verify_syncfixedpoint.mjs`).
		///
		/// Sorted, and a path under another is dropped, so the walk below it happens
		/// once and the set is the same on two devices that hold the same Diamonds.
		shareRoots:    async function () {
			var out = [];
			for (var i = 0; i < pg.diamonds.length; i++) {
				var d = pg.diamonds[i];
				if (!d || !d.id || trashed(d.id)) continue;
				var list = [];
				try { list = await attachmentsOf(d.id); } catch (e) { list = []; }
				list.forEach(function (a) {
					if (a.here === false || !a.path) return;
					// The flag, and not the mark. See above.
					if (!a.share) return;
					// AND ONLY ON THE USER'S MARK IN FORCE ON THIS DEVICE (re-check of
					// 2026-09-23, R3). Every row with the flag counted, a daimon's and a
					// fold's included, and what is shared is synced into and deleted from
					// on another device's word, with no copy kept here.
					if (!markInForce(a.link)) return;
					if (out.indexOf(a.path) < 0) out.push(a.path);
				});
			}
			out.sort();
			return out.filter(function (p, i2) {
				for (var j = 0; j < i2; j++) if (underPath(p, out[j])) return false;
				return true;
			});
		},
		bounds:        async function (id) {
			var did = id || (pg.currentDiamond ? pg.currentDiamond.id : '');
			// A trashed Diamond has no workspace to confine anything to. It is
			// answered here rather than at the callers because this is the one
			// input to the fence: `scopeAgentTo` refuses a scope with no
			// `own_dir` and throws rather than starting a turn, which is the
			// behaviour wanted — an agent dispatched into a deleted Diamond
			// must not run at the reach of an ordinary workspace turn.
			if (trashed(did)) return { own_dir: '', attached: [], read_only: [], toolkits: [], unconfirmed: [] };
			if (!did) return { own_dir: '', attached: [], read_only: [], toolkits: [], unconfirmed: [] };
			var d = pg.diamonds.find(function (x) { return x.id === did; });
			// THE MARKS IN FORCE ARE THE ENGINE'S TO SAY (HIST-SAFE U2, 2026-10-12): the
			// one composition -- only the user's `holds` and `consulted` rows, only where
			// pressed on this device, only on the workspace open now, none for a Diamond in
			// the trash -- is `marks::reach` in src/marks.rs, read at every act. This page
			// only draws and reports what it answers, so what is shown is what is in force.
			// A record the engine cannot read REJECTS here (fail closed), and so does an
			// engine without the door: neither is "nothing is marked".
			var eng = diamondApp(did);
			if (!eng || typeof eng.diamond_reach !== 'function') {
				throw new Error('This build of the engine cannot say what this diamond reaches.');
			}
			var r = JSON.parse(await eng.diamond_reach(String(did)));
			return {
				own_dir:   'diamonds/' + did,
				attached:  Array.isArray(r.attached)  ? r.attached  : [],
				read_only: Array.isArray(r.read_only) ? r.read_only : [],
				// The toolchains the USER granted this Diamond, from the store. Never
				// inferred from anything a model asked to run — see `Toolkit` in
				// src/tools.rs, which says the same thing at the other end.
				toolkits:  (d && Array.isArray(d.toolkits)) ? d.toolkits.slice() : [],
				// MARKED, AND NOT IN FORCE ON THIS DEVICE until the user confirms them
				// here. They grant nothing; the engine names them in a refusal so the
				// daimon asks for the press (audit finding 6).
				unconfirmed: Array.isArray(r.unconfirmed) ? r.unconfirmed : [],
			};
		},
		/// The marks on a Diamond that are not in force on this device and that
		/// the user can bring into force here with one press -- what the notice
		/// above the composer lists. See `markWaiting`.
		waiting:       async function (id) {
			if (!id || trashed(id)) return [];
			var list = [];
			try { list = await attachmentsOf(id); } catch (e) { list = []; }
			return list.filter(function (a) { return a.waiting; });
		},
	}; // page-split: end lift

	/// What root the file tools are ACTUALLY on, published for `verify_machine`.
	///
	/// The same reasoning as `DaimondCore.permissionMode`: the panel's chip and the
	/// engine's root can differ, and only one of them decides where a write lands.
	/// A check reading the chip would be measuring the drawing against itself --
	/// which is exactly the failure `--break noswitch` reproduces, where the chip
	/// goes active, the handle is remembered, and `set_workspace_dir` is never
	/// called. `entries` runs a real `file_list` through the wasm tools, so what it
	/// answers is the engine's own view and not the tree's copy of it.
	window.DaimondFiles = {
		folder:  function () { try { return Files.folder(); } catch (e) { return null; } },
		// The viewer lets go of the Preview panel: the live pages taking it ask here.
		previewAside: function () { try { Files.previewAside(); } catch (e) { /* no viewer yet */ } },
		// The open folder's id on this device, for `dev/verify_m2_samename.mjs`.
		folderId: function () { try { return Files.folderId(); } catch (e) { return ''; } },
		// The folders this device knows, handed to the engine again: `versions.js` asks before
		// every restore or undo opens (HK1).
		reknow: function () { try { return Files.reknow(); } catch (e) { return Promise.resolve(); } },
		entries: function (dir) { return Files.entries(dir || ''); },
		// What sync may write into and delete from on another device's word: the
		// folders shared AND in force here (R2), for the verifiers of marks.
		shareRoots: function () { return Files.shareRoots(); },
		// The Typst seams, for `dev/verify_typedit_loop.mjs`: which file a chapter's
		// Compile actually builds, what that compile writes, where a jump lands, and
		// the command Publish would send to the machine.
		mainFor:        function (p) { return Files.mainFor(p); },
		previewPdf:     function (p) { return Files.previewPdf(p); },
		chapterPage:    function (p) { return Files.chapterPage(p); },
		publishCommand: function (p) { return Files.publishCommand(p); },
		lastPublish:    function () { return Files.lastPublish(); },
		goToLine:       function (n) { return Files.goToLine(n); },
		// The compile's own ☁ rows, for `dev/verify_foldershare.mjs`: what a device
		// holding the book as references would look for, and the fetch a press of
		// Compile does first. See `hydrateProject`.
		compileCloudRows: function (p) { return Files.compileCloudRows(p); },
		hydrateProject:   function (p) { return Files.hydrateProject(p); },
	};

	// The daimon's door to the Doc panel. `file_show` in src/tools.rs reaches it
	// from the wasm through `window.DaimondDoc`, which `js/viewer.js` installs --
	// but only THIS module can open a file: the panel, its header and the routing
	// between the editor and the viewer all live in this closure. So the opener is
	// handed over, and viewer.js keeps the question of what showing a file MEANS.
	//
	// Registered here rather than on first use of the panel: a tool call can arrive
	// before the user has opened anything, and a door wired lazily is a door the
	// model finds shut and reports as absent.
	if (window.DaimondViewer && DaimondViewer.opener) DaimondViewer.opener(Files.open);

	// A FILE REWRITTEN UNDER THE READER IS REDRAWN, and the notice comes from the
	// one Rust door every byte the app writes goes through (`opfs::write_file`,
	// which dispatches `daimond-file-written`). `js/typstwatch.js` was the only
	// listener, so the live typeset pages followed a daimon's edit while the
	// SOURCE beside them, open in this very panel, kept showing what the file
	// used to say. The agent transcript below depends on this and is not the
	// reason for it.
	//
	// Not while the reader is editing: their unsaved characters are the only copy
	// of what they have typed, and no notice from anywhere may replace them.
	window.addEventListener('daimond-file-written', function (ev) {
		var p = (ev && ev.detail) ? String(ev.detail.path || '') : '';
		if (!p) return;
		Files.reshow(p);
	});

	// And who the screen belongs to right now, which only this module knows: the
	// open conversation as a turn's keeper names it (`convKey`), a Diamond's id or
	// `chat:<id>`. A chat answered the empty string until 2026-10-12, which a chat's
	// turn also named itself, so a chat's show took whatever Diamond was open (see
	// `file_show` in src/tools.rs). See `mayTakeScreen` in js/viewer.js for what is
	// done with the answer.
	if (window.DaimondViewer && DaimondViewer.screenOwner) {
		DaimondViewer.screenOwner(convKey);
	}
	// And whether the turn asking runs here for ANOTHER device, whose screen it then is
	// (D-20261006-27). See `runnerAskerOf`.
	if (window.DaimondViewer && DaimondViewer.remoteAsker) DaimondViewer.remoteAsker(runnerAskerOf);
} // page-split: end install
