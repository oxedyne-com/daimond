// verify_parcelbudget.mjs — the sync parcel's ceiling is set by the door it has to
// go through, and the sections spent against it add up to no more than it.
//
// WHY THIS FILE EXISTS. `SYNC_PARCEL_MAX` was 10 MiB, and the comment above it
// derived that from the GATEWAY's 16 MiB body cap. Steel terminates TLS in front of
// the gateway on jarrah and caps a body at 8 MiB, so the client could compose a
// parcel the front door refuses — and the comment, being a piece of reasoning from
// the wrong authority, would have talked the next reader into putting the number
// back. A value nobody can derive is a value somebody will restore.
//
// Three things are asked, and each is asked of the source rather than of a copy:
//
//   1. THE ARITHMETIC. What travels is base64 of the sealed parcel inside a JSON
//      envelope, so the body is 4 bytes for every 3 of parcel plus the AES-GCM IV
//      and tag. `SYNC_PARCEL_MAX` inflated that way must fit under Steel's door.
//   2. THE SPLIT. `collectSync` hands the Diamonds
//      `min(SYNC_DIAMONDS_MAX, SYNC_PARCEL_MAX - files)`. A Diamonds cap at or above
//      the parcel can never be the smaller of those two, so it never binds and reads
//      as a guarantee it does not make.
//   3. THE AUTHORITY. The comment on the constant must name Steel. This is the one
//      check here that is about prose, and it is the one that stops the regression
//      this file was written for.
//   4. AND WHAT DID NOT FIT IS NAMED. Not arithmetic at all, and it is here because
//      it is what the arithmetic was being held hostage to: while a file dropped for
//      budget was named to nobody, lowering the files budget would have made the sums
//      add up by making the failure silent. The names come first; the number after.
//
// How each goes red:
//
//   * put `SYNC_PARCEL_MAX` back to `10 * 1024 * 1024` → check 1 goes red and
//     check 2 goes red with it (10 MiB of parcel is 13.4 MiB of body, and the
//     Diamonds' 3 MiB is then only a fifth of a parcel it was never measured
//     against);
//   * raise `SYNC_DIAMONDS_MAX` to `5 * 1024 * 1024` → check 2 alone goes red;
//   * delete the word Steel from the comment → check 3 alone goes red.
//
//   node dev/verify_parcelbudget.mjs
//
// No browser, no gateway, no mock LLM: this reads source and does arithmetic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP  = fs.readFileSync(path.join(ROOT, 'www', 'js', 'daimond.js'), 'utf8');

// Steel's `http_max_body_bytes`, whose default is 8 MiB in fe2o3_steel/src/srv/cfg.rs
// and which the deployed config does not set. Restated here because fe2o3 is a
// separate repository that may not be beside this one — and checked against it below
// wherever it is, so the restatement cannot quietly go stale.
const STEEL_BODY_MAX = 8 * 1024 * 1024;
// `{"base_version":N,"device":"…","blob":"…","w":"…"}` around the sealed blob, plus
// room for a long device label. Deliberately generous: it is subtracted from the
// door, so over-stating it can only make the ceiling safer.
const ENVELOPE       = 512;
// AES-GCM: a 12-byte IV in front of the ciphertext and a 16-byte tag behind it,
// both inside what gets base64'd. See `wrap` in www/js/identity.js.
const SEAL           = 12 + 16;

let bad = 0;
const check = (what, ok, saw) => {
	console.log((ok ? 'ok   ' : 'FAIL ') + what + (saw === undefined ? '' : '  [' + saw + ']'));
	if (!ok) bad++;
};

/// A `var NAME = a * b * c;` constant, read out of the app source.
const constOf = (name) => {
	const m = new RegExp('var\\s+' + name + '\\s*=\\s*([0-9*\\s]+);').exec(APP);
	if (!m) throw new Error('verify_parcelbudget: ' + name + ' not found in www/js/daimond.js');
	return m[1].split('*').reduce((a, b) => a * Number(b.trim()), 1);
};

const PARCEL   = constOf('SYNC_PARCEL_MAX');
const DIAMONDS = constOf('SYNC_DIAMONDS_MAX');
const FILES    = constOf('SYNC_FILES_TOTAL_MAX');

// ── 1. The arithmetic ────────────────────────────────────────────────
const body = Math.ceil((PARCEL + SEAL) / 3) * 4 + ENVELOPE;
check('a parcel at the ceiling, sealed and base64\'d, fits under Steel\'s 8 MiB door',
	body <= STEEL_BODY_MAX, body + ' bytes of body from ' + PARCEL + ' of parcel');

// The largest parcel that fits, so the message says what the ceiling could be rather
// than only that it is not exceeded.
const most = Math.floor((STEEL_BODY_MAX - ENVELOPE) / 4) * 3 - SEAL;
check('the ceiling leaves margin under the arithmetic maximum, for the sections it '
	+ 'does not bound and for UTF-8',
	PARCEL < most, PARCEL + ' against a maximum of ' + most);

// ── 2. The split ─────────────────────────────────────────────────────
check('the Diamonds\' cap can actually bind — it is below the parcel it is spent in',
	DIAMONDS < PARCEL, DIAMONDS + ' of ' + PARCEL);

