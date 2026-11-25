#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/chat_knowledge.hpp"
#include "dimension/atomic_file.hpp"
#include "dimension/network_proxy.hpp"

#include <windows.h>
#include <winhttp.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <future>
#include <map>
#include <mutex>
#include <set>
#include <sstream>

namespace dimension {
namespace {

using O = Json::Object;
using A = Json::Array;
namespace fs = std::filesystem;

constexpr std::size_t kMaxHttpResponseBytes = 200U * 1024U;
constexpr std::size_t kMaxLoreEntries = 500U;
constexpr std::size_t kMaxLoreFileBytes = 4U * 1024U * 1024U;
constexpr std::size_t kMaxCustomSources = 12U;
constexpr std::size_t kMaxConcurrentCustomSources = 6U;
constexpr std::size_t kMaxPriorityDomains = 24U;
constexpr std::int64_t kCacheTtlMs = 15LL * 60LL * 1000LL; // 15 分钟缓存
constexpr std::size_t kMaxCacheEntries = 256U;

std::int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string trim_copy(std::string_view s) {
    std::size_t b = 0;
    while (b < s.size() && static_cast<unsigned char>(s[b]) <= 0x20U) ++b;
    std::size_t e = s.size();
    while (e > b && static_cast<unsigned char>(s[e - 1]) <= 0x20U) --e;
    return std::string(s.substr(b, e - b));
}

std::string to_lower_ascii(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        out.push_back(static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c));
    }
    return out;
}

std::string clip_utf8(std::string_view s, std::size_t max_bytes) {
    if (s.size() <= max_bytes) return std::string(s);
    std::size_t cut = max_bytes;
    while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xC0U) == 0x80U) --cut;
    return std::string(s.substr(0, cut));
}

std::string collapse_spaces(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    bool prev_sp = false;
    for (unsigned char c : s) {
        if (c == '\r' || c == '\n' || c == '\t' || c == ' ') {
            if (!prev_sp && !out.empty()) out.push_back(' ');
            prev_sp = true;
        } else {
            out.push_back(static_cast<char>(c));
            prev_sp = false;
        }
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return out;
}

std::string strip_html_tags(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    bool in_tag = false;
    for (char c : s) {
        if (c == '<') { in_tag = true; continue; }
        if (c == '>') { in_tag = false; out.push_back(' '); continue; }
        if (!in_tag) out.push_back(c);
    }
    return collapse_spaces(out);
}

void append_utf8_codepoint(std::string& out, std::uint32_t cp) {
    if (cp == 0 || cp > 0x10FFFFU) return;
    if (cp < 0x80U) {
        out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800U) {
        out.push_back(static_cast<char>(0xC0U | (cp >> 6)));
        out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
    } else if (cp < 0x10000U) {
        out.push_back(static_cast<char>(0xE0U | (cp >> 12)));
        out.push_back(static_cast<char>(0x80U | ((cp >> 6) & 0x3FU)));
        out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
    } else {
        out.push_back(static_cast<char>(0xF0U | (cp >> 18)));
        out.push_back(static_cast<char>(0x80U | ((cp >> 12) & 0x3FU)));
        out.push_back(static_cast<char>(0x80U | ((cp >> 6) & 0x3FU)));
        out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
    }
}

bool contains_non_ascii(std::string_view s) {
    for (unsigned char c : s) {
        if (c >= 0x80U) return true;
    }
    return false;
}

std::wstring utf8_to_wide(std::string_view s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (n <= 0) return {};
    std::wstring w(static_cast<std::size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

std::string random_short_id(std::string_view prefix) {
    std::array<unsigned char, 6> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
        const auto t = static_cast<std::uint64_t>(now_ms());
        for (std::size_t i = 0; i < bytes.size(); ++i) bytes[i] = static_cast<unsigned char>((t >> (i * 8)) & 0xFFU);
    }
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out(prefix);
    for (unsigned char b : bytes) {
        out.push_back(kHex[b >> 4]);
        out.push_back(kHex[b & 0x0FU]);
    }
    return out;
}

struct WinHttpHandle {
    HINTERNET h = nullptr;
    explicit WinHttpHandle(HINTERNET handle = nullptr) : h(handle) {}
    ~WinHttpHandle() { if (h) WinHttpCloseHandle(h); }
    WinHttpHandle(const WinHttpHandle&) = delete;
    WinHttpHandle& operator=(const WinHttpHandle&) = delete;
    explicit operator bool() const { return h != nullptr; }
};

HttpGetResult winhttp_get(const std::string& url, int timeout_ms, std::stop_token stop) {
    HttpGetResult res;
    if (stop.stop_requested()) {
        res.error = "cancelled";
        return res;
    }
    const auto wurl = utf8_to_wide(url);
    if (wurl.empty()) {
        res.error = "invalid_url";
        return res;
    }
    URL_COMPONENTS comps{};
    comps.dwStructSize = sizeof(comps);
    std::wstring host(256, L'\0');
    std::wstring path(2048, L'\0');
    comps.lpszHostName = host.data();
    comps.dwHostNameLength = static_cast<DWORD>(host.size());
    comps.lpszUrlPath = path.data();
    comps.dwUrlPathLength = static_cast<DWORD>(path.size());
    if (!WinHttpCrackUrl(wurl.c_str(), static_cast<DWORD>(wurl.size()), 0, &comps)) {
        res.error = "crack_url_failed";
        return res;
    }
    host.resize(comps.dwHostNameLength);
    path.resize(comps.dwUrlPathLength);
    if (path.empty()) path = L"/";
    const bool is_https = (comps.nScheme == INTERNET_SCHEME_HTTPS);
    const INTERNET_PORT port = comps.nPort ? comps.nPort : (is_https ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT);

    const int eff_timeout = std::clamp(timeout_ms, 800, 8000);
    WinHttpHandle session(open_configured_winhttp_session(
        L"Mozilla/5.0 (Windows NT 10.0; Win64; x64) DimensionAgent/0.7",
        0));
    if (!session) {
        res.error = "winhttp_open_failed";
        return res;
    }
    WinHttpSetTimeouts(session.h, eff_timeout, eff_timeout, eff_timeout, eff_timeout);
    WinHttpHandle conn(WinHttpConnect(session.h, host.c_str(), port, 0));
    if (!conn) {
        res.error = "winhttp_connect_failed";
        return res;
    }
    WinHttpHandle req(WinHttpOpenRequest(
        conn.h,
        L"GET",
        path.c_str(),
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        is_https ? WINHTTP_FLAG_SECURE : 0));
    if (!req) {
        res.error = "winhttp_request_failed";
        return res;
    }
    DWORD disable_flags = WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
    WinHttpSetOption(req.h, WINHTTP_OPTION_DISABLE_FEATURE, &disable_flags, sizeof(disable_flags));
    DWORD redirect_policy = WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP;
    WinHttpSetOption(req.h, WINHTTP_OPTION_REDIRECT_POLICY, &redirect_policy, sizeof(redirect_policy));

    const std::wstring headers = L"Accept: application/rss+xml, application/atom+xml, application/xml, application/json, text/html;q=0.9, text/plain;q=0.8\r\n"
                                 L"Accept-Language: zh-CN,zh;q=0.9,en;q=0.6\r\n";
    if (!WinHttpSendRequest(req.h, headers.c_str(), static_cast<DWORD>(headers.size()),
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(req.h, nullptr)) {
        res.error = "winhttp_send_failed";
        return res;
    }
    DWORD status = 0;
    DWORD status_sz = sizeof(status);
    if (WinHttpQueryHeaders(req.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_sz, WINHTTP_NO_HEADER_INDEX)) {
        res.status = static_cast<int>(status);
    }
    if (res.status < 200 || res.status >= 300) {
        res.error = "http_" + std::to_string(res.status);
        return res;
    }
    std::string buf;
    buf.reserve(8192);
    std::array<char, 4096> chunk{};
    for (;;) {
        if (stop.stop_requested()) {
            res.error = "cancelled";
            return res;
        }
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(req.h, &avail) || avail == 0) break;
        DWORD to_read = static_cast<DWORD>(std::min<std::size_t>(avail, chunk.size()));
        if (buf.size() + to_read > kMaxHttpResponseBytes) {
            to_read = static_cast<DWORD>(kMaxHttpResponseBytes - buf.size());
        }
        if (to_read == 0) break;
        DWORD got = 0;
        if (!WinHttpReadData(req.h, chunk.data(), to_read, &got) || got == 0) break;
        buf.append(chunk.data(), got);
        if (buf.size() >= kMaxHttpResponseBytes) break;
    }
    res.body = std::move(buf);
    return res;
}

std::string extract_xml_tag(std::string_view block, std::string_view tag_name) {
    const std::string open_prefix = "<" + std::string(tag_name);
    const std::string close_tag = "</" + std::string(tag_name) + ">";
    std::size_t pos = 0;
    while (pos < block.size()) {
        const auto hit = block.find(open_prefix, pos);
        if (hit == std::string_view::npos) return {};
        const auto after = hit + open_prefix.size();
        if (after >= block.size()) return {};
        const char ch = block[after];
        if (ch != '>' && ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n') {
            pos = after;
            continue;
        }
        const auto gt = block.find('>', after);
        if (gt == std::string_view::npos) return {};
        if (gt > hit && block[gt - 1] == '/') {
            pos = gt + 1;
            continue;
        }
        const auto end = block.find(close_tag, gt + 1);
        if (end == std::string_view::npos) return {};
        auto inner = block.substr(gt + 1, end - (gt + 1));
        constexpr std::string_view kCdataStart = "<![CDATA[";
        constexpr std::string_view kCdataEnd = "]]>";
        if (inner.starts_with(kCdataStart) && inner.ends_with(kCdataEnd) &&
            inner.size() >= kCdataStart.size() + kCdataEnd.size()) {
            inner = inner.substr(kCdataStart.size(), inner.size() - kCdataStart.size() - kCdataEnd.size());
        }
        return strip_html_tags(ChatWebLookupEngine::decode_html_entities(inner));
    }
    return {};
}

std::string extract_atom_link_href(std::string_view block) {
    std::size_t pos = 0;
    while (pos < block.size()) {
        const auto hit = block.find("<link", pos);
        if (hit == std::string_view::npos) return {};
        const auto gt = block.find('>', hit + 5);
        if (gt == std::string_view::npos) return {};
        const auto tag = block.substr(hit, gt - hit + 1);
        const auto href_pos = tag.find("href=");
        if (href_pos != std::string_view::npos && href_pos + 6 < tag.size()) {
            const char q = tag[href_pos + 5];
            if (q == '"' || q == '\'') {
                const auto q_end = tag.find(q, href_pos + 6);
                if (q_end != std::string_view::npos) {
                    return trim_copy(ChatWebLookupEngine::decode_html_entities(tag.substr(href_pos + 6, q_end - (href_pos + 6))));
                }
            }
        }
        pos = gt + 1;
    }
    return {};
}

std::string sanitize_http_url(std::string_view raw) {
    std::string u = trim_copy(raw);
    if (u.empty() || u.size() > 1024U) return {};
    if (u.starts_with("//")) u = "https:" + u;
    const auto low = to_lower_ascii(u);
    if (!low.starts_with("http://") && !low.starts_with("https://")) return {};
    for (unsigned char c : u) {
        if (c <= 0x20U || c == 0x7FU || c == '\\' || c == '<' || c == '>' || c == '"') return {};
    }
    return u;
}

std::string extract_url_host(std::string_view url) {
    const auto pos = url.find("://");
    if (pos == std::string_view::npos) return {};
    auto rest = url.substr(pos + 3);
    const auto slash = rest.find_first_of("/?#");
    if (slash != std::string_view::npos) rest = rest.substr(0, slash);
    const auto at = rest.rfind('@');
    if (at != std::string_view::npos) rest = rest.substr(at + 1);
    const auto colon = rest.find(':');
    if (colon != std::string_view::npos) rest = rest.substr(0, colon);
    return to_lower_ascii(trim_copy(rest));
}

bool host_matches_domain(std::string_view host, std::string_view domain) {
    if (host.empty() || domain.empty()) return false;
    if (host == domain) return true;
    return host.size() > domain.size() &&
           host.ends_with(domain) &&
           host[host.size() - domain.size() - 1] == '.';
}

std::string normalize_domain_token(std::string_view raw) {
    auto s = to_lower_ascii(trim_copy(raw));
    if (const auto pos = s.find("://"); pos != std::string::npos) {
        s = extract_url_host(s);
    } else if (const auto slash = s.find('/'); slash != std::string::npos) {
        s = s.substr(0, slash);
    }
    if (s.starts_with("www.") && s.size() > 4) s.erase(0, 4);
    while (!s.empty() && s.front() == '.') s.erase(0, 1);
    while (!s.empty() && s.back() == '.') s.pop_back();
    if (s.size() < 3 || s.size() > 80 || s.find('.') == std::string::npos) return {};
    for (unsigned char c : s) {
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.')) return {};
    }
    return s;
}

bool is_valid_url_template(std::string_view raw) {
    const auto s = trim_copy(raw);
    if (s.size() < 12 || s.size() > 512) return false;
    const auto low = to_lower_ascii(s);
    if (!low.starts_with("http://") && !low.starts_with("https://")) return false;
    if (s.find("{query}") == std::string::npos) return false;
    for (unsigned char c : s) {
        if (c <= 0x20U || c == 0x7FU || c == '\\') return false;
    }
    // 禁止嵌入式 user:pass@ 凭据
    const auto scheme_end = s.find("://");
    const auto auth_end = s.find_first_of("/?#", scheme_end + 3);
    const auto authority = auth_end == std::string::npos
        ? s.substr(scheme_end + 3)
        : s.substr(scheme_end + 3, auth_end - (scheme_end + 3));
    if (authority.empty() || authority.find('@') != std::string::npos) return false;
    return true;
}

std::string normalize_custom_format(std::string_view fmt) {
    const auto f = to_lower_ascii(trim_copy(fmt));
    if (f == "rss" || f == "json" || f == "html") return f;
    return "auto";
}

std::string replace_query_placeholder(std::string_view tpl, std::string_view encoded_query) {
    std::string out;
    out.reserve(tpl.size() + encoded_query.size());
    std::size_t pos = 0;
    while (pos < tpl.size()) {
        const auto hit = tpl.find("{query}", pos);
        if (hit == std::string_view::npos) {
            out.append(tpl.substr(pos));
            break;
        }
        out.append(tpl.substr(pos, hit - pos));
        out.append(encoded_query);
        pos = hit + 7;
    }
    return out;
}

std::string extract_html_attr(std::string_view tag, std::string_view attr_name) {
    const auto tag_low = to_lower_ascii(tag);
    const auto key = to_lower_ascii(attr_name);
    std::size_t pos = 0;
    while (pos < tag_low.size()) {
        const auto hit = tag_low.find(key, pos);
        if (hit == std::string::npos) return {};
        // 确保属性名前是空白字符，避免把 data-name 误判为 name
        if (hit > 0 && static_cast<unsigned char>(tag_low[hit - 1]) > 0x20U) {
            pos = hit + key.size();
            continue;
        }
        std::size_t p = hit + key.size();
        while (p < tag.size() && static_cast<unsigned char>(tag[p]) <= 0x20U) ++p;
        if (p >= tag.size() || tag[p] != '=') {
            pos = hit + key.size();
            continue;
        }
        ++p;
        while (p < tag.size() && static_cast<unsigned char>(tag[p]) <= 0x20U) ++p;
        if (p >= tag.size()) return {};
        if (tag[p] == '"' || tag[p] == '\'') {
            const char q = tag[p++];
            const auto end = tag.find(q, p);
            if (end == std::string_view::npos) return {};
            return collapse_spaces(ChatWebLookupEngine::decode_html_entities(tag.substr(p, end - p)));
        }
        const auto end = tag.find_first_of(" \t\r\n/>", p);
        const auto val = end == std::string_view::npos ? tag.substr(p) : tag.substr(p, end - p);
        return collapse_spaces(ChatWebLookupEngine::decode_html_entities(val));
    }
    return {};
}

std::string extract_html_title(std::string_view html) {
    const auto low = to_lower_ascii(html);
    const auto start = low.find("<title");
    if (start == std::string::npos) return {};
    const auto gt = low.find('>', start);
    if (gt == std::string::npos) return {};
    const auto end = low.find("</title>", gt + 1);
    if (end == std::string::npos) return {};
    return collapse_spaces(strip_html_tags(ChatWebLookupEngine::decode_html_entities(html.substr(gt + 1, end - (gt + 1)))));
}

std::string extract_html_meta_description(std::string_view html) {
    const auto low = to_lower_ascii(html);
    std::string fallback_og;
    std::size_t pos = 0;
    while (pos < low.size()) {
        const auto hit = low.find("<meta", pos);
        if (hit == std::string::npos) break;
        const auto gt = low.find('>', hit + 5);
        if (gt == std::string::npos) break;
        const auto tag = html.substr(hit, gt - hit + 1);
        pos = gt + 1;

        const auto name = to_lower_ascii(extract_html_attr(tag, "name"));
        const auto prop = to_lower_ascii(extract_html_attr(tag, "property"));
        if (name == "description") {
            auto c = extract_html_attr(tag, "content");
            if (!c.empty()) return c;
        } else if (fallback_og.empty() && (prop == "og:description" || name == "twitter:description")) {
            fallback_og = extract_html_attr(tag, "content");
        }
    }
    return fallback_og;
}

bool looks_like_not_found_title(std::string_view title) {
    const auto low = to_lower_ascii(title);
    return low.find("404") != std::string::npos ||
           low.find("not found") != std::string::npos ||
           low.find("page not found") != std::string::npos ||
           title.find("页面不存在") != std::string_view::npos ||
           title.find("找不到页面") != std::string_view::npos ||
           title.find("词条不存在") != std::string_view::npos;
}

std::string format_cn_count(std::int64_t n) {
    if (n <= 0) return {};
    if (n >= 100000000LL) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.1f亿", static_cast<double>(n) / 100000000.0);
        return buf;
    }
    if (n >= 10000LL) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.1f万", static_cast<double>(n) / 10000.0);
        return buf;
    }
    return std::to_string(n);
}

