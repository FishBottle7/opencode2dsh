// Package obs ports the opencode2dsh-needed subset of opencode2api
// observability.go: structured slog setup, request recovery middleware, and
// the SSE frame encoder. The LogHub ring buffer and SecretRedactor are not
// ported -- the agent runs as a child process whose stdout the plugin pipes.
package obs

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"opencode2dsh/agent/internal/catalog"
)

// NewLogger builds the structured JSON logger on stderr (stdout is reserved
// for the READY handshake in Phase 1).
func NewLogger(level string) *slog.Logger {
	return newLogger(os.Stderr, level)
}

func newLogger(output io.Writer, level string) *slog.Logger {
	levelVar := new(slog.LevelVar)
	setLogLevel(levelVar, level)
	return slog.New(slog.NewJSONHandler(output, &slog.HandlerOptions{
		Level: levelVar,
		ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
			return sanitizeLogAttr(attr)
		},
	}))
}

func setLogLevel(level *slog.LevelVar, value string) {
	switch value {
	case "debug":
		level.Set(slog.LevelDebug)
	case "warn":
		level.Set(slog.LevelWarn)
	case "error":
		level.Set(slog.LevelError)
	default:
		level.Set(slog.LevelInfo)
	}
}

// sanitizeLogAttr keeps the upstream key-based redaction; value-based
// redaction depended on the removed SecretRedactor.
func sanitizeLogAttr(attr slog.Attr) slog.Attr {
	attr.Value = attr.Value.Resolve()
	lower := strings.ToLower(attr.Key)
	if strings.Contains(lower, "password") || strings.Contains(lower, "authorization") || strings.Contains(lower, "cookie") || strings.Contains(lower, "secret") {
		return slog.String(attr.Key, "***")
	}
	if attr.Value.Kind() == slog.KindAny {
		if err, ok := attr.Value.Any().(error); ok {
			attr.Value = slog.StringValue(err.Error())
		}
	}
	return attr
}

// RecoveryMiddleware is observability.go:955-965 verbatim.
func RecoveryMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if value := recover(); value != nil {
				logger.Error("request handler panicked", "component", "http", "event", "request_panic", "error", value)
				writeAPIError(w, catalog.ProtocolChat, http.StatusInternalServerError, "internal server error", "server_error", "")
			}
		}()
		next.ServeHTTP(w, r)
	})
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

func writeJSONStatus(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// EncodeSSE is observability.go:903-915 verbatim.
func EncodeSSE(w http.ResponseWriter, event string, id uint64, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if id > 0 {
		_, _ = fmt.Fprintf(w, "id: %d\n", id)
	}
	if event != "" {
		_, _ = fmt.Fprintf(w, "event: %s\n", event)
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", data)
	return err
}
