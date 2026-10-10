// Package mcpserver exposes only the bounded public-data service through MCP.
package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"altena/portfolio-mcp/internal/publicdata"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	ResourcePrefix     = "portfolio://altena/"
	MaxRequestBytes    = 65536
	MaxResponseBytes   = 5 * 1024 * 1024
	MaxOutputBytes     = 2 * 1024 * 1024
	DefaultReadTimeout = 5 * time.Second
)

var (
	validID       = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	validResource = regexp.MustCompile(`^(index|profile|skills|timeline|works|notes)(?:/([A-Za-z0-9_-]{1,128}))?$`)
)

// Service has no transport or external HTTP dependency.
type Service interface {
	List(context.Context, publicdata.ListArgs) (json.RawMessage, error)
	Get(context.Context, publicdata.GetArgs) (json.RawMessage, error)
	Markdown(context.Context, publicdata.GetArgs) (string, error)
}

type Options struct {
	ReadTimeout time.Duration
	BeforeRead  func(category string) error
}

type controlledError string

func (e controlledError) Error() string { return string(e) }

func errorCode(err error) string {
	var controlled controlledError
	if errors.As(err, &controlled) {
		return string(controlled)
	}
	return publicdata.ErrorCode(err)
}

func errorEnvelope(err error) json.RawMessage {
	var controlled controlledError
	if !errors.As(err, &controlled) {
		return publicdata.ErrorEnvelope(err)
	}
	messages := map[string]string{"invalid_request": "Invalid request", "source_unavailable": "Source unavailable", "rate_limited": "Rate limited", "method_not_allowed": "Method not allowed"}
	message, ok := messages[string(controlled)]
	if !ok {
		return errorEnvelope(controlledError("source_unavailable"))
	}
	data, _ := json.Marshal(map[string]any{"schema_version": 1, "error": map[string]string{"code": string(controlled), "message": message}})
	return data
}

func protocolError(code int64, message string) error {
	return &jsonrpc.Error{Code: code, Message: message}
}

// ParsePublicResourceURI validates the raw string, before any URL parser or
// template matcher can normalize percent escapes, authorities, or dot paths.
func ParsePublicResourceURI(uri string) (publicdata.GetArgs, error) {
	if !strings.HasPrefix(uri, ResourcePrefix) {
		return publicdata.GetArgs{}, controlledError("invalid_request")
	}
	match := validResource.FindStringSubmatch(strings.TrimPrefix(uri, ResourcePrefix))
	if match == nil || match[2] != "" && match[1] != "works" && match[1] != "notes" {
		return publicdata.GetArgs{}, controlledError("invalid_request")
	}
	args := publicdata.GetArgs{Kind: match[1]}
	if match[2] != "" {
		args.ID = &match[2]
	}
	return args, nil
}

