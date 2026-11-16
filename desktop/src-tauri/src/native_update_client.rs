//! Native updater HTTP construction shared by runtime and required library tests.

use crate::native_updates as policy;
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;

/// Background discovery cadence. A long polling gap also triggers a resume check.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(15 * 60);
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);
const LATEST_LIMIT: u64 = 256 * 1024;

fn discovery_request(
    client: &reqwest::Client,
    endpoint: &str,
) -> Result<reqwest::Request, &'static str> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "download-unavailable")?;
    if !allowed_url(&url) {
        return Err("download-unavailable");
    }
    client
        .get(url)
        // Revalidate the moving latest pointer after every publish, including
        // cached 404s while release assets were still being stocked.
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "download-unavailable")
}

async fn discovery_response(
    response: reqwest::Response,
    key: &str,
) -> Result<policy::VerifiedManifest, &'static str> {
    if !response.status().is_success() {
        return Err("download-unavailable");
    }
    if response.content_length().is_some_and(|n| n > LATEST_LIMIT) {
        return Err("download-size");
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| "download-unavailable")?;
        policy::extend_download(&mut bytes, &chunk, LATEST_LIMIT).map_err(|_| "download-size")?;
    }
    let latest: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid-manifest")?;
    let envelope =
        serde_json::from_value(latest["phantom"].clone()).map_err(|_| "invalid-manifest")?;
    let manifest =
        policy::verify_compatible_manifest(envelope, key).map_err(|_| "invalid-manifest")?;
    if !policy::discovery_matches(&latest, &manifest) {
        return Err("invalid-manifest");
    }
    Ok(manifest)
}

/// Fresh, bounded discovery through the commissioned endpoint and signed policy.
pub async fn discovery(
    client: &reqwest::Client,
    endpoint: &str,
    key: &str,
) -> Result<policy::VerifiedManifest, &'static str> {
    let response = client
        .execute(discovery_request(client, endpoint)?)
        .await
        .map_err(|_| "download-unavailable")?;
    if !allowed_url(response.url()) {
        return Err("download-unavailable");
    }
    discovery_response(response, key).await
}

pub fn check_due(last_check: Duration, last_poll: Duration, now: Duration) -> bool {
    now < last_poll
        || now.saturating_sub(last_check) >= CHECK_INTERVAL
        || now.saturating_sub(last_poll) > Duration::from_secs(30)
}

pub fn allowed_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}

