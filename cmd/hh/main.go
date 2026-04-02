package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	defaultRouterURL = "http://127.0.0.1:9000"
	defaultPort      = "9000"
	defaultSecret    = "dev-secret"
)

// Set at build time via -ldflags "-X main.projectRoot=..."
var projectRoot string

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(0)
	}

	switch os.Args[1] {
	case "init":
		cmdInit()
	case "status":
		cmdStatus()
	case "kill":
		cmdKill()
	case "router":
		cmdRouter()
	case "--help", "-h", "help":
		usage()
	default:
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Println(`                                                              ...::::::::..
                              .=%@@@*+=#@
                           -%@*.         
                        .%@-             
                     *#@*.               
                   .=@@*                 
             :.   =@=.                   
         =@@*. .=@+                      
        -@.:  =@+            .-%@@@@@@@@@
        .@*:+@+        .=#@@@@@@@@@@@@@@@
           ..       .%@@@@@%@@@@@@@@@@@@@
                   =@@@@@@+ .@@@@@@@@@@@@
                      .*@@@@@@@@@@@@@@@@@
                  =******@@@@@@@@@@@@@@@@
                   .+@@@@@@@@@@@@@@@@@@@@
                       :%@@@@@@@@@@@@@@@@
                           .-+#@@@@@@@@@@
						   
  HookHerald — webhook relay for Claude Code

Usage: hh <command> [options]

Commands:
  init   [--slug <slug>] [--router-url <url>]   Set up .mcp.json in current directory
  status [--router-url <url>]                    Show active sessions
  kill   <slug> [--router-url <url>]             Bounce a session (Claude Code will respawn it)
  router [--port <port>] [--secret <secret>]     Start the webhook router`)
}

// --- Flag parsing ---

func getFlag(name string) string {
	flag := "--" + name
	for i, arg := range os.Args {
		if arg == flag && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return ""
}

// --- Slug detection ---

func detectSlug() string {
	out, err := exec.Command("git", "remote", "get-url", "origin").Output()
	if err == nil {
		remote := strings.TrimSpace(string(out))

		// SSH: git@gitlab.com:group/project.git
		if idx := strings.LastIndex(remote, ":"); idx != -1 && !strings.Contains(remote[:idx], "/") {
			slug := remote[idx+1:]
			slug = strings.TrimSuffix(slug, ".git")
			if strings.Contains(slug, "/") {
				return slug
			}
		}

		// HTTPS: https://gitlab.com/group/project.git
		if u, err := url.Parse(remote); err == nil && u.Path != "" {
			slug := strings.TrimPrefix(u.Path, "/")
			slug = strings.TrimSuffix(slug, ".git")
			if strings.Contains(slug, "/") {
				return slug
			}
		}
	}

	// Fallback: directory name
	dir, err := os.Getwd()
	if err != nil {
		return "unknown"
	}
	return filepath.Base(dir)
}

// --- find project root ---

func findRoot() string {
	// 1. Build-time embedded path
	if projectRoot != "" {
		return projectRoot
	}
	// 2. HH_HOME env var
	if v := os.Getenv("HH_HOME"); v != "" {
		return v
	}
	// 3. Relative to binary location
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for _, rel := range []string{".", "../..", ".."} {
			candidate := filepath.Join(dir, rel)
			if abs, err := filepath.Abs(candidate); err == nil {
				if _, err := os.Stat(filepath.Join(abs, "src", "webhook-channel.ts")); err == nil {
					return abs
				}
			}
		}
	}
	// 4. Relative to cwd
	if abs, err := filepath.Abs("."); err == nil {
		if _, err := os.Stat(filepath.Join(abs, "src", "webhook-channel.ts")); err == nil {
			return abs
		}
	}
	return "."
}

func channelPath() string {
	return filepath.Join(findRoot(), "src", "webhook-channel.ts")
}

func routerPath() string {
	return filepath.Join(findRoot(), "src", "webhook-router.ts")
}

// --- Commands ---

func cmdInit() {
	slug := getFlag("slug")
	if slug == "" {
		slug = detectSlug()
	}
	routerURL := getFlag("router-url")
	if routerURL == "" {
		routerURL = defaultRouterURL
	}

	mcpPath := filepath.Join(".", ".mcp.json")
	chPath := channelPath()

	// Read existing config
	config := map[string]interface{}{}
	if data, err := os.ReadFile(mcpPath); err == nil {
		if err := json.Unmarshal(data, &config); err != nil {
			fmt.Fprintln(os.Stderr, "Error: existing .mcp.json is not valid JSON")
			os.Exit(1)
		}
	}

	servers, ok := config["mcpServers"].(map[string]interface{})
	if !ok {
		servers = map[string]interface{}{}
	}

	servers["webhook-channel"] = map[string]interface{}{
		"command": "npx",
		"args":    []string{"tsx", chPath},
		"env": map[string]string{
			"PROJECT_SLUG": slug,
			"ROUTER_URL":   routerURL,
		},
	}
	config["mcpServers"] = servers

	out, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling JSON: %v\n", err)
		os.Exit(1)
	}

	if err := os.WriteFile(mcpPath, append(out, '\n'), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing .mcp.json: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Initialized HookHerald for %s in .mcp.json\n", slug)
	fmt.Printf("  Channel: %s\n", chPath)
	fmt.Printf("  Router:  %s\n", routerURL)
}

