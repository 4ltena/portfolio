package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"altena/portfolio-mcp/internal/publicdata"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type fakeService struct {
	calls   atomic.Int32
	block   chan struct{}
	started chan<- struct{}
	raw     json.RawMessage
	err     error
}

func (s *fakeService) wait() {
	s.calls.Add(1)
	if s.started != nil {
		s.started <- struct{}{}
	}
	if s.block != nil {
		<-s.block
	}
}
func (s *fakeService) List(context.Context, publicdata.ListArgs) (json.RawMessage, error) {
	s.wait()
	if s.raw != nil {
		return s.raw, s.err
	}
	return json.RawMessage(`{"items":[{"type":"work","id":"example","title":"Example"}]}`), s.err
}
func (s *fakeService) Get(context.Context, publicdata.GetArgs) (json.RawMessage, error) {
	s.wait()
	if s.raw != nil {
		return s.raw, s.err
	}
	return json.RawMessage(`{"item":{"type":"work","id":"example","title":"Example"}}`), s.err
}
func (s *fakeService) Markdown(context.Context, publicdata.GetArgs) (string, error) {
	s.wait()
	return "# Example\n", s.err
}

func TestRawResourceURI(t *testing.T) {
	for _, uri := range []string{"portfolio://altena/index", "portfolio://altena/works/a_-Z09", "portfolio://altena/notes/a"} {
		if _, err := ParsePublicResourceURI(uri); err != nil {
			t.Errorf("valid %q: %v", uri, err)
		}
	}
	for _, uri := range []string{
		"portfolio://altena/works/../profile", "portfolio://altena/works/%2e%2e/profile", "portfolio://altena/works/%61",
		"portfolio://altena/works/a?x=1", "portfolio://altena/works/a#fragment", "portfolio://user@altena/profile", "portfolio://altena:80/profile",
		"portfolio://altena/profile/x", "portfolio://altena/works/", "PORTFOLIO://altena/profile", "portfolio://altena/works/" + strings.Repeat("a", 129),
	} {
		if _, err := ParsePublicResourceURI(uri); err == nil {
			t.Errorf("accepted %q", uri)
		}
	}
}

func httpServer(t *testing.T, service Service) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	port := server.Listener.Addr().(*net.TCPAddr).Port
	handler, err := NewHTTPHandler(service, HTTPOptions{Port: port})
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = handler
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func TestSDKHTTPModernAndLegacy(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			service := &fakeService{}
			server := httpServer(t, service)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
			session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp"}, &mcp.ClientSessionOptions{ProtocolVersion: version})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			tools, err := session.ListTools(ctx, nil)
			if err != nil || len(tools.Tools) != 3 {
				t.Fatalf("tools: %v %v", tools, err)
			}
			for _, tool := range tools.Tools {
				if tool.OutputSchema == nil || tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
					t.Errorf("tool contract incomplete: %s", tool.Name)
				}
			}
			resources, err := session.ListResources(ctx, nil)
			if err != nil || len(resources.Resources) != 6 {
				t.Fatalf("resources: %v %v", resources, err)
			}
			templates, err := session.ListResourceTemplates(ctx, nil)
			if err != nil || len(templates.ResourceTemplates) != 2 {
				t.Fatalf("templates: %v %v", templates, err)
			}
			result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "get_public_content", Arguments: map[string]any{"kind": "works", "id": "example"}})
			if err != nil || result.IsError || len(result.Content) != 2 {
				t.Fatalf("valid tool: %v %v", result, err)
			}
			link, ok := result.Content[1].(*mcp.ResourceLink)
			if !ok || link.URI != ResourcePrefix+"works/example" {
				t.Fatalf("link: %v", result.Content)
			}
			read, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: ResourcePrefix + "works/example"})
			if err != nil || read.Contents[0].Text != "# Example\n" {
				t.Fatalf("read: %v %v", read, err)
			}
			before := service.calls.Load()
			for _, input := range []map[string]any{
				{"kind": "profile", "id": "unexpected"}, {"kind": "works"}, {"kind": "works", "id": "../a"}, {"kind": "works", "id": "a", "extra": true}, {"kind": "works", "id": nil},
			} {
				_, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "get_public_content", Arguments: input})
				var rpc *jsonrpc.Error
				if !errors.As(err, &rpc) || rpc.Code != jsonrpc.CodeInvalidParams || rpc.Message != "Invalid request" {
					t.Errorf("invalid args: %v", err)
				}
			}
			for _, uri := range []string{ResourcePrefix + "works/../profile", ResourcePrefix + "works/%2e%2e/profile", ResourcePrefix + "profile?x=1"} {
				_, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: uri})
				var rpc *jsonrpc.Error
				if !errors.As(err, &rpc) || rpc.Code != jsonrpc.CodeInvalidParams {
					t.Errorf("URI %s: %v", uri, err)
				}
			}
			if service.calls.Load() != before {
				t.Fatal("invalid input reached public service")
			}
		})
	}
}

