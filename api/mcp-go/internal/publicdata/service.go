// Package publicdata reads the portfolio's public sources without a Node
// process or a request to the existing web API.
package publicdata

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	_ "modernc.org/sqlite"
)

const maxItems = 1000
const maxFileBytes = 2 * 1024 * 1024
const maxBodyBytes = 512 * 1024
const maxDatasetBytes = 16 * 1024 * 1024
const maxOutputBytes = 2 * 1024 * 1024
const publicIDSQL = "typeof(id)='text' AND length(id) BETWEEN 1 AND 128 AND length(CAST(id AS BLOB))=length(id) AND id NOT GLOB '*[^A-Za-z0-9_-]*'"

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var revisionPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var cursorPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
var datePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
var compactDatePattern = regexp.MustCompile(`^\d{8}$`)
var workPathPattern = regexp.MustCompile(`^works/([A-Za-z0-9_-]{1,128})/index\.html$`)

type Config struct{ Root, DBPath string }
type ListArgs struct {
	Kind   string
	Q      *string
	Limit  int
	Cursor *string
}
type GetArgs struct {
	Kind string
	ID   *string
}
type Service struct {
	mu     sync.Mutex
	root   *os.Root
	db     *sql.DB
	closed bool
}
type publicError struct{ code string }

func (e *publicError) Error() string { return errorMessages[e.code] }

var errorMessages = map[string]string{
	"invalid_request": "Invalid request", "invalid_cursor": "Invalid cursor", "not_found": "Not found",
	"method_not_allowed": "Method not allowed", "cursor_expired": "Cursor expired", "rate_limited": "Rate limited", "source_unavailable": "Source unavailable",
}

func fail(code string) error { return &publicError{code} }
func ErrorCode(err error) string {
	var e *publicError
	if errors.As(err, &e) {
		if _, ok := errorMessages[e.code]; ok {
			return e.code
		}
	}
	return "source_unavailable"
}
func ErrorEnvelope(err error) json.RawMessage {
	code := ErrorCode(err)
	return marshalJS(object{{"schema_version", 1}, {"error", object{{"code", code}, {"message", errorMessages[code]}}}})
}
func controlled(err error) error {
	if err == nil {
		return nil
	}
	return fail(ErrorCode(err))
}