std::vector<std::string> tokenize_query(std::string_view query) {
    std::vector<std::string> tokens;
    const auto q = to_lower_ascii(trim_copy(query));
    std::string cur;
    for (std::size_t i = 0; i < q.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(q[i]);
        if (c <= 0x20U || c == ',' || c == '/' || c == '?' || c == '!' || c == '"' || c == '\'') {
            if (cur.size() >= 2) tokens.push_back(cur);
            cur.clear();
        } else {
            cur.push_back(static_cast<char>(c));
        }
    }
    if (cur.size() >= 2) tokens.push_back(cur);
    return tokens;
}

int score_item_relevance(const WebLookupItem& item,
                         const std::vector<std::string>& tokens,
                         std::string_view full_q_low,
                         std::string_view core_q_low,
                         const std::vector<std::string>& priority_domains) {
    const std::string hay = to_lower_ascii(item.title + " " + item.snippet);
    int score = 0;
    if (!core_q_low.empty() && hay.find(core_q_low) != std::string::npos) score += 22;
    else if (!full_q_low.empty() && hay.find(full_q_low) != std::string::npos) score += 18;
    for (const auto& t : tokens) {
        if (t.size() >= 2 && hay.find(t) != std::string::npos) {
            score += static_cast<int>(std::min<std::size_t>(t.size(), 12));
        }
    }
    if (item.source == "bilibili") score += 10;
    else if (item.source == "cnmeme") score += 9;
    else if (item.source == "baike") score += 7;
    else if (item.source == "zhwiki" || item.source == "enwiki") score += 5;
    else if (item.source.starts_with("custom:")) score += 6;

    const auto host = extract_url_host(item.url);
    for (const auto& dom : priority_domains) {
        if (host_matches_domain(host, dom)) {
            score += 8;
            break;
        }
    }

    if (hay.find("网络流行") != std::string::npos || hay.find("网络热词") != std::string::npos ||
        hay.find("什么梗") != std::string::npos || hay.find("流行梗") != std::string::npos ||
        hay.find("出处") != std::string::npos || hay.find("音mad") != std::string::npos ||
        hay.find("二创") != std::string::npos) {
        score += 10;
    } else if (hay.find("百科") != std::string::npos || hay.find("wiki") != std::string::npos ||
               hay.find("梗") != std::string::npos) {
        score += 3;
    }

    // 当核心查询为 2 字及以上中文词时，大幅降权“单字汉语字典/汉典/汉语国学”噪声
    if (contains_non_ascii(core_q_low) && core_q_low.size() >= 4U) {
        if (item.title.find("汉语文字") != std::string::npos ||
            item.title.find("汉语汉字") != std::string::npos ||
            item.title.find("汉典") != std::string::npos ||
            item.title.find("汉语国学") != std::string::npos) {
            score -= 24;
        }
    }
    return score;
}

