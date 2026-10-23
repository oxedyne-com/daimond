//! The store link between processes: a run's child reaches the store over a pipe (spec §16.1, R1b).
//!
//! [`PipeLink`] is a [`StoreLink`] over any tokio `AsyncRead`/`AsyncWrite` pair, and
//! [`serve_pipe`] is its other end, which hands each call to a bound run's [`LoopLink`].  It is
//! transport only: every frame it carries is the frame a [`LoopLink`] carries in process, the
//! call encoded by [`encode_call`] and the reply as the store thread encoded it, so the store
//! answers as it does in process.  Bodies cross over the body channel exactly as the
//! [`RemoteStore`](super::remote::RemoteStore) above it sends them (§16.3a); no frame is ever
//! over [`FRAME_MAX`].
//!
//! - **A message is two frames** of `fe2o3_jdat::pipe`: the call's id, eight bytes big-endian,
//!   then the call or reply frame itself.  The pipe's ceiling is [`FRAME_MAX`], so a peer's
//!   header declaring more is refused before a byte of its body is read or a buffer sized.
//! - **Replies come in any order**, matched to their calls by id, so a wait call parked on a
//!   lock never holds up a sync call behind it.  Id 0 is a notification, which is not answered.
//! - **The pipe's I/O runs on a thread of its own**, with its own executor, so
//!   [`call_blocking`](PipeLink::call_blocking) may block any thread, an executor's included.
//! - **A pipe that fails or ends fails every call it owes, and every later one,** with the store's
//!   typed transport error, [`StoreDown`] (`is_store_down`), naming the pipe's fault
//!   (`pipe.too-big`, `pipe.truncated`, …).  Nothing panics, and no other link is touched.
//! - **A relayed message** (R1d, spec §16.1) is the parent's, on the store's own pipe: its id frame
//!   carries the id, then an op byte ([`OP_CALL`], [`OP_BIND`], [`OP_DROP`]) and the door's name.
//!   [`serve_relay`] binds each door under the [`Tag`] and [`RunEnv`] the parent sent at spawn, and
//!   hands each call through that door's [`LoopLink`], so the store's binding check judges it.  A
//!   plain eight-byte id is the parent's own call.  A child's pipe ([`read_one`]) takes plain ids
//!   alone: a child cannot name a door, so it cannot speak for another run.
use crate::store::{
    call::{decode_call, decode_reply, encode_call, encode_reply, Fault, StoreCall, StoreDown,
        StoreReply, Unbound, FRAME_MAX},
    remote::StoreLink,
    run::RunEnv,
    server::{LoopLink, StoreServer, Tag},
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::pipe::{FrameReader, FrameWriter};

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        Mutex,
        MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};

use tokio::io::{AsyncRead, AsyncWrite};


/// The pipe's ceiling: no frame either way is larger than the store's own.
pub const PIPE_MAX: usize = FRAME_MAX;

/// The id of a call sent with no wait for its answer.
const NO_REPLY: u64 = 0;

/// The bytes of a call's id frame.
const ID_LEN: usize = 8;

/// A relayed message's op, the byte after its id: a call through the door.
pub const OP_CALL: u8 = 1;
/// A relayed message's op: bind the door, under the tag and environment its frame carries.
pub const OP_BIND: u8 = 2;
/// A relayed message's op: drop the door, ending its run's calls on the store.
pub const OP_DROP: u8 = 3;

/// A message's id frame: its id, and for a relayed message its op and the door it goes through.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Head {
    pub id:     u64,
    pub door:   Option<(u8, String)>,
}

impl Head {
    fn bytes(id: u64, door: Option<(u8, &str)>) -> Vec<u8> {
        let mut h = id.to_be_bytes().to_vec();
        if let Some((op, name)) = door {
            h.push(op);
            h.extend_from_slice(name.as_bytes());
        }
        h
    }

