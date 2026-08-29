package gateway

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"opencode2dsh/agent/internal/catalog"
	"opencode2dsh/agent/internal/config"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func testConfig(keys ...string) config.Config {
	cfg := config.Config{
		Listen:      "127.0.0.1:0",
		ServerKeys:  keys,
		Anonymous:   true,
		Upstream:    config.UpstreamConfig{Zen: "https://opencode.ai/zen"},
		Retry:       config.RetryConfig{MaxAttempts: 2, TimeoutSeconds: 30},
		Models:      config.ModelsConfig{RefreshSeconds: 300},
		Performance: config.PerformanceConfig{MaxIdleConns: 8, MaxIdleConnsPerHost: 2, IdleConnTimeoutSeconds: 30, ConnectTimeoutSeconds: 2, FailureCooldownSeconds: 1},
		Logging:     config.LoggingConfig{Level: "debug"},
	}
	normalized, err := config.NormalizeConfig("config.json", cfg)
	if err != nil {
		panic(err)
	}
	return normalized
}

// newTestGateway starts the gateway with an optional upstream stub and an
// optional pinned S3 static list.
func newTestGateway(t *testing.T, upstream http.HandlerFunc, static []string, keys ...string) (*Gateway, *httptest.Server) {
	t.Helper()
	if static != nil {
		catalog.SetStaticFreeModelsForTesting(static)
		t.Cleanup(func() { catalog.SetStaticFreeModelsForTesting(nil) })
	}
	gw, err := NewGateway(testConfig(keys...), discardLogger(), catalog.NewModelMetadataStore("", nil))
	if err != nil {
		t.Fatal(err)
	}
	if upstream != nil {
		upstreamServer := httptest.NewServer(upstream)
		t.Cleanup(upstreamServer.Close)
		gw.cfg.Upstream.Zen = upstreamServer.URL
	}
	api := httptest.NewServer(gw.Handler())
	t.Cleanup(api.Close)
	return gw, api
}

func TestAuthenticate(t *testing.T) {
	_, api := newTestGateway(t, nil, nil, "dev")

	resp, err := http.Get(api.URL + "/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing key must 401, got %d", resp.StatusCode)
	}

	req, _ := http.NewRequest("GET", api.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong bearer must 401, got %d", resp.StatusCode)
	}

	req, _ = http.NewRequest("GET", api.URL+"/v1/models", nil)
	req.Header.Set("x-api-key", "dev")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("x-api-key must be accepted (gateway.go:172), got %d", resp.StatusCode)
	}
}

func TestHandleModelsExposesStaticWhilePending(t *testing.T) {
	_, api := newTestGateway(t, nil, []string{"static-verified"}, "dev")
	req, _ := http.NewRequest("GET", api.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Data) != 1 || payload.Data[0]["id"] != "static-verified" {
		t.Fatalf("static verified model must be exposed while pending, got %v", payload.Data)
	}
}