// ── 2b. And what the parcel could not carry is NAMED ─────────────────
//
// THE ASYMMETRY WAS THE DEFECT, not the arithmetic. A Diamond left out of a parcel
// has always been named to the user by `noteDiamondsLeft`; a file skipped for budget
// went into a COUNT, made the census incomplete, and was named to nobody -- so a
// workspace with a few megabytes of inline text quietly stopped travelling between a
// person's devices and the app said nothing at all. Files are spent FIRST and are not
// clamped against the parcel, which makes the unnamed case the commoner of the two.
//
// This was a standing `note` here until 2026-08-28 rather than a check, and it said
// why: lowering `SYNC_FILES_TOTAL_MAX` would have fixed the arithmetic by trading a
// failure that names what was dropped for one that names nothing. The visibility had
// to come first. It has, so this is a check.
//
// ASKED OF THE SOURCE, like everything else here -- no browser, no parcel, no
// workspace. What it cannot see is the toast on the screen; what it can see is that
// every branch which drops a file for budget records its NAME, that `collectSync`
// hands those names to a teller, and that the teller says them out loud.
const collectFiles = APP.slice(APP.indexOf('async function collectFiles()'),
	APP.indexOf('async function writeSyncFile'));
const drops = [...collectFiles.matchAll(/>\s*(SYNC_CHUNK_TOTAL_MAX|SYNC_FILES_TOTAL_MAX)\)\s*\{([^}]*)\}/g)];
check('the budget branches that drop a file were found in collectFiles',
	drops.length >= 3, drops.length + ' branch(es)');
const silent = drops.filter((m) => !/out\.left\.push/.test(m[2]));
check('EVERY FILE THE PARCEL CANNOT CARRY IS RECORDED BY NAME, not merely counted',
	silent.length === 0,
	silent.map((m) => m[0].replace(/\s+/g, ' ')).join(' | '));
check('and the names are handed to a teller when the parcel is packed',
	/noteFilesLeft\(fileCol\.left\)/.test(APP));
const teller = APP.slice(APP.indexOf('function noteFilesLeft'),
	APP.indexOf('function noteFilesLeft') + 700);
check('which SAYS them, in the same shape a Diamond that did not fit is said in',
	/toast\(tn\('sync\.files_left'/.test(teller) && /slice\(0, 3\)/.test(teller));
// In all eight, because `tOr` and `tn` fall back to English and a missing
// translation looks exactly like a finished one.
const gaps = ['en', 'es', 'de', 'fr', 'pt-BR', 'zh-Hans', 'ja', 'ko'].filter((code) => {
	const src = fs.readFileSync(path.join(ROOT, 'www', 'i18n', code + '.js'), 'utf8');
	return !/'sync\.files_left\.one':/.test(src) || !/'sync\.files_left\.other':/.test(src);
});
check('and the sentence is in all eight catalogues, both plural arms', gaps.length === 0,
	gaps.join(', '));

// Still over-subscribed, and now it is a DECISION rather than a blocker: the
// condition the old note set -- that a file's skip be as visible as a Diamond's --
// is met by the checks above, so the files budget can come down without trading a
// named failure for a silent one. Left as a note because what it should come down TO
// is the owner's to say: it is a judgement about how much of a parcel a workspace
// should be able to take from the Diamonds, not an arithmetic fact.
if (FILES + DIAMONDS > PARCEL) {
	console.log('note  the two section budgets are over-subscribed: files ' + FILES
		+ ' + Diamonds ' + DIAMONDS + ' = ' + (FILES + DIAMONDS) + ' against a parcel of '
		+ PARCEL + '. Files are spent first and are not clamped against the parcel, so a '
		+ 'workspace that fills them leaves the Diamonds nothing. The skip is now named to '
		+ 'the user, so the files budget may come down: ' + (PARCEL - DIAMONDS)
		+ ' bytes would leave the Diamonds their whole share.');
}

// ── 3. The authority ─────────────────────────────────────────────────
const at  = APP.indexOf('var SYNC_PARCEL_MAX');
const why = APP.slice(Math.max(0, at - 3000), at);
check('the comment on the parcel ceiling names Steel, the door actually in force',
	/Steel/.test(why));
check('and names `http_max_body_bytes`, so the reader can go and read the default',
	/http_max_body_bytes/.test(why));

// ── 4. And the restated 8 MiB is the one fe2o3 ships, wherever fe2o3 is ──
const cfg = path.join(process.env.HOME || '', 'usr', 'code', 'rust', 'fe2o3',
	'fe2o3_steel', 'src', 'srv', 'cfg.rs');
if (fs.existsSync(cfg)) {
	const m = /http_max_body_bytes:\s+([0-9*\s]+),/.exec(fs.readFileSync(cfg, 'utf8'));
	const shipped = m ? m[1].split('*').reduce((a, b) => a * Number(b.trim()), 1) : 0;
	check('the 8 MiB restated here is the default fe2o3_steel ships',
		shipped === STEEL_BODY_MAX, shipped + ' in ' + cfg);
} else {
	console.log('note  fe2o3 is not beside this repository, so the restated 8 MiB was '
		+ 'not checked against fe2o3_steel/src/srv/cfg.rs.');
}

console.log(bad ? '\n' + bad + ' FAILED' : '\nall checks passed');
process.exit(bad ? 1 : 0);
