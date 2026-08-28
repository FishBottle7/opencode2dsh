// Package gateway ports opencode2api gateway.go, trimmed to the single
// anonymous Zen lane. The authenticated upstream machinery (doKeyUpstream,
// KeyTiers fallback, dual zen/go node pools) and the WebUI/admin monitoring
// hooks are not ported; Monitor call sites became slog lines.
package gateway

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"opencode2dsh/agent/internal/catalog"
	"opencode2dsh/agent/internal/config"
	"opencode2dsh/agent/internal/convert"
	"opencode2dsh/agent/internal/ids"
	"opencode2dsh/agent/internal/obs"
	"opencode2dsh/agent/internal/pool"
)

const maxRequestBody = 32 << 20

const anonymousZenKey = "public"

const (
	proxyHealthCheckURL      = "https://cloudflare.com/cdn-cgi/trace"
	proxyHealthCheckInterval = 15 * time.Minute
	proxyHealthCheckTimeout  = 10 * time.Second
)

var version = "dev"

type Gateway struct {
	cfg        config.Config
	logger     *slog.Logger
	transports *pool.TransportPool
	anonymous  *pool.AnonymousPool
	catalog    *catalog.ModelCatalog
}

type healthResponse struct {
	Status    string        `json:"status"`
	Ready     bool          `json:"ready"`
	Version   string        `json:"version"`
	Models    healthModels  `json:"models"`
	Anonymous bool          `json:"anonymous"`
	Proxies   healthProxies `json:"proxies"`
	Issues    []string      `json:"issues,omitempty"`
}

type healthModels struct {
	Status            string     `json:"status"`
	Total             int        `json:"total"`
	Exposed           int        `json:"exposed"`
	Zen               int        `json:"zen"`
	LastRefresh       *time.Time `json:"last_refresh,omitempty"`
	StaleAfterSeconds int        `json:"stale_after_seconds"`
}

type healthProxies struct {
	Total     int `json:"total"`
	Healthy   int `json:"healthy"`
	Unhealthy int `json:"unhealthy"`
}

func NewGateway(cfg config.Config, logger *slog.Logger, metadata *catalog.ModelMetadataStore) (*Gateway, error) {
	transports, err := pool.NewTransportPool(cfg.RuntimeProxies(), cfg.Performance, time.Duration(cfg.Retry.TimeoutSeconds)*time.Second)
	if err != nil {
		return nil, err
	}
	cooldown := time.Duration(cfg.Performance.FailureCooldownSeconds) * time.Second
	return &Gateway{
		cfg:        cfg,
		logger:     logger,
		transports: transports,
		anonymous:  pool.NewAnonymousPool(cfg.Anonymous, transports, cooldown),
		catalog:    catalog.NewModelCatalog(metadata),
	}, nil
}

func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/models", g.authenticate(g.handleModels))
	mux.HandleFunc("POST /v1/chat/completions", g.authenticate(g.handleInference(catalog.ProtocolChat)))
	mux.HandleFunc("GET /healthz", g.handleHealth)
	return obs.RecoveryMiddleware(g.logger, mux)
}

func (g *Gateway) handleHealth(w http.ResponseWriter, _ *http.Request) {
	models := g.catalog.Snapshot()
	proxyTotal, proxyHealthy := g.transports.HealthCounts()
	staleAfter := max(2*time.Duration(g.cfg.Models.RefreshSeconds)*time.Second, time.Minute)

	modelStatus := "ready"
	var lastRefresh *time.Time
	issues := make([]string, 0, 3)
	if models.UpdatedAt.IsZero() {
		modelStatus = "pending"
		issues = append(issues, "model_catalog_pending")
	} else {
		updatedAt := models.UpdatedAt.UTC()
		lastRefresh = &updatedAt
		if models.Exposed == 0 {
			modelStatus = "empty"
			issues = append(issues, "model_catalog_empty")
		} else if time.Since(models.UpdatedAt) > staleAfter {
			modelStatus = "stale"
			issues = append(issues, "model_catalog_stale")
		}
	}
	if proxyHealthy == 0 {
		issues = append(issues, "no_healthy_proxies")
	}

	status := "ok"
	httpStatus := http.StatusOK
	if len(issues) > 0 {
		status = "degraded"
		httpStatus = http.StatusServiceUnavailable
		if modelStatus == "pending" {
			status = "starting"
		}
	}
	writeJSON(w, httpStatus, healthResponse{
		Status:    status,
		Ready:     len(issues) == 0,
		Version:   version,
		Anonymous: g.cfg.Anonymous,
		Models: healthModels{
			Status:            modelStatus,
			Total:             models.Total,
			Exposed:           models.Exposed,
			Zen:               models.Zen,
			LastRefresh:       lastRefresh,
			StaleAfterSeconds: int(staleAfter / time.Second),
		},
		Proxies: healthProxies{
			Total:     proxyTotal,
			Healthy:   proxyHealthy,
			Unhealthy: proxyTotal - proxyHealthy,
		},
		Issues: issues,
	})
}