    fn parse(head: &[u8]) -> Outcome<Self> {
        let id = match head.get(..ID_LEN).map(<[u8; ID_LEN]>::try_from) {
            Some(Ok(b)) => u64::from_be_bytes(b),
            _           => return Err(err!(
                "A store pipe message began with a {}-byte frame where its {}-byte id belongs.",
                head.len(), ID_LEN; Decode, Wire)),
        };
        let (op, name) = match (head.get(ID_LEN), head.get(ID_LEN + 1..)) {
            (None, _)                   => return Ok(Self { id, door: None }),
            (Some(op), Some(name))      => (*op, name),
            (Some(_), None)             => (0, &[][..]),
        };
        match std::str::from_utf8(name) {
            Ok(n) if !n.is_empty()  => Ok(Self { id, door: Some((op, n.to_string())) }),
            _                       => Err(err!(
                "A relayed store message {} names no door, or one that is not UTF-8.", id;
                Decode, Wire)),
        }
    }
}

/// The store's typed transport error for a pipe that failed or ended.
fn broken(why: &str) -> Error<ErrTag> {
    StoreDown { why: fmt!("the store pipe {}", why) }.to_error()
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The calls a link owes                                          │
// └───────────────────────────────────────────────────────────────┘

/// One call owed its reply.
type Owed = flume::Sender<Outcome<Vec<u8>>>;

#[derive(Default)]
struct Owing {
    calls: BTreeMap<u64, Owed>, // by id, each call sent and not yet answered
    ended: Option<String>,      // why the pipe ended; every later call is refused with it
}

#[derive(Default)]
struct Shared {
    owing:  Mutex<Owing>,
    next:   AtomicU64,  // the last id given
}

impl Shared {

    fn owing(&self) -> MutexGuard<'_, Owing> {
        match self.owing.lock() {
            Ok(g)   => g,
            Err(p)  => p.into_inner(),
        }
    }

    /// A fresh id, and the receiver its reply comes on.
    fn enter(&self) -> Outcome<(u64, flume::Receiver<Outcome<Vec<u8>>>)> {
        let mut owing = self.owing();
        if let Some(why) = &owing.ended {
            return Err(broken(why));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = flume::bounded(1);
        owing.calls.insert(id, tx);
        Ok((id, rx))
    }

    fn forget(&self, id: u64) {
        self.owing().calls.remove(&id);
    }

    /// `bytes` to the call `id`, where one is owed.  A reply nothing owes is dropped.
    fn answer(&self, id: u64, bytes: Vec<u8>) {
        if let Some(tx) = self.owing().calls.remove(&id) {
            let _ = tx.send(Ok(bytes));
        }
    }

    /// The pipe's end: every call owed is answered with its transport error, and so is every
    /// later one.
    fn end(&self, why: &str) {
        let calls = {
            let mut owing = self.owing();
            if owing.ended.is_none() {
                owing.ended = Some(why.to_string());
            }
            std::mem::take(&mut owing.calls)
        };
        for (_, tx) in calls {
            let _ = tx.send(Err(broken(why)));
        }
    }

    fn ended(&self) -> Option<String> { self.owing().ended.clone() }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The child's end                                                │
// └───────────────────────────────────────────────────────────────┘

/// One run's way to a store in another process: each call as its frame over the pipe, each reply
/// matched to it by id.  The pipe is let go when the last clone is dropped.
#[derive(Clone)]
pub struct PipeLink {
    tx:     flume::Sender<(Vec<u8>, Vec<u8>)>,  // to the pipe's writer: an id frame and its call
    shared: Arc<Shared>,
}

impl std::fmt::Debug for PipeLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PipeLink").field("ended", &self.shared.ended()).finish()
    }
}

impl Default for PipeLink {
    /// A link with no pipe: every call is refused with the transport error.
    fn default() -> Self { Self::closed() }
}

impl PipeLink {

