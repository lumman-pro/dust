use std::{io::Write, path::PathBuf, time::Duration};

use anyhow::{Context, Result};
use clap::Parser;
use dfs_api::search::{
    IndexRegion, OBJECTS_INDEX_ALIAS, OBJECTS_INDEX_NAME, create_objects_index, objects_index_body,
};
use elasticsearch::{
    Elasticsearch,
    auth::Credentials,
    cert::{Certificate, CertificateValidation},
    http::transport::{SingleNodeConnectionPool, TransportBuilder},
};

const REQUEST_TIMEOUT_SECONDS: u64 = 90;

#[derive(Parser)]
#[command(about = "Preview or create the DFS object search index and write alias")]
struct Args {
    #[arg(long, value_enum, env = "REGION")]
    region: IndexRegion,
    /// Create the index. Without this flag, print the request body without contacting Elasticsearch.
    #[arg(long)]
    execute: bool,
    #[arg(long, env = "ELASTICSEARCH_URL", hide_env_values = true)]
    url: Option<String>,
    #[arg(
        long,
        env = "ELASTICSEARCH_USERNAME",
        hide_env_values = true,
        requires = "password"
    )]
    username: Option<String>,
    #[arg(
        long,
        env = "ELASTICSEARCH_PASSWORD",
        hide_env_values = true,
        requires = "username"
    )]
    password: Option<String>,
    /// PEM certificate authority for a cluster using a private CA.
    #[arg(long, env = "ELASTICSEARCH_CA_CERT")]
    ca_cert: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .json()
        .init();

    if !args.execute {
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer_pretty(&mut stdout, &objects_index_body(args.region)?)?;
        writeln!(stdout)?;
        return Ok(());
    }

    let url = args
        .url
        .context("--url or ELASTICSEARCH_URL is required with --execute")?;
    let pool = SingleNodeConnectionPool::new(url.parse()?);
    let mut transport = TransportBuilder::new(pool)
        .disable_proxy()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS));
    if let (Some(username), Some(password)) = (args.username, args.password) {
        transport = transport.auth(Credentials::Basic(username, password));
    }
    if let Some(path) = args.ca_cert {
        let certificate = Certificate::from_pem(&std::fs::read(path)?)?;
        transport = transport.cert_validation(CertificateValidation::Full(certificate));
    }
    let client = Elasticsearch::new(transport.build()?);
    create_objects_index(&client, args.region).await?;
    tracing::info!(
        index = OBJECTS_INDEX_NAME,
        alias = OBJECTS_INDEX_ALIAS,
        "created DFS object index"
    );
    Ok(())
}
