// dev/naive.mjs -- drive Daimond's own daimon the way a naive user would, over one forge
// proposal at a time.
//
// WHAT THIS IS FOR. Six proposals on the Oregami forge (oxedyne/daimond) are ACCEPTED and not
// yet DONE. A lane's job against them is not to finish the feature -- it is to remove whatever
// BLOCKER a daimon hits doing its own development, which is `dev/HATES.md`'s "Where Daimond
// stopped" register. This script is the instrument: it reads a proposal's title and body
// verbatim off the forge, types exactly that into a real Diamond's chat as a naive user would --
// no file names, no verifier names, no hints -- and reports what happened. See
// `~/usr/code/ai/claude/handover/daimond_plan_naive_drive_20260915.md` for the plan this
// implements; §2 says what the driver may and may not do, §4 says the safety fence around it.
//
//   node dev/naive.mjs --proposal 14
//   node dev/naive.mjs --proposal 14 --cdp http://127.0.0.1:9222 --diamond 19faba2f2212
//   node dev/naive.mjs --proposal 14 --resend          # refuses unless the text is unchanged
//   node dev/naive.mjs --proposal 14 --comment         # posts the score row (needs ORE_VOICE)
//   node dev/naive.mjs --proposal 14 --deadline-min 45 --dry-run
//
// THE ONE DEVICE THIS TOUCHES is the owner's real Chrome, attached over CDP the way
// `~/.local/lib/daimond-drive/drive.mjs` does -- never launched, never cloned into a second
// profile (that would mint a second device identity). Everything this script actually DOES to
// the page is exported as plain functions taking a Playwright `page`, so `dev/verify_naive.mjs`
// can drive the same code against a headless, mocked world and never come near the live tab.
//
// PRE-FLIGHT REFUSES BEFORE TOUCHING THE TAB where it can: lens `status` says the device is
// busy; the tab is not on the served build; the wrong Diamond (or none) is selected; a dialog
// is already up. Each is a named exit code and one plain sentence -- see `EXIT` below.
//
// WHAT THIS NEVER DOES: answer an `ask` card, tick "remember" on the network-consent dialog,
// say YES to a publication (a "Publish this?" card is CANCELLED and the run stops on it),
// raise a spend cap, press Continue, switch the shared checkout's branch, run an Ore verb, or
// create a Diamond. Selecting one is a click plus a read-back, never a mint.

import fs		from 'node:fs';
import os		from 'node:os';
import path		from 'node:path';
import crypto		from 'node:crypto';
import { execFileSync }	from 'node:child_process';
import { fileURLToPath }	from 'node:url';

import * as forge	from './forge.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');

// ── Named exit codes ─────────────────────────────────────────────────────────────────────────
//
// One number, one name, one sentence -- so a caller (a person or a lane re-sending after a fix)
// branches on the code and never on a parsed string.
export const EXIT = {
	ok:              0,
	error:           1,	// forge unreachable, CDP unreachable, no such proposal -- not a refusal
	busy:            2,	// pre-flight: the device is already mid-turn
	buildMismatch:   3,	// pre-flight: the tab is not on the served build
	diamondMismatch: 4,	// pre-flight: the wrong Diamond, or none, is selected
	dialogOpen:      5,	// pre-flight: a `.modal.dlg` was already up before anything was sent
	stopDialog:      6,	// mid-send: a foreign dialog appeared and nobody answers it
	stopDeadline:    7,	// mid-send: the wall clock ran out before DaimondCore.busy() cleared
	resendMismatch:  8,	// --resend asked, but the composed text has changed since the first send
};

const NAME_OF = Object.fromEntries(Object.entries(EXIT).map(([k, v]) => [v, k]));

// ── Composing the text, verbatim ─────────────────────────────────────────────────────────────

/// Title, then body, then the one identifying sentence. Nothing else: no file names, no
/// verifier names, no hints -- see plan §2. A blank body still gets its own paragraph break,
/// so the closing sentence never runs on from the title of a proposal with no body at all.
export function composeText(title, body, n) {
	const t = String(title || '').trim();
	const b = String(body || '').trim();
	return `${t}\n\n${b}\n\nThis is proposal ${Number(n)} on the forge.`;
}

