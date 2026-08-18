// verify_joinedup.mjs — five things that were built and then never joined up,
// and the one dead thing left behind by a sixth.
//
// Each is small. Together they are one failure repeated: a function, a page, a
// field or a rule that exists, works, and is reached by nothing in production.
// None of them showed up as a bug, because nothing was broken -- there was just
// no way in.
//
// WHAT IS ASSERTED, AND WHY THAT RATHER THAN THE NEXT THING:
//
//   1. A USER CAN CHANGE THEIR PUBLIC HANDLE. `DaimondSync.claimHandle` had no
//      caller outside its own verifier, so an account minted `bright-finch-5m5m`
//      kept it for ever, and four refusal sentences translated into eight
//      languages could not be reached by anybody. So: the control is in the
//      Admin home, it is VISIBLE, pressing it reaches `claimHandle`, and each of
//      the four refusals arrives on screen as the sentence the catalogue holds
//      for it -- read out of `www/i18n/en.js`, not out of the page, because a
//      check that asks the page what it thinks the sentence is would pass with
//      every sentence replaced by the same one.
//
//   2. A WITHDRAWN FOLDER GRANT IS NOTICED ON THE PANEL'S OWN READS. Both
//      halves, because either alone is satisfiable by a mistake: a NotAllowed
//      failure under a folder root must raise `daimond:folder-lost`, and an
//      ORDINARY failure under the same root must raise nothing. A change that
//      fired on every failure would drop the user's folder because a file was
//      missing, which is its own bug and a worse one.
//
//      And the predicate is compared, term by term, with `is_folder_lost` in
//      `src/wasm/opfs.rs`. It exists in two languages until the Rust side raises
//      the event itself; two copies of a rule drift, and this is what stops them
//      drifting quietly.
//
//   3. THE IMPROVE PANEL'S "i" OPENS THE PAGE ABOUT THE IMPROVE PANEL.
//      `guide/social.html` documents it and was reachable only from the guide's
//      own navigation; the button went to the tour of the whole frame.
//
//   4. A BACKUP'S VERSION IS READ. Both writers stamped `version: 1` and nothing
//      ever looked at it, so a format-2 file would have imported without a word
//      and silently dropped whatever format 2 added. Both halves again: a version
//      this build does not know is REFUSED, and one it does know is still taken.
//
//   5. THE REPRODUCIBLE-BUILD CHECK IS LINKED FROM THE APP. `www/verify.html` is
//      the one page that makes the transparency claim testable by the person
//      relying on it, and nothing in the PWA pointed at it. The link is asserted
//      to exist, to be visible, and to REACH a real page -- a link is not a
//      reach until something answers at the other end.
//
//   6. THE DEAD WORD-MARK SWAP IS GONE. Asserted at the STYLESHEET, not at the
//      source file: three rules selected `.empty-logo`, which nothing has
//      produced since the welcome copy went.
//
// EVERY CHECK IS PAIRED WITH ONE ASSERTING THE ELEMENT IS THERE. An element that
// does not exist reports itself to a browser locator as *hidden*, and "hidden"
// reads as "this is fine, it is just not showing" -- which is exactly how three
// of these defects survived a suite this large.
//
// EACH IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a damaged
// copy of a real file to the real page, and the run is expected to FAIL. A break
// whose anchor does not appear exactly once aborts, because a check proved
// against code that was never broken is not proved at all.
//
//   node dev/verify_joinedup.mjs --break nohandle    # the rename control is gone
//   node dev/verify_joinedup.mjs --break onesentence # one refusal for all four
//   node dev/verify_joinedup.mjs --break oldinfo     # the "i" goes back to interface.html
//   node dev/verify_joinedup.mjs --break noverify    # About drops the build check
//   node dev/verify_joinedup.mjs --break noversion   # the import stops reading the version
//   node dev/verify_joinedup.mjs --break anyfailure  # ANY failure drops the folder
//   node dev/verify_joinedup.mjs --break deadlogo    # the dead CSS rule comes back
//   node dev/verify_joinedup.mjs                     # and then, clean
//
//   bash dev/world.sh 15 --up ; eval "$(bash dev/world.sh 15 --env)"
//   node dev/verify_joinedup.mjs
//
// Needs dev/serve.mjs only. No gateway on :9002 -- the account endpoint is
// stubbed here -- and no mock LLM: nothing here runs a turn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WWW  = path.join(ROOT, 'www');
const SRC  = 'js/daimond.js';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
const HANDLE_BTN =
	'\t\t\tif (window.DaimondSync && DaimondSync.claimHandle) {\n'
	+ "\t\t\t\tvar hb = item(tOr('home.change_handle', 'Change public handle…'), doChangeHandle);\n"
	+ "\t\t\t\thb.id = 'admin-change-handle';\n"
	+ '\t\t\t}\n';
