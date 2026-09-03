package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestCatalogPendingFallsBackToStatic(t *testing.T) {
	original := staticFreeModels
	defer func() { staticFreeModels = original }()
	staticFreeModels = []string{"static-one", "static-two"}

	catalog := NewModelCatalog(nil)
	if got := catalog.List(); !reflect.DeepEqual(got, []string{"static-one", "static-two"}) {
		t.Fatalf("pending catalog must expose the S3 list, got %v", got)
	}
	if !catalog.Supported("static-one") || !catalog.Supported("anything") {
		t.Fatalf("pending catalog must support everything (upstream catalogPending branch)")
	}
	if _, err := catalog.Route("static-one", true); err != nil {
		t.Fatalf("static model must route while pending: %v", err)
	}
}

func TestCatalogDynamicListFiltersStatic(t *testing.T) {
	original := staticFreeModels
	defer func() { staticFreeModels = original }()
	staticFreeModels = []string{"stale-model"}

	catalog := NewModelCatalog(nil)
	catalog.Replace([]string{"fresh-a", "fresh-b"})
	if got := catalog.List(); reflect.DeepEqual(got, []string{"stale-model"}) || len(got) != 2 {
		t.Fatalf("dynamic catalog must be authoritative once refreshed, got %v", got)
	}
	if catalog.Supported("stale-model") {
		t.Fatalf("delisted model must lose support after refresh")
	}
	snap := catalog.Snapshot()
	if snap.Zen != 2 || snap.Total != 2 || snap.Exposed != 2 || snap.UpdatedAt.IsZero() {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}
}

func TestCatalogDecisionMergeWithMetadata(t *testing.T) {
	store := &ModelMetadataStore{
		models: map[string]ModelPrice{
			"costless-one": {ID: "costless-one", Input: zeroCost(), Output: zeroCost()},
			"paid-one":     {ID: "paid-one", Input: paidCost(), Output: paidCost()},
			"legacy-zero":  {ID: "legacy-zero", Input: zeroCost(), Output: zeroCost(), Deprecated: true},
			"ghost-free":   {ID: "ghost-free", Input: zeroCost(), Output: zeroCost(), Deprecated: true},
		},
		updatedAt: testTime(),
	}
	catalog := NewModelCatalog(store)

	if d := catalog.AnonymousDecision("costless-one"); !d.Allowed || d.Source != "metadata_free" {
		t.Fatalf("S1∩S2: metadata free must allow, got %+v", d)
	}
	if d := catalog.AnonymousDecision("paid-one"); d.Allowed {
		t.Fatalf("S1∩S2: metadata paid must deny, got %+v", d)
	}
	if d := catalog.AnonymousDecision("legacy-zero"); d.Allowed {
		t.Fatalf("deprecated must deny even with free in the name, got %+v", d)
	}
	// ghost-free is not a compile-time verified id: stale deprecation metadata
	// denies it (the deepseek-v4-flash-free regression).
	if d := catalog.AnonymousDecision("ghost-free"); d.Allowed {
		t.Fatalf("cataloged-but-deprecated id must not be resurrected by the name, got %+v", d)
	}

	// S2 not ready => name fallback (models.go:257 upstream behavior).
	pending := NewModelCatalog(&ModelMetadataStore{models: map[string]ModelPrice{}})
	if d := pending.AnonymousDecision("xx-free-xx"); !d.Allowed || d.Source != "name_free" {
		t.Fatalf("pending metadata must fall back to name, got %+v", d)
	}
}

func TestCatalogStaticOverridesOnlyUnknownMetadata(t *testing.T) {
	original := staticFreeModels
	defer func() { staticFreeModels = original }()
	staticFreeModels = []string{"verified-one", "verified-paid"}

	// metadata missing the model entirely -> static vouches.
	missing := NewModelCatalog(&ModelMetadataStore{models: map[string]ModelPrice{"other": {ID: "other"}}, updatedAt: testTime()})
	if d := missing.AnonymousDecision("verified-one"); !d.Allowed || d.Source != "static_verified" {
		t.Fatalf("static entry must be allowed when metadata does not know it, got %+v", d)
	}

	// metadata knows it as paid -> honest denial wins (R3).
	store := &ModelMetadataStore{
		models:    map[string]ModelPrice{"verified-paid": {ID: "verified-paid", Input: paidCost(), Output: paidCost()}},
		updatedAt: testTime(),
	}
	known := NewModelCatalog(store)
	if d := known.AnonymousDecision("verified-paid"); d.Allowed {
		t.Fatalf("metadata paid must not be overridden by the static list, got %+v", d)
	}

	// pending metadata -> static vouches (design.md 4.2 fallback chain).
	pending := NewModelCatalog(&ModelMetadataStore{models: map[string]ModelPrice{}})
	if d := pending.AnonymousDecision("verified-one"); !d.Allowed || d.Source != "static_verified" {
		t.Fatalf("static must vouch while metadata is pending, got %+v", d)
	}

	// stale deprecation metadata against a compile-time verified id -> the
	// S3 vouch survives (hy3-free case: works after models.dev flags it).
	stale := NewModelCatalog(&ModelMetadataStore{
		models:    map[string]ModelPrice{"verified-one": {ID: "verified-one", Input: zeroCost(), Output: zeroCost(), Deprecated: true}},
		updatedAt: testTime(),
	})
	if d := stale.AnonymousDecision("verified-one"); !d.Allowed || d.Source != "static_verified" {
		t.Fatalf("static vouch must survive a stale deprecated flag, got %+v", d)
	}
}

func TestFetchModelsParsesList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"data":[{"id":"a"},{"id":"b"},{"id":""}]}`))
	}))
	defer server.Close()
	models, status, err := FetchModels(context.Background(), server.Client(), server.URL, "public")
	if err != nil || status != 200 {
		t.Fatalf("FetchModels failed: %v %d", err, status)
	}
	if !reflect.DeepEqual(models, []string{"a", "b"}) {
		t.Fatalf("unexpected models: %v", models)
	}
}

func TestFetchModelsRejectsEmpty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	if _, _, err := FetchModels(context.Background(), server.Client(), server.URL, "public"); err == nil {
		t.Fatalf("empty model list must error")
	}
}