WebLookupConfig sanitize_lookup_config(const WebLookupConfig& in) {
    WebLookupConfig out;
    out.enable_bing = in.enable_bing;
    out.enable_baike = in.enable_baike;
    out.enable_cnmeme = in.enable_cnmeme;
    out.enable_bilibili_detail = in.enable_bilibili_detail;
    out.enable_wikipedia = in.enable_wikipedia;
    out.priority_domains.clear();
    std::set<std::string> seen_dom;
    for (const auto& d : in.priority_domains) {
        const auto norm = normalize_domain_token(d);
        if (!norm.empty() && seen_dom.insert(norm).second) {
            out.priority_domains.push_back(norm);
            if (out.priority_domains.size() >= kMaxPriorityDomains) break;
        }
    }
    std::set<std::string> seen_ids;
    for (const auto& src : in.custom_sources) {
        if (!is_valid_url_template(src.url_template)) continue;
        CustomSearchSource s;
        s.id = trim_copy(src.id);
        if (s.id.empty() || !seen_ids.insert(s.id).second) {
            s.id = random_short_id("src_");
            seen_ids.insert(s.id);
        }
        s.name = clip_utf8(trim_copy(src.name), 48);
        if (s.name.empty()) {
            const auto h = extract_url_host(src.url_template);
            s.name = h.empty() ? "自定义源" : clip_utf8(h, 48);
        }
        s.url_template = trim_copy(src.url_template);
        s.format = normalize_custom_format(src.format);
        s.enabled = src.enabled;
        out.custom_sources.push_back(std::move(s));
        if (out.custom_sources.size() >= kMaxCustomSources) break;
    }
    return out;
}

Json lookup_config_to_json(const WebLookupConfig& cfg) {
    A doms;
    for (const auto& d : cfg.priority_domains) doms.push_back(d);
    A custom;
    for (const auto& s : cfg.custom_sources) {
        custom.push_back(O{
            {"id", s.id},
            {"name", s.name},
            {"urlTemplate", s.url_template},
            {"format", s.format},
            {"enabled", s.enabled},
        });
    }
    return O{
        {"enableBing", cfg.enable_bing},
        {"enableBaike", cfg.enable_baike},
        {"enableCnmeme", cfg.enable_cnmeme},
        {"enableBilibiliDetail", cfg.enable_bilibili_detail},
        {"enableWikipedia", cfg.enable_wikipedia},
        {"priorityDomains", std::move(doms)},
        {"customSources", std::move(custom)},
    };
}

WebLookupConfig lookup_config_from_json(const Json& doc, const WebLookupConfig& base) {
    WebLookupConfig cfg = base;
    if (!doc.is_object()) return sanitize_lookup_config(cfg);
    auto bget = [&](std::string_view k, bool cur) {
        const auto* p = doc.find(k);
        return (p && p->is_bool()) ? p->as_bool() : cur;
    };
    cfg.enable_bing = bget("enableBing", cfg.enable_bing);
    cfg.enable_baike = bget("enableBaike", cfg.enable_baike);
    cfg.enable_cnmeme = bget("enableCnmeme", cfg.enable_cnmeme);
    cfg.enable_bilibili_detail = bget("enableBilibiliDetail", cfg.enable_bilibili_detail);
    cfg.enable_wikipedia = bget("enableWikipedia", cfg.enable_wikipedia);

    if (const auto* pd = doc.find("priorityDomains"); pd && pd->is_array()) {
        cfg.priority_domains.clear();
        for (const auto& item : pd->as_array()) {
            if (item.is_string()) cfg.priority_domains.push_back(item.as_string());
        }
    }
    if (const auto* cs = doc.find("customSources"); cs && cs->is_array()) {
        cfg.custom_sources.clear();
        for (const auto& item : cs->as_array()) {
            if (!item.is_object()) continue;
            auto jstr = [&](std::string_view k) -> std::string {
                const auto* p = item.find(k);
                return (p && p->is_string()) ? p->as_string() : std::string{};
            };
            CustomSearchSource s;
            s.id = jstr("id");
            s.name = jstr("name");
            s.url_template = jstr("urlTemplate");
            if (s.url_template.empty()) s.url_template = jstr("url");
            s.format = jstr("format");
            if (const auto* en = item.find("enabled"); en && en->is_bool()) s.enabled = en->as_bool();
            if (!is_valid_url_template(s.url_template)) {
                throw std::invalid_argument("自定义搜索地址必须是 http(s):// 且包含 {query} 占位符");
            }
            cfg.custom_sources.push_back(std::move(s));
        }
    }
    return sanitize_lookup_config(cfg);
}

bool contains_any(std::string_view text, std::initializer_list<std::string_view> needles) {
    for (auto n : needles) {
        if (!n.empty() && text.find(n) != std::string_view::npos) return true;
    }
    return false;
}

std::string normalize_trigger_key(std::string_view s) {
    return to_lower_ascii(trim_copy(s));
}

std::string normalize_scope(std::string_view scope) {
    const auto s = trim_copy(scope);
    if (s.empty() || s == "global") return "global";
    if (s.starts_with("bot:") && s.size() > 4) return s;
    if (s.starts_with("group:") && s.size() > 6) return s;
    return "global";
}

std::string normalize_source(std::string_view src) {
    if (src == "manual" || src == "auto_learned" || src == "web_cached" || src == "imported") {
        return std::string(src);
    }
    return "manual";
}

bool scope_matches(std::string_view scope, std::string_view bot_id, std::string_view group_id) {
    if (scope.empty() || scope == "global") return true;
    if (scope.starts_with("bot:")) {
        return !bot_id.empty() && scope.substr(4) == bot_id;
    }
    if (scope.starts_with("group:")) {
        return !group_id.empty() && scope.substr(6) == group_id;
    }
    return false;
}

Json entry_to_json(const LoreEntry& e) {
    A trigs;
    for (const auto& t : e.triggers) trigs.push_back(t);
    return O{
        {"id", e.id},
        {"title", e.title},
        {"triggers", std::move(trigs)},
        {"meaning", e.meaning},
        {"scope", e.scope},
        {"source", e.source},
        {"stickerId", e.sticker_id},
        {"enabled", e.enabled},
        {"hitCount", static_cast<double>(e.hit_count)},
        {"createdAtMs", static_cast<double>(e.created_at_ms)},
        {"updatedAtMs", static_cast<double>(e.updated_at_ms)},
    };
}

std::optional<LoreEntry> entry_from_json(const Json& j) {
    if (!j.is_object()) return std::nullopt;
    auto jstr = [&](std::string_view k) -> std::string {
        const auto* p = j.find(k);
        return (p && p->is_string()) ? p->as_string() : std::string{};
    };
    LoreEntry e;
    e.id = trim_copy(jstr("id"));
    e.title = clip_utf8(trim_copy(jstr("title")), 96);
    e.meaning = clip_utf8(collapse_spaces(jstr("meaning")), 420);
    if (e.title.empty() || e.meaning.empty()) return std::nullopt;
    e.scope = normalize_scope(jstr("scope"));
    e.source = normalize_source(jstr("source"));
    e.sticker_id = clip_utf8(trim_copy(jstr("stickerId")), 64);
    if (const auto* en = j.find("enabled"); en && en->is_bool()) e.enabled = en->as_bool();
    if (const auto* hc = j.find("hitCount"); hc && hc->is_number() && hc->as_number() >= 0) {
        e.hit_count = static_cast<std::uint64_t>(hc->as_number());
    }
    if (const auto* cr = j.find("createdAtMs"); cr && cr->is_number() && cr->as_number() >= 0) {
        e.created_at_ms = static_cast<std::int64_t>(cr->as_number());
    }
    if (const auto* up = j.find("updatedAtMs"); up && up->is_number() && up->as_number() >= 0) {
        e.updated_at_ms = static_cast<std::int64_t>(up->as_number());
    }
    std::set<std::string> seen;
    if (const auto* tr = j.find("triggers"); tr && tr->is_array()) {
        for (const auto& item : tr->as_array()) {
            if (!item.is_string()) continue;
            const auto t = clip_utf8(trim_copy(item.as_string()), 64);
            const auto k = normalize_trigger_key(t);
            if (k.size() >= 2 && seen.insert(k).second) {
                e.triggers.push_back(t);
                if (e.triggers.size() >= 12) break;
            }
        }
    }
    if (e.triggers.empty()) {
        e.triggers.push_back(e.title);
    }
    return e;
}

std::string strip_leading_quote_punct(std::string_view s) {
    auto v = trim_copy(s);
    static constexpr std::string_view kLefts[] = {"“", "「", "『", "《", "【", "\"", "'", "(", "（"};
    static constexpr std::string_view kRights[] = {"”", "」", "』", "》", "】", "\"", "'", ")", "）"};
    bool changed = true;
    while (changed && !v.empty()) {
        changed = false;
        for (auto p : kLefts) {
            if (v.starts_with(p)) { v.erase(0, p.size()); v = trim_copy(v); changed = true; }
        }
        for (auto p : kRights) {
            if (v.ends_with(p)) { v.erase(v.size() - p.size()); v = trim_copy(v); changed = true; }
        }
    }
    return v;
}

