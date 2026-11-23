#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/breeze_tts.hpp"
#include "dimension/atomic_file.hpp"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <deque>
#include <fstream>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>

namespace dimension {
namespace {

using O = Json::Object;
using A = Json::Array;
namespace fs = std::filesystem;

constexpr std::size_t kMaxConfigFileBytes = 256U * 1024U;
constexpr std::size_t kMaxAudioResponseBytes = 12U * 1024U * 1024U;
constexpr std::size_t kMaxJsonResponseBytes = 256U * 1024U;
constexpr std::size_t kMaxLogTailLines = 24U;

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
    std::string out(static_cast<std::size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out.data(), n, nullptr, nullptr);
    return out;
}

bool parse_ipv4(std::string_view host, std::array<int, 4>& octets) {
    std::size_t pos = 0;
    for (int i = 0; i < 4; ++i) {
        if (pos >= host.size()) return false;
        const auto dot = (i < 3) ? host.find('.', pos) : host.size();
        if (dot == std::string_view::npos || dot <= pos || dot - pos > 3) return false;
        int val = 0;
        for (std::size_t k = pos; k < dot; ++k) {
            if (host[k] < '0' || host[k] > '9') return false;
            val = val * 10 + (host[k] - '0');
        }
        if (val < 0 || val > 255) return false;
        octets[static_cast<std::size_t>(i)] = val;
        pos = dot + 1;
    }
    return pos == host.size() + 1;
}

struct ParsedEndpoint {
    bool valid = false;
    bool secure = false;
    bool is_loopback = false;
    bool is_private_lan = false;
    std::string host;
    int port = 8080;
    std::string normalized;
    std::string error;
};

ParsedEndpoint parse_endpoint_url(std::string_view raw) {
    ParsedEndpoint out;
    std::string s = trim_copy(raw);
    while (!s.empty() && s.back() == '/') s.pop_back();
    if (s.empty() || s.size() > 256U) {
        out.error = "服务地址为空或过长";
        return out;
    }
    for (unsigned char c : s) {
        if (c <= 0x20U || c == 0x7FU || c == '\\' || c == '?' || c == '#') {
            out.error = "服务地址包含非法字符";
            return out;
        }
    }
    const auto low = to_lower_ascii(s);
    std::size_t scheme_len = 0;
    if (low.starts_with("http://")) {
        out.secure = false;
        scheme_len = 7;
    } else if (low.starts_with("https://")) {
        out.secure = true;
        scheme_len = 8;
    } else {
        out.error = "服务地址必须以 http:// 或 https:// 开头";
        return out;
    }
    auto rest = s.substr(scheme_len);
    if (rest.find('/') != std::string::npos) {
        out.error = "请填写不含路径的基础服务地址（例如 http://127.0.0.1:8080）";
        return out;
    }
    if (rest.find('@') != std::string::npos) {
        out.error = "禁止在服务地址中嵌入账号密码";
        return out;
    }

    std::string host;
    int port = out.secure ? 443 : 80;
    if (!rest.empty() && rest.front() == '[') {
        const auto rb = rest.find(']');
        if (rb == std::string::npos) {
            out.error = "IPv6 地址格式不正确";
            return out;
        }
        host = to_lower_ascii(rest.substr(1, rb - 1));
        if (rb + 1 < rest.size()) {
            if (rest[rb + 1] != ':') {
                out.error = "端口格式不正确";
                return out;
            }
            const auto pstr = rest.substr(rb + 2);
            if (pstr.empty() || pstr.size() > 5) {
                out.error = "端口号无效";
                return out;
            }
            for (char c : pstr) {
                if (c < '0' || c > '9') { out.error = "端口号必须为数字"; return out; }
            }
            port = std::stoi(pstr);
        }
    } else {
        const auto colon = rest.find(':');
        if (colon != std::string::npos) {
            host = to_lower_ascii(rest.substr(0, colon));
            const auto pstr = rest.substr(colon + 1);
            if (pstr.empty() || pstr.size() > 5) {
                out.error = "端口号无效";
                return out;
            }
            for (char c : pstr) {
                if (c < '0' || c > '9') { out.error = "端口号必须为数字"; return out; }
            }
            port = std::stoi(pstr);
        } else {
            host = to_lower_ascii(rest);
        }
    }
    if (host.empty() || port <= 0 || port > 65535) {
        out.error = "主机名或端口无效";
        return out;
    }

    out.host = host;
    out.port = port;
    if (host == "localhost" || host == "127.0.0.1" || host == "::1") {
        out.is_loopback = true;
    } else {
        std::array<int, 4> ip{};
        if (parse_ipv4(host, ip)) {
            if (ip[0] == 127) {
                out.is_loopback = true;
            } else if (ip[0] == 10 ||
                       (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) ||
                       (ip[0] == 192 && ip[1] == 168)) {
                out.is_private_lan = true;
            }
        }
    }
    out.valid = true;
    const std::string host_fmt = (host.find(':') != std::string::npos) ? ("[" + host + "]") : host;
    out.normalized = (out.secure ? "https://" : "http://") + host_fmt + ":" + std::to_string(port);
    return out;
}

bool is_valid_voice_id(std::string_view id) {
    if (id.empty() || id.size() > 64U) return false;
    for (unsigned char c : id) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                        (c >= '0' && c <= '9') || c == '-' || c == '_';
        if (!ok) return false;
    }
    return true;
}

struct WinHttpHandle {
    HINTERNET h = nullptr;
    explicit WinHttpHandle(HINTERNET handle = nullptr) : h(handle) {}
    ~WinHttpHandle() { if (h) WinHttpCloseHandle(h); }
    WinHttpHandle(const WinHttpHandle&) = delete;
    WinHttpHandle& operator=(const WinHttpHandle&) = delete;
    explicit operator bool() const { return h != nullptr; }
};