func New(config Config) (*Service, error) {
	rootPath, err := filepath.Abs(config.Root)
	if err != nil {
		return nil, fail("source_unavailable")
	}
	rootPath, err = filepath.EvalSymlinks(rootPath)
	if err != nil {
		return nil, fail("source_unavailable")
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, fail("source_unavailable")
	}
	dbPath, err := filepath.Abs(config.DBPath)
	if err != nil {
		root.Close()
		return nil, fail("source_unavailable")
	}
	stat, err := os.Stat(dbPath)
	if err != nil || !stat.Mode().IsRegular() {
		root.Close()
		return nil, fail("source_unavailable")
	}
	dsn := (&url.URL{Scheme: "file", Path: dbPath, RawQuery: "mode=ro&_pragma=query_only%281%29&_pragma=busy_timeout%281000%29"}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		root.Close()
		return nil, fail("source_unavailable")
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		root.Close()
		return nil, fail("source_unavailable")
	}
	return &Service{root: root, db: db}, nil
}
func (s *Service) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	err := s.db.Close()
	other := s.root.Close()
	if err != nil || other != nil {
		return fail("source_unavailable")
	}
	return nil
}
func (s *Service) begin(ctx context.Context) (*sql.Tx, error) {
	if s.closed || ctx.Err() != nil {
		return nil, fail("source_unavailable")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	return tx, controlled(err)
}
func boundedJSON(v any) (json.RawMessage, error) {
	b := marshalJS(v)
	if len(b) > maxOutputBytes {
		return nil, fail("source_unavailable")
	}
	return b, nil
}
func checkedObject(v object) (object, error) {
	if len(marshalJS(v)) > maxOutputBytes {
		return nil, fail("source_unavailable")
	}
	return v, nil
}
func (s *Service) List(ctx context.Context, args ListArgs) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := s.list(ctx, args)
	if err != nil {
		return nil, controlled(err)
	}
	if ctx.Err() != nil {
		return nil, fail("source_unavailable")
	}
	return boundedJSON(v)
}
func (s *Service) Get(ctx context.Context, args GetArgs) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := s.get(ctx, args)
	if err != nil {
		return nil, controlled(err)
	}
	if ctx.Err() != nil {
		return nil, fail("source_unavailable")
	}
	return boundedJSON(v)
}
func (s *Service) Markdown(ctx context.Context, args GetArgs) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := s.markdown(ctx, args)
	if err != nil {
		return "", controlled(err)
	}
	if ctx.Err() != nil {
		return "", fail("source_unavailable")
	}
	if len(v) > maxOutputBytes {
		return "", fail("source_unavailable")
	}
	return v, nil
}
func generated() string             { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func normalize(value string) string { return cases.Lower(language.Und).String(norm.NFKC.String(value)) }

type reader struct {
	service     *Service
	tx          *sql.Tx
	ctx         context.Context
	sourceBytes int64
}

func (r *reader) charge(bytes int64) error {
	r.sourceBytes += bytes
	if r.sourceBytes > maxDatasetBytes {
		return fail("source_unavailable")
	}
	return nil
}
func (r *reader) readText(filename string) (string, string, error) {
	if filename != "index.html" && filename != "myworks.html" && filename != "terminal/profile.txt" && !workPathPattern.MatchString(filename) {
		return "", "", fail("source_unavailable")
	}
	if r.ctx.Err() != nil {
		return "", "", fail("source_unavailable")
	}
	f, err := r.service.root.Open(filepath.FromSlash(filename))
	if err != nil {
		return "", "", fail("source_unavailable")
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxFileBytes {
		return "", "", fail("source_unavailable")
	}
	if err = r.charge(stat.Size()); err != nil {
		return "", "", err
	}
	b, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil || len(b) > maxFileBytes || r.ctx.Err() != nil {
		return "", "", fail("source_unavailable")
	}
	// fs.readFileSync(..., 'utf8') replaces malformed UTF-8 with U+FFFD.
	value := decodeUTF8(b)
	if len(value) > maxFileBytes {
		return "", "", fail("source_unavailable")
	}
	if int64(len(value)) > stat.Size() {
		if err = r.charge(int64(len(value)) - stat.Size()); err != nil {
			return "", "", err
		}
	}
	return value, stat.ModTime().UTC().Format("2006-01-02T15:04:05.000Z"), nil
}
func (r *reader) table(table, columns, where string, values []any, body string) ([]map[string]any, error) {
	columnNames := strings.Split(columns, ",")
	parts := make([]string, len(columnNames))
	for i, c := range columnNames {
		parts[i] = "coalesce(length(CAST(" + c + " AS BLOB)),0)"
	}
	bodySQL := "0"
	if body != "" {
		bodySQL = "max(length(CAST(" + body + " AS BLOB)))"
	}
	statsSQL := "SELECT count(*),coalesce(sum(" + strings.Join(parts, "+") + "),0),coalesce(" + bodySQL + ",0) FROM (SELECT " + columns + " FROM " + table + " WHERE " + where + " LIMIT 1001)"
	var count, bytes, bodyBytes int64
	if err := r.tx.QueryRowContext(r.ctx, statsSQL, values...).Scan(&count, &bytes, &bodyBytes); err != nil {
		return nil, fail("source_unavailable")
	}
	if count > maxItems || bodyBytes > maxBodyBytes {
		return nil, fail("source_unavailable")
	}
	if err := r.charge(bytes); err != nil {
		return nil, err
	}
	rows, err := r.tx.QueryContext(r.ctx, "SELECT "+columns+" FROM "+table+" WHERE "+where+" LIMIT 1001", values...)
	if err != nil {
		return nil, fail("source_unavailable")
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(columnNames))
		targets := make([]any, len(values))
		for i := range values {
			targets[i] = &values[i]
		}
		if err = rows.Scan(targets...); err != nil {
			return nil, fail("source_unavailable")
		}
		row := map[string]any{}
		for i, c := range columnNames {
			row[c] = values[i]
		}
		result = append(result, row)
	}
	if rows.Err() != nil || len(result) > maxItems {
		return nil, fail("source_unavailable")
	}
	return result, nil
}
func (s *Service) snapshot(ctx context.Context, kind string, id *string) ([]map[string]any, error) {
	tx, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	r := &reader{service: s, tx: tx, ctx: ctx}
	var result []map[string]any
	switch kind {
	case "profile":
		var row map[string]any
		row, err = r.profile()
		if err == nil {
			result = []map[string]any{row}
		}
	case "works":
		result, err = r.works()
	case "notes":
		where := "visibility='public' AND " + publicIDSQL
		values := []any{}
		if id != nil {
			where += " AND id=?"
			values = append(values, *id)
		}
		result, err = r.table("articles", "id,title,date,tags,excerpt,content,created_at,updated_at,published_at", where, values, "content")
		if err == nil {
			for _, row := range result {
				err = note(row)
				if err != nil {
					break
				}
			}
		}
	case "skills":
		result, err = r.table("skills", "id,name,description,sort_order", publicIDSQL, nil, "")
		for _, row := range result {
			row["type"] = "skill"
		}
	case "timeline":
		result, err = r.table("timeline", "id,date,title,category,href", publicIDSQL, nil, "")
		for _, row := range result {
			row["type"] = "timeline"
		}
	default:
		err = fail("not_found")
	}
	if err != nil {
		return nil, controlled(err)
	}
	if err = tx.Commit(); err != nil {
		return nil, fail("source_unavailable")
	}
	return result, nil
}

var rolePattern = regexp.MustCompile(`Role\s+|Frontend Developer`)
var rolePrefix = regexp.MustCompile(`^.*?\|(?:__)?\s*(?:Role\s+)?`)

func (r *reader) profile() (map[string]any, error) {
	value, modified, err := r.readText("index.html")
	if err != nil {
		return nil, err
	}
	document, err := parseHTML(value)
	if err != nil {
		return nil, err
	}
	section := find(document, func(n *node) bool { return n.attrs["id"] == "profile" })
	if section == nil {
		return nil, fail("source_unavailable")
	}
	terminal, terminalModified, err := r.readText("terminal/profile.txt")
	if err != nil {
		return nil, err
	}
	if terminalModified > modified {
		modified = terminalModified
	}
	roles := []string{}
	for _, line := range strings.Split(terminal, "\n") {
		if rolePattern.MatchString(line) {
			roles = append(roles, trim(rolePrefix.ReplaceAllString(line, "")))
		}
	}
	bioNode := find(section, func(n *node) bool { return hasClass(n, "bio") })
	bios := []string{}
	for _, n := range findAll(bioNode, func(n *node) bool { return n.tag == "p" }) {
		bios = append(bios, text(n))
	}
	social := find(section, func(n *node) bool { return hasClass(n, "profile-social") })
	links := []string{}
	for _, n := range findAll(social, func(n *node) bool { return n.tag == "a" }) {
		if value := safeURL(n.attrs["href"], site, false); value != "" {
			links = append(links, value)
		}
	}
	foot := find(document, func(n *node) bool { return hasClass(n, "hero-foot") })
	focus := []string{}
	for _, n := range findAll(foot, func(n *node) bool { return n.tag == "span" && !hasClass(n, "hero-scroll") }) {
		focus = append(focus, text(n))
	}
	return map[string]any{"id": "altena", "type": "profile", "name": text(find(section, func(n *node) bool { return hasClass(n, "brand") })), "roles": roles, "description": text(find(section, func(n *node) bool { return hasClass(n, "philosophy") })), "bio": strings.Join(bios, "\n"), "focus": focus, "links": links, "source_url": site + "index.html#profile", "source_modified_at": modified}, nil
}
func (r *reader) works() ([]map[string]any, error) {
	value, modified, err := r.readText("myworks.html")
	if err != nil {
		return nil, err
	}
	document, err := parseHTML(value)
	if err != nil {
		return nil, err
	}
	cards := findAll(document, func(n *node) bool { return n.tag == "a" && hasClass(n, "page-tile-item") })
	if len(cards) == 0 && find(document, func(n *node) bool { return hasClass(n, "page-tile-container") }) == nil {
		return nil, fail("source_unavailable")
	}
	published := []*node{}
	for _, card := range cards {
		if workPathPattern.MatchString(card.attrs["href"]) {
			published = append(published, card)
		}
	}
	if len(published) > maxItems {
		return nil, fail("source_unavailable")
	}
	result := []map[string]any{}
	for _, card := range published {
		filename := card.attrs["href"]
		id := workPathPattern.FindStringSubmatch(filename)[1]
		value, detailModified, err := r.readText(filename)
		if err != nil {
			return nil, err
		}
		if modified > detailModified {
			detailModified = modified
		}
		detail, err := parseHTML(value)
		if err != nil {
			return nil, err
		}
		desc := find(detail, func(n *node) bool { return hasClass(n, "project-desc") })
		if desc == nil {
			return nil, fail("source_unavailable")
		}
		for _, n := range findAll(desc, func(n *node) bool { return n.tag == "img" }) {
			if value := safeURL(n.attrs["src"], site+filename, true); value != "" {
				n.attrs["src"] = value
			}
		}
		inner := innerHTML(desc)
		if len(inner) > maxBodyBytes {
			return nil, fail("source_unavailable")
		}
		tags := []string{}
		for _, tag := range strings.FieldsFunc(card.attrs["data-tags"], jsWhitespace) {
			tags = append(tags, strings.TrimPrefix(tag, "#"))
		}
		body, err := htmlToMarkdown(inner, site+filename)
		if err != nil {
			return nil, err
		}
		result = append(result, map[string]any{"id": id, "type": "work", "title": text(find(card, func(n *node) bool { return n.tag == "h3" })), "date": strings.ReplaceAll(text(find(card, func(n *node) bool { return hasClass(n, "note-date") })), "/", "-"), "tags": tags, "excerpt": text(find(card, func(n *node) bool { return n.tag == "p" })), "content_markdown": body, "source_url": site + filename, "source_modified_at": detailModified})
	}
	return result, nil
}
func requireString(v any) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fail("source_unavailable")
	}
	return s, nil
}
func requireStrings(v any) ([]string, error) {
	if s, ok := v.([]string); ok {
		return s, nil
	}
	a, ok := v.([]any)
	if !ok {
		return nil, fail("source_unavailable")
	}
	r := make([]string, len(a))
	for i, v := range a {
		s, err := requireString(v)
		if err != nil {
			return nil, err
		}
		r[i] = s
	}
	return r, nil
}
func date(v any) (any, error) {
	if v == nil || v == "" {
		return nil, nil
	}
	s, err := requireString(v)
	if err != nil {
		return nil, err
	}
	s = strings.ReplaceAll(s, "/", "-")
	if compactDatePattern.MatchString(s) {
		s = s[:4] + "-" + s[4:6] + "-" + s[6:]
	}
	if !datePattern.MatchString(s) {
		return nil, fail("source_unavailable")
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil || t.Format("2006-01-02") != s {
		return nil, fail("source_unavailable")
	}
	return s, nil
}
func timestamp(v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	var t time.Time
	switch value := v.(type) {
	case int64:
		t = time.UnixMilli(value)
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fail("source_unavailable")
		}
		t = time.UnixMilli(int64(value))
	case string:
		var err error
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02"} {
			t, err = time.Parse(layout, value)
			if err == nil {
				break
			}
		}
		if err != nil {
			return nil, fail("source_unavailable")
		}
	default:
		return nil, fail("source_unavailable")
	}
	if t.Year() < 0 || t.Year() > 9999 {
		return nil, fail("source_unavailable")
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z"), nil
}
func note(row map[string]any) error {
	content, err := requireString(row["content"])
	if err != nil {
		return err
	}
	id, err := requireString(row["id"])
	if err != nil {
		return err
	}
	d, err := requireString(row["date"])
	if err != nil {
		return err
	}
	tags, err := requireString(row["tags"])
	if err != nil {
		return err
	}
	var decoded any
	if json.Unmarshal([]byte(tags), &decoded) != nil {
		return fail("source_unavailable")
	}
	row["tags"], err = requireStrings(decoded)
	if err != nil {
		return err
	}
	updated := row["updated_at"]
	if updated == nil {
		updated = row["created_at"]
	}
	row["updated_at"], err = timestamp(updated)
	if err != nil {
		return err
	}
	row["published_at"], err = timestamp(row["published_at"])
	if err != nil {
		return err
	}
	if row["excerpt"] == nil || row["excerpt"] == "" {
		row["excerpt"] = ""
	}
	row["type"] = "note"
	row["date"] = strings.ReplaceAll(d, "/", "-")
	row["content_markdown"], err = htmlToMarkdown(content, site+"notes/"+id+"/index.html")
	if err != nil {
		return err
	}
	row["source_url"] = site + "notes/" + id + "/index.html"
	return nil
}
func dto(row map[string]any) (object, error) {
	id, err := requireString(row["id"])
	if err != nil || !idPattern.MatchString(id) {
		return nil, fail("source_unavailable")
	}
	typ, _ := row["type"].(string)
	profile := typ == "profile"
	tracked := profile || typ == "work"
	titleValue := row["title"]
	if profile || typ == "skill" {
		titleValue = row["name"]
	}
	title, err := requireString(titleValue)
	if err != nil {
		return nil, err
	}
	summaryValue := row["excerpt"]
	if profile || typ == "skill" {
		summaryValue = row["description"]
	}
	if typ == "timeline" {
		summaryValue = ""
	}
	summary, err := requireString(summaryValue)
	if err != nil {
		return nil, err
	}
	source := site + "index.html#timeline"
	if typ == "skill" {
		source = site + "index.html#skills"
	}
	if tracked || typ == "note" {
		source, err = requireString(row["source_url"])
		if err != nil {
			return nil, err
		}
	}
	canonical := source
	if typ == "note" {
		canonical = site + "notes/" + id + "/"
	}
	d, err := date(row["date"])
	if err != nil {
		return nil, err
	}
	var published, updated any
	basis := "not-tracked"
	if tracked {
		updated, err = requireString(row["source_modified_at"])
		basis = "source-file-mtime"
	} else if typ == "note" {
		updated, err = timestamp(row["updated_at"])
		basis = "article-record"
		if err == nil {
			published, err = timestamp(row["published_at"])
		}
	}
	if err != nil {
		return nil, err
	}
	tags := []string{}
	if typ == "note" || typ == "work" {
		tags, err = requireStrings(row["tags"])
		if err != nil {
			return nil, err
		}
	}
	item := object{{"id", id}, {"type", typ}, {"title", title}, {"summary", summary}, {"canonical_url", canonical}, {"source_url", source}, {"date", d}, {"published_at", published}, {"updated_at", updated}, {"updated_at_basis", basis}, {"tags", tags}}
	if tracked {
		item = append(item, field{"source_modified_at", updated})
	}
	if profile {
		roles, e := requireStrings(row["roles"])
		if e != nil {
			return nil, e
		}
		bio, e := requireString(row["bio"])
		if e != nil {
			return nil, e
		}
		focus, e := requireStrings(row["focus"])
		if e != nil {
			return nil, e
		}
		links, e := requireStrings(row["links"])
		if e != nil {
			return nil, e
		}
		lines := []string{}
		for _, role := range roles {
			lines = append(lines, escapeMarkdown(role))
		}
		lines = append(lines, "", escapeMarkdown(summary), "", escapeMarkdown(bio), "", "## 活動分野")
		for _, value := range focus {
			lines = append(lines, "- "+escapeMarkdown(value))
		}
		lines = append(lines, "", "## Links")
		for _, value := range links {
			lines = append(lines, "- <"+value+">")
		}
		lines = append(lines, "")
		item = append(item, field{"name", title}, field{"roles", roles}, field{"bio", bio}, field{"focus", focus}, field{"links", links}, field{"content_markdown", strings.Join(lines, "\n")})
	} else if typ == "work" || typ == "note" {
		body, e := requireString(row["content_markdown"])
		if e != nil {
			return nil, e
		}
		item = append(item, field{"content_markdown", body})
	} else if typ == "skill" {
		item = append(item, field{"name", title})
	} else if typ == "timeline" {
		category := row["category"]
		if category == nil || category == "" {
			category = ""
		}
		cat, e := requireString(category)
		if e != nil {
			return nil, e
		}
		var href any
		if value, ok := row["href"].(string); ok {
			if linked := safeURL(value, site, true); linked != "" {
				href = linked
			}
		}
		item = append(item, field{"category", cat}, field{"href", href})
	}
	revisionInput := item.without("source_modified_at")
	if tracked {
		revisionInput = revisionInput.without("updated_at")
	}
	return append(item, field{"revision", hash(revisionInput)}), nil
}

