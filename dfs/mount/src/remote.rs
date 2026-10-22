use crate::errno::Errno;
use dfs_protocol::{
    LIST_MAX_ENTRIES, LOOKUP_MAX_TARGETS, ObjectId, ObjectRef, READ_FILES_MAX_OBJECTS,
    STAT_MAX_REFERENCES,
    rpc::{
        ApplyRequest, Attr, AttrBatch, Empty, Entry, ErrorCode, ListRequest, LookupRequest,
        LookupTarget, Mutation, Operation, ReadData, ReadFilesRequest, ReadRequest, Session,
        StatRequest, dfs_client::DfsClient, operation,
    },
};
use tonic::{Request, metadata::AsciiMetadataValue, transport::Channel};

/// The mount's connection to the dfs server, authenticated with one session key. The caller builds
/// the channel, TLS included.
#[derive(Clone)]
pub struct Remote {
    client: DfsClient<Channel>,
    authorization: AsciiMetadataValue,
}

impl Remote {
    /// Fails with `EINVAL` if the key cannot be sent as a header.
    pub fn new(channel: Channel, session_key: &str) -> Result<Self, Errno> {
        let mut authorization: AsciiMetadataValue = format!("Bearer {session_key}")
            .parse()
            .map_err(|_| Errno::EINVAL)?;
        authorization.set_sensitive(true);
        Ok(Self {
            client: DfsClient::new(channel),
            authorization,
        })
    }

    fn request<T>(&self, message: T) -> Request<T> {
        let mut request = Request::new(message);
        request
            .metadata_mut()
            .insert("authorization", self.authorization.clone());
        request
    }

    pub async fn current_session(&self) -> Result<Session, Errno> {
        let response = self
            .client
            .clone()
            .current_session(self.request(Empty {}))
            .await?;
        Ok(response.into_inner())
    }

    /// Extends the session. Sessions expire one hour after their last refresh.
    pub async fn refresh_session(&self) -> Result<Session, Errno> {
        let response = self
            .client
            .clone()
            .refresh_session(self.request(Empty {}))
            .await?;
        Ok(response.into_inner())
    }

    /**
     * @cc [owner:fontanierh,label:api] stat-batch
     * On success, `stat` MUST return exactly one result per reference, in the same order, however
     * many references it gets.
     */
    pub async fn stat(&self, references: &[ObjectRef]) -> Result<Vec<Result<Attr, Errno>>, Errno> {
        let mut results = Vec::with_capacity(references.len());
        for chunk in references.chunks(STAT_MAX_REFERENCES) {
            let response = self
                .client
                .clone()
                .stat(self.request(StatRequest {
                    object_ids: chunk.to_vec(),
                    include_metadata: None,
                }))
                .await?
                .into_inner();
            results.extend(attr_results(response, chunk.len())?);
        }
        Ok(results)
    }

    /// Finds each target's name in its parent directory, with the attributes of what it names.
    /**
     * @cc [owner:fontanierh,label:api] lookup-batch
     * On success, `lookup` MUST return exactly one result per target, in the same order, however
     * many targets it gets.
     */
    pub async fn lookup(
        &self,
        targets: &[LookupTarget],
    ) -> Result<Vec<Result<Attr, Errno>>, Errno> {
        let mut results = Vec::with_capacity(targets.len());
        for chunk in targets.chunks(LOOKUP_MAX_TARGETS) {
            let response = self
                .client
                .clone()
                .lookup(self.request(LookupRequest {
                    targets: chunk.to_vec(),
                    include_metadata: None,
                }))
                .await?
                .into_inner();
            results.extend(attr_results(response, chunk.len())?);
        }
        Ok(results)
    }

    /// Lists the entries of the directory `directory` the session can read, in the server's order.
    /// Each page is a separate request, so changes made to the directory while it is listed may or
    /// may not show.
    /**
     * @cc [owner:fontanierh,label:api] list-every-page
     * On success, `list` MUST return the entries of every page of `directory`, asking for the next
     * page until the server returns one without `next_after`. Any failed page MUST fail `list`.
     */
    pub async fn list(&self, directory: ObjectRef) -> Result<Vec<Entry>, Errno> {
        let mut entries = Vec::new();
        let mut after = None;
        loop {
            let page = self
                .client
                .clone()
                .list(self.request(ListRequest {
                    directory_id: directory,
                    after,
                    limit: LIST_MAX_ENTRIES,
                }))
                .await?
                .into_inner();
            entries.extend(page.entries);
            match page.next_after {
                Some(next_after) => after = Some(next_after),
                None => return Ok(entries),
            }
        }
    }