func TestToolArgumentLimits(t *testing.T) {
	for _, input := range []string{
		`{"kind":"works","limit":0}`, `{"kind":"works","limit":51}`, `{"kind":"works","limit":1.5}`, `{"kind":"works","limit":null}`,
		`{"kind":"works","cursor":null}`, `{"kind":"works","cursor":"` + strings.Repeat("x", 2049) + `"}`,
		`{"kind":"works","q":"` + strings.Repeat("あ", 121) + `"}`, `{"kind":"works","q":"a\u0085b"}`, `{"kind":"skills","q":"a"}`, `{"kind":"works","q":null}`, `{"kind":"works","q":"a","unknown":1}`,
	} {
		name := "list_public_content"
		if strings.Contains(input, `"q"`) {
			name = "search_public_content"
		}
		if _, _, err := decodeArgs(name, json.RawMessage(input)); err == nil {
			t.Errorf("accepted %s", input)
		}
	}
	input := `{"kind":"works","q":"` + strings.Repeat("あ", 120) + `"}`
	if _, _, err := decodeArgs("search_public_content", json.RawMessage(input)); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{`{"kind":"works","limit":10.0}`, `{"kind":"works","limit":1e1}`} {
		args, _, err := decodeArgs("list_public_content", json.RawMessage(input))
		if err != nil || args.Limit != 10 {
			t.Errorf("integral JSON number %s: %v %v", input, args, err)
		}
		handler, _ := NewHTTPHandler(&fakeService{}, HTTPOptions{Port: 3318})
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_public_content","arguments":` + input + `}}`
		if response := request(handler, body, nil); response.Code != 200 || strings.Contains(response.Body.String(), `"error"`) {
			t.Errorf("raw integral HTTP request: %d %s", response.Code, response.Body.String())
		}
	}
}