func decodeArgs(name string, raw json.RawMessage) (publicdata.ListArgs, publicdata.GetArgs, error) {
	invalid := func() (publicdata.ListArgs, publicdata.GetArgs, error) {
		return publicdata.ListArgs{}, publicdata.GetArgs{}, controlledError("invalid_request")
	}
	var fields map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
		return invalid()
	}
	allowed := map[string]bool{"kind": true}
	if name == "get_public_content" {
		allowed["id"] = true
	} else {
		allowed["limit"] = true
		allowed["cursor"] = true
		if name == "search_public_content" {
			allowed["q"] = true
		}
	}
	for key := range fields {
		if !allowed[key] {
			return invalid()
		}
	}
	getString := func(key string) (string, bool) {
		var s string
		v, ok := fields[key]
		if !ok || len(v) == 0 || v[0] != '"' || json.Unmarshal(v, &s) != nil {
			return "", false
		}
		return s, true
	}
	kind, ok := getString("kind")
	if !ok {
		return invalid()
	}
	if name == "get_public_content" {
		args := publicdata.GetArgs{Kind: kind}
		if kind == "profile" {
			if _, ok := fields["id"]; ok {
				return invalid()
			}
			return publicdata.ListArgs{}, args, nil
		}
		id, ok := getString("id")
		if (kind != "works" && kind != "notes") || !ok || !validID.MatchString(id) {
			return invalid()
		}
		args.ID = &id
		return publicdata.ListArgs{}, args, nil
	}
	if kind != "works" && kind != "notes" && (name == "search_public_content" || kind != "skills" && kind != "timeline") {
		return invalid()
	}
	args := publicdata.ListArgs{Kind: kind, Limit: 20}
	if value, ok := fields["limit"]; ok {
		var number float64
		if bytes.Equal(value, []byte("null")) || json.Unmarshal(value, &number) != nil || number < 1 || number > 50 || math.Trunc(number) != number {
			return invalid()
		}
		args.Limit = int(number)
	}
	if _, ok := fields["cursor"]; ok {
		cursor, valid := getString("cursor")
		if !valid || len(cursor) > 2048 {
			return invalid()
		}
		args.Cursor = &cursor
	}
	if name == "search_public_content" {
		q, valid := getString("q")
		if !valid || !utf8.ValidString(q) || utf8.RuneCountInString(q) > 120 || strings.ContainsFunc(q, unicode.IsControl) {
			return invalid()
		}
		args.Q = &q
	}
	return args, publicdata.GetArgs{}, nil
}

func toolResult(raw json.RawMessage, failed bool) *mcp.CallToolResult {
	result := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}}, StructuredContent: raw, IsError: failed}
	if failed {
		return result
	}
	var data struct {
		Item  *linkItem  `json:"item"`
		Items []linkItem `json:"items"`
	}
	if json.Unmarshal(raw, &data) != nil {
		return result
	}
	if data.Item != nil {
		data.Items = []linkItem{*data.Item}
	}
	for _, item := range data.Items {
		var path string
		switch item.Type {
		case "profile":
			path = "profile"
		case "work":
			path = "works/" + item.ID
		case "note":
			path = "notes/" + item.ID
		default:
			continue
		}
		result.Content = append(result.Content, &mcp.ResourceLink{URI: ResourcePrefix + path, Name: item.ID, Title: item.Title, MIMEType: "text/markdown"})
	}
	return result
}

type linkItem struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Title string `json:"title"`
}

