use std::collections::HashMap;

use clap::Parser;
use dust::search_stores::search_store::{ElasticsearchSearchStore, INDEX_VERSIONS};
use elasticsearch::indices::{IndicesCreateParts, IndicesExistsAliasParts, IndicesExistsParts};
use http::StatusCode;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(
        long,
        help = "The index name (without the version), all registered indices when omitted"
    )]
    index_name: Option<String>,

    #[arg(
        long,
        help = "The version of the index, the registered version when omitted"
    )]
    index_version: Option<u32>,

    #[arg(long, help = "Skip confirmation")]
    skip_confirmation: bool,

    #[arg(long, help = "Remove previous alias")]
    remove_previous_alias: bool,
}

/*
 * Create indices in Elasticsearch for core
 *
 * Usage:
 * cargo run --bin elasticsearch_create_index -- [--index-name <index_name>] [--index-version <version>] [--skip-confirmation] [--remove-previous-alias]
 *
 * Without --index-name, creates every index in INDEX_VERSIONS at its current version, repairing missing aliases for existing indices.
 * Look for index settings and mappings in src/search_stores/indices/[index_name]_[version].settings.[region].json
 * Create each index with the given settings and mappings at [index_name]_[version], and set the alias to [index_name]
 */
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // parse args and env vars
    let args = Args::parse();

    if args.index_name.is_none() && (args.index_version.is_some() || args.remove_previous_alias) {
        return Err(anyhow::anyhow!(
            "--index-version and --remove-previous-alias require --index-name"
        )
        .into());
    }

    let targets: Vec<(String, u32)> = match &args.index_name {
        Some(index_name) => {
            let index_version = match args.index_version {
                Some(v) => v,
                None => registered_version(index_name)?,
            };
            vec![(index_name.clone(), index_version)]
        }
        None => INDEX_VERSIONS
            .iter()
            .map(|(name, version)| (name.to_string(), *version))
            .collect(),
    };

    if args.remove_previous_alias && targets[0].1 == 1 {
        return Err(anyhow::anyhow!("Cannot remove previous alias for version 1").into());
    }

    let url = std::env::var("ELASTICSEARCH_URL").expect("ELASTICSEARCH_URL must be set");
    let username =
        std::env::var("ELASTICSEARCH_USERNAME").expect("ELASTICSEARCH_USERNAME must be set");
    let password =
        std::env::var("ELASTICSEARCH_PASSWORD").expect("ELASTICSEARCH_PASSWORD must be set");

    let region = match std::env::var("NODE_ENV").unwrap_or_default().as_str() {
        "development" => "local".to_string(),
        _ => std::env::var("REGION").expect("REGION must be set"),
    };

    // create ES client
    let search_store = ElasticsearchSearchStore::new(&url, &username, &password).await?;

    for (index_name, index_version) in targets {
        create_index(
            &search_store,
            &index_name,
            index_version,
            &region,
            args.skip_confirmation,
            args.remove_previous_alias,
        )
        .await?;
    }

    Ok(())
}

fn registered_version(index_name: &str) -> Result<u32, Box<dyn std::error::Error>> {
    match INDEX_VERSIONS.iter().find(|(name, _)| name == &index_name) {
        Some((_, version)) => Ok(*version),
        None => {
            let available = INDEX_VERSIONS
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>()
                .join(", ");
            Err(anyhow::anyhow!(
                "Index '{}' is not configured in INDEX_VERSIONS. Available indices: {}",
                index_name,
                available
            )
            .into())
        }
    }
}

/**
 * @cc [owner:flvndvd,label:backend] repair-missing-index-alias
 * When the index exists and its alias is absent, restore the write alias without
 * recreating the index or changing its mappings or documents.
 */
/**
 * @cc [owner:flvndvd,label:backend] preserve-existing-index-alias
 * When reusing an existing index, preserve any existing alias, including one
 * pointing to a different version.
 */