    /// Starts the pipe's thread, where `open` is called inside its executor to give the pipe's
    /// two halves, so a stream that registers with an executor (a tokio socket) registers there.
    pub fn spawn<F, R, W>(open: F) -> Outcome<Self>
    where
        F: FnOnce() -> Outcome<(R, W)> + Send + 'static,
        R: AsyncRead + Unpin + 'static,
        W: AsyncWrite + Unpin + 'static,
    {
        let (tx, rx) = flume::unbounded::<(Vec<u8>, Vec<u8>)>();
        let shared = Arc::new(Shared::default());
        let theirs = shared.clone();
        let (ready_tx, ready_rx) = flume::bounded::<Outcome<()>>(1);
        let spawned = std::thread::Builder::new()
            .name(String::from("daimond-pipe"))
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(rt)  => rt,
                    Err(e)  => {
                        let _ = ready_tx.send(Err(err!(e,
                            "The store pipe's executor could not be built."; Init, Thread)));
                        return;
                    }
                };
                rt.block_on(async move {
                    let (r, w) = match open() {
                        Ok(p)   => p,
                        Err(e)  => {
                            let _ = ready_tx.send(Err(e));
                            return;
                        }
                    };
                    let _ = ready_tx.send(Ok(()));
                    let why = carry(r, w, rx, &theirs).await;
                    theirs.end(&why);
                });
            });
        if let Err(e) = spawned {
            return Err(err!(e, "The store pipe's thread could not be started."; Init, Thread));
        }
        match ready_rx.recv() {
            Ok(Ok(()))  => Ok(Self { tx, shared }),
            Ok(Err(e))  => Err(e),
            Err(_)      => Err(broken("ended as it opened")),
        }
    }

    /// A link over one end of a Unix socket pair, or any connected Unix socket.
    #[cfg(unix)]
    pub fn over_unix(sock: std::os::unix::net::UnixStream) -> Outcome<Self> {
        Self::spawn(move || {
            let s = res!(unix(sock));
            Ok(s.into_split())
        })
    }

    /// A link with no pipe, which refuses every call.
    pub fn closed() -> Self {
        let (tx, _) = flume::unbounded();
        let shared = Arc::new(Shared::default());
        shared.end("was never opened");
        Self { tx, shared }
    }

    /// Why the pipe ended, if it has.
    pub fn ended(&self) -> Option<String> { self.shared.ended() }

    fn send(&self, call: &StoreCall, id: u64) -> Outcome<()> {
        let frame = res!(encode_call(call));
        if frame.len() > PIPE_MAX {
            return Err(err!("A store.{} frame of {} bytes is over the pipe's {}.",
                call.name(), frame.len(), PIPE_MAX; TooBig, Wire));
        }
        if self.tx.send((Head::bytes(id, None), frame)).is_err() {
            let why = self.shared.ended().unwrap_or_else(|| String::from("has stopped"));
            return Err(broken(&why));
        }
        Ok(())
    }

    /// The call `call` sent, and the receiver its reply comes on.
    fn post(&self, call: &StoreCall) -> Outcome<(u64, flume::Receiver<Outcome<Vec<u8>>>)> {
        let (id, rx) = res!(self.shared.enter());
        if let Err(e) = self.send(call, id) {
            self.shared.forget(id);
            return Err(e);
        }
        Ok((id, rx))
    }

    fn got(call: &StoreCall, got: Result<Outcome<Vec<u8>>, flume::RecvError>)
        -> Outcome<StoreReply>
    {
        match got {
            Ok(Ok(bytes))   => decode_reply(&bytes),
            Ok(Err(e))      => Err(e),
            Err(_)          => Err(broken(&fmt!("dropped store.{} unanswered", call.name()))),
        }
    }
}

/// The parent's relay half (R1d): calls through a door, and the doors' binding.
impl PipeLink {

    /// Sends `frame` under the relayed id frame `door`, and answers its reply's receiver.
    fn post_door(&self, op: u8, door: &str, frame: Vec<u8>)
        -> Outcome<flume::Receiver<Outcome<Vec<u8>>>>
    {
        if frame.len() > PIPE_MAX {
            return Err(err!("A relayed frame of {} bytes for door '{}' is over the pipe's {}.",
                frame.len(), door, PIPE_MAX; TooBig, Wire));
        }
        let (id, rx) = res!(self.shared.enter());
        if self.tx.send((Head::bytes(id, Some((op, door))), frame)).is_err() {
            self.shared.forget(id);
            let why = self.shared.ended().unwrap_or_else(|| String::from("has stopped"));
            return Err(broken(&why));
        }
        Ok(rx)
    }

    async fn door_reply(&self, op: u8, door: &str, frame: Vec<u8>) -> Outcome<Vec<u8>> {
        let rx = res!(self.post_door(op, door, frame));
        match rx.recv_async().await {
            Ok(got) => got,
            Err(_)  => Err(broken(&fmt!("dropped door '{}''s message unanswered", door))),
        }
    }