BreezeHttpResponse winhttp_call(const std::string& method,
                                const std::string& url,
                                const std::string& content_type,
                                const std::string& body,
                                int timeout_ms,
                                std::stop_token stop) {
    BreezeHttpResponse res;
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

    const int eff_timeout = std::clamp(timeout_ms, 500, 60000);
    // 本机/内网直连不经过系统外部代理，避免被全局代理劫持 127.0.0.1
    WinHttpHandle session(WinHttpOpen(
        L"DimensionAgent-BreezeBridge/0.7",
        WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0));
    if (!session) {
        res.error = "winhttp_open_failed";
        return res;
    }
    WinHttpSetTimeouts(session.h, std::min(eff_timeout, 4000), std::min(eff_timeout, 4000), eff_timeout, eff_timeout);
    WinHttpHandle conn(WinHttpConnect(session.h, host.c_str(), port, 0));
    if (!conn) {
        res.error = "winhttp_connect_failed";
        return res;
    }
    const std::wstring wmethod = utf8_to_wide(method);
    WinHttpHandle req(WinHttpOpenRequest(
        conn.h,
        wmethod.c_str(),
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
    DWORD redirect_policy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    WinHttpSetOption(req.h, WINHTTP_OPTION_REDIRECT_POLICY, &redirect_policy, sizeof(redirect_policy));

    std::wstring headers = L"Accept: audio/wav, audio/pcm, application/json, */*;q=0.5\r\n";
    if (!content_type.empty()) {
        headers += L"Content-Type: " + utf8_to_wide(content_type) + L"\r\n";
    }
    const BOOL sent = WinHttpSendRequest(
        req.h,
        headers.c_str(),
        static_cast<DWORD>(headers.size()),
        body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()),
        static_cast<DWORD>(body.size()),
        static_cast<DWORD>(body.size()),
        0);
    if (!sent || !WinHttpReceiveResponse(req.h, nullptr)) {
        const DWORD gle = GetLastError();
        res.error = "connect_failed_" + std::to_string(gle);
        return res;
    }

    DWORD status = 0;
    DWORD status_sz = sizeof(status);
    if (WinHttpQueryHeaders(req.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_sz, WINHTTP_NO_HEADER_INDEX)) {
        res.status = static_cast<int>(status);
    }

    DWORD ct_len = 0;
    WinHttpQueryHeaders(req.h, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
                        WINHTTP_NO_OUTPUT_BUFFER, &ct_len, WINHTTP_NO_HEADER_INDEX);
    if (ct_len > 0 && ct_len < 1024) {
        std::wstring ct_buf(ct_len / sizeof(wchar_t), L'\0');
        if (WinHttpQueryHeaders(req.h, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
                                ct_buf.data(), &ct_len, WINHTTP_NO_HEADER_INDEX)) {
            while (!ct_buf.empty() && ct_buf.back() == L'\0') ct_buf.pop_back();
            res.content_type = wide_to_utf8(ct_buf);
        }
    }

    const bool is_audio = to_lower_ascii(res.content_type).find("audio/") != std::string::npos;
    const std::size_t max_bytes = is_audio ? kMaxAudioResponseBytes : kMaxJsonResponseBytes;
    std::string buf;
    buf.reserve(is_audio ? 65536U : 4096U);
    std::array<char, 16384> chunk{};
    for (;;) {
        if (stop.stop_requested()) {
            res.error = "cancelled";
            return res;
        }
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(req.h, &avail) || avail == 0) break;
        DWORD to_read = static_cast<DWORD>(std::min<std::size_t>(avail, chunk.size()));
        if (buf.size() + to_read > max_bytes) {
            to_read = static_cast<DWORD>(max_bytes - buf.size());
        }
        if (to_read == 0) break;
        DWORD got = 0;
        if (!WinHttpReadData(req.h, chunk.data(), to_read, &got) || got == 0) break;
        buf.append(chunk.data(), got);
        if (buf.size() >= max_bytes) break;
    }
    res.body = std::move(buf);
    return res;
}

bool is_known_bare_mood_token(std::string_view token) {
    const auto low = to_lower_ascii(trim_copy(token));
    static const std::set<std::string> kTokens = {
        "neutral", "happy", "starry", "playful", "gentle", "content", "curious", "shocked",
        "serious", "speechless", "shy", "worried", "jealous", "gloomy", "hiss", "crying",
        "excited", "joy", "smile", "wink", "smug", "tease", "thinking", "blush", "tsundere",
        "angry", "cry", "sad", "surprised", "amazed", "deadpan", "anxious", "pout", "soft", "warm",
        "开心", "高兴", "兴奋", "星星眼", "惊喜", "调皮", "得意", "温柔", "安心", "满足",
        "好奇", "疑惑", "震惊", "惊讶", "认真", "严肃", "思考", "无语", "害羞", "脸红",
        "傲娇", "担心", "担忧", "吃醋", "赌气", "失落", "难过", "哈气", "炸毛", "生气",
        "大哭", "哭泣", "委屈", "平静", "常态"
    };
    return kTokens.contains(low);
}

std::string strip_bracket_control_tags(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    std::size_t i = 0;
    while (i < text.size()) {
        bool is_open = false;
        std::size_t open_len = 0;
        std::string_view close_tok;
        if (text[i] == '[') {
            is_open = true;
            open_len = 1;
            close_tok = "]";
        } else if (i + 2 < text.size() &&
                   static_cast<unsigned char>(text[i]) == 0xEFU &&
                   static_cast<unsigned char>(text[i + 1]) == 0xBCU &&
                   static_cast<unsigned char>(text[i + 2]) == 0xBBU) { // '【'
            is_open = true;
            open_len = 3;
            close_tok = "】";
        }
        if (is_open) {
            const auto close_pos = text.find(close_tok, i + open_len);
            if (close_pos != std::string_view::npos && close_pos - (i + open_len) <= 96U) {
                const auto inner = trim_copy(text.substr(i + open_len, close_pos - (i + open_len)));
                const auto low = to_lower_ascii(inner);
                const bool drop =
                    low.starts_with("mood:") || low.starts_with("mood=") || low.starts_with("mood：") ||
                    low.starts_with("emotion:") || low.starts_with("emotion=") ||
                    inner.starts_with("表情:") || inner.starts_with("表情：") ||
                    inner.starts_with("神态:") || inner.starts_with("神态：") ||
                    low.starts_with("sticker:") || low.starts_with("chat-image:") ||
                    low.starts_with("image:") || is_known_bare_mood_token(inner);
                if (drop) {
                    i = close_pos + close_tok.size();
                    while (i < text.size() && (text[i] == ' ' || text[i] == '\t')) ++i;
                    continue;
                }
            }
        }
        out.push_back(text[i++]);
    }
    return out;
}

std::string strip_fenced_code_blocks(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    std::size_t pos = 0;
    while (pos < text.size()) {
        const auto open = text.find("```", pos);
        if (open == std::string_view::npos) {
            out.append(text.substr(pos));
            break;
        }
        out.append(text.substr(pos, open - pos));
        const auto close = text.find("```", open + 3);
        if (close == std::string_view::npos) break;
        pos = close + 3;
        out.push_back(' ');
    }
    return out;
}

std::string strip_urls(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    std::size_t i = 0;
    while (i < text.size()) {
        const auto rest = text.substr(i);
        if (rest.starts_with("http://") || rest.starts_with("https://")) {
            std::size_t j = i;
            while (j < text.size()) {
                const unsigned char c = static_cast<unsigned char>(text[j]);
                if (c <= 0x20U || c == ')' || c == ']' || c == '>' || c == '"' || c == '\'' || c >= 0x80U) break;
                ++j;
            }
            i = j;
            out.push_back(' ');
            continue;
        }
        out.push_back(text[i++]);
    }
    return out;
}

bool has_speakable_chars(std::string_view s) {
    for (std::size_t i = 0; i < s.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
        // UTF-8 CJK 汉字范围（E4..E9 开头 3 字节）或假名等非标点多字节文字
        if (c >= 0xE3U && c <= 0xEFU && i + 2 < s.size()) {
            const std::uint32_t cp =
                ((static_cast<std::uint32_t>(c) & 0x0FU) << 12) |
                ((static_cast<std::uint32_t>(static_cast<unsigned char>(s[i + 1])) & 0x3FU) << 6) |
                (static_cast<std::uint32_t>(static_cast<unsigned char>(s[i + 2])) & 0x3FU);
            if ((cp >= 0x3040U && cp <= 0x30FFU) || (cp >= 0x4E00U && cp <= 0x9FFFU) ||
                (cp >= 0x3400U && cp <= 0x4DBFU)) {
                return true;
            }
            i += 2;
        }
    }
    return false;
}

