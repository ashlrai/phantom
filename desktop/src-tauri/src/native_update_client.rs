//! Native updater HTTP construction shared by runtime and required library tests.

use std::time::Duration;

/// Background discovery cadence. A long polling gap also triggers a resume check.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(15 * 60);
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);

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