func cmdStatus() {
	routerURL := getFlag("router-url")
	if routerURL == "" {
		routerURL = defaultRouterURL
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(routerURL + "/api/sessions")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Router not reachable at %s\n", routerURL)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		fmt.Fprintf(os.Stderr, "Router returned %d\n", resp.StatusCode)
		os.Exit(1)
	}

	var sessions []struct {
		Slug        string  `json:"slug"`
		Port        int     `json:"port"`
		Status      string  `json:"status"`
		EventCount  int     `json:"eventCount"`
		ErrorCount  int     `json:"errorCount"`
		LastEventAt *string `json:"lastEventAt"`
	}

	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &sessions); err != nil {
		fmt.Fprintf(os.Stderr, "Invalid response: %v\n", err)
		os.Exit(1)
	}

	if len(sessions) == 0 {
		fmt.Println("No active sessions")
		return
	}

	fmt.Printf("%-30s %-8s %-10s %-10s %-10s %s\n", "SLUG", "PORT", "STATUS", "EVENTS", "ERRORS", "LAST EVENT")
	fmt.Println(strings.Repeat("-", 88))

	for _, s := range sessions {
		lastEvent := "never"
		if s.LastEventAt != nil {
			lastEvent = timeAgo(*s.LastEventAt)
		}
		fmt.Printf("%-30s %-8d %-10s %-10d %-10d %s\n",
			s.Slug, s.Port, s.Status, s.EventCount, s.ErrorCount, lastEvent)
	}
}

func cmdKill() {
	if len(os.Args) < 3 || strings.HasPrefix(os.Args[2], "--") {
		fmt.Fprintln(os.Stderr, "Usage: hh kill <slug>")
		os.Exit(1)
	}
	slug := os.Args[2]

	routerURL := getFlag("router-url")
	if routerURL == "" {
		routerURL = defaultRouterURL
	}

	payload, _ := json.Marshal(map[string]string{"project_slug": slug})
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(routerURL+"/api/kill", "application/json", bytes.NewReader(payload))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Router not reachable at %s\n", routerURL)
		os.Exit(1)
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	body, _ := io.ReadAll(resp.Body)
	json.Unmarshal(body, &result)

	if resp.StatusCode != 200 {
		if e, ok := result["error"]; ok {
			fmt.Fprintf(os.Stderr, "Error: %v\n", e)
		} else {
			fmt.Fprintf(os.Stderr, "Error: status %d\n", resp.StatusCode)
		}
		os.Exit(1)
	}

	fmt.Printf("Killed session: %s (port %v, %v events)\n",
		result["slug"], result["port"], result["eventCount"])
}

func cmdRouter() {
	port := getFlag("port")
	if port == "" {
		port = envOrDefault("ROUTER_PORT", defaultPort)
	}
	secret := getFlag("secret")
	if secret == "" {
		secret = envOrDefault("WEBHOOK_SECRET", defaultSecret)
	}

	rPath := routerPath()

	cmd := exec.Command("npx", "tsx", rPath)
	cmd.Env = append(os.Environ(),
		"ROUTER_PORT="+port,
		"WEBHOOK_SECRET="+secret,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	// Forward signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start router: %v\n", err)
		os.Exit(1)
	}

	go func() {
		sig := <-sigCh
		cmd.Process.Signal(sig)
	}()

	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		os.Exit(1)
	}
}

// --- Helpers ---

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func timeAgo(iso string) string {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		t, err = time.Parse("2006-01-02T15:04:05.000Z", iso)
		if err != nil {
			return iso
		}
	}
	diff := int(time.Since(t).Seconds())
	if diff < 5 {
		return "just now"
	}
	if diff < 60 {
		return fmt.Sprintf("%ds ago", diff)
	}
	if diff < 3600 {
		return fmt.Sprintf("%dm ago", diff/60)
	}
	if diff < 86400 {
		return fmt.Sprintf("%dh ago", diff/3600)
	}
	return fmt.Sprintf("%dd ago", diff/86400)
}
