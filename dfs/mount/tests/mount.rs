//! Integration tests for the mount library against a real dfs server.
//!
//! The harness starts the dfs server in this process (`dfs_api::serve` on a local port) and talks to
//! it over gRPC, as the mount does in production. The server stores its data in the FoundationDB
//! cluster named by `FDB_CLUSTER_FILE`, so these tests need a running FoundationDB and its client
//! library (`libfdb_c`), as in CI.
//!
//! Each run creates a fresh tenant with random IDs, so runs never see each other's data. Objects are
//! written directly to FoundationDB until the server can create them over gRPC.
//!
//! All checks run under the single `mount` test below; to add one, write an `async fn` and call it
//! from there.

use anyhow::{Context, Result};
use dfs_api::{
    clock,
    storage::{
        fdb,
        resources::{
            directory::DirectoryResource, keys::tenant_subspace, object::ObjectResource,
            tenant::TenantResource,
        },
    },
};
use dfs_mount::{DirEntry, Errno, Folder, Fs, Kind, ROOT_INO, Remote};
use dfs_protocol::{
    LIST_MAX_ENTRIES, LOOKUP_MAX_TARGETS, ObjectId, ObjectRef, READ_FILES_MAX_OBJECTS,
    READ_MAX_BYTES, STAT_MAX_REFERENCES,
    rpc::{
        AllowGrant, CreateOperation, CreateSessionRequest, CreateTenantRequest, DenyGrant, Grant,
        GrantUpdate, LookupTarget, ObjectKind, RemoveOperation, WriteOperation,
        dfs_client::DfsClient, grant, operation::Operation,
    },
};
use std::collections::{BTreeMap, HashMap};
use tokio::net::TcpListener;
use tonic::{Request, transport::Channel};

const MASTER_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SUBJECT: &str = "u:mount-test";
/// The content of the readable file, stored in its first block.
const FILE_CONTENT: &[u8] = b"hello";
/// More than one `Stat` request can carry.
const MANY_REFERENCES: usize = STAT_MAX_REFERENCES + 4;
/// More than one `Lookup` request can carry.
const MANY_TARGETS: usize = LOOKUP_MAX_TARGETS + 3;
/// More entries than one `List` page holds.
const MANY_ENTRIES: u32 = LIST_MAX_ENTRIES + 3;
/// Most children one seeding transaction creates, to stay well within FoundationDB's transaction
/// time and size limits.
const SEED_BATCH_SIZE: usize = 512;

/// The FDB network boots once per process and cannot restart once stopped, so every mount check
/// runs under this one test, which holds the guard and drops it before the binary exits.
#[test]
fn mount() -> Result<()> {
    // SAFETY: the only `boot` in this test binary; `_network` is dropped when this test returns.
    #[allow(unsafe_code)]
    let _network = unsafe { foundationdb::boot() };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    runtime.block_on(async {
        let channel = serve().await?;
        let tenant = Tenant::create(&channel).await?;
        stat_returns_one_ordered_result_per_reference(&channel, &tenant).await?;
        stat_fails_with_an_unknown_session_key(&channel, &tenant).await?;
        lookup_returns_one_ordered_result_per_target(&channel, &tenant).await?;
        read_returns_file_ranges(&channel, &tenant).await?;
        root_lists_readable_folders(&channel, &tenant).await?;
        root_looks_up_readable_folders(&channel, &tenant).await?;
        folders_look_up_readable_children(&channel, &tenant).await?;
        list_returns_every_page(&channel, &tenant).await?;
        apply_returns_one_ordered_result_per_operation(&channel, &tenant).await?;
        read_files_returns_one_ordered_result_per_object(&channel, &tenant).await?;
        folders_list_readable_children(&channel, &tenant).await?;
        files_read_in_ranges(&channel, &tenant).await
    })
}

async fn serve() -> Result<Channel> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(dfs_api::serve(listener, MASTER_KEY, std::future::pending()));
    Ok(Channel::from_shared(format!("http://{address}"))?
        .connect()
        .await?)
}

fn with_authorization<T>(message: T, authorization: &str) -> Result<Request<T>> {
    let mut request = Request::new(message);
    request
        .metadata_mut()
        .insert("authorization", authorization.parse()?);
    Ok(request)
}

