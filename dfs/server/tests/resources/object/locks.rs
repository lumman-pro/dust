use super::*;
use crate::storage::{
    fdb,
    resources::{
        SUPERUSER_SUBJECT,
        directory::DirectoryResource,
        file::{self, FileResource},
        tenant::TenantResource,
    },
};
use anyhow::{Context, Result};
use dfs_protocol::rpc::WriteOperation;

pub(crate) async fn run() -> Result<()> {
    lock_checks_require_current_tokens().await?;
    expired_lock_invalidation_is_transactional().await?;
    lock_checks_conflict_with_concurrent_acquisition().await?;
    expiry_grace_and_refresh_never_shorten().await?;
    unlocked_mutation_prevents_slow_replica_revival().await?;
    concurrent_refresh_conflicts_with_takeover().await?;
    cleanup_preserves_refreshed_locks().await?;
    cleanup_conflicts_with_concurrent_refresh().await
}

async fn acquire(tenant_id: &str, object_id: ObjectId, now_ms: u64) -> Result<LockState> {
    let tx = fdb::database()?.create_trx()?;
    let lock = ObjectResource::lock_at(&tx, tenant_id, object_id, None, now_ms).await?;
    tx.commit().await?;
    Ok(lock)
}

async fn lock_checks_require_current_tokens() -> Result<()> {
    let (tenant, _) = TenantResource::new(ObjectId::new_v7().to_string())?;
    let (session, _) = SessionResource::new(&tenant, vec![])?;
    let object_id = tenant.root_id;
    let lock = acquire(&tenant.tenant_id, object_id, clock::now_ms()?).await?;
    let tx = fdb::database()?.create_trx()?;
    assert!(matches!(
        ObjectResource::check_locks(&tx, &session, &[object_id], &LockTokens::default()).await,
        Err(storage::Error::Resource(Error::WouldBlock))
    ));
    let wrong = LockTokens::new(vec![ObjectLock {
        object_id,
        lock_id: ObjectId::new_v7().as_bytes().to_vec(),
    }])?;
    assert!(matches!(
        ObjectResource::check_locks(&tx, &session, &[object_id], &wrong).await,
        Err(storage::Error::Resource(Error::LockLost))
    ));
    let tokens = LockTokens::new(vec![ObjectLock {
        object_id,
        lock_id: lock.lock_id.clone(),
    }])?;
    assert!(
        ObjectResource::check_locks(&tx, &session, &[object_id], &tokens)
            .await?
            .0
            .is_empty()
    );
    let (other_tenant, _) = TenantResource::new(ObjectId::new_v7().to_string())?;
    let (other_session, _) = SessionResource::new(&other_tenant, vec![])?;
    assert!(
        ObjectResource::check_locks(&tx, &other_session, &[object_id], &LockTokens::default())
            .await?
            .0
            .is_empty()
    );
    assert!(matches!(
        ObjectResource::check_locks(&tx, &other_session, &[object_id], &tokens).await,
        Err(storage::Error::Resource(Error::LockLost))
    ));
    ObjectResource::unlock(&tx, &tenant.tenant_id, object_id, &lock.lock_id).await?;
    tx.commit().await?;
    let tx = fdb::database()?.create_trx()?;
    assert!(
        ObjectResource::check_locks(&tx, &session, &[object_id], &LockTokens::default())
            .await?
            .0
            .is_empty()
    );
    assert!(matches!(
        ObjectResource::check_locks(&tx, &session, &[object_id], &tokens).await,
        Err(storage::Error::Resource(Error::LockLost))
    ));
    Ok(())
}