    /// A child's call frame, relayed through `door` as it came: the reply frame as the store
    /// encoded it.  The store judges it under the door's binding, never under the parent's.
    pub async fn relay(&self, door: &str, frame: Vec<u8>) -> Outcome<Vec<u8>> {
        self.door_reply(OP_CALL, door, frame).await
    }

    /// Binds the door `env.run` on the store under `tag` and `env`, which the parent set at spawn.
    pub async fn bind_door(&self, tag: Tag, env: &RunEnv) -> Outcome<()> {
        let frame = res!(encode_bind(tag, env));
        let got = res!(self.door_reply(OP_BIND, &env.run, frame).await);
        refused_if_any(&env.run, "bind", &got)
    }

    /// Drops the door `door` on the store: its run's tasks end and its holds go.
    pub async fn drop_door(&self, door: &str) -> Outcome<()> {
        let got = res!(self.door_reply(OP_DROP, door, Vec::new()).await);
        refused_if_any(door, "drop", &got)
    }
}

fn refused_if_any(door: &str, what: &str, got: &[u8]) -> Outcome<()> {
    if got.is_empty() {
        return Ok(());
    }
    Err(err!("The store refused to {} door '{}': {}", what, door, String::from_utf8_lossy(got);
        Invalid, Input))
}

impl StoreLink for PipeLink {
    async fn call(&self, call: &StoreCall) -> Outcome<StoreReply> {
        let (_, rx) = res!(self.post(call));
        Self::got(call, rx.recv_async().await)
    }

    fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply> {
        let (_, rx) = res!(self.post(call));
        Self::got(call, rx.recv())
    }

    fn notify(&self, call: &StoreCall) {
        let _ = self.send(call, NO_REPLY);
    }
}

/// Writes each call the link sends and reads each reply, until the pipe fails or ends, or the
/// link is let go.  Answers why it stopped.
async fn carry<R, W>(r: R, w: W, rx: flume::Receiver<(Vec<u8>, Vec<u8>)>, shared: &Shared)
    -> String
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = FrameReader::new(r, PIPE_MAX);
    let mut writer = FrameWriter::new(w, PIPE_MAX);
    let reading = async {
        loop {
            match read_one(&mut reader).await {
                Ok(Some((id, bytes)))   => shared.answer(id, bytes),
                Ok(None)                => return String::from("ended: the store closed it"),
                Err(e)                  => return fmt!("failed: {}", e),
            }
        }
    };
    let writing = async {
        while let Ok((head, frame)) = rx.recv_async().await {
            if let Err(e) = write_msg(&mut writer, &head, &frame).await {
                return fmt!("failed: {}", e);
            }
        }
        String::from("was let go")
    };
    tokio::select! {
        why = reading => why,
        why = writing => why,
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The store's end                                                │
// └───────────────────────────────────────────────────────────────┘

/// Serves the calls that come over the pipe `(r, w)` to the bound run `link`, until the peer ends
/// it.  Each call is answered as its [`LoopLink`] answers it, in whatever order the store does, so
/// a parked wait call never holds up a sync one.  `Ok` at a clean end between messages; the pipe's
/// fault where it failed.  Runs on any executor but the store's own thread.
pub async fn serve_pipe<R, W>(link: LoopLink, r: R, w: W) -> Outcome<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = FrameReader::new(r, PIPE_MAX);
    let mut writer = FrameWriter::new(w, PIPE_MAX);
    let (out, replies) = flume::unbounded::<(u64, Vec<u8>)>();
    let reading = async move {
        loop {
            let (id, frame) = match read_one(&mut reader).await {
                Ok(Some(m)) => m,
                Ok(None)    => return Ok(()),
                Err(e)      => return Err(e),
            };
            let call = match decode_call(&frame) {
                Ok(c)   => c,
                Err(_)  => {
                    // As the store thread answers a frame it cannot read: an empty reply, which
                    // the caller's decode refuses.
                    if id != NO_REPLY {
                        let _ = out.send((id, Vec::new()));
                    }
                    continue;
                }
            };
            let wait = match link.send(&call) {
                Ok(w)   => w,
                Err(e)  => return Err(e),
            };
            if id == NO_REPLY {
                continue;
            }
            let out = out.clone();
            tokio::spawn(async move {
                if let Ok(bytes) = wait.recv_async().await {
                    let _ = out.send((id, bytes));
                }
            });
        }
    };
    let writing = async {
        while let Ok((id, bytes)) = replies.recv_async().await {
            if let Err(e) = write_one(&mut writer, id, &bytes).await {
                return Err(e);
            }
        }
        Ok(())
    };
    // The reader's end drops its sender, and the writer runs on until every reply owed is
    // written; a failed write ends both.
    let (read, write) = tokio::join!(reading, writing);
    res!(read);
    write
}

