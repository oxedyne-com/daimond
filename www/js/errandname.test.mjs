/* ============================================================
   Test -- the errand carries the diamond's name, and a name over the bound is refused here (SR-W1e).
   ------------------------------------------------------------
   Kimberlite's plain card signs the diamond's name, taken from the errand's `diamondName`, and
   refuses a submit without one or over `plain.diamond_name_max` UTF-8 bytes. So the page sends
   the name he sees (`errandDiamondName`, from the diamond list), and refuses a longer one before
   anything is marked or sent, the bound read from the gateway's /api/policy
   (`plain_diamond_name_max`, app.jdat), never a literal here or in the page.

   Run:  node www/js/errandname.test.mjs
         node www/js/errandname.test.mjs --break send    # the name never written on the errand
         node www/js/errandname.test.mjs --break bound   # no client-side bound
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
const KNOWN = ['send', 'bound'];
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + BREAK + '; known: ' + KNOWN.join(', ')); process.exit(2); }
function swap(src, a, b) {
	const n = src.split(a).length - 1;
	if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times: ' + a); process.exit(2); }
	return src.replace(a, b);
}

// The bound as the gateway serves it: app.jdat's policy route.
const APP = readPage(new URL('../../gateway/app.jdat', import.meta.url), 'utf8');
const MM = /"plain_diamond_name_max":\s*"(\d+)"/.exec(APP);
const MAX = MM ? Number(MM[1]) : 0;
check('app.jdat names the plain name bound', MAX > 0, String(MM && MM[0]));

let PEER = readPage(new URL('./peer.js', import.meta.url), 'utf8');
if (BREAK === 'send') PEER = swap(PEER, "e.diamondName = o.diamondName;", "void 0;");
if (BREAK === 'bound') PEER = swap(PEER, "if (nameMax > 0 && nameBytes > nameMax) {", "if (false) {");
const pw = { addEventListener() {}, dispatchEvent() { return true; } };
new Function('window', 'document', 'with (window) {\n' + PEER + '\n}')(pw, { addEventListener() {} });
const P = pw.DaimondPeer;

const chat = { id: 'c9', diamondId: 'd1', messages: [{ role: 'user', content: 'go', mid: 't9', ts: 1 }] };
const sent = (extra) => P.buildDispatch(chat, Object.assign({ turnId: 't9', prompt: 'go', now: 2, diamondNameMax: MAX }, extra)).errand(0);

check('a daimon errand carries the name he sees', sent({ diamondName: 'Weekday dates' }).diamondName === 'Weekday dates');
check('an ordinary chat carries no name', !('diamondName' in P.buildDispatch({ id: 'c8', messages: chat.messages },
	{ turnId: 't9', prompt: 'go', diamondName: 'x' }).errand(0)));
check('no name writes no key', !('diamondName' in sent({})));
{
	const fits = 'é'.repeat(MAX / 2), over = 'é'.repeat(MAX / 2 + 1);
	let e = null, why = '';
	try { e = sent({ diamondName: fits }); } catch (x) { why = String(x.message); }
	check('a name of exactly the bound is sent', !!e && e.diamondName === fits, why);
	why = '';
	try { sent({ diamondName: over }); } catch (x) { why = String(x.message); }
	check('a name one character over is refused before send, with the reason',
		why.indexOf(String(MAX + 2) + ' bytes') >= 0 && why.indexOf(String(MAX)) >= 0, why);
	let e2 = null;
	try { e2 = P.buildDispatch(chat, { turnId: 't9', prompt: 'go', diamondName: over }).errand(0); } catch (x) { e2 = null; }
	check('with no bound from the gateway the page leaves the refusal to Kimberlite', !!e2 && e2.diamondName === over);
}

// The page fills it from the diamond list.
{
	let F = null;
	try {
		F = loadPage({ window: makeWindow({}), want: ['errandDiamondName'], stub: { diamonds: [{ id: 'd1', name: 'Grüße — garden' }] } });
	} catch (e) { check('errandDiamondName is in the page', false, String(e && e.message)); }
	if (F) {
		check('the page names the diamond as its list does', F.errandDiamondName('d1') === 'Grüße — garden', JSON.stringify(F.errandDiamondName('d1')));
		check('no diamond, no name', F.errandDiamondName('') === '' && F.errandDiamondName('d9') === '');
	}
}

console.log((failures ? 'FAIL' : 'PASS') + ' errandname: ' + (checks - failures) + '/' + checks + (BREAK ? ' (break ' + BREAK + ')' : ''));
process.exit(failures ? 1 : 0);