async fn expired_lock_invalidation_is_transactional() -> Result<()> {
    let (tenant, _) = TenantResource::new(ObjectId::new_v7().to_string())?;
    let (session, _) = SessionResource::new(&tenant, vec![])?;
    let object_id = tenant.root_id;
    let lock = acquire(
        &tenant.tenant_id,
        object_id,
        clock::now_ms()? - LOCK_TTL_MS - LOCK_TAKEOVER_GRACE_MS,
    )
    .await?;
    let expiry_key = ObjectResource::lock_expiry_key(&tenant.tenant_id, object_id, lock.expires_at);
    for commit in [false, true] {
        let tx = fdb::database()?.create_trx()?;
        let expired = ObjectResource::check_locks(
            &tx,
            &session,
            &[object_id, object_id],
            &LockTokens::default(),
        )
        .await?;
        assert_eq!(expired, ExpiredLocks(vec![(object_id, lock.clone())]));
        assert_eq!(
            ObjectResource::fetch_lock(&tx, &tenant.tenant_id, object_id).await?,
            Some(lock.clone())
        );
        assert!(tx.get(&expiry_key, false).await?.is_some());
        expired.clear(&tx, &tenant.tenant_id);
        assert!(
            ObjectResource::fetch_lock(&tx, &tenant.tenant_id, object_id)
                .await?
                .is_none()
        );
        assert!(tx.get(&expiry_key, false).await?.is_none());
        if commit {
            tx.commit().await?;
        }
    }
    let tx = fdb::database()?.create_trx()?;
    assert!(
        ObjectResource::fetch_lock(&tx, &tenant.tenant_id, object_id)
            .await?
            .is_none()
    );
    assert!(tx.get(&expiry_key, false).await?.is_none());
    assert!(matches!(
        ObjectResource::lock_at(
            &tx,
            &tenant.tenant_id,
            object_id,
            Some(&lock.lock_id),
            lock.expires_at - 1,
        )
        .await,
        Err(storage::Error::Resource(Error::LockLost))
    ));
    Ok(())
}

async fn lock_checks_conflict_with_concurrent_acquisition() -> Result<()> {
    let (tenant, _) = TenantResource::new(ObjectId::new_v7().to_string())?;
    let (session, _) = SessionResource::new(&tenant, vec![])?;
    let object_id = tenant.root_id;
    let tx = fdb::database()?.create_trx()?;
    assert!(
        ObjectResource::check_locks(&tx, &session, &[object_id], &LockTokens::default())
            .await?
            .0
            .is_empty()
    );
    let lock = acquire(&tenant.tenant_id, object_id, clock::now_ms()?).await?;
    let mutation_key = tenant_subspace(&tenant.tenant_id).pack(&"mutation");
    tx.set(&mutation_key, b"must not commit");
    assert_eq!(
        tx.commit()
            .await
            .err()
            .context("expected lock acquisition conflict")?
            .code(),
        1020
    );
    let tx = fdb::database()?.create_trx()?;
    assert!(tx.get(&mutation_key, false).await?.is_none());
    assert_eq!(
        ObjectResource::fetch_lock(&tx, &tenant.tenant_id, object_id).await?,
        Some(lock.clone())
    );
    ObjectResource::unlock(&tx, &tenant.tenant_id, object_id, &lock.lock_id).await?;
    tx.commit().await?;
    Ok(())
}

