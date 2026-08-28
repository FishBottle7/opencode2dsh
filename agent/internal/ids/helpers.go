// Package ids ports opencode2api ids.go verbatim (only the package clause
// moved from main to ids). ids.go references two JSON accessors that lived in
// convert.go upstream; they are copied verbatim below so ids.go stays
// byte-identical to upstream for cheap rebases. The exported wrappers let the
// other internal packages use this package's identifiers without touching the
// frozen file.
package ids

import (
	"encoding/json"
	"net/http"
)

// RequestIDs aliases the unexported requestIDs struct from ids.go so other
// packages can name the type without modifying the frozen file. Its fields are
// exported, so values remain readable across packages either way.
type RequestIDs = requestIDs

// DeriveRequestIDs wraps deriveRequestIDs.
func DeriveRequestIDs(r *http.Request, body map[string]any) RequestIDs {
	return deriveRequestIDs(r, body)
}

// FirstString wraps firstString.
func FirstString(values ...string) string { return firstString(values...) }

// UserAgent wraps opencodeUserAgent.
func UserAgent() string { return opencodeUserAgent() }

// The accessors below are copied verbatim from opencode2api convert.go
// (lines 1792-1858) so package-internal call sites keep their upstream shape.

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

func int64At(object map[string]any, path ...string) int64 {
	return int64(intAt(object, path...))
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

// Exported wrappers for the accessors above, for sibling packages.

func CloneMap(input map[string]any) map[string]any { return cloneMap(input) }

func SliceAt(object map[string]any, path ...string) []any { return sliceAt(object, path...) }

func MapAt(object map[string]any, path ...string) map[string]any { return mapAt(object, path...) }

func StringAt(object map[string]any, path ...string) string { return stringAt(object, path...) }

func BoolAt(object map[string]any, path ...string) bool { return boolAt(object, path...) }

func IntAt(object map[string]any, path ...string) int { return intAt(object, path...) }

func Int64At(object map[string]any, path ...string) int64 { return int64At(object, path...) }

func AnyAt(object map[string]any, path ...string) any { return anyAt(object, path...) }
