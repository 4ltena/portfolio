package publicdata

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Objects retain JavaScript's insertion order, which is part of the revision
// and cursor contract. Ordinary Go maps cannot preserve that order.
type field struct {
	name  string
	value any
}
type object []field

func (o object) get(name string) any {
	for _, f := range o {
		if f.name == name {
			return f.value
		}
	}
	return nil
}
func (o object) without(names ...string) object {
	r := make(object, 0, len(o))
	for _, f := range o {
		if !contains(names, f.name) {
			r = append(r, f)
		}
	}
	return r
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func jsString(value string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 32 {
				b.WriteString(`\u00`)
				b.WriteString(hex.EncodeToString([]byte{byte(r)}))
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
func jsNumber(v float64) string {
	if v == 0 {
		return "0"
	}
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "null"
	}
	fmt := byte('f')
	if math.Abs(v) < 1e-6 || math.Abs(v) >= 1e21 {
		fmt = 'e'
	}
	s := strconv.FormatFloat(v, fmt, -1, 64)
	if fmt == 'e' {
		s = strings.Replace(s, "e-0", "e-", 1)
		s = strings.Replace(s, "e+0", "e+", 1)
	}
	return s
}
func marshalJS(v any) []byte {
	switch x := v.(type) {
	case nil:
		return []byte("null")
	case string:
		return []byte(jsString(x))
	case bool:
		return []byte(strconv.FormatBool(x))
	case int:
		return []byte(strconv.Itoa(x))
	case int64:
		return []byte(jsNumber(float64(x)))
	case float64:
		return []byte(jsNumber(x))
	case json.RawMessage:
		return x
	case object:
		var b strings.Builder
		b.WriteByte('{')
		for i, f := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(jsString(f.name))
			b.WriteByte(':')
			b.Write(marshalJS(f.value))
		}
		b.WriteByte('}')
		return []byte(b.String())
	case []any:
		var b strings.Builder
		b.WriteByte('[')
		for i, v := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			b.Write(marshalJS(v))
		}
		b.WriteByte(']')
		return []byte(b.String())
	case []string:
		a := make([]any, len(x))
		for i := range x {
			a[i] = x[i]
		}
		return marshalJS(a)
	case []object:
		a := make([]any, len(x))
		for i := range x {
			a[i] = x[i]
		}
		return marshalJS(a)
	default:
		panic("unsupported internal JSON value")
	}
}
func hash(v any) string {
	h := sha256.Sum256(marshalJS(v))
	return "sha256:" + hex.EncodeToString(h[:])
}

func jsWhitespace(r rune) bool {
	return r >= '\t' && r <= '\r' || r == ' ' || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func trim(s string) string { return strings.TrimFunc(s, jsWhitespace) }
func collapse(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if jsWhitespace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
		} else {
			b.WriteRune(r)
			space = false
		}
	}
	return b.String()
}
func validString(s string) bool { return utf8.ValidString(s) }

// Node's UTF-8 decoder replaces maximal malformed subsequences. In
// particular, a truncated valid prefix is one replacement, rather than
// one replacement per byte as Go's range decoder would produce.
func decodeUTF8(bytes []byte) string {
	var b strings.Builder
	for len(bytes) > 0 {
		r, size := utf8.DecodeRune(bytes)
		if r == utf8.RuneError && size == 1 {
			width := 1
			switch {
			case bytes[0] >= 0xc2 && bytes[0] <= 0xdf:
				width = 2
			case bytes[0] >= 0xe0 && bytes[0] <= 0xef:
				width = 3
			case bytes[0] >= 0xf0 && bytes[0] <= 0xf4:
				width = 4
			}
			for size < width && size < len(bytes) {
				c := bytes[size]
				if c < 0x80 || c > 0xbf || size == 1 && (bytes[0] == 0xe0 && c < 0xa0 || bytes[0] == 0xed && c > 0x9f || bytes[0] == 0xf0 && c < 0x90 || bytes[0] == 0xf4 && c > 0x8f) {
					break
				}
				size++
			}
		}
		b.WriteRune(r)
		bytes = bytes[size:]
	}
	return b.String()
}