/// The store's end of its own pipe (R1d): the parent's calls through `parent`, and every door
/// the parent binds over it, each call through its door's [`LoopLink`].
///
/// A door is bound only under [`Tag::Run`] or [`Tag::Door`] and named for its run; the parent
/// tag is the store's own binding of `parent`, never one a message can ask for.  A call through
/// a door not bound is answered [`Unbound`], naming the door.
pub async fn serve_relay<R, W>(server: &StoreServer, parent: LoopLink, r: R, w: W) -> Outcome<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = FrameReader::new(r, PIPE_MAX);
    let mut writer = FrameWriter::new(w, PIPE_MAX);
    let (out, replies) = flume::unbounded::<(u64, Vec<u8>)>();
    let reading = async move {
        let mut doors: BTreeMap<String, LoopLink> = BTreeMap::new();
        loop {
            let (head, frame) = match res!(read_msg(&mut reader).await) {
                Some(m) => m,
                None    => return Ok(()),
            };
            let id = head.id;
            let link = match head.door {
                None                    => &parent,
                Some((OP_CALL, door))   => match doors.get(&door) {
                    Some(l) => l,
                    None    => {
                        let name = decode_call(&frame).map(|c| c.name()).unwrap_or("?");
                        let refused = StoreReply::Fault(Fault::Unbound(Unbound {
                            call: name.to_string(), id: fmt!("door {}", door) }));
                        let _ = out.send((id, encode_reply(&refused).unwrap_or_default()));
                        continue;
                    }
                },
                Some((OP_BIND, door))   => {
                    let said = match bind_one(server, parent.run(), &doors, &door, &frame) {
                        Ok(l)   => {
                            doors.insert(door, l);
                            Vec::new()
                        }
                        Err(e)  => fmt!("{}", e).into_bytes(),
                    };
                    let _ = out.send((id, said));
                    continue;
                }
                Some((OP_DROP, door))   => {
                    let said = match doors.remove(&door) {
                        Some(_) => match server.drop_run(&door) {
                            Ok(())  => Vec::new(),
                            Err(e)  => fmt!("{}", e).into_bytes(),
                        },
                        None    => fmt!("door '{}' is not bound", door).into_bytes(),
                    };
                    let _ = out.send((id, said));
                    continue;
                }
                Some((op, door))        => {
                    let _ = out.send((id, fmt!("op {} for door '{}' is not one the store takes",
                        op, door).into_bytes()));
                    continue;
                }
            };
            let call = match decode_call(&frame) {
                Ok(c)   => c,
                Err(_)  => {
                    if id != NO_REPLY {
                        let _ = out.send((id, Vec::new()));
                    }
                    continue;
                }
            };
            let wait = res!(link.send(&call));
            if id == NO_REPLY {
                continue;
            }
            let out = out.clone();
            tokio::spawn(async move {
                if let Ok(bytes) = wait.recv_async().await {
                    let _ = out.send((id, bytes));
                }
            });
        }
    };
    let writing = async {
        while let Ok((id, bytes)) = replies.recv_async().await {
            res!(write_one(&mut writer, id, &bytes).await);
        }
        Ok(())
    };
    let (read, write) = tokio::join!(reading, writing);
    res!(read);
    write
}

