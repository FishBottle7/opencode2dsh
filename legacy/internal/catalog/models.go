package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"opencode2dsh/agent/internal/ids"
)

type Protocol string

const (
	ProtocolChat      Protocol = "chat"
	ProtocolResponses Protocol = "responses"
	ProtocolAnthropic Protocol = "anthropic"
)

type Tier string

const TierZen Tier = "zen"

type ModelRoute struct {
	ID        string
	Tier      Tier
	Protocol  Protocol
	Anonymous bool
}

// CatalogSnapshot feeds /healthz. The Go-tier counters from upstream collapse
// into the Zen-only lane.
type CatalogSnapshot struct {
	Zen       int       `json:"zen"`
	Total     int       `json:"total"`
	Exposed   int       `json:"exposed"`
	UpdatedAt time.Time `json:"updated_at,omitempty"`
}

// ModelCatalog is the trimmed opencode2api catalog: one Zen tier, the anonymous
// decision glue, and the opencode2dsh S3 static fallback. Go-tier state,
// protocol capability tracking, and user protocol overrides are not ported
// because the gateway speaks Chat end to end.
type ModelCatalog struct {
	mu        sync.RWMutex
	zen       map[string]bool
	updatedAt time.Time
	metadata  *ModelMetadataStore
}

func NewModelCatalog(metadata *ModelMetadataStore) *ModelCatalog {
	return &ModelCatalog{zen: map[string]bool{}, metadata: metadata}
}

func (c *ModelCatalog) Replace(zen []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if zen != nil {
		c.zen = toSet(zen)
	}
	c.updatedAt = time.Now()
}

// Route is the trimmed upstream Route (models.go:173-191): the anonymous Zen
// lane is the only path. The authenticated KeyTiers fallback plan and the
// cross-tier protocol maps are not ported.
func (c *ModelCatalog) Route(model string, hasAnonymous bool) (ModelRoute, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	decision := c.anonymousDecision(model)
	if hasAnonymous && decision.Allowed && (c.pendingLocked() || c.zen[model]) {
		return ModelRoute{ID: model, Tier: TierZen, Protocol: ProtocolChat, Anonymous: true}, nil
	}
	return ModelRoute{}, fmt.Errorf("model %q is not available in the anonymous Zen catalog", model)
}

// anonymousDecision merges the metadata verdict with the S3 static vouch.
// Metadata verdicts that are Known (paid/deprecated) win over the static list
// with one exception: a compile-time verified S3 id stays vouched against a
// stale "deprecated" flag (hy3-free case: it kept working after models.dev
// flagged it and only died when it left the Zen catalog). The name fallback
// only applies while metadata cannot speak (pending/missing).
func (c *ModelCatalog) anonymousDecision(model string) AnonymousDecision {
	if c.metadata != nil {
		decision := c.metadata.Decide(model)
		if isStaticFreeModel(model) && !decision.Allowed &&
			(!decision.Known || decision.Source == "metadata_deprecated") {
			return AnonymousDecision{Allowed: true, Source: "static_verified", Known: false}
		}
		return decision
	}
	if isStaticFreeModel(model) {
		return AnonymousDecision{Allowed: true, Source: "static_verified", Known: false}
	}
	return AnonymousDecision{Allowed: isFreeModel(model), Source: "name_fallback_metadata_pending"}
}

// AnonymousDecision exposes the decision for diagnostics and the /v1/models
// filter in the gateway.
func (c *ModelCatalog) AnonymousDecision(model string) AnonymousDecision {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.anonymousDecision(model)
}

// List returns the models exposed by /v1/models. Before the first successful
// S1 refresh the catalog is pending and falls back to the S3 static list
// (design.md 4.2); afterwards the dynamic Zen list is authoritative.
func (c *ModelCatalog) List() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.zen) == 0 {
		return staticFreeList()
	}
	models := make([]string, 0, len(c.zen))
	for model := range c.zen {
		models = append(models, model)
	}
	sort.Strings(models)
	return models
}

func (c *ModelCatalog) Snapshot() CatalogSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.zen) == 0 {
		return CatalogSnapshot{Total: 0, Exposed: len(staticFreeModels), UpdatedAt: c.updatedAt}
	}
	return CatalogSnapshot{Zen: len(c.zen), Total: len(c.zen), Exposed: len(c.zen), UpdatedAt: c.updatedAt}
}

func (c *ModelCatalog) Supported(model string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	// A pending catalog has no upstream snapshot to contradict a request, so
	// retain the pre-refresh compatibility behavior (models.go:358-384).
	return c.pendingLocked() || c.zen[model]
}

func (c *ModelCatalog) pendingLocked() bool {
	return len(c.zen) == 0
}

func toSet(items []string) map[string]bool {
	out := make(map[string]bool, len(items))
	for _, item := range items {
		out[item] = true
	}
	return out
}

type modelsResponse struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// FetchModels is models.go:587-618 verbatim with the user agent now coming
// from the ids package.
func FetchModels(ctx context.Context, client *http.Client, baseURL, key string) ([]string, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/v1/models", nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("User-Agent", ids.UserAgent())
	req.Header.Set("x-opencode-client", "cli")
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, resp.StatusCode, fmt.Errorf("models endpoint returned HTTP %d", resp.StatusCode)
	}
	var payload modelsResponse
	dec := json.NewDecoder(io.LimitReader(resp.Body, 8<<20))
	if err := dec.Decode(&payload); err != nil {
		return nil, resp.StatusCode, err
	}
	models := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if item.ID != "" {
			models = append(models, item.ID)
		}
	}
	if len(models) == 0 {
		return nil, resp.StatusCode, errors.New("models endpoint returned an empty list")
	}
	return models, resp.StatusCode, nil
}
