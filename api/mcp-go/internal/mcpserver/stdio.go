package mcpserver

import (
	"context"
	"errors"
	"io"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type boundedWriter struct{ io.WriteCloser }

func (w boundedWriter) Write(p []byte) (int, error) {
	if len(p) > MaxResponseBytes {
		return 0, errors.New("response exceeds budget")
	}
	return w.WriteCloser.Write(p)
}

// ServeStdio uses the SDK's bounded newline decoder. The writer is solely for
// protocol messages; the command sends diagnostics to stderr.
func ServeStdio(ctx context.Context, service Service, reader io.ReadCloser, writer io.WriteCloser) error {
	server, err := New(service, Options{})
	if err != nil {
		return err
	}
	return server.Run(ctx, &mcp.IOTransport{Reader: reader, Writer: boundedWriter{writer}, MaxLineLength: MaxRequestBytes})
}