async fn expiry_grace_and_refresh_never_shorten() -> Result<()> {
    let tenant_id = ObjectId::new_v7().to_string();
    let object_id = ObjectId::new_v7();
    let lock = acquire(&tenant_id, object_id, 10_000).await?;
    let tx = fdb::database()?.create_trx()?;
    let refreshed =
        ObjectResource::lock_at(&tx, &tenant_id, object_id, Some(&lock.lock_id), 9_000).await?;
    assert_eq!(refreshed, lock);
    tx.commit().await?;
    let tokens = LockTokens::new(vec![ObjectLock {
        object_id,
        lock_id: lock.lock_id.clone(),
    }])?;
    for now_ms in [
        lock.expires_at,
        lock.expires_at + LOCK_TAKEOVER_GRACE_MS - 1,
    ] {
        let tx = fdb::database()?.create_trx()?;
        assert!(matches!(
            ObjectResource::lock_at(&tx, &tenant_id, object_id, None, now_ms).await,
            Err(storage::Error::Resource(Error::WouldBlock))
        ));
        assert!(matches!(
            ObjectResource::lock_at(&tx, &tenant_id, object_id, Some(&lock.lock_id), now_ms).await,
            Err(storage::Error::Resource(Error::LockLost))
        ));
        assert!(matches!(
            ObjectResource::check_locks_at(
                &tx,
                &tenant_id,
                &[object_id],
                &LockTokens::default(),
                now_ms
            )
            .await,
            Err(storage::Error::Resource(Error::WouldBlock))
        ));
        assert!(matches!(
            ObjectResource::check_locks_at(&tx, &tenant_id, &[object_id], &tokens, now_ms).await,
            Err(storage::Error::Resource(Error::LockLost))
        ));
    }
    let replacement = acquire(
        &tenant_id,
        object_id,
        lock.expires_at + LOCK_TAKEOVER_GRACE_MS,
    )
    .await?;
    assert_ne!(replacement.lock_id, lock.lock_id);
    let tx = fdb::database()?.create_trx()?;
    ObjectResource::unlock(&tx, &tenant_id, object_id, &lock.lock_id).await?;
    assert_eq!(
        ObjectResource::fetch_lock(&tx, &tenant_id, object_id).await?,
        Some(replacement.clone())
    );
    ObjectResource::unlock(&tx, &tenant_id, object_id, &replacement.lock_id).await?;
    tx.commit().await?;
    Ok(())
}

async fn file_with_expired_lock() -> Result<(SessionResource, ObjectId, LockState)> {
    let (tenant, _) = TenantResource::new(ObjectId::new_v7().to_string())?;
    let (session, _) = SessionResource::new(&tenant, vec![SUPERUSER_SUBJECT.to_owned()])?;
    let tx = fdb::database()?.create_trx()?;
    let root = ObjectResource::new_root(&tenant)?;
    root.create(&tx, &[]).await?;
    let file = DirectoryResource::try_from(root)?
        .create_child(
            &tx,
            ObjectId::new_v7(),
            "locked.txt".to_owned(),
            ObjectKind::File,
            None,
            HashMap::new(),
        )
        .await?;
    tx.commit().await?;
    let lock = acquire(
        &tenant.tenant_id,
        file.object_id,
        clock::now_ms()? - LOCK_TTL_MS - LOCK_TAKEOVER_GRACE_MS,
    )
    .await?;
    Ok((session, file.object_id, lock))
}

