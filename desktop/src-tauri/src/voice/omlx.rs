//! Opt-in oMLX Whisper transport. Audio never leaves numeric IPv4 loopback.
//! Set ASHLR_VOICE_OMLX_ENDPOINT to http://127.0.0.1:8000/v1/audio/transcriptions
//! and ASHLR_VOICE_OMLX_MODEL to the installed Whisper model's oMLX id.
use super::engine::SpeechEngine;
use super::whisper::wav_bytes;
use std::{path::PathBuf, time::Duration};

pub struct OmlxEngine {
    endpoint: reqwest::Url,
    model: String,
    parakeet: PathBuf,
    fallback: Option<Box<dyn SpeechEngine>>,
}

fn endpoint(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid oMLX endpoint")?;
    // Check the literal authority too: reject URL-normalized aliases such as 2130706433.
    let authority = raw
        .strip_prefix("http://")
        .and_then(|s| s.split('/').next());
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/v1/audio/transcriptions"
        || !authority.is_some_and(|a| {
            a == "127.0.0.1"
                || a.strip_prefix("127.0.0.1:")
                    .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        })
    {
        return Err(
            "oMLX dictation requires http://127.0.0.1:<port>/v1/audio/transcriptions".into(),
        );
    }
    Ok(url)
}

impl OmlxEngine {
    pub fn configured(parakeet: PathBuf) -> Option<Self> {
        let url = endpoint(&std::env::var("ASHLR_VOICE_OMLX_ENDPOINT").ok()?).ok()?;
        let model = std::env::var("ASHLR_VOICE_OMLX_MODEL").ok()?;
        if model.is_empty() || model.len() > 256 || model.contains(['\r', '\n']) {
            return None;
        }
        Some(Self {
            endpoint: url,
            model,
            parakeet,
            fallback: None,
        })
    }