async fn create_index(
    search_store: &ElasticsearchSearchStore,
    index_name: &str,
    index_version: u32,
    region: &str,
    skip_confirmation: bool,
    remove_previous_alias: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let index_fullname = format!("core.{}_{}", index_name, index_version);
    let index_alias = format!("core.{}", index_name);
    let index_previous_fullname = format!("core.{}_{}", index_name, index_version - 1);

    let response = search_store
        .client
        .indices()
        .exists(IndicesExistsParts::Index(&[index_fullname.as_str()]))
        .send()
        .await?;

    let index_exists = match response.status_code() {
        StatusCode::OK => true,
        StatusCode::NOT_FOUND => false,
        status => return Err(anyhow::anyhow!("Failed to check index: {}", status).into()),
    };

    if index_exists {
        let response = search_store
            .client
            .indices()
            .exists_alias(IndicesExistsAliasParts::Name(&[index_alias.as_str()]))
            .send()
            .await?;
        match response.status_code() {
            StatusCode::OK => {
                println!(
                    "Index {} already exists, preserving alias {}",
                    index_fullname, index_alias
                );
                return Ok(());
            }
            StatusCode::NOT_FOUND => {}
            status => return Err(anyhow::anyhow!("Failed to check alias: {}", status).into()),
        }
    }

    // confirm creation
    if !skip_confirmation {
        println!(
            "CHECK: Initialize index '{}' with alias '{}' in region '{}' (remove previous alias: {})? (y to confirm)",
            index_fullname, index_alias, region, remove_previous_alias
        );
        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        if input.trim() != "y" {
            return Err(anyhow::anyhow!("Aborted").into());
        }
    }

    if !index_exists {
        // get index settings and mappings, parse them as json
        let settings_path = format!(
            "src/search_stores/indices/{}_{}.settings.{}.json",
            index_name,
            index_version,
            region.to_lowercase()
        );
        let mappings_path = format!(
            "src/search_stores/indices/{}_{}.mappings.json",
            index_name, index_version
        );

        // catch errors, provide the error message
        let settings_raw = std::fs::read_to_string(&settings_path).expect(&format!(
            "Failed to read settings file at {}: {:?}",
            settings_path,
            std::io::Error::last_os_error()
        ));
        let mappings_raw = std::fs::read_to_string(&mappings_path).expect(&format!(
            "Failed to read mappings file at {}: {:?}",
            mappings_path,
            std::io::Error::last_os_error()
        ));
        let settings: HashMap<String, serde_json::Value> = serde_json::from_str(&settings_raw)
            .expect(&format!(
                "Failed to parse settings file at {settings_path}: {:?}",
                std::io::Error::last_os_error()
            ));
        let mappings: HashMap<String, serde_json::Value> = serde_json::from_str(&mappings_raw)
            .expect(&format!(
                "Failed to parse mappings file at {mappings_path}: {:?}",
                std::io::Error::last_os_error()
            ));

        let body = serde_json::json!({
            "settings": settings,
            "mappings": mappings,
        });

        // create index with settings and mappings
        let index_creation_response = search_store
            .client
            .indices()
            .create(IndicesCreateParts::Index(index_fullname.as_str()))
            .body(body)
            .send()
            .await?;

        match index_creation_response.status_code() {
            StatusCode::OK => println!("Index created: {}", index_fullname),
            _ => {
                let body = index_creation_response.json::<serde_json::Value>().await?;
                eprintln!("{:?}", body);
                return Err(anyhow::anyhow!("Failed to create index").into());
            }
        }
    }

    // create alias, and remove previous alias if needed
    let body = match remove_previous_alias && !index_exists {
        true => serde_json::json!({
            "actions": [
                { "add": { "index": index_fullname, "alias": index_alias, "is_write_index": true } },
                { "remove": { "index": index_previous_fullname, "alias": index_alias } }
            ]
        }),
        false => serde_json::json!({
            "actions": [
                { "add": { "index": index_fullname, "alias": index_alias, "is_write_index": true } },
            ]
        }),
    };

    let alias_creation_response = search_store
        .client
        .indices()
        .update_aliases()
        .body(body)
        .send()
        .await?;

    match alias_creation_response.status_code() {
        StatusCode::OK => {
            println!("Alias created: {}", index_alias);
            Ok(())
        }
        _ => {
            let body = alias_creation_response.json::<serde_json::Value>().await?;
            eprintln!("{:?}", body);
            Err(anyhow::anyhow!("Failed to create alias").into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::extract::{Request, State};
    use axum::response::IntoResponse;
    use axum::{Json, Router};
    use http::Method;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;
    use tokio::task::JoinHandle;

    type Requests = Arc<Mutex<Vec<(Method, String, Value)>>>;

    #[derive(Clone)]
    struct MockState {
        alias_status: StatusCode,
        update_status: StatusCode,
        requests: Requests,
    }

    struct MockElasticsearch {
        search_store: ElasticsearchSearchStore,
        requests: Requests,
        server: JoinHandle<std::io::Result<()>>,
    }

    impl Drop for MockElasticsearch {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    async fn respond(
        State(state): State<MockState>,
        request: Request,
    ) -> Result<impl IntoResponse, StatusCode> {
        let method = request.method().clone();
        let path = request.uri().path().to_string();
        let bytes = to_bytes(request.into_body(), 1024 * 1024)
            .await
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?
        };
        state
            .requests
            .lock()
            .await
            .push((method.clone(), path.clone(), body));
        let status = match (method, path.as_str()) {
            (Method::HEAD, "/core.alias_retry_test_1") => StatusCode::OK,
            (Method::HEAD, "/_alias/core.alias_retry_test") => state.alias_status,
            (Method::POST, "/_aliases") => state.update_status,
            _ => StatusCode::BAD_REQUEST,
        };
        Ok((
            status,
            [("x-elastic-product", "Elasticsearch")],
            Json(json!({ "acknowledged": status == StatusCode::OK })),
        ))
    }

    impl MockElasticsearch {
        async fn new(
            alias_status: StatusCode,
            update_status: StatusCode,
        ) -> Result<Self, Box<dyn std::error::Error>> {
            let requests = Arc::new(Mutex::new(Vec::new()));
            let app = Router::new().fallback(respond).with_state(MockState {
                alias_status,
                update_status,
                requests: requests.clone(),
            });
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let url = format!("http://{}", listener.local_addr()?);
            let server = tokio::spawn(async move { axum::serve(listener, app).await });
            Ok(Self {
                search_store: ElasticsearchSearchStore::new(&url, "dev", "dev").await?,
                requests,
                server,
            })
        }
    }

    #[tokio::test]
    async fn repairs_missing_alias_without_recreating_index(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mock = MockElasticsearch::new(StatusCode::NOT_FOUND, StatusCode::OK).await?;

        create_index(
            &mock.search_store,
            "alias_retry_test",
            1,
            "local",
            true,
            false,
        )
        .await?;

        assert_eq!(
            *mock.requests.lock().await,
            vec![
                (
                    Method::HEAD,
                    "/core.alias_retry_test_1".to_string(),
                    Value::Null
                ),
                (
                    Method::HEAD,
                    "/_alias/core.alias_retry_test".to_string(),
                    Value::Null
                ),
                (
                    Method::POST,
                    "/_aliases".to_string(),
                    json!({
                        "actions": [{ "add": {
                            "index": "core.alias_retry_test_1",
                            "alias": "core.alias_retry_test",
                            "is_write_index": true
                        }}]
                    })
                ),
            ]
        );
        Ok(())
    }

    #[tokio::test]
    async fn preserves_existing_alias() -> Result<(), Box<dyn std::error::Error>> {
        let mock = MockElasticsearch::new(StatusCode::OK, StatusCode::OK).await?;

        create_index(
            &mock.search_store,
            "alias_retry_test",
            1,
            "local",
            true,
            false,
        )
        .await?;

        assert_eq!(
            *mock.requests.lock().await,
            vec![
                (
                    Method::HEAD,
                    "/core.alias_retry_test_1".to_string(),
                    Value::Null
                ),
                (
                    Method::HEAD,
                    "/_alias/core.alias_retry_test".to_string(),
                    Value::Null
                ),
            ]
        );
        Ok(())
    }

    #[tokio::test]
    async fn propagates_alias_lookup_failure() -> Result<(), Box<dyn std::error::Error>> {
        let mock = MockElasticsearch::new(StatusCode::FORBIDDEN, StatusCode::OK).await?;

        let result = create_index(
            &mock.search_store,
            "alias_retry_test",
            1,
            "local",
            true,
            false,
        )
        .await;

        assert!(result.is_err());
        assert_eq!(mock.requests.lock().await.len(), 2);
        Ok(())
    }

    #[tokio::test]
    async fn propagates_alias_repair_failure() -> Result<(), Box<dyn std::error::Error>> {
        let mock = MockElasticsearch::new(StatusCode::NOT_FOUND, StatusCode::FORBIDDEN).await?;

        let result = create_index(
            &mock.search_store,
            "alias_retry_test",
            1,
            "local",
            true,
            false,
        )
        .await;

        assert!(result.is_err());
        let requests = mock.requests.lock().await;
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[2].0, Method::POST);
        Ok(())
    }
}