async fn unlocked_mutation_prevents_slow_replica_revival() -> Result<()> {
    let (session, object_id, lock) = file_with_expired_lock().await?;
    let tenant_id = &session.tenant.tenant_id;
    let write = WriteOperation {
        object_id,
        offset: 0,
        data: b"unlocked writer".to_vec(),
        append: false,
    };
    let tx = fdb::database()?.create_trx()?;
    assert!(matches!(
        FileResource::apply_write(
            &tx,
            &session,
            WriteOperation {
                offset: u64::MAX,
                ..write.clone()
            },
            &LockTokens::default(),
        )
        .await,
        Err(storage::Error::Resource(file::Error::InvalidRange))
    ));
    tx.commit().await?;
    let tx = fdb::database()?.create_trx()?;
    assert_eq!(
        ObjectResource::fetch_lock(&tx, tenant_id, object_id).await?,
        Some(lock.clone())
    );
    assert!(
        tx.get(
            &ObjectResource::lock_expiry_key(tenant_id, object_id, lock.expires_at),
            false
        )
        .await?
        .is_some()
    );
    let unchanged = ObjectResource::fetch(&tx, &session.tenant, &object_id)
        .await?
        .context("missing file")?;
    assert_eq!(unchanged.size, 0);
    assert!(
        FileResource::try_from(unchanged)?
            .read(&tx, 0, 100)
            .await?
            .is_empty()
    );
    FileResource::apply_write(&tx, &session, write.clone(), &LockTokens::default()).await?;
    tx.commit().await?;
    let tx = fdb::database()?.create_trx()?;
    assert!(matches!(
        ObjectResource::lock_at(
            &tx,
            tenant_id,
            object_id,
            Some(&lock.lock_id),
            lock.expires_at - 1,
        )
        .await,
        Err(storage::Error::Resource(Error::LockLost))
    ));
    let tokens = LockTokens::new(vec![ObjectLock {
        object_id,
        lock_id: lock.lock_id.clone(),
    }])?;
    assert!(matches!(
        ObjectResource::check_locks_at(&tx, tenant_id, &[object_id], &tokens, lock.expires_at - 1)
            .await,
        Err(storage::Error::Resource(Error::LockLost))
    ));
    assert!(matches!(
        FileResource::apply_write(&tx, &session, write.clone(), &tokens).await,
        Err(storage::Error::Resource(file::Error::Object(
            Error::LockLost
        )))
    ));
    let object = ObjectResource::fetch(&tx, &session.tenant, &object_id)
        .await?
        .context("missing file")?;
    assert_eq!(
        FileResource::try_from(object)?.read(&tx, 0, 100).await?,
        write.data
    );
    assert!(
        tx.get(
            &ObjectResource::lock_expiry_key(tenant_id, object_id, lock.expires_at),
            false
        )
        .await?
        .is_none()
    );
    let (begin, end) = tenant_subspace(tenant_id).range();
    tx.clear_range(&begin, &end);
    tx.commit().await?;
    Ok(())
}

async fn concurrent_refresh_conflicts_with_takeover() -> Result<()> {
    for refresh_first in [true, false] {
        let (session, object_id, lock) = file_with_expired_lock().await?;
        let tenant_id = &session.tenant.tenant_id;
        let refresh = fdb::database()?.create_trx()?;
        let refreshed = ObjectResource::lock_at(
            &refresh,
            tenant_id,
            object_id,
            Some(&lock.lock_id),
            lock.expires_at - 1,
        )
        .await?;
        let takeover = fdb::database()?.create_trx()?;
        let write = WriteOperation {
            object_id,
            offset: 0,
            data: b"unlocked writer".to_vec(),
            append: false,
        };
        FileResource::apply_write(&takeover, &session, write.clone(), &LockTokens::default())
            .await?;
        let (first, second) = if refresh_first {
            (refresh, takeover)
        } else {
            (takeover, refresh)
        };
        first.commit().await?;
        assert_eq!(
            second
                .commit()
                .await
                .err()
                .context("expected conflict")?
                .code(),
            1020
        );
        let retry = fdb::database()?.create_trx()?;
        if refresh_first {
            assert!(matches!(
                FileResource::apply_write(&retry, &session, write.clone(), &LockTokens::default())
                    .await,
                Err(storage::Error::Resource(file::Error::Object(
                    Error::WouldBlock
                )))
            ));
        } else {
            assert!(matches!(
                ObjectResource::lock_at(
                    &retry,
                    tenant_id,
                    object_id,
                    Some(&lock.lock_id),
                    lock.expires_at - 1,
                )
                .await,
                Err(storage::Error::Resource(Error::LockLost))
            ));
        }
        retry.commit().await?;
        let tx = fdb::database()?.create_trx()?;
        let object = ObjectResource::fetch(&tx, &session.tenant, &object_id)
            .await?
            .context("missing file")?;
        let data = FileResource::try_from(object)?.read(&tx, 0, 100).await?;
        assert_eq!(data, if refresh_first { vec![] } else { write.data });
        assert_eq!(
            ObjectResource::fetch_lock(&tx, tenant_id, object_id).await?,
            refresh_first.then_some(refreshed.clone())
        );
        assert!(
            tx.get(
                &ObjectResource::lock_expiry_key(tenant_id, object_id, lock.expires_at),
                false
            )
            .await?
            .is_none()
        );
        assert_eq!(
            tx.get(
                &ObjectResource::lock_expiry_key(tenant_id, object_id, refreshed.expires_at),
                false
            )
            .await?
            .is_some(),
            refresh_first
        );
        ObjectResource::unlock(&tx, tenant_id, object_id, &lock.lock_id).await?;
        let (begin, end) = tenant_subspace(tenant_id).range();
        tx.clear_range(&begin, &end);
        tx.commit().await?;
    }
    Ok(())
}