const REFUSAL   = "\t\t\tawait noticeDialog(title, (r && r.message) || t('handle.failed'));";
const IMP_INFO  = "\t\tif (window.DaimondWeb && DaimondWeb.guide) DaimondWeb.guide('social.html');\n"
	+ "\t\telse window.open('guide/social.html', '_blank');";
const VERIFY_IN = '\t\tbody.appendChild(check);\n';
const VER_GUARD = "\t\t\tvar ver = data.version === undefined ? BACKUP_VERSION : data.version;\n"
	+ "\t\t\tif (typeof ver !== 'number' || !isFinite(ver) || ver > BACKUP_VERSION) {";
const LOST_TEST = "\tvar text = (e && typeof e === 'object' && e.message) ? String(e.message) : String(e);\n"
	+ "\treturn text.indexOf('NotAllowed') >= 0;";
const LOGO_RULE = '.empty-state h2 { margin: 0; color: var(--text-primary); font-size: var(--fs-3xl); }';

const BREAKS = {
	// The control is not drawn. `claimHandle` goes back to having no caller.
	nohandle:    [{ file: SRC, find: HANDLE_BTN, with: '' }],
	// One sentence for all four noes: the user is told "try again shortly" when
	// the real answer was "somebody else has that name".
	onesentence: [{ file: SRC, find: REFUSAL,
		with: "\t\t\tawait noticeDialog(title, t('handle.failed'));" }],
	// The "i" goes back to the page about the whole frame.
	oldinfo:     [{ file: SRC, find: IMP_INFO,
		with: "\t\tif (window.DaimondWeb && DaimondWeb.guide) DaimondWeb.guide('interface.html');\n"
			+ "\t\telse window.open('guide/interface.html', '_blank');" }],
	// About draws the link and never puts it in the card, which is the shape of
	// every defect in this file: it exists, and nothing reaches it.
	noverify:    [{ file: SRC, find: VERIFY_IN, with: '' }],
	// The import stops reading the version, exactly as it shipped.
	noversion:   [{ file: SRC, find: VER_GUARD, with: '\t\t\tif (false) {' }],
	// Any failure at all counts as a withdrawn grant, so a missing file costs the
	// user their folder.
	anyfailure:  [{ file: SRC, find: LOST_TEST, with: '\treturn true;' }],
	// The dead rule comes back, in the stylesheet where it lived.
	deadlogo:    [{ file: 'css/app.css', find: LOGO_RULE,
		with: '.empty-state .empty-logo { width: 56px; height: 56px; opacity: 0.9; margin-bottom: 4px; }\n'
			+ LOGO_RULE }],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source of ONE file, with every edit for it applied, or a hard
/// stop. All of a file's edits go into one body: registering two routes for the
/// same URL serves only the last, so a break with two edits in one file would
/// silently deliver half of itself.
function damaged(file, specs) {
	let src = fs.readFileSync(path.join(WWW, file), 'utf8');
	for (const spec of specs) {
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': an anchor appears ${n} times in ${file}, `
				+ 'so it was not applied and the run below would prove nothing.');
			process.exit(2);
		}
		src = src.replace(spec.find, spec.with);
	}
	return src;
}

const MIME = { js: 'application/javascript', css: 'text/css' };

/// Serve every file this break damages, before anything navigates.
async function serveBroken(page) {
	if (!BREAK) return;
	const byFile = new Map();
	for (const spec of BREAKS[BREAK]) {
		if (!byFile.has(spec.file)) byFile.set(spec.file, []);
		byFile.get(spec.file).push(spec);
	}
	for (const [file, specs] of byFile) {
		const body = damaged(file, specs);
		const type = MIME[file.split('.').pop()] || 'text/plain';
		await page.route('**/' + file, r => r.fulfill({ status: 200, contentType: type, body }));
	}
}