func (g *Gateway) authenticate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		candidates := []string{strings.TrimSpace(r.Header.Get("x-api-key"))}
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(auth), "bearer ") {
			candidates = append(candidates, strings.TrimSpace(auth[7:]))
		}
		valid := false
		for _, key := range g.cfg.ServerKeys {
			for _, candidate := range candidates {
				if len(candidate) == len(key) && subtle.ConstantTimeCompare([]byte(candidate), []byte(key)) == 1 {
					valid = true
				}
			}
		}
		if !valid {
			writeAPIError(w, catalog.ProtocolChat, http.StatusUnauthorized, "invalid local API key", "authentication_error", "")
			return
		}
		next(w, r)
	}
}

func (g *Gateway) handleModels(w http.ResponseWriter, _ *http.Request) {
	now := time.Now().Unix()
	models := g.catalog.List()
	data := make([]map[string]any, 0, len(models))
	for _, model := range models {
		if !g.catalog.AnonymousDecision(model).Allowed {
			continue
		}
		if _, err := g.catalog.Route(model, g.cfg.Anonymous); err != nil {
			continue
		}
		data = append(data, map[string]any{"id": model, "object": "model", "created": now, "owned_by": "opencode"})
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

func (g *Gateway) handleInference(external catalog.Protocol) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
		if err != nil {
			writeAPIError(w, external, http.StatusBadRequest, "request body is too large or unreadable", "invalid_request_error", "")
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			writeAPIError(w, external, http.StatusBadRequest, "request body must be a JSON object", "invalid_request_error", "")
			return
		}
		model := ids.StringAt(payload, "model")
		if model == "" {
			writeAPIError(w, external, http.StatusBadRequest, "model is required", "invalid_request_error", "model")
			return
		}
		if !g.catalog.Supported(model) {
			writeAPIError(w, external, http.StatusBadRequest, "the model uses an upstream protocol that opencode2dsh does not expose", "invalid_request_error", "model")
			return
		}
		route, err := g.catalog.Route(model, g.cfg.Anonymous)
		if err != nil {
			writeAPIError(w, external, http.StatusBadRequest, err.Error(), "invalid_request_error", "model")
			return
		}
		upstreamPayload, err := convert.PrepareUpstreamRequest(external, route.Protocol, payload, g.cfg.Upstream.Zen)
		if err != nil {
			writeAPIError(w, external, http.StatusBadRequest, err.Error(), "invalid_request_error", "")
			return
		}
		upstreamBody, err := json.Marshal(upstreamPayload)
		if err != nil {
			writeAPIError(w, external, http.StatusBadRequest, "request contains unsupported JSON values", "invalid_request_error", "")
			return
		}
		reqIDs := ids.DeriveRequestIDs(r, payload)
		stream := ids.BoolAt(payload, "stream")
		requestCtx, cancel := context.WithTimeout(r.Context(), time.Duration(g.cfg.Retry.TimeoutSeconds)*time.Second)
		defer cancel()
		resp, err := g.doAnonymousUpstream(requestCtx, route, upstreamBody, reqIDs)
		if err != nil {
			g.logger.Warn("all upstream attempts failed", "component", "upstream", "event", "request_failed", "request_id", reqIDs.Request, "tier", route.Tier, "anonymous", true, "error", err)
			writeAPIError(w, external, http.StatusBadGateway, "all upstream attempts failed", "upstream_error", reqIDs.Request)
			return
		}
		defer resp.Body.Close()
		w.Header().Set("x-request-id", reqIDs.Request)
		if resp.StatusCode/100 != 2 {
			copyErrorResponse(w, external, resp, reqIDs.Request)
			return
		}
		if stream {
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(resp.StatusCode)
			var usage convert.BridgeUsage
			var usageReported bool
			if external == route.Protocol {
				observer := convert.NewStreamUsageObserver(route.Protocol)
				_, err = io.Copy(w, io.TeeReader(resp.Body, observer))
				usage = observer.Finish()
				usageReported = observer.Reported()
			} else {
				// Cross-protocol transcoding is an interface placeholder in
				// opencode2dsh; the branch is unreachable while the gateway
				// only routes Chat.
				err = convert.NoTranscode()
			}
			if usageReported {
				g.logger.Debug("upstream stream usage", "component", "stream", "event", "stream_usage", "request_id", reqIDs.Request, "model", model, "input_tokens", usage.Input, "output_tokens", usage.Output, "total_tokens", usage.Total)
			}
			if err != nil && !errors.Is(err, context.Canceled) {
				g.logger.Debug("downstream stream ended with an error", "component", "stream", "event", "stream_failed", "request_id", reqIDs.Request, "model", model, "tier", route.Tier, "error", err)
			}
			return
		}
		responseBody, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		if err != nil {
			writeAPIError(w, external, http.StatusBadGateway, "failed to read upstream response", "upstream_error", reqIDs.Request)
			return
		}
		if external != route.Protocol {
			g.logger.Warn("response protocol conversion is not available in opencode2dsh", "component", "conversion", "event", "response_conversion_unavailable", "request_id", reqIDs.Request, "model", model)
			writeAPIError(w, external, http.StatusBadGateway, "unsupported upstream response", "upstream_error", reqIDs.Request)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(responseBody)
	}
}

// doAnonymousUpstream is gateway.go:424-483 with the multi-layer semantics
// removed: opencode2dsh has no authenticated fallback, so exhausting the
// proxy cursor is final. It tries every currently available proxy at most
// once; only a successful response ends the attempt loop.
func (g *Gateway) doAnonymousUpstream(ctx context.Context, route catalog.ModelRoute, body []byte, reqIDs ids.RequestIDs) (*http.Response, error) {
	var lastResponse *http.Response
	var lastErr error
	cursor := g.anonymous.CursorFor(reqIDs.Session)
	limit := g.anonymous.Len()
	attempts := 0
	if len(body) == 0 {
		return nil, errors.New("no prepared Zen request body")
	}
	for attempts < limit {
		node := cursor.Next()
		if node == nil {
			break
		}
		attempts++
		if lastResponse != nil {
			pool.DrainAndClose(lastResponse.Body)
			lastResponse = nil
		}
		req, err := newUpstreamRequest(ctx, g.cfg.Upstream.Zen, route.Protocol, body, reqIDs, anonymousZenKey)
		if err != nil {
			return nil, err
		}
		started := time.Now()
		resp, err := node.Proxy.Client.Do(req)
		duration := time.Since(started)
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		g.syncProxyResult(node.Proxy, status, err)
		if err == nil && resp.StatusCode/100 == 2 {
			g.anonymous.MarkSuccess(node)
			g.logger.Debug("anonymous upstream accepted request", "component", "upstream", "event", "anonymous_attempt_succeeded", "request_id", reqIDs.Request, "attempt", attempts, "tier", catalog.TierZen, "key_id", "anonymous", "anonymous", true, "proxy", config.RedactURL(node.Proxy.Name), "status", resp.StatusCode, "duration_ms", duration.Milliseconds())
			return resp, nil
		}
		g.anonymous.MarkFailure(node, resp, err)
		lastResponse = resp
		lastErr = err
		if err != nil {
			g.logger.Debug("anonymous transport attempt failed", "component", "upstream", "event", "anonymous_attempt_transport_failed", "request_id", reqIDs.Request, "attempt", attempts, "proxy", config.RedactURL(node.Proxy.Name), "duration_ms", duration.Milliseconds(), "error", err)
		} else {
			g.logger.Debug("anonymous upstream returned an error response; trying the next proxy", "component", "upstream", "event", "anonymous_attempt_response_failed", "request_id", reqIDs.Request, "attempt", attempts, "proxy", config.RedactURL(node.Proxy.Name), "status", resp.StatusCode, "duration_ms", duration.Milliseconds())
		}
	}
	if lastResponse != nil {
		return lastResponse, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no healthy anonymous proxies available")
	}
	return nil, lastErr
}

func newUpstreamRequest(ctx context.Context, baseURL string, protocol catalog.Protocol, body []byte, reqIDs ids.RequestIDs, key string) (*http.Request, error) {
	endpoint := strings.TrimRight(baseURL, "/") + protocolPath(protocol)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("User-Agent", ids.UserAgent())
	req.Header.Set("x-opencode-client", "cli")
	req.Header.Set("x-opencode-session", reqIDs.Session)
	// OpenCode 1.18.x sends these correlation headers to preserve provider-side
	// prompt/session affinity. Keep the legacy x-opencode-session header too so
	// older Zen deployments continue to recognize the request.
	req.Header.Set("x-session-affinity", reqIDs.Session)
	req.Header.Set("X-Session-Id", reqIDs.Session)
	req.Header.Set("x-opencode-request", reqIDs.Request)
	req.Header.Set("x-opencode-project", reqIDs.Project)
	if reqIDs.ParentSession != "" {
		req.Header.Set("x-parent-session-id", reqIDs.ParentSession)
	}
	if protocol == catalog.ProtocolAnthropic {
		// Interface placeholder: the Anthropic lane is not registered.
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("anthropic-beta", "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14")
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	return req, nil
}

func isNonRetryableClientResponse(resp *http.Response, err error) bool {
	return err == nil && resp != nil && resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusTooManyRequests
}

// syncProxyResult is the trimmed upstream proxy-health update: transport
// failures mark the route unhealthy, any real HTTP response proves it
// reachable. The upstream cloudflare verification probe for ambiguous 4xx/5xx
// outcomes is deferred to Phase 3 (single direct exit must not generate
// probe traffic, plan.md 3.4).
func (g *Gateway) syncProxyResult(proxy *pool.ProxyTransport, status int, err error) {
	if proxy == nil {
		return
	}
	if pool.IsProxyFailure(err) {
		if proxy.Healthy.Swap(false) {
			g.logger.Warn("proxy became unavailable", "component", "proxy", "event", "proxy_unavailable", "proxy", config.RedactURL(proxy.Name))
		}
		return
	}
	if status >= 200 && status < 600 {
		if !proxy.Healthy.Swap(true) {
			g.logger.Info("proxy connectivity restored", "component", "proxy", "event", "proxy_restored", "proxy", config.RedactURL(proxy.Name))
		}
	}
}

func protocolPath(protocol catalog.Protocol) string {
	switch protocol {
	case catalog.ProtocolResponses:
		return "/v1/responses"
	case catalog.ProtocolAnthropic:
		return "/v1/messages"
	default:
		return "/v1/chat/completions"
	}
}

func (g *Gateway) StartModelRefresh(ctx context.Context) {
	refresh := func() {
		// The anonymous lane refresh is refreshAnonymousTier
		// (gateway.go:870-891): the authenticated key-tier refresh paths are
		// not ported.
		if models := g.refreshAnonymousTier(ctx, g.cfg.Upstream.Zen); models != nil {
			g.catalog.Replace(models)
			g.logger.Info("model catalog refreshed", "component", "models", "event", "catalog_refreshed", "models", len(g.catalog.List()))
		}
	}
	go func() {
		refresh()
		ticker := time.NewTicker(time.Duration(g.cfg.Models.RefreshSeconds) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				refresh()
			}
		}
	}()
}

func (g *Gateway) refreshAnonymousTier(ctx context.Context, base string) []string {
	cursor := g.anonymous.CursorFor("")
	limit := g.anonymous.Len()
	for attempt := 1; attempt <= limit; attempt++ {
		node := cursor.Next()
		if node == nil {
			break
		}
		refreshCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		models, status, err := catalog.FetchModels(refreshCtx, node.Proxy.Client, base, anonymousZenKey)
		g.syncProxyResult(node.Proxy, status, err)
		cancel()
		if err == nil {
			g.anonymous.MarkSuccess(node)
			return models
		}
		g.anonymous.MarkFailure(node, nil, err)
		g.logger.Debug("anonymous model catalog refresh attempt failed", "component", "models", "event", "anonymous_refresh_attempt_failed", "upstream", config.RedactURL(base), "attempt", attempt, "proxy", config.RedactURL(node.Proxy.Name), "error", err)
	}
	g.logger.Warn("anonymous model catalog refresh failed", "component", "models", "event", "anonymous_refresh_failed", "upstream", config.RedactURL(base))
	return nil
}

func copyErrorResponse(w http.ResponseWriter, protocol catalog.Protocol, resp *http.Response, requestID string) {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	message := http.StatusText(resp.StatusCode)
	var value map[string]any
	if json.Unmarshal(body, &value) == nil {
		message = ids.FirstString(ids.StringAt(value, "error", "message"), ids.StringAt(value, "message"), message)
	}
	writeAPIError(w, protocol, resp.StatusCode, message, "upstream_error", requestID)
}

func writeAPIError(w http.ResponseWriter, protocol catalog.Protocol, status int, message, kind, requestID string) {
	w.Header().Set("Content-Type", "application/json")
	if requestID != "" {
		w.Header().Set("x-request-id", requestID)
	}
	if protocol == catalog.ProtocolAnthropic {
		writeJSONStatus(w, status, map[string]any{"type": "error", "error": map[string]any{"type": kind, "message": message}})
		return
	}
	writeJSONStatus(w, status, map[string]any{"error": map[string]any{"message": message, "type": kind, "param": nil, "code": nil}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	writeJSONStatus(w, status, value)
}

func writeJSONStatus(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