/// A tenant whose root `SUBJECT` can read and write, holding a file `SUBJECT` can read, with
/// `FILE_CONTENT`, and one it cannot.
struct Tenant {
    key: String,
    root_id: ObjectId,
    file_id: ObjectId,
    unreadable_id: ObjectId,
}

impl Tenant {
    async fn create(channel: &Channel) -> Result<Self> {
        let tenant = DfsClient::new(channel.clone())
            .create_tenant(with_authorization(
                CreateTenantRequest {
                    tenant_id: ObjectId::new_v7().to_string(),
                    root_grants: vec![Grant {
                        kind: Some(grant::Kind::Allow(AllowGrant {
                            subject: SUBJECT.to_owned(),
                            mode: 0o6,
                        })),
                    }],
                },
                &format!("Bearer {MASTER_KEY}"),
            )?)
            .await?
            .into_inner();

        // File creation RPCs are not implemented yet. Directory children also write the entries
        // `Lookup` and `List` read.
        let tx = fdb::database()?.create_trx()?;
        let resource = TenantResource::fetch(&tx, &tenant.tenant_id)
            .await?
            .context("missing tenant")?;
        let root = ObjectResource::fetch(&tx, &resource, &tenant.root_id)
            .await?
            .context("missing root")?;
        let mut root = DirectoryResource::try_from(root)?;
        let mut file = root
            .create_child(
                &tx,
                ObjectId::new_v7(),
                "report.txt".to_owned(),
                ObjectKind::File,
                None,
                HashMap::new(),
            )
            .await?;
        file.size = FILE_CONTENT.len() as u64;
        file.record_content_change(&tx, clock::now_ms()?);
        tx.set(
            &tenant_subspace(&tenant.tenant_id).pack(&(
                "block",
                file.object_id.as_bytes().as_slice(),
                0_u64,
            )),
            FILE_CONTENT,
        );
        let mut unreadable = root
            .create_child(
                &tx,
                ObjectId::new_v7(),
                "secret.txt".to_owned(),
                ObjectKind::File,
                None,
                HashMap::new(),
            )
            .await?;
        unreadable.update_grants(
            &tx,
            &[GrantUpdate {
                grant: Grant {
                    kind: Some(grant::Kind::Deny(DenyGrant { mode: 0o4 })),
                },
                remove: false,
            }],
        )?;
        tx.commit().await?;

        Ok(Self {
            key: tenant.tenant_key,
            root_id: tenant.root_id,
            file_id: file.object_id,
            unreadable_id: unreadable.object_id,
        })
    }

    async fn remote(&self, channel: &Channel) -> Result<Remote> {
        let session = DfsClient::new(channel.clone())
            .create_session(with_authorization(
                CreateSessionRequest {
                    subjects: vec![SUBJECT.to_owned()],
                },
                &format!("Bearer {}", self.key),
            )?)
            .await?
            .into_inner();
        Ok(Remote::new(channel.clone(), &session.session_key)?)
    }
}

async fn stat_returns_one_ordered_result_per_reference(
    channel: &Channel,
    tenant: &Tenant,
) -> Result<()> {
    let remote = tenant.remote(channel).await?;
    let missing = ObjectId::new_v7();
    let references: Vec<ObjectRef> = (0..MANY_REFERENCES)
        .map(|index| match index % 4 {
            0 => tenant.root_id.into(),
            1 => tenant.file_id.into(),
            2 => missing.into(),
            _ => tenant.unreadable_id.into(),
        })
        .collect();

    let results = remote.stat(&references).await?;

    assert_eq!(results.len(), MANY_REFERENCES);
    for (index, result) in results.iter().enumerate() {
        let kind = result
            .as_ref()
            .map(|attr| attr.kind())
            .map_err(|errno| *errno);
        match index % 4 {
            0 => assert_eq!(kind, Ok(ObjectKind::Directory), "reference {index}"),
            1 => assert_eq!(kind, Ok(ObjectKind::File), "reference {index}"),
            // An object the session cannot read looks missing.
            _ => assert_eq!(kind, Err(Errno::ENOENT), "reference {index}"),
        }
    }
    assert!(remote.stat(&[]).await?.is_empty());
    Ok(())
}

