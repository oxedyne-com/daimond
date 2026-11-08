// IndexedDB's key order for the in-memory fake stores: numbers, then strings, then
// arrays element by element. A fake holds a string key as itself and an array key as
// its JSON behind U+FFFF, so a Map can hold both.
export const enc = (k) => typeof k === 'string' ? k : '￿' + JSON.stringify(k);
export const dec = (x) => x.startsWith('￿') ? JSON.parse(x.slice(1)) : x;
const rank = (k) => typeof k === 'number' ? 0 : typeof k === 'string' ? 1 : 2;
export function cmp(a, b) {
	if (rank(a) !== rank(b)) return rank(a) - rank(b);
	if (rank(a) < 2) return a < b ? -1 : a > b ? 1 : 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; }
	return a.length - b.length;
}
/// Is `k` inside the `IDBKeyRange.bound` shape `r` (no range: every key)?
export const inRange = (r, k) => !r || (cmp(k, r.lower) > (r.lowerOpen ? 0 : -1) && cmp(k, r.upper) < (r.upperOpen ? 0 : 1));
export const isRange = (k) => !!k && typeof k === 'object' && !Array.isArray(k);