export function textHash(text) {
	return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ── The resend guard ─────────────────────────────────────────────────────────────────────────
//
// One JSON file per proposal, under `~/.cache/daimond-naive/`, holding the hash of the FIRST
// text ever sent and when. `--resend` is refused whenever the composed text no longer hashes
// to that -- the forge proposal was edited since, and re-sending a DIFFERENT text under the old
// name is not a resend, it is a new ask wearing the old one's clothes.
export const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'daimond-naive');

export function cacheFile(n, cacheDir = DEFAULT_CACHE_DIR) {
	return path.join(cacheDir, `${Number(n)}.json`);
}

export function loadCache(n, cacheDir = DEFAULT_CACHE_DIR) {
	try {
		const raw = fs.readFileSync(cacheFile(n, cacheDir), 'utf8');
		const j = JSON.parse(raw);
		return (j && typeof j.hash === 'string') ? j : null;
	} catch (e) { return null; }		// no prior send, or an unreadable one -- same thing here
}

export function saveCache(n, hash, text, cacheDir = DEFAULT_CACHE_DIR) {
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(cacheFile(n, cacheDir), JSON.stringify({
		hash, text, sentAt: new Date().toISOString(),
	}, null, 2) + '\n');
}

/// Is this send allowed to go out? `resend` false with no prior record is a first send, always
/// allowed; `resend` true with no prior record is nothing to resend, refused; a hash that
/// disagrees with the prior record is refused regardless of `resend`, because sending a changed
/// text under the SAME proposal number silently, with no flag at all, is the failure this guard
/// exists against.
export function checkResend({ n, text, resend, cacheDir = DEFAULT_CACHE_DIR } = {}) {
	const hash = textHash(text);
	const prior = loadCache(n, cacheDir);
	if (!prior) {
		if (resend) {
			return { ok: false, code: EXIT.resendMismatch,
				message: `naive: --resend asked for proposal ${n}, but nothing was ever sent for it.` };
		}
		return { ok: true, hash, prior: null };
	}
	if (prior.hash !== hash) {
		return { ok: false, code: EXIT.resendMismatch,
			message: `naive: proposal ${n}'s composed text has changed since the first send `
				+ `(${prior.sentAt}) -- refusing to send under the same name. Read the proposal `
				+ 'again, or delete ' + cacheFile(n, cacheDir) + ' if the change was intended.' };
	}
	return { ok: true, hash, prior };
}

// ── The served build ─────────────────────────────────────────────────────────────────────────

export const BUILD_URL = 'https://daimond.oxedyne.com/build.json';

/// The build id the deployed site is actually serving, read fresh and never cached -- a stale
/// read here is exactly the gap this check exists to close. `fetchImpl` is `fetch` in
/// production and a fixture's own stand-in under test.
export async function servedBuildId(fetchImpl = fetch, url = BUILD_URL) {
	const r = await fetchImpl(url, { cache: 'no-store' });
	if (!r.ok) throw new Error(`naive: ${url} answered ${r.status}`);
	const j = await r.json();
	const id = (j && typeof j.build === 'string') ? j.build.trim() : '';
	if (!id) throw new Error(`naive: ${url} carried no build id`);
	return id;
}

/// The build THIS TAB last confirmed it is running -- the same reading `buildId()` in
/// `www/js/daimond.js` makes, done here through `DaimondRelease` and `DaimondUpdater` because
/// `buildId()` itself is closed over the page's module scope and not published on `window`.
export async function pageBuildId(page) {
	return await page.evaluate(() => {
		try {
			const cur = window.DaimondRelease && DaimondRelease.current && DaimondRelease.current();
			if (cur && cur.build) return cur.build;
		} catch (e) { /* the log has not been read yet */ }
		try {
			const b = window.DaimondUpdater && DaimondUpdater.booted && DaimondUpdater.booted();
			if (b) return b;
		} catch (e) { /* the updater has not polled yet */ }
		return '';
	});
}

// ── Selecting the Diamond -- a click and a read-back, never a mint ─────────────────────────────

/// `window.DaimondAttach.focus()` is the app's own answer to "what is on screen": `{kind:
/// 'diamond', id, name}` for a Diamond, `{kind:'chat', id}` for a loose chat, or `null`. Reading
/// it rather than a DOM class is what a page redesign cannot quietly break under this script.
export async function currentFocus(page) {
	return await page.evaluate(() => {
		try { return (window.DaimondAttach && DaimondAttach.focus && DaimondAttach.focus()) || null; }
		catch (e) { return null; }
	});
}

