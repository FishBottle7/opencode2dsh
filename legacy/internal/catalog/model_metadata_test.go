package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testTime() time.Time { return time.Date(2026, 2, 5, 0, 0, 0, 0, time.UTC) }

func zeroCost() *float64 { v := 0.0; return &v }
func paidCost() *float64 { v := 1.5; return &v }

func newReadyStore(models map[string]ModelPrice) *ModelMetadataStore {
	return &ModelMetadataStore{models: models, updatedAt: testTime()}
}

func TestDecideFiveClasses(t *testing.T) {
	store := newReadyStore(map[string]ModelPrice{
		"gpt-oss-120b":  {ID: "gpt-oss-120b", Input: zeroCost(), Output: zeroCost()},                 // metadata free
		"claude-x":      {ID: "claude-x", Input: paidCost(), Output: paidCost()},                   // metadata paid
		"retired-model": {ID: "retired-model", Input: zeroCost(), Output: zeroCost(), Deprecated: true}, // deprecated
		"free-model":    {ID: "free-model", Input: paidCost(), Output: paidCost()},                 // name fallback
		"no-cost":       {ID: "no-cost"},                                                           // costs unknown
	})

	cases := []struct {
		model   string
		allowed bool
		source  string
		known   bool
	}{
		{"gpt-oss-120b", true, "metadata_free", true},
		{"claude-x", false, "metadata_paid", true},
		{"retired-model", false, "metadata_deprecated", true},
		{"free-model", true, "name_free", true},
		{"unknown-model", false, "metadata_model_missing", false},
		{"no-cost", false, "metadata_cost_unknown", false},
	}
	for _, c := range cases {
		got := store.Decide(c.model)
		if got.Allowed != c.allowed || got.Source != c.source || got.Known != c.known {
			t.Fatalf("Decide(%q) = %+v, want allowed=%v source=%s known=%v", c.model, got, c.allowed, c.source, c.known)
		}
	}
}

func TestDecideMetadataPending(t *testing.T) {
	store := &ModelMetadataStore{models: map[string]ModelPrice{}}
	if got := store.Decide("anything-free"); !got.Allowed || got.Source != "name_free" {
		t.Fatalf("pending store must fall back to name, got %+v", got)
	}
	if got := store.Decide("anything"); got.Allowed || got.Source != "metadata_pending" {
		t.Fatalf("pending store must reject non-free names, got %+v", got)
	}
}

func TestDecideMatchesUpstreamSourcePriority(t *testing.T) {
	// name + metadata both free => name_and_metadata_free (upstream order).
	store := newReadyStore(map[string]ModelPrice{
		"both-free": {ID: "both-free", Input: zeroCost(), Output: zeroCost()},
	})
	if got := store.Decide("both-free"); got.Source != "name_and_metadata_free" {
		t.Fatalf("expected name_and_metadata_free, got %+v", got)
	}
}

func TestDecodeModelsDevPrefersOpenCodeProvider(t *testing.T) {
	payload := map[string]any{
		"openai": map[string]any{
			"id":     "openai",
			"models": map[string]any{"gpt": map[string]any{"cost": map[string]any{"input": 2.0, "output": 4.0}}},
		},
		"opencode": map[string]any{
			"id": "opencode",
			"models": map[string]any{
				"free-one": map[string]any{"cost": map[string]any{"input": 0, "output": 0}},
				"paid-one": map[string]any{"cost": map[string]any{"input": 1.0, "output": 1.0}},
			},
		},
	}
	data, _ := json.Marshal(payload)
	models, err := decodeModelsDev(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("expected only opencode models, got %d", len(models))
	}
	if m := models["free-one"]; m.Input == nil || *m.Input != 0 {
		t.Fatalf("free-one cost not parsed: %+v", m)
	}
}

func TestMetadataCacheRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-config.json.models.dev.json")
	cache := modelMetadataCache{UpdatedAt: testTime(), Models: map[string]ModelPrice{"a": {ID: "a", Input: zeroCost(), Output: zeroCost()}}}
	if err := saveMetadataCache(path, cache); err != nil {
		t.Fatal(err)
	}
	store := NewModelMetadataStore(filepath.Join(dir, "agent-config.json"), nil)
	if err := store.loadCache(); err != nil {
		t.Fatalf("loadCache: %v", err)
	}
	decision := store.Decide("a")
	if !decision.Allowed || decision.Source != "metadata_free" {
		t.Fatalf("cache round trip lost semantics: %+v", decision)
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		t.Fatalf("cache file missing: %v", err)
	}
}