    /// Reads up to `length` bytes of the file `object` from `offset`, with its attributes. The data
    /// is shorter than `length` only at the end of the file. `length` is at most `READ_MAX_BYTES`.
    pub async fn read(
        &self,
        object: ObjectId,
        offset: u64,
        length: u32,
    ) -> Result<ReadData, Errno> {
        let response = self
            .client
            .clone()
            .read(self.request(ReadRequest {
                object_id: object,
                offset,
                length,
            }))
            .await?;
        Ok(response.into_inner())
    }

    /// Applies `operations` in order, in one server transaction. Each operation gets its own result: one
    /// that fails does not stop the ones after it. When `apply` fails, or its caller gives up on it,
    /// the operations may or may not have been applied.
    /**
     * @cc [owner:fontanierh,label:api] apply-once
     * `apply` MUST send its operations in at most one `Apply` request and MUST NOT retry it, so an
     * operation is never applied twice. No operations MUST return no results without a request.
     */
    /**
     * @cc [owner:fontanierh,label:api] apply-batch
     * On success, `apply` MUST return exactly one result per operation, in the same order.
     */
    pub async fn apply(
        &self,
        operations: Vec<operation::Operation>,
    ) -> Result<Vec<Result<Mutation, Errno>>, Errno> {
        if operations.is_empty() {
            return Ok(Vec::new());
        }
        let count = operations.len();
        let operations = operations
            .into_iter()
            .map(|operation| Operation {
                operation: Some(operation),
            })
            .collect();
        let response = self
            .client
            .clone()
            .apply(self.request(ApplyRequest {
                operations,
                locks: Vec::new(),
            }))
            .await?
            .into_inner();
        if response.results.len() != count {
            return Err(Errno::EIO);
        }
        Ok(response
            .results
            .into_iter()
            .map(|result| match (result.mutation, result.error) {
                (Some(mutation), None) => Ok(mutation),
                (None, Some(error)) => Err(error.code().into()),
                _ => Err(Errno::EIO),
            })
            .collect())
    }

    /// Reads whole files with their attributes, all from one server snapshot. A file is `Ok(None)` when
    /// it does not fit the reply, being over `READ_MAX_BYTES` or past the reply's budget: `read` it
    /// instead. At most `READ_FILES_MAX_OBJECTS` objects.
    /**
     * @cc [owner:fontanierh,label:api] read-files-batch
     * On success, `read_files` MUST return exactly one result per object, in the same order, from a
     * single `ReadFiles` request. More than `READ_FILES_MAX_OBJECTS` objects MUST fail with `EINVAL`
     * and no objects MUST return no results, both without a request.
     */
    /**
     * @cc [owner:fontanierh,label:api] read-files-capacity
     * A per-file `CAPACITY` error MUST become `Ok(None)`, not an errno, so the caller can tell a file
     * that did not fit from one it cannot read.
     */
    pub async fn read_files(
        &self,
        objects: &[ObjectId],
    ) -> Result<Vec<Result<Option<ReadData>, Errno>>, Errno> {
        if objects.len() > READ_FILES_MAX_OBJECTS {
            return Err(Errno::EINVAL);
        }
        if objects.is_empty() {
            return Ok(Vec::new());
        }
        let response = self
            .client
            .clone()
            .read_files(self.request(ReadFilesRequest {
                object_ids: objects.to_vec(),
            }))
            .await?
            .into_inner();
        if response.results.len() != objects.len() {
            return Err(Errno::EIO);
        }
        Ok(response
            .results
            .into_iter()
            .zip(objects)
            .map(|(result, object)| {
                if result.object_id != *object {
                    return Err(Errno::EIO);
                }
                match (result.object, result.data, result.error) {
                    (Some(object), Some(data), None) => Ok(Some(ReadData { data, object })),
                    (None, None, Some(error)) if error.code() == ErrorCode::Capacity => Ok(None),
                    (None, None, Some(error)) => Err(error.code().into()),
                    _ => Err(Errno::EIO),
                }
            })
            .collect())
    }
}

/// The results of a `Stat` or `Lookup` batch, one per request item. Fails with `EIO` if the server
/// returned another count or a result with both or neither of an attribute and an error.
fn attr_results(batch: AttrBatch, expected: usize) -> Result<Vec<Result<Attr, Errno>>, Errno> {
    if batch.results.len() != expected {
        return Err(Errno::EIO);
    }
    Ok(batch
        .results
        .into_iter()
        .map(|result| match (result.object, result.error) {
            (Some(attr), None) => Ok(attr),
            (None, Some(error)) => Err(error.code().into()),
            _ => Err(Errno::EIO),
        })
        .collect())
}