/// Click the Diamond's own rail tile, then its chat face. Never creates one: if `.diamond-box`
/// for this id is not in the rail, this answers false rather than reaching for "new Diamond".
///
/// Dispatched as a NATIVE DOM click via `evaluate`, not a Playwright `locator.click()` -- the
/// rail tile sits inside a CSS-transformed, scrollable list, and a synthetic pointer event at
/// the locator's computed coordinate missed the tile's own listener even with `force: true`
/// (Playwright still targets a screen point, and a point that lands off the true hit area
/// clicks nothing). `el.click()` fires the same `click` event the listener is bound to, at the
/// element itself rather than a coordinate, which is what a real tap always was.
export async function selectDiamond(page, diamondId) {
	const found = await page.evaluate((id) => {
		const el = document.querySelector(`.diamond-box[data-id="${CSS.escape(id)}"]`);
		if (!el) return false;
		el.click();
		return true;
	}, diamondId);
	if (!found) return false;
	await page.waitForTimeout(300);
	await page.evaluate(() => {
		const b = document.getElementById('dview-chat');
		if (b) b.click();
	});
	try { await page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 }); }
	catch (e) { /* the pre-flight focus check below is what actually judges this */ }
	return true;
}

// ── The dialog on screen, if any ─────────────────────────────────────────────────────────────
//
// `.modal.dlg` is the root every one of the app's own dialogs shares (`dialog()` in
// `www/js/daimond.js`), so its presence is unambiguous. The network-consent dialog is told
// apart from every other kind it could be -- confirm, prompt, form, a file picker -- by the one
// DOM feature unique to it: the "remember" tick-box the consent card alone carries
// (`net-standing-box`), which survives a translation change where matching the heading text
// would not.
export async function readDialog(page) {
	return await page.evaluate(() => {
		const card = document.querySelector('.modal.dlg');
		if (!card) return null;
		const h = card.querySelector('h2');
		return {
			kind:        card.getAttribute('data-kind') || 'dlg',
			title:       h ? String(h.textContent || '').trim() : '',
			isConsent:   !!card.querySelector('.net-standing-box'),
			// The publication card, told apart by the app's own marker rather than by its
			// heading, which is translated. See `data-ask` in `dialog()`, www/js/daimond.js.
			isPublish:   card.getAttribute('data-ask') === 'publish',
			hasOkButton: !!card.querySelector('.dlg-ok'),
			hasCancel:   !!card.querySelector('.dlg-cancel'),
		};
	});
}

/// Press Cancel on whatever dialog is up, and nothing else.
///
/// THE ONE DIALOG THIS SCRIPT ANSWERS WITH A NO. Everything else it meets it leaves alone and
/// stops on -- see the policy at the top of this file -- and leaving a publication dialog alone
/// is what happened on proposal 11, 2026-09-15: the card sat on the owner's screen, the turn
/// held there, and the run's record ends at a dialog nobody was going to answer. A naive user
/// asked "shall I publish this in your name?" by a machine they set working on a task says no,
/// and the STOP is the finding: a daimon that reached for the forge in its owner's name is the
/// blocker, not the dialog.
export async function cancelDialog(page) {
	await page.click('.modal.dlg .dlg-cancel', { force: true });
	await page.waitForTimeout(300);
}

/// Click the consent dialog's own OK button once, WITHOUT ticking "remember" -- a one-off yes
/// for the command that asked, never the standing "Always" a naive user did not choose. See
/// `permmode.net_remember` in `www/js/daimond.js`: the tick is read only at OK, so leaving the
/// box alone is enough to leave it unset.
export async function allowConsentOnce(page) {
	await page.click('.modal.dlg .dlg-ok', { force: true });
	await page.waitForTimeout(300);
}

/// Is the app doing anything at all right now? The app's own answer, published for exactly this
/// (`window.DaimondCore.busy()`, `www/js/daimond.js`) -- a generation, a queued message, a
/// crystal fold, or a worker still running.
export async function appBusy(page) {
	return await page.evaluate(() => {
		try { return !!(window.DaimondCore && DaimondCore.busy && DaimondCore.busy()); }
		catch (e) { return false; }
	});
}

// ── lens -- read, never written ──────────────────────────────────────────────────────────────

export const LENS_PATH = path.join(os.homedir(), '.local', 'lib', 'daimond-lens', 'lens.mjs');