type keyedRow struct {
	dto object
	key []any
}

func orderKey(kind string, raw map[string]any, item object) ([]any, error) {
	var value any
	if kind == "skills" {
		switch number := raw["sort_order"].(type) {
		case int64:
			value = float64(number)
		case float64:
			if math.IsNaN(number) || math.IsInf(number, 0) {
				return nil, fail("source_unavailable")
			}
			value = number
		default:
			return nil, fail("source_unavailable")
		}
	} else if kind == "notes" {
		value = item.get("published_at")
	} else {
		value = item.get("date")
	}
	return []any{value, item.get("id")}, nil
}
func compareKeys(kind string, a, b []any) int {
	direction := -1
	if kind == "skills" {
		direction = 1
	}
	if a[0] != b[0] {
		if a[0] == nil {
			return 1
		}
		if b[0] == nil {
			return -1
		}
		if kind == "skills" {
			if a[0].(float64) < b[0].(float64) {
				return -1
			}
			return 1
		}
		return direction * strings.Compare(a[0].(string), b[0].(string))
	}
	return direction * strings.Compare(a[1].(string), b[1].(string))
}
func (s *Service) rows(ctx context.Context, kind string) ([]keyedRow, error) {
	raw, err := s.snapshot(ctx, kind, nil)
	if err != nil {
		return nil, err
	}
	rows := make([]keyedRow, len(raw))
	seen := map[string]bool{}
	dataset := make([]object, len(raw))
	for i, row := range raw {
		item, e := dto(row)
		if e != nil {
			return nil, e
		}
		key, e := orderKey(kind, row, item)
		if e != nil {
			return nil, e
		}
		id := item.get("id").(string)
		if seen[id] {
			return nil, fail("source_unavailable")
		}
		seen[id] = true
		if body, ok := item.get("content_markdown").(string); ok && len(body) > maxBodyBytes {
			return nil, fail("source_unavailable")
		}
		rows[i] = keyedRow{item, key}
	}
	sort.Slice(rows, func(i, j int) bool { return compareKeys(kind, rows[i].key, rows[j].key) < 0 })
	for i, row := range rows {
		dataset[i] = object{{"dto", row.dto}, {"key", row.key}}
	}
	if len(marshalJS(dataset)) > maxDatasetBytes {
		return nil, fail("source_unavailable")
	}
	return rows, nil
}