// New advertises the existing three tools, six resources and two templates.
func New(service Service, opts Options) (*mcp.Server, error) {
	if service == nil || opts.ReadTimeout < 0 {
		return nil, controlledError("invalid_request")
	}
	if opts.ReadTimeout == 0 {
		opts.ReadTimeout = DefaultReadTimeout
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := mcp.NewServer(&mcp.Implementation{Name: "altena-portfolio-public", Version: "1.0.0"}, &mcp.ServerOptions{Logger: logger, Capabilities: &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{}, Resources: &mcp.ResourceCapabilities{}}})
	beforeRead := func(category string) error {
		if opts.BeforeRead != nil {
			return opts.BeforeRead(category)
		}
		return nil
	}
	// Keep capacity until the actual service call finishes, even if a service
	// ignores cancellation. Repeated timed-out requests cannot create unlimited
	// readers in the background.
	readers := make(chan struct{}, 8)
	read := func(ctx context.Context, operation func() (json.RawMessage, error)) (json.RawMessage, error) {
		select {
		case readers <- struct{}{}:
		default:
			return nil, controlledError("rate_limited")
		}
		type result struct {
			raw json.RawMessage
			err error
		}
		done := make(chan result, 1)
		go func() { defer func() { <-readers }(); raw, err := operation(); done <- result{raw, err} }()
		select {
		case <-ctx.Done():
			return nil, controlledError("source_unavailable")
		case value := <-done:
			return value.raw, value.err
		}
	}
	annotations := &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: new(false), IdempotentHint: true, OpenWorldHint: new(false)}
	for _, entry := range []struct{ name, title, description string }{
		{"list_public_content", "List public portfolio content", "Read a bounded page of public works, notes, skills or timeline entries."},
		{"search_public_content", "Search public portfolio content", "Search public works or notes by title, summary, tags and Markdown text."},
		{"get_public_content", "Read public portfolio content", "Read the public profile or one public work or note, including its Markdown body."},
	} {
		server.AddTool(&mcp.Tool{Name: entry.name, Title: entry.title, Description: entry.description, InputSchema: inputSchema(entry.name), OutputSchema: outputSchema(entry.name == "get_public_content"), Annotations: annotations}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			list, get, err := decodeArgs(entry.name, req.Params.Arguments)
			if err != nil {
				return nil, protocolError(jsonrpc.CodeInvalidParams, "Invalid request")
			}
			if err = beforeRead("tool"); err != nil {
				return toolResult(errorEnvelope(err), true), nil
			}
			readCtx, cancel := context.WithTimeout(ctx, opts.ReadTimeout)
			defer cancel()
			raw, err := read(readCtx, func() (json.RawMessage, error) {
				if entry.name == "get_public_content" {
					return service.Get(readCtx, get)
				}
				return service.List(readCtx, list)
			})
			if readCtx.Err() != nil || len(raw) > MaxOutputBytes || err == nil && !json.Valid(raw) {
				err = controlledError("source_unavailable")
			}
			if err != nil {
				return toolResult(errorEnvelope(err), true), nil
			}
			return toolResult(raw, false), nil
		})
	}
	resource := func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		args, err := ParsePublicResourceURI(req.Params.URI)
		if err != nil {
			return nil, protocolError(jsonrpc.CodeInvalidParams, "Invalid request")
		}
		if err = beforeRead("resource"); err != nil {
			return nil, protocolError(jsonrpc.CodeInternalError, "Rate limited")
		}
		readCtx, cancel := context.WithTimeout(ctx, opts.ReadTimeout)
		defer cancel()
		raw, err := read(readCtx, func() (json.RawMessage, error) {
			text, err := service.Markdown(readCtx, args)
			return json.RawMessage(text), err
		})
		text := string(raw)
		if readCtx.Err() != nil || len(text) > MaxOutputBytes {
			err = controlledError("source_unavailable")
		}
		if err != nil {
			if errorCode(err) == "not_found" {
				return nil, protocolError(jsonrpc.CodeInvalidParams, "Not found")
			}
			if errorCode(err) == "invalid_request" {
				return nil, protocolError(jsonrpc.CodeInvalidParams, "Invalid request")
			}
			return nil, protocolError(jsonrpc.CodeInternalError, "Source unavailable")
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: req.Params.URI, MIMEType: "text/markdown", Text: text}}}, nil
	}
	for _, entry := range []struct{ kind, title string }{{"index", "Public portfolio overview"}, {"profile", "Public profile"}, {"works", "Public works"}, {"notes", "Public notes"}, {"skills", "Public skills"}, {"timeline", "Public timeline"}} {
		server.AddResource(&mcp.Resource{URI: ResourcePrefix + entry.kind, Name: entry.kind, Title: entry.title, Description: entry.title + " as bounded Markdown.", MIMEType: "text/markdown"}, resource)
	}
	for _, kind := range []string{"works", "notes"} {
		server.AddResourceTemplate(&mcp.ResourceTemplate{Name: kind + "-detail", URITemplate: ResourcePrefix + kind + "/{id}", Title: "Public " + kind + " detail", Description: "Read a public item ID discovered from a tool result.", MIMEType: "text/markdown"}, resource)
	}
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if method == "resources/read" {
				read, ok := req.(*mcp.ReadResourceRequest)
				if !ok || read.Params == nil {
					return nil, protocolError(jsonrpc.CodeInvalidParams, "Invalid request")
				}
				if _, err := ParsePublicResourceURI(read.Params.URI); err != nil {
					return nil, protocolError(jsonrpc.CodeInvalidParams, "Invalid request")
				}
				// Preserve the SDK's version-specific result adaptation, including
				// the modern resultType field, after validating the raw request.
				return next(ctx, method, req)
			}
			return next(ctx, method, req)
		}
	})
	return server, nil
}