// Lightweight offline fallback extractor for patterns like:
//   "曼波的意思是赛马娘诗歌剧哼的洗脑魔性小曲"
//   "「V我50」指的是疯狂星期四让大家请吃肯德基的梗"
std::vector<LoreEntry> heuristic_extract_lore(std::string_view user_text,
                                              std::string_view scope) {
    std::vector<LoreEntry> out;
    const auto text = collapse_spaces(user_text);
    if (text.size() < 10 || text.size() > 900) return out;

    static constexpr std::string_view kPatterns[] = {
        "的意思是", "指的是", "是指", "就是指", "其实是指", "其实是", "是个梗，", "是个梗,", "是一个梗，", "是一个梗,", "的缩写是", "外号叫"
    };
    for (auto sep : kPatterns) {
        const auto pos = text.find(sep);
        if (pos == std::string::npos || pos == 0) continue;
        std::string lhs = text.substr(0, pos);
        std::string rhs = trim_copy(text.substr(pos + sep.size()));
        if (rhs.size() < 4) continue;

        // Trim leading conversational prefixes from lhs
        static constexpr std::string_view kCutMarks[] = {"，", ",", "。", "！", "!", "？", "?", "：", ":", "就是", "其实", "不是啦", "不是，", "那个", "科普一下", "给你科普"};
        for (auto mk : kCutMarks) {
            const auto lp = lhs.rfind(mk);
            if (lp != std::string::npos && lp + mk.size() < lhs.size()) {
                lhs = lhs.substr(lp + mk.size());
            }
        }
        lhs = strip_leading_quote_punct(lhs);
        // Strip trailing "这个梗" / "这个词"
        for (std::string_view suf : {"这个梗", "这个词", "这梗", "梗"}) {
            if (lhs.size() > suf.size() + 2 && lhs.ends_with(suf)) {
                lhs.erase(lhs.size() - suf.size());
                lhs = strip_leading_quote_punct(lhs);
            }
        }
        if (lhs.size() < 2 || lhs.size() > 48) continue;

        LoreEntry e;
        e.title = clip_utf8(lhs, 64);
        e.triggers = {e.title};
        e.meaning = clip_utf8(rhs, 320);
        e.scope = std::string(scope);
        e.source = "auto_learned";
        out.push_back(std::move(e));
        break;
    }
    return out;
}

} // namespace

// ============================================================================
// ChatWebLookupEngine
// ============================================================================

struct ChatWebLookupEngine::Impl {
    HttpGetFn http_get;
    fs::path config_file;
    mutable std::mutex mutex;
    WebLookupConfig config;
    struct CacheSlot {
        WebLookupResult result;
        std::int64_t expires_at_ms = 0;
    };
    std::map<std::string, CacheSlot> cache;

    void load_config_unlocked() {
        if (config_file.empty()) return;
        std::error_code ec;
        if (!fs::exists(config_file, ec)) return;
        std::ifstream in(config_file, std::ios::binary);
        if (!in.good()) return;
        std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        if (bytes.empty() || bytes.size() > 256U * 1024U) return;
        try {
            const auto doc = Json::parse(bytes, 256U * 1024U);
            config = lookup_config_from_json(doc, config);
        } catch (...) {}
    }

    void persist_config_unlocked() {
        if (config_file.empty()) return;
        std::error_code ec;
        fs::create_directories(config_file.parent_path(), ec);
        atomic_write_file(config_file, lookup_config_to_json(config).dump());
    }
};

ChatWebLookupEngine::ChatWebLookupEngine(HttpGetFn custom_http, std::filesystem::path config_file)
    : impl_(std::make_unique<Impl>()) {
    impl_->http_get = custom_http ? std::move(custom_http) : HttpGetFn(winhttp_get);
    if (!config_file.empty()) {
        impl_->config_file = fs::absolute(std::move(config_file));
        impl_->load_config_unlocked();
    }
}

ChatWebLookupEngine::~ChatWebLookupEngine() = default;

WebLookupConfig ChatWebLookupEngine::get_config() const {
    std::lock_guard lock(impl_->mutex);
    return impl_->config;
}

Json ChatWebLookupEngine::config_json() const {
    std::lock_guard lock(impl_->mutex);
    return lookup_config_to_json(impl_->config);
}

WebLookupConfig ChatWebLookupEngine::update_config(const WebLookupConfig& cfg) {
    std::lock_guard lock(impl_->mutex);
    impl_->config = sanitize_lookup_config(cfg);
    impl_->cache.clear();
    impl_->persist_config_unlocked();
    return impl_->config;
}

WebLookupConfig ChatWebLookupEngine::update_config_json(const Json& doc) {
    std::lock_guard lock(impl_->mutex);
    impl_->config = lookup_config_from_json(doc, impl_->config);
    impl_->cache.clear();
    impl_->persist_config_unlocked();
    return impl_->config;
}

void ChatWebLookupEngine::clear_cache() {
    std::lock_guard lock(impl_->mutex);
    impl_->cache.clear();
}

std::string ChatWebLookupEngine::decode_html_entities(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    for (std::size_t i = 0; i < text.size(); ++i) {
        if (text[i] != '&') {
            out.push_back(text[i]);
            continue;
        }
        const auto semi = text.find(';', i + 1);
        if (semi == std::string_view::npos || semi - i > 12) {
            out.push_back(text[i]);
            continue;
        }
        const auto ent = text.substr(i + 1, semi - i - 1);
        if (ent == "amp") out.push_back('&');
        else if (ent == "lt") out.push_back('<');
        else if (ent == "gt") out.push_back('>');
        else if (ent == "quot") out.push_back('"');
        else if (ent == "apos" || ent == "#39") out.push_back('\'');
        else if (ent == "nbsp") out.push_back(' ');
        else if (ent.size() >= 2 && ent[0] == '#') {
            std::uint32_t cp = 0;
            bool ok = true;
            if (ent[1] == 'x' || ent[1] == 'X') {
                for (std::size_t k = 2; k < ent.size(); ++k) {
                    char c = ent[k];
                    cp <<= 4;
                    if (c >= '0' && c <= '9') cp |= static_cast<std::uint32_t>(c - '0');
                    else if (c >= 'a' && c <= 'f') cp |= static_cast<std::uint32_t>(c - 'a' + 10);
                    else if (c >= 'A' && c <= 'F') cp |= static_cast<std::uint32_t>(c - 'A' + 10);
                    else { ok = false; break; }
                }
            } else {
                for (std::size_t k = 1; k < ent.size(); ++k) {
                    if (ent[k] < '0' || ent[k] > '9') { ok = false; break; }
                    cp = cp * 10U + static_cast<std::uint32_t>(ent[k] - '0');
                }
            }
            if (ok && cp > 0) append_utf8_codepoint(out, cp);
            else out.append(text.substr(i, semi - i + 1));
        } else {
            out.append(text.substr(i, semi - i + 1));
        }
        i = semi;
    }
    return out;
}

std::string ChatWebLookupEngine::url_encode(std::string_view text) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(text.size() * 2);
    for (unsigned char c : text) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(static_cast<char>(c));
        } else if (c == ' ') {
            out += "%20";
        } else {
            out.push_back('%');
            out.push_back(kHex[c >> 4]);
            out.push_back(kHex[c & 0x0FU]);
        }
    }
    return out;
}

std::string ChatWebLookupEngine::extract_bvid(std::string_view text) {
    auto is_alnum_ascii = [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    };
    for (std::size_t i = 0; i + 12 <= text.size(); ++i) {
        if ((text[i] == 'B' || text[i] == 'b') &&
            (text[i + 1] == 'V' || text[i + 1] == 'v') &&
            text[i + 2] == '1') {
            if (i > 0 && is_alnum_ascii(text[i - 1])) continue;
            bool ok = true;
            for (std::size_t k = 2; k < 12; ++k) {
                if (!is_alnum_ascii(text[i + k])) { ok = false; break; }
            }
            if (!ok) continue;
            if (i + 12 < text.size() && is_alnum_ascii(text[i + 12])) continue;
            std::string bvid(text.substr(i, 12));
            bvid[0] = 'B';
            bvid[1] = 'V';
            return bvid;
        }
    }
    return {};
}

std::string ChatWebLookupEngine::extract_core_query(std::string_view raw_query) {
    std::string cleaned = collapse_spaces(raw_query);
    cleaned = strip_leading_quote_punct(cleaned);
    while (!cleaned.empty()) {
        bool trimmed = false;
        for (std::string_view p : {"？", "?", "！", "!", "。", ".", "，", ","}) {
            if (cleaned.ends_with(p)) {
                cleaned.erase(cleaned.size() - p.size());
                cleaned = trim_copy(cleaned);
                trimmed = true;
            }
        }
        if (!trimmed) break;
    }
    if (cleaned.size() < 2) return cleaned;
    if (!extract_bvid(cleaned).empty()) return cleaned;

    // 过滤查询词中的常见修饰词和站点词，避免 Bing RSS 切词退化为单字字典
    static constexpr std::string_view kNoiseWords[] = {
        "什么梗", "是什么梗", "啥梗", "啥意思", "是什么意思", "什么意思", "意思",
        "出处", "来源", "起源", "由来", "梗", "热梗", "网络梗", "流行梗", "流行语", "网络用语",
        "b站", "bilibili", "哔哩哔哩", "萌娘百科", "萌娘", "百度百科", "百科", "知乎", "维基百科", "维基", "wiki", "meme"
    };
    auto is_noise_word = [](std::string_view tok) {
        const auto low = to_lower_ascii(tok);
        for (auto w : kNoiseWords) {
            if (low == w) return true;
        }
        return false;
    };

    std::vector<std::string> kept;
    std::size_t pos = 0;
    while (pos < cleaned.size()) {
        while (pos < cleaned.size() && cleaned[pos] == ' ') ++pos;
        if (pos >= cleaned.size()) break;
        const auto next = cleaned.find(' ', pos);
        const auto tok = next == std::string::npos ? cleaned.substr(pos) : cleaned.substr(pos, next - pos);
        pos = next == std::string::npos ? cleaned.size() : next + 1;
        if (!is_noise_word(tok)) kept.push_back(tok);
    }

    std::string core;
    for (std::size_t i = 0; i < kept.size(); ++i) {
        if (i > 0) core.push_back(' ');
        core += kept[i];
    }
    if (core.empty()) core = cleaned;

    // 进一步剥离粘连在核心词尾部的“是什么梗 / 什么梗 / 出处”等中文修饰后缀
    static constexpr std::string_view kTrailingSuffixes[] = {
        "是什么梗", "是什么出处", "是什么意思", "什么梗", "啥梗", "什么意思", "啥意思",
        "这个梗", "的出处", "出处", "来源", "含义", "梗"
    };
    bool stripped = true;
    while (stripped) {
        stripped = false;
        for (auto suf : kTrailingSuffixes) {
            if (core.size() > suf.size() + 3U && core.ends_with(suf)) {
                core.erase(core.size() - suf.size());
                core = strip_leading_quote_punct(core);
                stripped = true;
                break;
            }
        }
    }
    return core.size() >= 2 ? core : cleaned;
}

