package obs

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewLoggerLevels(t *testing.T) {
	var buf bytes.Buffer
	logger := newLogger(&buf, "warn")
	logger.Info("suppressed")
	logger.Warn("kept", "k", "v")
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("warn level must suppress info: %q", buf.String())
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &record); err != nil {
		t.Fatal(err)
	}
	if record["msg"] != "kept" {
		t.Fatalf("unexpected record: %v", record)
	}
}

func TestSanitizeLogAttrSecretKeys(t *testing.T) {
	if got := sanitizeLogAttr(slog.String("authorization", "Bearer dev")); got.Value.String() != "***" {
		t.Fatalf("authorization must be redacted: %v", got)
	}
	if got := sanitizeLogAttr(slog.String("model", "m")); got.Value.String() != "m" {
		t.Fatalf("normal keys must pass through: %v", got)
	}
	if got := sanitizeLogAttr(slog.Any("error", errString("boom"))); got.Value.String() != "boom" {
		t.Fatalf("errors must render as strings: %v", got)
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func TestRecoveryMiddleware(t *testing.T) {
	var buf bytes.Buffer
	logger := newLogger(&buf, "info")
	panicky := RecoveryMiddleware(logger, panickingHandler{})
	recorder := httptest.NewRecorder()
	panicky.ServeHTTP(recorder, httptest.NewRequest("GET", "/v1/models", nil))
	if recorder.Code != 500 {
		t.Fatalf("panic must map to 500, got %d", recorder.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	errObj := body["error"].(map[string]any)
	if errObj["type"] != "server_error" {
		t.Fatalf("unexpected error body: %v", body)
	}
	if !strings.Contains(buf.String(), "request_panic") {
		t.Fatalf("panic must be logged: %s", buf.String())
	}
}

type panickingHandler struct{}

func (panickingHandler) ServeHTTP(_ http.ResponseWriter, _ *http.Request) { panic("boom") }

func TestEncodeSSE(t *testing.T) {
	recorder := httptest.NewRecorder()
	if err := EncodeSSE(recorder, "ping", 7, map[string]any{"a": 1}); err != nil {
		t.Fatal(err)
	}
	want := "id: 7\nevent: ping\ndata: {\"a\":1}\n\n"
	if recorder.Body.String() != want {
		t.Fatalf("got %q want %q", recorder.Body.String(), want)
	}
}