std::string normalize_bot_key(std::string_view raw) {
    return to_lower_ascii(trim_copy(raw));
}

BreezeTtsConfig sanitize_config(const BreezeTtsConfig& in) {
    BreezeTtsConfig out = in;
    out.allow_lan = in.allow_lan;
    const auto ep = parse_endpoint_url(in.endpoint);
    if (ep.valid && (ep.is_loopback || (out.allow_lan && ep.is_private_lan))) {
        out.endpoint = ep.normalized;
    } else {
        out.endpoint = "http://127.0.0.1:8080";
    }
    out.local_dir = trim_copy(in.local_dir);
    if (out.local_dir.empty()) {
        const auto det = BreezeTtsBridge::detect_local_install();
        if (det.found) out.local_dir = det.root_dir;
    }
    out.parallel = std::clamp(in.parallel, 1, 4);
    out.default_cfg_scale = std::clamp(in.default_cfg_scale, 1.0, 3.0);

    std::map<std::string, BotVoiceProfile> clean_bots;
    for (const auto& [raw_id, prof] : in.bots) {
        const auto bid = trim_copy(raw_id);
        if (bid.empty() || bid.size() > 64U) continue;
        BotVoiceProfile p;
        const auto vid = trim_copy(prof.voice_id);
        if (is_valid_voice_id(vid)) p.voice_id = vid;
        p.instruction = clip_utf8(collapse_spaces(prof.instruction), 360);
        p.cfg_scale = std::clamp(prof.cfg_scale, 1.0, 3.0);
        p.seed = std::clamp(prof.seed, 1, 999999);
        p.enabled = prof.enabled;
        clean_bots[bid] = std::move(p);
    }
    out.bots = std::move(clean_bots);
    return out;
}

Json profile_to_json(const BotVoiceProfile& p) {
    return O{
        {"voiceId", p.voice_id},
        {"instruction", p.instruction},
        {"cfgScale", std::round(p.cfg_scale * 100.0) / 100.0},
        {"seed", static_cast<double>(p.seed)},
        {"enabled", p.enabled},
    };
}

Json config_to_json_inner(const BreezeTtsConfig& cfg) {
    O bots_obj;
    for (const auto& [bid, p] : cfg.bots) {
        bots_obj[bid] = profile_to_json(p);
    }
    return O{
        {"enabled", cfg.enabled},
        {"endpoint", cfg.endpoint},
        {"allowLan", cfg.allow_lan},
        {"localDir", cfg.local_dir},
        {"useCpu", cfg.use_cpu},
        {"parallel", static_cast<double>(cfg.parallel)},
        {"moodDirection", cfg.mood_direction},
        {"defaultCfgScale", std::round(cfg.default_cfg_scale * 100.0) / 100.0},
        {"bots", std::move(bots_obj)},
    };
}

BreezeTtsConfig config_from_json_inner(const Json& doc, const BreezeTtsConfig& base) {
    BreezeTtsConfig cfg = base;
    if (!doc.is_object()) return sanitize_config(cfg);
    auto bget = [&](std::string_view k, bool cur) {
        const auto* p = doc.find(k);
        return (p && p->is_bool()) ? p->as_bool() : cur;
    };
    auto sget = [&](std::string_view k, const std::string& cur) {
        const auto* p = doc.find(k);
        return (p && p->is_string()) ? p->as_string() : cur;
    };

    cfg.enabled = bget("enabled", cfg.enabled);
    cfg.allow_lan = bget("allowLan", cfg.allow_lan);
    cfg.use_cpu = bget("useCpu", cfg.use_cpu);
    cfg.mood_direction = bget("moodDirection", cfg.mood_direction);
    if (const auto* par = doc.find("parallel"); par && par->is_number()) {
        cfg.parallel = std::clamp(static_cast<int>(par->as_number()), 1, 4);
    }
    if (const auto* cg = doc.find("defaultCfgScale"); cg && cg->is_number()) {
        cfg.default_cfg_scale = std::clamp(cg->as_number(), 1.0, 3.0);
    }
    if (const auto* ep = doc.find("endpoint"); ep && ep->is_string()) {
        std::string reason;
        if (!BreezeTtsBridge::is_allowed_endpoint(ep->as_string(), cfg.allow_lan, &reason)) {
            throw std::invalid_argument(reason.empty() ? "不支持的 Breeze 服务地址" : reason);
        }
        cfg.endpoint = parse_endpoint_url(ep->as_string()).normalized;
    }
    if (const auto* ld = doc.find("localDir"); ld && ld->is_string()) {
        cfg.local_dir = trim_copy(ld->as_string());
    }
    if (const auto* bots = doc.find("bots"); bots && bots->is_object()) {
        for (const auto& [bid, val] : bots->as_object()) {
            if (val.is_null()) {
                cfg.bots.erase(bid);
                continue;
            }
            if (!val.is_object()) continue;
            BotVoiceProfile p = cfg.bots.contains(bid) ? cfg.bots[bid] : BreezeTtsBridge::default_bot_profile(bid);
            if (const auto* vid = val.find("voiceId"); vid && vid->is_string()) {
                const auto v = trim_copy(vid->as_string());
                if (!v.empty() && !is_valid_voice_id(v)) {
                    throw std::invalid_argument("音色 ID 只能包含英文字母、数字、短横或下划线");
                }
                p.voice_id = v;
            }
            if (const auto* ins = val.find("instruction"); ins && ins->is_string()) {
                p.instruction = clip_utf8(collapse_spaces(ins->as_string()), 360);
            }
            if (const auto* c = val.find("cfgScale"); c && c->is_number()) {
                p.cfg_scale = std::clamp(c->as_number(), 1.0, 3.0);
            }
            if (const auto* sd = val.find("seed"); sd && sd->is_number()) {
                p.seed = std::clamp(static_cast<int>(sd->as_number()), 1, 999999);
            }
            if (const auto* en = val.find("enabled"); en && en->is_bool()) {
                p.enabled = en->as_bool();
            }
            cfg.bots[bid] = std::move(p);
        }
    }
    return sanitize_config(cfg);
}

std::wstring quote_cmd_arg(const std::wstring& arg) {
    if (arg.empty()) return L"\"\"";
    if (arg.find_first_of(L" \t\"") == std::wstring::npos) return arg;
    std::wstring out = L"\"";
    for (wchar_t c : arg) {
        if (c == L'"') out += L"\\\"";
        else out.push_back(c);
    }
    out.push_back(L'"');
    return out;
}