std::string ChatWebLookupEngine::infer_source_label(std::string_view source, std::string_view url) {
    const auto host = extract_url_host(url);
    if (!host.empty()) {
        if (host_matches_domain(host, "bilibili.com") || host_matches_domain(host, "b23.tv")) return "B站";
        if (host_matches_domain(host, "biligame.com")) return "B站Wiki";
        if (host_matches_domain(host, "cnmeme.wiki")) return "梗Wiki";
        if (host_matches_domain(host, "moegirl.org.cn") || host_matches_domain(host, "moegirl.org")) return "萌娘百科";
        if (host_matches_domain(host, "baike.baidu.com")) return "百度百科";
        if (host_matches_domain(host, "zhihu.com")) return "知乎";
        if (host_matches_domain(host, "wikipedia.org")) return "维基百科";
        if (host_matches_domain(host, "nga.cn") || host_matches_domain(host, "ngabbs.com")) return "NGA";
        if (host_matches_domain(host, "tieba.baidu.com")) return "贴吧";
        if (host_matches_domain(host, "xiaohongshu.com")) return "小红书";
    }
    if (source == "bilibili") return "B站";
    if (source == "cnmeme") return "梗Wiki";
    if (source == "baike") return "百度百科";
    if (source == "zhwiki" || source == "enwiki") return "维基百科";
    if (source == "bing") return "必应";
    return source.empty() ? "网络" : std::string(source);
}

std::vector<WebLookupItem> ChatWebLookupEngine::parse_bing_rss(std::string_view xml_body, std::size_t max_items) {
    std::vector<WebLookupItem> out;
    std::size_t pos = 0;
    while (out.size() < max_items) {
        const auto start = xml_body.find("<item>", pos);
        if (start == std::string_view::npos) break;
        const auto end = xml_body.find("</item>", start);
        if (end == std::string_view::npos) break;
        const auto block = xml_body.substr(start + 6, end - (start + 6));
        pos = end + 7;

        const auto title = clip_utf8(extract_xml_tag(block, "title"), 120);
        const auto desc = clip_utf8(extract_xml_tag(block, "description"), 260);
        const auto url = sanitize_http_url(extract_xml_tag(block, "link"));
        if (title.empty() && desc.empty()) continue;
        const auto label = infer_source_label("bing", url);
        out.push_back({"bing", label, title, desc, url});
    }
    return out;
}

std::vector<WebLookupItem> ChatWebLookupEngine::parse_wikipedia_extracts(std::string_view json_body,
                                                                         std::string_view source_tag,
                                                                         std::size_t max_items) {
    std::vector<WebLookupItem> out;
    if (json_body.empty()) return out;
    try {
        const auto parsed = Json::parse(json_body, kMaxHttpResponseBytes);
        const auto* query = parsed.find("query");
        if (!query || !query->is_object()) return out;
        const auto* pages = query->find("pages");
        if (!pages || !pages->is_object()) return out;
        const std::string wiki_host = (source_tag == "enwiki") ? "en.wikipedia.org" : "zh.wikipedia.org";
        for (const auto& [page_id, val] : pages->as_object()) {
            (void)page_id;
            if (!val.is_object()) continue;
            const auto* t = val.find("title");
            const auto* ex = val.find("extract");
            const auto* fu = val.find("fullurl");
            const std::string title = (t && t->is_string()) ? clip_utf8(collapse_spaces(t->as_string()), 96) : "";
            const std::string snippet = (ex && ex->is_string()) ? clip_utf8(collapse_spaces(ex->as_string()), 260) : "";
            if (title.empty() || snippet.empty()) continue;
            std::string url = (fu && fu->is_string()) ? sanitize_http_url(fu->as_string()) : "";
            if (url.empty()) {
                url = "https://" + wiki_host + "/wiki/" + url_encode(title);
            }
            out.push_back({std::string(source_tag), "维基百科", title, snippet, std::move(url)});
            if (out.size() >= max_items) break;
        }
    } catch (...) {}
    return out;
}

std::optional<WebLookupItem> ChatWebLookupEngine::parse_baidu_baike_card(std::string_view json_body) {
    if (json_body.empty()) return std::nullopt;
    try {
        const auto parsed = Json::parse(json_body, kMaxHttpResponseBytes);
        if (!parsed.is_object()) return std::nullopt;
        auto jstr = [&](std::string_view k) -> std::string {
            const auto* p = parsed.find(k);
            return (p && p->is_string()) ? collapse_spaces(p->as_string()) : std::string{};
        };
        const auto raw_title = jstr("title");
        const auto desc = jstr("desc");
        const auto abs = jstr("abstract");
        if (raw_title.empty() || abs.empty()) return std::nullopt;
        std::string title = raw_title;
        if (!desc.empty() && title.find(desc) == std::string::npos) {
            title += "（" + desc + "）";
        }
        std::string url = sanitize_http_url(jstr("url"));
        if (url.starts_with("http://baike.baidu.com/")) {
            url.replace(0, 7, "https://");
        }
        return WebLookupItem{
            "baike",
            "百度百科",
            clip_utf8(title, 120),
            clip_utf8(abs, 280),
            std::move(url)
        };
    } catch (...) {
        return std::nullopt;
    }
}

std::optional<WebLookupItem> ChatWebLookupEngine::parse_bilibili_view_detail(std::string_view json_body,
                                                                             std::string_view bvid_hint) {
    if (json_body.empty()) return std::nullopt;
    try {
        const auto parsed = Json::parse(json_body, kMaxHttpResponseBytes);
        if (!parsed.is_object()) return std::nullopt;
        if (const auto* code = parsed.find("code"); !code || !code->is_number() || static_cast<int>(code->as_number()) != 0) {
            return std::nullopt;
        }
        const auto* data = parsed.find("data");
        if (!data || !data->is_object()) return std::nullopt;
        const Json* view = data;
        if (const auto* nested = data->find("View"); nested && nested->is_object()) {
            view = nested;
        }
        auto jstr = [](const Json& obj, std::string_view k) -> std::string {
            const auto* p = obj.find(k);
            return (p && p->is_string()) ? collapse_spaces(p->as_string()) : std::string{};
        };
        const std::string title = jstr(*view, "title");
        if (title.empty()) return std::nullopt;
        std::string bvid = jstr(*view, "bvid");
        if (bvid.empty()) bvid = std::string(bvid_hint);
        const std::string desc = jstr(*view, "desc");
        const std::string tname = jstr(*view, "tname");
        std::string owner_name;
        if (const auto* owner = view->find("owner"); owner && owner->is_object()) {
            owner_name = jstr(*owner, "name");
        }
        std::int64_t views = 0;
        if (const auto* stat = view->find("stat"); stat && stat->is_object()) {
            if (const auto* v = stat->find("view"); v && v->is_number()) {
                views = static_cast<std::int64_t>(v->as_number());
            }
        }
        std::vector<std::string> tags;
        if (const auto* tarr = data->find("Tags"); tarr && tarr->is_array()) {
            for (const auto& t : tarr->as_array()) {
                if (!t.is_object()) continue;
                const auto tn = jstr(t, "tag_name");
                if (!tn.empty()) {
                    tags.push_back(tn);
                    if (tags.size() >= 8) break;
                }
            }
        }

        std::string snippet;
        if (!owner_name.empty()) snippet += "UP主：" + owner_name;
        if (!tname.empty()) {
            if (!snippet.empty()) snippet += " | ";
            snippet += "分区：" + tname;
        }
        if (views > 0) {
            if (!snippet.empty()) snippet += " | ";
            snippet += "播放：" + format_cn_count(views);
        }
        if (!tags.empty()) {
            if (!snippet.empty()) snippet += " | ";
            snippet += "标签：";
            for (std::size_t i = 0; i < tags.size(); ++i) {
                if (i > 0) snippet += "/";
                snippet += tags[i];
            }
        }
        if (!desc.empty() && desc != "-") {
            if (!snippet.empty()) snippet += " | ";
            snippet += "简介：" + clip_utf8(desc, 140);
        }
        std::string url = bvid.empty() ? "" : ("https://www.bilibili.com/video/" + bvid);
        return WebLookupItem{
            "bilibili",
            "B站",
            clip_utf8(title, 120),
            clip_utf8(snippet, 300),
            std::move(url)
        };
    } catch (...) {
        return std::nullopt;
    }
}

