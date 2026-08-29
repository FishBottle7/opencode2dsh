package catalog

// staticFreeModels is the S3 bootstrap list (design.md 4.1): model ids that
// were verified against the anonymous Zen lane with a real chat request. Every
// entry must carry a "verified YYYY-MM-DD" marker and only entries that passed
// a live anonymous chat may stay in the active list; unverified guesses live in
// the candidates block below.
//
// scripts/verify-static-models.(ps1|sh) re-checks this list against the
// upstream; maintain it whenever a model is added or upstream delists one.
var staticFreeModels = []string{
	"big-pickle",     // verified 2026-08-28: anonymous chat 200 (non-stream + stream)
	"hy3-free",       // verified 2026-08-28: anonymous chat 200 (non-stream)
	"mimo-v2.5-free", // verified 2026-08-28: anonymous chat 200 (non-stream)
}

// staticFreeCandidates were exposed by /v1/models on 2026-08-28 but did not
// complete a successful anonymous chat that day; re-verify before promoting.
var staticFreeCandidates = []string{
	// "deepseek-v4-flash-free"          // 2026-08-28: upstream "Model is unavailable"
	// "nemotron-3-ultra-free"           // 2026-08-28: upstream returned server_error payload
	// "laguna-s-2.1-free"               // 2026-08-28: upstream 503 provider error
	// "nemotron-3.5-lightning-free"     // 2026-08-28: 502 after all attempts
	// "muse-spark-1.2-contributor-free" // 2026-08-28: 502 after all attempts
	// "gpt-oss-120b",                   // design-era guess: not in the anonymous /v1/models list on 2026-08-28
	// "gpt-oss-20b",                    // design-era guess: not in the anonymous /v1/models list on 2026-08-28
	// "qwen3-coder-480b",               // design-era guess: not in the anonymous /v1/models list on 2026-08-28
	// "deepseek-v4-flash",              // design-era guess: not in the anonymous /v1/models list on 2026-08-28
}

func isStaticFreeModel(model string) bool {
	for _, id := range staticFreeModels {
		if id == model {
			return true
		}
	}
	return false
}

func staticFreeList() []string {
	out := make([]string, 0, len(staticFreeModels))
	out = append(out, staticFreeModels...)
	return out
}

// SetStaticFreeModelsForTesting replaces the active S3 list. It exists so
// cross-package tests (gateway) can pin the static list; production code must
// never call it.
func SetStaticFreeModelsForTesting(ids []string) {
	staticFreeModels = append([]string(nil), ids...)
}
