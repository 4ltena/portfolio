package publicdata

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func ptr(value string) *string { return &value }
func fixture(t *testing.T) (*Service, *sql.DB, string) {
	t.Helper()
	root := t.TempDir()
	dbPath := filepath.Join(root, "fixture.sqlite")
	writer, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE articles (id TEXT PRIMARY KEY,title TEXT,date TEXT,tags TEXT,excerpt TEXT,content TEXT,created_at INTEGER,updated_at INTEGER,published_at INTEGER,visibility TEXT)`,
		`CREATE TABLE skills (id TEXT PRIMARY KEY,name TEXT,description TEXT,sort_order REAL)`,
		`CREATE TABLE timeline (id TEXT PRIMARY KEY,date TEXT,title TEXT,category TEXT,href TEXT)`,
		`INSERT INTO skills VALUES ('linux','Linux','Operating systems',1),('go','Go','Backend',2)`,
		`INSERT INTO timeline VALUES ('event','2026/01/02','Started','study','index.html')`,
	} {
		if _, err = writer.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct {
		id, visibility string
		published      int64
	}{{"public-a", "public", 1700000000000}, {"public-b", "public", 1600000000000}, {"draft", "draft", 1800000000000}, {"unlisted", "unlisted", 1800000000000}, {"bad/id", "public", 1800000000000}, {"日本語", "public", 1800000000000}, {"nul\x00id", "public", 1800000000000}} {
		_, err = writer.Exec(`INSERT INTO articles VALUES (?,?,?,'["Linux"]','Summary',?,1000,2000,?,?)`, row.id, "Ｌｉｎｕｘ < & \u2028", "2026/01/02", "<p>Text <strong>bold</strong><br>next</p><pre><code>if (a &lt; b) {\n\n  x = \"```\";\n}</code></pre><script>PRIVATE_SCRIPT</script>", row.published, row.visibility)
		if err != nil {
			t.Fatal(err)
		}
	}
	write := func(name, value string) {
		t.Helper()
		filename := filepath.Join(root, name)
		if err = os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filename, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", `<div class="hero-foot"><span>Infrastructure</span><span class="hero-scroll">Scroll</span></div><section id="profile"><span class="brand">Altena</span><p class="philosophy">Alt &amp; Higher</p><div class="bio"><p>Hello</p><p>World</p></div><nav class="profile-social"><a href="https://example.com">Social</a><a href="mailto:test@example.com">Mail</a></nav></section>`)
	write("terminal/profile.txt", " | Role    Engineer\n | Frontend Developer\n")
	write("myworks.html", `<div class="page-tile-container"><a class="page-tile-item" href="works/example/index.html" data-tags="#Go #Linux"><h3>Example</h3><p>Work summary</p><span class="note-date">2026/01/03</span></a><a class="page-tile-item" href="../secret/index.html"><h3>Private</h3></a></div>`)
	write("works/example/index.html", `<div class="project-desc"><p>A <code>&lt;tag&gt;</code></p><img src="../../img/example.png" alt="Picture"><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></div>`)
	service, err := New(Config{Root: root, DBPath: dbPath})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { service.Close(); writer.Close() })
	return service, writer, root
}
func decoded(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func list(t *testing.T, s *Service, args ListArgs) map[string]any {
	t.Helper()
	raw, err := s.List(context.Background(), args)
	if err != nil {
		t.Fatal(err)
	}
	return decoded(t, raw)
}
func detail(t *testing.T, s *Service, args GetArgs) map[string]any {
	t.Helper()
	raw, err := s.Get(context.Background(), args)
	if err != nil {
		t.Fatal(err)
	}
	return decoded(t, raw)["item"].(map[string]any)
}
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || ErrorCode(err) != code {
		t.Fatalf("error=%v, code=%s, want=%s", err, ErrorCode(err), code)
	}
}

