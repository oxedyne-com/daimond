//! The engine ABI (OWNKEY §5): the contract the page's wasm and a runner built from the same tree
//! speak to each other.  One source for both, so the two carry the same numbers by construction.
//!
//! A peer is offered when `peer.abi ≥ own.min ∧ own.abi ≥ peer.min` (§5.2).  `ENGINE_ABI` rises
//! when the errand, report, session seal or store records, or the turn semantics both sides share,
//! gain or change a field one side relies on; `ENGINE_ABI_MIN` rises only when a side drops an
//! older peer.  The pin over the shared golden vectors (`abi_pin.txt`, kimberlite's
//! `errands::abi_pin_tests`) fails any vector change made without a bump.

pub const ENGINE_ABI: u32 = 1;      // the contract this build speaks
pub const ENGINE_ABI_MIN: u32 = 1;  // the oldest peer contract it still accepts

/// Does a peer speaking `abi`, accepting nothing older than `min`, work with this build?
pub fn peer_ok(abi: u32, min: u32) -> bool {
    abi >= ENGINE_ABI_MIN && ENGINE_ABI >= min
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_abi_range_is_two_sided() {
        assert!(ENGINE_ABI_MIN >= 1 && ENGINE_ABI >= ENGINE_ABI_MIN, "ABI {} below its own min {}",
            ENGINE_ABI, ENGINE_ABI_MIN);
        assert!(peer_ok(ENGINE_ABI, ENGINE_ABI_MIN), "a build must accept itself");
        assert!(!peer_ok(ENGINE_ABI_MIN - 1, ENGINE_ABI_MIN), "a peer below the min is offered");
        assert!(!peer_ok(ENGINE_ABI, ENGINE_ABI + 1), "a peer needing a newer build is offered");
    }
}
