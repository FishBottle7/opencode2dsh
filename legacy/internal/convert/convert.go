// Package convert ports opencode2api convert.go/stream.go, trimmed to the
// Chat<->Chat identity path plus the SSE usage observer. The cross-protocol
// bridge (Responses/Anthropic encoders, stream emitter) is intentionally left
// as an interface stub: opencode2dsh speaks Chat end to end (design.md 6.3).
package convert

import (
	"encoding/json"
	"fmt"
	"strings"

	"opencode2dsh/agent/internal/catalog"
)

const toolReasoningPlaceholder = "tool call"

var reasoningVendorHints = [...]string{"moonshot", "kimi", "deepseek", "mimo", "xiaomimimo"}

// BridgeUsage is the bridge usage record from convert.go:71-81 (verbatim).
type BridgeUsage struct {
	// Input is the total prompt input, including cache reads and writes. This
	// matches OpenAI's prompt_tokens semantics and lets each output encoder
	// split the provider-specific cache fields exactly once.
	Input         int
	Output        int
	Total         int
	Cached        int
	CacheCreation int
	Reasoning     int
}

// ConvertRequest keeps the upstream same-protocol identity branch. Cross
// protocol conversion is an interface placeholder in opencode2dsh.
func ConvertRequest(from, to Protocol, input map[string]any) (map[string]any, error) {
	if from == to {
		return cloneMap(input), nil
	}
	return nil, fmt.Errorf("protocol conversion %s->%s is not available in opencode2dsh", from, to)
}

// PrepareUpstreamRequest is the single request preparation path for both
// pass-through and transcoded requests (convert.go:111-118 verbatim). Same
// protocol requests are cloned so provider-specific fields survive, while
// cross-protocol requests would go through the bridge. Target-protocol
// normalization then repairs reasoning history in either case.
func PrepareUpstreamRequest(from, to Protocol, input map[string]any, upstreamURL string) (map[string]any, error) {
	output, err := ConvertRequest(from, to, input)
	if err != nil {
		return nil, err
	}
	normalizeToolReasoningHistory(to, stringAt(output, "model"), upstreamURL, output)
	return output, nil
}

// normalizeToolReasoningHistory applies only to endpoints that are known to
// require reasoning replay, or to requests that explicitly enable reasoning.
// Normalizing the target shape makes the behavior independent of the client
// protocol used to reach the gateway. (convert.go:124-136 verbatim; the
// Anthropic branch is not ported.)
func normalizeToolReasoningHistory(protocol Protocol, model, upstreamURL string, input map[string]any) bool {
	if !shouldNormalizeToolReasoningHistory(model, upstreamURL, input) {
		return false
	}
	switch protocol {
	case ProtocolChat:
		return normalizeChatToolReasoningHistory(input)
	default:
		return false
	}
}

// shouldNormalizeToolReasoningHistory identifies providers whose compatible
// endpoints require thinking/reasoning to be replayed with assistant tool
// calls. Explicit reasoning settings also cover aliased model names.
func shouldNormalizeToolReasoningHistory(model, upstreamURL string, input map[string]any) bool {
	return isReasoningVendorIdentifier(model) || isReasoningVendorIdentifier(upstreamURL) || requestEnablesReasoning(input)
}

func isReasoningVendorIdentifier(value string) bool {
	value = strings.ToLower(value)
	for _, hint := range reasoningVendorHints {
		if strings.Contains(value, hint) {
			return true
		}
	}
	return false
}

func requestEnablesReasoning(input map[string]any) bool {
	for _, key := range []string{"reasoning_effort", "reasoning", "thinking", "effort"} {
		value, exists := input[key]
		if !exists || value == nil {
			continue
		}
		switch typed := value.(type) {
		case string:
			mode := strings.ToLower(strings.TrimSpace(typed))
			if mode != "" && mode != "none" && mode != "disabled" {
				return true
			}
		case bool:
			if typed {
				return true
			}
		case map[string]any:
			mode := strings.ToLower(strings.TrimSpace(firstString(stringAt(typed, "type"), stringAt(typed, "effort"))))
			if mode == "none" || mode == "disabled" {
				continue
			}
			return true
		default:
			return true
		}
	}
	return false
}