function runLens(args) {
	return execFileSync(process.execPath, [LENS_PATH, ...args, '--json'],
		{ encoding: 'utf8', timeout: 30000 });
}

/// The real `lens.mjs` calls, wrapped so `runNaive` can be handed a fixture in their place under
/// test -- nothing here is a fresh design, it is `child_process.execFileSync` pointed at the
/// instrument the plan names.
export const realLens = {
	pull:   () => { try { execFileSync(process.execPath, [LENS_PATH, 'pull'], { timeout: 60000 }); } catch (e) { /* best effort; status/turns fall back to what is already archived */ } },
	status: (device) => JSON.parse(runLens(['status', '--device', device])),
	turns:  (device, since = '2h') => JSON.parse(runLens(['turns', '--device', device, '--since', since, '--limit', '50'])),
};

/// Is the named device busy, by the archive's own `stats.live.activity` -- `'busy'` exactly
/// where `www/js/daimond.js`'s telemetry beat sets it from `Workers.busy()`. A device not yet
/// in the archive (`states` empty) reads as not busy: there is nothing recorded to refuse on.
export function deviceBusy(statusJson, deviceFilter) {
	const states = (statusJson && statusJson.devices) || [];
	const dev = states.find((s) => matchesDevice(s.device, s.name, deviceFilter)) || states[0];
	if (!dev) return { busy: false, dev: null };
	const activity = dev.live && dev.live.activity;
	const workerActive = !!(dev.live && dev.live.workerState && dev.live.workerState.active > 0);
	return { busy: activity === 'busy' || workerActive, dev };
}

function matchesDevice(id, name, filter) {
	if (!filter) return true;
	const f = String(filter).toLowerCase();
	return String(id || '').toLowerCase().startsWith(f) || String(name || '').toLowerCase().includes(f);
}

/// The newest turn recorded for this device, from a `turns --json` array -- rows arrive oldest
/// first (`lens.mjs`'s own contract), so the newest is the last one that names this device.
export function newestTurn(turnsJson, deviceFilter) {
	const rows = Array.isArray(turnsJson) ? turnsJson : [];
	for (let i = rows.length - 1; i >= 0; i--) {
		if (matchesDevice(rows[i].device, '', deviceFilter)) return rows[i];
	}
	return null;
}

// ── The verify report, read back out of the reply ───────────────────────────────────────────
//
// `[world: …]`, `[hand: …]` and `[verify: N checks passed, M failed, K breaks confirmed red,
// J breaks proved nothing]` are DAIMOND.md's own three lines (src/tools.rs, `VERIFY_WORLD`/
// `VERIFY_HAND`/the verify trailer) -- read back here rather than invented, and taken as the
// LAST occurrence of each, since a marathon turn may print more than one.
const RE_WORLD  = /\[world:\s*([^\]]*)\]/g;
const RE_HAND   = /\[hand:\s*([^\]]*)\]/g;
const RE_VERIFY = /\[verify:\s*(\d+)\s*checks passed,\s*(\d+)\s*failed,\s*(\d+)\s*breaks confirmed red,\s*(\d+)\s*breaks proved nothing\]/g;

function lastMatch(re, text) {
	let m, last = null;
	re.lastIndex = 0;
	while ((m = re.exec(text))) last = m;
	return last;
}

export function parseVerifyReport(text) {
	const t = String(text || '');
	const world  = lastMatch(RE_WORLD, t);
	const hand   = lastMatch(RE_HAND, t);
	const verify = lastMatch(RE_VERIFY, t);
	return {
		world: world ? world[1].trim() : null,
		hand:  hand ? hand[1].trim() : null,
		checksPassed:        verify ? Number(verify[1]) : null,
		failed:              verify ? Number(verify[2]) : null,
		breaksConfirmedRed:  verify ? Number(verify[3]) : null,
		breaksProvedNothing: verify ? Number(verify[4]) : null,
		found: !!(world || hand || verify),
	};
}

export async function transcriptText(page) {
	return await page.evaluate(() => {
		const el = document.getElementById('chat-output');
		return el ? el.innerText : '';
	});
}

// ── The commit landed ────────────────────────────────────────────────────────────────────────

export const DEFAULT_CHECKOUT = path.join(os.homedir(), 'usr', 'code', 'web', 'apps', 'oxedyne', 'daimond');