/// Binds door `door` from its bind frame, or says why not.
fn bind_one(
    server: &StoreServer,
    parent: &str,
    doors:  &BTreeMap<String, LoopLink>,
    door:   &str,
    frame:  &[u8],
)
    -> Outcome<LoopLink>
{
    let (tag, env) = res!(decode_bind(frame));
    if tag == Tag::Parent {
        return Err(err!("Door '{}' asked for the parent tag, which is never bound over the pipe.",
            door; Security, Invalid));
    }
    if env.run != door || door == parent {
        return Err(err!("Door '{}' is bound only for its own run, not for '{}'.", door, env.run;
            Security, Invalid));
    }
    if doors.contains_key(door) {
        return Err(err!("Door '{}' is bound already.", door; Security, Exists));
    }
    server.bind(tag, env)
}

/// [`serve_relay`] over a connected Unix socket.
#[cfg(unix)]
pub async fn serve_relay_unix(server: &StoreServer, parent: LoopLink,
    sock: std::os::unix::net::UnixStream) -> Outcome<()>
{
    let s = res!(unix(sock));
    let (r, w) = s.into_split();
    serve_relay(server, parent, r, w).await
}

// ┌───────────────────────────────────────────────────────────────┐
// │ A door's binding on the wire                                   │
// └───────────────────────────────────────────────────────────────┘

fn put_str(b: &mut Vec<u8>, s: &str) {
    b.extend_from_slice(&(s.len() as u32).to_be_bytes());
    b.extend_from_slice(s.as_bytes());
}

fn put_set(b: &mut Vec<u8>, set: &BTreeSet<String>) {
    b.extend_from_slice(&(set.len() as u32).to_be_bytes());
    for s in set {
        put_str(b, s);
    }
}

/// A door's bind frame: its tag, then its run's environment, field by field.
pub fn encode_bind(tag: Tag, env: &RunEnv) -> Outcome<Vec<u8>> {
    let mut b = vec![match tag { Tag::Run => 1u8, Tag::Door => 2, Tag::Parent => 3 }];
    put_str(&mut b, &env.run);
    put_set(&mut b, &env.diamonds);
    match &env.folder_id {
        Some(f) => { b.push(1); put_str(&mut b, f); },
        None    => b.push(0),
    }
    put_set(&mut b, &env.known);
    put_str(&mut b, &env.page);
    if b.len() > PIPE_MAX {
        return Err(err!("Door '{}''s bind frame of {} bytes is over the pipe's {}.",
            env.run, b.len(), PIPE_MAX; TooBig, Wire));
    }
    Ok(b)
}

struct Cursor<'a> {
    b:  &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Outcome<&'a [u8]> {
        let got = self.at.checked_add(n).and_then(|end| self.b.get(self.at..end).map(|s| (s, end)));
        match got {
            Some((s, end))  => { self.at = end; Ok(s) },
            None            => Err(err!("A door's bind frame ended early."; Decode, Wire)),
        }
    }

    fn byte(&mut self) -> Outcome<u8> {
        let b = res!(self.take(1));
        Ok(b.first().copied().unwrap_or(0))
    }

    fn len(&mut self) -> Outcome<usize> {
        let b = res!(self.take(4));
        match <[u8; 4]>::try_from(b) {
            Ok(a)   => Ok(u32::from_be_bytes(a) as usize),
            Err(_)  => Err(err!("A door's bind frame ended early."; Decode, Wire)),
        }
    }

    fn string(&mut self) -> Outcome<String> {
        let n = res!(self.len());
        let b = res!(self.take(n));
        match std::str::from_utf8(b) {
            Ok(s)   => Ok(s.to_string()),
            Err(e)  => Err(err!(e, "A door's bind frame holds a name that is not UTF-8.";
                Decode, Wire)),
        }
    }

    fn set(&mut self) -> Outcome<BTreeSet<String>> {
        let n = res!(self.len());
        let mut set = BTreeSet::new();
        for _ in 0..n {
            set.insert(res!(self.string()));
        }
        Ok(set)
    }
}

