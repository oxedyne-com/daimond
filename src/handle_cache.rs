//! The handles a filesystem edge has already been given, kept by path, so a path is walked once
//! rather than once per operation.
//!
//! OPFSLEAK, 2026-10-24.  Every browser `FileSystem*Handle` is a Mojo route between the renderer
//! and the browser, and Chrome keeps a small block of a shared pool for each live route.  The pool
//! grows in 64 KiB pages under `/dev/shm` and never shrinks, and a dropped handle's block is freed
//! only when a major GC collects the handle, which a page with a small heap almost never runs.
//! The OPFS edge walked every path from `navigator.storage.getDirectory()` on every call, so a
//! Typst watch over sixty files minted about 440 handles a second and the owner's tab held 10.8 GB
//! of `/dev/shm` after four days.  Holding one handle per path, and handing the same one back,
//! takes that churn to nothing.
//!
//! Target-agnostic, so the bookkeeping is proved natively; the edge that fills it is
//! [`crate::wasm::opfs`].
//!
//! ## Keys
//!
//! A key is a SCOPE -- which root the path resolves against (an account's sandbox, one opened
//! folder) -- and the path's components as the workspace spells them, joined by `/`.  A component
//! never holds a `/`, so `a/b` is below `a` and nothing else is.
//!
//! ## Bound and clean-up
//!
//! At most `cap` entries.  Past it, the entry used longest ago goes, so a walk over more paths
//! than the cap costs only the walks it would have cost without a cache.  Besides that, the edge
//! forgets a path and everything below it when it removes or moves it ([`HandleCache::forget_under`]),
//! a scope when its folder closes ([`HandleCache::forget_scopes`]), everything on an account
//! switch ([`HandleCache::clear`]), and a single path whose handle the browser says is gone.

use std::collections::BTreeMap;


/// Separates a key's scope from its path; never in a scope or a component.
const SEP: char = '\u{1}';

/// The key of `comps` (workspace spellings) under `scope`.
pub fn key<S: AsRef<str>>(scope: &str, comps: &[S]) -> String {
    let mut k = String::with_capacity(scope.len() + 1 + comps.iter().map(|c| c.as_ref().len() + 1).sum::<usize>());
    k.push_str(scope);
    k.push(SEP);
    for (i, c) in comps.iter().enumerate() {
        if i > 0 {
            k.push('/');
        }
        k.push_str(c.as_ref());
    }
    k
}

/// A bounded map from a path key to a handle, least recently used out first.
#[derive(Debug)]
pub struct HandleCache<H> {
    cap:    usize,
    tick:   u64,                    // the clock a use is stamped with
    items:  BTreeMap<String, (H, u64)>,
}

impl<H: Clone> HandleCache<H> {

    pub const fn new(cap: usize) -> Self {
        Self { cap, tick: 0, items: BTreeMap::new() }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// The handle held for `key`, marked as used now.
    pub fn get(&mut self, key: &str) -> Option<H> {
        self.tick += 1;
        let now = self.tick;
        self.items.get_mut(key).map(|(h, used)| {
            *used = now;
            h.clone()
        })
    }

    /// Hold `handle` for `key`, replacing what was there, and drop the least recently used entry
    /// when that takes the map past its cap.
    pub fn put(&mut self, key: String, handle: H) {
        self.tick += 1;
        self.items.insert(key, (handle, self.tick));
        while self.items.len() > self.cap {
            let oldest = self.items.iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => { self.items.remove(&k); },
                None    => break,
            }
        }
    }

    /// Forget `key` alone.
    pub fn forget(&mut self, key: &str) {
        self.items.remove(key);
    }

    /// Forget `key` and every key below it.  A key with no path (a scope's root) forgets the
    /// whole scope.
    pub fn forget_under(&mut self, key: &str) {
        let whole_scope = key.ends_with(SEP);
        let below = match whole_scope {
            true  => key.to_string(),
            false => {
                let mut b = key.to_string();
                b.push('/');
                b
            },
        };
        self.items.remove(key);
        // From `below`, not from `key`: `a.txt` sorts between `a` and `a/b`.
        let gone: Vec<String> = self.items.range(below.clone()..)
            .take_while(|(k, _)| k.starts_with(&below))
            .map(|(k, _)| k.clone())
            .collect();
        for k in gone {
            self.items.remove(&k);
        }
    }