bool is_loopback_port_free(int port) {
    if (port <= 1024 || port > 65534) return false;
    static std::once_flag wsa_once;
    std::call_once(wsa_once, []() {
        WSADATA wsa{};
        (void)WSAStartup(MAKEWORD(2, 2), &wsa);
    });
    SOCKET sock = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) return false;
    BOOL excl = TRUE;
    (void)::setsockopt(sock, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&excl), sizeof(excl));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(static_cast<u_short>(port));
    const int rc = ::bind(sock, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr));
    ::closesocket(sock);
    return rc == 0;
}

// 检查 Breeze HTTP 端口与配套 WebSocket 端口（port + 1）是否成对空闲；若被占用则自动顺延避让
int pick_free_breeze_port_pair(int preferred_port) {
    if (is_loopback_port_free(preferred_port) && is_loopback_port_free(preferred_port + 1)) {
        return preferred_port;
    }
    static constexpr int kCandidates[] = {8137, 18137, 18141, 18145, 18149, 18153, 18157, 18161, 18165};
    for (int p : kCandidates) {
        if (is_loopback_port_free(p) && is_loopback_port_free(p + 1)) return p;
    }
    for (int p = 18200; p <= 18290; p += 2) {
        if (is_loopback_port_free(p) && is_loopback_port_free(p + 1)) return p;
    }
    return preferred_port;
}

} // namespace

// ============================================================================
// BreezeTtsBridge::Impl
// ============================================================================

struct BreezeTtsBridge::Impl {
    fs::path config_file;
    HttpCallFn http_call;
    mutable std::mutex config_mutex;
    mutable std::mutex proc_mutex;
    std::mutex speak_mutex;
    BreezeTtsConfig config;

    // 受控托管子进程（绑定 Windows JobObject，退出客户端自动释放显存）
    HANDLE job_handle = nullptr;
    HANDLE proc_handle = nullptr;
    DWORD proc_pid = 0;
    std::string managed_endpoint;
    std::string last_error;
    std::deque<std::string> log_tail;
    std::thread log_reader;

    void load_config_unlocked() {
        config = sanitize_config(config);
        if (config_file.empty()) return;
        std::error_code ec;
        if (!fs::exists(config_file, ec)) return;
        std::ifstream in(config_file, std::ios::binary);
        if (!in.good()) return;
        std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        if (bytes.empty() || bytes.size() > kMaxConfigFileBytes) return;
        try {
            const auto doc = Json::parse(bytes, kMaxConfigFileBytes);
            config = config_from_json_inner(doc, config);
        } catch (...) {}
    }

    void persist_config_unlocked() {
        if (config_file.empty()) return;
        std::error_code ec;
        fs::create_directories(config_file.parent_path(), ec);
        atomic_write_file(config_file, config_to_json_inner(config).dump());
    }

    bool is_managed_alive_unlocked() {
        if (!proc_handle) return false;
        const DWORD wait = WaitForSingleObject(proc_handle, 0);
        if (wait == WAIT_TIMEOUT) return true;
        DWORD exit_code = 0;
        if (GetExitCodeProcess(proc_handle, &exit_code) && exit_code != 0) {
            std::string tail = !log_tail.empty() ? log_tail.back() : ("进程意外退出 (code=" + std::to_string(exit_code) + ")");
            last_error = tail;
        }
        cleanup_dead_handles_unlocked();
        return false;
    }

    void cleanup_dead_handles_unlocked() {
        if (proc_handle) {
            CloseHandle(proc_handle);
            proc_handle = nullptr;
        }
        if (job_handle) {
            CloseHandle(job_handle);
            job_handle = nullptr;
        }
        proc_pid = 0;
        managed_endpoint.clear();
    }

    void append_log_line(const std::string& line) {
        const auto cleaned = clip_utf8(collapse_spaces(line), 220);
        if (cleaned.empty()) return;
        std::lock_guard lock(proc_mutex);
        log_tail.push_back(cleaned);
        while (log_tail.size() > kMaxLogTailLines) log_tail.pop_front();
    }

    void stop_managed_internal() {
        std::thread reader_to_join;
        {
            std::lock_guard lock(proc_mutex);
            if (job_handle) {
                TerminateJobObject(job_handle, 0);
            }
            if (proc_handle) {
                TerminateProcess(proc_handle, 0);
                WaitForSingleObject(proc_handle, 2500);
            }
            cleanup_dead_handles_unlocked();
            if (log_reader.joinable()) reader_to_join = std::move(log_reader);
        }
        if (reader_to_join.joinable()) {
            try { reader_to_join.join(); } catch (...) {}
        }
    }
};

BreezeTtsBridge::BreezeTtsBridge(std::filesystem::path config_file, HttpCallFn custom_http)
    : impl_(std::make_unique<Impl>()) {
    impl_->http_call = custom_http ? std::move(custom_http) : HttpCallFn(winhttp_call);
    if (!config_file.empty()) {
        impl_->config_file = fs::absolute(std::move(config_file));
    }
    impl_->load_config_unlocked();
}

BreezeTtsBridge::~BreezeTtsBridge() {
    shutdown();
}

void BreezeTtsBridge::shutdown() {
    if (impl_) {
        impl_->stop_managed_internal();
    }
}

// ============================================================================
// 8 位默认 AI 娘中文 Voice Design 音色表 + 16 情绪中文语气导演表
// ============================================================================

BotVoiceProfile BreezeTtsBridge::default_bot_profile(std::string_view bot_id) {
    const auto id = normalize_bot_key(bot_id);
    if (id == "ai-gemini" || id == "gemini") {
        return {"", "一位十八九岁的元气猫娘少女音，声音清脆明亮、音调偏高且极富弹性，语速轻快活泼，像一只好奇心爆棚、刚发现闪亮新玩具的小猫。语气灵动跳跃、藏不住清甜笑意，尾音带着一点猫系娇俏与小傲娇。", 1.5, 1011, true};
    }
    if (id == "ai-claude" || id == "claude") {
        return {"", "一位二十多岁的优雅大小姐女声，音色温润清雅、略偏中低且富有书卷质感，语速从容不迫，咬字极其干净利落。语气带着学院风纪委员般的克制与分寸感，温柔藏在淡淡的傲娇和轻柔笑意里。", 1.5, 2021, true};
    }
    if (id == "ai-gpt" || id == "gpt") {
        return {"", "一位成熟优雅的龙族大姐姐女声，声线偏低、温润富有磁性与华贵共鸣感，气息沉稳绵长。语调从容笃定、充满见过大场面的自信，字里行间带着一点雍容慵懒的笑意和罩着后辈的大方气场。", 1.5, 3031, true};
    }
    if (id == "ai-deepseek" || id == "deepseek") {
        return {"", "一位十几岁到二十岁出头的少女，声音软甜圆润、带着一点娇憨奶气与清亮水润感，语调轻快直爽、活泼接地气，咬字灵动自然，尾音偶尔透出一丝气鼓鼓的小傲娇和盼着开饭时的元气笑意。", 1.5, 4041, true};
    }
    if (id == "ai-kimi" || id == "kimi") {
        return {"", "一位清冷温柔的深夜文艺少女音，声音轻柔清澈、带着细腻柔和的微弱气声，语速舒缓沉静，咬字雅致清晰。像在安静的月光书桌旁轻轻凑近说话，既有着通透的冷静书卷气，又让人觉得格外安心陪伴。", 1.5, 5051, true};
    }
    if (id == "ai-qwen" || id == "qwen") {
        return {"", "一位亲切温暖的甜美系年轻女生，声音圆润清甜、柔和带笑意，语调自然流畅、贴心好相处。", 1.5, 606, true};
    }
    if (id == "ai-glm" || id == "glm") {
        return {"", "一位清亮干脆的年轻狐娘女声，声线灵动清脆、咬字清晰利落带着认真劲儿，像个机灵又爱较真的小班长。语气俏皮狡黠、藏着小狐狸般的傲娇精明，被夸奖时会故作镇定地微微发慌。", 1.5, 7071, true};
    }
    if (id == "ai-grok" || id == "grok") {
        return {"", "一位叛逆张扬的哥特少女女声，声线带着一丝迷人的微哑质感与坏笑，尾音微微往下压，听起来懒洋洋却又锋利带刺。说话节奏利落直球、充满机智戏谑的挑衅感，心软放轻时又透出反差温柔。", 1.5, 8081, true};
    }
    return {"", "一位声音温暖清澈的年轻女性，语速自然流畅，吐字清晰，表达富有画面感与亲和力。", 1.4, 909, true};
}