type cursorPosition struct {
	last     []any
	revision string
}

func parameters(args ListArgs) (string, int, *cursorPosition, error) {
	if !contains([]string{"works", "notes", "skills", "timeline"}, args.Kind) {
		return "", 0, nil, fail("not_found")
	}
	q := ""
	if args.Q != nil {
		if !contains([]string{"works", "notes"}, args.Kind) || !validString(*args.Q) || utf8.RuneCountInString(*args.Q) > 120 {
			return "", 0, nil, fail("invalid_request")
		}
		for _, r := range *args.Q {
			if unicode.Is(unicode.Cc, r) {
				return "", 0, nil, fail("invalid_request")
			}
		}
		q = normalize(trim(*args.Q))
	}
	limit := args.Limit
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 50 {
		return "", 0, nil, fail("invalid_request")
	}
	var position *cursorPosition
	if args.Cursor != nil {
		value := *args.Cursor
		if len(value) > 2048 || !cursorPattern.MatchString(value) {
			return "", 0, nil, fail("invalid_cursor")
		}
		bytes, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil || base64.RawURLEncoding.EncodeToString(bytes) != value || !utf8.Valid(bytes) {
			return "", 0, nil, fail("invalid_cursor")
		}
		var decoded map[string]any
		if json.Unmarshal(bytes, &decoded) != nil || len(decoded) != 6 {
			return "", 0, nil, fail("invalid_cursor")
		}
		for _, key := range []string{"v", "k", "q", "l", "last", "r"} {
			if _, ok := decoded[key]; !ok {
				return "", 0, nil, fail("invalid_cursor")
			}
		}
		revision, ok := decoded["r"].(string)
		if !ok || !revisionPattern.MatchString(revision) || decoded["v"] != float64(1) || decoded["k"] != args.Kind || decoded["q"] != hash(q) || decoded["l"] != float64(limit) {
			return "", 0, nil, fail("invalid_cursor")
		}
		last, ok := decoded["last"].([]any)
		if !ok || len(last) != 2 {
			return "", 0, nil, fail("invalid_cursor")
		}
		id, ok := last[1].(string)
		if !ok || !idPattern.MatchString(id) {
			return "", 0, nil, fail("invalid_cursor")
		}
		if args.Kind == "skills" {
			number, ok := last[0].(float64)
			if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
				return "", 0, nil, fail("invalid_cursor")
			}
		} else if last[0] != nil {
			if _, ok := last[0].(string); !ok {
				return "", 0, nil, fail("invalid_cursor")
			}
		}
		position = &cursorPosition{last, revision}
	}
	return q, limit, position, nil
}
func (s *Service) list(ctx context.Context, args ListArgs) (object, error) {
	q, limit, position, err := parameters(args)
	if err != nil {
		return nil, err
	}
	rows, err := s.rows(ctx, args.Kind)
	if err != nil {
		return nil, err
	}
	revisionRows := make([]any, len(rows))
	for i, row := range rows {
		revisionRows[i] = []any{row.key, row.dto.get("revision")}
	}
	revision := hash(revisionRows)
	if position != nil && position.revision != revision {
		return nil, fail("cursor_expired")
	}
	filtered := []keyedRow{}
	for _, row := range rows {
		if q != "" {
			parts := []string{row.dto.get("title").(string), row.dto.get("summary").(string)}
			parts = append(parts, row.dto.get("tags").([]string)...)
			body, _ := row.dto.get("content_markdown").(string)
			parts = append(parts, body)
			if !strings.Contains(normalize(strings.Join(parts, "\n")), q) {
				continue
			}
		}
		filtered = append(filtered, row)
	}
	start := 0
	if position != nil {
		index := -1
		for i, row := range filtered {
			if string(marshalJS(row.key)) == string(marshalJS(position.last)) {
				index = i
				break
			}
		}
		if index < 0 {
			return nil, fail("invalid_cursor")
		}
		start = index + 1
	}
	end := start + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	page := filtered[start:end]
	var next any
	if start+limit < len(filtered) {
		cursor := base64.RawURLEncoding.EncodeToString(marshalJS(object{{"v", 1}, {"k", args.Kind}, {"q", hash(q)}, {"l", limit}, {"last", page[len(page)-1].key}, {"r", revision}}))
		if len(cursor) > 2048 {
			return nil, fail("source_unavailable")
		}
		next = cursor
	}
	items := make([]object, len(page))
	for i, row := range page {
		items[i] = row.dto.without("content_markdown")
	}
	return checkedObject(object{{"schema_version", 1}, {"generated_at", generated()}, {"kind", args.Kind}, {"query", q}, {"count", len(page)}, {"total_count", len(filtered)}, {"limit", limit}, {"next_cursor", next}, {"items", items}})
}
func (s *Service) get(ctx context.Context, args GetArgs) (object, error) {
	var item object
	if args.Kind == "profile" {
		if args.ID != nil && *args.ID != "altena" {
			return nil, fail("not_found")
		}
		raw, err := s.snapshot(ctx, "profile", nil)
		if err != nil {
			return nil, err
		}
		item, err = dto(raw[0])
		if err != nil {
			return nil, err
		}
	} else {
		if !contains([]string{"works", "notes"}, args.Kind) || args.ID == nil || !idPattern.MatchString(*args.ID) {
			return nil, fail("not_found")
		}
		if args.Kind == "notes" {
			raw, err := s.snapshot(ctx, args.Kind, args.ID)
			if err != nil {
				return nil, err
			}
			if len(raw) == 0 {
				return nil, fail("not_found")
			}
			item, err = dto(raw[0])
			if err != nil {
				return nil, err
			}
		} else {
			rows, err := s.rows(ctx, args.Kind)
			if err != nil {
				return nil, err
			}
			for _, row := range rows {
				if row.dto.get("id") == *args.ID {
					item = row.dto
					break
				}
			}
			if item == nil {
				return nil, fail("not_found")
			}
		}
	}
	if body, ok := item.get("content_markdown").(string); ok && len(body) > maxBodyBytes {
		return nil, fail("source_unavailable")
	}
	return checkedObject(object{{"schema_version", 1}, {"generated_at", generated()}, {"item", item}})
}