    /// Forget every entry whose scope starts with `prefix`.
    pub fn forget_scopes(&mut self, prefix: &str) {
        self.items.retain(|k, _| !k.starts_with(prefix));
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }
}


// ── The walk ────────────────────────────────────────────────────────────────
//
// A held handle may outlive its entry: another door removed or moved it.  A browser that ties a
// handle to its entry rather than its path then answers `NotFoundError` or `InvalidStateError`
// through it, and so does a held folder asked for a child that was never there.  The two are told
// apart without walking the path again: the held folder is looked up once in ITS parent (itself
// held, so one new handle) and compared with the held one ([`verify`]).  The same entry means the
// folder is live and the miss is the leaf's, so only the leaf is forgotten; another entry, or none,
// forgets that folder and everything below it.  A walk therefore always starts from the deepest
// folder held, whatever went before.

/// A filesystem whose handles the walk holds: the browser's in [`crate::wasm::opfs`], a model of
/// one in the tests.
#[allow(async_fn_in_trait)]
pub trait Tree {
    type Dir:   Clone;
    type File:  Clone;
    type Fault;

    fn dirs<R>(&self, f: impl FnOnce(&mut HandleCache<Self::Dir>) -> R) -> R;
    fn files<R>(&self, f: impl FnOnce(&mut HandleCache<Self::File>) -> R) -> R;
    /// Is `e` what a handle whose entry has gone answers?
    fn stale(&self, e: &Self::Fault) -> bool;
    /// The name the workspace's `name` is stored under in `dir`.
    async fn spell(&self, dir: &Self::Dir, name: &str) -> String;
    async fn dir_in(&self, dir: &Self::Dir, name: &str, create: bool) -> Result<Self::Dir, Self::Fault>;
    async fn file_in(&self, dir: &Self::Dir, name: &str, create: bool) -> Result<Self::File, Self::Fault>;
    /// Do `a` and `b` name the same entry?
    async fn same(&self, a: &Self::Dir, b: &Self::Dir) -> bool;
    /// The root of `scope` asked for afresh, and held from now on.
    async fn root_again(&self, scope: &str) -> Result<Self::Dir, Self::Fault>;
}

/// Where a walk starts: the root, the scope its paths are held under, and whether the root is a
/// held one that may have gone.
pub struct Base<D> {
    pub dir:    D,
    pub scope:  String,
    pub held:   bool,
}

/// A failed lookup: the stored name it failed at, and the fault.
pub struct Lost<F> {
    pub name:   String,
    pub fault:  F,
}

/// Forget the handles held at `comps` and below it.
pub fn forget_under<T: Tree>(t: &T, scope: &str, comps: &[String]) {
    let at = key(scope, comps);
    t.dirs(|c| c.forget_under(&at));
    t.files(|c| c.forget_under(&at));
}

/// Run `op` on `dir`, the folder at `at`.  Where `dir` was `held` and answers stale, it is checked
/// against its parent ([`verify`]) and `op` runs once more on what that gives, whose answer
/// stands.
pub async fn ask<T, R, F, Fut>(t: &T, base: &Base<T::Dir>, at: &[String], dir: &mut T::Dir,
    held: &mut bool, create: bool, op: F)
    -> Result<R, T::Fault>
where
    T:      Tree,
    F:      Fn(T::Dir) -> Fut,
    Fut:    std::future::Future<Output = Result<R, T::Fault>>,
{
    let e = match op(dir.clone()).await {
        Ok(v)   => return Ok(v),
        Err(e)  => e,
    };
    if !*held || !t.stale(&e) {
        return Err(e);
    }
    match Box::pin(verify(t, base, at, dir, create)).await {
        Ok(d)   => {
            *dir = d;
            *held = false;
            op(dir.clone()).await
        },
        Err(l)  => Err(l.fault),
    }
}