// ── The English the user is owed ─────────────────────────────────────
// Read from the CATALOGUE FILE, not from the page.
const CATALOGUE = (() => {
	const src = fs.readFileSync(path.join(WWW, 'i18n/en.js'), 'utf8');
	const out = {};
	for (const key of ['handle.taken', 'handle.invalid', 'handle.reserved', 'handle.failed']) {
		const m = src.match(new RegExp(`'${key.replace('.', '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`));
		if (!m) {
			console.error(`i18n/en.js carries no '${key}' -- the check below would compare nothing.`);
			process.exit(2);
		}
		out[key] = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
	}
	return out;
})();

// ── The stubbed gateway ──────────────────────────────────────────────
// A real namespace owner in miniature: one name to one account, a 409 for a name
// somebody else holds, and a switch that makes it fall over, which is the fourth
// refusal and the only one no name can provoke.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});

const ME       = 'acct-joinedup';
const SOMEONE  = 'acct-somebody-else';
const THEIRS   = 'quiet-heron-22aa';
const MINTED   = 'bright-finch-5m5m';
const RESERVED = new Set(['admin', 'daimond', 'support', 'system', 'root', 'operator']);

const NS  = new Map([[THEIRS, SOMEONE]]);
let clock = 1_700_000_000;
let mine  = '';
let mineTs = 0;
let sick  = false;			// the gateway falls over, for `handle.failed`

function normalise(raw) {
	const h = String(raw || '').trim().toLowerCase();
	if (h.length < 3 || h.length > 24) return null;
	if (!/^[a-z0-9-]+$/.test(h)) return null;
	if (h.startsWith('-') || h.endsWith('-') || h.includes('--')) return null;
	return h;
}

function accountRoute(r) {
	const req    = r.request();
	const url    = new URL(req.url());
	const method = req.method();

	if (process.env.JU_DEBUG) console.log(`   [stub] ${method} ${url.pathname}${url.search} body=${req.postData() || ''}`);
	if (method === 'POST' && url.searchParams.get('op') === 'handle') {
		if (sick) return r.fulfill(json({ ok: false }, 500));
		let body = {};
		try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = {}; }
		const want = normalise(body.handle);
		if (!want) return r.fulfill(json({ ok: false, reason: 'invalid' }, 400));
		if (RESERVED.has(want)) return r.fulfill(json({ ok: false, reason: 'reserved' }, 400));
		const holder = NS.get(want);
		if (holder && holder !== ME) return r.fulfill(json({ ok: false, reason: 'taken' }, 409));
		NS.delete(mine);
		mine   = want;
		mineTs = ++clock;
		NS.set(mine, ME);
		return r.fulfill(json({ ok: true, reason: 'claimed', handle: mine, handle_ts: mineTs }));
	}
	if (method === 'GET') {
		return r.fulfill(json({ ok: true, account_id: ME, handle: mine, handle_ts: mineTs }));
	}
	// Registration. The gateway mints the name; the client never proposes one.
	if (!mine) { mine = MINTED; mineTs = ++clock; NS.set(mine, ME); }
	return r.fulfill(json({ ok: true, account_id: ME, created: true, handle: mine, handle_ts: mineTs }));
}

/// Everything the page needs to boot signed in against a gateway that answers.
async function stubGateway(page) {
	// A catch-all FIRST, because Playwright gives a request to the route
	// registered LAST -- so everything below overrides this, and everything the
	// app asks for that is not below gets a bland yes instead of a 502.
	//
	// It is here for one reason. This world has no gateway, and opening the Admin
	// drawer sets off the console-role probe, the devices list and the balance
	// poll; each 502 knocked the session over, the app re-bootstrapped, and
	// `handleReady()` was false for a moment every few hundred milliseconds. Half
	// the renames in this file were then refused with "try again shortly" -- in
	// the one check whose whole subject is WHICH refusal was given.
	await page.route('**/api/**', r => r.fulfill(json({ ok: true })));
	await page.route(/\/api\/account(\?|$)/, accountRoute);
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-j', challenge_id: 'cid-j' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 5000, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: true, held: true, currency: 'usd' })));
	await page.route('**/api/sync**',         r => r.fulfill(json({ ok: true, version: 0, blob: null })));
}