func TestPublicOnlyAndControlledErrors(t *testing.T) {
	s, _, root := fixture(t)
	page := list(t, s, ListArgs{Kind: "notes"})
	if page["total_count"] != float64(2) {
		t.Fatalf("public total=%v", page["total_count"])
	}
	for _, id := range []string{"draft", "unlisted", "bad/id", "../secret", "日本語", "nul\x00id", "missing"} {
		_, err := s.Get(context.Background(), GetArgs{Kind: "notes", ID: ptr(id)})
		requireCode(t, err, "not_found")
	}
	if item := detail(t, s, GetArgs{Kind: "notes", ID: ptr("public-a")}); strings.Contains(item["content_markdown"].(string), "PRIVATE_SCRIPT") {
		t.Fatal("script leaked")
	}
	for _, id := range []string{"../secret", "draft"} {
		_, err := s.Get(context.Background(), GetArgs{Kind: "works", ID: ptr(id)})
		requireCode(t, err, "not_found")
	}
	if got := string(ErrorEnvelope(errors.New("private SQL " + root))); got != `{"schema_version":1,"error":{"code":"source_unavailable","message":"Source unavailable"}}` {
		t.Fatal(got)
	}
	if _, err := s.Get(context.Background(), GetArgs{Kind: "profile", ID: ptr("unknown")}); ErrorCode(err) != "not_found" {
		t.Fatal(err)
	}
}
func TestSearchCursorAndRevision(t *testing.T) {
	s, writer, _ := fixture(t)
	first := list(t, s, ListArgs{Kind: "notes", Q: ptr("  ＬＩＮＵＸ  "), Limit: 1})
	if first["query"] != "linux" || first["total_count"] != float64(2) {
		t.Fatal(first)
	}
	cursor := first["next_cursor"].(string)
	second := list(t, s, ListArgs{Kind: "notes", Q: ptr("linux"), Limit: 1, Cursor: &cursor})
	if second["items"].([]any)[0].(map[string]any)["id"] != "public-b" {
		t.Fatal(second)
	}
	before := detail(t, s, GetArgs{Kind: "notes", ID: ptr("public-a")})["revision"]
	if _, err := writer.Exec(`UPDATE articles SET content='private changes' WHERE visibility!='public'`); err != nil {
		t.Fatal(err)
	}
	list(t, s, ListArgs{Kind: "notes", Q: ptr("linux"), Limit: 1, Cursor: &cursor})
	if _, err := writer.Exec(`UPDATE articles SET content='<p>Public change</p>' WHERE id='public-a'`); err != nil {
		t.Fatal(err)
	}
	_, err := s.List(context.Background(), ListArgs{Kind: "notes", Q: ptr("linux"), Limit: 1, Cursor: &cursor})
	requireCode(t, err, "cursor_expired")
	if after := detail(t, s, GetArgs{Kind: "notes", ID: ptr("public-a")})["revision"]; after == before {
		t.Fatal("content update did not revise")
	}
	for _, query := range []string{strings.Repeat("🧪", 121), "a\n", "a\x00"} {
		_, err := s.List(context.Background(), ListArgs{Kind: "notes", Q: ptr(query)})
		requireCode(t, err, "invalid_request")
	}
	for _, bad := range []string{"", strings.Repeat("a", 2049), "*", base64.RawURLEncoding.EncodeToString([]byte(`{}`))} {
		_, err := s.List(context.Background(), ListArgs{Kind: "notes", Cursor: &bad})
		requireCode(t, err, "invalid_cursor")
	}
	for input, want := range map[string]string{"ΟΣ": "ος", "İ": "i̇", "\ufeffLinux\ufeff": "linux"} {
		if value := list(t, s, ListArgs{Kind: "notes", Q: &input})["query"]; value != want {
			t.Fatalf("normalize %q=%q want %q", input, value, want)
		}
	}
}
func TestHTMLLiteralCodeAndPublicStructures(t *testing.T) {
	input := "<p>Hello<br>world <a href=\"javascript:private\">label</a></p><pre><code>&lt;script&gt;\n\n```\n&lt;/script&gt;</code></pre><script>hidden</script><style>hidden</style><table><tr><th>A</th><th>B</th></tr><tr><td>one|two</td><td>2</td></tr></table><img src=\"/portfolio/img/a.png\" alt=\"A [pic]\"><img src=\"data:secret\"><blockquote><p>Quote</p></blockquote>"
	got, err := htmlToMarkdown(input, site)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Hello\nworld label", "````\n<script>\n\n```\n</script>\n````", "| A | B |\n| --- | --- |\n| one\\|two | 2 |", "![A \\[pic\\]](<https://altena.me/portfolio/img/a.png>)", "> Quote"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}
	for _, forbidden := range []string{"hidden", "javascript:", "data:secret"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("leaked %q", forbidden)
		}
	}
	s, _, _ := fixture(t)
	work := detail(t, s, GetArgs{Kind: "works", ID: ptr("example")})
	body := work["content_markdown"].(string)
	if !strings.Contains(body, "` <tag> `") || !strings.Contains(body, "https://altena.me/portfolio/img/example.png") {
		t.Fatal(body)
	}
}
func TestBoundsPathsCancellationAndReadOnly(t *testing.T) {
	s, writer, root := fixture(t)
	if _, err := s.db.Exec(`UPDATE articles SET title='mutated'`); err == nil {
		t.Fatal("readonly database accepted write")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.List(ctx, ListArgs{Kind: "notes"})
	requireCode(t, err, "source_unavailable")
	if _, err = writer.Exec(`UPDATE articles SET content=? WHERE id='draft'`, strings.Repeat("x", maxBodyBytes+1)); err != nil {
		t.Fatal(err)
	}
	list(t, s, ListArgs{Kind: "notes"})
	if _, err = writer.Exec(`UPDATE articles SET content=? WHERE id='public-a'`, strings.Repeat("x", maxBodyBytes+1)); err != nil {
		t.Fatal(err)
	}
	_, err = s.List(context.Background(), ListArgs{Kind: "notes"})
	requireCode(t, err, "source_unavailable")
	outside := filepath.Join(t.TempDir(), "secret.html")
	if err = os.WriteFile(outside, []byte(`<div class="project-desc">PRIVATE</div>`), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "works/example/index.html")
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	_, err = s.List(context.Background(), ListArgs{Kind: "works"})
	requireCode(t, err, "source_unavailable")
	if err = os.WriteFile(filepath.Join(root, "index.html"), []byte(strings.Repeat("x", maxFileBytes+1)), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = s.Get(context.Background(), GetArgs{Kind: "profile"})
	requireCode(t, err, "source_unavailable")
}
func TestJSONInsertionOrderAndLiteralUnicode(t *testing.T) {
	value := object{{"z", "<>&\u2028\u2029"}, {"a", []any{nil, 1, "x"}}}
	got := string(marshalJS(value))
	if got != "{\"z\":\"<>&\u2028\u2029\",\"a\":[null,1,\"x\"]}" {
		t.Fatal(got)
	}
}

func TestHTMLDepthAndTokenBounds(t *testing.T) {
	for _, input := range []string{strings.Repeat("<b>", 129) + "deep" + strings.Repeat("</b>", 129), strings.Repeat("<br>", 100001)} {
		_, err := htmlToMarkdown(input, site)
		requireCode(t, err, "source_unavailable")
	}
	s, writer, _ := fixture(t)
	if _, err := writer.Exec(`UPDATE articles SET content=? WHERE id='public-a'`, strings.Repeat("<b>", 129)+"deep"+strings.Repeat("</b>", 129)); err != nil {
		t.Fatal(err)
	}
	_, err := s.Get(context.Background(), GetArgs{Kind: "notes", ID: ptr("public-a")})
	requireCode(t, err, "source_unavailable")
}

func TestUnicodeURLAndUTF8SourceAccounting(t *testing.T) {
	url := safeURL("notes.html?search=AIハッカソン&x=%E3%81%82&quoted='ok'", site, true)
	if url != "https://altena.me/portfolio/notes.html?search=AI%E3%83%8F%E3%83%83%E3%82%AB%E3%82%BD%E3%83%B3&x=%E3%81%82&quoted=%27ok%27" {
		t.Fatal(url)
	}
	for _, example := range []struct {
		input    []byte
		expected string
	}{{[]byte{0xff, 0xff}, "��"}, {[]byte{0xe2, 0x82}, "�"}, {[]byte{0xf0, 0x9f, 0x92}, "�"}, {[]byte{0xe0, 0x80, 0x80}, "���"}} {
		if got := decodeUTF8(example.input); got != example.expected {
			t.Fatalf("decode %x=%q want %q", example.input, got, example.expected)
		}
	}
	s, _, root := fixture(t)
	if err := os.WriteFile(filepath.Join(root, "terminal/profile.txt"), []byte{0xff, 0xff}, 0600); err != nil {
		t.Fatal(err)
	}
	tx, err := s.begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	r := reader{service: s, tx: tx, ctx: context.Background(), sourceBytes: maxDatasetBytes - 5}
	_, _, err = r.readText("terminal/profile.txt")
	requireCode(t, err, "source_unavailable")
}

func TestTrackedRevisionIgnoresMtimeAndConcurrentReads(t *testing.T) {
	s, _, root := fixture(t)
	before := detail(t, s, GetArgs{Kind: "works", ID: ptr("example")})
	future := time.Now().Add(2 * time.Hour)
	if err := os.Chtimes(filepath.Join(root, "works/example/index.html"), future, future); err != nil {
		t.Fatal(err)
	}
	after := detail(t, s, GetArgs{Kind: "works", ID: ptr("example")})
	if before["revision"] != after["revision"] || before["source_modified_at"] == after["source_modified_at"] {
		t.Fatal("mtime changed content revision or failed to update source timestamp")
	}
	errors := make(chan error, 24)
	for i := 0; i < 24; i++ {
		go func(i int) {
			var err error
			switch i % 3 {
			case 0:
				_, err = s.List(context.Background(), ListArgs{Kind: "notes"})
			case 1:
				_, err = s.Get(context.Background(), GetArgs{Kind: "profile"})
			case 2:
				_, err = s.Markdown(context.Background(), GetArgs{Kind: "index"})
			}
			errors <- err
		}(i)
	}
	for i := 0; i < 24; i++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
}

func TestPublicItemLimit(t *testing.T) {
	s, writer, _ := fixture(t)
	for i := 0; i < maxItems; i++ {
		if _, err := writer.Exec(`INSERT INTO skills (id,name,description,sort_order) VALUES (?,?,?,?)`, "entry-"+strconv.Itoa(i), "Skill", "Summary", i); err != nil {
			t.Fatal(err)
		}
	}
	_, err := s.List(context.Background(), ListArgs{Kind: "skills"})
	requireCode(t, err, "source_unavailable")
}

func TestCompactDatesCalendarAndMissingValues(t *testing.T) {
	for _, input := range []string{"2024-02-29", "2024/02/29", "20240229"} {
		value, err := date(input)
		if err != nil || value != "2024-02-29" {
			t.Fatalf("date %q = %v, %v", input, value, err)
		}
	}
	for _, input := range []any{nil, ""} {
		value, err := date(input)
		if err != nil || value != nil {
			t.Fatalf("missing date invented: %v, %v", value, err)
		}
	}
	for _, input := range []string{"20260230", "20260229", "20261301", "2026011", "2026 0101", " 20260101", "２０２６０１０１"} {
		_, err := date(input)
		requireCode(t, err, "source_unavailable")
	}
}

func TestMixedDatesUseCanonicalChronologicalCursorKeys(t *testing.T) {
	s, writer, root := fixture(t)
	before := list(t, s, ListArgs{Kind: "timeline"})["items"].([]any)[0]
	if _, err := writer.Exec(`UPDATE timeline SET date='20260102' WHERE id='event'`); err != nil {
		t.Fatal(err)
	}
	after := list(t, s, ListArgs{Kind: "timeline"})["items"].([]any)[0]
	if !reflect.DeepEqual(before, after) {
		t.Fatal("compact date changed an equivalent DTO or revision")
	}
	for _, row := range []struct{ id, date string }{{"compact", "20260101"}, {"slash", "2026/08/11"}, {"iso", "2026-07-01"}, {"leap", "20240229"}, {"missing", ""}} {
		if _, err := writer.Exec(`INSERT INTO timeline VALUES (?,?,?,'public',NULL)`, row.id, row.date, row.id); err != nil {
			t.Fatal(err)
		}
	}
	first := list(t, s, ListArgs{Kind: "timeline", Limit: 2})
	items := first["items"].([]any)
	if items[0].(map[string]any)["id"] != "slash" || items[1].(map[string]any)["id"] != "iso" {
		t.Fatal(items)
	}
	cursor := first["next_cursor"].(string)
	cursorBytes, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		t.Fatal(err)
	}
	position := decoded(t, cursorBytes)
	if !reflect.DeepEqual(position["last"], []any{"2026-07-01", "iso"}) {
		t.Fatal(position)
	}
	second := list(t, s, ListArgs{Kind: "timeline", Limit: 2, Cursor: &cursor})["items"].([]any)
	if second[0].(map[string]any)["id"] != "event" || second[1].(map[string]any)["id"] != "compact" {
		t.Fatal(second)
	}
	all := list(t, s, ListArgs{Kind: "timeline"})["items"].([]any)
	if all[len(all)-1].(map[string]any)["date"] != nil {
		t.Fatal("invented missing date")
	}
	body, err := s.Markdown(context.Background(), GetArgs{Kind: "timeline"})
	if err != nil || !strings.Contains(body, "2024-02-29 — leap") {
		t.Fatalf("markdown %q error %v", body, err)
	}

	gallery := `<div class="page-tile-container"><a class="page-tile-item" href="works/example/index.html"><h3>Compact</h3><span class="note-date">20260101</span><p>Older</p></a><a class="page-tile-item" href="works/newer/index.html"><h3>Slash</h3><span class="note-date">2026/08/11</span><p>Newer</p></a></div>`
	if err = os.WriteFile(filepath.Join(root, "myworks.html"), []byte(gallery), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(root, "works/newer"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "works/newer/index.html"), []byte(`<div class="project-desc"><p>Body</p></div>`), 0600); err != nil {
		t.Fatal(err)
	}
	works := list(t, s, ListArgs{Kind: "works", Limit: 1})
	if works["items"].([]any)[0].(map[string]any)["id"] != "newer" {
		t.Fatal(works)
	}
	workCursor := works["next_cursor"].(string)
	older := list(t, s, ListArgs{Kind: "works", Limit: 1, Cursor: &workCursor})["items"].([]any)[0].(map[string]any)
	if older["id"] != "example" || older["date"] != "2026-01-01" {
		t.Fatal(older)
	}
	beforeNote := detail(t, s, GetArgs{Kind: "notes", ID: ptr("public-a")})
	if _, err = writer.Exec(`UPDATE articles SET date='20260102' WHERE id='public-a'`); err != nil {
		t.Fatal(err)
	}
	if afterNote := detail(t, s, GetArgs{Kind: "notes", ID: ptr("public-a")}); !reflect.DeepEqual(beforeNote, afterNote) {
		t.Fatal("equivalent note date changed DTO/revision")
	}
	if _, err = writer.Exec(`UPDATE timeline SET date='20260230' WHERE id='compact'`); err != nil {
		t.Fatal(err)
	}
	_, err = s.List(context.Background(), ListArgs{Kind: "timeline"})
	requireCode(t, err, "source_unavailable")
}
