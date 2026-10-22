pub mod error;
pub mod fdb;
pub mod receipt;
pub mod resources;

pub use error::Error;

#[cfg(test)]
#[path = "../../tests/storage/mod.rs"]
mod tests;
