// Command agent is the opencode2dsh sidecar: a single-tenant anonymous-lane
// proxy for OpenCode Zen, ported from opencode2api. main.go is the upstream
// startup/signal skeleton with WebUI and the multi-instance runtime removed.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"opencode2dsh/agent/internal/catalog"
	"opencode2dsh/agent/internal/config"
	"opencode2dsh/agent/internal/gateway"
	"opencode2dsh/agent/internal/obs"
)

func main() {
	configPath := flag.String("config", "config.json", "path to config.json")
	listen := flag.String("listen", "", "override the configured API listen address")
	printReady := flag.Bool("print-ready", false, "write a READY line with the bound port to stdout once the listener is up")
	flag.Parse()

	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		slog.Error("configuration error", "error", err)
		os.Exit(1)
	}
	if *listen != "" {
		cfg.Listen = *listen
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// The agent runs as a child process: structured logs go to stderr so the
	// plugin can pipe them; stdout stays reserved for the Phase 1 READY line.
	logger := obs.NewLogger(cfg.Logging.Level)

	// models.dev metadata (S2): the disk cache lives beside the config file
	// and seeds the free-model decision before the first refresh.
	metadata := catalog.NewModelMetadataStore(*configPath, logger)
	metadata.Start(ctx)

	gw, err := gateway.NewGateway(cfg, logger, metadata)
	if err != nil {
		logger.Error("failed to initialize gateway", "component", "runtime", "event", "gateway_initialization_failed", "error", err)
		os.Exit(1)
	}
	gw.StartModelRefresh(ctx)

	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		logger.Error("listen failed", "component", "api", "event", "listen_failed", "address", cfg.Listen, "error", err)
		os.Exit(1)
	}

	apiServer := &http.Server{
		Handler: gw.Handler(), ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 120 * time.Second,
	}
	go func() {
		logger.Info("server listening", "component", "api", "event", "server_started", "address", listener.Addr().String(), "version", gateway.Version())
		if err := apiServer.Serve(listener); err != nil && err != http.ErrServerClosed {
			logger.Error("server stopped unexpectedly", "component", "api", "event", "server_failed", "address", listener.Addr().String(), "error", err)
			cancel()
		}
	}()

	// design.md §8.2: the plugin reads this line instead of polling to
	// discover the randomly bound port (listen 127.0.0.1:0).
	if *printReady {
		ready, err := json.Marshal(map[string]any{"port": listener.Addr().(*net.TCPAddr).Port, "version": gateway.Version()})
		if err != nil {
			logger.Error("failed to encode ready line", "component", "runtime", "event", "ready_encode_failed", "error", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stdout, "READY %s\n", ready)
	}

	<-ctx.Done()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()
	if err := apiServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "component", "server", "event", "shutdown_failed", "address", cfg.Listen, "error", err)
	}
}
