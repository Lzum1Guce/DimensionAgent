#include "dimension/network_proxy.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <mutex>
#include <set>
#include <sstream>

namespace dimension {
namespace {

using O = Json::Object;

std::mutex& state_mutex() {
    static std::mutex m;
    return m;
}

NetworkProxySettings& global_settings() {
    static NetworkProxySettings s;
    return s;
}

std::atomic<std::uint64_t> g_proxy_generation{1};

std::string trim_copy(std::string_view s) {
    std::size_t b = 0;
    std::size_t e = s.size();
    while (b < e && static_cast<unsigned char>(s[b]) <= 0x20U) ++b;
    while (e > b && static_cast<unsigned char>(s[e - 1]) <= 0x20U) --e;
    return std::string(s.substr(b, e - b));
}

std::string ascii_lower(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

std::string jstr(const Json& j, std::string_view key, std::string def = {}) {
    if (!j.is_object()) return def;
    const auto* p = j.find(key);
    return (p && p->is_string()) ? p->as_string() : def;
}

bool jbool(const Json& j, std::string_view key, bool def = false) {
    if (!j.is_object()) return def;
    const auto* p = j.find(key);
    return (p && p->is_bool()) ? p->as_bool() : def;
}

#ifdef _WIN32
std::wstring utf8_to_wide(std::string_view s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (n <= 0) return {};
    std::wstring w(static_cast<std::size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

std::string wide_to_utf8(std::wstring_view w) {
    if (w.empty()) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    if (n <= 0) return {};
    std::string s(static_cast<std::size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}

std::string env_var_utf8(const wchar_t* name) {
    const DWORD need = GetEnvironmentVariableW(name, nullptr, 0);
    if (need == 0) return {};
    std::wstring buf(need, L'\0');
    const DWORD got = GetEnvironmentVariableW(name, buf.data(), need);
    if (got == 0) return {};
    buf.resize(got);
    return wide_to_utf8(buf);
}

// Snapshot the startup process environment once BEFORE DimensionAgent mutates its own env vars,
// so switching from "none" back to "auto" never loses original process-level proxy env vars.
struct StartupEnvProxySnapshot {
    std::string http_proxy;
    std::string https_proxy;
    std::string all_proxy;
    std::string no_proxy;
};

const StartupEnvProxySnapshot& startup_env_proxy() {
    static const StartupEnvProxySnapshot snap = []() {
        StartupEnvProxySnapshot s;
        s.https_proxy = trim_copy(env_var_utf8(L"HTTPS_PROXY"));
        if (s.https_proxy.empty()) s.https_proxy = trim_copy(env_var_utf8(L"https_proxy"));
        s.http_proxy = trim_copy(env_var_utf8(L"HTTP_PROXY"));
        if (s.http_proxy.empty()) s.http_proxy = trim_copy(env_var_utf8(L"http_proxy"));
        s.all_proxy = trim_copy(env_var_utf8(L"ALL_PROXY"));
        if (s.all_proxy.empty()) s.all_proxy = trim_copy(env_var_utf8(L"all_proxy"));
        s.no_proxy = trim_copy(env_var_utf8(L"NO_PROXY"));
        if (s.no_proxy.empty()) s.no_proxy = trim_copy(env_var_utf8(L"no_proxy"));
        return s;
    }();
    return snap;
}

void set_or_clear_env(const wchar_t* name, std::string_view val) {
    if (val.empty()) {
        SetEnvironmentVariableW(name, nullptr);
    } else {
        const std::wstring w = utf8_to_wide(val);
        SetEnvironmentVariableW(name, w.c_str());
    }
}

void sync_process_env_for_resolved(const ResolvedNetworkProxy& resolved) {
    if (resolved.use_proxy && !resolved.active_proxy_url.empty()) {
        set_or_clear_env(L"HTTP_PROXY", resolved.active_proxy_url);
        set_or_clear_env(L"HTTPS_PROXY", resolved.active_proxy_url);
        set_or_clear_env(L"ALL_PROXY", resolved.active_proxy_url);
        set_or_clear_env(L"http_proxy", resolved.active_proxy_url);
        set_or_clear_env(L"https_proxy", resolved.active_proxy_url);
        set_or_clear_env(L"all_proxy", resolved.active_proxy_url);
        set_or_clear_env(L"NO_PROXY", resolved.no_proxy_csv);
        set_or_clear_env(L"no_proxy", resolved.no_proxy_csv);
    } else {
        set_or_clear_env(L"HTTP_PROXY", "");
        set_or_clear_env(L"HTTPS_PROXY", "");
        set_or_clear_env(L"ALL_PROXY", "");
        set_or_clear_env(L"http_proxy", "");
        set_or_clear_env(L"https_proxy", "");
        set_or_clear_env(L"all_proxy", "");
        set_or_clear_env(L"NO_PROXY", "");
        set_or_clear_env(L"no_proxy", "");
    }
}
#endif

// Parses a Windows multi-protocol ProxyServer string such as:
//   "127.0.0.1:10808"
//   "http=127.0.0.1:7890;https=127.0.0.1:7890"
//   "socks=127.0.0.1:10808"
void parse_windows_proxy_server_string(std::string_view raw,
                                       std::string& out_http,
                                       std::string& out_https,
                                       std::string& out_primary) {
    out_http.clear();
    out_https.clear();
    out_primary.clear();
    const std::string s = trim_copy(raw);
    if (s.empty()) return;

    if (s.find('=') == std::string::npos) {
        const std::string norm = normalize_proxy_url(s);
        out_http = norm;
        out_https = norm;
        out_primary = norm;
        return;
    }

    std::string socks_fallback;
    std::size_t pos = 0;
    while (pos < s.size()) {
        const auto sep = s.find_first_of(";,", pos);
        const auto part = trim_copy(s.substr(pos, sep == std::string::npos ? std::string::npos : sep - pos));
        const auto eq = part.find('=');
        if (eq != std::string::npos) {
            const auto scheme = ascii_lower(trim_copy(part.substr(0, eq)));
            const auto val = trim_copy(part.substr(eq + 1));
            if (!val.empty()) {
                if (scheme == "http") {
                    out_http = normalize_proxy_url(val);
                } else if (scheme == "https") {
                    out_https = normalize_proxy_url(val);
                } else if (scheme == "socks" || scheme == "socks5" || scheme == "socks5h") {
                    if (val.find("://") == std::string::npos) socks_fallback = "socks5://" + val;
                    else socks_fallback = val;
                }
            }
        }
        if (sep == std::string::npos) break;
        pos = sep + 1;
    }

    if (!out_https.empty()) out_primary = out_https;
    else if (!out_http.empty()) out_primary = out_http;
    else if (!socks_fallback.empty()) out_primary = socks_fallback;

    if (out_http.empty()) out_http = out_primary;
    if (out_https.empty()) out_https = out_primary;
}

std::string extract_host_from_url(std::string_view url) {
    std::string s = trim_copy(url);
    const auto scheme_end = s.find("://");
    if (scheme_end != std::string::npos) {
        s = s.substr(scheme_end + 3U);
    }
    const auto slash = s.find('/');
    if (slash != std::string::npos) s.resize(slash);
    const auto at = s.rfind('@');
    if (at != std::string::npos) s = s.substr(at + 1U);
    if (s.empty()) return {};
    if (s.front() == '[') {
        const auto rb = s.find(']');
        if (rb != std::string::npos) return ascii_lower(s.substr(1U, rb - 1U));
        return {};
    }
    const auto colon = s.rfind(':');
    if (colon != std::string::npos) s.resize(colon);
    return ascii_lower(s);
}

} // namespace

Json NetworkProxySettings::to_json() const {
    return O{
        {"mode", mode},
        {"proxyUrl", proxy_url},
        {"bypass", bypass},
        {"applyToSandbox", apply_to_sandbox}
    };
}

NetworkProxySettings NetworkProxySettings::from_json(const Json& j) {
    NetworkProxySettings out;
    if (!j.is_object()) return out;
    const std::string m = ascii_lower(trim_copy(jstr(j, "mode", "auto")));
    if (m == "global" || m == "none" || m == "auto") {
        out.mode = m;
    }
    out.proxy_url = normalize_proxy_url(jstr(j, "proxyUrl"));
    const std::string raw_bypass = jstr(j, "bypass");
    out.bypass = raw_bypass.empty() ? std::string("localhost,127.0.0.1,::1") : normalize_no_proxy_csv(raw_bypass);
    out.apply_to_sandbox = jbool(j, "applyToSandbox", true);
    return out;
}

Json SystemProxyInfo::to_json() const {
    return O{
        {"enabled", enabled},
        {"autoDetect", auto_detect},
        {"autoConfigUrl", auto_config_url},
        {"source", source},
        {"proxyUrl", proxy_url},
        {"httpProxy", http_proxy},
        {"httpsProxy", https_proxy},
        {"bypass", bypass}
    };
}

Json ResolvedNetworkProxy::to_json() const {
    return O{
        {"mode", mode},
        {"useProxy", use_proxy},
        {"useWinHttpAuto", use_winhttp_auto},
        {"activeProxyUrl", active_proxy_url},
        {"winhttpProxySpec", winhttp_proxy_spec},
        {"noProxyCsv", no_proxy_csv},
        {"sandboxProxyUrl", sandbox_proxy_url},
        {"summary", summary}
    };
}

std::string normalize_proxy_url(std::string_view raw) {
    std::string s = trim_copy(raw);
    if (s.empty()) return {};
    // Strip control chars / stray trailing slash
    for (unsigned char c : s) {
        if (c < 0x21U || c == 0x7FU) return {};
    }
    if (s.find('=') != std::string::npos && s.find("://") == std::string::npos) {
        std::string h, hs, prim;
        parse_windows_proxy_server_string(s, h, hs, prim);
        return prim;
    }
    if (s.find("://") == std::string::npos) {
        s = "http://" + s;
    }
    while (s.size() > 8U && s.back() == '/') s.pop_back();
    return s;
}

std::string validate_global_proxy_url(std::string_view raw) {
    const std::string norm = normalize_proxy_url(raw);
    if (norm.empty()) {
        return "全局代理模式下请填写有效的代理地址（例如 http://127.0.0.1:10808）";
    }
    const auto sep = norm.find("://");
    if (sep == std::string::npos) {
        return "代理地址格式无效，请使用 http://host:port 或 socks5://host:port";
    }
    const std::string scheme = ascii_lower(norm.substr(0, sep));
    if (scheme != "http" && scheme != "https" && scheme != "socks5" && scheme != "socks5h") {
        return "仅支持 http://、https://、socks5:// 或 socks5h:// 代理协议";
    }
    const std::string rest = norm.substr(sep + 3U);
    if (rest.empty()) {
        return "代理地址缺少主机与端口";
    }
    const std::string host = extract_host_from_url(norm);
    if (host.empty()) {
        return "代理地址中的主机名无效";
    }
    // Verify port presence & valid range 1..65535
    std::string authority = rest;
    if (const auto slash = authority.find('/'); slash != std::string::npos) authority.resize(slash);
    if (const auto at = authority.rfind('@'); at != std::string::npos) authority = authority.substr(at + 1U);
    std::size_t colon = std::string::npos;
    if (!authority.empty() && authority.front() == '[') {
        const auto rb = authority.find(']');
        if (rb != std::string::npos && rb + 1U < authority.size() && authority[rb + 1U] == ':') {
            colon = rb + 1U;
        }
    } else {
        colon = authority.rfind(':');
    }
    if (colon == std::string::npos || colon + 1U >= authority.size()) {
        return "请填写完整的代理端口（例如 http://127.0.0.1:10808）";
    }
    const std::string port_str = authority.substr(colon + 1U);
    if (port_str.size() > 5U || !std::all_of(port_str.begin(), port_str.end(),
                                             [](unsigned char c) { return c >= '0' && c <= '9'; })) {
        return "代理端口必须是 1~65535 的数字";
    }
    const int port = std::stoi(port_str);
    if (port < 1 || port > 65535) {
        return "代理端口必须在 1~65535 之间";
    }
    return {};
}

std::string normalize_no_proxy_csv(std::string_view raw) {
    std::vector<std::string> items;
    std::set<std::string> seen;
    auto push_item = [&](std::string_view token) {
        std::string t = trim_copy(token);
        if (t.empty()) return;
        const std::string low = ascii_lower(t);
        if (low == "<local>") return;
        if (seen.insert(low).second) {
            items.push_back(t);
        }
    };
    push_item("localhost");
    push_item("127.0.0.1");
    push_item("::1");

    std::size_t pos = 0;
    while (pos < raw.size()) {
        const auto sep = raw.find_first_of(",; \t\r\n", pos);
        const auto piece = raw.substr(pos, sep == std::string_view::npos ? std::string_view::npos : sep - pos);
        push_item(piece);
        if (sep == std::string_view::npos) break;
        pos = sep + 1U;
    }

    std::ostringstream oss;
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (i > 0) oss << ',';
        oss << items[i];
    }
    return oss.str();
}

std::string to_winhttp_bypass_spec(std::string_view raw_csv) {
    const std::string norm = normalize_no_proxy_csv(raw_csv);
    std::string out = norm;
    std::replace(out.begin(), out.end(), ',', ';');
    if (!out.empty()) out += ";";
    out += "<local>";
    return out;
}

std::string to_winhttp_proxy_spec(std::string_view normalized_url) {
    const std::string norm = normalize_proxy_url(normalized_url);
    const auto sep = norm.find("://");
    if (sep == std::string::npos) return {};
    const std::string scheme = ascii_lower(norm.substr(0, sep));
    if (scheme != "http" && scheme != "https") {
        // WinHTTP named proxy only supports HTTP/HTTPS proxy tunnels natively.
        return {};
    }
    std::string authority = norm.substr(sep + 3U);
    if (const auto slash = authority.find('/'); slash != std::string::npos) authority.resize(slash);
    if (const auto at = authority.rfind('@'); at != std::string::npos) authority = authority.substr(at + 1U);
    return authority;
}

bool is_loopback_proxy_url(std::string_view normalized_url) {
    const std::string host = extract_host_from_url(normalized_url);
    return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "0.0.0.0" || host.starts_with("127.");
}

SystemProxyInfo detect_system_proxy_info() {
    SystemProxyInfo info;
    info.source = "none";
#ifdef _WIN32
    // Ensure startup environment snapshot is captured before any process-env mutation.
    const auto& init_env = startup_env_proxy();

    // 1. Official WinHTTP IE / Windows System Proxy API (reads manual proxy + PAC + WPAD auto-detect).
    WINHTTP_CURRENT_USER_IE_PROXY_CONFIG ie_cfg{};
    if (WinHttpGetIEProxyConfigForCurrentUser(&ie_cfg)) {
        info.auto_detect = (ie_cfg.fAutoDetect != FALSE);
        if (ie_cfg.lpszAutoConfigUrl) {
            info.auto_config_url = trim_copy(wide_to_utf8(ie_cfg.lpszAutoConfigUrl));
            GlobalFree(ie_cfg.lpszAutoConfigUrl);
        }
        if (ie_cfg.lpszProxy) {
            const std::string raw_proxy = trim_copy(wide_to_utf8(ie_cfg.lpszProxy));
            GlobalFree(ie_cfg.lpszProxy);
            if (!raw_proxy.empty()) {
                parse_windows_proxy_server_string(raw_proxy, info.http_proxy, info.https_proxy, info.proxy_url);
                if (!info.proxy_url.empty()) {
                    info.enabled = true;
                    info.source = "windows-system";
                }
            }
        }
        if (ie_cfg.lpszProxyBypass) {
            info.bypass = normalize_no_proxy_csv(wide_to_utf8(ie_cfg.lpszProxyBypass));
            GlobalFree(ie_cfg.lpszProxyBypass);
        }
        if (!info.enabled && !info.auto_config_url.empty()) {
            info.enabled = true;
            info.source = "windows-pac";
        }
    }

    // 2. Direct HKCU Internet Settings fallback if WinHttpGetIEProxyConfigForCurrentUser missed manual settings.
    if (!info.enabled) {
        HKEY hkey = nullptr;
        if (RegOpenKeyExW(HKEY_CURRENT_USER,
                          L"Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                          0, KEY_READ, &hkey) == ERROR_SUCCESS) {
            DWORD enabled = 0;
            DWORD sz = sizeof(enabled);
            if (RegQueryValueExW(hkey, L"ProxyEnable", nullptr, nullptr,
                                 reinterpret_cast<LPBYTE>(&enabled), &sz) == ERROR_SUCCESS && enabled == 1) {
                wchar_t buf[1024]{};
                DWORD bsz = sizeof(buf);
                if (RegQueryValueExW(hkey, L"ProxyServer", nullptr, nullptr,
                                     reinterpret_cast<LPBYTE>(buf), &bsz) == ERROR_SUCCESS && buf[0] != L'\0') {
                    parse_windows_proxy_server_string(wide_to_utf8(buf), info.http_proxy, info.https_proxy, info.proxy_url);
                    if (!info.proxy_url.empty()) {
                        info.enabled = true;
                        info.source = "windows-registry";
                    }
                }
                wchar_t bypass_buf[2048]{};
                DWORD bp_sz = sizeof(bypass_buf);
                if (RegQueryValueExW(hkey, L"ProxyOverride", nullptr, nullptr,
                                     reinterpret_cast<LPBYTE>(bypass_buf), &bp_sz) == ERROR_SUCCESS && bypass_buf[0] != L'\0') {
                    info.bypass = normalize_no_proxy_csv(wide_to_utf8(bypass_buf));
                }
            }
            RegCloseKey(hkey);
        }
    }

    // 3. Fallback to startup OS environment variables (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY).
    if (!info.enabled) {
        const std::string env_p = !init_env.https_proxy.empty() ? init_env.https_proxy
            : (!init_env.http_proxy.empty() ? init_env.http_proxy : init_env.all_proxy);
        if (!env_p.empty()) {
            const std::string norm = normalize_proxy_url(env_p);
            if (!norm.empty()) {
                info.enabled = true;
                info.source = "environment";
                info.proxy_url = norm;
                info.http_proxy = !init_env.http_proxy.empty() ? normalize_proxy_url(init_env.http_proxy) : norm;
                info.https_proxy = !init_env.https_proxy.empty() ? normalize_proxy_url(init_env.https_proxy) : norm;
                if (!init_env.no_proxy.empty()) {
                    info.bypass = normalize_no_proxy_csv(init_env.no_proxy);
                }
            }
        }
    }
#endif
    if (info.bypass.empty()) {
        info.bypass = "localhost,127.0.0.1,::1";
    }
    return info;
}

ResolvedNetworkProxy resolve_network_proxy(const NetworkProxySettings& settings,
                                           const SystemProxyInfo& system_info) {
    ResolvedNetworkProxy out;
    out.mode = (settings.mode == "global" || settings.mode == "none") ? settings.mode : std::string("auto");
    out.system_info = system_info;

    const std::string merged_bypass = normalize_no_proxy_csv(
        settings.bypass.empty() ? system_info.bypass : settings.bypass);
    out.no_proxy_csv = merged_bypass;
    out.winhttp_bypass_spec = to_winhttp_bypass_spec(merged_bypass);

    if (out.mode == "none") {
        out.use_proxy = false;
        out.use_winhttp_auto = false;
        out.summary = "无代理（全软件直连，已屏蔽系统代理与环境变量）";
        return out;
    }

    if (out.mode == "global") {
        const std::string norm = normalize_proxy_url(settings.proxy_url);
        if (!norm.empty()) {
            out.use_proxy = true;
            out.use_winhttp_auto = false;
            out.active_proxy_url = norm;
            out.winhttp_proxy_spec = to_winhttp_proxy_spec(norm);
            if (settings.apply_to_sandbox && !is_loopback_proxy_url(norm)) {
                out.sandbox_proxy_url = norm;
            }
            out.summary = "全局代理：" + norm;
        } else {
            out.use_proxy = false;
            out.use_winhttp_auto = false;
            out.summary = "全局代理未填写有效地址，当前暂以直连运行";
        }
        return out;
    }

    // mode == "auto"
    out.use_winhttp_auto = true;
    if (system_info.enabled && !system_info.proxy_url.empty()) {
        out.use_proxy = true;
        out.active_proxy_url = system_info.proxy_url;
        out.winhttp_proxy_spec = to_winhttp_proxy_spec(system_info.proxy_url);
        if (system_info.source == "environment") {
            // WinHTTP AUTOMATIC_PROXY ignores HTTP_PROXY env vars, so use NAMED_PROXY when sourced from env.
            out.use_winhttp_auto = false;
        }
        if (settings.apply_to_sandbox && !is_loopback_proxy_url(system_info.proxy_url)) {
            out.sandbox_proxy_url = system_info.proxy_url;
        }
        out.summary = "自动代理（已读取电脑系统代理：" + system_info.proxy_url + "）";
    } else if (system_info.enabled && !system_info.auto_config_url.empty()) {
        out.use_proxy = true;
        out.summary = "自动代理（跟随系统 PAC 脚本：" + system_info.auto_config_url + "）";
    } else if (system_info.auto_detect) {
        out.use_proxy = false;
        out.summary = "自动代理（跟随系统 WPAD 自动检测，当前未检测到手动代理）";
    } else {
        out.use_proxy = false;
        out.summary = "自动代理（当前电脑未开启系统代理，走直连）";
    }
    return out;
}

NetworkProxySettings get_network_proxy_settings() {
    std::lock_guard lk(state_mutex());
    return global_settings();
}

ResolvedNetworkProxy resolve_active_network_proxy() {
    NetworkProxySettings cur;
    {
        std::lock_guard lk(state_mutex());
        cur = global_settings();
    }
    // Always re-probe live OS proxy in auto mode so toggling Windows system proxy takes effect automatically!
    const SystemProxyInfo sys = detect_system_proxy_info();
    return resolve_network_proxy(cur, sys);
}

std::uint64_t network_proxy_generation() {
    return g_proxy_generation.load(std::memory_order_acquire);
}

ResolvedNetworkProxy apply_network_proxy_settings(const NetworkProxySettings& settings) {
#ifdef _WIN32
    // Capture original startup env vars before our first mutation.
    (void)startup_env_proxy();
#endif
    NetworkProxySettings clean = settings;
    if (clean.mode != "global" && clean.mode != "none") clean.mode = "auto";
    clean.proxy_url = normalize_proxy_url(clean.proxy_url);
    clean.bypass = normalize_no_proxy_csv(clean.bypass);
    {
        std::lock_guard lk(state_mutex());
        global_settings() = clean;
    }
    g_proxy_generation.fetch_add(1, std::memory_order_acq_rel);

    const SystemProxyInfo sys = detect_system_proxy_info();
    const ResolvedNetworkProxy resolved = resolve_network_proxy(clean, sys);
#ifdef _WIN32
    sync_process_env_for_resolved(resolved);
#endif
    return resolved;
}

std::vector<std::pair<std::string, std::string>> build_host_proxy_env_overrides() {
    const ResolvedNetworkProxy r = resolve_active_network_proxy();
    if (r.use_proxy && !r.active_proxy_url.empty()) {
        return {
            {"HTTP_PROXY", r.active_proxy_url},
            {"HTTPS_PROXY", r.active_proxy_url},
            {"ALL_PROXY", r.active_proxy_url},
            {"http_proxy", r.active_proxy_url},
            {"https_proxy", r.active_proxy_url},
            {"all_proxy", r.active_proxy_url},
            {"NO_PROXY", r.no_proxy_csv},
            {"no_proxy", r.no_proxy_csv}
        };
    }
    // Explicit empty values signal build_environment_block to strip inherited proxy env vars cleanly.
    return {
        {"HTTP_PROXY", ""},
        {"HTTPS_PROXY", ""},
        {"ALL_PROXY", ""},
        {"http_proxy", ""},
        {"https_proxy", ""},
        {"all_proxy", ""},
        {"NO_PROXY", ""},
        {"no_proxy", ""}
    };
}

std::vector<std::pair<std::string, std::string>> build_sandbox_proxy_env_overrides() {
    const ResolvedNetworkProxy r = resolve_active_network_proxy();
    if (!r.sandbox_proxy_url.empty()) {
        return {
            {"HTTP_PROXY", r.sandbox_proxy_url},
            {"HTTPS_PROXY", r.sandbox_proxy_url},
            {"ALL_PROXY", r.sandbox_proxy_url},
            {"http_proxy", r.sandbox_proxy_url},
            {"https_proxy", r.sandbox_proxy_url},
            {"all_proxy", r.sandbox_proxy_url},
            {"NO_PROXY", r.no_proxy_csv},
            {"no_proxy", r.no_proxy_csv}
        };
    }
    return {};
}

#ifdef _WIN32
HINTERNET open_configured_winhttp_session(const wchar_t* user_agent, DWORD flags) {
    const ResolvedNetworkProxy r = resolve_active_network_proxy();
    if (r.mode == "none") {
        return WinHttpOpen(user_agent, WINHTTP_ACCESS_TYPE_NO_PROXY,
                           WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, flags);
    }
    if (!r.use_winhttp_auto && r.use_proxy && !r.winhttp_proxy_spec.empty()) {
        const std::wstring wproxy = utf8_to_wide(r.winhttp_proxy_spec);
        const std::wstring wbypass = utf8_to_wide(r.winhttp_bypass_spec);
        return WinHttpOpen(user_agent, WINHTTP_ACCESS_TYPE_NAMED_PROXY,
                           wproxy.c_str(), wbypass.empty() ? WINHTTP_NO_PROXY_BYPASS : wbypass.c_str(), flags);
    }
    if (r.mode == "global" && !r.use_proxy) {
        return WinHttpOpen(user_agent, WINHTTP_ACCESS_TYPE_NO_PROXY,
                           WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, flags);
    }
    return WinHttpOpen(user_agent, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                       WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, flags);
}
#endif

} // namespace dimension
