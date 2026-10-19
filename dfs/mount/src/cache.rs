//! Server replies kept to answer later requests without asking the server again, each for the cache
//! TTL from when its request was sent.

use dfs_protocol::{ObjectId, rpc::Attr};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// The fewest entries a map holds before expired entries are dropped.
const PRUNE_MIN_ENTRIES: usize = 1024;

/// Attributes by object, and names by (directory, name): the object found, or none.
pub(crate) struct Cache {
    ttl: Duration,
    attrs: Stamped<ObjectId, Attr>,
    names: Stamped<(ObjectId, String), Option<ObjectId>>,
}

/// Values with the time their request was sent.
struct Stamped<K, V> {
    entries: HashMap<K, (V, Instant)>,
    /// Expired entries are dropped when the map reaches this many entries.
    prune_at: usize,
}

impl Cache {
    pub(crate) fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            attrs: Stamped::new(),
            names: Stamped::new(),
        }
    }

    pub(crate) fn attr(&self, object: ObjectId, now: Instant) -> Option<&Attr> {
        self.attrs.get(&object, now, self.ttl)
    }

    /// The object `name` names in `directory`: `Some(None)` when it names none.
    pub(crate) fn name(
        &self,
        directory: ObjectId,
        name: &str,
        now: Instant,
    ) -> Option<Option<ObjectId>> {
        self.names
            .get(&(directory, name.to_owned()), now, self.ttl)
            .copied()
    }

    /// Keeps `attr`, the attributes of `object` from a request sent at `sent`.
    pub(crate) fn install_attr(&mut self, object: ObjectId, attr: Attr, sent: Instant) {
        self.attrs.install(object, attr, sent, self.ttl);
    }

    /// Keeps what `name` names in `directory`, from a request sent at `sent`.
    pub(crate) fn install_name(
        &mut self,
        directory: ObjectId,
        name: String,
        object: Option<ObjectId>,
        sent: Instant,
    ) {
        self.names
            .install((directory, name), object, sent, self.ttl);
    }
}

impl<K: Eq + std::hash::Hash, V> Stamped<K, V> {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            prune_at: PRUNE_MIN_ENTRIES,
        }
    }

    /**
     * @cc [owner:fontanierh,label:product] ttl-at-serve
     * `get` MUST return a value only while less than the TTL has passed since its request was
     * sent. A zero TTL MUST serve nothing.
     */
    fn get(&self, key: &K, now: Instant, ttl: Duration) -> Option<&V> {
        let (value, sent) = self.entries.get(key)?;
        (now.saturating_duration_since(*sent) < ttl).then_some(value)
    }

    /**
     * @cc [owner:fontanierh,label:product] newest-request-wins
     * `install` MUST NOT replace a value with one from a request sent earlier.
     */
    /**
     * @cc [owner:fontanierh,label:performance] bounded-by-live-entries
     * When the map reaches `prune_at` entries, `install` MUST drop the expired ones and set
     * `prune_at` to twice the entries left, at least `PRUNE_MIN_ENTRIES`, so expired entries do not
     * pile up and pruning stays amortized constant time.
     */
    fn install(&mut self, key: K, value: V, sent: Instant, ttl: Duration) {
        if let Some((_, current)) = self.entries.get(&key)
            && *current > sent
        {
            return;
        }
        self.entries.insert(key, (value, sent));
        if self.entries.len() >= self.prune_at {
            let now = Instant::now();
            self.entries
                .retain(|_, (_, sent)| now.saturating_duration_since(*sent) < ttl);
            self.prune_at = (self.entries.len() * 2).max(PRUNE_MIN_ENTRIES);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL: Duration = Duration::from_millis(750);

    fn attr(size: u64) -> Attr {
        Attr {
            size,
            ..Attr::default()
        }
    }

    #[test]
    fn replies_are_served_until_the_ttl_from_their_request() {
        let mut cache = Cache::new(TTL);
        let object = ObjectId::new_v7();
        let sent = Instant::now();
        cache.install_attr(object, attr(1), sent);
        assert_eq!(cache.attr(object, sent).map(|a| a.size), Some(1));
        assert_eq!(
            cache
                .attr(object, sent + TTL - Duration::from_millis(1))
                .map(|a| a.size),
            Some(1)
        );
        assert!(cache.attr(object, sent + TTL).is_none());
    }

    #[test]
    fn missing_names_are_kept_too() {
        let mut cache = Cache::new(TTL);
        let directory = ObjectId::new_v7();
        let found = ObjectId::new_v7();
        let sent = Instant::now();
        cache.install_name(directory, "a".to_owned(), Some(found), sent);
        cache.install_name(directory, "b".to_owned(), None, sent);
        assert_eq!(cache.name(directory, "a", sent), Some(Some(found)));
        assert_eq!(cache.name(directory, "b", sent), Some(None));
        assert_eq!(cache.name(directory, "c", sent), None);
    }

    #[test]
    fn a_zero_ttl_serves_nothing() {
        let mut cache = Cache::new(Duration::ZERO);
        let object = ObjectId::new_v7();
        let sent = Instant::now();
        cache.install_attr(object, attr(1), sent);
        assert!(cache.attr(object, sent).is_none());
    }

    #[test]
    fn an_older_request_does_not_replace_a_newer_one() {
        let mut cache = Cache::new(TTL);
        let object = ObjectId::new_v7();
        let first = Instant::now();
        let second = first + Duration::from_millis(1);
        cache.install_attr(object, attr(2), second);
        cache.install_attr(object, attr(1), first);
        assert_eq!(cache.attr(object, second).map(|a| a.size), Some(2));
    }

    #[test]
    fn expired_entries_are_dropped_as_the_cache_grows() {
        let mut cache = Cache::new(Duration::ZERO);
        let sent = Instant::now();
        for _ in 0..PRUNE_MIN_ENTRIES * 3 {
            cache.install_attr(ObjectId::new_v7(), attr(0), sent);
        }
        assert!(cache.attrs.entries.len() < PRUNE_MIN_ENTRIES);
    }
}
