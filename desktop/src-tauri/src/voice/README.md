# Local oMLX dictation

The desktop mic button starts hands-free dictation; click Stop to insert the
transcript. The existing voice hotkey supports hold-to-talk and a latched
session. Both use the same native capture and transcription pipeline.

To opt into Whisper on an existing local oMLX audio server, launch the desktop
app with these settings in its process environment:

```sh
ASHLR_VOICE_OMLX_ENDPOINT=http://127.0.0.1:8000/v1/audio/transcriptions
ASHLR_VOICE_OMLX_MODEL=mlx-community/whisper-large-v3-mlx
```

Use the model id installed in your oMLX server. This integration does not install
or start oMLX, download Whisper models, or configure authentication. Unset these
settings to use the existing Parakeet path. An invalid endpoint or missing model
setting also leaves the existing engine selection in place.

Only literal `http://127.0.0.1` endpoints at `/v1/audio/transcriptions` are
accepted. Hostnames, other IP addresses, credentials, query strings and fragments
are rejected. Requests disable proxies and redirects and have connection,
response size and time limits. WAV audio stays in memory.

If oMLX fails, the same captured audio is transcribed by the installed Parakeet
model. Subsequent partials and the final transcript stay on Parakeet until the
engine is unloaded. Install Parakeet through the existing voice model download
flow before relying on this fallback. If neither engine works, the existing
voice error flow reports the failure; no cloud transcription is attempted.

Protocol reference: [oMLX audio routes](https://github.com/jundot/omlx/blob/main/omlx/api/audio_routes.py).