/// The held folder `held` at `at`, checked by looking it up once in its parent: itself where that
/// is the same entry, else the entry found (held in its place, with everything below it
/// forgotten).  A folder no longer there forgets itself and everything below it.
pub async fn verify<T: Tree>(t: &T, base: &Base<T::Dir>, at: &[String], held: &T::Dir, create: bool)
    -> Result<T::Dir, Lost<T::Fault>>
{
    let fresh = match at.split_last() {
        None                => match t.root_again(&base.scope).await {
            Ok(d)       => d,
            Err(fault)  => {
                forget_under(t, &base.scope, at);
                return Err(Lost { name: String::new(), fault });
            },
        },
        Some((last, up))    => {
            let (mut dir, mut up_held) = match Box::pin(folder(t, base, up, create)).await {
                Ok(v)   => v,
                Err(l)  => {
                    forget_under(t, &base.scope, at);
                    return Err(l);
                },
            };
            let name = t.spell(&dir, last).await;
            let asked = ask(t, base, up, &mut dir, &mut up_held, create, |d| {
                let name = name.clone();
                async move { t.dir_in(&d, &name, create).await }
            }).await;
            match asked {
                Ok(d)       => d,
                Err(fault)  => {
                    forget_under(t, &base.scope, at);
                    return Err(Lost { name, fault });
                },
            }
        },
    };
    if t.same(held, &fresh).await {
        return Ok(held.clone());
    }
    forget_under(t, &base.scope, at);
    if !at.is_empty() {
        t.dirs(|c| c.put(key(&base.scope, at), fresh.clone()));
    }
    Ok(fresh)
}

/// The folder at `comps` below `base`, walked from the deepest folder of it held, creating what is
/// missing when `create`; each folder looked up is held.  Says whether the folder handed back is a
/// held one, not asked for in this walk.
pub async fn folder<T: Tree>(t: &T, base: &Base<T::Dir>, comps: &[String], create: bool)
    -> Result<(T::Dir, bool), Lost<T::Fault>>
{
    let mut dir = base.dir.clone();
    let mut held = base.held;
    let mut from = 0;
    for i in (1..=comps.len()).rev() {
        let k = key(&base.scope, &comps[..i]);
        if let Some(h) = t.dirs(|c| c.get(&k)) {
            dir = h;
            held = true;
            from = i;
            break;
        }
    }
    for i in from..comps.len() {
        let name = t.spell(&dir, &comps[i]).await;
        let asked = ask(t, base, &comps[..i], &mut dir, &mut held, create, |d| {
            let name = name.clone();
            async move { t.dir_in(&d, &name, create).await }
        }).await;
        dir = match asked {
            Ok(d)       => d,
            Err(fault)  => return Err(Lost { name, fault }),
        };
        held = false;
        t.dirs(|c| c.put(key(&base.scope, &comps[..i + 1]), dir.clone()));
    }
    Ok((dir, held))
}

/// The folder holding the leaf of `comps` (see [`folder`]), the leaf's stored name, and whether
/// the folder is a held one.
pub async fn parent<T: Tree>(t: &T, base: &Base<T::Dir>, comps: &[String], create: bool)
    -> Result<(T::Dir, String, bool), Lost<T::Fault>>
{
    let (last, up) = comps.split_last()
        .map(|(l, u)| (l.as_str(), u))
        .unwrap_or(("", &[]));
    let (dir, held) = match folder(t, base, up, create).await {
        Ok(v)   => v,
        Err(l)  => return Err(l),
    };
    let leaf = t.spell(&dir, last).await;
    Ok((dir, leaf, held))
}