// normalizeChatToolReasoningHistory ensures every assistant tool-call turn
// carries reasoning_content. Some clients discard this non-standard field
// while retaining tool_calls, which otherwise makes the next thinking-mode
// request invalid. A legacy reasoning string is promoted when available.
func normalizeChatToolReasoningHistory(input map[string]any) bool {
	messages, ok := input["messages"].([]any)
	if !ok {
		return false
	}

	changed := false
	for _, rawMessage := range messages {
		message, ok := rawMessage.(map[string]any)
		if !ok || stringAt(message, "role") != "assistant" || len(sliceAt(message, "tool_calls")) == 0 {
			continue
		}
		if reasoning, ok := message["reasoning_content"].(string); ok && strings.TrimSpace(reasoning) != "" {
			continue
		}
		reasoning, _ := message["reasoning"].(string)
		if strings.TrimSpace(reasoning) == "" {
			reasoning = toolReasoningPlaceholder
		}
		message["reasoning_content"] = reasoning
		changed = true
	}
	return changed
}

// Protocol is re-exported for readability within this package.
type Protocol = catalog.Protocol

const (
	ProtocolChat      = catalog.ProtocolChat
	ProtocolResponses = catalog.ProtocolResponses
	ProtocolAnthropic = catalog.ProtocolAnthropic
)

// decodeOpenAIUsage is convert.go:1531-1547 verbatim.
func decodeOpenAIUsage(usage map[string]any) BridgeUsage {
	input := firstNonZero(intAt(usage, "prompt_tokens"), intAt(usage, "input_tokens"))
	output := firstNonZero(intAt(usage, "completion_tokens"), intAt(usage, "output_tokens"))
	total := intAt(usage, "total_tokens")
	if total == 0 {
		total = input + output
	}
	cached := firstNonZero(intAt(usage, "prompt_tokens_details", "cached_tokens"), intAt(usage, "input_tokens_details", "cached_tokens"))
	cacheCreation := firstNonZero(
		intAt(usage, "cache_creation_input_tokens"),
		intAt(usage, "prompt_tokens_details", "cache_creation_input_tokens"),
		intAt(usage, "prompt_tokens_details", "cache_write_tokens"),
		intAt(usage, "input_tokens_details", "cache_creation_input_tokens"),
	)
	reasoning := firstNonZero(intAt(usage, "completion_tokens_details", "reasoning_tokens"), intAt(usage, "output_tokens_details", "reasoning_tokens"))
	return BridgeUsage{Input: input, Output: output, Total: total, Cached: cached, CacheCreation: cacheCreation, Reasoning: reasoning}
}

func firstNonZero(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func cloneMap(input map[string]any) map[string]any {
	data, _ := json.Marshal(input)
	var output map[string]any
	_ = json.Unmarshal(data, &output)
	return output
}

func sliceAt(object map[string]any, path ...string) []any {
	values, _ := anyAt(object, path...).([]any)
	return values
}

func mapAt(object map[string]any, path ...string) map[string]any {
	value, _ := anyAt(object, path...).(map[string]any)
	return value
}

func stringAt(object map[string]any, path ...string) string {
	value, _ := anyAt(object, path...).(string)
	return value
}

func boolAt(object map[string]any, path ...string) bool {
	value, _ := anyAt(object, path...).(bool)
	return value
}

func intAt(object map[string]any, path ...string) int {
	value := anyAt(object, path...)
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case json.Number:
		integer, _ := number.Int64()
		return int(integer)
	default:
		return 0
	}
}

func anyAt(object map[string]any, path ...string) any {
	var current any = object
	for _, key := range path {
		next, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = next[key]
	}
	return current
}

func firstString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func firstAny(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
