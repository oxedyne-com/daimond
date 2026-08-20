// fenceprobe — ask the fence what it actually permits, from inside it.
//
// Written on 2026-08-20 to settle an argument. A daimon reported that a git repository did
// not exist; the tree it was looking at was missing `.git`, `.gitignore`, `.claude` and
// `target`, and the fence was the obvious suspect. It was not: this probe plans the real
// fence over the real workspace, applies it, and lists the directory from inside, and every
// entry was present and stat-able. The cause was elsewhere — the browser was open on a
// second machine whose copy of the tree is made by Syncthing, and `.stignore` there holds
// `target` and `.*`.
//
// It is kept because the question recurs and reasoning about Landlock is unreliable: an
// allow-list with no deny rules and union semantics up the tree does not behave the way
// reading it suggests. Measure instead.
//
//   cargo run --release --example fenceprobe --manifest-path hand/Cargo.toml
//
// Edit the spec below to ask about a different workspace.
// Apply the fence a chat with ~/usr/code attached gets, then list the daimond
// directory from inside it. Whatever is missing here, the fence is why.
use daimond_hand::fence::{Fence, Unfenced};
use daimond_hand::wire::FenceSpec;

fn names(tag: &str) {
    let d = "/home/jason/usr/code/web/apps/oxedyne/daimond";
    match std::fs::read_dir(d) {
        Ok(it) => {
            let mut v: Vec<String> = it.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            v.sort();
            println!("{}: {} entries: {}", tag, v.len(), v.join(" "));
        },
        Err(e) => println!("{}: read_dir failed: {}", tag, e),
    }
    for p in [".git", ".gitignore", ".claude", "target", "src"] {
        let full = format!("{}/{}", d, p);
        println!("   {:12} stat={}", p, std::fs::metadata(&full).is_ok());
    }
}

fn main() {
    names("BEFORE");
    let spec = FenceSpec {
        rw:   vec!["/home/jason/usr/code".to_string()],
        ro:   vec![],
        deny: vec![],
        net:  false,
    };
    let f = Fence::detect();
    let p = match f.plan(&spec, &Unfenced::Refuse) {
        Ok(p) => p,
        Err(e) => { println!("plan failed: {}", e); return; },
    };
    match p.apply() {
        Ok(_) => println!("--- fence applied ---"),
        Err(e) => { println!("apply failed: {}", e); return; },
    }
    names("AFTER");
}