// ── 2. The predicate, in two languages ───────────────────────────────
//
// STATIC, and first, because it needs no browser and because it is the check
// that stops the duplication rotting. The three terms are pulled OUT of the Rust
// source: nothing here restates them, so a change to `is_folder_lost` that the
// browser mirror does not follow goes red.
{
	const rs = fs.readFileSync(path.join(ROOT, 'src/wasm/opfs.rs'), 'utf8');
	const js = fs.readFileSync(path.join(WWW, SRC), 'utf8');

	const pred = (rs.match(/pub fn is_folder_lost\(result: &str\) -> bool \{([\s\S]*?)\n\}/) || [])[1] || '';
	check('src/wasm/opfs.rs still has an is_folder_lost to mirror', !!pred.trim(),
		pred.trim().slice(0, 80));

	// `workspace_mode() == "folder" && result.contains("NotAllowed")` — taken to
	// pieces so the JS can be asked about each piece by name.
	const mode = (pred.match(/(\w+)\(\)\s*==\s*"([^"]+)"/) || []);
	const text = (pred.match(/contains\("([^"]+)"\)/) || []);
	check('and its two terms read out of the Rust, not restated here',
		!!mode[1] && !!mode[2] && !!text[1], `${mode[1]}()=="${mode[2]}" && contains("${text[1]}")`);

	const mirror = (js.match(/function folderWasLost\(e\) \{([\s\S]*?)\n\}/) || [])[1] || '';
	// One line, so a failure prints something a reader can take in.
	const flat = mirror.replace(/\s+/g, ' ').trim().slice(0, 150);
	check('js/daimond.js carries the mirror', !!mirror.trim());
	check('which asks the same question of the root', mirror.includes(`${mode[1]}() !== '${mode[2]}'`)
		|| mirror.includes(`${mode[1]}() === '${mode[2]}'`), flat);
	check('and tests the same word in the failure', mirror.includes(`'${text[1]}'`), flat);

	// The event name, likewise read from the Rust constant rather than typed.
	const ev = (rs.match(/pub const FOLDER_LOST_EVENT: &str = "([^"]+)"/) || [])[1] || '';
	check('the browser raises the event the Rust names', !!ev && js.includes(`dispatchEvent(new CustomEvent('${ev}'))`), ev);
	check('and the one handler is still the only listener for it',
		js.split(`window.addEventListener('${ev}', handlePermissionLoss)`).length === 2,
		'handlePermissionLoss');

	// Every direct-call site the panel owns now reports. Named individually,
	// because "at least one" is satisfied by the first one anybody wired.
	const sites = js.split('noteFolderLost(').length - 1;
	check('and every direct read reports through it, not just one',
		sites >= 6, `${sites} references (declaration plus call sites)`);
}

// ── 6. The dead word-mark swap, at the source ────────────────────────
{
	const js = fs.readFileSync(path.join(WWW, SRC), 'utf8');
	check('nothing in js/daimond.js queries .empty-logo any more',
		!/querySelector\([^)]*empty-logo/.test(js));
}

// ── The one browser session that carries items 1, 3, 4 and 5 ─────────
const PROFILE = scratch('pw', 'joinedup' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({
	name: 'joinedup', profile: PROFILE, connect: false,
	route: async (page) => { await serveBroken(page); await stubGateway(page); },
});
const p = s.page;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

/// The dialog standing at the front, or null.
const front = () => p.evaluate(() => {
	const ds = document.querySelectorAll('.modal.dlg');
	if (!ds.length) return null;
	const d = ds[ds.length - 1];
	return {
		title: ((d.querySelector('h2') || {}).textContent || '').trim(),
		msg:   ((d.querySelector('.dlg-msg') || {}).textContent || '').trim(),
		input: !!d.querySelector('.dlg-input'),
	};
});

/// Dismiss whatever dialog is at the front, and wait for the card to LEAVE.
///
/// Not a fixed pause: a dialog fades out, and one still in the document while the
/// next is opened means `front()` reads the card that is going rather than the
/// one that came -- which is a flake that reports the wrong sentence, in a check
/// whose whole subject is which sentence was said.
const dismiss = async () => {
	await p.evaluate(() => {
		const ds = document.querySelectorAll('.modal.dlg');
		if (!ds.length) return;
		const b = ds[ds.length - 1].querySelector('.dlg-ok');
		if (b) b.click();
	});
	await settled();
};

/// Wait until no dialog is standing.
const settled = () => p.waitForFunction(
	() => document.querySelectorAll('.modal.dlg').length === 0, null, { timeout: 8000 });

try {

// ── 1. A user can change their public handle ─────────────────────────

await p.waitForFunction(() => !!(window.DaimondSync && window.DaimondSync.handle()),
	null, { timeout: 15000 }).catch(() => { /* asserted below, with the value */ });
const minted = await p.evaluate(() => window.DaimondSync.handle());
check('the account was minted a public name it did not choose', minted === MINTED,
	`showing '${minted}'`);

// The session has to be up before a rename is asked for, or `claimHandle`
// answers "not just now" for a reason that has nothing to do with the name --
// which is a flake in the one check that is about WHICH refusal was given.
await p.waitForFunction(() => {
	try { return !!(window.DaimondGateway && DaimondGateway.state().authed); }
	catch (e) { return false; }
}, null, { timeout: 15000 }).catch(() => { /* the refusals below will say so */ });

await p.click('#user-row');
await p.waitForTimeout(500);

// PRESENT, then VISIBLE, and in that order. A locator asked whether a control
// that does not exist is visible answers "no", which reads as "it is there and
// hidden" -- and that answer is how three of these defects survived.
const btn = p.locator('#admin-change-handle');
check('the Admin home HAS a control for the public handle', await btn.count() === 1,
	`${await btn.count()} matching element(s)`);
check('and it is on screen, not merely in the document',
	await btn.count() === 1 && await btn.first().isVisible());
const row = p.locator('#account-handle');
check('and the name it changes is shown beside the fingerprint', await row.count() === 1);
check('with the minted name in it',
	await row.count() === 1 && (await row.first().innerText()).includes(minted),
	await row.count() ? (await row.first().innerText()).trim() : '(no row)');

/// Press the control, type `name`, press Save, and report what came back.
async function claim(name) {
	await settled().catch(() => {});		// nothing left over from the last one
	// A control that is not there is a FAILURE of the checks above, not a crash
	// here: the run has to reach its tally or a break proves nothing but a stack.
	const pressed = await p.evaluate(() => {
		const b = document.getElementById('admin-change-handle');
		if (!b) return false;
		b.click();
		return true;
	});
	if (!pressed) {
		return { prefilled: '', said: null, gw: null,
			showing: await p.evaluate(() => window.DaimondSync.handle()) };
	}
	await p.waitForSelector('.modal.dlg .dlg-input', { timeout: 8000 });
	const prefilled = await p.inputValue('.modal.dlg .dlg-input');
	await p.fill('.modal.dlg .dlg-input', name);
	await p.evaluate(() => {
		const ds = document.querySelectorAll('.modal.dlg');
		ds[ds.length - 1].querySelector('.dlg-ok').click();
	});
	// The prompt closes the moment Save is pressed; the refusal arrives a network
	// round trip LATER. So this waits for a dialog that is not the prompt -- one
	// with no input in it -- and reads "none within four seconds" as the rename
	// having been accepted, because a rename that takes says nothing at all.
	//
	// Waiting for "no dialog with an input" instead was the flake: it was true
	// the instant the prompt closed, so the refusal was read as null perhaps one
	// run in six.
	await p.waitForFunction(() => {
		const ds = document.querySelectorAll('.modal.dlg');
		return ds.length > 0 && !ds[ds.length - 1].querySelector('.dlg-input');
	}, null, { timeout: 4000 }).catch(() => { /* accepted: there is no notice */ });
	const said = await front();
	if (said) await dismiss();
	else await settled().catch(() => {});
	const gw = await p.evaluate(() => {
		try {
			return { authed: !!DaimondGateway.state().authed,
				safe: !!(window.DaimondSafe && DaimondSafe.on()) };
		} catch (e) { return { authed: null, safe: null }; }
	});
	return { prefilled, said, gw, showing: await p.evaluate(() => window.DaimondSync.handle()) };
}

const taken    = await claim(THEIRS);
check('the dialog opens pre-filled with the name the account holds now',
	taken.prefilled === minted, `pre-filled '${taken.prefilled}'`);
const invalid  = await claim('no');
const reserved = await claim('admin');
// The half without which the whole property could be met by refusing everything.
const won      = await claim('copper-marten-8p8p');
// LAST, and on purpose: a 500 from the account endpoint is the one answer that
// can leave the session unsure of itself, and a check that has already had its
// answers is a check that cannot be spoiled by it.
sick = true;
const failed   = await claim('another-name-entirely');
sick = false;

const heard = {
	taken:    taken.said    && taken.said.msg,
	invalid:  invalid.said  && invalid.said.msg,
	reserved: reserved.said && reserved.said.msg,
	failed:   failed.said   && failed.said.msg,
};
check('a name somebody else holds is refused in the words written for it',
	heard.taken === CATALOGUE['handle.taken'],
	String(heard.taken) + ' [gw ' + JSON.stringify(taken.gw) + ']');
check('a name that is not a name, likewise',
	heard.invalid === CATALOGUE['handle.invalid'], String(heard.invalid));
check('a name the operator keeps, likewise',
	heard.reserved === CATALOGUE['handle.reserved'], String(heard.reserved));
check('and a gateway that cannot answer says so as itself',
	heard.failed === CATALOGUE['handle.failed'], String(heard.failed));
check('which is four different sentences, not one repeated',
	new Set(Object.values(heard)).size === 4,
	Object.entries(heard).map(([k, v]) => k + '=' + String(v).slice(0, 24)).join(' | '));
check('and no refusal moved the name',
	taken.showing === minted && invalid.showing === minted
		&& reserved.showing === minted && failed.showing === won.showing,
	[taken.showing, invalid.showing, reserved.showing, failed.showing].join(', '));

check('a rename that the gateway takes, takes here too',
	won.showing === 'copper-marten-8p8p', `showing '${won.showing}'`);
const rowAfter = await p.locator('#account-handle').innerText().catch(() => '');
check('and the panel redraws to say the new name',
	rowAfter.includes('copper-marten-8p8p'), rowAfter.trim());

await p.keyboard.press('Escape');
await p.waitForTimeout(300);

// ── 5. The reproducible-build check is linked from About ─────────────

await p.evaluate(() => document.getElementById('about-btn').click());
await p.waitForSelector('.about-body', { timeout: 8000 });
const link = p.locator('.about-body a.about-verify');
check('About HAS a way through to the build check', await link.count() === 1,
	`${await link.count()} matching element(s)`);
check('and it is on screen, not merely in the document',
	await link.count() === 1 && await link.first().isVisible());
const href = await link.count() ? await link.first().getAttribute('href') : '';
const rel  = await link.count() ? (await link.first().getAttribute('rel') || '') : '';
const tgt  = await link.count() ? (await link.first().getAttribute('target') || '') : '';
check('pointing at the app\'s own verify page', /(^|\/)verify\.html$/.test(String(href)), String(href));
check('in a tab of its own, with no handle back on this window',
	tgt === '_blank' && rel.includes('noopener') && rel.includes('noreferrer'),
	`target='${tgt}' rel='${rel}'`);
check('and it says what it is for, not just where it goes',
	/\bbuild\b/i.test(await link.first().innerText().catch(() => '')),
	(await link.first().innerText().catch(() => '')).trim());
// A link is not a reach until something answers at the other end.
const served = await p.evaluate(async (u) => {
	try {
		const r = await fetch(u, { cache: 'no-store' });
		return { status: r.status, body: (await r.text()).slice(0, 4000) };
	} catch (e) { return { status: 0, body: String(e) }; }
}, href || 'verify.html');
check('and the page at the other end is really the build check',
	served.status === 200 && served.body.includes('id="verdict"'),
	`HTTP ${served.status}`);
await p.keyboard.press('Escape');
await p.waitForTimeout(300);

// ── 3. The Improve panel's "i" opens the page about the panel ────────

await p.evaluate(() => window.DaimondPanels.show('social'));
await p.waitForTimeout(500);
const info = p.locator('#social-info');
check('the Improve panel HAS its circled i', await info.count() === 1,
	`${await info.count()} matching element(s)`);
check('and it is on screen, not merely in the document',
	await info.count() === 1 && await info.first().isVisible());
await p.evaluate(() => document.getElementById('social-info').click());
await p.waitForTimeout(800);
const framed = await p.evaluate(() => {
	const f = document.getElementById('web-frame');
	return f ? (f.getAttribute('src') || '') : '(no frame)';
});
check('and pressing it opens the guide page about THIS panel',
	/guide\/social\.html$/.test(framed), framed);
const guidePage = await p.evaluate(async () => {
	try {
		const r = await fetch('guide/social.html', { cache: 'no-store' });
		return { status: r.status, len: (await r.text()).length };
	} catch (e) { return { status: 0, len: 0 }; }
});
check('and that page exists and has something on it',
	guidePage.status === 200 && guidePage.len > 2000, JSON.stringify(guidePage));

// ── 6. The dead rule is gone from the stylesheets the page loaded ────
//
// Asked of the LOADED CSS and not of the file on disk: what matters is that no
// rule in the running app selects a class nothing produces.
const deadRules = await p.evaluate(() => {
	const out = [];
	for (const sheet of document.styleSheets) {
		let rules;
		try { rules = sheet.cssRules; } catch (e) { continue; }	// a sheet we may not read
		for (const r of rules) {
			if (r.selectorText && r.selectorText.includes('empty-logo')) out.push(r.selectorText);
		}
	}
	return out;
});
check('no stylesheet rule selects .empty-logo, which nothing draws',
	deadRules.length === 0, deadRules.join(' | '));
const drawn = await p.evaluate(() => document.querySelectorAll('.empty-logo').length);
check('and nothing on the page carries the class', drawn === 0, String(drawn));

// ── 4. A backup's version is read ────────────────────────────────────

const NEWER = scratch('joinedup-newer.json');
const KNOWN = scratch('joinedup-known.json');
fs.writeFileSync(NEWER, JSON.stringify({
	format: 'daimond-backup', version: 99, exported: new Date().toISOString(),
	chats: [], workspace: [], diamonds: [],
}));
fs.writeFileSync(KNOWN, JSON.stringify({
	format: 'daimond-backup', version: 1, exported: new Date().toISOString(),
	chats: [], workspace: [], diamonds: [],
}));

/// Feed a file to the Import control and report the dialog that answers.
async function importFile(file) {
	// Never throws. Under `--break noversion` the first import is ACCEPTED, and
	// acknowledging it reloads the app into the lock screen -- so the second
	// import below has nothing to press. That is the defect behaving exactly as
	// it shipped, and it must show up as a red check rather than as a stack trace
	// that stops the rest of the file from running.
	try {
		await p.click('#user-row', { timeout: 8000 });
		await p.waitForTimeout(400);
		const chooser = p.waitForEvent('filechooser', { timeout: 15000 });
		await p.click('button.admin-item:has-text("Import a backup")', { timeout: 8000 });
		await (await chooser).setFiles(file);
		await p.waitForSelector('.modal.dlg .dlg-ok', { timeout: 15000 }).catch(() => {});
		return front();
	} catch (e) { return null; }
}

const refused = await importFile(NEWER);
check('a backup this build does not know is refused, out loud',
	!!refused && /newer/i.test(refused.title), refused ? refused.title : '(no dialog)');
check('and the refusal says BOTH numbers, so the reader knows what to run',
	!!refused && refused.msg.includes('99') && refused.msg.includes('1'),
	refused ? refused.msg.slice(0, 120) : '');
check('and nothing was restored: the app did not reload out from under it',
	await p.evaluate(() => !!(window.DaimondSync && window.DaimondSync.handle())).catch(() => false));
// Dismissed only if it really was the refusal. A "Backup restored" notice --
// which is what a build that does not read the version puts here -- reloads the
// app when it is acknowledged, and the run would then be pressing buttons on a
// lock screen.
if (refused && /newer/i.test(refused.title)) {
	await dismiss().catch(() => {});
	await p.waitForTimeout(400);
}

// The other half. Without it, "refuse everything" would pass the check above.
const accepted = await importFile(KNOWN);
check('a backup this build DOES know is still restored',
	!!accepted && !/newer/i.test(accepted.title), accepted ? accepted.title : '(no dialog)');

// Nothing threw on the way past. Failed loads are excluded: this world has no
// gateway on :9002, so every endpoint not stubbed here answers 502, which says
// nothing about any of the above. An exception does.
const threw = errors(s).filter(e => !/Failed to load resource|502|WebSocket|ERR_/i.test(e));
check('nothing threw in the page', threw.length === 0, threw.slice(0, 3).join(' | '));

} finally {
	await s.close();
}

// ── 2, live. A withdrawn grant, on the panel's own read ──────────────
//
// The wasm glue is patched so that the workspace root reports itself as a real
// folder and a read fails the way a revoked grant fails. That is fault injection
// and not a break: it stands in for a browser event this harness cannot produce,
// and BOTH outcomes are asked for -- a NotAllowed failure must raise the alarm,
// and an ordinary one under the same root must not.
const GLUE = 'pkg/oxedyne_daimond.js';
const NOT_ALLOWED = "OPFS: open dir 'x' failed: NotAllowedError: The request is not allowed "
	+ 'by the user agent or the platform in the current context.. [IO, File, Read]';

const glueSrc = fs.readFileSync(path.join(WWW, GLUE), 'utf8');
const MODE_FN = 'export function workspace_mode() {';
const READ_FN = 'export function read_file(path) {';
for (const anchor of [MODE_FN, READ_FN]) {
	if (glueSrc.split(anchor).length !== 2) {
		console.error(`the wasm glue no longer carries '${anchor}' exactly once; `
			+ 'the injection below would prove nothing.');
		process.exit(2);
	}
}
const glue = glueSrc
	.replace(MODE_FN, MODE_FN + "\n    return 'folder';\t// injected: a real folder is open")
	.replace(READ_FN, READ_FN
		+ `\n    return Promise.reject(String(path).indexOf('lost/') === 0`
		+ `\n        ? ${JSON.stringify(NOT_ALLOWED)}`
		+ `\n        : "OPFS: open file 'x' failed: NotFoundError. [IO, File, Read]");`);

const PROFILE2 = scratch('pw', 'joinedup-lost' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE2, { recursive: true, force: true });
const s2 = await open({
	name: 'joinedlost', profile: PROFILE2, connect: false,
	route: async (page) => {
		await serveBroken(page);
		await page.route('**/' + GLUE, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body: glue,
		}));
		// The counter has to exist before the app does, or a boot-time read would
		// be missed and the count below would be the wrong number for a good reason.
		await page.addInitScript(() => {
			window.__lost = 0;
			window.addEventListener('daimond:folder-lost', () => { window.__lost++; });
		});
	},
});
try {
	const p2 = s2.page;
	await p2.waitForFunction(() => !!(window.DaimondCore && window.DaimondCore.readFile),
		null, { timeout: 15000 });
	check('the workspace root reports itself as a real folder',
		await p2.evaluate(async () => (await import('/pkg/oxedyne_daimond.js')).workspace_mode()) === 'folder');

	const before = await p2.evaluate(() => window.__lost);
	// An ORDINARY failure first. A read that fails because the file is not there
	// must NOT cost the user their folder -- and asking this FIRST means the
	// positive half below cannot be satisfied by an alarm already ringing.
	await p2.evaluate(() => window.DaimondCore.readFile('ordinary/missing.md').catch(() => {}));
	await p2.waitForTimeout(300);
	const afterOrdinary = await p2.evaluate(() => window.__lost);
	check('a read that fails because the file is missing raises no alarm',
		afterOrdinary === before, `${before} → ${afterOrdinary}`);

	await p2.evaluate(() => window.DaimondCore.readFile('lost/anything.md').catch(() => {}));
	await p2.waitForTimeout(300);
	const afterLost = await p2.evaluate(() => window.__lost);
	check('and a read that fails on a withdrawn grant raises it, from the PANEL\'s own door',
		afterLost > afterOrdinary, `${afterOrdinary} → ${afterLost}`);

	const threw2 = errors(s2).filter(e => !/Failed to load resource|502|WebSocket|ERR_|NotFound|NotAllowed/i.test(e));
	check('nothing threw in the injected page', threw2.length === 0, threw2.slice(0, 3).join(' | '));
} finally {
	await s2.close();
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('failed: ' + bad.join(', '));
process.exit(bad.length ? 1 : 0);
