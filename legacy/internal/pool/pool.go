// Package pool ports opencode2api pool.go, trimmed to the transport pool and
// the anonymous cooldown pool. The authenticated key-node machinery (nodePool,
// upstreamNode, nodeCursor, proxy rebinding) is not ported: opencode2dsh never
// configures upstream keys. The gray multi-IP rotation stays dormant by
// default -- proxies=["direct"] is a single node, and MarkFailure then acts as
// an honest single-exit cooldown/backoff (design.md 9.2).
package pool

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"opencode2dsh/agent/internal/config"
	"opencode2dsh/agent/internal/ids"
)

type ProxyTransport struct {
	Index    int
	Name     string
	Client   *http.Client
	Healthy  atomic.Bool
	Checking atomic.Bool
}

type TransportPool struct {
	Items []*ProxyTransport
}

// AnonymousPool gives the shared OpenCode "public" credential an independent
// cooldown per proxy. Unlike key nodes, anonymous nodes are never rebound:
// changing proxy is the failover mechanism because Zen rate-limits them by IP.
type AnonymousPool struct {
	nodes    []*AnonymousNode
	next     atomic.Uint64
	cooldown time.Duration
}

type AnonymousNode struct {
	Proxy         *ProxyTransport
	failures      atomic.Uint32
	cooldownUntil atomic.Int64
}

type AnonymousCursor struct {
	pool   *AnonymousPool
	start  int
	offset int
}

func NewAnonymousPool(enabled bool, transports *TransportPool, cooldown time.Duration) *AnonymousPool {
	anonymous := &AnonymousPool{cooldown: cooldown}
	if !enabled || transports == nil {
		return anonymous
	}
	anonymous.nodes = make([]*AnonymousNode, 0, len(transports.Items))
	for _, proxy := range transports.Items {
		anonymous.nodes = append(anonymous.nodes, &AnonymousNode{Proxy: proxy})
	}
	return anonymous
}

func (p *AnonymousPool) Len() int {
	if p == nil {
		return 0
	}
	return len(p.nodes)
}

func (p *AnonymousPool) CursorFor(affinity string) AnonymousCursor {
	if p == nil || len(p.nodes) == 0 {
		return AnonymousCursor{pool: p}
	}
	start := 0
	if affinity == "" {
		start = int((p.next.Add(1) - 1) % uint64(len(p.nodes)))
	} else {
		hash := fnv.New64a()
		_, _ = hash.Write([]byte(affinity))
		start = int(hash.Sum64() % uint64(len(p.nodes)))
	}
	return AnonymousCursor{pool: p, start: start}
}

// Next visits each healthy, non-cooling proxy at most once per cursor.
func (c *AnonymousCursor) Next() *AnonymousNode {
	if c.pool == nil || len(c.pool.nodes) == 0 {
		return nil
	}
	now := time.Now().UnixNano()
	for c.offset < len(c.pool.nodes) {
		node := c.pool.nodes[(c.start+c.offset)%len(c.pool.nodes)]
		c.offset++
		if node.Proxy.Healthy.Load() && node.cooldownUntil.Load() <= now {
			return node
		}
	}
	return nil
}

func (p *AnonymousPool) MarkSuccess(node *AnonymousNode) {
	if node == nil {
		return
	}
	node.failures.Store(0)
	node.cooldownUntil.Store(0)
}

func (p *AnonymousPool) MarkFailure(node *AnonymousNode, resp *http.Response, err error) {
	if node == nil {
		return
	}
	if err == nil && resp != nil && resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < 500 {
		return
	}
	failures := node.failures.Add(1)
	delay := p.cooldown * time.Duration(1<<min(failures-1, 3))
	if resp != nil {
		if retryAfter := parseRetryAfter(resp.Header.Get("Retry-After")); retryAfter > delay {
			delay = retryAfter
		}
	}
	node.cooldownUntil.Store(time.Now().Add(delay).UnixNano())
}

// CooldownUntil exposes the node cooldown for diagnostics and tests.
func (n *AnonymousNode) CooldownUntil() time.Time {
	return time.Unix(0, n.cooldownUntil.Load())
}

func (p *TransportPool) HasHealthy() bool {
	for _, proxy := range p.Items {
		if proxy.Healthy.Load() {
			return true
		}
	}
	return false
}

func (p *TransportPool) HealthCounts() (total, healthy int) {
	if p == nil {
		return 0, 0
	}
	for _, proxy := range p.Items {
		if proxy.Healthy.Load() {
			healthy++
		}
	}
	return len(p.Items), healthy
}

