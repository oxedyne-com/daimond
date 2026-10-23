//! A conversation's counters, apart from the browser engine that keeps them so a native test
//! can read the arithmetic (EP-6 F6L).

use crate::agent::Agent;
use crate::protocol::Session;

/// A conversation's counters: the snapshot's view, and a Diamond turn's spend.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Counters {
    pub prompt:         u64,
    pub completion:     u64,
    pub cached:         u64,
    pub cost:           f64,
    pub last_prompt:    u64,
}

impl Counters {

    pub fn of(s: &Session) -> Self {
        Self {
            prompt:         s.prompt_tokens,
            completion:     s.completion_tokens,
            cached:         s.cached_tokens,
            cost:           s.cost_usd,
            last_prompt:    s.last_prompt_tokens,
        }
    }

    /// The agent's per-response mirror of its session, which a sink can read mid-round.
    pub fn live(agent: &Agent) -> Self {
        Self {
            prompt:         agent.live_prompt.get(),
            completion:     agent.live_completion.get(),
            cached:         agent.live_cached.get(),
            cost:           agent.live_cost.get(),
            last_prompt:    agent.live_last_prompt.get(),
        }
    }

    pub fn set_on(&self, s: &mut Session) {
        s.prompt_tokens         = self.prompt;
        s.completion_tokens     = self.completion;
        s.cached_tokens         = self.cached;
        s.cost_usd              = self.cost;
        s.last_prompt_tokens    = self.last_prompt;
    }

    /// These counters with `spend`'s totals added, the last prompt still these counters' own.
    ///
    /// Lead ruling (EP-6 F6L): spend owed into a chat is a child's (a worker, a steer, a fold
    /// proposal, each on its own session), so it bills the chat but never sets the chat's last
    /// request, which the fold check and the context % (the chat's last request / window) read.
    pub fn plus(&self, spend: &Counters) -> Self {
        Self {
            prompt:         self.prompt + spend.prompt,
            completion:     self.completion + spend.completion,
            cached:         self.cached + spend.cached,
            cost:           self.cost + spend.cost,
            last_prompt:    self.last_prompt,
        }
    }

    /// What a getter reads: the view, and the spend owed into it since.
    pub fn owing(&self, owed: &[Counters]) -> Self {
        owed.iter().fold(*self, |c, u| c.plus(u))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spend(n: u64, last: u64) -> Counters {
        Counters { prompt: n, completion: n, cached: n, cost: n as f64, last_prompt: last }
    }

    /// Lead ruling (EP-6 F6L, QA LOW-3): a child's spend owed into the chat adds to the chat's
    /// totals and never sets the chat's last prompt, which the fold check and the context % read
    /// as the chat's own last request.
    #[test]
    fn owed_child_spend_adds_but_never_sets_the_last_prompt() {
        let chat = spend(100, 4000);
        let got = chat.owing(&[spend(10, 90_000), spend(5, 7)]);
        assert_eq!(got.prompt, 115);
        assert_eq!(got.completion, 115);
        assert_eq!(got.cached, 115);
        assert_eq!(got.cost, 115.0);
        assert_eq!(got.last_prompt, 4000, "the chat's last request stands");
        assert_eq!(chat.plus(&spend(1, 1)).last_prompt, 4000);
    }
}