async fn lookup_returns_one_ordered_result_per_target(
    channel: &Channel,
    tenant: &Tenant,
) -> Result<()> {
    let remote = tenant.remote(channel).await?;
    let targets: Vec<LookupTarget> = (0..MANY_TARGETS)
        .map(|index| LookupTarget {
            parent_id: tenant.root_id.into(),
            name: ["report.txt", "secret.txt", "missing.txt"][index % 3].to_owned(),
        })
        .collect();

    let results = remote.lookup(&targets).await?;

    assert_eq!(results.len(), MANY_TARGETS);
    for (index, result) in results.iter().enumerate() {
        let id = result.as_ref().map(|attr| attr.id).map_err(|errno| *errno);
        match index % 3 {
            0 => assert_eq!(id, Ok(tenant.file_id.into()), "target {index}"),
            // An object the session cannot read looks missing.
            _ => assert_eq!(id, Err(Errno::ENOENT), "target {index}"),
        }
    }
    assert!(remote.lookup(&[]).await?.is_empty());
    Ok(())
}

async fn stat_fails_with_an_unknown_session_key(channel: &Channel, tenant: &Tenant) -> Result<()> {
    let remote = Remote::new(channel.clone(), &"fedcba9876543210".repeat(4))?;
    let result = remote.stat(&[tenant.root_id.into()]).await;
    assert!(matches!(result, Err(Errno::EACCES)));
    Ok(())
}

async fn read_returns_file_ranges(channel: &Channel, tenant: &Tenant) -> Result<()> {
    let remote = tenant.remote(channel).await?;

    let read = remote.read(tenant.file_id, 1, 3).await?;
    assert_eq!(read.data, &FILE_CONTENT[1..4]);
    assert_eq!(read.object.id, tenant.file_id.into());
    assert_eq!(read.object.size, FILE_CONTENT.len() as u64);
    // Reads stop at the end of the file.
    let read = remote.read(tenant.file_id, 2, 10).await?;
    assert_eq!(read.data, &FILE_CONTENT[2..]);
    let end = FILE_CONTENT.len() as u64;
    assert!(remote.read(tenant.file_id, end, 10).await?.data.is_empty());

    for (object, length, expected) in [
        (tenant.file_id, READ_MAX_BYTES + 1, Errno::EINVAL),
        (tenant.root_id, 1, Errno(libc::EISDIR)),
        (tenant.unreadable_id, 1, Errno::ENOENT),
        (ObjectId::new_v7(), 1, Errno::ENOENT),
    ] {
        let result = remote.read(object, 0, length).await;
        assert_eq!(result.err(), Some(expected), "reading {object}");
    }
    Ok(())
}

fn folder(name: &str, id: ObjectId) -> Folder {
    Folder {
        name: name.to_owned(),
        id,
    }
}

async fn root_lists_readable_folders(channel: &Channel, tenant: &Tenant) -> Result<()> {
    let folders = vec![
        folder("workspace", tenant.root_id),
        // Left out: not a directory, unreadable, and missing.
        folder("report", tenant.file_id),
        folder("secret", tenant.unreadable_id),
        folder("missing", ObjectId::new_v7()),
    ];

    let fs = Fs::new(tenant.remote(channel).await?, folders.clone())?;
    let entries = fs.readdir(ROOT_INO).await?;
    assert_eq!(
        entries
            .iter()
            .map(|entry| (entry.kind, entry.name.as_str()))
            .collect::<Vec<_>>(),
        [(Kind::Directory, "workspace")]
    );
    assert_ne!(entries[0].ino, ROOT_INO);
    // Folder inode numbers are fixed for the life of the mount.
    assert_eq!(fs.readdir(ROOT_INO).await?, entries);
    fs.forget(entries[0].ino, 1);
    assert_eq!(fs.readdir(ROOT_INO).await?, entries);

    let remote = Remote::new(channel.clone(), &"fedcba9876543210".repeat(4))?;
    let result = Fs::new(remote, folders)?.readdir(ROOT_INO).await;
    assert_eq!(result, Err::<Vec<DirEntry>, _>(Errno::EACCES));
    Ok(())
}