func request(handler http.Handler, body string, modify func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:3318/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if modify != nil {
		modify(req)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}

func TestHTTPGuardsAndRequestLimit(t *testing.T) {
	handler, err := NewHTTPHandler(&fakeService{}, HTTPOptions{Port: 3318, AllowedOrigins: []string{"http://localhost:3317"}})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	for _, test := range []struct {
		modify func(*http.Request)
		status int
	}{
		{func(r *http.Request) {
			r.Host = "attacker.invalid:3318"
			r.Header.Set("X-Forwarded-Host", "127.0.0.1:3318")
		}, 403},
		{func(r *http.Request) { r.Header.Set("Origin", "http://attacker.invalid") }, 403},
		{func(r *http.Request) {
			r.Header.Add("Origin", "http://localhost:3317")
			r.Header.Add("Origin", "http://localhost:3317")
		}, 403},
		{func(r *http.Request) { r.Header.Set("Origin", "http://localhost:3317") }, 200},
		{func(r *http.Request) { r.Method = http.MethodGet }, 405},
		{func(r *http.Request) { r.URL, _ = url.Parse("http://127.0.0.1:3318/mcp?x=1") }, 404},
	} {
		if response := request(handler, body, test.modify); response.Code != test.status {
			t.Errorf("want %d got %d %s", test.status, response.Code, response.Body.String())
		}
	}
	response := request(handler, strings.Repeat(" ", MaxRequestBytes+1), func(r *http.Request) { r.ContentLength = -1 })
	if response.Code != 413 || strings.Contains(response.Body.String(), "65536") {
		t.Errorf("body limit: %d %s", response.Code, response.Body.String())
	}
	for _, origin := range []string{"http://localhost", "http://localhost:80", "http://localhost:03318", "http://localhost:3318/", "http://127.0.0.1:3318?x", "http://user@localhost:3318", "https://localhost:3318", "http://localhost:65536"} {
		if ValidateAllowedOrigin(origin) == nil {
			t.Errorf("accepted origin %q", origin)
		}
	}
}

func TestHTTPRateAndConcurrency(t *testing.T) {
	t.Run("requests", func(t *testing.T) {
		now := time.Now()
		handler, _ := NewHTTPHandler(&fakeService{}, HTTPOptions{Port: 3318, Now: func() time.Time { return now }})
		body := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
		for i := 0; i < 120; i++ {
			if r := request(handler, body, nil); r.Code != 200 {
				t.Fatalf("request %d: %d", i, r.Code)
			}
		}
		if r := request(handler, body, nil); r.Code != 429 {
			t.Fatalf("request rate: %d", r.Code)
		}
		now = now.Add(time.Minute)
		if r := request(handler, body, nil); r.Code != 200 {
			t.Fatalf("rate reset: %d", r.Code)
		}
	})
	t.Run("tool and resource", func(t *testing.T) {
		service := &fakeService{}
		handler, _ := NewHTTPHandler(service, HTTPOptions{Port: 3318})
		for _, body := range []string{`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_public_content","arguments":{"kind":"profile"}}}`, `{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"portfolio://altena/profile"}}`} {
			for i := 0; i < 60; i++ {
				request(handler, body, nil)
			}
			// The 121st HTTP request would obscure the resource budget, so use a
			// fresh HTTP handler for each independent category assertion.
			response := request(handler, body, nil)
			if !strings.Contains(response.Body.String(), "Rate limited") {
				t.Fatalf("category budget: %s", response.Body.String())
			}
			handler, _ = NewHTTPHandler(service, HTTPOptions{Port: 3318})
		}
		if service.calls.Load() != 120 {
			t.Fatalf("rate reached service %d times", service.calls.Load())
		}
	})
	t.Run("concurrency", func(t *testing.T) {
		blocked := make(chan struct{})
		started := make(chan struct{}, 8)
		service := &fakeService{block: blocked, started: started}
		handler, _ := NewHTTPHandler(service, HTTPOptions{Port: 3318})
		finished := make(chan struct{}, 8)
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_public_content","arguments":{"kind":"profile"}}}`
		for i := 0; i < 8; i++ {
			go func() { request(handler, body, nil); finished <- struct{}{} }()
		}
		for i := 0; i < 8; i++ {
			select {
			case <-started:
			case <-time.After(time.Second):
				close(blocked)
				t.Fatal("read did not start")
			}
		}
		if r := request(handler, body, nil); r.Code != 429 {
			t.Errorf("concurrency: %d", r.Code)
		}
		close(blocked)
		for i := 0; i < 8; i++ {
			<-finished
		}
	})
}

func TestServiceTimeoutAndGenericError(t *testing.T) {
	for _, test := range []struct {
		name    string
		service *fakeService
		timeout time.Duration
	}{
		{"generic", &fakeService{err: errors.New("SQL /private/secret.db password")}, time.Second},
		{"deadline", &fakeService{block: make(chan struct{})}, 20 * time.Millisecond},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.service.block != nil {
				defer close(test.service.block)
			}
			server, err := New(test.service, Options{ReadTimeout: test.timeout})
			if err != nil {
				t.Fatal(err)
			}
			clientTransport, serverTransport := mcp.NewInMemoryTransports()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			serverSession, err := server.Connect(ctx, serverTransport, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer serverSession.Close()
			client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
			session, err := client.Connect(ctx, clientTransport, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			started := time.Now()
			result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "get_public_content", Arguments: map[string]any{"kind": "profile"}})
			if err != nil || !result.IsError || !strings.Contains(result.Content[0].(*mcp.TextContent).Text, "Source unavailable") || strings.Contains(result.Content[0].(*mcp.TextContent).Text, "secret") {
				t.Fatalf("error: %v %v", result, err)
			}
			if time.Since(started) > 250*time.Millisecond {
				t.Fatal("service deadline was not enforced")
			}
		})
	}
}

type memoryWriteCloser struct{ bytes.Buffer }

func (*memoryWriteCloser) Close() error { return nil }

func TestStdioWireBudgets(t *testing.T) {
	writer := &memoryWriteCloser{}
	if _, err := (boundedWriter{writer}).Write(make([]byte, MaxResponseBytes+1)); err == nil || writer.Len() != 0 {
		t.Fatal("oversized response was partially written")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	input := io.NopCloser(strings.NewReader(strings.Repeat("x", MaxRequestBytes+1) + "\n"))
	_ = ServeStdio(ctx, &fakeService{}, input, writer)
	if strings.Contains(writer.String(), strings.Repeat("x", 100)) {
		t.Fatal("input was reflected to stdout")
	}
}

func TestHTTPWireResponseLimit(t *testing.T) {
	// Escaping the text copy of structured content exceeds 5MiB while the
	// service envelope itself remains under its independent 2MiB limit.
	raw := json.RawMessage(`{"item":{"content_markdown":"` + strings.Repeat(`\\`, (MaxOutputBytes-100)/2) + `"}}`)
	handler, err := NewHTTPHandler(&fakeService{raw: raw}, HTTPOptions{Port: 3318})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_public_content","arguments":{"kind":"profile"}}}`
	response := request(handler, body, nil)
	if response.Code != 503 || response.Body.Len() > 200 || !strings.Contains(response.Body.String(), "Source unavailable") {
		t.Fatalf("response limit: %d %d", response.Code, response.Body.Len())
	}
}