std::vector<WebLookupItem> ChatWebLookupEngine::parse_custom_response(std::string_view body,
                                                                      std::string_view source_tag,
                                                                      std::string_view source_label,
                                                                      std::string_view request_url,
                                                                      std::string_view format,
                                                                      std::size_t max_items) {
    std::vector<WebLookupItem> out;
    const auto trimmed = trim_copy(body);
    if (trimmed.empty() || max_items == 0) return out;
    const auto fmt = normalize_custom_format(format);
    const std::string fallback_label = source_label.empty()
        ? infer_source_label(source_tag, request_url)
        : std::string(source_label);

    auto try_rss_or_atom = [&]() -> bool {
        if (trimmed.find("<item") != std::string::npos) {
            std::size_t pos = 0;
            while (out.size() < max_items) {
                const auto start = trimmed.find("<item", pos);
                if (start == std::string::npos) break;
                const auto gt = trimmed.find('>', start);
                if (gt == std::string::npos) break;
                const auto end = trimmed.find("</item>", gt + 1);
                if (end == std::string::npos) break;
                const auto block = std::string_view(trimmed).substr(gt + 1, end - (gt + 1));
                pos = end + 7;
                const auto title = clip_utf8(extract_xml_tag(block, "title"), 120);
                const auto desc = clip_utf8(extract_xml_tag(block, "description"), 260);
                const auto url = sanitize_http_url(extract_xml_tag(block, "link"));
                if (title.empty() && desc.empty()) continue;
                out.push_back({std::string(source_tag), fallback_label, title, desc, url.empty() ? sanitize_http_url(request_url) : url});
            }
            return !out.empty();
        }
        if (trimmed.find("<entry") != std::string::npos) {
            std::size_t pos = 0;
            while (out.size() < max_items) {
                const auto start = trimmed.find("<entry", pos);
                if (start == std::string::npos) break;
                const auto gt = trimmed.find('>', start);
                if (gt == std::string::npos) break;
                const auto end = trimmed.find("</entry>", gt + 1);
                if (end == std::string::npos) break;
                const auto block = std::string_view(trimmed).substr(gt + 1, end - (gt + 1));
                pos = end + 8;
                const auto title = clip_utf8(extract_xml_tag(block, "title"), 120);
                auto desc = extract_xml_tag(block, "summary");
                if (desc.empty()) desc = extract_xml_tag(block, "content");
                desc = clip_utf8(desc, 260);
                const auto url = sanitize_http_url(extract_atom_link_href(block));
                if (title.empty() && desc.empty()) continue;
                out.push_back({std::string(source_tag), fallback_label, title, desc, url.empty() ? sanitize_http_url(request_url) : url});
            }
            return !out.empty();
        }
        return false;
    };

    auto try_json = [&]() -> bool {
        if (trimmed.front() != '{' && trimmed.front() != '[') return false;
        try {
            const auto parsed = Json::parse(trimmed, kMaxHttpResponseBytes);
            // 1) MediaWiki query.pages / query.search
            if (parsed.is_object()) {
                if (const auto* q = parsed.find("query"); q && q->is_object()) {
                    if (q->find("pages")) {
                        auto wikis = parse_wikipedia_extracts(trimmed, source_tag, max_items);
                        for (auto& w : wikis) {
                            w.source_label = fallback_label;
                            out.push_back(std::move(w));
                        }
                        if (!out.empty()) return true;
                    }
                    if (const auto* sr = q->find("search"); sr && sr->is_array()) {
                        for (const auto& item : sr->as_array()) {
                            if (!item.is_object()) continue;
                            const auto* t = item.find("title");
                            const auto* sn = item.find("snippet");
                            const std::string title = (t && t->is_string()) ? clip_utf8(collapse_spaces(t->as_string()), 120) : "";
                            const std::string snip = (sn && sn->is_string()) ? clip_utf8(strip_html_tags(decode_html_entities(sn->as_string())), 260) : "";
                            if (title.empty() && snip.empty()) continue;
                            out.push_back({std::string(source_tag), fallback_label, title, snip, sanitize_http_url(request_url)});
                            if (out.size() >= max_items) break;
                        }
                        if (!out.empty()) return true;
                    }
                }
            }

            // 2) SearXNG / 通用 JSON 数组（results / items / entries / data / 顶层数组）
            auto extract_from_array = [&](const Json::Array& arr) {
                for (const auto& el : arr) {
                    if (!el.is_object()) continue;
                    auto pick = [&](std::initializer_list<std::string_view> keys) -> std::string {
                        for (auto k : keys) {
                            if (const auto* p = el.find(k); p && p->is_string()) {
                                auto v = collapse_spaces(strip_html_tags(decode_html_entities(p->as_string())));
                                if (!v.empty()) return v;
                            }
                        }
                        return {};
                    };
                    const auto title = clip_utf8(pick({"title", "name", "key"}), 120);
                    const auto snip = clip_utf8(pick({"content", "snippet", "description", "abstract", "summary"}), 260);
                    const auto url = sanitize_http_url(pick({"url", "link", "href"}));
                    if (title.empty() && snip.empty()) continue;
                    out.push_back({std::string(source_tag), fallback_label, title, snip, url.empty() ? sanitize_http_url(request_url) : url});
                    if (out.size() >= max_items) break;
                }
            };

            if (parsed.is_array()) {
                extract_from_array(parsed.as_array());
                return !out.empty();
            }
            if (parsed.is_object()) {
                for (std::string_view key : {"results", "items", "entries", "data"}) {
                    if (const auto* arr = parsed.find(key); arr && arr->is_array()) {
                        extract_from_array(arr->as_array());
                        if (!out.empty()) return true;
                    }
                }
                // 3) 单条对象（如百度百科类 JSON）
                if (auto bk = parse_baidu_baike_card(trimmed)) {
                    bk->source = std::string(source_tag);
                    bk->source_label = fallback_label;
                    if (bk->url.empty()) bk->url = sanitize_http_url(request_url);
                    out.push_back(std::move(*bk));
                    return true;
                }
            }
        } catch (...) {}
        return false;
    };

    auto try_html = [&]() -> bool {
        const auto title = clip_utf8(extract_html_title(trimmed), 120);
        const auto desc = clip_utf8(extract_html_meta_description(trimmed), 280);
        if (looks_like_not_found_title(title)) return false;
        if (title.empty() || desc.empty()) return false;
        out.push_back({std::string(source_tag), fallback_label, title, desc, sanitize_http_url(request_url)});
        return true;
    };

    if (fmt == "rss") {
        (void)try_rss_or_atom();
    } else if (fmt == "json") {
        (void)try_json();
    } else if (fmt == "html") {
        (void)try_html();
    } else {
        if (!try_json()) {
            if (!try_rss_or_atom()) {
                (void)try_html();
            }
        }
    }
    return out;
}

