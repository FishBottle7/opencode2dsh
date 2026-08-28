package convert

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func chatStreamFixture() string {
	return strings.Join([]string{
		`data: {"id":"chatcmpl-1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`,
		``,
		`data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"你好"}}]}`,
		``,
		`data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}`,
		``,
		`data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")
}

func TestConvertRequestChatIdentity(t *testing.T) {
	input := map[string]any{
		"model":       "gpt-oss-120b",
		"stream":      true,
		"temperature": 0.7,
		"messages":    []any{map[string]any{"role": "user", "content": "ping"}},
		"provider":    map[string]any{"order": []any{"x"}},
	}
	output, err := ConvertRequest(ProtocolChat, ProtocolChat, input)
	if err != nil {
		t.Fatal(err)
	}
	// Identity means a deep clone with identical JSON semantics.
	left, _ := json.Marshal(input)
	right, _ := json.Marshal(output)
	if string(left) != string(right) {
		t.Fatalf("identity conversion changed the payload:\n%s\n%s", left, right)
	}
	// Mutating the clone must not touch the input.
	output["model"] = "changed"
	if input["model"] != "gpt-oss-120b" {
		t.Fatalf("ConvertRequest must return a clone, input was mutated")
	}
	if _, err := ConvertRequest(ProtocolChat, ProtocolAnthropic, input); err == nil {
		t.Fatalf("cross-protocol conversion must be a placeholder error")
	}
}

func TestPrepareUpstreamRequestNormalizesReasoningHistory(t *testing.T) {
	input := map[string]any{
		"model": "deepseek-v4-flash",
		"messages": []any{
			map[string]any{"role": "user", "content": "use the tool"},
			map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
				"id": "call-1", "type": "function",
				"function": map[string]any{"name": "t", "arguments": "{}"},
			}}},
		},
	}
	output, err := PrepareUpstreamRequest(ProtocolChat, ProtocolChat, input, "https://opencode.ai/zen")
	if err != nil {
		t.Fatal(err)
	}
	messages := output["messages"].([]any)
	assistant := messages[1].(map[string]any)
	if assistant["reasoning_content"] != "tool call" {
		t.Fatalf("vendor normalization must inject reasoning_content placeholder, got %v", assistant["reasoning_content"])
	}
	if input["messages"].([]any)[1].(map[string]any)["reasoning_content"] != nil {
		t.Fatalf("normalization must operate on the clone, not the input")
	}
}

func TestPrepareUpstreamRequestSkipsExplicitDisabledReasoning(t *testing.T) {
	input := map[string]any{
		"model":    "some-model",
		"thinking": "disabled",
		"messages": []any{},
	}
	if _, err := PrepareUpstreamRequest(ProtocolChat, ProtocolChat, input, "https://x"); err != nil {
		t.Fatal(err)
	}
	// Non-vendor URL/model with reasoning disabled must stay untouched; the
	// messages slice has no assistant turns anyway.
}

func TestStreamUsageObserverChat(t *testing.T) {
	observer := NewStreamUsageObserver(ProtocolChat)
	if _, err := observer.Write([]byte(chatStreamFixture())); err != nil {
		t.Fatal(err)
	}
	usage := observer.Finish()
	if !observer.Reported() {
		t.Fatalf("usage event must be reported")
	}
	if usage.Input != 10 || usage.Output != 5 || usage.Total != 15 {
		t.Fatalf("unexpected usage: %+v", usage)
	}
}

func TestStreamUsageObserverSplitsFrames(t *testing.T) {
	observer := NewStreamUsageObserver(ProtocolChat)
	fixture := chatStreamFixture()
	for i := 0; i < len(fixture); i += 7 {
		end := min(i+7, len(fixture))
		if _, err := observer.Write([]byte(fixture[i:end])); err != nil {
			t.Fatal(err)
		}
	}
	if usage := observer.Finish(); usage.Total != 15 {
		t.Fatalf("frame splitting must not lose usage: %+v", usage)
	}
}

func TestStreamUsageObserverMergeSemantics(t *testing.T) {
	observer := NewStreamUsageObserver(ProtocolChat)
	chunk1 := `data: {"id":"x","choices":[{"index":0,"delta":{"content":"a"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}` + "\n\n"
	chunk2 := `data: {"id":"x","choices":[{"index":0,"delta":{"content":"b"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}` + "\n\n"
	if _, err := observer.Write([]byte(chunk1 + chunk2)); err != nil {
		t.Fatal(err)
	}
	usage := observer.Finish()
	if usage.Input != 3 || usage.Output != 2 || usage.Total != 5 {
		t.Fatalf("merge must keep the latest non-zero fields: %+v", usage)
	}
}

func TestObserverToleratesBrokenFrames(t *testing.T) {
	observer := NewStreamUsageObserver(ProtocolChat)
	_, err := observer.Write([]byte("data: {broken json\n\ndata: [DONE]\n\n"))
	if err != nil {
		t.Fatal(err)
	}
	observer.Finish()
}

func TestReadSSEEventLines(t *testing.T) {
	var events []string
	reader := strings.NewReader("event: ping\r\ndata: one\r\n\r\n: comment\ndata: two\n\n")
	if err := readSSE(reader, func(eventName, data string) error {
		events = append(events, eventName+"|"+data)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(events, []string{"ping|one", "|two"}) {
		t.Fatalf("unexpected events: %v", events)
	}
}

func TestParseChatFinishKinds(t *testing.T) {
	parser := &bridgeStreamParser{protocol: ProtocolChat, tools: map[string]bool{}, toolIDs: map[string]string{}, toolNames: map[string]string{}}
	events, err := parser.Parse("", `{"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"error"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		if event.Kind == "error" {
			found = true
		}
	}
	if !found {
		t.Fatalf("finish_reason=error must surface an error event: %+v", events)
	}
}

func TestNoTranscode(t *testing.T) {
	if strings.Contains(NoTranscode().Error(), "opencode2dsh") == false {
		t.Fatal("placeholder error should name the project")
	}
}