/// The file at `comps`: the held handle unless `again`, else looked up (created when `create`)
/// and held.  Says whether the handle is a held one.
pub async fn file_at<T: Tree>(t: &T, base: &Base<T::Dir>, comps: &[String], create: bool, again: bool)
    -> Result<(T::File, bool), Lost<T::Fault>>
{
    let k = key(&base.scope, comps);
    if !again {
        if let Some(h) = t.files(|c| c.get(&k)) {
            return Ok((h, true));
        }
    }
    let (mut dir, leaf, mut held) = match parent(t, base, comps, create).await {
        Ok(v)   => v,
        Err(l)  => return Err(l),
    };
    let up = &comps[..comps.len().saturating_sub(1)];
    let asked = ask(t, base, up, &mut dir, &mut held, create, |d| {
        let leaf = leaf.clone();
        async move { t.file_in(&d, &leaf, create).await }
    }).await;
    match asked {
        Ok(f)       => {
            t.files(|c| c.put(k, f.clone()));
            Ok((f, false))
        },
        Err(fault)  => Err(Lost { name: leaf, fault }),
    }
}

/// Run `op` on the file at `comps` through its held handle; where that answers stale, the handle
/// is forgotten and `op` runs once more through one looked up again, whose answer stands.
pub async fn with_file<T, R, F, Fut>(t: &T, base: &Base<T::Dir>, comps: &[String], op: F)
    -> Result<R, Lost<T::Fault>>
where
    T:      Tree,
    F:      Fn(T::File) -> Fut,
    Fut:    std::future::Future<Output = Result<R, T::Fault>>,
{
    let leaf = || comps.last().cloned().unwrap_or_default();
    let (h, held) = match file_at(t, base, comps, false, false).await {
        Ok(v)   => v,
        Err(l)  => return Err(l),
    };
    match op(h).await {
        Ok(v)                           => return Ok(v),
        Err(e) if !(held && t.stale(&e))=> return Err(Lost { name: leaf(), fault: e }),
        Err(_)                          => {},
    }
    t.files(|c| c.forget(&key(&base.scope, comps)));
    let (h, _) = match file_at(t, base, comps, false, true).await {
        Ok(v)   => v,
        Err(l)  => return Err(l),
    };
    op(h).await.map_err(|fault| Lost { name: leaf(), fault })
}


#[cfg(test)]
mod tests {
    use super::*;

    fn k(scope: &str, path: &str) -> String {
        let comps: Vec<&str> = path.split('/').filter(|c| !c.is_empty()).collect();
        key(scope, &comps)
    }

    #[test]
    fn the_same_handle_comes_back_for_the_same_path() {
        let mut c: HandleCache<u32> = HandleCache::new(8);
        c.put(k("s", "book/c01.typ"), 7);
        assert_eq!(c.get(&k("s", "book/c01.typ")), Some(7));
        assert_eq!(c.get(&k("s", "book/c02.typ")), None);
        // Another scope is another root, so the same path is another entry.
        assert_eq!(c.get(&k("f1", "book/c01.typ")), None);
    }

    #[test]
    fn past_the_cap_the_least_recently_used_goes() {
        let mut c: HandleCache<u32> = HandleCache::new(3);
        c.put(k("s", "a"), 1);
        c.put(k("s", "b"), 2);
        c.put(k("s", "c"), 3);
        assert_eq!(c.get(&k("s", "a")), Some(1));     // `a` used last; `b` is now oldest
        c.put(k("s", "d"), 4);
        assert_eq!(c.len(), 3);
        assert_eq!(c.get(&k("s", "b")), None);
        assert_eq!(c.get(&k("s", "a")), Some(1));
        assert_eq!(c.get(&k("s", "d")), Some(4));
    }

    #[test]
    fn the_bound_holds_however_many_paths_are_put() {
        let mut c: HandleCache<u32> = HandleCache::new(16);
        for i in 0..1000 {
            c.put(k("s", &format!("d/{}", i)), i);
            assert!(c.len() <= 16);
        }
        assert_eq!(c.get(&k("s", "d/999")), Some(999));
    }

