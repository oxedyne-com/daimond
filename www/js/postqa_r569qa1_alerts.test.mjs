/* QA r569qa1 (post-deploy): the alerts section's parcel must be a fixed point when nothing
   changes. sync.js compares `compareKey(collect)` to what it last sent and skips the push
   when they agree; `alerts` is a known section and is compared verbatim.
   Run: node www/js/postqa_r569qa1_alerts.test.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'alerts.js'), 'utf8');
const LOAD = new Function('window', 'with (window) {\n' + SRC + '\n}\n//# sourceURL=alerts.js');
const T0 = 1_790_000_000_000, MIN = 60 * 1000;
function device(t) { const w = makeWindow({ now: t || T0 }); LOAD(w); return w; }
function tool(w, verb, diamond, p) { return JSON.parse(w.DaimondPendingTool[verb](diamond, JSON.stringify(p))); }
const snap = (w) => JSON.stringify(w.DaimondAlerts.syncSnapshot());
let fails = 0;
function check(name, cond, detail) { console.log((cond ? '  ok   ' : '  FAIL ') + name + (detail ? '  (' + detail + ')' : '')); if (!cond) fails++; }

// A server-watch Diamond: one condition still up, then 200 incidents raised and cleared
// under their own keys (each leaves a tombstone for a month), so the 200-item cap sheds.
const a = device();
tool(a, 'raise', 'mail', { key: 'disk-web1', headline: 'Disk 92% on web1', needs: true });
for (let i = 0; i < 200; i++) {
	a._setNow(T0 + 100 + i * 2); tool(a, 'raise', 'mail', { key: 'inc' + i, headline: 'Incident ' + i, needs: true });
	a._setNow(T0 + 101 + i * 2); tool(a, 'clear', 'mail', { key: 'inc' + i });
}
a._setNow(T0 + 10 * MIN);
const s1 = snap(a);
a._setNow(T0 + 20 * MIN);			// nothing raised, cleared or synced in between
const s2 = snap(a);
const seen = (s) => (JSON.parse(s).items['mail:disk-web1'] || {}).seen;
check('Q1. with nothing changed, two collects of the alerts section are identical (push-skip holds)',
	s1 === s2, 'seen ' + seen(s1) + ' -> ' + seen(s2));

// And the peer: each landed parcel is news to it as well.
const b = device(T0 + 20 * MIN);
b.DaimondAlerts.adoptSync(JSON.parse(s1));
b._setNow(T0 + 21 * MIN);
const changed = b.DaimondAlerts.adoptSync(JSON.parse(s2));
check('Q2. the peer finds nothing new in a parcel that changed nothing', changed === false);
// Q3. Two devices each append a mail note before either has synced (two arrivals, two claims).
{
	const c = device(T0), d = device(T0);
	c.DaimondAlerts.note('mail', 'mail-note', 'From Email', 'desk: invoice from ACME filed');
	d._setNow(T0 + 5);
	d.DaimondAlerts.note('mail', 'mail-note', 'From Email', 'phone: newsletter archived');
	const cs = JSON.parse(JSON.stringify(c.DaimondAlerts.syncSnapshot()));
	const ds = JSON.parse(JSON.stringify(d.DaimondAlerts.syncSnapshot()));
	c.DaimondAlerts.adoptSync(ds); d.DaimondAlerts.adoptSync(cs);
	const det = c.DaimondAlerts.live().map((x) => x.detail).join('|');
	check('Q3. both devices\' note words survive the merge', det.includes('desk:') && det.includes('phone:'), JSON.stringify(det));
}
// Q4. The per-device notes are bounded: a fifth device's note takes the oldest down.
{
	const w = device(T0);
	for (let i = 0; i < 5; i++) {
		w._setNow(T0 + 10 + i);
		w.localStorage.setItem('daimond-id-device', 'dev' + i);
		w.DaimondAlerts.note('mail', 'mail-note', 'From Email', 'from dev' + i);
	}
	const keys = w.DaimondAlerts.live().map((x) => x.key);
	check('Q4. at most four live device notes per Diamond, the oldest taken down',
		keys.length === 4 && !keys.includes('mail-note.dev0'), JSON.stringify(keys));
	check('Q5. a per-device note key is the page\'s, not the model\'s',
		JSON.parse(w.DaimondPendingTool.clear('mail', JSON.stringify({ key: 'mail-note.dev1' }))).ok === false);
}
process.exit(fails ? 1 : 0);