func line(value any) string {
	if value == nil {
		return ""
	}
	return escapeMarkdown(trim(collapse(fmt.Sprint(value))))
}
func entry(title, url, summary string) string {
	result := "- [" + line(title) + "](<" + url + ">)"
	if summary != "" {
		result += ": " + line(summary)
	}
	return result
}
func documentMarkdown(item object) string {
	title := item.get("title").(string)
	if name, ok := item.get("name").(string); ok && name != "" {
		title = name
	}
	updated := item.get("updated_at")
	if updated == nil || updated == "" {
		updated = item.get("source_modified_at")
	}
	meta := "取得元: " + item.get("source_url").(string) + "\n更新日時: " + fmt.Sprint(updated) + "\n更新日時の根拠: " + item.get("updated_at_basis").(string) + "\nID: " + item.get("id").(string) + "\nrevision: " + escapeMarkdown(item.get("revision").(string))
	result := "# " + escapeMarkdown(title) + "\n\n" + meta + "\n\n"
	if item.get("type") == "profile" {
		roles := []string{}
		for _, value := range item.get("roles").([]string) {
			roles = append(roles, escapeMarkdown(value))
		}
		focus := []string{}
		for _, value := range item.get("focus").([]string) {
			focus = append(focus, "- "+escapeMarkdown(value))
		}
		links := []string{}
		for _, value := range item.get("links").([]string) {
			links = append(links, "- <"+value+">")
		}
		return result + strings.Join(roles, "\n") + "\n\n" + escapeMarkdown(item.get("summary").(string)) + "\n\n" + escapeMarkdown(item.get("bio").(string)) + "\n\n## 活動分野\n" + strings.Join(focus, "\n") + "\n\n## Links\n" + strings.Join(links, "\n") + "\n"
	}
	tags := []string{}
	for _, value := range item.get("tags").([]string) {
		tags = append(tags, escapeMarkdown(value))
	}
	d := "null"
	if item.get("date") != nil {
		d = item.get("date").(string)
	}
	return result + "日付: " + d + "\nタグ: " + strings.Join(tags, ", ") + "\n\n" + escapeMarkdown(item.get("summary").(string)) + "\n\n" + item.get("content_markdown").(string)
}
func (s *Service) markdown(ctx context.Context, args GetArgs) (string, error) {
	if args.Kind == "index" {
		if args.ID != nil {
			return "", fail("not_found")
		}
		profileResult, err := s.get(ctx, GetArgs{Kind: "profile"})
		if err != nil {
			return "", err
		}
		profile := profileResult.get("item").(object)
		worksResult, err := s.list(ctx, ListArgs{Kind: "works", Limit: 5})
		if err != nil {
			return "", err
		}
		notesResult, err := s.list(ctx, ListArgs{Kind: "notes", Limit: 5})
		if err != nil {
			return "", err
		}
		lines := []string{"# Altena Portfolio", "", "取得元: " + site + "index.html", "", "## Profile", "### " + line(profile.get("name"))}
		for _, role := range profile.get("roles").([]string) {
			lines = append(lines, line(role))
		}
		lines = append(lines, "", line(profile.get("summary")), "", line(profile.get("bio")), "", "## 活動分野")
		for _, value := range profile.get("focus").([]string) {
			lines = append(lines, "- "+line(value))
		}
		lines = append(lines, "", "## コンテンツ")
		for _, kind := range []string{"profile", "works", "notes", "skills", "timeline"} {
			lines = append(lines, entry(strings.ToUpper(kind[:1])+kind[1:], site+kind+".md", ""))
		}
		lines = append(lines, "", "## Works")
		for _, item := range worksResult.get("items").([]object) {
			lines = append(lines, entry(item.get("title").(string), site+"works/"+item.get("id").(string)+".md", item.get("summary").(string)))
		}
		lines = append(lines, "", "## Latest Notes")
		for _, item := range notesResult.get("items").([]object) {
			lines = append(lines, entry(item.get("title").(string), site+"notes/"+item.get("id").(string)+".md", item.get("summary").(string)))
		}
		lines = append(lines, "", "## 公開連絡先")
		for _, value := range profile.get("links").([]string) {
			lines = append(lines, "- <"+value+">")
		}
		lines = append(lines, "")
		return strings.Join(lines, "\n"), nil
	}
	if args.Kind == "profile" || args.ID != nil {
		result, err := s.get(ctx, args)
		if err != nil {
			return "", err
		}
		return documentMarkdown(result.get("item").(object)), nil
	}
	if args.Kind == "skills" || args.Kind == "timeline" {
		rows, err := s.rows(ctx, args.Kind)
		if err != nil {
			return "", err
		}
		body := []string{}
		for _, row := range rows {
			if args.Kind == "skills" {
				body = append(body, "- **"+line(row.dto.get("name"))+"**: "+line(row.dto.get("summary")))
			} else {
				body = append(body, "- "+line(row.dto.get("date"))+" — "+line(row.dto.get("title"))+" ("+line(row.dto.get("category"))+")")
			}
		}
		return "# " + strings.ToUpper(args.Kind[:1]) + args.Kind[1:] + "\n\n取得元: " + site + "index.html#" + args.Kind + "\n更新日時: 未記録\n\n" + strings.Join(body, "\n") + "\n", nil
	}
	result, err := s.list(ctx, ListArgs{Kind: args.Kind})
	if err != nil {
		return "", err
	}
	body := []string{}
	for _, item := range result.get("items").([]object) {
		d := "null"
		if item.get("date") != nil {
			d = item.get("date").(string)
		}
		body = append(body, entry(d+" "+item.get("title").(string), site+args.Kind+"/"+item.get("id").(string)+".md", item.get("summary").(string)))
	}
	guidance := fmt.Sprintf("続きを取得するには list_public_content に kind: %q と同じ limit を指定し、応答の next_cursor を cursor に渡してください。検索は search_public_content に同じ kind と q を指定します。cursor_expired の場合は cursor を省いて先頭から取得してください。", args.Kind)
	return "# " + strings.ToUpper(args.Kind[:1]) + args.Kind[1:] + "\n\n" + strings.Join(body, "\n") + fmt.Sprintf("\n\n件数: %v / %v\n\n", result.get("count"), result.get("total_count")) + guidance + "\n", nil
}