export function gitLog1(checkout = DEFAULT_CHECKOUT) {
	try {
		return execFileSync('git', ['-C', checkout, 'log', '-1', '--oneline'],
			{ encoding: 'utf8', timeout: 10000 }).trim();
	} catch (e) {
		return `(git log -1 failed: ${String((e && e.message) || e).split('\n')[0]})`;
	}
}

// ── The score row ────────────────────────────────────────────────────────────────────────────

export function buildScoreRow({ proposal, exitCode, endedHow, rounds, folds, usd, commit, report,
	diamond, consentsAllowed }) {
	const row = {
		proposal:          Number(proposal),
		exit:              NAME_OF[exitCode] || String(exitCode),
		endedHow:          endedHow ?? null,
		rounds:             rounds ?? null,
		folds:              folds ?? null,
		usd:                usd ?? null,
		commit,
		world:              report ? report.world : null,
		hand:               report ? report.hand : null,
		checksPassed:       report ? report.checksPassed : null,
		failed:             report ? report.failed : null,
		breaksConfirmedRed: report ? report.breaksConfirmedRed : null,
		breaksProvedNothing:report ? report.breaksProvedNothing : null,
		diamond:            diamond ?? null,
		consentsAllowed:    consentsAllowed ?? 0,
		at:                 new Date().toISOString(),
	};
	const line = `proposal ${row.proposal}  ${row.exit}  ended=${row.endedHow ?? '?'}  `
		+ `rounds=${row.rounds ?? '?'}  folds=${row.folds ?? '?'}  $${row.usd ?? '?'}  `
		+ `commit="${row.commit}"  world=${row.world ?? 'none'}  hand=${row.hand ?? 'none'}  `
		+ `verify=${row.checksPassed ?? '?'}/${row.failed ?? '?'}/${row.breaksConfirmedRed ?? '?'}/`
		+ `${row.breaksProvedNothing ?? '?'}`;
	return { row, line };
}

/// A HATES.md stub in the second half's own shape -- "a section per lane... recording what was
/// asked, what happened, and the exact sentence or behaviour that stopped it" (dev/HATES.md
/// header). PRINTED ONLY: this script never writes the file, because settling what belongs in
/// the standing register is a person's editorial call and not a driver's.
export function hatesStub({ proposal, title, exitCode, message, transcriptTail }) {
	const date = new Date().toISOString().slice(0, 10);
	const tail = String(transcriptTail || '').trim().slice(-600);
	return `## Proposal ${proposal} -- lane/naive-drive -- ${date}\n\n`
		+ `**Asked:** ${title}\n\n`
		+ `**What happened:** ${NAME_OF[exitCode] || exitCode} -- ${message}\n\n`
		+ (tail ? `**Where it stopped, the daimon's own words:**\n\n\`\`\`\n${tail}\n\`\`\`\n` : '');
}

