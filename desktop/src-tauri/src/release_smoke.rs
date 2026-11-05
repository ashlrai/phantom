//! Operand-free loader smoke; never opens windows, reads accounts or starts a sidecar.
pub const FLAG: &str = "--release-smoke";

pub fn inspect(config: &str, version: &str, revision: &str) -> Result<String, String> {
    let config: serde_json::Value = serde_json::from_str(config).map_err(|_| "invalid config")?;
    if config["version"] != version
        || revision.len() != 40
        || !revision
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        || config["plugins"]["updater"]["endpoints"][0]
            != "https://github.com/ashlrai/phantom/releases/latest/download/latest.json"
    {
        return Err("release identity mismatch".into());
    }
    Ok(serde_json::json!({"schemaVersion": 1, "version": version,
        "revision": revision, "state": "pass"})
    .to_string())
}

pub fn dispatch(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some(FLAG) {
        return None;
    }
    if args.len() != 2 {
        return Some(2);
    }
    match inspect(
        include_str!("../tauri.conf.json"),
        env!("CARGO_PKG_VERSION"),
        option_env!("PHANTOM_RELEASE_REVISION").unwrap_or("unknown"),
    ) {
        Ok(result) => {
            println!("{result}");
            Some(0)
        }
        Err(_) => {
            eprintln!("desktop release smoke refused");
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_compiled_version_endpoint_and_revision() {
        let config = include_str!("../tauri.conf.json");
        assert!(inspect(config, env!("CARGO_PKG_VERSION"), &"a".repeat(40)).is_ok());
        assert!(inspect(config, "0.0.0", &"a".repeat(40)).is_err());
        assert!(inspect(config, env!("CARGO_PKG_VERSION"), "unknown").is_err());
        assert!(inspect(
            &config.replace("github.com", "example.com"),
            env!("CARGO_PKG_VERSION"),
            &"a".repeat(40)
        )
        .is_err());
        assert!(inspect("{}", env!("CARGO_PKG_VERSION"), &"a".repeat(40)).is_err());
    }
    #[test]
    fn never_claims_other_entrypoints_or_accepts_operands() {
        assert_eq!(dispatch(&["app".into()]), None);
        assert_eq!(
            dispatch(&["app".into(), FLAG.into(), "extra".into()]),
            Some(2)
        );
    }
}
