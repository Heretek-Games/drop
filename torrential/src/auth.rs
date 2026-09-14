//! Shared-secret authorization for the depot HTTP server.
//!
//! The catalog (`/api/v1/depot/manifest.json`) and cache invalidation
//! (`/invalidate`) routes have always been gated by `TORRENTIAL_HTTP_TOKEN`
//! when it is configured. Chunk *content* was intentionally left open so that
//! anonymous clients could download from a public depot.
//!
//! Exposing a depot to the internet (for example a remote/seedbox depot) makes
//! that gap a real vulnerability, so chunk authentication is now available as
//! an explicit opt-in: set `TORRENTIAL_REQUIRE_CHUNK_AUTH=true` to require the
//! shared token on every content request. Enabling it without configuring
//! `TORRENTIAL_HTTP_TOKEN` fails closed (every chunk request is rejected)
//! instead of silently allowing anonymous access.

use axum::http::{HeaderMap, header};

/// Depot route authorization configuration.
#[derive(Debug, Clone, Default)]
pub struct DepotAuth {
    token: Option<String>,
    require_chunk_auth: bool,
}

impl DepotAuth {
    /// Build the configuration from the process environment.
    #[must_use]
    pub fn from_env() -> Self {
        Self::new(
            std::env::var("TORRENTIAL_HTTP_TOKEN").ok(),
            std::env::var("TORRENTIAL_REQUIRE_CHUNK_AUTH")
                .ok()
                .as_deref(),
        )
    }

    /// Build a configuration from explicit values (used by tests).
    #[must_use]
    pub fn new(token: Option<String>, require_chunk_auth: Option<&str>) -> Self {
        let token = token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self {
            token,
            require_chunk_auth: parse_bool(require_chunk_auth),
        }
    }

    /// Whether chunk content requests must present the shared token.
    #[must_use]
    pub fn requires_chunk_auth(&self) -> bool {
        self.require_chunk_auth
    }

    /// Gate the catalog and invalidation routes.
    ///
    /// Enforced only when `TORRENTIAL_HTTP_TOKEN` is configured, preserving the
    /// historical behaviour for deployments that never set it.
    ///
    /// # Errors
    ///
    /// Returns [`AuthError::Rejected`] when a token is configured but the
    /// request did not present a matching token.
    pub fn authorize_catalog(&self, headers: &HeaderMap) -> Result<(), AuthError> {
        let Some(expected) = self.token.as_deref() else {
            return Ok(());
        };
        Self::verify(headers, expected)
    }

    /// Gate chunk content routes.
    ///
    /// When the opt-in is disabled this always allows the request (backwards
    /// compatible). When enabled it is fail-closed: a missing configured token
    /// rejects every request.
    ///
    /// # Errors
    ///
    /// Returns [`AuthError::NotConfigured`] when chunk auth is enabled but no
    /// token is configured, or [`AuthError::Rejected`] when the presented token
    /// is missing or does not match.
    pub fn authorize_chunk(&self, headers: &HeaderMap) -> Result<(), AuthError> {
        if !self.require_chunk_auth {
            return Ok(());
        }
        let Some(expected) = self.token.as_deref() else {
            return Err(AuthError::NotConfigured);
        };
        Self::verify(headers, expected)
    }

    fn verify(headers: &HeaderMap, expected: &str) -> Result<(), AuthError> {
        match presented_token(headers) {
            Some(presented) if constant_time_eq(presented, expected) => Ok(()),
            _ => Err(AuthError::Rejected),
        }
    }
}

/// Reason a depot request was rejected, for logging and status mapping.
#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    /// A token is required but none was presented, or it did not match.
    Rejected,
    /// Chunk auth was enabled but `TORRENTIAL_HTTP_TOKEN` is unset.
    NotConfigured,
}

/// Extract the presented shared token from the `Authorization: Bearer <token>`
/// header or the legacy `x-torrential-token` header.
pub fn presented_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            headers
                .get("x-torrential-token")
                .and_then(|value| value.to_str().ok())
        })
}

fn parse_bool(value: Option<&str>) -> bool {
    match value.map(|value| value.trim().to_ascii_lowercase()) {
        Some(value) => matches!(value.as_str(), "1" | "true" | "yes" | "on"),
        None => false,
    }
}

/// Compare two secrets without early-exit on the first differing byte.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with(name: &'static str, value: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
        headers
    }

    #[test]
    fn catalog_open_without_token() {
        let auth = DepotAuth::new(None, None);
        assert!(auth.authorize_catalog(&HeaderMap::new()).is_ok());
    }

    #[test]
    fn catalog_requires_token_when_configured() {
        let auth = DepotAuth::new(Some("s3cret".into()), None);
        assert_eq!(
            auth.authorize_catalog(&HeaderMap::new()),
            Err(AuthError::Rejected)
        );
        assert!(
            auth.authorize_catalog(&headers_with("authorization", "Bearer s3cret"))
                .is_ok()
        );
        assert!(
            auth.authorize_catalog(&headers_with("x-torrential-token", "s3cret"))
                .is_ok()
        );
        assert_eq!(
            auth.authorize_catalog(&headers_with("authorization", "Bearer nope")),
            Err(AuthError::Rejected)
        );
    }

    #[test]
    fn chunk_open_by_default() {
        let auth = DepotAuth::new(Some("s3cret".into()), None);
        assert!(!auth.requires_chunk_auth());
        assert!(auth.authorize_chunk(&HeaderMap::new()).is_ok());
    }

    #[test]
    fn chunk_requires_token_when_opted_in() {
        let auth = DepotAuth::new(Some("s3cret".into()), Some("true"));
        assert!(auth.requires_chunk_auth());
        assert_eq!(
            auth.authorize_chunk(&HeaderMap::new()),
            Err(AuthError::Rejected)
        );
        assert!(
            auth.authorize_chunk(&headers_with("authorization", "Bearer s3cret"))
                .is_ok()
        );
    }

    #[test]
    fn chunk_fails_closed_without_configured_token() {
        let auth = DepotAuth::new(None, Some("1"));
        assert_eq!(
            auth.authorize_chunk(&headers_with("authorization", "Bearer anything")),
            Err(AuthError::NotConfigured)
        );
    }

    #[test]
    fn blank_token_is_treated_as_unset() {
        let auth = DepotAuth::new(Some("   ".into()), Some("on"));
        assert_eq!(
            auth.authorize_chunk(&headers_with("x-torrential-token", "")),
            Err(AuthError::NotConfigured)
        );
    }

    #[test]
    fn parse_bool_accepts_common_truthy_values() {
        for value in ["1", "true", "TRUE", "Yes", "on", " on "] {
            assert!(parse_bool(Some(value)), "{value} should be truthy");
        }
        for value in ["0", "false", "no", "off", "", "maybe"] {
            assert!(!parse_bool(Some(value)), "{value} should be falsy");
        }
        assert!(!parse_bool(None));
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abz"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(constant_time_eq("", ""));
    }
}
