//! The engine ABI (OWNKEY §5): the contract the page's wasm and a runner built from the same tree
//! speak to each other.  One source for both, so the two carry the same numbers by construction.
//!
//! A peer is offered when `peer.abi ≥ own.min ∧ own.abi ≥ peer.min` (§5.2).  `ENGINE_ABI` rises
//! when the errand, report, session seal or store records, or the turn semantics both sides share,
//! gain or change a field one side relies on; `ENGINE_ABI_MIN` rises only when a side drops an
//! older peer.  The pin over the shared golden vectors (`abi_pin.txt`, kimberlite's
//! `errands::abi_pin_tests`) fails any vector change made without a bump.

// 1: the errand as of runnerweb-rb, KT-2 `limits`, OWNKEY `keys` and `abi`.
// 2: + the report's `alerts` (KT-5d) and `words`, the seed's and the ask's `words` (U2); min stays
//    1, as each is optional and an ABI-1 peer reads the rest as before.
pub const ENGINE_ABI: u32 = 2;      // the contract this build speaks
pub const ENGINE_ABI_MIN: u32 = 1;  // the oldest peer contract it still accepts
pub const WORDS_ABI: u32 = 2;       // the first page to file the words a runner stages home (U2)

/// Does a peer speaking `abi`, accepting nothing older than `min`, work with this build?
pub fn peer_ok(abi: u32, min: u32) -> bool {
    abi >= ENGINE_ABI_MIN && ENGINE_ABI >= min
}

#[cfg(test)]
#[path = "../../tests/unit/engine/abi/tests.rs"]
mod tests;