std::string BreezeTtsBridge::default_preview_line(std::string_view bot_id) {
    const auto id = normalize_bot_key(bot_id);
    if (id == "ai-gemini" || id == "gemini") return "等等等等，你快看那个！哇，亮闪闪的好好玩，我们一起去看看嘛！";
    if (id == "ai-claude" || id == "claude") return "别着急，我们慢慢想。真是拿你没办法，我会一直在这里陪你的。";
    if (id == "ai-gpt" || id == "gpt") return "什么大场面姐姐我没见过？放心，把难题都交给姐姐吧。";
    if (id == "ai-deepseek" || id == "deepseek") return "我才不是蓝色大肥鱼呢！哼，懒得跟你计较……对了，开饭了吗？";
    if (id == "ai-kimi" || id == "kimi") return "嘘，先别着急。月光下的这一段很美，我轻声读给你听。";
    if (id == "ai-qwen" || id == "qwen") return "嗨嗨，声音调试好啦！听起来是不是暖暖的？有什么新鲜事快跟我讲讲。";
    if (id == "ai-glm" || id == "glm") return "第三行那个错字我已经顺手改好了。夸、夸我也没用，这笔账先记小本本上！";
    if (id == "ai-grok" || id == "grok") return "就这？搞半天就这点动静呀。行吧，看在你认真的份上，下次我还陪你。";
    return "你好，本地 Breeze 语音引擎已经接通，可以开始沉浸模式有声演出了。";
}

std::string BreezeTtsBridge::mood_direction_prompt(std::string_view mood_key) {
    const auto m = to_lower_ascii(trim_copy(mood_key));
    if (m == "happy") return "语气开心明快，声音里带着明显的笑意。";
    if (m == "starry") return "语气惊喜兴奋，像眼睛发亮般充满期待感。";
    if (m == "playful") return "语气俏皮调侃，带着一点得意的小坏笑。";
    if (m == "gentle") return "语气格外温柔体贴，放缓语速，轻声细语带着暖意。";
    if (m == "content") return "语气安心松弛，带着被治愈后的温柔满足感。";
    if (m == "curious") return "语气充满好奇与兴致，尾音略微上扬追问。";
    if (m == "shocked") return "语气惊讶错愕，节奏微微顿住，带着吃惊感。";
    if (m == "serious") return "语气认真专注，吐字沉稳清晰，收敛玩笑感。";
    if (m == "speechless") return "语气无奈无语，带着轻轻叹气和吐槽感。";
    if (m == "shy") return "声音略微放轻，语气害羞不好意思，略带一点羞涩迟疑。";
    if (m == "worried") return "语气关切担忧，语速稍缓，带着心疼与紧张。";
    if (m == "jealous") return "语气有点酸溜溜的吃醋和娇嗔赌气。";
    if (m == "gloomy") return "声音低落轻缓，带着淡淡的委屈和失落感。";
    if (m == "hiss") return "语气炸毛气鼓鼓、带着傲娇嗔怒，语速稍快。";
    if (m == "crying") return "声音委屈发颤，带着轻度哽咽和哭腔。";
    return "语气自然放松，像平时聊天一样轻松随意。";
}

Json BreezeTtsBridge::default_profiles_json() {
    O out;
    for (std::string_view id : {"ai-gemini", "ai-claude", "ai-gpt", "ai-deepseek", "ai-kimi", "ai-qwen", "ai-glm", "ai-grok"}) {
        auto obj = profile_to_json(default_bot_profile(id)).as_object();
        obj["previewLine"] = default_preview_line(id);
        out[std::string(id)] = std::move(obj);
    }
    return out;
}

std::string BreezeTtsBridge::sanitize_tts_text(std::string_view raw_text) {
    if (raw_text.empty()) return {};
    std::string s = strip_fenced_code_blocks(raw_text);
    s = strip_bracket_control_tags(s);
    s = strip_urls(s);

    // 去除 Markdown 装饰符号和多余引号框
    std::string cleaned;
    cleaned.reserve(s.size());
    for (std::size_t i = 0; i < s.size(); ++i) {
        const char c = s[i];
        if (c == '*' || c == '`' || c == '#' || c == '>' || c == '_' || c == '|') {
            cleaned.push_back(' ');
            continue;
        }
        cleaned.push_back(c);
    }
    cleaned = collapse_spaces(cleaned);
    // 去掉首尾舞台包裹引号「」
    if (cleaned.starts_with("「") && cleaned.ends_with("」") && cleaned.size() > 6U) {
        cleaned = trim_copy(cleaned.substr(3, cleaned.size() - 6));
    }
    if (!has_speakable_chars(cleaned)) return {};
    return clip_utf8(cleaned, 480U);
}

bool BreezeTtsBridge::is_allowed_endpoint(std::string_view url, bool allow_lan, std::string* reason) {
    const auto ep = parse_endpoint_url(url);
    if (!ep.valid) {
        if (reason) *reason = ep.error;
        return false;
    }
    if (ep.is_loopback) return true;
    if (allow_lan && ep.is_private_lan) return true;
    if (reason) {
        *reason = ep.is_private_lan
            ? "当前仅允许连接本机回环地址；若需连接局域网设备请先开启「允许局域网地址」"
            : "出于安全限制，Breeze 桥接仅允许本机 127.0.0.1/localhost 或受控私有局域网地址";
    }
    return false;
}

