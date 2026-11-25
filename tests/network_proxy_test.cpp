#include "dimension/network_proxy.hpp"

#include <cstdlib>
#include <iostream>
#include <string>

using namespace dimension;

namespace {

int g_checks = 0;

void check(bool cond, const char* msg) {
    ++g_checks;
    if (!cond) {
        std::cerr << "FAIL: " << msg << "\n";
        std::exit(1);
    }
}

} // namespace

int main() {
    // 1. Proxy URL normalization & validation
    check(normalize_proxy_url("127.0.0.1:10808") == "http://127.0.0.1:10808",
          "Bare host:port normalizes to http://");
    check(normalize_proxy_url("http=127.0.0.1:7890;https=127.0.0.1:7891") == "http://127.0.0.1:7891",
          "Windows multi-protocol ProxyServer prefers https endpoint");
    check(normalize_proxy_url("socks5://127.0.0.1:10808/") == "socks5://127.0.0.1:10808",
          "Trailing slash stripped cleanly");
    check(validate_global_proxy_url("http://127.0.0.1:10808").empty(),
          "Valid HTTP proxy URL passes validation");
    check(validate_global_proxy_url("127.0.0.1:7890").empty(),
          "Bare host:port passes validation");
    check(validate_global_proxy_url("socks5://192.168.1.10:1080").empty(),
          "Valid SOCKS5 proxy URL passes validation");
    check(!validate_global_proxy_url("").empty(),
          "Empty global proxy URL rejected");
    check(!validate_global_proxy_url("ftp://127.0.0.1:21").empty(),
          "Unsupported scheme rejected");
    check(!validate_global_proxy_url("http://127.0.0.1").empty(),
          "Missing port rejected");
    check(!validate_global_proxy_url("http://127.0.0.1:99999").empty(),
          "Out-of-range port rejected");

    // 2. Bypass list & WinHTTP spec helpers
    const std::string csv = normalize_no_proxy_csv("*.local;10.0.0.1, localhost");
    check(csv.find("localhost") != std::string::npos && csv.find("127.0.0.1") != std::string::npos &&
          csv.find("::1") != std::string::npos && csv.find("*.local") != std::string::npos &&
          csv.find("10.0.0.1") != std::string::npos,
          "normalize_no_proxy_csv preserves custom hosts and enforces loopback safety");
    const std::string wh_bypass = to_winhttp_bypass_spec(csv);
    check(wh_bypass.find("<local>") != std::string::npos && wh_bypass.find(';') != std::string::npos,
          "to_winhttp_bypass_spec formats semicolon list with <local>");
    check(to_winhttp_proxy_spec("http://127.0.0.1:10808") == "127.0.0.1:10808",
          "to_winhttp_proxy_spec extracts host:port for HTTP proxy");
    check(to_winhttp_proxy_spec("socks5://127.0.0.1:10808").empty(),
          "to_winhttp_proxy_spec safely skips unsupported socks5 scheme for WinHTTP");
    check(is_loopback_proxy_url("http://127.0.0.1:10808") && is_loopback_proxy_url("http://localhost:7890"),
          "Loopback proxy URLs accurately detected");
    check(!is_loopback_proxy_url("http://192.168.1.8:7890"),
          "LAN proxy URLs recognized as reachable from WSL sandbox");

    // 3. Resolution across auto / global / none modes
    SystemProxyInfo sys_on;
    sys_on.enabled = true;
    sys_on.source = "windows-system";
    sys_on.proxy_url = "http://127.0.0.1:10808";
    sys_on.http_proxy = sys_on.proxy_url;
    sys_on.https_proxy = sys_on.proxy_url;
    sys_on.bypass = "localhost,127.0.0.1,::1";

    {
        NetworkProxySettings s;
        s.mode = "auto";
        const auto r = resolve_network_proxy(s, sys_on);
        check(r.mode == "auto" && r.use_proxy && r.use_winhttp_auto &&
              r.active_proxy_url == "http://127.0.0.1:10808" && r.sandbox_proxy_url.empty(),
              "Auto mode reads Windows system proxy and keeps loopback out of WSL NAT");
    }
    {
        NetworkProxySettings s;
        s.mode = "global";
        s.proxy_url = "http://192.168.1.50:7890";
        s.apply_to_sandbox = true;
        const auto r = resolve_network_proxy(s, sys_on);
        check(r.mode == "global" && r.use_proxy && !r.use_winhttp_auto &&
              r.winhttp_proxy_spec == "192.168.1.50:7890" &&
              r.sandbox_proxy_url == "http://192.168.1.50:7890",
              "Global mode distributes LAN proxy to both WinHTTP and WSL sandbox");
    }
    {
        NetworkProxySettings s;
        s.mode = "none";
        s.proxy_url = "http://192.168.1.50:7890";
        const auto r = resolve_network_proxy(s, sys_on);
        check(r.mode == "none" && !r.use_proxy && !r.use_winhttp_auto &&
              r.active_proxy_url.empty() && r.sandbox_proxy_url.empty(),
              "None mode forces direct connection and clears all active proxies");
    }

    // 4. Generation bumps on apply and host env overrides reflect none vs global cleanly
    const auto g0 = network_proxy_generation();
    NetworkProxySettings s_none;
    s_none.mode = "none";
    (void)apply_network_proxy_settings(s_none);
    const auto g1 = network_proxy_generation();
    check(g1 == g0 + 1, "apply_network_proxy_settings bumps generation for hot WinHTTP reload");
    const auto env_none = build_host_proxy_env_overrides();
    bool all_cleared = !env_none.empty();
    for (const auto& [k, v] : env_none) {
        if (!v.empty()) all_cleared = false;
    }
    check(all_cleared, "None mode produces explicit empty proxy overrides to clear inherited env");

    NetworkProxySettings s_global;
    s_global.mode = "global";
    s_global.proxy_url = "http://127.0.0.1:10808";
    (void)apply_network_proxy_settings(s_global);
    const auto env_glob = build_host_proxy_env_overrides();
    bool saw_https = false;
    for (const auto& [k, v] : env_glob) {
        if (k == "HTTPS_PROXY" && v == "http://127.0.0.1:10808") saw_https = true;
    }
    check(saw_https, "Global mode distributes HTTPS_PROXY to child host CLIs");

    // Restore clean auto mode before exiting
    NetworkProxySettings s_auto;
    s_auto.mode = "auto";
    (void)apply_network_proxy_settings(s_auto);

    std::cout << "network_proxy: " << g_checks << " checks passed\n";
    return 0;
}
