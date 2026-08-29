package ids

import (
	"net/http"
	"strings"
	"testing"
)

func TestDeriveRequestIDsStableOnSessionHeader(t *testing.T) {
	body := map[string]any{"model": "m", "messages": []any{map[string]any{"role": "user", "content": "hello"}}}
	first := deriveRequestIDs(requestWithHeader("x-opencode-session", "abc"), body)
	second := deriveRequestIDs(requestWithHeader("x-opencode-session", "abc"), body)
	if first.Session != second.Session {
		t.Fatalf("session id changed for identical signal: %s vs %s", first.Session, second.Session)
	}
	if !strings.HasPrefix(first.Session, "ses_") {
		t.Fatalf("session id missing ses_ prefix: %s", first.Session)
	}
	if !strings.HasPrefix(first.Project, "prj_") {
		t.Fatalf("project id missing prj_ prefix: %s", first.Project)
	}
}

func TestDeriveRequestIDsStableOnFirstUserMessage(t *testing.T) {
	body := func(content string) map[string]any {
		return map[string]any{"messages": []any{
			map[string]any{"role": "user", "content": content},
			map[string]any{"role": "assistant", "content": "reply"},
			map[string]any{"role": "user", "content": "second turn"},
		}}
	}
	first := deriveRequestIDs(requestWithHeader("", ""), body("hello"))
	second := deriveRequestIDs(requestWithHeader("", ""), body("hello"))
	if first.Session != second.Session {
		t.Fatalf("multi-turn conversation lost session affinity: %s vs %s", first.Session, second.Session)
	}
	other := deriveRequestIDs(requestWithHeader("", ""), body("different opening"))
	if first.Session == other.Session {
		t.Fatalf("different openings must map to different sessions")
	}
}

func TestDeriveRequestIDsRandomFallback(t *testing.T) {
	first := deriveRequestIDs(requestWithHeader("", ""), map[string]any{})
	second := deriveRequestIDs(requestWithHeader("", ""), map[string]any{})
	if first.Session == second.Session {
		t.Fatalf("missing signal must produce a random fallback, got identical session %s", first.Session)
	}
	if !strings.HasPrefix(first.Session, "ses_") {
		t.Fatalf("fallback session id missing ses_ prefix: %s", first.Session)
	}
}

func TestHeaderPrecedenceOverConversationSeed(t *testing.T) {
	withHeader := deriveRequestIDs(requestWithHeader("x-session-affinity", "affinity"), map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	})
	without := deriveRequestIDs(requestWithHeader("", ""), map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	})
	if withHeader.Session == without.Session {
		t.Fatalf("explicit header must win over conversation seed")
	}
}

func TestUserAgentShape(t *testing.T) {
	ua := opencodeUserAgent()
	if !strings.HasPrefix(ua, "opencode/1.18.21 (") {
		t.Fatalf("unexpected user agent: %s", ua)
	}
}

func requestWithHeader(key, value string) *http.Request {
	r, err := http.NewRequest(http.MethodPost, "http://127.0.0.1/v1/chat/completions", nil)
	if err != nil {
		panic(err)
	}
	if key != "" {
		r.Header.Set(key, value)
	}
	return r
}