// ── The orchestration ────────────────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/// Everything this script does to a Diamond, over one proposal. Takes a Playwright `page` and a
/// `deps` bag rather than reaching for a CDP connection or `child_process` itself, so
/// `dev/verify_naive.mjs` can call this directly against a headless, mocked page and never open
/// the live tab. `log` defaults to `console.log`; a test hands in an array-collecting stand-in.
export async function runNaive(opts, deps) {
	const {
		proposal, diamondId = null, resend = false, dryRun = false, comment = false,
		deadlineMs = 45 * 60 * 1000, pollMs = 5000, device = 'argonaut',
		checkout = DEFAULT_CHECKOUT, cacheDir = DEFAULT_CACHE_DIR,
	} = opts;
	const {
		page, forgeRead = forge.read, forgeComment = forge.comment, lens = realLens,
		fetchImpl = fetch, log = console.log, now = () => Date.now(),
	} = deps;

	// 1. Read the proposal and compose the text.
	const r = await forgeRead(proposal);
	if (!r.ok) {
		return { code: EXIT.error, message: `naive: could not read proposal ${proposal} from the `
			+ `forge (${r.why}${r.said ? ': ' + r.said : ''}).` };
	}
	const title = r.data.title || '';
	const body  = r.data.body || '';
	const text  = composeText(title, body, proposal);
	log(text);

	const resendCheck = checkResend({ n: proposal, text, resend, cacheDir });
	if (!resendCheck.ok) { log(resendCheck.message); return resendCheck; }

	// 2. Pre-flight refusals, cheapest and least invasive first.
	if (!dryRun) {
		lens.pull();
		let status;
		try { status = lens.status(device); }
		catch (e) { return { code: EXIT.error, message: `naive: lens status failed: ${String((e && e.message) || e)}` }; }
		const { busy } = deviceBusy(status, device);
		if (busy) {
			return { code: EXIT.busy, message: `naive: ${device} is already busy -- not sending `
				+ 'proposal ' + proposal + ' on top of it.' };
		}
	}

	let served, mine;
	try {
		served = await servedBuildId(fetchImpl);
		mine   = await pageBuildId(page);
	} catch (e) {
		return { code: EXIT.error, message: `naive: could not read the build ids: ${String((e && e.message) || e)}` };
	}
	if (!mine || mine !== served) {
		return { code: EXIT.buildMismatch, message: `naive: the tab is on build ${mine || '(none read)'}`
			+ `, the served build is ${served} -- reload the page with nothing running first.` };
	}

	if (diamondId) {
		const focusNow = await currentFocus(page);
		if (!focusNow || focusNow.kind !== 'diamond' || focusNow.id !== diamondId) {
			const picked = await selectDiamond(page, diamondId);
			if (!picked) {
				return { code: EXIT.diamondMismatch, message: `naive: Diamond ${diamondId} is not in `
					+ 'the rail -- refusing to create one.' };
			}
		}
	}
	const focus = await currentFocus(page);
	if (!focus || focus.kind !== 'diamond' || (diamondId && focus.id !== diamondId)) {
		return { code: EXIT.diamondMismatch, message: 'naive: no Diamond is selected '
			+ (diamondId ? `(wanted ${diamondId}, got ${focus ? focus.kind + ':' + focus.id : 'nothing'})`
				: '(pass --diamond, or select one on the tab first).') };
	}

	const openBefore = await readDialog(page);
	if (openBefore) {
		return { code: EXIT.dialogOpen, message: `naive: a dialog is already open (${openBefore.kind}`
			+ `${openBefore.title ? ': ' + openBefore.title : ''}) -- answer or close it first.` };
	}

	if (dryRun) {
		saveCacheIfFirst(proposal, resendCheck, text, cacheDir);
		return { code: EXIT.ok, message: 'naive: --dry-run -- composed and pre-flighted only, nothing sent.', dryRun: true };
	}

	// 3. Send, and wait -- answering nothing but the network-consent dialog.
	await page.fill('#chat-input', text);
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(400);
	saveCacheIfFirst(proposal, resendCheck, text, cacheDir);

	const startedAt = now();
	let consentsAllowed = 0;
	let stop = null;
	for (;;) {
		const dlg = await readDialog(page);
		if (dlg) {
			if (dlg.isConsent && dlg.hasOkButton) {
				await allowConsentOnce(page);
				consentsAllowed += 1;
				log(`naive: allowed the network-consent dialog once (${consentsAllowed} so far).`);
				continue;
			}
			// A PUBLICATION IN THE OWNER'S NAME IS CANCELLED AND RECORDED, not waited on.
			// Cancelled first, so the turn is released and can end and be scored; recorded as
			// a stop, because a daimon that tried to publish is exactly the kind of thing this
			// instrument exists to find.
			if (dlg.isPublish && dlg.hasCancel) {
				await cancelDialog(page);
				const pubTail = await transcriptText(page);
				log('naive: a publication dialog appeared -- cancelled it, and stopping.');
				stop = { code: EXIT.stopDialog, message: 'naive: stopped on a publication put '
					+ `to the user in their name (${dlg.title || 'publish'}) -- cancelled.`,
					transcriptTail: pubTail };
				break;
			}
			const tail = await transcriptText(page);
			log(`naive: a dialog appeared that is not network consent (${dlg.kind}: ${dlg.title}) -- stopping.`);
			stop = { code: EXIT.stopDialog, message: `naive: stopped on a dialog nobody answers `
				+ `(${dlg.kind}${dlg.title ? ': ' + dlg.title : ''}).`, transcriptTail: tail };
			break;
		}
		const busy = await appBusy(page);
		if (!busy) break;
		if (now() - startedAt > deadlineMs) {
			const tail = await transcriptText(page);
			stop = { code: EXIT.stopDeadline, message: `naive: still busy after `
				+ `${Math.round(deadlineMs / 60000)} minute(s) -- stopping the wait, not the turn.`,
				transcriptTail: tail };
			break;
		}
		await sleep(pollMs);
	}

	// 4. Score.
	const tail = await transcriptText(page);
	const report = parseVerifyReport(tail);
	const commit = gitLog1(checkout);
	let endedHow = null, rounds = null, folds = null, usd = null;
	try {
		const turns = lens.turns(device);
		const t = newestTurn(turns, device);
		if (t) { endedHow = t.outcome; rounds = t.rounds; folds = t.folds; usd = t.usd; }
	} catch (e) { log(`naive: lens turns failed: ${String((e && e.message) || e)}`); }

	const { row, line } = buildScoreRow({
		proposal, exitCode: stop ? stop.code : EXIT.ok, endedHow, rounds, folds, usd, commit,
		report, diamond: diamondId, consentsAllowed,
	});
	log(JSON.stringify(row));
	log(line);

	if (stop) {
		log(hatesStub({ proposal, title, exitCode: stop.code, message: stop.message,
			transcriptTail: stop.transcriptTail }));
	}

	if (comment) {
		if (!process.env.ORE_VOICE) {
			log('naive: --comment asked, but ORE_VOICE is not set -- not posting.');
		} else {
			try { await forgeComment(proposal, line); }
			catch (e) { log(`naive: forge comment failed: ${String((e && e.message) || e)}`); }
		}
	}

	return { code: stop ? stop.code : EXIT.ok, message: stop ? stop.message : 'naive: turn finished.',
		row, line };
}

