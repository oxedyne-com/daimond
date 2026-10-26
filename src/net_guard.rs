//! One address check for every outbound request made because a remote party named the place
//! (R3 QA-a F1, QA-b F1): resolve the name once, refuse it where any address it resolves to is
//! loopback, the LAN, link-local or metadata, documentation, benchmark, multicast or reserved
//! space, any IPv6 form carrying one of those, or one of this machine's own networks, and connect
//! only to an address that passed.  The runner's command proxy (`kimberlite/src/egress.rs`) and
//! [`crate::llm::LlmClient::fetch_linked`] both judge with it, so the two cannot drift.

use oxedyne_fe2o3_core::prelude::*;

use std::net::{
    IpAddr,
    Ipv4Addr,
    Ipv6Addr,
    SocketAddr,
};

/// Why `ip` is refused, or `None` if it is public.  An IPv6 address carrying an IPv4 one
/// (v4-mapped, v4-compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) is judged as the IPv4
/// address inside it.
pub fn refused(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4)  => refused_v4(v4),
        IpAddr::V6(v6)  => refused_v6(v6),
    }
}

fn refused_v4(ip: Ipv4Addr) -> Option<&'static str> {
    const RANGES: &[([u8; 4], u32, &str)] = &[
        ([0, 0, 0, 0],          8,  "the unspecified \"this network\" range"),
        ([10, 0, 0, 0],         8,  "a private LAN address"),
        ([100, 64, 0, 0],       10, "a carrier-grade NAT address"),
        ([127, 0, 0, 0],        8,  "this machine's own loopback"),
        ([169, 254, 0, 0],      16, "a link-local address (cloud metadata lives here)"),
        ([172, 16, 0, 0],       12, "a private LAN address"),
        ([192, 0, 0, 0],        24, "reserved protocol space"),
        ([192, 0, 2, 0],        24, "a documentation address"),
        ([192, 168, 0, 0],      16, "a private LAN address"),
        ([198, 18, 0, 0],       15, "a benchmarking address"),
        ([198, 51, 100, 0],     24, "a documentation address"),
        ([203, 0, 113, 0],      24, "a documentation address"),
        ([224, 0, 0, 0],        4,  "a multicast address"),
        ([240, 0, 0, 0],        4,  "reserved space or broadcast"),
    ];
    let a = u32::from(ip);
    for (net, len, why) in RANGES {
        let mask = u32::MAX << (32 - len);
        if a & mask == u32::from_be_bytes(*net) & mask {
            return Some(why);
        }
    }
    None
}

fn refused_v6(ip: Ipv6Addr) -> Option<&'static str> {
    let s = ip.segments();
    if ip.is_unspecified() {
        return Some("the unspecified address");
    }
    if ip.is_loopback() {
        return Some("this machine's own loopback");
    }
    if let Some(v4) = inner_v4(ip) {
        return refused_v4(v4);
    }
    match s[0] {
        x if x & 0xfe00 == 0xfc00   => Some("a private (unique local) address"),
        x if x & 0xffc0 == 0xfe80   => Some("a link-local address"),
        x if x & 0xff00 == 0xff00   => Some("a multicast address"),
        0x2001 if s[1] == 0x0db8    => Some("a documentation address"),
        0x0064 if s[1] == 0xff9b && s[2] == 0x0001
                                    => Some("a local-use NAT64 address"),
        _                           => None,
    }
}

/// A network one of this machine's own interfaces sits on.  Nothing a remote party names is
/// reached on it, as nothing on the LAN is (QA-S1 M1): with a global IPv6 prefix, every LAN device's SLAAC
/// address and the machine's own `[::]` services pass the range check, so they are refused
/// here instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Net {
    pub addr:   IpAddr, // An address on it: for IPv6, the machine's own
    pub len:    u8,     // Its prefix length
}

/// What a remote party's address is judged against: this machine's own networks, read by the
/// caller, and the destinations a test's configuration names public (a loopback test server,
/// never filled in a release build).
#[derive(Clone, Debug, Default)]
pub struct Guard {
    pub nets:   Vec<Net>,
    pub public: Vec<(String, u16)>,
}

impl Guard {
    /// Is `host:port` one a test's configuration names public?
    pub fn is_public(&self, host: &str, port: u16) -> bool {
        self.public.iter().any(|(h, p)| *p == port && h.eq_ignore_ascii_case(host))
    }

    /// The addresses `host:port` may be reached at, every one judged: the name is resolved once
    /// and refused in words where any address it resolves to is not public.  A name a test makes
    /// public is its loopback test server.
    pub async fn judge(&self, host: &str, port: u16) -> Outcome<Vec<SocketAddr>> {
        let test_public = self.is_public(host, port);
        let addrs: Vec<SocketAddr> = match host.parse::<IpAddr>() {
            Ok(ip)                  => vec![SocketAddr::new(ip, port)],
            Err(_) if test_public   => vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)],
            Err(_)                  => match tokio::net::lookup_host((host, port)).await {
                Ok(a)   => a.collect(),
                Err(_)  => Vec::new(),
            },
        };
        if addrs.is_empty() {
            return Err(err!("{} did not resolve to any address, so nothing was fetched.", host;
                Network, Missing));
        }
        if !test_public {
            for a in &addrs {
                if let Some(why) = refused(a.ip()).or_else(|| on_nets(a.ip(), &self.nets)) {
                    return Err(err!("{} is {} ({}), which Daimond does not reach on a remote \
                        party's word, so nothing was fetched.", host, why, a.ip(); Network, Security));
                }
            }
        }
        Ok(addrs)
    }
}

/// Why `ip` lies on one of `nets`, this machine's own networks, or `None`.  An IPv6 form
/// carrying an IPv4 address is judged by the address inside.
pub fn on_nets(ip: IpAddr, nets: &[Net]) -> Option<&'static str> {
    let ip = match ip {
        IpAddr::V6(v6)  => inner_v4(v6).map(IpAddr::V4).unwrap_or(ip),
        IpAddr::V4(_)   => ip,
    };
    let on = nets.iter().any(|n| match (ip, n.addr) {
        (IpAddr::V4(a), IpAddr::V4(b))  => same_prefix(u32::from(a).into(), u32::from(b).into(),
                                            n.len, 32),
        (IpAddr::V6(a), IpAddr::V6(b))  => same_prefix(a.into(), b.into(), n.len, 128),
        _                               => false,
    });
    if on { Some("on one of this machine's own networks") } else { None }
}

/// Do `a` and `b`, of `bits` bits each, share their first `len` bits?  A zero-length prefix
/// matches nothing, so a stray default route never refuses the internet.
fn same_prefix(a: u128, b: u128, len: u8, bits: u32) -> bool {
    let len = u32::from(len).min(bits);
    if len == 0 {
        return false;
    }
    (a >> (bits - len)) == (b >> (bits - len))
}

/// The IPv4 address an IPv6 one carries, in any of the forms a stack will route as IPv4.
pub fn inner_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = ip.segments();
    let low = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    match s {
        [0, 0, 0, 0, 0, 0xffff, _, _]       => Some(low),   // v4-mapped
        [0, 0, 0, 0, 0, 0, _, _]            => Some(low),   // v4-compatible
        [0x64, 0xff9b, 0, 0, 0, 0, _, _]    => Some(low),   // NAT64
        [0x2002, a, b, ..]                  => Some(Ipv4Addr::new(  // 6to4
            (a >> 8) as u8, a as u8, (b >> 8) as u8, b as u8)),
        _                                   => None,
    }
}
