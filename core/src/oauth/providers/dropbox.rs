use crate::{
    oauth::{
        connection::{
            Connection, ConnectionProvider, FinalizeResult, Provider, ProviderError, RefreshResult,
            PROVIDER_TIMEOUT_SECONDS,
        },
        credential::Credential,
        providers::utils::{execute_request, ProviderHttpRequestError},
    },
    utils,
};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use lazy_static::lazy_static;
use std::env;

lazy_static! {
    static ref OAUTH_DROPBOX_CLIENT_ID: String =
        env::var("OAUTH_DROPBOX_CLIENT_ID").expect("OAUTH_DROPBOX_CLIENT_ID must be set");
    static ref OAUTH_DROPBOX_CLIENT_SECRET: String =
        env::var("OAUTH_DROPBOX_CLIENT_SECRET").expect("OAUTH_DROPBOX_CLIENT_SECRET must be set");
}

const DROPBOX_TOKEN_URL: &str = "https://api.dropboxapi.com/oauth2/token";

struct DropboxTokens {
    access_token: String,
    access_token_expiry: Option<u64>,
    refresh_token: Option<String>,
    raw_json: serde_json::Value,
}

pub struct DropboxConnectionProvider {}

impl DropboxConnectionProvider {
    pub fn new() -> Self {
        DropboxConnectionProvider {}
    }

    /// Calls Dropbox's token endpoint with Dust's app credentials and the given grant parameters.
    /// https://www.dropbox.com/developers/documentation/http/documentation#oauth2-token
    async fn request_tokens(&self, grant: &[(&str, &str)]) -> Result<DropboxTokens, ProviderError> {
        let mut params = vec![
            ("client_id", OAUTH_DROPBOX_CLIENT_ID.as_str()),
            ("client_secret", OAUTH_DROPBOX_CLIENT_SECRET.as_str()),
        ];
        params.extend_from_slice(grant);

        let req = self
            .reqwest_client()
            .post(DROPBOX_TOKEN_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&params);

        let raw_json = execute_request(ConnectionProvider::Dropbox, req)
            .await
            .map_err(|e| self.handle_provider_request_error(e))?;

        let access_token = match raw_json["access_token"].as_str() {
            Some(token) => token.to_string(),
            None => Err(anyhow!("Missing `access_token` in response from Dropbox"))?,
        };

        let access_token_expiry = raw_json["expires_in"].as_u64().map(|expires_in| {
            utils::now() + expires_in.saturating_sub(PROVIDER_TIMEOUT_SECONDS) * 1000
        });

        let refresh_token = raw_json["refresh_token"].as_str().map(|s| s.to_string());

        Ok(DropboxTokens {
            access_token,
            access_token_expiry,
            refresh_token,
            raw_json,
        })
    }
}

#[async_trait]
impl Provider for DropboxConnectionProvider {
    fn id(&self) -> ConnectionProvider {
        ConnectionProvider::Dropbox
    }

    async fn finalize(
        &self,
        _connection: &Connection,
        _related_credentials: Option<Credential>,
        code: &str,
        redirect_uri: &str,
    ) -> Result<FinalizeResult, ProviderError> {
        let tokens = self
            .request_tokens(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
            ])
            .await?;

        Ok(FinalizeResult {
            redirect_uri: redirect_uri.to_string(),
            code: code.to_string(),
            access_token: tokens.access_token,
            access_token_expiry: tokens.access_token_expiry,
            refresh_token: tokens.refresh_token,
            raw_json: tokens.raw_json,
            extra_metadata: None,
        })
    }

    async fn refresh(
        &self,
        connection: &Connection,
        _related_credentials: Option<Credential>,
    ) -> Result<RefreshResult, ProviderError> {
        let refresh_token = match connection.unseal_refresh_token() {
            Ok(Some(token)) => token,
            Ok(None) => {
                return Err(ProviderError::ActionNotSupportedError(
                    "No refresh token available".to_string(),
                ))
            }
            Err(e) => return Err(ProviderError::InternalError(e)),
        };

        // Dropbox refresh tokens do not rotate: the response carries no `refresh_token`, so
        // `refresh_token` is `None` and the stored one is kept.
        let tokens = self
            .request_tokens(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token.as_str()),
            ])
            .await?;

        Ok(RefreshResult {
            access_token: tokens.access_token,
            access_token_expiry: tokens.access_token_expiry,
            refresh_token: tokens.refresh_token,
            raw_json: tokens.raw_json,
        })
    }

    fn scrubbed_raw_json(&self, raw_json: &serde_json::Value) -> Result<serde_json::Value> {
        let raw_json = match raw_json.clone() {
            serde_json::Value::Object(mut map) => {
                map.remove("access_token");
                map.remove("refresh_token");
                map.remove("expires_in");
                serde_json::Value::Object(map)
            }
            _ => Err(anyhow!("Invalid raw_json, not an object"))?,
        };

        Ok(raw_json)
    }

    fn handle_provider_request_error(&self, error: ProviderHttpRequestError) -> ProviderError {
        match &error {
            // Dropbox answers a revoked or expired refresh token with a 400 `invalid_grant`.
            ProviderHttpRequestError::RequestFailed {
                status, message, ..
            } if *status == 400 && message.contains("invalid_grant") => {
                ProviderError::TokenRevokedError
            }
            _ => self.default_handle_provider_request_error(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DropboxConnectionProvider;
    use crate::oauth::{
        connection::{ConnectionProvider, Provider, ProviderError},
        providers::utils::ProviderHttpRequestError,
    };
    use serde_json::json;

    #[test]
    fn scrubs_tokens_and_expiry_from_raw_json() {
        let scrubbed = DropboxConnectionProvider::new()
            .scrubbed_raw_json(&json!({
                "access_token": "sl.access",
                "refresh_token": "refresh",
                "expires_in": 14400,
                "account_id": "dbid:abc",
                "scope": "files.content.read",
            }))
            .expect("raw_json should be scrubbed");

        assert_eq!(
            scrubbed,
            json!({ "account_id": "dbid:abc", "scope": "files.content.read" })
        );
    }

    #[test]
    fn maps_invalid_grant_to_token_revoked() {
        let error = DropboxConnectionProvider::new().handle_provider_request_error(
            ProviderHttpRequestError::RequestFailed {
                provider: ConnectionProvider::Dropbox,
                status: 400,
                message: r#"{"error": "invalid_grant", "error_description": "refresh token is invalid or revoked"}"#.to_string(),
            },
        );

        assert!(matches!(error, ProviderError::TokenRevokedError));
    }

    #[test]
    fn keeps_default_handling_for_other_400_errors() {
        let error = DropboxConnectionProvider::new().handle_provider_request_error(
            ProviderHttpRequestError::RequestFailed {
                provider: ConnectionProvider::Dropbox,
                status: 400,
                message: r#"{"error": "invalid_request"}"#.to_string(),
            },
        );

        assert!(!matches!(error, ProviderError::TokenRevokedError));
    }
}