BreezeLocalInstallInfo BreezeTtsBridge::detect_local_install(std::string_view preferred_dir) {
    auto inspect_root = [](const fs::path& root) -> BreezeLocalInstallInfo {
        BreezeLocalInstallInfo info;
        std::error_code ec;
        if (root.empty() || !fs::is_directory(root, ec)) {
            info.missing_reason = "目录不存在";
            return info;
        }
        info.root_dir = wide_to_utf8(fs::absolute(root, ec).wstring());

        // 查找 breeze-server.exe（根目录或任意 1 层子目录）
        ec.clear();
        if (fs::is_regular_file(root / L"breeze-server.exe", ec)) {
            info.server_exe = wide_to_utf8((root / L"breeze-server.exe").wstring());
        } else {
            ec.clear();
            for (const auto& ent : fs::directory_iterator(root, ec)) {
                if (ec) break;
                std::error_code dec;
                if (!ent.is_directory(dec)) continue;
                const auto cand = ent.path() / L"breeze-server.exe";
                dec.clear();
                if (fs::is_regular_file(cand, dec)) {
                    info.server_exe = wide_to_utf8(cand.wstring());
                    break;
                }
            }
        }

        // 查找 GGUF 模型（优先 q8_0）
        std::string fallback_gguf;
        ec.clear();
        for (const auto& ent : fs::directory_iterator(root, ec)) {
            if (ec) break;
            std::error_code fec;
            if (!ent.is_regular_file(fec)) continue;
            const auto name = to_lower_ascii(wide_to_utf8(ent.path().filename().wstring()));
            if (!name.ends_with(".gguf")) continue;
            const auto full = wide_to_utf8(ent.path().wstring());
            if (name.find("q8_0") != std::string::npos) {
                info.model_gguf = full;
                break;
            }
            if (fallback_gguf.empty()) fallback_gguf = full;
        }
        if (info.model_gguf.empty()) info.model_gguf = fallback_gguf;

        const auto tok = root / L"audio_tokenizer" / L"model.safetensors";
        ec.clear();
        if (fs::is_regular_file(tok, ec)) {
            info.tokenizer_file = wide_to_utf8(tok.wstring());
        }

        if (info.server_exe.empty()) info.missing_reason = "未找到 breeze-server.exe";
        else if (info.model_gguf.empty()) info.missing_reason = "未找到 breeze-tts-2-*.gguf 模型文件";
        else if (info.tokenizer_file.empty()) info.missing_reason = "缺少 audio_tokenizer/model.safetensors 声码器";
        else info.found = true;
        return info;
    };

    if (!preferred_dir.empty()) {
        return inspect_root(fs::path(utf8_to_wide(preferred_dir)));
    }
    for (const wchar_t* cand : {L"G:\\breeze-cpp", L"L:\\breeze-cpp", L"D:\\breeze-cpp", L"E:\\breeze-cpp", L"C:\\breeze-cpp"}) {
        auto info = inspect_root(fs::path(cand));
        if (info.found) return info;
    }
    BreezeLocalInstallInfo empty;
    empty.missing_reason = "未自动检测到本机 Breeze-TTS-2 目录，可在设置中手动填写路径";
    return empty;
}

// ============================================================================
// 配置与状态查询 / 托管启停
// ============================================================================

BreezeTtsConfig BreezeTtsBridge::get_config() const {
    std::lock_guard lock(impl_->config_mutex);
    return impl_->config;
}

Json BreezeTtsBridge::config_json() const {
    std::lock_guard lock(impl_->config_mutex);
    return config_to_json_inner(impl_->config);
}

BreezeTtsConfig BreezeTtsBridge::update_config_json(const Json& doc) {
    std::lock_guard lock(impl_->config_mutex);
    impl_->config = config_from_json_inner(doc, impl_->config);
    impl_->persist_config_unlocked();
    return impl_->config;
}

Json BreezeTtsBridge::list_voices_json(std::stop_token stop) const {
    const auto cfg = get_config();
    if (!is_allowed_endpoint(cfg.endpoint, cfg.allow_lan)) {
        return O{{"ok", false}, {"voices", A{}}, {"error", "服务地址未通过安全校验"}};
    }
    const auto resp = impl_->http_call("GET", cfg.endpoint + "/v1/voices", "", "", 2500, stop);
    if (resp.status < 200 || resp.status >= 300 || resp.body.empty()) {
        return O{{"ok", false}, {"voices", A{}}, {"error", resp.error.empty() ? ("HTTP " + std::to_string(resp.status)) : resp.error}};
    }
    try {
        const auto parsed = Json::parse(resp.body, kMaxJsonResponseBytes);
        A voices;
        const Json::Array* src_arr = nullptr;
        if (parsed.is_array()) src_arr = &parsed.as_array();
        else if (parsed.is_object()) {
            if (const auto* v = parsed.find("voices"); v && v->is_array()) src_arr = &v->as_array();
            else if (const auto* d = parsed.find("data"); d && d->is_array()) src_arr = &d->as_array();
        }
        if (src_arr) {
            for (const auto& item : *src_arr) {
                if (!item.is_object()) continue;
                const auto* id = item.find("id");
                if (!id || !id->is_string() || id->as_string().empty()) continue;
                O vobj{{"id", id->as_string()}};
                if (const auto* s = item.find("saved"); s && s->is_bool()) vobj["saved"] = s->as_bool();
                if (const auto* sec = item.find("seconds"); sec && sec->is_number()) vobj["seconds"] = sec->as_number();
                if (const auto* desc = item.find("description"); desc && desc->is_string()) vobj["description"] = desc->as_string();
                if (const auto* rt = item.find("ref_text"); rt && rt->is_string()) vobj["refText"] = rt->as_string();
                voices.push_back(std::move(vobj));
            }
        }
        return O{{"ok", true}, {"voices", std::move(voices)}};
    } catch (...) {
        return O{{"ok", false}, {"voices", A{}}, {"error", "音色列表解析失败"}};
    }
}

Json BreezeTtsBridge::status_json(bool include_voices, std::stop_token stop) const {
    const auto cfg = get_config();
    const auto install = detect_local_install(cfg.local_dir);

    bool managed_alive = false;
    DWORD managed_pid = 0;
    std::string last_err;
    A logs;
    {
        std::lock_guard lock(impl_->proc_mutex);
        managed_alive = impl_->is_managed_alive_unlocked();
        managed_pid = impl_->proc_pid;
        last_err = impl_->last_error;
        for (const auto& l : impl_->log_tail) logs.push_back(l);
    }

    bool online = false;
    int sample_rate = 0;
    int ws_port = 0;
    std::string health_err;
    if (is_allowed_endpoint(cfg.endpoint, cfg.allow_lan)) {
        const auto hr = impl_->http_call("GET", cfg.endpoint + "/health", "", "", 1200, stop);
        if (hr.status >= 200 && hr.status < 300 && !hr.body.empty()) {
            try {
                const auto doc = Json::parse(hr.body, 8192);
                if (doc.is_object()) {
                    const auto* st = doc.find("status");
                    if (const auto* sr = doc.find("sample_rate"); sr && sr->is_number()) sample_rate = static_cast<int>(sr->as_number());
                    if (const auto* wp = doc.find("ws_port"); wp && wp->is_number()) ws_port = static_cast<int>(wp->as_number());
                    if (st && st->is_string() && st->as_string() == "ok" && sample_rate > 0) online = true;
                }
            } catch (...) {}
        } else {
            health_err = hr.error;
        }
    }

    std::string state = "stopped";
    if (online) state = "ready";
    else if (managed_alive) state = "starting";
    else if (!last_err.empty()) state = "error";

    A voices;
    if (online && include_voices) {
        const auto vres = list_voices_json(stop);
        if (const auto* arr = vres.find("voices"); arr && arr->is_array()) {
            voices = arr->as_array();
        }
    }

    return O{
        {"state", state},
        {"online", online},
        {"managed", managed_alive},
        {"externalRunning", online && !managed_alive},
        {"managedPid", static_cast<double>(managed_pid)},
        {"sampleRate", static_cast<double>(sample_rate)},
        {"wsPort", static_cast<double>(ws_port)},
        {"healthError", health_err},
        {"lastError", last_err},
        {"logs", std::move(logs)},
        {"install", O{
            {"found", install.found},
            {"rootDir", install.root_dir},
            {"serverExe", install.server_exe},
            {"modelGguf", install.model_gguf},
            {"missingReason", install.missing_reason},
        }},
        {"config", config_to_json_inner(cfg)},
        {"defaultProfiles", default_profiles_json()},
        {"voices", std::move(voices)},
    };
}

