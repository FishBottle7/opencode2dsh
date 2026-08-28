package convert

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

type bridgeStreamEvent struct {
	Kind       string
	ResponseID string
	Model      string
	Text       string
	Signature  string
	ToolKey    string
	ToolID     string
	ToolName   string
	Stop       string
	Error      string
	ErrorType  string
	Encrypted  string
	Usage      *BridgeUsage
}

type bridgeStreamParser struct {
	protocol  Protocol
	started   bool
	tools     map[string]bool
	toolIDs   map[string]string
	toolNames map[string]string
	toolOrder []string
}

func nextSSEBoundary(data []byte) (int, int) {
	lf := bytes.Index(data, []byte("\n\n"))
	crlf := bytes.Index(data, []byte("\r\n\r\n"))
	if lf < 0 {
		if crlf < 0 {
			return -1, 0
		}
		return crlf, 4
	}
	if crlf >= 0 && crlf < lf {
		return crlf, 4
	}
	return lf, 2
}

func readSSE(reader io.Reader, handler func(eventName, data string) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	var eventName string
	var dataLines []string
	flush := func() error {
		if len(dataLines) == 0 {
			eventName = ""
			return nil
		}
		err := handler(eventName, strings.Join(dataLines, "\n"))
		eventName = ""
		dataLines = dataLines[:0]
		return err
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}

func (parser *bridgeStreamParser) Parse(eventName, data string) ([]bridgeStreamEvent, error) {
	if data == "[DONE]" {
		return []bridgeStreamEvent{{Kind: "done"}}, nil
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(data), &value); err != nil {
		return nil, fmt.Errorf("invalid upstream SSE JSON: %w", err)
	}
	switch parser.protocol {
	case ProtocolChat:
		return parser.parseChat(value), nil
	default:
		return nil, fmt.Errorf("unsupported stream protocol %q in opencode2dsh", parser.protocol)
	}
}

// parseChat is stream.go:212-271 verbatim.
func (parser *bridgeStreamParser) parseChat(value map[string]any) []bridgeStreamEvent {
	events := make([]bridgeStreamEvent, 0, 4)
	if !parser.started {
		if id := stringAt(value, "id"); id != "" {
			parser.started = true
			events = append(events, bridgeStreamEvent{Kind: "start", ResponseID: id, Model: stringAt(value, "model")})
		}
	}
	if usageMap := mapAt(value, "usage"); len(usageMap) > 0 {
		usage := decodeOpenAIUsage(usageMap)
		events = append(events, bridgeStreamEvent{Kind: "usage", Usage: &usage})
	}
	for _, raw := range sliceAt(value, "choices") {
		choice, _ := raw.(map[string]any)
		delta := mapAt(choice, "delta")
		if reasoning := firstString(stringAt(delta, "reasoning_content"), stringAt(delta, "reasoning")); reasoning != "" {
			events = append(events, bridgeStreamEvent{Kind: "reasoning", Text: reasoning})
		}
		if text := stringAt(delta, "content"); text != "" {
			events = append(events, bridgeStreamEvent{Kind: "text", Text: text})
		}
		for _, rawCall := range sliceAt(delta, "tool_calls") {
			call, _ := rawCall.(map[string]any)
			key := fmt.Sprint(firstAny(call["index"], stringAt(call, "id")))
			function := mapAt(call, "function")
			id := stringAt(call, "id")
			if _, seen := parser.tools[key]; !seen {
				parser.tools[key] = false
				parser.toolOrder = append(parser.toolOrder, key)
			}
			if id != "" {
				parser.toolIDs[key] = id
			}
			if name := stringAt(function, "name"); name != "" {
				parser.toolNames[key] = mergeToolName(parser.toolNames[key], name)
			}
			if arguments := stringAt(function, "arguments"); arguments != "" {
				if !parser.tools[key] && parser.toolNames[key] != "" {
					parser.tools[key] = true
					events = append(events, bridgeStreamEvent{Kind: "tool_start", ToolKey: key, ToolID: parser.toolIDs[key], ToolName: parser.toolNames[key]})
				}
				events = append(events, bridgeStreamEvent{Kind: "tool_delta", ToolKey: key, ToolID: parser.toolIDs[key], ToolName: parser.toolNames[key], Text: arguments})
			}
		}
		if stop := stringAt(choice, "finish_reason"); stop != "" {
			if isStreamErrorFinish(stop) {
				events = append(events, bridgeStreamEvent{Kind: "error", Error: firstString(stringAt(choice, "error", "message"), "upstream Chat stream failed"), ErrorType: "upstream_error"})
				continue
			}
			for _, key := range parser.toolOrder {
				if !parser.tools[key] && parser.toolNames[key] != "" {
					parser.tools[key] = true
					events = append(events, bridgeStreamEvent{Kind: "tool_start", ToolKey: key, ToolID: parser.toolIDs[key], ToolName: parser.toolNames[key]})
				}
			}
			events = append(events, bridgeStreamEvent{Kind: "finish", Stop: stop})
		}
	}
	return events
}

func isStreamErrorFinish(stop string) bool {
	switch strings.ToLower(strings.TrimSpace(stop)) {
	case "error", "network_error", "server_error":
		return true
	default:
		return false
	}
}

func mergeToolName(current, fragment string) string {
	if current == "" || fragment == current {
		return fragment
	}
	if strings.HasPrefix(fragment, current) {
		return fragment
	}
	return current + fragment
}

// StreamUsageObserver is the pass-through SSE tap (stream.go:83-135): the
// gateway TeeReader feeds it while the raw upstream bytes go straight to the
// client. It only accumulates usage events; it never rewrites the stream.
type StreamUsageObserver struct {
	parser   *bridgeStreamParser
	buffer   []byte
	usage    BridgeUsage
	reported bool
}

func NewStreamUsageObserver(protocol Protocol) *StreamUsageObserver {
	return &StreamUsageObserver{parser: &bridgeStreamParser{
		protocol: protocol, tools: map[string]bool{}, toolIDs: map[string]string{}, toolNames: map[string]string{},
	}}
}

func (observer *StreamUsageObserver) Write(data []byte) (int, error) {
	observer.buffer = append(observer.buffer, data...)
	for {
		index, width := nextSSEBoundary(observer.buffer)
		if index < 0 {
			break
		}
		frame := append([]byte(nil), observer.buffer[:index+width]...)
		observer.buffer = observer.buffer[index+width:]
		observer.consume(frame)
	}
	return len(data), nil
}

func (observer *StreamUsageObserver) Finish() BridgeUsage {
	if len(observer.buffer) > 0 {
		observer.consume(observer.buffer)
		observer.buffer = nil
	}
	return observer.usage
}

func (observer *StreamUsageObserver) Reported() bool { return observer.reported }

func (observer *StreamUsageObserver) consume(frame []byte) {
	_ = readSSE(strings.NewReader(string(frame)), func(eventName, data string) error {
		events, err := observer.parser.Parse(eventName, data)
		if err != nil {
			return nil
		}
		for _, event := range events {
			if event.Usage != nil {
				observer.reported = true
				mergeBridgeUsage(&observer.usage, *event.Usage)
			}
		}
		return nil
	})
}

func mergeBridgeUsage(destination *BridgeUsage, source BridgeUsage) {
	if source.Input != 0 {
		destination.Input = source.Input
	}
	if source.Output != 0 {
		destination.Output = source.Output
	}
	if source.Total != 0 {
		destination.Total = max(destination.Total, source.Total)
	}
	if source.Cached != 0 {
		destination.Cached = source.Cached
	}
	if source.CacheCreation != 0 {
		destination.CacheCreation = source.CacheCreation
	}
	if source.Reasoning != 0 {
		destination.Reasoning = source.Reasoning
	}
	destination.Total = max(destination.Total, destination.Input+destination.Output)
}

// errNoTranscode marks the not-ported cross-protocol stream path; callers
// surface it as a 502 upstream_error per design.md 6.2.
var errNoTranscode = errors.New("cross-protocol stream transcoding is not available in opencode2dsh")

// NoTranscode exposes the placeholder error for the gateway.
func NoTranscode() error { return errNoTranscode }
