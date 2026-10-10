package publicdata

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/idna"
)

const site = "https://altena.me/portfolio/"

type node struct {
	tag, data string
	attrs     map[string]string
	attrNames []string
	children  []*node
	parent    *node
}

func parseHTML(value string) (*node, error) {
	root := &node{}
	stack := []*node{root}
	z := html.NewTokenizer(strings.NewReader(value))
	nodes := 0
	voids := []string{"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
	for {
		t := z.Next()
		if t == html.ErrorToken {
			break
		}
		nodes++
		if nodes > 100000 {
			return nil, fail("source_unavailable")
		}
		parent := stack[len(stack)-1]
		switch t {
		case html.TextToken:
			data := string(z.Raw())
			if parent.tag != "script" && parent.tag != "style" {
				data = html.UnescapeString(data)
			}
			parent.children = append(parent.children, &node{data: data, parent: parent})
		case html.StartTagToken, html.SelfClosingTagToken:
			token := z.Token()
			tag := token.Data
			// htmlparser2's common implied-closing rules, without the browser
			// parser's inserted table containers or discarded code newlines.
			for len(stack) > 1 {
				previous := stack[len(stack)-1].tag
				close := previous == "li" && tag == "li" || previous == "p" && contains([]string{"p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "pre", "blockquote", "hr"}, tag) || contains([]string{"td", "th"}, previous) && contains([]string{"td", "th", "tr"}, tag) || previous == "tr" && tag == "tr"
				if !close {
					break
				}
				stack = stack[:len(stack)-1]
			}
			parent = stack[len(stack)-1]
			n := &node{tag: tag, attrs: map[string]string{}, parent: parent}
			for _, a := range token.Attr {
				if _, found := n.attrs[a.Key]; !found {
					n.attrs[a.Key] = a.Val
					n.attrNames = append(n.attrNames, a.Key)
				}
			}
			parent.children = append(parent.children, n)
			if !contains(voids, tag) && t != html.SelfClosingTagToken {
				stack = append(stack, n)
				if len(stack) > 129 {
					return nil, fail("source_unavailable")
				}
			}
		case html.EndTagToken:
			tag := z.Token().Data
			for i := len(stack) - 1; i > 0; i-- {
				if stack[i].tag == tag {
					stack = stack[:i]
					break
				}
			}
		}
	}
	return root, nil
}
func findAll(n *node, predicate func(*node) bool) []*node {
	var found []*node
	if n == nil {
		return found
	}
	for _, c := range n.children {
		if predicate(c) {
			found = append(found, c)
		}
		found = append(found, findAll(c, predicate)...)
	}
	return found
}
func find(n *node, predicate func(*node) bool) *node {
	if n == nil {
		return nil
	}
	for _, c := range n.children {
		if predicate(c) {
			return c
		}
		if v := find(c, predicate); v != nil {
			return v
		}
	}
	return nil
}
func hasClass(n *node, class string) bool {
	return n != nil && contains(strings.FieldsFunc(n.attrs["class"], jsWhitespace), class)
}
func rawText(n *node) string {
	if n == nil {
		return ""
	}
	if n.tag == "" {
		if n.data != "" {
			return n.data
		}
	}
	if n.tag == "br" {
		return "\n"
	}
	var b strings.Builder
	for _, c := range n.children {
		b.WriteString(rawText(c))
	}
	return b.String()
}
func text(n *node) string { return trim(collapse(rawText(n))) }
func escapeMarkdown(s string) string {
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune("\\`*_{}[]<>#|", r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}
func safeURL(value, source string, image bool) string {
	if value == "" {
		return ""
	}
	value = strings.TrimFunc(value, func(r rune) bool { return r <= 32 })
	value = strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(value, "\r", ""), "\n", ""), "\t", "")
	// WHATWG special URLs treat backslashes as forward slashes.
	if !strings.HasPrefix(strings.ToLower(value), "mailto:") {
		value = strings.ReplaceAll(value, "\\", "/")
	}
	var input strings.Builder
	for _, b := range []byte(value) {
		if b < 32 {
			input.WriteString(fmtByte(b))
		} else {
			input.WriteByte(b)
		}
	}
	value = input.String()
	base, e := url.Parse(source)
	if e != nil {
		return ""
	}
	relative, e := url.Parse(value)
	if e != nil {
		return ""
	}
	u := base.ResolveReference(relative)
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" && (image || u.Scheme != "mailto") {
		return ""
	}
	if u.Scheme == "http" || u.Scheme == "https" {
		if u.Hostname() == "" {
			return ""
		}
		u.Host = strings.ToLower(u.Host)
		if strings.IndexFunc(u.Hostname(), func(r rune) bool { return r > 127 }) >= 0 {
			port := u.Port()
			ascii, err := idna.Lookup.ToASCII(u.Hostname())
			if err != nil {
				return ""
			}
			u.Host = ascii
			if port != "" {
				u.Host += ":" + port
			}
		}
		if u.Scheme == "http" && u.Port() == "80" || u.Scheme == "https" && u.Port() == "443" {
			u.Host = u.Hostname()
			if strings.Contains(u.Host, ":") {
				u.Host = "[" + u.Host + "]"
			}
		}
		if u.Path == "" {
			u.Path = "/"
		}
	}
	// URL.String leaves RawQuery untouched. WHATWG URL percent-encodes
	// Unicode bytes and its query character set while retaining &, = and
	// already-encoded percent sequences.
	var query strings.Builder
	for _, b := range []byte(u.RawQuery) {
		if b > 126 || b <= 32 || b == '"' || b == '#' || b == '<' || b == '>' || b == '\'' && (u.Scheme == "http" || u.Scheme == "https") {
			query.WriteString(fmtByte(b))
		} else {
			query.WriteByte(b)
		}
	}
	u.RawQuery = query.String()
	return strings.ReplaceAll(u.String(), " ", "%20")
}

func fmtByte(b byte) string {
	const digits = "0123456789ABCDEF"
	return string([]byte{'%', digits[b>>4], digits[b&15]})
}

var imagePath = regexp.MustCompile(`(?i)^/portfolio/img/[A-Za-z0-9._/-]+$`)
var imageAbsolute = regexp.MustCompile(`(?i)^https?://[^\s]+$`)

func sanitized(n *node) []*node {
	if contains([]string{"script", "style", "textarea", "option"}, n.tag) {
		return nil
	}
	children := []*node{}
	for _, c := range n.children {
		children = append(children, sanitized(c)...)
	}
	allowed := contains([]string{"p", "br", "strong", "em", "b", "i", "u", "s", "ul", "ol", "li", "h2", "h3", "h4", "blockquote", "pre", "code", "hr", "a", "table", "thead", "tbody", "tr", "th", "td", "img"}, n.tag)
	if n.tag == "" && n.data != "" {
		return []*node{n}
	}
	if !allowed {
		return children
	}
	n.children = children
	if n.tag == "a" || n.tag == "img" {
		key := "href"
		if n.tag == "img" {
			key = "src"
		}
		value := n.attrs[key]
		clean := strings.Map(func(r rune) rune {
			if r <= 32 || r == 127 {
				return -1
			}
			return r
		}, value)
		protocol := ""
		if i := strings.Index(clean, ":"); i >= 0 {
			protocol = strings.ToLower(clean[:i])
		}
		if strings.HasPrefix(clean, "//") || protocol != "" && !contains([]string{"http", "https", "mailto"}, protocol) || n.tag == "img" && protocol == "mailto" {
			delete(n.attrs, key)
		}
		if n.tag == "img" && !imagePath.MatchString(n.attrs[key]) && !imageAbsolute.MatchString(n.attrs[key]) {
			return nil
		}
	}
	return []*node{n}
}

var ticksPattern = regexp.MustCompile("`+")

func ticks(value string, minimum int) string {
	for _, run := range ticksPattern.FindAllString(value, -1) {
		if len(run)+1 > minimum {
			minimum = len(run) + 1
		}
	}
	return strings.Repeat("`", minimum)
}
func htmlToMarkdown(input, source string) (string, error) {
	root, err := parseHTML(input)
	if err != nil {
		return "", err
	}
	root.children = sanitized(root)
	var attach func(*node)
	attach = func(n *node) {
		// sanitize-html emits strings which htmlparser2 reparses. Unwrapped
		// tags therefore coalesce their neighboring text nodes.
		merged := make([]*node, 0, len(n.children))
		for _, c := range n.children {
			if c.tag == "" && len(merged) > 0 && merged[len(merged)-1].tag == "" {
				merged[len(merged)-1].data += c.data
				continue
			}
			c.parent = n
			attach(c)
			merged = append(merged, c)
		}
		n.children = merged
	}
	attach(root)
	var render func(*node) string
	inside := func(n *node) string {
		var b strings.Builder
		for _, c := range n.children {
			b.WriteString(render(c))
		}
		return b.String()
	}
	render = func(n *node) string {
		if n.tag == "" && n.data != "" {
			if trim(n.data) == "" && n.parent != nil {
				for i, c := range n.parent.children {
					if c == n {
						for _, adj := range []int{i - 1, i + 1} {
							if adj >= 0 && adj < len(n.parent.children) && contains([]string{"p", "h2", "h3", "h4", "pre", "ul", "ol", "table", "blockquote", "hr"}, n.parent.children[adj].tag) {
								return ""
							}
						}
						break
					}
				}
			}
			return escapeMarkdown(collapse(n.data))
		}
		content := func() string { return trim(inside(n)) }
		switch n.tag {
		case "h2", "h3", "h4":
			level, _ := strconv.Atoi(n.tag[1:])
			return "\n\n" + strings.Repeat("#", level) + " " + content() + "\n\n"
		case "p":
			return "\n\n" + content() + "\n\n"
		case "br":
			return "\n"
		case "hr":
			return "\n\n---\n\n"
		case "pre":
			value := rawText(n)
			fence := ticks(value, 3)
			return "\n\n" + fence + "\n" + value + "\n" + fence + "\n\n"
		case "code":
			value := rawText(n)
			fence := ticks(value, 1)
			return fence + " " + value + " " + fence
		case "b", "strong":
			return "**" + content() + "**"
		case "i", "em":
			return "*" + content() + "*"
		case "s":
			return "~~" + content() + "~~"
		case "blockquote":
			lines := strings.Split(content(), "\n")
			for i := range lines {
				lines[i] = "> " + lines[i]
			}
			return "\n\n" + strings.Join(lines, "\n") + "\n\n"
		case "a":
			if value := safeURL(n.attrs["href"], source, false); value != "" {
				return "[" + content() + "](<" + value + ">)"
			}
			return inside(n)
		case "img":
			if value := safeURL(n.attrs["src"], source, true); value != "" {
				return "\n\n![" + escapeMarkdown(n.attrs["alt"]) + "](<" + value + ">)\n\n"
			}
			return ""
		case "ul", "ol":
			var lines []string
			for _, c := range n.children {
				if c.tag != "li" {
					continue
				}
				prefix := "-"
				if n.tag == "ol" {
					prefix = strconv.Itoa(len(lines)+1) + "."
				}
				lines = append(lines, prefix+" "+strings.ReplaceAll(trim(render(c)), "\n", "\n  "))
			}
			return "\n\n" + strings.Join(lines, "\n") + "\n\n"
		case "table":
			var rows [][]string
			width := 0
			for _, tr := range findAll(n, func(c *node) bool { return c.tag == "tr" }) {
				row := []string{}
				for _, cell := range tr.children {
					if cell.tag == "th" || cell.tag == "td" {
						row = append(row, strings.ReplaceAll(trim(render(cell)), "\n", " "))
					}
				}
				rows = append(rows, row)
				if len(row) > width {
					width = len(row)
				}
			}
			if len(rows) == 0 {
				return ""
			}
			line := func(row []string) string {
				values := make([]string, width)
				copy(values, row)
				return "| " + strings.Join(values, " | ") + " |"
			}
			lines := []string{line(rows[0])}
			separator := make([]string, width)
			for i := range separator {
				separator[i] = "---"
			}
			lines = append(lines, line(separator))
			for _, row := range rows[1:] {
				lines = append(lines, line(row))
			}
			return "\n\n" + strings.Join(lines, "\n") + "\n\n"
		default:
			return inside(n)
		}
	}
	var result strings.Builder
	for _, n := range root.children {
		result.WriteString(render(n))
	}
	lines := []string{}
	fenceWidth := 0
	for _, line := range strings.Split(trim(result.String()), "\n") {
		marker := len(line) >= 3 && strings.Trim(line, "`") == ""
		if marker && (fenceWidth == 0 || len(line) >= fenceWidth) {
			if fenceWidth == 0 {
				fenceWidth = len(line)
			} else {
				fenceWidth = 0
			}
			lines = append(lines, line)
		} else if fenceWidth > 0 || trim(line) != "" {
			lines = append(lines, line)
		} else if len(lines) == 0 || lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
	}
	return trim(strings.Join(lines, "\n")) + "\n", nil
}

// Serialize a description as htmlparser2/domutils would before sanitizing it.
func innerHTML(n *node) string {
	if n == nil {
		return ""
	}
	var b strings.Builder
	var write func(*node)
	write = func(c *node) {
		if c.tag == "" {
			b.WriteString(html.EscapeString(c.data))
			return
		}
		b.WriteByte('<')
		b.WriteString(c.tag)
		for _, key := range c.attrNames {
			if value, ok := c.attrs[key]; ok {
				b.WriteByte(' ')
				b.WriteString(key)
				b.WriteString(`="`)
				b.WriteString(html.EscapeString(value))
				b.WriteByte('"')
			}
		}
		b.WriteByte('>')
		if !contains([]string{"img", "br", "hr", "input", "meta", "link", "source", "wbr"}, c.tag) {
			for _, child := range c.children {
				write(child)
			}
			b.WriteString("</" + c.tag + ">")
		}
	}
	for _, c := range n.children {
		write(c)
	}
	return b.String()
}