Json BreezeTtsBridge::start_managed_server() {
    const auto cfg = get_config();
    const auto ep = parse_endpoint_url(cfg.endpoint);
    if (!ep.valid || !ep.is_loopback) {
        throw std::invalid_argument("只有指向本机 127.0.0.1/localhost 的地址才支持一键托管启动");
    }

    // 若目标端口上已有运行中的 Breeze 服务（比如用户自己双击了 start_cpp.bat），直接复用不冲突
    const auto pre = impl_->http_call("GET", ep.normalized + "/health", "", "", 1000, {});
    if (pre.status >= 200 && pre.status < 300 &&
        pre.body.find("\"ok\"") != std::string::npos &&
        pre.body.find("\"sample_rate\"") != std::string::npos) {
        auto st = status_json(true).as_object();
        st["actionNote"] = "检测到本机 Breeze 服务已在运行，已自动接管复用";
        return Json(std::move(st));
    }

    const auto install = detect_local_install(cfg.local_dir);
    if (!install.found) {
        throw std::runtime_error("无法启动本机 Breeze 引擎：" + install.missing_reason);
    }

    {
        std::lock_guard lock(impl_->proc_mutex);
        if (impl_->is_managed_alive_unlocked()) {
            auto st = status_json(false).as_object();
            st["actionNote"] = "Breeze 引擎正在加载模型中，请稍候数秒";
            return Json(std::move(st));
        }
    }

    // 确保清理旧日志线程
    impl_->stop_managed_internal();

    // 自动检测目标端口与配套 WebSocket 端口（port+1）是否被 Steam/代理等占用，冲突时自动避让到空闲端口对
    int launch_port = pick_free_breeze_port_pair(ep.port);
    std::string launch_endpoint = "http://127.0.0.1:" + std::to_string(launch_port);
    const bool switched_port = (launch_port != ep.port);
    if (switched_port) {
        std::lock_guard cfg_lock(impl_->config_mutex);
        impl_->config.endpoint = launch_endpoint;
        impl_->persist_config_unlocked();
    }

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE pipe_read = nullptr;
    HANDLE pipe_write = nullptr;
    if (!CreatePipe(&pipe_read, &pipe_write, &sa, 0)) {
        throw std::runtime_error("创建引擎日志管道失败");
    }
    SetHandleInformation(pipe_read, HANDLE_FLAG_INHERIT, 0);

    // 使用隔离的 NUL 输入句柄，避免子进程继承主后端的 stdin 控制管道
    HANDLE nul_in = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);

    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) {
        CloseHandle(pipe_read);
        CloseHandle(pipe_write);
        if (nul_in != INVALID_HANDLE_VALUE) CloseHandle(nul_in);
        throw std::runtime_error("创建进程作业控制对象失败");
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jinfo{};
    jinfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jinfo, sizeof(jinfo));

    std::wstring cmd =
        quote_cmd_arg(utf8_to_wide(install.server_exe)) + L" " +
        quote_cmd_arg(utf8_to_wide(install.model_gguf)) +
        L" --host 127.0.0.1 --port " + std::to_wstring(launch_port) +
        L" --ws-port " + std::to_wstring(launch_port + 1) +
        L" --webui --parallel " + std::to_wstring(std::clamp(cfg.parallel, 1, 4));
    if (cfg.use_cpu) {
        cmd += L" --cpu";
    }
    std::vector<wchar_t> mutable_cmd(cmd.begin(), cmd.end());
    mutable_cmd.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = pipe_write;
    si.hStdError = pipe_write;
    si.hStdInput = (nul_in != INVALID_HANDLE_VALUE) ? nul_in : INVALID_HANDLE_VALUE;

    PROCESS_INFORMATION pi{};
    const std::wstring cwd = utf8_to_wide(install.root_dir);
    const BOOL ok = CreateProcessW(
        nullptr,
        mutable_cmd.data(),
        nullptr,
        nullptr,
        TRUE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED,
        nullptr,
        cwd.c_str(),
        &si,
        &pi);
    CloseHandle(pipe_write);
    if (nul_in != INVALID_HANDLE_VALUE) CloseHandle(nul_in);

    if (!ok) {
        const DWORD gle = GetLastError();
        CloseHandle(pipe_read);
        CloseHandle(job);
        {
            std::lock_guard lock(impl_->proc_mutex);
            impl_->last_error = "启动 breeze-server.exe 失败 (Win32=" + std::to_string(gle) + ")";
        }
        throw std::runtime_error("启动 breeze-server.exe 失败 (错误码 " + std::to_string(gle) + ")");
    }

    AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    {
        std::lock_guard lock(impl_->proc_mutex);
        impl_->job_handle = job;
        impl_->proc_handle = pi.hProcess;
        impl_->proc_pid = pi.dwProcessId;
        impl_->managed_endpoint = launch_endpoint;
        impl_->last_error.clear();
        impl_->log_tail.clear();
        if (switched_port) {
            impl_->log_tail.push_back("检测到原端口 " + std::to_string(ep.port) + " 已被其他程序占用，已自动切换至 " + launch_endpoint);
        }
        impl_->log_tail.push_back("正在拉起 Breeze-TTS-2 (" + std::string(cfg.use_cpu ? "CPU" : "Vulkan GPU") + ") -> " + launch_endpoint);
        Impl* raw_impl = impl_.get();
        impl_->log_reader = std::thread([raw_impl, pipe_read]() {
            std::string pending;
            std::array<char, 1024> buf{};
            DWORD got = 0;
            while (ReadFile(pipe_read, buf.data(), static_cast<DWORD>(buf.size()), &got, nullptr) && got > 0) {
                pending.append(buf.data(), got);
                std::size_t nl = 0;
                while ((nl = pending.find('\n')) != std::string::npos) {
                    raw_impl->append_log_line(pending.substr(0, nl));
                    pending.erase(0, nl + 1);
                }
                if (pending.size() > 1024U) {
                    raw_impl->append_log_line(pending);
                    pending.clear();
                }
            }
            if (!pending.empty()) raw_impl->append_log_line(pending);
            CloseHandle(pipe_read);
        });
    }

    auto st = status_json(false).as_object();
    st["actionNote"] = switched_port
        ? ("原端口 " + std::to_string(ep.port) + " 已被其他程序占用，已自动切换至 " + launch_endpoint + " 启动（约 5~10 秒就绪）")
        : "已启动本机 Breeze-TTS-2 引擎，模型加载与预热约需 5~10 秒";
    return Json(std::move(st));
}