async fn cleanup_preserves_refreshed_locks() -> Result<()> {
    let tenant_id = ObjectId::new_v7().to_string();
    let object_id = ObjectId::new_v7();
    let lock = acquire(&tenant_id, object_id, 10_000).await?;
    let tx = fdb::database()?.create_trx()?;
    let refreshed =
        ObjectResource::lock_at(&tx, &tenant_id, object_id, Some(&lock.lock_id), 20_000).await?;
    tx.commit().await?;
    let tx = fdb::database()?.create_trx()?;
    assert!(
        tx.get(
            &ObjectResource::lock_expiry_key(&tenant_id, object_id, lock.expires_at),
            false,
        )
        .await?
        .is_none()
    );
    ObjectResource::clear_expired_locks(&tx, lock.expires_at + LOCK_TAKEOVER_GRACE_MS).await?;
    assert_eq!(
        ObjectResource::fetch_lock(&tx, &tenant_id, object_id).await?,
        Some(refreshed.clone())
    );
    ObjectResource::clear_expired_locks(&tx, refreshed.expires_at + LOCK_TAKEOVER_GRACE_MS - 1)
        .await?;
    assert!(
        ObjectResource::fetch_lock(&tx, &tenant_id, object_id)
            .await?
            .is_some()
    );
    ObjectResource::clear_expired_locks(&tx, refreshed.expires_at + LOCK_TAKEOVER_GRACE_MS).await?;
    assert!(
        ObjectResource::fetch_lock(&tx, &tenant_id, object_id)
            .await?
            .is_none()
    );
    tx.commit().await?;
    Ok(())
}

async fn cleanup_conflicts_with_concurrent_refresh() -> Result<()> {
    for refresh_first in [true, false] {
        let tenant_id = ObjectId::new_v7().to_string();
        let object_id = ObjectId::new_v7();
        let lock = acquire(&tenant_id, object_id, 10_000).await?;
        let refresh = fdb::database()?.create_trx()?;
        let refreshed =
            ObjectResource::lock_at(&refresh, &tenant_id, object_id, Some(&lock.lock_id), 20_000)
                .await?;
        let cleanup = fdb::database()?.create_trx()?;
        let sweep_at_ms = lock.expires_at + LOCK_TAKEOVER_GRACE_MS;
        ObjectResource::clear_expired_locks(&cleanup, sweep_at_ms).await?;
        let (first, second) = if refresh_first {
            (refresh, cleanup)
        } else {
            (cleanup, refresh)
        };
        first.commit().await?;
        assert_eq!(
            second
                .commit()
                .await
                .err()
                .context("expected conflict")?
                .code(),
            1020
        );
        let retry = fdb::database()?.create_trx()?;
        if refresh_first {
            ObjectResource::clear_expired_locks(&retry, sweep_at_ms).await?;
        } else {
            assert!(matches!(
                ObjectResource::lock_at(
                    &retry,
                    &tenant_id,
                    object_id,
                    Some(&lock.lock_id),
                    20_000,
                )
                .await,
                Err(storage::Error::Resource(Error::LockLost))
            ));
        }
        retry.commit().await?;
        let tx = fdb::database()?.create_trx()?;
        assert_eq!(
            ObjectResource::fetch_lock(&tx, &tenant_id, object_id).await?,
            refresh_first.then_some(refreshed.clone())
        );
        ObjectResource::unlock(&tx, &tenant_id, object_id, &lock.lock_id).await?;
        tx.commit().await?;
    }
    Ok(())
}