async fn root_looks_up_readable_folders(channel: &Channel, tenant: &Tenant) -> Result<()> {
    let fs = Fs::new(
        tenant.remote(channel).await?,
        vec![
            folder("workspace", tenant.root_id),
            folder("report", tenant.file_id),
            folder("secret", tenant.unreadable_id),
            folder("missing", ObjectId::new_v7()),
        ],
    )?;

    let workspace = fs.lookup(ROOT_INO, "workspace").await?;
    assert_eq!(workspace.kind, Kind::Directory);
    assert_eq!(workspace.permissions, 0o700);
    assert_eq!(fs.readdir(ROOT_INO).await?[0].ino, workspace.ino);
    assert_eq!(fs.getattr(workspace.ino).await?, workspace);

    // Like the listing: not a directory, unreadable, missing, and not configured.
    for name in ["report", "secret", "missing", "other"] {
        assert_eq!(
            fs.lookup(ROOT_INO, name).await,
            Err(Errno::ENOENT),
            "{name}"
        );
    }
    Ok(())
}

async fn folders_look_up_readable_children(channel: &Channel, tenant: &Tenant) -> Result<()> {
    let fs = Fs::new(
        tenant.remote(channel).await?,
        vec![folder("workspace", tenant.root_id)],
    )?;
    let workspace = fs.lookup(ROOT_INO, "workspace").await?;

    let report = fs.lookup(workspace.ino, "report.txt").await?;
    assert_eq!(report.kind, Kind::File);
    assert_eq!(report.size, FILE_CONTENT.len() as u64);
    assert!(![ROOT_INO, workspace.ino].contains(&report.ino));
    assert_eq!(fs.getattr(report.ino).await?, report);
    // Looked up again, the object keeps its inode number.
    assert_eq!(
        fs.lookup(workspace.ino, "report.txt").await?.ino,
        report.ino
    );

    // Unreadable and missing names look missing, and a file has no children.
    for name in ["secret.txt", "missing"] {
        assert_eq!(
            fs.lookup(workspace.ino, name).await,
            Err(Errno::ENOENT),
            "{name}"
        );
    }
    assert_eq!(fs.lookup(report.ino, "a").await, Err(Errno(libc::ENOTDIR)));

    // Once the kernel forgets both lookups, the mount drops the inode.
    fs.forget(report.ino, 2);
    assert_eq!(fs.getattr(report.ino).await, Err(Errno::ENOENT));
    Ok(())
}

/// Creates the children `names` of the directory `parent`, written directly to FoundationDB, and
/// returns them in order.
async fn create_children(
    tenant_id: &str,
    parent: ObjectId,
    kind: ObjectKind,
    names: &[String],
) -> Result<Vec<ObjectResource>> {
    let mut children = Vec::with_capacity(names.len());
    for batch in names.chunks(SEED_BATCH_SIZE) {
        let tx = fdb::database()?.create_trx()?;
        let tenant = TenantResource::fetch(&tx, tenant_id)
            .await?
            .context("missing tenant")?;
        let parent = ObjectResource::fetch(&tx, &tenant, &parent)
            .await?
            .context("missing parent")?;
        let mut parent = DirectoryResource::try_from(parent)?;
        for name in batch {
            let child = parent
                .create_child(
                    &tx,
                    ObjectId::new_v7(),
                    name.clone(),
                    kind,
                    None,
                    HashMap::new(),
                )
                .await?;
            children.push(child);
        }
        tx.commit().await?;
    }
    Ok(children)
}

