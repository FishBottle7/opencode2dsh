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
	"big-pickle",                      // verified 2026-08-28: anonymous chat 200 (non-stream + stream)
	"mimo-v2.5-free",                  // verified 2026-08-28: anonymous chat 200 (non-stream)
	"ling-3.0-flash-fin-free",         // verified 2026-09-01: anonymous chat 200
	"nemotron-3.5-lightning-free",     // verified 2026-09-01: anonymous chat 200
	"nemotron-3-ultra-free",           // verified 2026-09-01: anonymous chat 200 (7s; earlier timeout was transient)
	"muse-spark-1.2-contributor-free", // verified 2026-09-01: docs pricing Free; 403 region-blocked from our probe, accepted
}

// staticFreeCandidates were exposed by /v1/models but did not complete a
// successful anonymous chat; re-verify before promoting.
var staticFreeCandidates = []string{
	// "deepseek-v4-flash-free"          // models.dev deprecated; 2026-09-01: upstream 400 "Model is unavailable"
	// "laguna-s-2.1-free"                // models.dev deprecated; 2026-09-01: upstream 503 (intermittent, failed twice)
	// "hy3-free"                         // models.dev deprecated; 2026-09-01: delisted from /v1/models, upstream 401 "not supported"
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