WebLookupResult ChatWebLookupEngine::lookup(std::string_view raw_query,
                                            std::stop_token stop,
                                            int timeout_ms) {
    WebLookupResult res;
    const auto query = clip_utf8(collapse_spaces(raw_query), 120);
    res.query = query;
    if (query.size() < 2) {
        res.error = "查询词过短";
        return res;
    }

    const std::string cache_key = to_lower_ascii(query);
    const std::int64_t t_now = now_ms();
    WebLookupConfig cfg;
    {
        std::lock_guard lock(impl_->mutex);
        cfg = impl_->config;
        if (auto it = impl_->cache.find(cache_key); it != impl_->cache.end()) {
            if (it->second.expires_at_ms > t_now) {
                auto cached = it->second.result;
                cached.from_cache = true;
                return cached;
            }
            impl_->cache.erase(it);
        }
    }

    const int eff_timeout = std::clamp(timeout_ms, 1000, 6000);
    const std::string direct_bvid = extract_bvid(query);
    const std::string core_query = extract_core_query(query);
    const std::string core_low = to_lower_ascii(core_query);
    const std::string encoded_core = url_encode(core_query);
    const std::string encoded_raw = url_encode(query);
    const bool has_zh = contains_non_ascii(core_query);

    auto fetcher = impl_->http_get;
    struct SourceTaskResult {
        std::vector<WebLookupItem> items;
        std::string error;
    };
    std::vector<std::future<SourceTaskResult>> tasks;

    // 1. 直接识别到 B站 BV 号时，直读公开视频详情（含 UP主、简介、完整 Tags）
    if (cfg.enable_bilibili_detail && !direct_bvid.empty()) {
        const std::string bv_url = "https://api.bilibili.com/x/web-interface/view/detail?bvid=" + direct_bvid;
        tasks.push_back(std::async(std::launch::async, [fetcher, bv_url, direct_bvid, eff_timeout, stop]() {
            SourceTaskResult tr;
            const auto resp = fetcher(bv_url, eff_timeout, stop);
            tr.error = resp.error;
            if (resp.status >= 200 && resp.status < 300 && !resp.body.empty()) {
                if (auto item = parse_bilibili_view_detail(resp.body, direct_bvid)) {
                    tr.items.push_back(std::move(*item));
                }
            }
            return tr;
        }));
    }

    // 2. Bing CN RSS（使用提纯后的核心词；纯 BV 号直查走 B站官方详情接口，避免 Bing 返回无关广告）
    if (cfg.enable_bing && (direct_bvid.empty() || !cfg.enable_bilibili_detail)) {
        const std::string bing_q = direct_bvid.empty() ? encoded_core : url_encode(direct_bvid);
        const std::string bing_url = "https://cn.bing.com/search?q=" + bing_q + "&format=rss";
        tasks.push_back(std::async(std::launch::async, [fetcher, bing_url, eff_timeout, stop]() {
            SourceTaskResult tr;
            const auto resp = fetcher(bing_url, eff_timeout, stop);
            tr.error = resp.error;
            if (resp.status >= 200 && resp.status < 300 && !resp.body.empty()) {
                tr.items = parse_bing_rss(resp.body, 6);
            }
            return tr;
        }));
    }

    // 3. 百度百科公开词条接口（免登录、200ms 秒回中文新梗全貌）
    if (cfg.enable_baike && direct_bvid.empty() && has_zh && core_query.size() <= 48U) {
        const std::string baike_url = "https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=" + encoded_core;
        tasks.push_back(std::async(std::launch::async, [fetcher, baike_url, eff_timeout, stop]() {
            SourceTaskResult tr;
            const auto resp = fetcher(baike_url, eff_timeout, stop);
            tr.error = resp.error;
            if (resp.status >= 200 && resp.status < 300 && !resp.body.empty()) {
                if (auto item = parse_baidu_baike_card(resp.body)) {
                    tr.items.push_back(std::move(*item));
                }
            }
            return tr;
        }));
    }

    // 4. 梗Wiki（cnmeme.wiki，专业中文网络热梗出处与含义）
    if (cfg.enable_cnmeme && direct_bvid.empty() && has_zh && core_query.size() <= 48U) {
        const std::string meme_url = "https://cnmeme.wiki/entry/" + encoded_core;
        tasks.push_back(std::async(std::launch::async, [fetcher, meme_url, eff_timeout, stop]() {
            SourceTaskResult tr;
            const auto resp = fetcher(meme_url, eff_timeout, stop);
            tr.error = resp.error;
            if (resp.status >= 200 && resp.status < 300 && !resp.body.empty()) {
                tr.items = parse_custom_response(resp.body, "cnmeme", "梗Wiki", meme_url, "html", 1);
            }
            return tr;
        }));
    }

    // 5. 中/英文维基百科 API（附带 fullurl）
    if (cfg.enable_wikipedia && direct_bvid.empty()) {
        const std::string wiki_host = has_zh ? "zh.wikipedia.org" : "en.wikipedia.org";
        const std::string wiki_tag = has_zh ? "zhwiki" : "enwiki";
        const std::string wiki_url = "https://" + wiki_host +
            "/w/api.php?action=query&generator=search&gsrsearch=" + encoded_core +
            "&gsrlimit=2&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exchars=240&format=json";
        tasks.push_back(std::async(std::launch::async, [fetcher, wiki_url, wiki_tag, eff_timeout, stop]() {
            SourceTaskResult tr;
            const auto resp = fetcher(wiki_url, eff_timeout, stop);
            tr.error = resp.error;
            if (resp.status >= 200 && resp.status < 300 && !resp.body.empty()) {
                tr.items = parse_wikipedia_extracts(resp.body, wiki_tag, 2);
            }
            return tr;
        }));
    }

    // 6. 用户自定义的公开搜索地址模板（最多并发执行 6 条已启用源）
    std::size_t custom_launched = 0;
    for (const auto& src : cfg.custom_sources) {
        if (!src.enabled || !is_valid_url_template(src.url_template)) continue;
        const std::string target_url = replace_query_placeholder(src.url_template, encoded_core.empty() ? encoded_raw : encoded_core);
        const std::string stag = "custom:" + src.id;
        const std::string slabel = src.name;
        const std::string sfmt = src.format;
        tasks.push_back(std::async(std::launch::async, [fetcher, target_url, stag, slabel, sfmt, eff_timeout, stop]() {
            SourceTaskResult tr;
            const auto resp = fetcher(target_url, eff_timeout, stop);
            tr.error = resp.error;
            if (resp.status >= 200 && resp.status < 300 && !resp.body.empty()) {
                tr.items = parse_custom_response(resp.body, stag, slabel, target_url, sfmt, 3);
            }
            return tr;
        }));
        if (++custom_launched >= kMaxConcurrentCustomSources) break;
    }

    std::vector<WebLookupItem> merged;
    std::string first_err;
    for (auto& fut : tasks) {
        auto tr = fut.get();
        if (first_err.empty() && !tr.error.empty()) first_err = tr.error;
        merged.insert(merged.end(), std::make_move_iterator(tr.items.begin()), std::make_move_iterator(tr.items.end()));
    }

    // 7. B站视频出处二段快补：若结果中命中了 B站 BV 链接且摘要仅为默认 SEO 模板，自动穿透拉取 UP主与 Tags
    if (cfg.enable_bilibili_detail && direct_bvid.empty() && !stop.stop_requested()) {
        std::string found_bvid;
        std::size_t found_idx = merged.size();
        for (std::size_t i = 0; i < merged.size(); ++i) {
            if (merged[i].source == "bilibili") continue;
            const auto bv = extract_bvid(merged[i].url);
            if (bv.empty()) continue;
            const bool generic_desc = merged[i].snippet.size() < 48U ||
                merged[i].snippet.find("点击前往哔哩哔哩") != std::string::npos ||
                merged[i].snippet.find("更多实用攻略教学") != std::string::npos ||
                merged[i].snippet.find("视频播放量") != std::string::npos;
            if (generic_desc) {
                found_bvid = bv;
                found_idx = i;
                break;
            }
        }
        if (!found_bvid.empty() && found_idx < merged.size()) {
            const int enrich_timeout = std::min(eff_timeout, 1500);
            const std::string bv_url = "https://api.bilibili.com/x/web-interface/view/detail?bvid=" + found_bvid;
            const auto resp = fetcher(bv_url, enrich_timeout, stop);
            if (resp.status >= 200 && resp.status < 300 && !resp.body.empty()) {
                if (auto enriched = parse_bilibili_view_detail(resp.body, found_bvid)) {
                    merged[found_idx] = std::move(*enriched);
                }
            }
        }
    }

    if (merged.empty()) {
        res.ok = false;
        res.error = !first_err.empty() ? first_err : "no_results";
        res.summary = "未查到关于「" + query + "」的公开资料，请勿瞎编，按人设坦诚向用户求科普。";
        return res;
    }

    const auto tokens = tokenize_query(core_query);
    std::stable_sort(merged.begin(), merged.end(), [&](const WebLookupItem& a, const WebLookupItem& b) {
        return score_item_relevance(a, tokens, cache_key, core_low, cfg.priority_domains) >
               score_item_relevance(b, tokens, cache_key, core_low, cfg.priority_domains);
    });

    // 去重（按标准化标题前缀与 URL）并保留前 5 条高信噪比结果
    std::set<std::string> seen_titles;
    std::set<std::string> seen_urls;
    std::vector<WebLookupItem> final_items;
    for (auto& item : merged) {
        if (item.source_label.empty()) {
            item.source_label = infer_source_label(item.source, item.url);
        }
        const auto tk = to_lower_ascii(clip_utf8(item.title, 36));
        const auto uk = to_lower_ascii(item.url);
        if (!uk.empty() && !seen_urls.insert(uk).second) continue;
        if (!tk.empty() && !seen_titles.insert(tk).second) continue;
        final_items.push_back(std::move(item));
        if (final_items.size() >= 5) break;
    }

    std::string summary = "联网参考摘要（关键词「" + query + "」，请用自己的人设自然消化接梗，可顺口提及出处来源，禁止机械背诵或列清单）：\n";
    for (const auto& it : final_items) {
        std::string line = "- [" + it.source_label + "] " + it.title;
        if (!it.snippet.empty()) line += "：" + it.snippet;
        if (!it.url.empty()) line += " (" + it.url + ")";
        line += "\n";
        if (summary.size() + line.size() > 1600U) break;
        summary += line;
    }

    res.ok = true;
    res.items = std::move(final_items);
    res.summary = std::move(summary);

    {
        std::lock_guard lock(impl_->mutex);
        if (impl_->cache.size() >= kMaxCacheEntries) {
            for (auto it = impl_->cache.begin(); it != impl_->cache.end();) {
                if (it->second.expires_at_ms <= t_now) it = impl_->cache.erase(it);
                else ++it;
            }
            if (impl_->cache.size() >= kMaxCacheEntries && !impl_->cache.empty()) {
                impl_->cache.erase(impl_->cache.begin());
            }
        }
        impl_->cache[cache_key] = Impl::CacheSlot{res, t_now + kCacheTtlMs};
    }
    return res;
}

// ============================================================================
// LorebookStore
// ============================================================================

struct LorebookStore::Impl {
    fs::path file;
    mutable std::mutex mutex;
    std::vector<LoreEntry> entries;
    std::int64_t last_hit_persist_ms = 0;

    explicit Impl(fs::path data_dir) : file(fs::absolute(std::move(data_dir)) / L"lorebook.json") {
        load_unlocked();
    }

    void load_unlocked() {
        entries.clear();
        std::error_code ec;
        if (!fs::exists(file, ec)) return;
        std::ifstream in(file, std::ios::binary);
        if (!in.good()) return;
        std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        if (bytes.empty() || bytes.size() > kMaxLoreFileBytes) return;
        try {
            const auto doc = Json::parse(bytes, kMaxLoreFileBytes);
            const auto* arr = doc.find("entries");
            if (!arr || !arr->is_array()) return;
            for (const auto& item : arr->as_array()) {
                if (auto parsed = entry_from_json(item)) {
                    if (parsed->id.empty()) parsed->id = random_short_id("lore_");
                    entries.push_back(std::move(*parsed));
                    if (entries.size() >= kMaxLoreEntries) break;
                }
            }
        } catch (...) {}
    }

    void save_unlocked() const {
        A rows;
        for (const auto& e : entries) rows.push_back(entry_to_json(e));
        const Json doc = O{
            {"format", "dimension-lorebook-v1"},
            {"version", 1},
            {"updatedAtMs", static_cast<double>(now_ms())},
            {"entries", std::move(rows)},
        };
        std::error_code ec;
        fs::create_directories(file.parent_path(), ec);
        atomic_write_file(file, doc.dump());
    }
};

LorebookStore::LorebookStore(std::filesystem::path data_dir)
    : impl_(std::make_unique<Impl>(std::move(data_dir))) {}

LorebookStore::~LorebookStore() = default;

std::vector<LoreEntry> LorebookStore::match_entries(std::string_view text,
                                                    std::string_view bot_id,
                                                    std::string_view group_id,
                                                    std::size_t max_items) {
    std::vector<LoreEntry> matched;
    if (text.empty() || max_items == 0) return matched;
    const std::string hay = to_lower_ascii(text);

    struct Scored {
        std::size_t idx = 0;
        int score = 0;
    };
    std::vector<Scored> hits;

    std::lock_guard lock(impl_->mutex);
    for (std::size_t i = 0; i < impl_->entries.size(); ++i) {
        const auto& e = impl_->entries[i];
        if (!e.enabled) continue;
        if (!scope_matches(e.scope, bot_id, group_id)) continue;

        int best_score = 0;
        int match_count = 0;
        for (const auto& trig : e.triggers) {
            const auto tk = normalize_trigger_key(trig);
            if (tk.size() < 2) continue;
            if (hay.find(tk) != std::string::npos) {
                ++match_count;
                best_score = std::max(best_score, static_cast<int>(tk.size()) * 3);
            }
        }
        if (match_count > 0) {
            int total = best_score + match_count * 4 + static_cast<int>(std::min<std::uint64_t>(e.hit_count, 20));
            if (e.scope != "global") total += 2; // Slightly prefer bot/group-specific inside jokes
            hits.push_back({i, total});
        }
    }

    if (hits.empty()) return matched;
    std::stable_sort(hits.begin(), hits.end(), [](const Scored& a, const Scored& b) { return a.score > b.score; });

    const std::int64_t t_now = now_ms();
    const std::size_t take = std::min(max_items, hits.size());
    for (std::size_t k = 0; k < take; ++k) {
        auto& e = impl_->entries[hits[k].idx];
        e.hit_count += 1;
        matched.push_back(e);
    }
    if (t_now - impl_->last_hit_persist_ms > 15000) {
        impl_->last_hit_persist_ms = t_now;
        try { impl_->save_unlocked(); } catch (...) {}
    }
    return matched;
}

