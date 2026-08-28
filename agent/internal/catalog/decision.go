// Package catalog ports opencode2api models.go + model_metadata.go, trimmed to
// the single anonymous Zen lane (Go tier, docs scraping and authenticated key
// tiers are not ported), plus the opencode2dsh static fallback list (S3).
package catalog

import "strings"

// isFreeModel is copied verbatim from opencode2api models.go:303-305. It is
// the name-based fallback used when metadata is missing or not ready yet.
func isFreeModel(model string) bool {
	return strings.Contains(strings.ToLower(model), "free")
}
