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
	// calibrated in Phase 0.10; see docs/plan.md acceptance step 5/6
}

// staticFreeCandidates are unverified guesses (design.md 4.1). They must pass
// scripts/verify-static-models before being promoted to staticFreeModels.
var staticFreeCandidates = []string{
	// "gpt-oss-120b",      // candidate: verify 2026-02-05
	// "gpt-oss-20b",       // candidate: verify 2026-02-05
	// "deepseek-v4-flash", // candidate: verify 2026-02-05
	// "qwen3-coder-480b",  // candidate: verify 2026-02-05
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
