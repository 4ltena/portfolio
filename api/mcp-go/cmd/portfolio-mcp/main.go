package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"altena/portfolio-mcp/internal/mcpserver"
	"altena/portfolio-mcp/internal/publicdata"
)

type originsFlag []string

func (o *originsFlag) String() string { return strings.Join(*o, ",") }
func (o *originsFlag) Set(value string) error {
	if err := mcpserver.ValidateAllowedOrigin(value); err != nil {
		return errors.New("invalid allowed origin")
	}
	*o = append(*o, value)
	return nil
}

// Resolve a default only from operator-controlled working/executable ancestry.
// An explicit root (or PORTFOLIO_MCP_ROOT) avoids dependence on a launch cwd.
func defaultRoot() string {
	if root := os.Getenv("PORTFOLIO_MCP_ROOT"); root != "" {
		return root
	}
	var starts []string
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	if executable, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(executable))
	}
	for _, start := range starts {
		for dir := start; ; dir = filepath.Dir(dir) {
			index, indexErr := os.Stat(filepath.Join(dir, "index.html"))
			api, apiErr := os.Stat(filepath.Join(dir, "api"))
			if indexErr == nil && !index.IsDir() && apiErr == nil && api.IsDir() {
				return dir
			}
			if parent := filepath.Dir(dir); parent == dir {
				break
			}
		}
	}
	return ""
}

type stdoutWriter struct{}

func (stdoutWriter) Write(p []byte) (int, error) { return os.Stdout.Write(p) }
func (stdoutWriter) Close() error                { return nil }

func run() error {
	flags := flag.NewFlagSet("portfolio-mcp", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", defaultRoot(), "Portfolio repository root")
	db := flags.String("db", os.Getenv("PORTFOLIO_MCP_DB"), "Existing public SQLite database")
	transport := flags.String("transport", "stdio", "stdio or http")
	portDefault := mcpserver.DefaultPort
	if value := os.Getenv("PORTFOLIO_MCP_PORT"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return errors.New("invalid configuration")
		}
		portDefault = parsed
	}
	port := flags.Int("port", portDefault, "Loopback HTTP port (0 chooses an available port)")
	var origins originsFlag
	if value := os.Getenv("PORTFOLIO_MCP_ORIGINS"); value != "" {
		for _, origin := range strings.Split(value, ",") {
			if err := origins.Set(origin); err != nil {
				return err
			}
		}
	}
	flags.Var(&origins, "allowed-origin", "Explicit loopback origin; repeat for multiple origins")
	if err := flags.Parse(os.Args[1:]); err != nil || flags.NArg() != 0 || *root == "" || *port < 0 || *port > 65535 || *transport != "stdio" && *transport != "http" {
		return errors.New("invalid configuration")
	}
	resolvedRoot, err := filepath.Abs(*root)
	if err != nil {
		return errors.New("invalid configuration")
	}
	if *db == "" {
		*db = filepath.Join(resolvedRoot, "api", "data", "portfolio.db")
	}
	resolvedDB, err := filepath.Abs(*db)
	if err != nil {
		return errors.New("invalid configuration")
	}
	source, err := publicdata.New(publicdata.Config{Root: resolvedRoot, DBPath: resolvedDB})
	if err != nil {
		return errors.New("public source could not be opened")
	}
	defer source.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *transport == "stdio" {
		err := mcpserver.ServeStdio(ctx, source, os.Stdin, stdoutWriter{})
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		return errors.New("http listener could not be opened")
	}
	defer listener.Close()
	actualPort := listener.Addr().(*net.TCPAddr).Port
	handler, err := mcpserver.NewHTTPHandler(source, mcpserver.HTTPOptions{Port: actualPort, AllowedOrigins: origins})
	if err != nil {
		return errors.New("invalid configuration")
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 6 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
	finished := make(chan error, 1)
	go func() { finished <- server.Serve(listener) }()
	fmt.Fprintf(os.Stderr, "Local public MCP: http://127.0.0.1:%d/mcp\n", actualPort)
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
		}
		return nil
	case err := <-finished:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return errors.New("http server failed")
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Local public MCP could not be started or completed")
		os.Exit(1)
	}
}