std::string LorebookStore::match_prompt(std::string_view text,
                                        std::string_view bot_id,
                                        std::string_view group_id,
                                        std::size_t max_items) {
    const auto hits = match_entries(text, bot_id, group_id, max_items);
    if (hits.empty()) return {};
    std::string out = "【已命中的共同梗词典 / 圈内常识（自然融进对话接梗吐槽，严禁生硬背诵定义）】\n";
    for (const auto& e : hits) {
        out += "- 「" + e.title + "」：" + e.meaning;
        if (!e.sticker_id.empty()) {
            out += "（贴切时可顺手发 [sticker:" + e.sticker_id + "]）";
        }
        out += "\n";
    }
    return out;
}

LoreEntry LorebookStore::upsert_entry(const LoreEntry& draft) {
    LoreEntry clean;
    clean.id = trim_copy(draft.id);
    clean.title = clip_utf8(trim_copy(draft.title), 96);
    clean.meaning = clip_utf8(collapse_spaces(draft.meaning), 420);
    if (clean.title.empty() || clean.meaning.empty()) {
        throw std::runtime_error("词条名称与释义不能为空");
    }
    clean.scope = normalize_scope(draft.scope);
    clean.source = normalize_source(draft.source);
    clean.sticker_id = clip_utf8(trim_copy(draft.sticker_id), 64);
    clean.enabled = draft.enabled;

    std::set<std::string> seen;
    for (const auto& raw_t : draft.triggers) {
        const auto t = clip_utf8(trim_copy(raw_t), 64);
        const auto k = normalize_trigger_key(t);
        if (k.size() >= 2 && seen.insert(k).second) {
            clean.triggers.push_back(t);
            if (clean.triggers.size() >= 12) break;
        }
    }
    if (clean.triggers.empty()) {
        clean.triggers.push_back(clean.title);
    }

    const std::int64_t t_now = now_ms();
    std::lock_guard lock(impl_->mutex);

    // Update by ID or merge by normalized title within same scope
    const std::string title_key = normalize_trigger_key(clean.title);
    for (auto& existing : impl_->entries) {
        const bool same_id = !clean.id.empty() && existing.id == clean.id;
        const bool same_title_scope = clean.id.empty() &&
            normalize_trigger_key(existing.title) == title_key && existing.scope == clean.scope;
        if (same_id || same_title_scope) {
            existing.title = clean.title;
            existing.meaning = clean.meaning;
            existing.triggers = clean.triggers;
            existing.scope = clean.scope;
            existing.source = clean.source;
            existing.sticker_id = clean.sticker_id;
            existing.enabled = clean.enabled;
            existing.updated_at_ms = t_now;
            impl_->save_unlocked();
            return existing;
        }
    }

    if (impl_->entries.size() >= kMaxLoreEntries) {
        throw std::runtime_error("梗词典已达 500 条上限，请先清理不再使用的词条");
    }
    if (clean.id.empty()) clean.id = random_short_id("lore_");
    clean.created_at_ms = t_now;
    clean.updated_at_ms = t_now;
    impl_->entries.push_back(clean);
    impl_->save_unlocked();
    return clean;
}

bool LorebookStore::remove_entry(std::string_view id) {
    std::lock_guard lock(impl_->mutex);
    const auto old_sz = impl_->entries.size();
    std::erase_if(impl_->entries, [&](const LoreEntry& e) { return e.id == id; });
    if (impl_->entries.size() == old_sz) return false;
    impl_->save_unlocked();
    return true;
}

std::optional<LoreEntry> LorebookStore::toggle_entry(std::string_view id, bool enabled) {
    std::lock_guard lock(impl_->mutex);
    for (auto& e : impl_->entries) {
        if (e.id == id) {
            e.enabled = enabled;
            e.updated_at_ms = now_ms();
            impl_->save_unlocked();
            return e;
        }
    }
    return std::nullopt;
}

LorebookStore::ImportSummary LorebookStore::import_json(const Json& payload) {
    ImportSummary sum;
    const Json* arr = nullptr;
    if (payload.is_array()) arr = &payload;
    else if (payload.is_object()) arr = payload.find("entries");
    if (!arr || !arr->is_array()) {
        throw std::runtime_error("导入格式无效，需要包含 entries 数组或直接为词条数组");
    }

    std::lock_guard lock(impl_->mutex);
    const std::int64_t t_now = now_ms();
    for (const auto& item : arr->as_array()) {
        auto parsed = entry_from_json(item);
        if (!parsed) { sum.skipped += 1; continue; }
        parsed->source = "imported";
        const auto tk = normalize_trigger_key(parsed->title);
        bool merged = false;
        for (auto& existing : impl_->entries) {
            if (normalize_trigger_key(existing.title) == tk && existing.scope == parsed->scope) {
                existing.meaning = parsed->meaning;
                std::set<std::string> seen;
                for (const auto& t : existing.triggers) seen.insert(normalize_trigger_key(t));
                for (const auto& t : parsed->triggers) {
                    if (seen.insert(normalize_trigger_key(t)).second && existing.triggers.size() < 12) {
                        existing.triggers.push_back(t);
                    }
                }
                if (!parsed->sticker_id.empty()) existing.sticker_id = parsed->sticker_id;
                existing.updated_at_ms = t_now;
                merged = true;
                sum.updated += 1;
                break;
            }
        }
        if (!merged) {
            if (impl_->entries.size() >= kMaxLoreEntries) { sum.skipped += 1; continue; }
            parsed->id = random_short_id("lore_");
            parsed->created_at_ms = t_now;
            parsed->updated_at_ms = t_now;
            impl_->entries.push_back(std::move(*parsed));
            sum.added += 1;
        }
    }
    if (sum.added > 0 || sum.updated > 0) {
        impl_->save_unlocked();
    }
    return sum;
}

Json LorebookStore::export_json() const {
    std::lock_guard lock(impl_->mutex);
    A rows;
    for (const auto& e : impl_->entries) rows.push_back(entry_to_json(e));
    return O{
        {"format", "dimension-lorebook-v1"},
        {"version", 1},
        {"entries", std::move(rows)},
    };
}

Json LorebookStore::list_json() const {
    std::lock_guard lock(impl_->mutex);
    A rows;
    std::size_t enabled_count = 0;
    std::size_t auto_count = 0;
    for (const auto& e : impl_->entries) {
        if (e.enabled) ++enabled_count;
        if (e.source == "auto_learned") ++auto_count;
        rows.push_back(entry_to_json(e));
    }
    return O{
        {"entries", std::move(rows)},
        {"totalCount", static_cast<double>(impl_->entries.size())},
        {"enabledCount", static_cast<double>(enabled_count)},
        {"autoLearnedCount", static_cast<double>(auto_count)},
    };
}

bool LorebookStore::has_learning_cue(std::string_view user_text, std::string_view prev_bot_text) {
    if (user_text.size() < 8 || user_text.size() > 1400) return false;
    const bool user_explains = contains_any(user_text, {
        "的意思是", "指的是", "就是指", "是指", "是个梗", "是一个梗", "热梗", "网络梗",
        "出自", "科普一下", "给你科普", "教你们", "教你个梗", "不是那个意思", "理解错了",
        "黑话", "缩写是", "外号叫", "我们的暗号", "其实就是", "这梗讲的是", "记住这个梗"
    });
    if (user_explains) return true;
    if (!prev_bot_text.empty() && user_text.size() >= 14) {
        const bool bot_asked = contains_any(prev_bot_text, {
            "什么梗", "没听过", "没听说过", "求科普", "给我科普", "断网", "漏课", "啥意思", "什么意思", "不懂这个"
        });
        if (bot_asked) return true;
    }
    return false;
}

LoreAutoLearnResult LorebookStore::auto_learn_from_turn(std::string_view user_text,
                                                        std::string_view prev_bot_text,
                                                        std::string_view bot_id,
                                                        std::string_view group_id,
                                                        const LightModelFn& light_model,
                                                        bool default_global) {
    LoreAutoLearnResult res;
    if (!has_learning_cue(user_text, prev_bot_text)) return res;
    res.triggered = true;

    const std::string target_scope = default_global
        ? std::string("global")
        : (!group_id.empty() ? ("group:" + std::string(group_id))
                             : (!bot_id.empty() ? ("bot:" + std::string(bot_id)) : std::string("global")));

    std::vector<LoreEntry> candidates;
    if (light_model) {
        const std::string sys =
            "你是聊天梗词典与圈内常识提取器。判断用户刚才是否在科普、解释一个梗、黑话、缩写、作品设定或专属暗号。\n"
            "若是，输出纯 JSON 数组（不要 Markdown 代码块，最多 2 条）：\n"
            "[{\"title\":\"梗名/词条名\",\"triggers\":[\"主词\",\"常见别名\"],\"meaning\":\"一句话大白话释义与玩梗用法\"}]\n"
            "若只是普通聊天没有可沉淀的明确词条，输出空数组 []。严禁编造用户没说的内容。";
        std::string usr;
        if (!prev_bot_text.empty()) {
            usr += "AI上一句：" + clip_utf8(prev_bot_text, 240) + "\n";
        }
        usr += "用户解释：" + clip_utf8(user_text, 700);
        try {
            auto raw = trim_copy(light_model(sys, usr));
            // Strip optional markdown fence
            if (raw.starts_with("```")) {
                const auto nl = raw.find('\n');
                if (nl != std::string::npos) raw = raw.substr(nl + 1);
                if (const auto endf = raw.rfind("```"); endf != std::string::npos) raw.resize(endf);
                raw = trim_copy(raw);
            }
            const auto first_br = raw.find('[');
            const auto last_br = raw.rfind(']');
            if (first_br != std::string::npos && last_br != std::string::npos && last_br > first_br) {
                const auto parsed = Json::parse(raw.substr(first_br, last_br - first_br + 1), 65536);
                if (parsed.is_array()) {
                    for (const auto& item : parsed.as_array()) {
                        if (auto e = entry_from_json(item)) {
                            e->scope = target_scope;
                            e->source = "auto_learned";
                            candidates.push_back(std::move(*e));
                            if (candidates.size() >= 2) break;
                        }
                    }
                }
            }
        } catch (...) {}
    }

    if (candidates.empty()) {
        candidates = heuristic_extract_lore(user_text, target_scope);
    }

    for (const auto& cand : candidates) {
        try {
            res.learned.push_back(upsert_entry(cand));
        } catch (...) {}
    }
    return res;
}

} // namespace dimension