/// The tag and environment of a door's bind frame.
pub fn decode_bind(bytes: &[u8]) -> Outcome<(Tag, RunEnv)> {
    let mut c = Cursor { b: bytes, at: 0 };
    let tag = match res!(c.byte()) {
        1 => Tag::Run,
        2 => Tag::Door,
        3 => Tag::Parent,
        t => return Err(err!("A door's bind frame names tag {}, which is none.", t; Decode, Wire)),
    };
    let run = res!(c.string());
    let diamonds = res!(c.set());
    let folder_id = match res!(c.byte()) {
        0 => None,
        _ => Some(res!(c.string())),
    };
    let known = res!(c.set());
    let page = res!(c.string());
    if c.at != bytes.len() {
        return Err(err!("A door's bind frame runs on past its end."; Decode, Wire));
    }
    Ok((tag, RunEnv { run, diamonds, folder_id, known, page }))
}

/// [`serve_pipe`] over a connected Unix socket.
#[cfg(unix)]
pub async fn serve_unix(link: LoopLink, sock: std::os::unix::net::UnixStream) -> Outcome<()> {
    let s = res!(unix(sock));
    let (r, w) = s.into_split();
    serve_pipe(link, r, w).await
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Messages                                                       │
// └───────────────────────────────────────────────────────────────┘

#[cfg(unix)]
fn unix(sock: std::os::unix::net::UnixStream) -> Outcome<tokio::net::UnixStream> {
    if let Err(e) = sock.set_nonblocking(true) {
        return Err(err!(e, "The store pipe's socket could not be made non-blocking."; IO, Init));
    }
    match tokio::net::UnixStream::from_std(sock) {
        Ok(s)   => Ok(s),
        Err(e)  => Err(err!(e, "The store pipe's socket could not join the executor."; IO, Init)),
    }
}

/// A pipe's frame reader, at the pipe's ceiling.
pub fn msg_reader<R: AsyncRead + Unpin>(r: R) -> FrameReader<R> { FrameReader::new(r, PIPE_MAX) }

/// A pipe's frame writer, at the pipe's ceiling.
pub fn msg_writer<W: AsyncWrite + Unpin>(w: W) -> FrameWriter<W> { FrameWriter::new(w, PIPE_MAX) }

/// The next message, plain or relayed: its id frame and its frame.  `None` at a clean end
/// between messages.
pub async fn read_msg<R: AsyncRead + Unpin>(reader: &mut FrameReader<R>)
    -> Outcome<Option<(Head, Vec<u8>)>>
{
    let head = match res!(reader.read_bytes().await) {
        Some(b) => b,
        None    => return Ok(None),
    };
    let head = res!(Head::parse(&head));
    match res!(reader.read_bytes().await) {
        Some(frame) => Ok(Some((head, frame))),
        None        => Err(err!(
            "The store pipe ended between message {}'s id and its frame.", head.id;
            Decode, Missing)),
    }
}

/// The next plain message: its id and its frame.  `None` at a clean end between messages.  A
/// relayed id frame is refused: only the parent names a door, on the store's own pipe.
pub async fn read_one<R: AsyncRead + Unpin>(reader: &mut FrameReader<R>)
    -> Outcome<Option<(u64, Vec<u8>)>>
{
    match res!(read_msg(reader).await) {
        None                                => Ok(None),
        Some((Head { id, door: None }, f))  => Ok(Some((id, f))),
        Some((Head { id, door: Some((_, door)) }, _)) => Err(err!(
            "Message {} names door '{}', and only plain ids are taken here: refused.", id, door;
            Security, Wire)),
    }
}

/// Writes one message under the id frame `head`.
async fn write_msg<W: AsyncWrite + Unpin>(writer: &mut FrameWriter<W>, head: &[u8], frame: &[u8])
    -> Outcome<()>
{
    res!(writer.write_bytes(head).await);
    writer.write_bytes(frame).await
}

/// Writes one plain message: its id, then its frame.
pub async fn write_one<W: AsyncWrite + Unpin>(writer: &mut FrameWriter<W>, id: u64, frame: &[u8])
    -> Outcome<()>
{
    write_msg(writer, &Head::bytes(id, None), frame).await
}

/// Writes one relayed message, as only the parent sends them (and a test forging one).
pub async fn write_relayed<W: AsyncWrite + Unpin>(writer: &mut FrameWriter<W>, id: u64, op: u8,
    door: &str, frame: &[u8]) -> Outcome<()>
{
    write_msg(writer, &Head::bytes(id, Some((op, door))), frame).await
}
