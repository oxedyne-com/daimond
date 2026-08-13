# Typst packages, carried in the bundle

`#import "@preview/cetz:0.3.4"` names a package in Typst Universe. The command-line
compiler downloads it and caches it under `~/.cache/typst/packages`; the compiler in
this page has no network at all, so until now every document with a live cetz diagram
was refused outright — including the author's own 281-page book, whose template opens
with that exact line.

These packs are how that is answered. Five packages ship inside the app, as sealed
files, and `src/wasm/typst.rs` hands their sources to the compiler as ordinary files.

| pack | files | bytes | why it is here |
|---|---|---|---|
| `preview/cetz/0.3.4.pack` | 38 | 289,319 | the book imports it |
| `preview/oxifmt/0.2.1.pack` | 3 | 21,812 | cetz 0.3.4 and 0.3.2 both import it |
| `preview/cetz/0.3.2.pack` | 38 | 287,832 | **cetz-plot 0.1.1 imports this version, not 0.3.4** |
| `preview/cetz-plot/0.1.1.pack` | 27 | 184,702 | charts and plots on top of cetz |
| `preview/fletcher/0.5.7.pack` | 13 | 143,367 | arrow diagrams; imports cetz 0.3.4 |

927 KB in total, fetched only when a document actually imports one. A session that
typesets nothing, or typesets a document with no packages in it, pays nothing.

## Why not `www/vendor/`

Because `www/vendor/` is gitignored, excluded from the public mirror by
`dev/publish.mjs`, and excluded from the bundle fingerprint by `verify/lib.mjs`. A
live view was once shipped with no renderer behind it for exactly that reason. These
files are under `www/assets/`, which is committed, crosses to the mirror, is cached by
the service worker as part of the shell, and **is inside `www/manifest.json` and the
transparency chain**. What compiled the book is provably what shipped.

## Why the whole closure and not the named package

cetz 0.3.4's `src/deps.typ` is one line: `#import "@preview/oxifmt:0.2.1"`. Ship cetz
without oxifmt and the import resolves, then fails — and *a package that resolves while
its dependency does not is indistinguishable from one that never resolved*. The same
trap caught the first run of `dev/probe_typstpkg.mjs`.

So the closure is walked, not assumed:

- `refresh.sh` carries the set a human chose. It is a **wish list, not a closure.**
- `src/wasm/typst.rs` derives the closure at compile time from the package **sources
  themselves** — it reads each pack's `.typ` files and follows every `@…` import it
  finds, recursively. A dependency cannot be silently absent, because nothing consults
  a hand-written list of dependencies.
- A dependency that is not carried produces its **own** refusal, in different words
  from an unavailable package, saying that the document is not at fault.

`cetz-plot` is why this matters in practice: its `src/cetz.typ` imports
`@preview/cetz:0.3.2`, not the 0.3.4 the book uses. cetz is therefore vendored twice.
Nobody would have guessed that from the package's name or its version number.

## The pack format

One file per package, so one HTTP request loads one package and the service worker
caches it whole.

```
DAIMOND TYPST PACK 1
namespace preview
name cetz
version 0.3.4
entrypoint src/lib.typ
file 7651 LICENSE
file 1953 src/aabb.typ
…
<one blank line>
<the file bodies, concatenated, in the order listed>
```

ASCII header, blank line, raw bytes. Lengths rather than delimiters, so a source
containing anything at all cannot end a file early. `packs/INDEX` lists every pack with
its file count and its byte length, and `src/wasm/typst.rs` **`include_str!`s that
INDEX** — so the wasm knows what this build carries without asking the network, and a
pack that does not match its INDEX line is reported as a broken deployment rather than
as a missing package.

## Refreshing

```bash
bash www/assets/typst/refresh.sh          # from ~/.cache/typst/packages
```

Nothing is downloaded: the local typst package cache is read, and a package that is not
in it stops the script rather than producing a set with a hole in it. The script is
served alongside what it produced, so the recipe is inside the same seal as the result.

**`packs/INDEX` is compiled into the wasm.** After a refresh the wasm must be rebuilt
and the bundle resealed, or the wasm and the served packs describe different sets.

## What is taken, and what is left

Sources (`*.typ`), the `typst.toml` that names the entrypoint, and the licence. Not the
README, not the galleries, not the built PDFs — none of them is read by a compile and
together they are most of what a package directory weighs. The licences ship because
this is other people's LGPL and MIT work travelling inside our bundle.

## The accepted cost

A document that asks for a version not carried here still fails. It fails with a
sentence that says which versions *are* carried and that the fix is to vendor another
one — but it fails. That was the deliberate choice: the alternative is fetching from a
registry at compile time, which would make "this compiler runs inside the page with no
network at all" false, and would put outside the seal the one thing the whole
verification story rests on.