pub fn client() -> Result<reqwest::Client, &'static str> {
    // rustls-no-provider requires a process default before reqwest construction.
    // Installation is once-only; concurrent clients retain the installed provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() < 5 && allowed_url(a.url()) {
                a.follow()
            } else {
                a.stop()
            }
        }))
        .build()
        .map_err(|_| "download-unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const ENDPOINT: &str =
        "https://github.com/ashlrai/phantom/releases/latest/download/latest.json";

    fn fixture() -> (Value, String) {
        let f: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/desktop-update-paired-phantom-tauri.json"
        ))
        .unwrap();
        let m: Value =
            serde_json::from_str(f["envelope"]["manifestText"].as_str().unwrap()).unwrap();
        (
            serde_json::json!({"version": m["version"], "platforms": {"darwin-aarch64": {"url": m["app"]["url"], "signature": m["app"]["signature"]}}, "phantom": f["envelope"]}),
            f["publicKey"].as_str().unwrap().to_owned(),
        )
    }

    // Mock HTTP responses keep this suite hermetic when the host denies sockets.
    // Production discovery retains the fixed HTTPS origin policy.
    fn mock_feed(
        responses: Vec<(u16, Vec<u8>)>,
        key: &str,
    ) -> Vec<Result<policy::VerifiedManifest, &'static str>> {
        tauri::async_runtime::block_on(async {
            let client = client().unwrap();
            let mut results = Vec::new();
            for (status, body) in responses {
                let request = discovery_request(&client, ENDPOINT).unwrap();
                assert_eq!(request.url().as_str(), ENDPOINT);
                assert_eq!(
                    request.headers()[reqwest::header::CACHE_CONTROL],
                    "no-cache"
                );
                // No Content-Length, and multiple chunks: exercise the streaming
                // byte bound independently of the declared-length preflight.
                let chunks: Vec<_> = body
                    .chunks(4096)
                    .map(|chunk| Ok::<_, std::io::Error>(chunk.to_vec()))
                    .collect();
                let response = tauri::http::Response::builder()
                    .status(status)
                    .body(reqwest::Body::wrap_stream(futures_util::stream::iter(
                        chunks,
                    )))
                    .unwrap();
                results.push(discovery_response(response.into(), key).await);
            }
            results
        })
    }

    #[test]
    fn mock_feed_rechecks_after_missing_release_and_after_success() {
        let (feed, key) = fixture();
        let body = serde_json::to_vec(&feed).unwrap();
        let mut results = mock_feed(
            vec![(404, Vec::new()), (200, body.clone()), (200, body)],
            &key,
        )
        .into_iter();
        assert_eq!(results.next().unwrap().unwrap_err(), "download-unavailable");
        for result in results {
            let manifest = result.unwrap();
            assert_eq!(manifest.version(), feed["version"].as_str().unwrap());
            assert!(
                policy::stable_version(manifest.version()).unwrap()
                    > policy::stable_version("3.25.1").unwrap()
            );
        }
    }

    #[test]
    fn mock_feed_rejects_tampering_malformed_json_and_streaming_overflow() {
        let (feed, key) = fixture();
        let mut wrong_version = feed.clone();
        wrong_version["version"] = serde_json::json!("99.0.0");
        let mut wrong_signature = feed;
        let changed = format!(
            "{} ",
            wrong_signature["phantom"]["manifestText"].as_str().unwrap()
        );
        wrong_signature["phantom"]["manifestText"] = serde_json::json!(changed);
        let results = mock_feed(
            vec![
                (200, serde_json::to_vec(&wrong_version).unwrap()),
                (200, serde_json::to_vec(&wrong_signature).unwrap()),
                (200, b"{".to_vec()),
                (200, vec![b' '; LATEST_LIMIT as usize + 1]),
            ],
            &key,
        );
        let errors: Vec<_> = results.into_iter().map(Result::unwrap_err).collect();
        assert_eq!(
            errors,
            vec![
                "invalid-manifest",
                "invalid-manifest",
                "invalid-manifest",
                "download-size"
            ]
        );
    }

    #[test]
    fn discovery_request_preserves_origin_restrictions() {
        let client = client().unwrap();
        assert!(discovery_request(&client, ENDPOINT).is_ok());
        for endpoint in [
            "http://127.0.0.1/latest.json",
            "https://example.com/latest.json",
            "https://user@github.com/latest.json",
        ] {
            assert!(discovery_request(&client, endpoint).is_err());
        }
    }

    #[test]
    fn updater_client_constructs_in_a_fresh_process_without_network() {
        const CHILD: &str = "PHANTOM_TLS_CLIENT_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            assert!(rustls::crypto::CryptoProvider::get_default().is_none());
            client().expect("updater client must configure its TLS provider");
            client().expect("repeated construction must remain safe");
            assert!(rustls::crypto::CryptoProvider::get_default().is_some());
            return;
        }
        // A separate test process prevents another TLS test from masking startup.
        let output = crate::native_metadata_launch::spawn_outside_fixture_leases(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "native_update_client::tests::updater_client_constructs_in_a_fresh_process_without_network",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped()),
        )
        .unwrap()
        .wait_with_output()
        .unwrap();
        assert!(
            output.status.success(),
            "fresh updater client failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed;"),
            "fresh-process filter must execute the actual constructor case"
        );
    }

    #[test]
    fn native_update_schedule_checks_on_interval_and_resume_without_catchup_storms() {
        assert!(!check_due(
            Duration::ZERO,
            Duration::from_secs(890),
            Duration::from_secs(895)
        ));
        assert!(check_due(
            Duration::ZERO,
            Duration::from_secs(895),
            Duration::from_secs(900)
        ));
        assert!(check_due(
            Duration::from_secs(100),
            Duration::from_secs(105),
            Duration::from_secs(150)
        ));
        assert!(!check_due(
            Duration::from_secs(150),
            Duration::from_secs(150),
            Duration::from_secs(155)
        ));
        assert!(check_due(
            Duration::from_secs(100),
            Duration::from_secs(105),
            Duration::from_secs(90)
        ));
    }

    #[test]
    fn https_redirects_have_a_closed_origin_set() {
        for good in [
            "https://github.com/a",
            "https://release-assets.githubusercontent.com/a",
        ] {
            assert!(allowed_url(&reqwest::Url::parse(good).unwrap()));
        }
        for bad in [
            "http://github.com/a",
            "https://github.com.evil.test/a",
            "https://user@github.com/a",
            "https://github.com:444/a",
        ] {
            assert!(!allowed_url(&reqwest::Url::parse(bad).unwrap()));
        }
    }
}
