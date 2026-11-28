#pragma once

#include "dimension/json.hpp"

#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <winhttp.h>
#endif

namespace dimension {

// Global network proxy configuration persisted in DimensionAgent metadata.
// mode:
//   "auto"   - Automatically detect and distribute the Windows system / OS proxy settings.
//   "global" - Force all network traffic and child CLI processes through custom proxy_url.
//   "none"   - Direct connection; explicitly bypass system proxy and clear proxy env vars.
struct NetworkProxySettings {
    std::string mode = "auto";
    std::string proxy_url;                              // Used when mode == "global"
    std::string bypass = "localhost,127.0.0.1,::1";     // Comma/semicolon separated no-proxy hosts
    bool apply_to_sandbox = true;                       // Forward reachable (non-loopback) proxy into WSL sandbox

    Json to_json() const;
    static NetworkProxySettings from_json(const Json& j);
};

// Snapshot of the computer's OS proxy configuration (Windows Internet Settings / WinHTTP / Env / Local probe).
struct SystemProxyInfo {
    bool enabled = false;
    bool auto_detect = false;
    std::string auto_config_url; // PAC URL if configured
    std::string source;          // "windows-system" | "windows-registry" | "windows-pac" | "environment" | "local-probe" | "none"
    std::string proxy_url;       // Primary normalized URL (e.g. "http://127.0.0.1:10808")
    std::string http_proxy;
    std::string https_proxy;
    std::string bypass;
    std::vector<std::string> detected_local_proxies; // Active local proxies verified by HTTP CONNECT / SOCKS5 handshake

    Json to_json() const;
};

// Resolved runtime proxy decision used across WinHTTP, host CLIs, downloaders, and WSL sandbox.
struct ResolvedNetworkProxy {
    std::string mode = "auto";           // "auto" | "global" | "none"
    bool use_proxy = false;
    bool use_winhttp_auto = false;       // True when mode == "auto" and Windows WinHTTP automatic proxy handles it
    std::string active_proxy_url;        // Normalized URL for curl / env vars (e.g. "http://127.0.0.1:10808")
    std::string winhttp_proxy_spec;      // WinHTTP lpszProxy syntax (e.g. "127.0.0.1:10808")
    std::string winhttp_bypass_spec;     // WinHTTP lpszProxyBypass syntax (semicolon separated + <local>)
    std::string no_proxy_csv;            // Standard comma-separated NO_PROXY list
    std::string sandbox_proxy_url;       // Reachable proxy URL safe to inject into WSL NAT sandbox (empty if loopback)
    std::string summary;                 // Concise Chinese summary for UI display
    SystemProxyInfo system_info;

    Json to_json() const;
};

// Normalizes user-entered or OS-reported proxy strings into a clean URL (e.g. "127.0.0.1:10808" -> "http://127.0.0.1:10808").
// Also parses Windows multi-protocol ProxyServer strings ("http=127.0.0.1:7890;https=127.0.0.1:7890").
std::string normalize_proxy_url(std::string_view raw);

// Validates a proxy URL for "global" mode; returns empty string if valid, otherwise a Chinese error message.
std::string validate_global_proxy_url(std::string_view raw);

// Normalizes a comma/semicolon bypass list into standard NO_PROXY CSV (always ensuring loopback safety).
std::string normalize_no_proxy_csv(std::string_view raw);

// Converts a bypass list to WinHTTP semicolon-separated format with <local>.
std::string to_winhttp_bypass_spec(std::string_view raw_csv);

// Extracts WinHTTP named proxy host:port spec from a normalized proxy URL (empty for unsupported schemes like socks5).
std::string to_winhttp_proxy_spec(std::string_view normalized_url);

// Returns true if the URL host refers to localhost / 127.0.0.1 / ::1 (unreachable directly from WSL2 NAT).
bool is_loopback_proxy_url(std::string_view normalized_url);

// Concurrently probes localhost candidate proxy ports (priority_urls first, then common desktop proxy ports)
// using fast protocol-level HTTP CONNECT and SOCKS5 handshakes so non-proxy web servers are never misidentified.
std::vector<std::string> probe_active_local_proxies(const std::vector<std::string>& priority_urls = {},
                                                    bool force_refresh = false);

// Probes the computer's current OS proxy settings (Windows Internet Settings registry, WinHTTP IE config,
// env fallback, and active local proxy auto-detection).
SystemProxyInfo detect_system_proxy_info(bool force_probe = false);

// Pure resolver (testable without touching global state or real registry).
ResolvedNetworkProxy resolve_network_proxy(const NetworkProxySettings& settings,
                                           const SystemProxyInfo& system_info);

// Global process-wide configuration accessors (thread-safe).
NetworkProxySettings get_network_proxy_settings();
ResolvedNetworkProxy resolve_active_network_proxy();
std::uint64_t network_proxy_generation();

// Applies new global proxy settings, increments generation (triggering WinHTTP session hot-reload),
// synchronizes the current process's HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY environment variables,
// and ensures/stops the built-in WSL loopback proxy bridge as needed.
ResolvedNetworkProxy apply_network_proxy_settings(const NetworkProxySettings& settings,
                                                  bool force_probe = false);

// Registers the WSL executable & sandbox distribution so loopback host proxies (e.g. 127.0.0.1:10808)
// are transparently bridged into WSL2 NAT via a stdio-multiplexed tunnel without firewall/Allow-LAN changes.
void configure_network_proxy_sandbox(const std::filesystem::path& wsl_executable,
                                     const std::string& sandbox_distribution);

// Cleanly stops the built-in WSL proxy bridge (called on application shutdown; also covered by static destructor).
void shutdown_network_proxy_bridge();

// Builds environment variable overrides for child host CLI processes.
// When mode == "none" (or no proxy active), entries carry empty values so build_environment_block removes/clears them.
std::vector<std::pair<std::string, std::string>> build_host_proxy_env_overrides();

// Builds environment variable overrides safe to pass into WSL Bubblewrap sandbox (--setenv).
std::vector<std::pair<std::string, std::string>> build_sandbox_proxy_env_overrides();

#ifdef _WIN32
// Opens a WinHTTP session configured according to the currently active global/auto/none proxy policy
// (or a thread-local per-Bot pinned proxy override when executing on behalf of an Isolated Bot Pool member).
HINTERNET open_configured_winhttp_session(const wchar_t* user_agent, DWORD flags);
#endif

// Thread-local RAII proxy override for Isolated Bot Pool HTTP requests (e.g., model API calls).
// Never touches global proxy state; non-isolated Bots never activate this guard.
class ScopedBotProxyOverride {
public:
    ScopedBotProxyOverride(bool active,
                           std::string egress_mode,
                           std::string proxy_url,
                           bool fail_closed = true);
    ~ScopedBotProxyOverride();
    ScopedBotProxyOverride(const ScopedBotProxyOverride&) = delete;
    ScopedBotProxyOverride& operator=(const ScopedBotProxyOverride&) = delete;

private:
    bool active_ = false;
    bool prev_active_ = false;
    std::string prev_mode_;
    std::string prev_url_;
    bool prev_fail_closed_ = true;
};

} // namespace dimension