async fn list_returns_every_page(channel: &Channel, tenant: &Tenant) -> Result<()> {
    let remote = tenant.remote(channel).await?;
    let tenant_id = remote.current_session().await?.tenant_id;
    let directory = create_children(
        &tenant_id,
        tenant.root_id,
        ObjectKind::Directory,
        &["listing".to_owned()],
    )
    .await?
    .remove(0)
    .object_id;
    // Zero-padded, so name order is creation order.
    let names: Vec<String> = (0..MANY_ENTRIES)
        .map(|index| format!("{index:05}"))
        .collect();
    create_children(&tenant_id, directory, ObjectKind::File, &names).await?;
    let hidden = create_children(
        &tenant_id,
        directory,
        ObjectKind::File,
        &["hidden".to_owned()],
    )
    .await?
    .remove(0)
    .object_id;
    // Grants are updated on the object as read in the same transaction.
    let tx = fdb::database()?.create_trx()?;
    let resource = TenantResource::fetch(&tx, &tenant_id)
        .await?
        .context("missing tenant")?;
    let mut hidden = ObjectResource::fetch(&tx, &resource, &hidden)
        .await?
        .context("missing hidden file")?;
    hidden.update_grants(
        &tx,
        &[GrantUpdate {
            grant: Grant {
                kind: Some(grant::Kind::Deny(DenyGrant { mode: 0o4 })),
            },
            remove: false,
        }],
    )?;
    tx.commit().await?;

    let entries = remote.list(directory.into()).await?;
    // Left out: `hidden`, which the session cannot read.
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        names
    );
    assert!(entries.iter().all(|entry| {
        entry
            .object
            .as_ref()
            .is_some_and(|attr| attr.kind() == ObjectKind::File)
    }));

    for (object, expected) in [
        (tenant.file_id, Errno(libc::ENOTDIR)),
        (tenant.unreadable_id, Errno::ENOENT),
        (ObjectId::new_v7(), Errno::ENOENT),
    ] {
        let result = remote.list(object.into()).await;
        assert_eq!(result.err(), Some(expected), "listing {object}");
    }
    Ok(())
}

async fn apply_returns_one_ordered_result_per_operation(
    channel: &Channel,
    tenant: &Tenant,
) -> Result<()> {
    let remote = tenant.remote(channel).await?;
    let file = ObjectId::new_v7();
    let create = |object_id| {
        Operation::Create(CreateOperation {
            parent_id: tenant.root_id,
            name: "applied.txt".to_owned(),
            object_id,
            kind: ObjectKind::File.into(),
            mime_type: None,
            xattrs: BTreeMap::new(),
        })
    };
    let write = Operation::Write(WriteOperation {
        object_id: file,
        offset: 0,
        data: FILE_CONTENT.to_vec(),
        append: false,
    });

    let results = remote
        .apply(vec![
            create(file),
            write.clone(),
            // The name is taken; the failure does not stop the next operation.
            create(ObjectId::new_v7()),
            write.clone(),
        ])
        .await?;
    assert_eq!(results.len(), 4);
    let created = results[0].as_ref().map_err(|errno| *errno)?;
    let attr = created
        .object
        .as_ref()
        .context("missing created attributes")?;
    assert_eq!(attr.id, file.into());
    assert_eq!(attr.kind(), ObjectKind::File);
    assert!(results[1].is_ok());
    assert_eq!(results[2], Err(Errno(libc::EEXIST)));
    assert!(results[3].is_ok());
    let read = remote.read(file, 0, READ_MAX_BYTES).await?;
    assert_eq!(read.data, FILE_CONTENT);

    let results = remote
        .apply(vec![
            Operation::Remove(RemoveOperation {
                object_id: file,
                kind: ObjectKind::File.into(),
                parent_id: tenant.root_id,
            }),
            write,
        ])
        .await?;
    assert!(results[0].is_ok());
    assert_eq!(results[1], Err(Errno::ENOENT));
    assert_eq!(remote.read(file, 0, 1).await.err(), Some(Errno::ENOENT));

    assert!(remote.apply(Vec::new()).await?.is_empty());
    Ok(())
}

async fn read_files_returns_one_ordered_result_per_object(
    channel: &Channel,
    tenant: &Tenant,
) -> Result<()> {
    let remote = tenant.remote(channel).await?;
    // A readable file over `READ_MAX_BYTES`, which no `ReadFiles` reply can hold.
    let tenant_id = remote.current_session().await?.tenant_id;
    let tx = fdb::database()?.create_trx()?;
    let resource = TenantResource::fetch(&tx, &tenant_id)
        .await?
        .context("missing tenant")?;
    let mut large = ObjectResource::new_root(&resource)?;
    large.object_id = ObjectId::new_v7();
    large.parent_id = Some(tenant.root_id);
    large.name = "large.bin".to_owned();
    large.kind = ObjectKind::File;
    large.size = u64::from(READ_MAX_BYTES) + 1;
    large.create(&tx, &[]).await?;
    tx.commit().await?;

    let missing = ObjectId::new_v7();
    let objects = [
        tenant.file_id,
        large.object_id,
        tenant.root_id,
        tenant.unreadable_id,
        missing,
        tenant.file_id,
    ];
    let results = remote.read_files(&objects).await?;

    assert_eq!(results.len(), objects.len());
    for index in [0, 5] {
        let read = results[index].as_ref().map_err(|errno| *errno)?;
        let read = read.as_ref().context("file did not fit")?;
        assert_eq!(read.data, FILE_CONTENT, "result {index}");
        assert_eq!(read.object.id, tenant.file_id.into(), "result {index}");
    }
    // Too large for the reply: read it with `read` instead.
    assert_eq!(results[1], Ok(None));
    assert_eq!(results[2], Err(Errno(libc::EISDIR)));
    // An object the session cannot read looks missing.
    assert_eq!(results[3], Err(Errno::ENOENT));
    assert_eq!(results[4], Err(Errno::ENOENT));

    assert!(remote.read_files(&[]).await?.is_empty());
    let too_many = vec![tenant.file_id; READ_FILES_MAX_OBJECTS + 1];
    assert_eq!(remote.read_files(&too_many).await, Err(Errno::EINVAL));
    Ok(())
}