func NewTransportPool(proxies []string, perf config.PerformanceConfig, responseHeaderTimeout time.Duration) (*TransportPool, error) {
	p := &TransportPool{Items: make([]*ProxyTransport, 0, len(proxies))}
	for _, raw := range proxies {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.MaxIdleConns = perf.MaxIdleConns
		transport.MaxIdleConnsPerHost = perf.MaxIdleConnsPerHost
		transport.MaxConnsPerHost = perf.MaxConnsPerHost
		transport.IdleConnTimeout = time.Duration(perf.IdleConnTimeoutSeconds) * time.Second
		transport.ResponseHeaderTimeout = responseHeaderTimeout
		transport.ForceAttemptHTTP2 = true
		transport.DialContext = (&net.Dialer{
			Timeout:   time.Duration(perf.ConnectTimeoutSeconds) * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext
		if raw == "direct" {
			transport.Proxy = nil
		} else {
			u, err := url.Parse(raw)
			if err != nil {
				return nil, fmt.Errorf("parse proxy %s: %w", config.RedactURL(raw), err)
			}
			transport.Proxy = http.ProxyURL(u)
		}
		proxy := &ProxyTransport{Index: len(p.Items), Name: raw, Client: &http.Client{Transport: transport}}
		proxy.Healthy.Store(true)
		p.Items = append(p.Items, proxy)
	}
	return p, nil
}

type ProxyHealthResult struct {
	Proxy      *ProxyTransport
	Err        error
	Failed     bool
	WasHealthy bool
}

// CheckHealth concurrently rechecks only proxies already marked unhealthy.
// Healthy proxies are skipped before a check is claimed. Any HTTP response
// from the test URL proves that the route is reachable; only a timeout or
// connection refusal keeps the proxy unhealthy.
func (p *TransportPool) CheckHealth(ctx context.Context, target string, timeout time.Duration) []ProxyHealthResult {
	results := make(chan ProxyHealthResult, len(p.Items))
	checks := 0
	for _, proxy := range p.Items {
		if proxy.Healthy.Load() || !proxy.Checking.CompareAndSwap(false, true) {
			continue
		}
		// A real request may have restored the proxy between the first health
		// read and claiming this check.
		if proxy.Healthy.Load() {
			proxy.Checking.Store(false)
			continue
		}
		checks++
		go func() {
			results <- p.checkClaimedProxy(ctx, proxy, target, timeout)
		}()
	}
	out := make([]ProxyHealthResult, 0, checks)
	for range checks {
		out = append(out, <-results)
	}
	return out
}

// checkClaimedProxy performs a check after the caller has acquired checking.
func (p *TransportPool) checkClaimedProxy(ctx context.Context, proxy *ProxyTransport, target string, timeout time.Duration) ProxyHealthResult {
	defer proxy.Checking.Store(false)
	checkCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(checkCtx, http.MethodGet, target, nil)
	if err == nil {
		req.Header.Set("User-Agent", ids.UserAgent())
		resp, requestErr := proxy.Client.Do(req)
		err = requestErr
		if resp != nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
			_ = resp.Body.Close()
		}
	}
	result := ProxyHealthResult{Proxy: proxy, Err: err, WasHealthy: proxy.Healthy.Load()}
	if err == nil {
		result.WasHealthy = proxy.Healthy.Swap(true)
	} else if isProxyFailure(err) {
		result.Failed = true
		result.WasHealthy = proxy.Healthy.Swap(false)
	}
	return result
}

// isProxyFailure deliberately recognizes only failures that say the proxy
// route is unavailable. HTTP responses and unrelated transport/protocol errors
// must not evict a proxy.
func isProxyFailure(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, syscall.ECONNREFUSED) {
		return true
	}
	var timeout interface{ Timeout() bool }
	return errors.As(err, &timeout) && timeout.Timeout()
}

// IsProxyFailure wraps isProxyFailure for the gateway.
func IsProxyFailure(err error) bool { return isProxyFailure(err) }

func parseRetryAfter(value string) time.Duration {
	if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil {
		return max(time.Until(when), 0)
	}
	return 0
}

func drainAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 64<<10))
	_ = body.Close()
}

// DrainAndClose wraps drainAndClose for the gateway.
func DrainAndClose(body io.ReadCloser) { drainAndClose(body) }
