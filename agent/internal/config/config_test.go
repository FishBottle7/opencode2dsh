package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadConfigDefaults(t *testing.T) {
	cfg, err := LoadConfig(writeTemp(t, `{
		// comment support comes from stripJSONComments
		"server_keys": ["dev"]
	}`))
	if err != nil {
		t.Fatalf("valid minimal config rejected: %v", err)
	}
	if cfg.Listen != "127.0.0.1:0" {
		t.Fatalf("default listen must be loopback random port, got %q", cfg.Listen)
	}
	if !cfg.Anonymous {
		t.Fatalf("anonymous must default to true")
	}
	if cfg.Upstream.Zen != "https://opencode.ai/zen" {
		t.Fatalf("unexpected default zen upstream: %q", cfg.Upstream.Zen)
	}
	if cfg.Retry.TimeoutSeconds != 300 || cfg.Models.RefreshSeconds != 300 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if got := cfg.RuntimeProxies(); len(got) != 1 || got[0] != "direct" {
		t.Fatalf("proxies must default to [direct], got %v", got)
	}
}

func TestLoadConfigValidVariants(t *testing.T) {
	cases := []string{
		`{"listen":"localhost:8317","server_keys":["a"],"anonymous":true,"proxies":["direct"]}`,
		`{"listen":"[::1]:0","server_keys":["a","b"],"upstream":{"zen":"http://example.internal/zen"},"retry":{"max_attempts":2,"timeout_seconds":60}}`,
		`{"server_keys":["a"],"logging":{"level":"debug"},"performance":{"max_idle_conns":10,"max_idle_conns_per_host":2,"idle_conn_timeout_seconds":5,"connect_timeout_seconds":1,"failure_cooldown_seconds":1}}`,
	}
	for i, raw := range cases {
		if _, err := LoadConfig(writeTemp(t, raw)); err != nil {
			t.Fatalf("valid case %d rejected: %v", i, err)
		}
	}
}

func TestLoadConfigInvalidVariants(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{`{"listen":"0.0.0.0:8080","server_keys":["a"]}`, "loopback"},
		{`{"listen":"192.168.1.5:8080","server_keys":["a"]}`, "loopback"},
		{`{"server_keys":["a"],"anonymous":false}`, "anonymous"},
		{`{}`, "server_keys"},
		{`{"server_keys":[]}`, "server_keys"},
		{`{"server_keys":["a"],"upstream":{"zen":"not-a-url"}}`, "http or https"},
		{`{"server_keys":["a"],"retry":{"max_attempts":0}}`, "max_attempts"},
		{`{"server_keys":["a"],"logging":{"level":"trace"}}`, "logging.level"},
		{`{"server_keys":["a"],"unknown_field":1}`, "unknown field"},
		{`{"server_keys":["a"],"proxies":["ftp://x"]}`, "proxy scheme"},
	}
	for i, tc := range cases {
		_, err := LoadConfig(writeTemp(t, tc.raw))
		if err == nil {
			t.Fatalf("invalid case %d accepted: %s", i, tc.raw)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("case %d error %q does not mention %q", i, err.Error(), tc.want)
		}
	}
}

func TestStripJSONCommentsPreservesURLs(t *testing.T) {
	out, err := stripJSONComments([]byte(`{"upstream":{"zen":"https://opencode.ai/zen"}} /* block */`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "https://opencode.ai/zen") {
		t.Fatalf("comment stripper damaged URL content: %s", out)
	}
	if _, err := stripJSONComments([]byte(`{"a": /* unterminated`)); err == nil {
		t.Fatalf("unterminated block comment must error")
	}
}

func TestSaveConfigAtomicRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-config.json")
	cfg, err := LoadConfig(writeTemp(t, `{"server_keys":["secret"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := SaveConfigAtomic(path, cfg); err != nil {
		t.Fatal(err)
	}
	reloaded, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("reloading saved config failed: %v", err)
	}
	if reloaded.Listen != cfg.Listen || !reloaded.Anonymous {
		t.Fatalf("round trip changed semantics: %+v", reloaded)
	}
	if got := reloaded.RuntimeProxies(); len(got) != 1 || got[0] != "direct" {
		t.Fatalf("saved config must not persist effective proxies: %v", got)
	}
}