func TestHandleModelsEmptyWithoutStatic(t *testing.T) {
	_, api := newTestGateway(t, nil, nil, "dev")
	req, _ := http.NewRequest("GET", api.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	// Pending catalog with an empty static list: /v1/models stays empty until
	// the first successful refresh (honest behavior, design.md 4.2).
	if len(payload.Data) != 0 {
		t.Fatalf("no data sources configured must expose nothing, got %v", payload.Data)
	}
}

func TestHandleInferenceEndToEnd(t *testing.T) {
	var seen http.Header
	_, api := newTestGateway(t, func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("upstream path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer public" {
			t.Errorf("anonymous credential must be Bearer public, got %q", got)
		}
		if r.Header.Get("x-opencode-client") != "cli" {
			t.Error("client header missing")
		}
		if !strings.HasPrefix(r.Header.Get("x-opencode-session"), "ses_") {
			t.Error("session header missing")
		}
		if !strings.Contains(r.Header.Get("User-Agent"), "opencode/") {
			t.Error("user agent missing")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"chatcmpl-1","choices":[{"index":0,"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}, []string{"ping-model"}, "dev")

	req, _ := http.NewRequest("POST", api.URL+"/v1/chat/completions", strings.NewReader(`{"model":"ping-model","messages":[{"role":"user","content":"ping"}]}`))
	req.Header.Set("Authorization", "Bearer dev")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("e2e inference failed: %d %s", resp.StatusCode, raw)
	}
	if resp.Header.Get("x-request-id") == "" {
		t.Fatal("x-request-id must be set on responses")
	}
	var payload map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	if payload["id"] != "chatcmpl-1" {
		t.Fatalf("response not passed through: %v", payload)
	}
	if seen == nil || seen.Get("x-opencode-request") == "" || seen.Get("x-opencode-project") == "" {
		t.Fatalf("correlation headers must reach upstream: %v", seen)
	}
}

func TestHandleInferenceStreamPassThrough(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant"}}]}`,
		``,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}`,
		``,
		`data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")
	_, api := newTestGateway(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, sse)
	}, []string{"stream-model"}, "dev")

	req, _ := http.NewRequest("POST", api.URL+"/v1/chat/completions", strings.NewReader(`{"model":"stream-model","messages":[{"role":"user","content":"hi"}],"stream":true}`))
	req.Header.Set("Authorization", "Bearer dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "[DONE]") || !strings.Contains(string(raw), `"content":"hi"`) {
		t.Fatalf("stream must pass through verbatim, got: %s", raw)
	}
	if resp.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" {
		t.Fatalf("unexpected content type: %s", resp.Header.Get("Content-Type"))
	}
}

func TestCopyErrorResponsePassesStatusAndRetryAfter(t *testing.T) {
	_, api := newTestGateway(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "42")
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"message":"slow down"}}`)
	}, []string{"limited-model"}, "dev")

	req, _ := http.NewRequest("POST", api.URL+"/v1/chat/completions", strings.NewReader(`{"model":"limited-model","messages":[{"role":"user","content":"x"}]}`))
	req.Header.Set("Authorization", "Bearer dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("upstream status must be passed through, got %d", resp.StatusCode)
	}
	if resp.Header.Get("Retry-After") != "42" {
		t.Fatalf("Retry-After must be forwarded, got %q", resp.Header.Get("Retry-After"))
	}
	var payload map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	errObj := payload["error"].(map[string]any)
	if errObj["message"] != "slow down" || errObj["type"] != "upstream_error" {
		t.Fatalf("copyErrorResponse semantics changed: %v", payload)
	}
}

func TestHealthzStarting(t *testing.T) {
	_, api := newTestGateway(t, nil, nil, "dev")
	resp, err := http.Get(api.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Status != "starting" || payload.Ready || !payload.Anonymous {
		t.Fatalf("pending catalog must report starting/ready=false/anonymous=true: %+v", payload)
	}
	if !contains(payload.Issues, "model_catalog_pending") {
		t.Fatalf("pending issue missing: %v", payload.Issues)
	}
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("healthz must be 503 while starting, got %d", resp.StatusCode)
	}
}

func TestHealthzReadyAfterRefresh(t *testing.T) {
	gw, api := newTestGateway(t, nil, []string{"ok-model"}, "dev")
	gw.catalog.Replace([]string{"ok-model"})
	resp, err := http.Get(api.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload healthResponse
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	if payload.Status != "ok" || !payload.Ready {
		t.Fatalf("fresh catalog must be ok: %+v", payload)
	}
	if payload.Models.Zen != 1 || payload.Models.Exposed != 1 {
		t.Fatalf("unexpected models block: %+v", payload.Models)
	}
}

func TestUnknownModelRejected(t *testing.T) {
	gw, api := newTestGateway(t, nil, []string{"known-model"}, "dev")
	gw.catalog.Replace([]string{"known-model", "paid-model"})

	req, _ := http.NewRequest("POST", api.URL+"/v1/chat/completions", strings.NewReader(`{"model":"paid-model","messages":[{"role":"user","content":"x"}]}`))
	req.Header.Set("Authorization", "Bearer dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("routable-but-paid model must be rejected at routing, got %d", resp.StatusCode)
	}
	if !strings.Contains(payload["error"].(map[string]any)["message"].(string), "not available in the anonymous Zen catalog") {
		t.Fatalf("route error message unexpected: %v", payload)
	}

	req, _ = http.NewRequest("POST", api.URL+"/v1/chat/completions", strings.NewReader(`{"model":"totally-unknown","messages":[{"role":"user","content":"x"}]}`))
	req.Header.Set("Authorization", "Bearer dev")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown model must 400, got %d", resp.StatusCode)
	}
}

func TestModelRequired(t *testing.T) {
	_, api := newTestGateway(t, nil, nil, "dev")
	req, _ := http.NewRequest("POST", api.URL+"/v1/chat/completions", strings.NewReader(`{"messages":[]}`))
	req.Header.Set("Authorization", "Bearer dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing model must 400, got %d", resp.StatusCode)
	}
}

func TestOversizedBodyRejected(t *testing.T) {
	_, api := newTestGateway(t, nil, nil, "dev")
	huge := strings.Repeat("a", maxRequestBody+16)
	req, _ := http.NewRequest("POST", api.URL+"/v1/chat/completions", strings.NewReader(huge))
	req.Header.Set("Authorization", "Bearer dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized body must 400, got %d", resp.StatusCode)
	}
}

func TestStartModelRefreshPopulatesCatalog(t *testing.T) {
	gw, api := newTestGateway(t, func(w http.ResponseWriter, _ *http.Request) {
		// Free-judged ids: metadata is absent in this test, so the name
		// fallback (models.go:257) is what lets them pass the /v1/models
		// filter -- matching how real free models read via models.dev.
		w.Write([]byte(`{"data":[{"id":"dyn-a-free"},{"id":"dyn-b-free"}]}`))
	}, nil, "dev")
	gw.StartModelRefresh(context.Background())
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest("GET", api.URL+"/v1/models", nil)
		req.Header.Set("Authorization", "Bearer dev")
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			var payload struct {
				Data []map[string]any `json:"data"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&payload)
			resp.Body.Close()
			if len(payload.Data) == 2 {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("catalog was not populated by the refresh loop")
}

func TestUpstreamTransportFailureIs502(t *testing.T) {
	gw, api := newTestGateway(t, nil, []string{"unreachable-model"}, "dev")
	// Point upstream at a dead port to force a transport failure.
	gw.cfg.Upstream.Zen = "http://127.0.0.1:1"

	req, _ := http.NewRequest("POST", api.URL+"/v1/chat/completions", strings.NewReader(`{"model":"unreachable-model","messages":[{"role":"user","content":"x"}]}`))
	req.Header.Set("Authorization", "Bearer dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("transport failure must 502, got %d", resp.StatusCode)
	}
	var payload map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	if payload["error"].(map[string]any)["type"] != "upstream_error" {
		t.Fatalf("502 body mismatch: %v", payload)
	}
}

func TestProtocolPath(t *testing.T) {
	if protocolPath(catalog.ProtocolChat) != "/v1/chat/completions" {
		t.Fatal("chat path")
	}
	if protocolPath(catalog.ProtocolResponses) != "/v1/responses" {
		t.Fatal("responses path")
	}
	if protocolPath(catalog.ProtocolAnthropic) != "/v1/messages" {
		t.Fatal("anthropic path")
	}
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