    fn request(&self, samples: &[f32]) -> Result<String, String> {
        // The capture pipeline caps utterances at ten minutes.
        if samples.len() > 16_000 * 600 {
            return Err("Dictation audio exceeds limit".into());
        }
        let boundary = "ashlr-voice-wav-boundary";
        let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\n", self.model).into_bytes();
        body.extend(wav_bytes(samples));
        body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
        tauri::async_runtime::block_on(async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| "Could not initialize local dictation")?;
            let mut response = client
                .post(self.endpoint.clone())
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(body)
                .send()
                .await
                .map_err(|_| "oMLX dictation unavailable")?;
            if !response.status().is_success() {
                return Err("oMLX transcription failed".into());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "oMLX response failed")? {
                if bytes.len() + chunk.len() > 128 * 1024 {
                    return Err("oMLX transcript exceeds limit".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid oMLX transcript")?;
            value
                .get("text")
                .and_then(|v| v.as_str())
                .filter(|s| s.len() <= 64 * 1024)
                .map(str::to_owned)
                .ok_or_else(|| "Missing oMLX transcript".into())
        })
    }
}

impl OmlxEngine {
    fn transcribe_with_fallback(
        &mut self,
        samples: &[f32],
        load: impl FnOnce(&std::path::Path) -> Result<Box<dyn SpeechEngine>, String>,
    ) -> Result<String, String> {
        if self.fallback.is_none() {
            if let Ok(text) = self.request(samples) {
                return Ok(text);
            }
            self.fallback = Some(load(&self.parakeet)?);
        }
        self.fallback.as_mut().unwrap().transcribe(samples)
    }
}

impl SpeechEngine for OmlxEngine {
    fn id(&self) -> &'static str {
        self.fallback.as_ref().map_or("whisper", |e| e.id())
    }
    fn label(&self) -> &'static str {
        self.fallback
            .as_ref()
            .map_or("local Whisper (oMLX)", |e| e.label())
    }
    fn partial_interval_ms(&self) -> u64 {
        1500
    }
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
        self.transcribe_with_fallback(samples, super::load_parakeet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_every_non_literal_loopback_endpoint() {
        for raw in [
            "http://localhost:8000/v1/audio/transcriptions",
            "http://127.0.0.2:8000/v1/audio/transcriptions",
            "http://[::1]:8000/v1/audio/transcriptions",
            "http://192.168.1.2/v1/audio/transcriptions",
            "https://127.0.0.1/v1/audio/transcriptions",
            "http://2130706433/v1/audio/transcriptions",
            "http://user@127.0.0.1/v1/audio/transcriptions",
            "http://127.0.0.1/v1/audio/transcriptions?redirect=remote",
            "http://127.0.0.1.evil/v1/audio/transcriptions",
        ] {
            assert!(endpoint(raw).is_err(), "{raw}");
        }
        assert!(endpoint("http://127.0.0.1:8000/v1/audio/transcriptions").is_ok());
    }
    struct Fake;
    impl SpeechEngine for Fake {
        fn id(&self) -> &'static str {
            "parakeet"
        }
        fn label(&self) -> &'static str {
            "local Parakeet"
        }
        fn transcribe(&mut self, _: &[f32]) -> Result<String, String> {
            Ok("fallback transcript".into())
        }
    }
    // A one-request loopback server; no model, microphone, or external service.
    fn server(status: &str, body: &str) -> (reqwest::Url, std::thread::JoinHandle<Vec<u8>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = endpoint(&format!(
            "http://{}/v1/audio/transcriptions",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let n = socket.read(&mut chunk).unwrap();
                assert!(n > 0);
                data.extend_from_slice(&chunk[..n]);
                if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..at]).to_lowercase();
                    let len: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if data.len() >= at + 4 + len {
                        break;
                    }
                }
            }
            socket.write_all(reply.as_bytes()).unwrap();
            data
        });
        (url, thread)
    }
    #[test]
    fn posts_wav_and_reads_whisper_transcript() {
        let (endpoint, server) = server("200 OK", r#"{"text":"hello local"}"#);
        let engine = OmlxEngine {
            endpoint,
            model: "whisper-local".into(),
            parakeet: PathBuf::new(),
            fallback: None,
        };
        assert_eq!(engine.request(&[0.5; 160]).unwrap(), "hello local");
        let request = server.join().unwrap();
        assert!(request.windows(4).any(|w| w == b"RIFF"));
        assert!(String::from_utf8_lossy(&request).contains("whisper-local"));
    }
    #[test]
    fn rejects_redirects_and_malformed_transcripts() {
        for (status, body) in [
            ("302 Found", ""),
            ("200 OK", "not json"),
            ("200 OK", r#"{"text":42}"#),
            ("200 OK", r#"{}"#),
        ] {
            let (endpoint, server) = server(status, body);
            let engine = OmlxEngine {
                endpoint,
                model: "whisper".into(),
                parakeet: PathBuf::new(),
                fallback: None,
            };
            assert!(engine.request(&[0.0]).is_err());
            server.join().unwrap();
        }
    }
    #[test]
    fn failed_request_loads_parakeet_and_reuses_it() {
        let (endpoint, server) = server("503 Unavailable", "");
        let mut engine = OmlxEngine {
            endpoint,
            model: "whisper".into(),
            parakeet: PathBuf::from("parakeet-model"),
            fallback: None,
        };
        assert_eq!(
            engine
                .transcribe_with_fallback(&[0.0], |path| {
                    assert_eq!(path, std::path::Path::new("parakeet-model"));
                    Ok(Box::new(Fake))
                })
                .unwrap(),
            "fallback transcript"
        );
        server.join().unwrap();
        assert_eq!(
            engine
                .transcribe_with_fallback(&[0.0], |_| panic!("already loaded"))
                .unwrap(),
            "fallback transcript"
        );
        assert_eq!(engine.id(), "parakeet");
    }
    #[test]
    fn fallback_transcribes_and_reports_parakeet() {
        let mut engine = OmlxEngine {
            endpoint: endpoint("http://127.0.0.1:1/v1/audio/transcriptions").unwrap(),
            model: "whisper".into(),
            parakeet: PathBuf::new(),
            fallback: Some(Box::new(Fake)),
        };
        assert_eq!(engine.transcribe(&[0.0]).unwrap(), "fallback transcript");
        assert_eq!(engine.id(), "parakeet");
    }
}
