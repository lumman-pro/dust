use std::path::Path;

use crate::api::DustApiClient;

use super::{print_response, scoped_path};

pub async fn run(manifest: &Path) -> anyhow::Result<()> {
    let manifest_path = scoped_path(manifest)?;
    let client = DustApiClient::from_env()?;
    let response = client.enter_frame_draft_mode(&manifest_path).await?;
    print_response(&response)
}