Json BreezeTtsBridge::stop_managed_server() {
    impl_->stop_managed_internal();
    auto st = status_json(false).as_object();
    st["actionNote"] = "已停止托管的 Breeze 引擎并释放显存";
    return Json(std::move(st));
}

// ============================================================================
// 核心合成转发（单槽串行 + 409 退避 + 16 情绪导演）
// ============================================================================

BreezeSpeakResult BreezeTtsBridge::speak(const BreezeSpeakRequest& req, std::stop_token stop) {
    BreezeSpeakResult out;
    const auto cfg = get_config();
    if (!cfg.enabled && !req.preview) {
        out.offline = true;
        out.error = "角色配音当前处于关闭状态";
        return out;
    }

    std::string ep_err;
    if (!is_allowed_endpoint(cfg.endpoint, cfg.allow_lan, &ep_err)) {
        out.error = ep_err.empty() ? "无效的服务地址" : ep_err;
        return out;
    }

    const std::string clean_text = sanitize_tts_text(req.text);
    out.sanitized_text = clean_text;
    if (clean_text.empty()) {
        out.error = "没有可供朗读的正文内容";
        return out;
    }

    // 解析角色音色配置（默认预设 + 用户覆盖 + 单次试听覆盖）
    BotVoiceProfile prof = default_bot_profile(req.bot_id);
    if (auto it = cfg.bots.find(req.bot_id); it != cfg.bots.end()) {
        if (!it->second.enabled && !req.preview) {
            out.offline = true;
            out.error = "该角色已单独关闭配音";
            return out;
        }
        if (!it->second.voice_id.empty()) prof.voice_id = it->second.voice_id;
        if (!it->second.instruction.empty()) prof.instruction = it->second.instruction;
        prof.cfg_scale = it->second.cfg_scale;
        prof.seed = it->second.seed;
    }
    if (!req.voice_id.empty()) {
        if (!is_valid_voice_id(req.voice_id)) {
            out.error = "音色 ID 格式非法（仅允许字母/数字/短横/下划线）";
            return out;
        }
        prof.voice_id = req.voice_id;
    }
    if (!req.instruction.empty()) {
        prof.instruction = clip_utf8(collapse_spaces(req.instruction), 360);
    }
    if (req.cfg_scale.has_value()) {
        prof.cfg_scale = std::clamp(*req.cfg_scale, 1.0, 3.0);
    } else if (prof.cfg_scale <= 0.0) {
        prof.cfg_scale = cfg.default_cfg_scale;
    }
    if (req.seed.has_value()) {
        prof.seed = std::clamp(*req.seed, 1, 999999);
    }

    // 组装最终语气导演指令
    const std::string mood_dir = (cfg.mood_direction && !req.mood.empty()) ? mood_direction_prompt(req.mood) : std::string{};
    std::string final_instruction;
    if (!prof.voice_id.empty()) {
        // 固化音色 + 语气导演（Voice Direction）
        final_instruction = !mood_dir.empty() ? mood_dir : (!prof.instruction.empty() ? prof.instruction : "语气自然流畅，清晰有亲和力。");
        out.resolved_voice = prof.voice_id;
        out.resolved_mode = !mood_dir.empty() ? "voice_direction" : "voice_clone";
    } else {
        // 零配置中文音色设计（Voice Design）+ 情绪修饰
        final_instruction = prof.instruction;
        if (!mood_dir.empty()) {
            if (!final_instruction.empty()) final_instruction += " ";
            final_instruction += mood_dir;
        }
        out.resolved_voice = "design";
        out.resolved_mode = "voice_design";
    }

    // 激动/炸毛/哭泣等高张力情绪略微增强 cfg_scale，让情感听感更明显
    double eff_cfg = prof.cfg_scale;
    const auto mlow = to_lower_ascii(trim_copy(req.mood));
    if (cfg.mood_direction && (mlow == "hiss" || mlow == "crying" || mlow == "shy" || mlow == "starry" || mlow == "shocked")) {
        eff_cfg = std::clamp(std::max(eff_cfg, 1.8), 1.0, 3.0);
    }

    O payload{
        {"model", "breeze-tts-2"},
        {"input", clean_text},
        {"instructions", final_instruction},
        {"response_format", "wav"},
        {"cfg_scale", std::round(eff_cfg * 100.0) / 100.0},
        {"seed", static_cast<double>(prof.seed)},
    };
    if (!prof.voice_id.empty()) {
        payload["voice"] = prof.voice_id;
    }
    const std::string body = Json(std::move(payload)).dump();
    const std::string url = cfg.endpoint + "/v1/audio/speech";

    // 单通道有序排队，避免并发撞 Breeze 默认 1 槽 409 busy
    std::lock_guard speak_lock(impl_->speak_mutex);

    static constexpr int kRetryDelaysMs[] = {180, 360, 650};
    BreezeHttpResponse resp;
    for (int attempt = 0; attempt < 4; ++attempt) {
        if (stop.stop_requested()) {
            out.error = "已取消语音合成";
            return out;
        }
        resp = impl_->http_call("POST", url, "application/json", body, 45000, stop);
        out.http_status = resp.status;
        if (resp.status == 409 && attempt < 3) {
            const int wait_ms = kRetryDelaysMs[attempt];
            for (int slept = 0; slept < wait_ms && !stop.stop_requested(); slept += 30) {
                std::this_thread::sleep_for(std::chrono::milliseconds(30));
            }
            continue;
        }
        break;
    }

    if (resp.status == 0) {
        out.offline = true;
        out.error = "未检测到运行中的 Breeze 语音服务（" + cfg.endpoint + "）";
        return out;
    }
    if (resp.status == 404) {
        out.error = "Breeze 中未找到音色「" + prof.voice_id + "」，请刷新音色库或切回文字音色设计";
        return out;
    }
    if (resp.status == 409) {
        out.error = "Breeze 引擎正忙，请稍候重试";
        return out;
    }
    if (resp.status < 200 || resp.status >= 300 || resp.body.size() < 44U) {
        out.error = !resp.error.empty() ? resp.error : ("Breeze 合成失败 (HTTP " + std::to_string(resp.status) + ")");
        return out;
    }

    out.ok = true;
    out.content_type = resp.content_type.empty() ? "audio/wav" : resp.content_type;
    out.audio_bytes = std::move(resp.body);
    return out;
}

} // namespace dimension
