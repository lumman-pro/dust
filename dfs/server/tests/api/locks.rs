use anyhow::{Context, Result};
use dfs_api::{
    clock,
    storage::{
        fdb,
        resources::{
            keys::{namespace_subspace, tenant_subspace},
            object::ObjectResource,
            tenant::TenantResource,
        },
    },
};
use dfs_protocol::{
    ObjectId,
    rpc::{
        self, ApplyRequest, CreateSessionRequest, CreateTenantRequest, ErrorCode, LockRequest,
        ObjectKind, ObjectLock, UpdateOperation, WriteOperation, dfs_client::DfsClient,
        operation::Operation,
    },
};
use foundationdb::tuple::pack;

use super::{allow, create_directory_child};
use crate::{MASTER_KEY, error_code, serve, with_authorization};

pub(crate) async fn locks_enforce_ownership_grace_and_atomic_invalidation() -> Result<()> {
    let mut client = DfsClient::new(serve().await?);
    let tenant = client
        .create_tenant(with_authorization(
            CreateTenantRequest {
                tenant_id: ObjectId::new_v7().to_string(),
                root_grants: vec![allow("writer", 0o6), allow("reader", 0o4)],
            },
            &format!("Bearer {MASTER_KEY}"),
        )?)
        .await?
        .into_inner();
    let tenant_authorization = format!("Bearer {}", tenant.tenant_key);
    let session = client
        .create_session(with_authorization(
            CreateSessionRequest {
                subjects: vec!["writer".into()],
            },
            &tenant_authorization,
        )?)
        .await?
        .into_inner();
    let authorization = format!("Bearer {}", session.session_key);
    let reader = client
        .create_session(with_authorization(
            CreateSessionRequest {
                subjects: vec!["reader".into()],
            },
            &tenant_authorization,
        )?)
        .await?
        .into_inner();
    let tx = fdb::database()?.create_trx()?;
    let resource = TenantResource::fetch(&tx, &tenant.tenant_id)
        .await?
        .context("tenant missing")?;
    let file =
        create_directory_child(&tx, &resource, &tenant.root_id, "locked", ObjectKind::File).await?;
    tx.commit().await?;
    let before = ObjectResource::fetch(&fdb::database()?.create_trx()?, &resource, &file)
        .await?
        .context("file missing")?;
    let denied = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &format!("Bearer {}", reader.session_key),
        )?)
        .await
        .err()
        .context("expected forbidden")?;
    assert_eq!(error_code(&denied)?, ErrorCode::Forbidden);
    let lock = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    let conflict = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected contention")?;
    assert_eq!(error_code(&conflict)?, ErrorCode::WouldBlock);
    let refreshed = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: Some(lock.lock_id.clone()),
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(refreshed.lock_id, lock.lock_id);
    assert!(refreshed.expires_at >= lock.expires_at);
    let after = ObjectResource::fetch(&fdb::database()?.create_trx()?, &resource, &file)
        .await?
        .context("file missing")?;
    assert_eq!(
        (before.attr_version, before.content_version, before.ctime_ms),
        (after.attr_version, after.content_version, after.ctime_ms)
    );
    let update = rpc::Operation {
        operation: Some(Operation::Update(UpdateOperation {
            object_id: file,
            ..Default::default()
        })),
    };
    let blocked = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update.clone()],
                locks: vec![],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(
        blocked.results[0]
            .error
            .as_ref()
            .context("expected blocked mutation")?
            .code(),
        ErrorCode::WouldBlock
    );
    let proof = ObjectLock {
        object_id: file,
        lock_id: lock.lock_id.clone(),
    };
    let success = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update.clone()],
                locks: vec![proof.clone()],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert!(success.results[0].mutation.is_some());
    let duplicate = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update.clone()],
                locks: vec![proof.clone(), proof.clone()],
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected duplicate rejection")?;
    assert_eq!(error_code(&duplicate)?, ErrorCode::InvalidInput);
    let malformed = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: Some(vec![0; 16]),
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected malformed rejection")?;
    assert_eq!(error_code(&malformed)?, ErrorCode::InvalidInput);

    let key =
        tenant_subspace(&tenant.tenant_id).pack(&("object", file.as_bytes().as_slice(), "lock"));
    let expiry_key = |expires_at_ms: u64| {
        namespace_subspace().pack(&(
            "lock-expiry",
            expires_at_ms.to_be_bytes().as_slice(),
            tenant.tenant_id.as_str(),
            file.as_bytes().as_slice(),
        ))
    };
    let tx = fdb::database()?.create_trx()?;
    let grace_expiry_ms = clock::now_ms()?;
    tx.clear(&expiry_key(refreshed.expires_at));
    tx.set(&key, &pack(&(lock.lock_id.as_slice(), grace_expiry_ms)));
    tx.set(&expiry_key(grace_expiry_ms), &[]);
    tx.commit().await?;
    let blocked = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update.clone()],
                locks: vec![],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(
        blocked.results[0]
            .error
            .as_ref()
            .context("expected grace")?
            .code(),
        ErrorCode::WouldBlock
    );
    let lost = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update.clone()],
                locks: vec![proof.clone()],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(
        lost.results[0]
            .error
            .as_ref()
            .context("expected expired token")?
            .code(),
        ErrorCode::LockLost
    );

    let tx = fdb::database()?.create_trx()?;
    let expired_ms = clock::now_ms()? - 10_000;
    tx.clear(&expiry_key(grace_expiry_ms));
    tx.set(&key, &pack(&(lock.lock_id.as_slice(), expired_ms)));
    tx.set(&expiry_key(expired_ms), &[]);
    tx.commit().await?;
    let invalid = rpc::Operation {
        operation: Some(Operation::Write(WriteOperation {
            object_id: file,
            offset: u64::MAX,
            data: vec![1],
            append: false,
        })),
    };
    let rejected = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![invalid],
                locks: vec![],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(
        rejected.results[0]
            .error
            .as_ref()
            .context("expected invalid write")?
            .code(),
        ErrorCode::InvalidInput
    );
    assert!(
        fdb::database()?
            .create_trx()?
            .get(&key, false)
            .await?
            .is_some()
    );
    let success = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update.clone()],
                locks: vec![],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert!(success.results[0].mutation.is_some());
    let tx = fdb::database()?.create_trx()?;
    assert!(tx.get(&key, false).await?.is_none());
    assert!(tx.get(&expiry_key(expired_ms), false).await?.is_none());
    let lost = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: Some(lock.lock_id),
            },
            &authorization,
        )?)
        .await
        .err()
        .context("expected invalidated token")?;
    assert_eq!(error_code(&lost)?, ErrorCode::LockLost);
    let replacement = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    client
        .unlock(with_authorization(proof, &authorization)?)
        .await?;
    let conflict = client
        .lock(with_authorization(
            LockRequest {
                object_id: file,
                lock_id: None,
            },
            &authorization,
        )?)
        .await
        .err()
        .context("stale unlock must preserve replacement")?;
    assert_eq!(error_code(&conflict)?, ErrorCode::WouldBlock);
    client
        .unlock(with_authorization(
            ObjectLock {
                object_id: file,
                lock_id: replacement.lock_id,
            },
            &authorization,
        )?)
        .await?;
    let root_lock = client
        .lock(with_authorization(
            LockRequest {
                object_id: tenant.root_id,
                lock_id: None,
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    let operations = vec![
        Operation::Create(rpc::CreateOperation {
            parent_id: tenant.root_id,
            object_id: ObjectId::new_v7(),
            name: "blocked".into(),
            kind: ObjectKind::File.into(),
            ..Default::default()
        }),
        Operation::Move(rpc::MoveOperation {
            object_id: file,
            parent_id: tenant.root_id,
            name: "blocked-rename".into(),
            ..Default::default()
        }),
        Operation::Remove(rpc::RemoveOperation {
            object_id: file,
            parent_id: tenant.root_id,
            kind: ObjectKind::File.into(),
        }),
    ];
    let result = client
        .apply(with_authorization(
            ApplyRequest {
                operations: operations
                    .into_iter()
                    .map(|operation| rpc::Operation {
                        operation: Some(operation),
                    })
                    .collect(),
                locks: vec![],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(result.results.len(), 3);
    for result in result.results {
        assert_eq!(
            result
                .error
                .context("parent lock must block mutation")?
                .code(),
            ErrorCode::WouldBlock
        );
    }
    let result = client
        .apply(with_authorization(
            ApplyRequest {
                operations: vec![update],
                locks: vec![],
            },
            &authorization,
        )?)
        .await?
        .into_inner();
    assert!(result.results[0].mutation.is_some());
    client
        .unlock(with_authorization(
            ObjectLock {
                object_id: tenant.root_id,
                lock_id: root_lock.lock_id,
            },
            &authorization,
        )?)
        .await?;
    Ok(())
}