    #[test]
    fn forgetting_a_folder_forgets_what_is_below_it_and_nothing_beside_it() {
        let mut c: HandleCache<u32> = HandleCache::new(32);
        for p in ["a", "a/b", "a/b/c.txt", "ab", "ab/x", "a.txt", "b/a"] {
            c.put(k("s", p), 1);
        }
        c.put(k("f1", "a/b"), 1);
        c.forget_under(&k("s", "a"));
        for gone in ["a", "a/b", "a/b/c.txt"] {
            assert_eq!(c.get(&k("s", gone)), None, "{} should be forgotten", gone);
        }
        for kept in ["ab", "ab/x", "a.txt", "b/a"] {
            assert_eq!(c.get(&k("s", kept)), Some(1), "{} should be kept", kept);
        }
        assert_eq!(c.get(&k("f1", "a/b")), Some(1), "another scope is untouched");
    }

    #[test]
    fn forgetting_a_scope_root_forgets_the_scope() {
        let mut c: HandleCache<u32> = HandleCache::new(32);
        c.put(k("s", "a/b"), 1);
        c.put(k("s", "c"), 1);
        c.put(k("sx", "c"), 1);
        c.forget_under(&k("s", ""));
        assert_eq!(c.get(&k("s", "a/b")), None);
        assert_eq!(c.get(&k("s", "c")), None);
        assert_eq!(c.get(&k("sx", "c")), Some(1), "a scope sharing a prefix is untouched");
    }

    #[test]
    fn a_closed_folder_takes_its_scopes_with_it() {
        let mut c: HandleCache<u32> = HandleCache::new(32);
        c.put(k("f1", "a"), 1);
        c.put(k("f2", "a"), 1);
        c.put(k("s", "a"), 1);
        c.forget_scopes("f");
        assert_eq!(c.len(), 1);
        assert_eq!(c.get(&k("s", "a")), Some(1));
        c.clear();
        assert!(c.is_empty());
    }

    // ── The walk, over a model filesystem ───────────────────────────────────
    //
    // The model ties a handle to its entry, as the strictest browser does: a handle works only
    // while the entry it was minted for stands.  Every handle handed out counts as minted.

    use std::cell::Cell;
    use std::cell::RefCell;
    use std::future::Future;
    use std::sync::Arc;
    use std::task::Context;
    use std::task::Poll;
    use std::task::Wake;

    #[derive(Clone, Debug, PartialEq)]
    struct H {
        path:   String,
        made:   u64,    // the entry's generation
    }

    struct Model {
        nodes:  RefCell<BTreeMap<String, (bool, u64)>>,	// path -> (is a folder, generation)
        next:   Cell<u64>,
        mints:  Cell<u32>,
        dirs:   RefCell<HandleCache<H>>,
        files:  RefCell<HandleCache<H>>,
    }

    const GONE: &str = "NotFoundError";
    const KIND: &str = "TypeMismatchError";

