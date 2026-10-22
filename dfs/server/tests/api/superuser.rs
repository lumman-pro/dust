use anyhow::{Context, Result};
use dfs_api::{
    auth::hash_key,
    storage::{
        fdb,
        resources::keys::{namespace_subspace, tenant_subspace},
    },
};
use dfs_protocol::{
    ObjectId,
    rpc::{
        self, ApplyRequest, CreateOperation, CreateSessionRequest, CreateTenantRequest, ErrorCode,
        ObjectKind, ReadRequest, RevokeSessionRequest, UpdateGrantsRequest, WriteOperation,
        dfs_client::DfsClient, operation::Operation,
    },
};

use super::{attach, deny};
use crate::{MASTER_KEY, error_code, serve, with_authorization};

pub(crate) async fn superuser_sessions_read_and_write_despite_denies() -> Result<()> {
    let mut client = DfsClient::new(serve().await?);
    let tenant = client
        .create_tenant(with_authorization(
            CreateTenantRequest {
                tenant_id: ObjectId::new_v7().to_string(),
                root_grants: vec![deny(6)],
            },
            &format!("Bearer {MASTER_KEY}"),
        )?)
        .await?
        .into_inner();
    let tenant_authorization = format!("Bearer {}", tenant.tenant_key);
    let mut sessions = Vec::new();
    for subjects in [
        vec!["superuser"],
        vec!["Superuser", "superuser ", "u:superuser"],
    ] {
        let session = client
            .create_session(with_authorization(
                CreateSessionRequest {
                    subjects: subjects.into_iter().map(str::to_owned).collect(),
                },
                &tenant_authorization,
            )?)
            .await?
            .into_inner();
        sessions.push(session);
    }
    let superuser_authorization = format!("Bearer {}", sessions[0].session_key);
    let file_id = ObjectId::new_v7();
    let batch = client
        .apply(with_authorization(
            ApplyRequest {
                locks: vec![],
                operations: vec![rpc::Operation {
                    operation: Some(Operation::Create(CreateOperation {
                        parent_id: tenant.root_id,
                        object_id: file_id,
                        name: "file.txt".to_owned(),
                        kind: ObjectKind::File.into(),
                        ..Default::default()
                    })),
                }],
            },
            &superuser_authorization,
        )?)
        .await?
        .into_inner();
    assert_eq!(batch.results.len(), 1);
    assert!(batch.results[0].error.is_none());
    assert_eq!(
        batch.results[0]
            .mutation
            .as_ref()
            .and_then(|mutation| mutation.object.as_ref())
            .context("missing created file")?
            .mode,
        0o600
    );
    attach(&mut client, &tenant_authorization, file_id, deny(6)).await?;

    // Both inherited and local DENY apply to ordinary sessions, but not the reserved subject.
    for (session, privileged) in [(&sessions[1], false), (&sessions[0], true)] {
        let authorization = format!("Bearer {}", session.session_key);
        let batch = client
            .apply(with_authorization(
                ApplyRequest {
                    locks: vec![],
                    operations: vec![rpc::Operation {
                        operation: Some(Operation::Write(WriteOperation {
                            object_id: file_id,
                            data: b"contents".to_vec(),
                            offset: 0,
                            append: false,
                        })),
                    }],
                },
                &authorization,
            )?)
            .await?
            .into_inner();
        let result = batch
            .results
            .into_iter()
            .next()
            .context("missing write result")?;
        let read = client
            .read(with_authorization(
                ReadRequest {
                    object_id: file_id,
                    offset: 0,
                    length: 32,
                },
                &authorization,
            )?)
            .await;
        if privileged {
            assert!(result.error.is_none());
            assert!(result.mutation.is_some());
            let read = read?.into_inner();
            assert_eq!(read.data, b"contents");
            assert_eq!(read.object.mode, 0o600);
        } else {
            assert!(result.mutation.is_none());
            assert_eq!(
                result.error.context("missing write error")?.code(),
                ErrorCode::Forbidden
            );
            assert_eq!(
                error_code(&read.err().context("ordinary read must fail")?)?,
                ErrorCode::NotFound
            );
        }
    }

    // Object privileges do not authorize tenant administration.
    let error = client
        .update_grants(with_authorization(
            UpdateGrantsRequest {
                object_id: file_id,
                changes: vec![],
            },
            &superuser_authorization,
        )?)
        .await
        .err()
        .context("superuser session must not authorize tenant-key RPCs")?;
    assert_eq!(error_code(&error)?, ErrorCode::Unauthenticated);

    for session in sessions {
        client
            .revoke_session(with_authorization(
                RevokeSessionRequest {
                    session_id: session.id,
                },
                &tenant_authorization,
            )?)
            .await?;
    }
    let tx = fdb::database()?.create_trx()?;
    let (begin, end) = tenant_subspace(&tenant.tenant_id).range();
    tx.clear_range(&begin, &end);
    tx.clear(&namespace_subspace().pack(&("tenant-key", hash_key(&tenant.tenant_key).as_slice())));
    tx.commit().await?;
    Ok(())
}
