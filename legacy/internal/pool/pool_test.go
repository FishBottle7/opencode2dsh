package pool

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"opencode2dsh/agent/internal/config"
)

func newDirectPool(t *testing.T, cooldown time.Duration) (*TransportPool, *AnonymousPool) {
	t.Helper()
	transports, err := NewTransportPool([]string{"direct"}, testPerformance(), 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	anonymous := NewAnonymousPool(true, transports, cooldown)
	return transports, anonymous
}

func testPerformance() config.PerformanceConfig {
	return config.PerformanceConfig{
		MaxIdleConns: 16, MaxIdleConnsPerHost: 4, IdleConnTimeoutSeconds: 60,
		ConnectTimeoutSeconds: 2, FailureCooldownSeconds: 15,
	}
}

func TestDirectSingleNodeCursor(t *testing.T) {
	_, anonymous := newDirectPool(t, time.Second)
	if anonymous.Len() != 1 {
		t.Fatalf("direct pool must have exactly one node, got %d", anonymous.Len())
	}
	cursor := anonymous.CursorFor("session-1")
	first := cursor.Next()
	if first == nil {
		t.Fatalf("healthy direct node must be returned once")
	}
	if again := cursor.Next(); again != nil {
		t.Fatalf("cursor must visit each node at most once, got second visit")
	}
	fresh := anonymous.CursorFor("")
	if fresh.Next() == nil {
		t.Fatalf("fresh cursor must reach the node again")
	}
}

func TestMarkFailureExponentialCooldown(t *testing.T) {
	_, anonymous := newDirectPool(t, 100*time.Millisecond)
	cursor := anonymous.CursorFor("")
	node := cursor.Next()
	if node == nil {
		t.Fatal("node expected")
	}
	resp := &http.Response{StatusCode: http.StatusTooManyRequests, Header: http.Header{}}
	anonymous.MarkFailure(node, resp, nil)
	if cursor.Next() != nil {
		t.Fatalf("node must be cooling after 429")
	}
	if until := node.CooldownUntil(); time.Until(until) <= 0 {
		t.Fatalf("cooldown must be in the future: %v", until)
	}
	anonymous.MarkSuccess(node)
	fresh := anonymous.CursorFor("")
	if again := fresh.Next(); again == nil {
		t.Fatalf("MarkSuccess must clear the cooldown")
	}
}

func TestMarkFailureHonorsRetryAfter(t *testing.T) {
	_, anonymous := newDirectPool(t, 50*time.Millisecond)
	cursor := anonymous.CursorFor("")
	node := cursor.Next()
	resp := &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{"120"}}}
	anonymous.MarkFailure(node, resp, nil)
	if until := node.CooldownUntil(); time.Until(until) < 119*time.Second {
		t.Fatalf("Retry-After must dominate the base cooldown, got %v", until)
	}
}

func TestMarkFailureIgnoresClientErrors(t *testing.T) {
	_, anonymous := newDirectPool(t, time.Second)
	cursor := anonymous.CursorFor("")
	node := cursor.Next()
	for _, status := range []int{http.StatusBadRequest, http.StatusNotFound, http.StatusConflict} {
		anonymous.MarkFailure(node, &http.Response{StatusCode: status, Header: http.Header{}}, nil)
	}
	if node.CooldownUntil().After(time.Now()) {
		t.Fatalf("non-retryable client errors must not cool the node")
	}
	fresh := anonymous.CursorFor("")
	if again := fresh.Next(); again == nil {
		t.Fatalf("node must stay reachable after 4xx")
	}
}

func TestDisabledAnonymousPool(t *testing.T) {
	transports, _ := newDirectPool(t, time.Second)
	disabled := NewAnonymousPool(false, transports, time.Second)
	if disabled.Len() != 0 {
		t.Fatalf("disabled pool must be empty")
	}
	if cursor := disabled.CursorFor("x"); cursor.Next() != nil {
		t.Fatalf("disabled pool must yield no nodes")
	}
	disabled.MarkSuccess(nil)
	disabled.MarkFailure(nil, nil, errors.New("x"))
}

func TestTransportPoolHealthTransitions(t *testing.T) {
	transports, _ := newDirectPool(t, time.Second)
	if !transports.HasHealthy() {
		t.Fatalf("fresh direct transport must be healthy (pool.go:150)")
	}
	proxy := transports.Items[0]
	proxy.Healthy.Store(false)
	total, healthy := transports.HealthCounts()
	if total != 1 || healthy != 0 {
		t.Fatalf("unexpected health counts: %d/%d", healthy, total)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	results := transports.CheckHealth(context.Background(), server.URL, 2*time.Second)
	if len(results) != 1 {
		t.Fatalf("expected one health check, got %d", len(results))
	}
	if results[0].Err != nil || !proxy.Healthy.Load() {
		t.Fatalf("reachable target must restore health: %+v", results[0])
	}
	if total, healthy = transports.HealthCounts(); healthy != 1 {
		t.Fatalf("health not restored: %d/%d", healthy, total)
	}
}

func TestIsProxyFailureClassification(t *testing.T) {
	if isProxyFailure(nil) {
		t.Fatal("nil must not be a failure")
	}
	if !isProxyFailure(context.DeadlineExceeded) {
		t.Fatal("deadline exceeded is a route failure")
	}
	if isProxyFailure(errors.New("some http error")) {
		t.Fatal("generic errors must not evict a proxy")
	}
	if isProxyFailure(&netError{}) {
		t.Fatal("non-timeout net errors must not evict a proxy")
	}
	if !isProxyFailure(&netTimeout{}) {
		t.Fatal("timeout errors must evict a proxy")
	}
}

type netError struct{}

func (*netError) Error() string { return "boom" }

type netTimeout struct{}

func (*netTimeout) Error() string   { return "timeout" }
func (*netTimeout) Timeout() bool   { return true }
func (*netTimeout) Temporary() bool { return false }

func TestParseRetryAfter(t *testing.T) {
	if d := parseRetryAfter("30"); d != 30*time.Second {
		t.Fatalf("seconds form: %v", d)
	}
	future := time.Now().Add(90 * time.Second).UTC().Format(http.TimeFormat)
	if d := parseRetryAfter(future); d < 80*time.Second {
		t.Fatalf("date form: %v", d)
	}
	if d := parseRetryAfter("garbage"); d != 0 {
		t.Fatalf("garbage must be zero: %v", d)
	}
}
