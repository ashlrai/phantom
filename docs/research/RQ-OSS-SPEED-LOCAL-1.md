# RQ-OSS-SPEED-LOCAL-1: local inference speed and efficiency

Research checked 2026-11-06. Recommendations are experiments or integration candidates, not evidence of deployed software, model quality, or a landed RQ-OMLX-DISTILL-1. Phantom's existing [local inference](../LOCAL-INFERENCE.md) and [model inventory](../MODEL-INVENTORY.md) safeguards remain authoritative. Local endpoints must remain loopback-only. No weights are committed, caches deleted, or models downloaded by this study.

## Ranked adoption table

Impact is a hypothesis (1–5), effort is an integration estimate, and `adopt` means evaluate/use in a bounded prototype, not deploy automatically. License links describe the indicated component; model and converted-weight licenses must be checked independently at the exact revision before acquisition or distribution.

| rank | project | url | license (SPDX) | license_url | effort | impact | Phantom fit note | recommend |
|---:|---|---|---|---|---|---:|---|---|
| 1 | oMLX | [server](https://github.com/jundot/omlx) | Apache-2.0 | [code](https://github.com/jundot/omlx/blob/main/LICENSE) | M | 5 | Code: MLX server, continuous batching and SSD KV cache; weights separate. Benchmark existing loopback integration, bound cache and concurrency. | adopt |
| 2 | llama.cpp / GGUF | [runtime](https://github.com/ggml-org/llama.cpp) | MIT | [code](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE) | M | 5 | Code: Metal, GGUF, quantize, server and llama-bench; weights separate. Portable baseline and alternative to MLX. | adopt |
| 3 | mlx-lm | [runtime](https://github.com/ml-explore/mlx-lm) | MIT | [code](https://github.com/ml-explore/mlx-lm/blob/main/LICENSE) | M | 5 | Code: native MLX quantization, prompt and quantized KV caches; weights separate. Compare bounded warm-prefix runs; check pinned version for [cache-limit issue](https://github.com/ml-explore/mlx-lm/issues/1390). | adopt |
| 4 | Qwen3-4B MLX 4-bit | [model card](https://huggingface.co/Qwen/Qwen3-4B-MLX-4bit) | Apache-2.0 | [weights](https://huggingface.co/Qwen/Qwen3-4B-MLX-4bit/blob/main/LICENSE) | S | 4 | Weights: official 4-bit worker candidate; file is about 2.14 GB, not total memory. Runtime code separately licensed. | adopt |
| 5 | lm-evaluation-harness | [harness](https://github.com/EleutherAI/lm-evaluation-harness) | MIT | [code](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/LICENSE) | M | 4 | Code: reproducible local evaluation; datasets and weights separately licensed. Add coding tasks and real patch/test outcomes. | adopt |
| 6 | Aider repo map | [repo map](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md) | Apache-2.0 | [code](https://github.com/Aider-AI/aider/blob/main/LICENSE) | M | 4 | Code: ranked symbol map suggests reducing prompt context; compare token savings against task resolution. Preserve notices if copying. | inspire-only |
| 7 | Qwen3-0.6B | [model card](https://huggingface.co/Qwen/Qwen3-0.6B) | Apache-2.0 | [weights](https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/LICENSE) | M | 3 | Weights: router/draft candidate, not a presumed coding worker; verify routing recall and escalation. Code license separate. | adopt |
| 8 | DeepSeek-R1-Distill-Qwen-1.5B | [model card](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B) | MIT | [weights and terms](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B/blob/main/LICENSE) | M | 3 | Card specifies MIT code and weights and Qwen2.5 base; benchmark reasoning and token cost. Do not generalize to Llama-derived distills. | adopt |
| 9 | vLLM / vLLM-Metal | [Metal](https://github.com/vllm-project/vllm-metal) | Apache-2.0 | [code](https://github.com/vllm-project/vllm-metal/blob/main/LICENSE) | L | 3 | Code: Apple backend exists; main vLLM has batching and prefix caching. Weights separate; assess memory and compatibility on small Macs. | inspire-only |
| 10 | Ollama | [runtime](https://github.com/ollama/ollama) | MIT | [code](https://github.com/ollama/ollama/blob/main/LICENSE) | M | 3 | Code: alternative local serving and metrics; weights separate. Compare on identical model and workload, loopback only. | inspire-only |
| 11 | DistillKit | [toolkit](https://github.com/arcee-ai/DistillKit) | Apache-2.0 | [code](https://github.com/arcee-ai/DistillKit/blob/main/LICENSE) | L | 3 | Code: distillation experiments; teacher, student, training data and produced weights each need independent rights. No proprietary teacher reverse engineering. | inspire-only |
| 12 | SGLang | [runtime](https://github.com/sgl-project/sglang) | Apache-2.0 | [code](https://github.com/sgl-project/sglang/blob/main/LICENSE) | L | 2 | Code: prefix reuse and batching; weights separate. Accelerator-oriented; learn cache design, do not assume a small-Mac win. | inspire-only |
| 13 | LocalAI | [server](https://github.com/mudler/LocalAI) | MIT | [code](https://github.com/mudler/LocalAI/blob/master/LICENSE) | M | 2 | Code: multi-backend wrapper; weights separate. Extra layer has no demonstrated speed advantage here. | inspire-only |
| 14 | Jan | [desktop](https://github.com/janhq/jan) | Apache-2.0 | [code](https://github.com/janhq/jan/blob/main/LICENSE) | L | 1 | Code: local desktop/backends; weights separate. Reference only; no need to copy an app. | inspire-only |
| 15 | TensorRT-LLM | [runtime](https://github.com/NVIDIA/TensorRT-LLM) | Apache-2.0; bundled notices | [code and notices](https://github.com/NVIDIA/TensorRT-LLM/blob/main/LICENSE) | L | 1 | Code: NVIDIA GPU stack with separately licensed dependencies; weights separate. Not a Mac solution and proprietary dependencies conflict with this slice. | skip |
| 16 | Gemma 3 | [model card](https://huggingface.co/google/gemma-3-270m) | LicenseRef-Gemma | [weights terms](https://ai.google.dev/gemma/terms) | M | 2 | Weights: custom terms and access agreement, not Apache; compatibility with the specific use and distribution requires review. Code separate. | inspire-only |
| 17 | Llama distills | [model card](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Llama-8B) | LicenseRef-Llama-3.1 | [weights terms](https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct/blob/main/LICENSE) | M | 2 | Weights: custom Llama terms apply to Llama-derived variants; do not treat as MIT merely because DeepSeek code is MIT. Review exact card and distribution conditions. | inspire-only |
| 18 | Phi-4-mini-instruct | [model card](https://huggingface.co/microsoft/Phi-4-mini-instruct) | MIT | [weights](https://huggingface.co/microsoft/Phi-4-mini-instruct/blob/b93bc7647dbc8c4d92c54c9f26aec78c106f5c7d/LICENSE) | M | 3 | Weights: 3.8B worker comparison; runtime code separate and exact quantization provenance requires review. | adopt |

## Evidence and caveats

- The 2026 [vllm-mlx paper](https://arxiv.org/abs/2601.19139) reports 21–87% higher text throughput than llama.cpp and up to 4.3× aggregate throughput at 16 concurrent requests on its tested configurations. These are author measurements, not 8/16 GB Phantom measurements; compare versions, chips, context, quantization and concurrency.
- A 2026 [Apple Silicon optimization study](https://arxiv.org/abs/2610.31479) reports that all tested speculative decoding methods reduced throughput on its Apple workloads. llama.cpp [supports several methods](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md); test draft acceptance, latency and total memory against no speculation. Do not assume GPU-server gains transfer.
- [AWQ](https://github.com/mit-han-lab/llm-awq/blob/main/LICENSE) (MIT) reports [6.39 vs 17.07 ms/token](https://github.com/mit-han-lab/llm-awq/blob/main/tinychat/README.md) for W4 vs FP16 Llama-3-8B on RTX 4090 with four context tokens. This is CUDA evidence, not a Mac prediction. [GPTQ](https://github.com/IST-DASLab/gptq/blob/main/LICENSE) is Apache-2.0; compare MLX-native quantization and llama.cpp GGUF quantization before adding a conversion pipeline. Each converted artifact inherits or adds its own weight terms.
- Small MoE active parameter counts do not establish resident-memory fit: total weights, KV, runtime, OS and concurrent work matter. 4-bit file sizes are lower bounds, not allocations. [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) has Apache-2.0 weights per its model card; use only with a supported embedding endpoint, and evaluate retrieval recall.
- For quality, use a pinned, isolated subset of [SWE-bench](https://github.com/SWE-bench/SWE-bench) plus representative Phantom tasks: patch applies, tests pass, regressions, escalation rate and human-reviewed merge readiness. Passing tests are a proxy, not proof of merge quality. [HELM](https://github.com/stanford-crfm/helm) and lm-eval subsets can supplement, with dataset licenses and resource limits checked per task. Avoid executing generated code outside an appropriate sandbox.

## Mac / oMLX practical shortlist

These are alternatives, not simultaneous resident models. Fit is unverified; start with one request, short context and the existing memory guard, then measure real peak memory, swap and thermal behavior. Use exact checkpoint revision, hash, quantization, license and runtime version in a local pin; never check weights into Git.

| memory | stack | role and license |
|---|---|---|
| 8 GB | oMLX + Qwen3-0.6B 4-bit | draft/router experiment; Apache-2.0 code and weights |
| 8 GB | mlx-lm + Qwen3-4B MLX 4-bit | bounded worker candidate; MIT code, Apache-2.0 weights; admission may refuse |
| 8 GB | llama.cpp + Qwen3-Embedding-0.6B GGUF | embedding candidate; MIT code, Apache-2.0 weights; verify exact converted artifact license |
| 16 GB | oMLX + Qwen3-4B MLX 4-bit | worker candidate; Apache-2.0 code and weights |
| 16 GB | llama.cpp + DeepSeek-R1-Distill-Qwen-1.5B GGUF | reasoning/router comparison; MIT code and model weights; verify conversion provenance |
| 16 GB | oMLX + Qwen3-Embedding-0.6B | embedding candidate; Apache-2.0 code and weights; verify endpoint and artifact compatibility |

An 8B model or MoE is deliberately not promised to fit at useful context. Model cards are upstream starting points, not guarantees that a particular community quantization is licensed or supported.

## READY jobs

- READY RQ-LOCAL-CODING-BENCH-1: extend the existing inventory with sandboxed, pinned coding tasks and record patch/test success, escalation and latency alongside three cold samples; compare 8/16 GB hosts without evicting caches.
- READY RQ-LOCAL-CACHE-AB-1: compare bounded cold/warm prefix reuse and speculation on/off across pinned oMLX, mlx-lm and llama.cpp, recording TTFT, decode tok/s, peak memory, swap and draft acceptance.
- READY RQ-LOCAL-LANE-CAPS-1: enforce measured per-host context, concurrency and memory admission caps with fail-closed loopback routing and regression tests; do not alter live queue configuration.
- READY RQ-LOCAL-MODEL-PINS-1: define local-only model manifests with source revision, hash, quantization, code/weight license and provenance; keep weights outside Git and reject unverified conversions.

## Sources

Primary upstream links are embedded in the table and evidence above. Release context: [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases), [vLLM-Metal releases](https://github.com/vllm-project/vllm-metal/releases), [oMLX releases](https://github.com/jundot/omlx/releases), and [mlx-lm releases](https://github.com/ml-explore/mlx-lm/releases). License and performance claims can change; recheck pinned revisions before implementation. No local benchmark was run for this research.