    impl Model {
        fn new() -> Self {
            let m = Self {
                nodes:  RefCell::new(BTreeMap::new()),
                next:   Cell::new(1),
                mints:  Cell::new(0),
                dirs:   RefCell::new(HandleCache::new(64)),
                files:  RefCell::new(HandleCache::new(64)),
            };
            m.make("", true);
            m
        }
        fn make(&self, path: &str, dir: bool) {
            let g = self.next.get();
            self.next.set(g + 1);
            self.nodes.borrow_mut().insert(path.to_string(), (dir, g));
        }
        fn remove(&self, path: &str) {
            let below = fmt_below(path);
            self.nodes.borrow_mut().retain(|k, _| k != path && !k.starts_with(&below));
        }
        fn live(&self, h: &H) -> bool {
            self.nodes.borrow().get(&h.path).map(|(_, g)| *g) == Some(h.made)
        }
        fn mint(&self, path: String, made: u64) -> H {
            self.mints.set(self.mints.get() + 1);
            H { path, made }
        }
        fn child(&self, d: &H, name: &str, want_dir: bool, create: bool) -> Result<H, &'static str> {
            if !self.live(d) {
                return Err(GONE);
            }
            let p = match d.path.is_empty() {
                true  => name.to_string(),
                false => format!("{}/{}", d.path, name),
            };
            let at = self.nodes.borrow().get(&p).copied();
            match at {
                Some((dir, g)) if dir == want_dir   => Ok(self.mint(p, g)),
                Some(_)                             => Err(KIND),
                None if create                      => {
                    self.make(&p, want_dir);
                    let g = self.next.get() - 1;
                    Ok(self.mint(p, g))
                },
                None                                => Err(GONE),
            }
        }
        fn base(&self, root: &H, held: bool) -> Base<H> {
            Base { dir: root.clone(), scope: "s".to_string(), held }
        }
    }

    fn fmt_below(path: &str) -> String {
        let mut b = path.to_string();
        b.push('/');
        b
    }

    impl Tree for Model {
        type Dir = H;
        type File = H;
        type Fault = &'static str;

        fn dirs<R>(&self, f: impl FnOnce(&mut HandleCache<H>) -> R) -> R {
            f(&mut self.dirs.borrow_mut())
        }
        fn files<R>(&self, f: impl FnOnce(&mut HandleCache<H>) -> R) -> R {
            f(&mut self.files.borrow_mut())
        }
        fn stale(&self, e: &&'static str) -> bool {
            *e == GONE
        }
        async fn spell(&self, _dir: &H, name: &str) -> String {
            name.to_string()
        }
        async fn dir_in(&self, dir: &H, name: &str, create: bool) -> Result<H, &'static str> {
            self.child(dir, name, true, create)
        }
        async fn file_in(&self, dir: &H, name: &str, create: bool) -> Result<H, &'static str> {
            self.child(dir, name, false, create)
        }
        async fn same(&self, a: &H, b: &H) -> bool {
            a == b
        }
        async fn root_again(&self, _scope: &str) -> Result<H, &'static str> {
            let g = self.nodes.borrow().get("").map(|(_, g)| *g);
            match g {
                Some(g) => Ok(self.mint(String::new(), g)),
                None    => Err(GONE),
            }
        }
    }

    fn block_on<F: Future>(f: F) -> F::Output {
        struct Nop;
        impl Wake for Nop {
            fn wake(self: Arc<Self>) {}
        }
        let waker = Arc::new(Nop).into();
        let mut cx = Context::from_waker(&waker);
        let mut f = std::pin::pin!(f);
        loop {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    fn comps(path: &str) -> Vec<String> {
        path.split('/').map(|c| c.to_string()).collect()
    }

    /// `exists()`'s file question: the leaf asked of its folder.
    fn ask_leaf(m: &Model, base: &Base<H>, path: &str) -> Result<H, &'static str> {
        let c = comps(path);
        block_on(async {
            let (mut dir, leaf, mut held) = match parent(m, base, &c, false).await {
                Ok(v)   => v,
                Err(l)  => return Err(l.fault),
            };
            ask(m, base, &c[..c.len() - 1], &mut dir, &mut held, false, |d| {
                let leaf = leaf.clone();
                async move { m.file_in(&d, &leaf, false).await }
            }).await
        })
    }

    /// The watch's stamp of a file, through its held handle.
    fn stamp(m: &Model, base: &Base<H>, path: &str) -> Result<u64, &'static str> {
        let c = comps(path);
        block_on(with_file(m, base, &c, |h| async move {
            match m.live(&h) {
                true  => Ok(h.made),
                false => Err(GONE),
            }
        })).map_err(|l| l.fault)
    }

    fn held_dir(m: &Model, path: &str) -> Option<H> {
        m.dirs.borrow_mut().get(&key("s", &comps(path)))
    }

    fn book(m: &Model) {
        m.make("a", true);
        m.make("a/b", true);
        m.make("a/b/w.typ", false);
    }

    #[test]
    fn an_exists_miss_mints_at_most_one_handle_and_keeps_the_folders() {
        for root_held in [false, true] {
            let m = Model::new();
            book(&m);
            let root = block_on(m.root_again("s")).unwrap_or(H { path: String::new(), made: 0 });
            let base = m.base(&root, root_held);
            assert!(ask_leaf(&m, &base, "a/b/w.typ").is_ok());
            let (a, b) = (held_dir(&m, "a"), held_dir(&m, "a/b"));
            assert!(a.is_some() && b.is_some());
            for _ in 0..5 {
                let before = m.mints.get();
                assert_eq!(ask_leaf(&m, &base, "a/b/missing.typ"), Err(GONE));
                assert!(m.mints.get() - before <= 1, "an exists() miss minted {}", m.mints.get() - before);
            }
            // A miss at the root's own level asks only for the root again, where it is held.
            for _ in 0..3 {
                let before = m.mints.get();
                assert_eq!(ask_leaf(&m, &base, "missing.typ"), Err(GONE));
                assert!(m.mints.get() - before <= 1);
            }
            assert_eq!(held_dir(&m, "a"), a, "a live ancestor is kept");
            assert_eq!(held_dir(&m, "a/b"), b, "a live ancestor is kept");
        }
    }

    #[test]
    fn a_deleted_watched_file_mints_at_most_one_handle_per_poll() {
        let m = Model::new();
        book(&m);
        let root = H { path: String::new(), made: 1 };
        let base = m.base(&root, false);
        assert!(stamp(&m, &base, "a/b/w.typ").is_ok());
        let before = m.mints.get();
        assert!(stamp(&m, &base, "a/b/w.typ").is_ok());
        assert_eq!(m.mints.get(), before, "a held file is polled with no new handle");
        let (a, b) = (held_dir(&m, "a"), held_dir(&m, "a/b"));
        m.remove("a/b/w.typ");
        for _ in 0..5 {
            let before = m.mints.get();
            assert_eq!(stamp(&m, &base, "a/b/w.typ"), Err(GONE));
            assert!(m.mints.get() - before <= 1, "a deleted watched file minted {}", m.mints.get() - before);
        }
        assert_eq!(held_dir(&m, "a"), a);
        assert_eq!(held_dir(&m, "a/b"), b);
        // Written again: found again, and held again.
        m.make("a/b/w.typ", false);
        assert!(stamp(&m, &base, "a/b/w.typ").is_ok());
        let before = m.mints.get();
        assert!(stamp(&m, &base, "a/b/w.typ").is_ok());
        assert_eq!(m.mints.get(), before);
    }

    #[test]
    fn a_folder_made_again_is_found_from_its_parent_and_what_was_below_it_forgotten() {
        let m = Model::new();
        book(&m);
        m.make("a/b/c", true);
        m.make("a/b/c/x.typ", false);
        let root = H { path: String::new(), made: 1 };
        let base = m.base(&root, false);
        assert!(stamp(&m, &base, "a/b/c/x.typ").is_ok());
        let a = held_dir(&m, "a");
        m.remove("a/b");
        m.make("a/b", true);
        m.make("a/b/c", true);
        m.make("a/b/c/x.typ", false);
        assert!(stamp(&m, &base, "a/b/c/x.typ").is_ok(), "the new entries are found");
        assert_eq!(held_dir(&m, "a"), a, "the live parent is kept");
        let b = held_dir(&m, "a/b");
        assert!(b.as_ref().map(|h| m.live(h)) == Some(true), "the old folder's handle is replaced");
        assert!(held_dir(&m, "a/b/c").as_ref().map(|h| m.live(h)) == Some(true));
        // And a folder removed for good fails, and is no longer held.
        m.remove("a/b");
        assert_eq!(stamp(&m, &base, "a/b/c/x.typ"), Err(GONE));
        assert_eq!(held_dir(&m, "a/b"), None);
        assert_eq!(held_dir(&m, "a/b/c"), None);
        assert_eq!(held_dir(&m, "a"), a);
    }

    #[test]
    fn a_held_root_made_again_is_asked_for_again() {
        let m = Model::new();
        book(&m);
        let old = H { path: String::new(), made: 1 };
        assert!(stamp(&m, &m.base(&old, true), "a/b/w.typ").is_ok());
        m.remove("");
        m.make("", true);
        book(&m);
        let r = stamp(&m, &m.base(&old, true), "a/b/w.typ");
        assert!(r.is_ok(), "{:?}", r);
    }

}
