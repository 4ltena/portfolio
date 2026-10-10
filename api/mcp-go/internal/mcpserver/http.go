package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const DefaultPort = 3318

type HTTPOptions struct {
	Port           int
	AllowedOrigins []string
	// Now is only used by the fixed-window rate limiter.
	Now func() time.Time
}

var originPattern = regexp.MustCompile(`^http://(127\.0\.0\.1|localhost):([0-9]+)$`)

// ValidateAllowedOrigin accepts only a canonical, explicitly ported loopback
// origin. Paths, credentials, default ports, and URL normalization are rejected.
func ValidateAllowedOrigin(origin string) error {
	match := originPattern.FindStringSubmatch(origin)
	if match == nil {
		return controlledError("invalid_request")
	}
	port, err := strconv.Atoi(match[2])
	if err != nil || port < 1 || port > 65535 || port == 80 || strconv.Itoa(port) != match[2] {
		return controlledError("invalid_request")
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.String() != origin || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return controlledError("invalid_request")
	}
	return nil
}

type rateBucket struct {
	start time.Time
	count int
}
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]rateBucket
	now     func() time.Time
}

func (r *rateLimiter) consume(category string, limit int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	bucket := r.buckets[category]
	if bucket.start.IsZero() || now.Sub(bucket.start) >= time.Minute {
		bucket = rateBucket{start: now}
	}
	if bucket.count >= limit {
		return controlledError("rate_limited")
	}
	bucket.count++
	r.buckets[category] = bucket
	return nil
}

// bufferedResponse holds a whole bounded exchange before exposing bytes to the
// client, so a response budget failure cannot leak a partial result.
type bufferedResponse struct {
	header   http.Header
	body     bytes.Buffer
	status   int
	tooLarge bool
}

func (b *bufferedResponse) Header() http.Header { return b.header }
func (b *bufferedResponse) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}
func (b *bufferedResponse) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	if b.tooLarge || len(p) > MaxResponseBytes-b.body.Len() {
		b.tooLarge = true
		return 0, errors.New("response exceeds budget")
	}
	return b.body.Write(p)
}
func (b *bufferedResponse) Flush() {}

func sendHTTPError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(errorEnvelope(controlledError(code)))
}

// Modern MCP maps JSON-RPC errors to HTTP status codes. Retain that wire
// envelope so SDK clients still receive the protocol error, while replacing
// diagnostic messages and removing unrelated error data.
func sendProtocolHTTPError(w http.ResponseWriter, response *bufferedResponse) bool {
	var rpc struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Error   *struct {
			Code    int64           `json:"code"`
			Message string          `json:"message"`
			Data    json.RawMessage `json:"data,omitempty"`
		} `json:"error"`
	}
	if json.Unmarshal(response.body.Bytes(), &rpc) != nil || rpc.JSONRPC != "2.0" || rpc.Error == nil {
		return false
	}
	message := "Invalid request"
	if rpc.Error.Code == jsonrpc.CodeInternalError {
		message = "Source unavailable"
	}
	if rpc.Error.Message == "Not found" || rpc.Error.Message == "Rate limited" {
		message = rpc.Error.Message
	}
	rpc.Error.Message = message
	if rpc.Error.Code != mcp.CodeUnsupportedProtocolVersion {
		rpc.Error.Data = nil
	}
	body, err := json.Marshal(rpc)
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.status)
	_, _ = w.Write(body)
	return true
}

// NewHTTPHandler serves stateless modern and legacy MCP on /mcp. Port must be
// the actual listening port, including when the caller used port 0 to bind.
func NewHTTPHandler(service Service, opts HTTPOptions) (http.Handler, error) {
	if opts.Port < 1 || opts.Port > 65535 {
		return nil, controlledError("invalid_request")
	}
	origins := make(map[string]bool, len(opts.AllowedOrigins))
	for _, origin := range opts.AllowedOrigins {
		if err := ValidateAllowedOrigin(origin); err != nil {
			return nil, err
		}
		origins[origin] = true
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	rates := &rateLimiter{buckets: make(map[string]rateBucket), now: opts.Now}
	server, err := New(service, Options{BeforeRead: func(category string) error { return rates.consume(category, 60) }})
	if err != nil {
		return nil, err
	}
	sdk := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: MaxRequestBytes, PropagateRequestCancellation: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	concurrent := make(chan struct{}, 8)
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Host != "127.0.0.1:"+strconv.Itoa(opts.Port) && req.Host != "localhost:"+strconv.Itoa(opts.Port) {
			sendHTTPError(w, 403, "invalid_request")
			return
		}
		originValues := req.Header.Values("Origin")
		if len(originValues) > 1 || len(originValues) == 1 && !origins[originValues[0]] {
			sendHTTPError(w, 403, "invalid_request")
			return
		}
		// Do not trust Forwarded, X-Forwarded-Host or X-Forwarded-Proto. req.Host
		// is the only authority checked above.
		if req.URL.Path != "/mcp" || req.URL.RawPath != "" || req.URL.RawQuery != "" || req.URL.Fragment != "" {
			sendHTTPError(w, 404, "invalid_request")
			return
		}
		if err := rates.consume("http", 120); err != nil {
			sendHTTPError(w, 429, "rate_limited")
			return
		}
		select {
		case concurrent <- struct{}{}:
		default:
			sendHTTPError(w, 429, "rate_limited")
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), DefaultReadTimeout)
		defer cancel()
		done := make(chan *bufferedResponse, 1)
		go func() {
			defer func() { <-concurrent }()
			response := &bufferedResponse{header: make(http.Header)}
			body, err := io.ReadAll(http.MaxBytesReader(nil, req.Body, MaxRequestBytes))
			if err != nil {
				status := http.StatusBadRequest
				var tooLarge *http.MaxBytesError
				if errors.As(err, &tooLarge) {
					status = http.StatusRequestEntityTooLarge
				}
				sendHTTPError(response, status, "invalid_request")
				done <- response
				return
			}
			if ctx.Err() != nil {
				sendHTTPError(response, 503, "source_unavailable")
				done <- response
				return
			}
			request := req.Clone(ctx)
			request.Body = io.NopCloser(bytes.NewReader(body))
			request.ContentLength = int64(len(body))
			sdk.ServeHTTP(response, request)
			done <- response
		}()
		select {
		case <-ctx.Done():
			_ = req.Body.Close()
			sendHTTPError(w, 503, "source_unavailable")
		case response := <-done:
			if response.tooLarge {
				sendHTTPError(w, 503, "source_unavailable")
				return
			}
			if response.status >= 400 {
				if sendProtocolHTTPError(w, response) {
					return
				}
				code := "invalid_request"
				if response.status == 405 {
					code = "method_not_allowed"
				}
				if response.status >= 500 {
					code = "source_unavailable"
				}
				sendHTTPError(w, response.status, code)
				return
			}
			for key, values := range response.header {
				if strings.EqualFold(key, "Content-Length") {
					continue
				}
				w.Header()[key] = values
			}
			w.Header().Set("Cache-Control", "no-store")
			if response.status == 0 {
				response.status = http.StatusOK
			}
			w.WriteHeader(response.status)
			_, _ = w.Write(response.body.Bytes())
		}
	}), nil
}
