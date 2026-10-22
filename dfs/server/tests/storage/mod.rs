use anyhow::Result;

#[test]
fn storage() -> Result<()> {
    #[allow(unsafe_code)]
    let _network = unsafe { foundationdb::boot() };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        super::receipt::tests::run().await?;
        super::resources::object::locks::tests::run().await
    })
}