async fn folders_list_readable_children(channel: &Channel, tenant: &Tenant) -> Result<()> {
    let fs = Fs::new(
        tenant.remote(channel).await?,
        vec![folder("workspace", tenant.root_id)],
    )?;
    let workspace = fs.lookup(ROOT_INO, "workspace").await?;

    let entries = fs.readdir(workspace.ino).await?;
    let report = entries
        .iter()
        .find(|entry| entry.name == "report.txt")
        .context("missing report.txt")?;
    assert_eq!(report.kind, Kind::File);
    assert!(![ROOT_INO, workspace.ino].contains(&report.ino));
    // Left out: the file the session cannot read.
    assert!(!entries.iter().any(|entry| entry.name == "secret.txt"));
    // A listing counts no lookup, so the kernel cannot ask about a listed inode before looking it up.
    assert_eq!(fs.getattr(report.ino).await, Err(Errno::ENOENT));
    Ok(())
}

async fn files_read_in_ranges(channel: &Channel, tenant: &Tenant) -> Result<()> {
    let remote = tenant.remote(channel).await?;
    // A file one `Read` request cannot hold. Never written, so it reads as zeros.
    let tenant_id = remote.current_session().await?.tenant_id;
    let tx = fdb::database()?.create_trx()?;
    let resource = TenantResource::fetch(&tx, &tenant_id)
        .await?
        .context("missing tenant")?;
    let root = ObjectResource::fetch(&tx, &resource, &tenant.root_id)
        .await?
        .context("missing root")?;
    let mut sparse = DirectoryResource::try_from(root)?
        .create_child(
            &tx,
            ObjectId::new_v7(),
            "sparse.bin".to_owned(),
            ObjectKind::File,
            None,
            HashMap::new(),
        )
        .await?;
    sparse.size = u64::from(READ_MAX_BYTES) + 2;
    sparse.record_content_change(&tx, clock::now_ms()?);
    tx.commit().await?;

    let fs = Fs::new(remote, vec![folder("workspace", tenant.root_id)])?;
    let workspace = fs.lookup(ROOT_INO, "workspace").await?.ino;
    let report = fs.lookup(workspace, "report.txt").await?.ino;
    let sparse = fs.lookup(workspace, "sparse.bin").await?.ino;

    assert_eq!(fs.read(report, 1, 3).await?, &FILE_CONTENT[1..4]);
    // Reads stop at the end of the file.
    assert_eq!(fs.read(report, 2, 10).await?, &FILE_CONTENT[2..]);
    let end = FILE_CONTENT.len() as u64;
    assert!(fs.read(report, end, 10).await?.is_empty());

    // Larger than one `Read` request: the rest of the file, all of it.
    let rest = READ_MAX_BYTES as usize + 1;
    let data = fs.read(sparse, 1, READ_MAX_BYTES + 1).await?;
    assert_eq!(data.len(), rest);
    assert!(data.iter().all(|byte| *byte == 0));
    assert_eq!(fs.read(sparse, 1, READ_MAX_BYTES + 5).await?.len(), rest);

    assert_eq!(fs.read(workspace, 0, 1).await, Err(Errno(libc::EISDIR)));
    // Once the kernel forgets it, the inode is unknown.
    fs.forget(report, 1);
    assert_eq!(fs.read(report, 0, 1).await, Err(Errno::ENOENT));
    Ok(())
}