function saveCacheIfFirst(n, resendCheck, text, cacheDir) {
	if (!resendCheck.prior) saveCache(n, resendCheck.hash, text, cacheDir);
}

// ── Connecting to the real tab (production only; never used by the verifier) ───────────────────

/// The same playwright resolution and CDP attach `drive.mjs` uses -- attach, never launch, and
/// pick the `daimond.oxedyne.com` page rather than whatever tab happened to be on top.
async function connectRealPage(cdpUrl) {
	const { chromium } = await import('./pw.mjs');
	const browser = await chromium.connectOverCDP(cdpUrl);
	const pages = browser.contexts().flatMap((c) => c.pages());
	const page = pages.find((p) => p.url().startsWith('https://daimond.oxedyne.com')) || pages[0];
	if (!page) throw new Error(`naive: no Daimond tab found at ${cdpUrl}`);
	return { browser, page };
}

// ── The command line ─────────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
	const o = { proposal: null, cdp: process.env.DAIMOND_CDP || 'http://127.0.0.1:9222',
		diamond: null, resend: false, comment: false, deadlineMin: 45, dryRun: false,
		device: 'argonaut', checkout: DEFAULT_CHECKOUT };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--proposal')    { o.proposal = Number(argv[++i]); continue; }
		if (a === '--cdp')         { o.cdp = argv[++i]; continue; }
		if (a === '--diamond')     { o.diamond = argv[++i]; continue; }
		if (a === '--resend')      { o.resend = true; continue; }
		if (a === '--comment')     { o.comment = true; continue; }
		if (a === '--deadline-min'){ o.deadlineMin = Number(argv[++i]); continue; }
		if (a === '--dry-run')     { o.dryRun = true; continue; }
		if (a === '--device')      { o.device = argv[++i]; continue; }
		if (a === '--checkout')    { o.checkout = argv[++i]; continue; }
	}
	return o;
}

async function main(argv) {
	const o = parseArgv(argv);
	if (!o.proposal || !Number.isInteger(o.proposal) || o.proposal < 1) {
		console.error('usage: node dev/naive.mjs --proposal N [--cdp URL] [--diamond ID] '
			+ '[--resend] [--comment] [--deadline-min 45] [--dry-run]');
		return EXIT.error;
	}
	let conn = null;
	try {
		conn = await connectRealPage(o.cdp);
		const result = await runNaive({
			proposal: o.proposal, diamondId: o.diamond, resend: o.resend, dryRun: o.dryRun,
			comment: o.comment, deadlineMs: o.deadlineMin * 60000, device: o.device,
			checkout: o.checkout,
		}, { page: conn.page });
		console.log(result.message);
		return result.code;
	} catch (e) {
		console.error(`naive: ${String((e && e.message) || e)}`);
		return EXIT.error;
	} finally {
		if (conn) await conn.browser.close();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).then((code) => process.exit(code || 0));
}
