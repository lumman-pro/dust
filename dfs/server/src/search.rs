use anyhow::{Context, Result, bail, ensure};
use clap::ValueEnum;
use elasticsearch::{
    Elasticsearch,
    http::{StatusCode, response::Response},
    indices::{IndicesCreateParts, IndicesExistsAliasParts, IndicesExistsParts},
};
use serde_json::{Value, json};

pub const OBJECTS_INDEX_ALIAS: &str = "dfs.objects";
pub const OBJECTS_INDEX_NAME: &str = "dfs.objects_1";

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum IndexRegion {
    Local,
    #[value(name = "us-central1")]
    UsCentral1,
    #[value(name = "europe-west1")]
    EuropeWest1,
}

/**
 * @cc [owner:flvndvd,label:backend] objects-index-region-settings
 * All regions MUST use the same mapping and analysis settings. Production regions MUST require
 * nodes with workload=filesystem; local settings MUST work with one node and no workload label.
 */
pub fn objects_index_body(region: IndexRegion) -> Result<Value> {
    let settings = match region {
        IndexRegion::Local => include_str!("search/indices/objects_1.settings.local.json"),
        IndexRegion::UsCentral1 => {
            include_str!("search/indices/objects_1.settings.us-central1.json")
        }
        IndexRegion::EuropeWest1 => {
            include_str!("search/indices/objects_1.settings.europe-west1.json")
        }
    };
    let settings: Value =
        serde_json::from_str(settings).context("invalid object index settings")?;
    let mappings: Value =
        serde_json::from_str(include_str!("search/indices/objects_1.mappings.json"))
            .context("invalid object index mapping")?;

    Ok(json!({
        "settings": settings,
        "mappings": mappings,
        "aliases": { (OBJECTS_INDEX_ALIAS): { "is_write_index": true } },
    }))
}

/**
 * @cc [owner:flvndvd,label:backend;error-handling] objects-index-bootstrap-preflight
 * Bootstrap MUST fail without a mutation if preflight finds the physical index or alias already
 * exists, or if either existence check returns any status other than 404. Bootstrap MUST NOT
 * delete an index, change an existing mapping, or issue a separate alias-update request.
 */
/**
 * @cc [owner:flvndvd,label:backend;error-handling] objects-index-bootstrap-acknowledgement
 * Bootstrap MUST create the index and write alias in one request and return success only when
 * Elasticsearch reports both acknowledged=true and shards_acknowledged=true. An unacknowledged
 * or timed-out operation MUST NOT trigger automatic deletion or retry of the creation request.
 */
pub async fn create_objects_index(client: &Elasticsearch, region: IndexRegion) -> Result<()> {
    let body = objects_index_body(region)?;
    require_missing(
        client
            .indices()
            .exists(IndicesExistsParts::Index(&[OBJECTS_INDEX_NAME]))
            .send()
            .await?,
        OBJECTS_INDEX_NAME,
    )?;
    require_missing(
        client
            .indices()
            .exists_alias(IndicesExistsAliasParts::Name(&[OBJECTS_INDEX_ALIAS]))
            .send()
            .await?,
        OBJECTS_INDEX_ALIAS,
    )?;

    let response = client
        .indices()
        .create(IndicesCreateParts::Index(OBJECTS_INDEX_NAME))
        .body(body)
        .send()
        .await?
        .error_for_status_code()?;
    let result: Value = response.json().await?;
    ensure!(
        result["acknowledged"] == true && result["shards_acknowledged"] == true,
        "object index creation was not fully acknowledged; inspect {OBJECTS_INDEX_NAME} and \
         {OBJECTS_INDEX_ALIAS} before retrying"
    );
    Ok(())
}

fn require_missing(response: Response, name: &str) -> Result<()> {
    match response.status_code() {
        StatusCode::NOT_FOUND => Ok(()),
        StatusCode::OK => {
            bail!("{name} already exists; bootstrap does not migrate an existing index")
        }
        status => bail!("could not check whether {name} exists: HTTP {status}"),
    }
}
