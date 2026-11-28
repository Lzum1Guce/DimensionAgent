#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include "dimension/network_proxy.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>

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

struct SandboxTargetConfig {
    std::filesystem::path wsl_executable;
    std::string distribution;
};

SandboxTargetConfig& sandbox_target_config() {
    static SandboxTargetConfig cfg;
    return cfg;
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

std::wstring quote_win_arg(const std::wstring& arg) {
    if (!arg.empty() && arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) return arg;
    std::wstring out = L"\"";
    for (std::size_t i = 0;; ++i) {
        std::size_t bs = 0;
        while (i < arg.size() && arg[i] == L'\\') { ++i; ++bs; }
        if (i == arg.size()) {
            out.append(bs * 2, L'\\');
            break;
        } else if (arg[i] == L'"') {
            out.append(bs * 2 + 1, L'\\');
            out.push_back(L'"');
        } else {
            out.append(bs, L'\\');
            out.push_back(arg[i]);
        }
    }
    out.push_back(L'"');
    return out;
}

std::filesystem::path resolve_wsl_exe(const std::filesystem::path& configured) {
    std::error_code ec;
    if (!configured.empty() && std::filesystem::is_regular_file(configured, ec)) return configured;
    wchar_t buf[4096]{};
    const DWORD len = SearchPathW(nullptr, L"wsl.exe", nullptr, 4096, buf, nullptr);
    if (len > 0 && len < 4096) {
        std::filesystem::path p(std::wstring_view(buf, len));
        if (std::filesystem::is_regular_file(p, ec)) return p;
    }
    const std::filesystem::path sys32 = L"C:\\Windows\\System32\\wsl.exe";
    if (std::filesystem::is_regular_file(sys32, ec)) return sys32;
    return {};
}

bool parse_proxy_scheme_host_port(std::string_view url,
                                  std::string& out_scheme,
                                  std::string& out_host,
                                  int& out_port) {
    out_scheme.clear();
    out_host.clear();
    out_port = 0;
    const std::string norm = normalize_proxy_url(url);
    const auto sep = norm.find("://");
    if (sep == std::string::npos) return false;
    out_scheme = ascii_lower(norm.substr(0, sep));
    std::string auth = norm.substr(sep + 3U);
    if (const auto slash = auth.find('/'); slash != std::string::npos) auth.resize(slash);
    if (const auto at = auth.rfind('@'); at != std::string::npos) auth = auth.substr(at + 1U);
    if (auth.empty()) return false;
    std::size_t colon = std::string::npos;
    if (auth.front() == '[') {
        const auto rb = auth.find(']');
        if (rb == std::string::npos || rb + 1U >= auth.size() || auth[rb + 1U] != ':') return false;
        out_host = auth.substr(1U, rb - 1U);
        colon = rb + 1U;
    } else {
        colon = auth.rfind(':');
        if (colon == std::string::npos) return false;
        out_host = auth.substr(0, colon);
    }
    const std::string port_s = auth.substr(colon + 1U);
    if (port_s.empty() || port_s.size() > 5U) return false;
    for (unsigned char c : port_s) {
        if (c < '0' || c > '9') return false;
    }
    out_port = std::stoi(port_s);
    return !out_host.empty() && out_port >= 1 && out_port <= 65535;
}

// Built-in zero-config WSL2 NAT loopback proxy bridge:
// Listens on 127.0.0.1:<ephemeral> inside WSL and multiplexes TCP streams over wsl.exe stdio
// straight into Windows host 127.0.0.1:<proxy_port>. Works even when proxy software only binds
// 127.0.0.1 and Windows Firewall blocks all WSL virtual adapter inbound traffic.
class WslProxyBridge {
public:
    static WslProxyBridge& instance() {
        static WslProxyBridge bridge;
        return bridge;
    }

    ~WslProxyBridge() { stop(); }

    std::string ensure_bridge_for(const std::filesystem::path& wsl_cfg,
                                  const std::string& distro,
                                  std::string_view host_proxy_url) {
        if (distro.empty() || host_proxy_url.empty()) {
            stop();
            return {};
        }
        std::string scheme, host;
        int port = 0;
        if (!parse_proxy_scheme_host_port(host_proxy_url, scheme, host, port)) {
            stop();
            return {};
        }
        const std::filesystem::path wsl_exe = resolve_wsl_exe(wsl_cfg);
        if (wsl_exe.empty()) return {};

        const std::string desired_key = distro + "|" + scheme + "|" + host + "|" + std::to_string(port);
        {
            std::lock_guard lk(mu_);
            if (active_ && desired_key == active_key_ && wsl_listen_port_ > 0 && is_process_running_locked()) {
                return scheme + "://127.0.0.1:" + std::to_string(wsl_listen_port_);
            }
        }

        stop();

        std::lock_guard start_lk(start_mu_);
        {
            std::lock_guard lk(mu_);
            if (active_ && desired_key == active_key_ && wsl_listen_port_ > 0 && is_process_running_locked()) {
                return scheme + "://127.0.0.1:" + std::to_string(wsl_listen_port_);
            }
        }

        ensure_wsa_initialized();
        if (!start_bridge(wsl_exe, distro, scheme, host, port, desired_key)) {
            stop();
            return {};
        }
        std::lock_guard lk(mu_);
        if (active_ && wsl_listen_port_ > 0) {
            return scheme + "://127.0.0.1:" + std::to_string(wsl_listen_port_);
        }
        return {};
    }

    void stop() {
        HANDLE proc = nullptr;
        HANDLE job = nullptr;
        std::jthread reader;
        std::jthread err_drainer;
        std::map<std::uint32_t, std::shared_ptr<Conn>> conns_copy;
        {
            std::lock_guard lk(mu_);
            active_ = false;
            wsl_listen_port_ = 0;
            active_key_.clear();
            {
                std::lock_guard wlk(write_mu_);
                if (in_write_) { CloseHandle(in_write_); in_write_ = nullptr; }
            }
            proc = proc_h_;
            job = job_h_;
            reader = std::move(stdout_reader_);
            err_drainer = std::move(stderr_drainer_);
        }
        {
            std::lock_guard clk(conns_mu_);
            conns_copy.swap(conns_);
        }
        for (auto& [_, c] : conns_copy) {
            c->close_socket();
        }
        for (auto& [_, c] : conns_copy) {
            if (c->reader.joinable()) c->reader.join();
        }
        if (job) TerminateJobObject(job, 0);
        else if (proc) TerminateProcess(proc, 0);
        if (proc) WaitForSingleObject(proc, 500);
        if (reader.joinable()) {
            CancelSynchronousIo(static_cast<HANDLE>(reader.native_handle()));
            reader.join();
        }
        if (err_drainer.joinable()) {
            CancelSynchronousIo(static_cast<HANDLE>(err_drainer.native_handle()));
            err_drainer.join();
        }
        std::lock_guard lk(mu_);
        if (out_read_) { CloseHandle(out_read_); out_read_ = nullptr; }
        if (err_read_) { CloseHandle(err_read_); err_read_ = nullptr; }
        if (proc_h_) { CloseHandle(proc_h_); proc_h_ = nullptr; }
        if (job_h_) { CloseHandle(job_h_); job_h_ = nullptr; }
    }

private:
    struct Conn {
        std::mutex sock_mu;
        SOCKET sock = INVALID_SOCKET;
        std::thread reader;
        void close_socket() {
            std::lock_guard lk(sock_mu);
            if (sock != INVALID_SOCKET) {
                shutdown(sock, SD_BOTH);
                closesocket(sock);
                sock = INVALID_SOCKET;
            }
        }
    };

    static void ensure_wsa_initialized() {
        static const bool ok = []() {
            WSADATA wsa{};
            return WSAStartup(MAKEWORD(2, 2), &wsa) == 0;
        }();
        (void)ok;
    }

    bool is_process_running_locked() const {
        return proc_h_ && WaitForSingleObject(proc_h_, 0) == WAIT_TIMEOUT;
    }

    static void encode_be32(unsigned char* p, std::uint32_t v) {
        p[0] = static_cast<unsigned char>((v >> 24) & 0xFFU);
        p[1] = static_cast<unsigned char>((v >> 16) & 0xFFU);
        p[2] = static_cast<unsigned char>((v >> 8) & 0xFFU);
        p[3] = static_cast<unsigned char>(v & 0xFFU);
    }

    static std::uint32_t decode_be32(const unsigned char* p) {
        return (static_cast<std::uint32_t>(p[0]) << 24) |
               (static_cast<std::uint32_t>(p[1]) << 16) |
               (static_cast<std::uint32_t>(p[2]) << 8) |
               static_cast<std::uint32_t>(p[3]);
    }

    bool send_frame(std::uint8_t type, std::uint32_t conn_id, const char* data, std::uint32_t len) {
        std::vector<char> frame(9U + len);
        frame[0] = static_cast<char>(type);
        encode_be32(reinterpret_cast<unsigned char*>(frame.data() + 1), conn_id);
        encode_be32(reinterpret_cast<unsigned char*>(frame.data() + 5), len);
        if (len > 0 && data) {
            std::memcpy(frame.data() + 9, data, len);
        }
        std::lock_guard lk(write_mu_);
        if (!in_write_) return false;
        const char* buf = frame.data();
        std::size_t rem = frame.size();
        while (rem > 0) {
            DWORD written = 0;
            const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(rem, 65536U));
            if (!WriteFile(in_write_, buf, chunk, &written, nullptr) || written == 0) return false;
            buf += written;
            rem -= written;
        }
        return true;
    }

    bool start_bridge(const std::filesystem::path& wsl_exe,
                      const std::string& distro,
                      const std::string& scheme,
                      const std::string& host,
                      int port,
                      const std::string& desired_key) {
        static constexpr const char* kNodeBridgeScript =
            "const net=require('net');"
            "const conns=new Map();let nextId=1;"
            "function send(t,id,buf){const l=buf?buf.length:0;const f=Buffer.allocUnsafe(9+l);f[0]=t;f.writeUInt32BE(id>>>0,1);f.writeUInt32BE(l>>>0,5);if(l)buf.copy(f,9);process.stdout.write(f);}"
            "let ib=Buffer.alloc(0);"
            "process.stdin.on('data',(c)=>{ib=ib.length?Buffer.concat([ib,c]):c;let off=0;while(ib.length-off>=9){const t=ib[off],id=ib.readUInt32BE(off+1),l=ib.readUInt32BE(off+5);if(ib.length-off<9+l)break;const p=l?ib.subarray(off+9,off+9+l):null;off+=9+l;const s=conns.get(id);if(!s)continue;if(t===2&&p){try{s.write(p);}catch{}}else if(t===3){try{s.end();}catch{}}else if(t===4){conns.delete(id);try{s.destroy();}catch{}}}ib=off>=ib.length?Buffer.alloc(0):ib.subarray(off);});"
            "process.stdin.on('end',()=>process.exit(0));"
            "const srv=net.createServer((s)=>{s.setNoDelay(true);const id=nextId++;conns.set(id,s);send(1,id,null);"
            "s.on('data',(d)=>{for(let o=0;o<d.length;o+=32768)send(2,id,d.subarray(o,o+32768));});"
            "s.on('end',()=>send(3,id,null));"
            "s.on('error',()=>{});"
            "s.on('close',()=>{if(conns.delete(id))send(4,id,null);});});"
            "srv.listen(0,'127.0.0.1',()=>{const p=srv.address().port;process.stdout.write(Buffer.from('DPRX'));send(0,p,null);});";

        std::wstring cmd = quote_win_arg(wsl_exe.wstring())
            + L" -d " + quote_win_arg(utf8_to_wide(distro))
            + L" -u root --exec /usr/bin/node -e " + quote_win_arg(utf8_to_wide(kNodeBridgeScript));

        SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE out_r = nullptr, out_w = nullptr, err_r = nullptr, err_w = nullptr, in_r = nullptr, in_w = nullptr;
        if (!CreatePipe(&out_r, &out_w, &sa, 0)) return false;
        if (!CreatePipe(&err_r, &err_w, &sa, 0)) { CloseHandle(out_r); CloseHandle(out_w); return false; }
        if (!CreatePipe(&in_r, &in_w, &sa, 0)) {
            CloseHandle(out_r); CloseHandle(out_w); CloseHandle(err_r); CloseHandle(err_w); return false;
        }
        SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(in_w, HANDLE_FLAG_INHERIT, 0);

        HANDLE job = CreateJobObjectW(nullptr, nullptr);
        if (job) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
            jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
        }

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        si.hStdInput = in_r;
        si.hStdOutput = out_w;
        si.hStdError = err_w;

        std::vector<wchar_t> mutable_cmd(cmd.begin(), cmd.end());
        mutable_cmd.push_back(L'\0');
        PROCESS_INFORMATION pi{};
        const BOOL ok = CreateProcessW(nullptr, mutable_cmd.data(), nullptr, nullptr, TRUE,
                                       CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP,
                                       nullptr, nullptr, &si, &pi);
        CloseHandle(in_r);
        CloseHandle(out_w);
        CloseHandle(err_w);
        if (!ok) {
            CloseHandle(in_w); CloseHandle(out_r); CloseHandle(err_r);
            if (job) CloseHandle(job);
            return false;
        }

        if (job) AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);

        {
            std::lock_guard lk(mu_);
            job_h_ = job;
            proc_h_ = pi.hProcess;
            out_read_ = out_r;
            err_read_ = err_r;
            {
                std::lock_guard wlk(write_mu_);
                in_write_ = in_w;
            }
            target_scheme_ = scheme;
            target_host_ = host;
            target_port_ = port;
            active_key_ = desired_key;
            wsl_listen_port_ = 0;
            active_ = true;
            stderr_drainer_ = std::jthread([this, err_r]() {
                char buf[1024];
                DWORD n = 0;
                while (ReadFile(err_r, buf, sizeof(buf), &n, nullptr) && n > 0) {}
            });
            stdout_reader_ = std::jthread([this, out_r]() {
                reader_loop(out_r);
            });
        }

        std::unique_lock lk(ready_mu_);
        const bool got_ready = ready_cv_.wait_for(lk, std::chrono::seconds(8), [&]() {
            std::lock_guard slk(mu_);
            return !active_ || wsl_listen_port_ > 0;
        });
        std::lock_guard slk(mu_);
        return got_ready && active_ && wsl_listen_port_ > 0;
    }

    void reader_loop(HANDLE out_r) {
        auto read_exact = [&](unsigned char* dst, std::size_t need) -> bool {
            std::size_t got_total = 0;
            while (got_total < need) {
                DWORD n = 0;
                if (!ReadFile(out_r, dst + got_total, static_cast<DWORD>(need - got_total), &n, nullptr) || n == 0) {
                    return false;
                }
                got_total += n;
            }
            return true;
        };

        static constexpr unsigned char kMagic[4] = {'D', 'P', 'R', 'X'};
        std::size_t matched = 0;
        unsigned char b = 0;
        while (matched < 4U) {
            DWORD n = 0;
            if (!ReadFile(out_r, &b, 1, &n, nullptr) || n == 0) {
                {
                    std::lock_guard lk(mu_);
                    active_ = false;
                }
                ready_cv_.notify_all();
                return;
            }
            if (b == kMagic[matched]) {
                ++matched;
            } else {
                matched = (b == kMagic[0]) ? 1U : 0U;
            }
        }

        unsigned char hdr[9];
        std::vector<char> payload;
        while (read_exact(hdr, sizeof(hdr))) {
            const std::uint8_t type = hdr[0];
            const std::uint32_t conn_id = decode_be32(hdr + 1);
            const std::uint32_t len = decode_be32(hdr + 5);
            if (len > 4U * 1024U * 1024U) break;
            payload.resize(len);
            if (len > 0 && !read_exact(reinterpret_cast<unsigned char*>(payload.data()), len)) {
                break;
            }

            if (type == 0) {
                {
                    std::lock_guard lk(mu_);
                    wsl_listen_port_ = static_cast<int>(conn_id);
                }
                ready_cv_.notify_all();
            } else if (type == 1) {
                handle_open(conn_id);
            } else if (type == 2) {
                handle_data(conn_id, payload.data(), len);
            } else if (type == 3) {
                handle_eof(conn_id);
            } else if (type == 4) {
                handle_close(conn_id);
            }
        }

        {
            std::lock_guard lk(mu_);
            active_ = false;
        }
        ready_cv_.notify_all();
    }

    void handle_open(std::uint32_t conn_id) {
        std::string host;
        int port = 0;
        {
            std::lock_guard lk(mu_);
            host = target_host_;
            port = target_port_;
        }
        SOCKET s = INVALID_SOCKET;
        // Fast zero-DNS path for IPv4 loopback (127.0.0.1 / localhost): skips getaddrinfo lock on every burst connection.
        if (host == "127.0.0.1" || host == "localhost") {
            SOCKET cand = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
            if (cand != INVALID_SOCKET) {
                BOOL nodelay = TRUE;
                setsockopt(cand, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nodelay), sizeof(nodelay));
                sockaddr_in addr{};
                addr.sin_family = AF_INET;
                addr.sin_port = htons(static_cast<u_short>(port));
                addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
                if (connect(cand, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == 0) {
                    s = cand;
                } else {
                    closesocket(cand);
                }
            }
        }
        if (s == INVALID_SOCKET) {
            addrinfo hints{};
            hints.ai_family = AF_UNSPEC;
            hints.ai_socktype = SOCK_STREAM;
            hints.ai_protocol = IPPROTO_TCP;
            addrinfo* res = nullptr;
            const std::string port_s = std::to_string(port);
            if (getaddrinfo(host.c_str(), port_s.c_str(), &hints, &res) != 0 || !res) {
                (void)send_frame(4, conn_id, nullptr, 0);
                return;
            }
            for (addrinfo* rp = res; rp; rp = rp->ai_next) {
                SOCKET cand = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
                if (cand == INVALID_SOCKET) continue;
                BOOL nodelay = TRUE;
                setsockopt(cand, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nodelay), sizeof(nodelay));
                if (connect(cand, rp->ai_addr, static_cast<int>(rp->ai_addrlen)) == 0) {
                    s = cand;
                    break;
                }
                closesocket(cand);
            }
            freeaddrinfo(res);
        }
        if (s == INVALID_SOCKET) {
            (void)send_frame(4, conn_id, nullptr, 0);
            return;
        }

        auto conn = std::make_shared<Conn>();
        conn->sock = s;
        {
            std::lock_guard clk(conns_mu_);
            conns_[conn_id] = conn;
        }
        conn->reader = std::thread([this, conn_id, conn]() {
            char buf[32768];
            while (true) {
                SOCKET cur_s = INVALID_SOCKET;
                {
                    std::lock_guard slk(conn->sock_mu);
                    cur_s = conn->sock;
                }
                if (cur_s == INVALID_SOCKET) break;
                const int n = recv(cur_s, buf, sizeof(buf), 0);
                if (n > 0) {
                    if (!send_frame(2, conn_id, buf, static_cast<std::uint32_t>(n))) break;
                } else if (n == 0) {
                    (void)send_frame(3, conn_id, nullptr, 0);
                    break;
                } else {
                    (void)send_frame(4, conn_id, nullptr, 0);
                    break;
                }
            }
            conn->close_socket();
        });
    }

    void handle_data(std::uint32_t conn_id, const char* data, std::uint32_t len) {
        std::shared_ptr<Conn> conn;
        {
            std::lock_guard clk(conns_mu_);
            if (auto it = conns_.find(conn_id); it != conns_.end()) conn = it->second;
        }
        if (!conn) return;
        std::lock_guard slk(conn->sock_mu);
        if (conn->sock == INVALID_SOCKET) return;
        std::size_t off = 0;
        while (off < len) {
            const int sent = send(conn->sock, data + off, static_cast<int>(len - off), 0);
            if (sent <= 0) {
                closesocket(conn->sock);
                conn->sock = INVALID_SOCKET;
                (void)send_frame(4, conn_id, nullptr, 0);
                break;
            }
            off += static_cast<std::size_t>(sent);
        }
    }

    void handle_eof(std::uint32_t conn_id) {
        std::shared_ptr<Conn> conn;
        {
            std::lock_guard clk(conns_mu_);
            if (auto it = conns_.find(conn_id); it != conns_.end()) conn = it->second;
        }
        if (!conn) return;
        std::lock_guard slk(conn->sock_mu);
        if (conn->sock != INVALID_SOCKET) {
            shutdown(conn->sock, SD_SEND);
        }
    }

    void handle_close(std::uint32_t conn_id) {
        std::shared_ptr<Conn> conn;
        {
            std::lock_guard clk(conns_mu_);
            if (auto it = conns_.find(conn_id); it != conns_.end()) {
                conn = std::move(it->second);
                conns_.erase(it);
            }
        }
        if (conn) {
            conn->close_socket();
            if (conn->reader.joinable()) conn->reader.detach();
        }
    }

    std::mutex start_mu_;
    std::mutex mu_;
    std::mutex write_mu_;
    std::mutex ready_mu_;
    std::condition_variable ready_cv_;
    bool active_ = false;
    int wsl_listen_port_ = 0;
    std::string active_key_;
    std::string target_scheme_;
    std::string target_host_;
    int target_port_ = 0;
    HANDLE job_h_ = nullptr;
    HANDLE proc_h_ = nullptr;
    HANDLE in_write_ = nullptr;
    HANDLE out_read_ = nullptr;
    HANDLE err_read_ = nullptr;
    std::jthread stdout_reader_;
    std::jthread stderr_drainer_;

    std::mutex conns_mu_;
    std::map<std::uint32_t, std::shared_ptr<Conn>> conns_;
};
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
    Json::Array detected;
    for (const auto& u : detected_local_proxies) detected.emplace_back(u);
    return O{
        {"enabled", enabled},
        {"autoDetect", auto_detect},
        {"autoConfigUrl", auto_config_url},
        {"source", source},
        {"proxyUrl", proxy_url},
        {"httpProxy", http_proxy},
        {"httpsProxy", https_proxy},
        {"bypass", bypass},
        {"detectedLocalProxies", std::move(detected)}
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
    std::ostringstream oss;
    std::size_t pos = 0;
    bool first = true;
    while (pos <= norm.size()) {
        const auto comma = norm.find(',', pos);
        const std::string_view token = (comma == std::string_view::npos)
            ? std::string_view(norm).substr(pos)
            : std::string_view(norm).substr(pos, comma - pos);
        if (!token.empty()) {
            if (!first) oss << ';';
            first = false;
            // WinHttpOpen(WINHTTP_ACCESS_TYPE_NAMED_PROXY) rejects bare IPv6 literals like "::1"
            // with ERROR_INVALID_PARAMETER (87); wrap unbracketed IPv6 literals in "[...]".
            const auto first_colon = token.find(':');
            const bool is_bare_ipv6 = first_colon != std::string_view::npos &&
                                      token.rfind(':') != first_colon &&
                                      token.front() != '[';
            if (is_bare_ipv6) {
                oss << '[' << token << ']';
            } else {
                oss << token;
            }
        }
        if (comma == std::string_view::npos) break;
        pos = comma + 1U;
    }
    if (!first) oss << ';';
    oss << "<local>";
    return oss.str();
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

#ifdef _WIN32
namespace {

bool extract_loopback_port(std::string_view url, int& out_port) {
    const std::string norm = normalize_proxy_url(url);
    if (norm.empty() || !is_loopback_proxy_url(norm)) return false;
    const auto sep = norm.find("://");
    if (sep == std::string::npos) return false;
    std::string auth = norm.substr(sep + 3U);
    if (const auto slash = auth.find('/'); slash != std::string::npos) auth.resize(slash);
    if (const auto at = auth.rfind('@'); at != std::string::npos) auth = auth.substr(at + 1U);
    const auto colon = auth.rfind(':');
    if (colon == std::string::npos || colon + 1U >= auth.size()) return false;
    const std::string ps = auth.substr(colon + 1U);
    if (ps.size() > 5U || !std::all_of(ps.begin(), ps.end(), [](unsigned char c) { return c >= '0' && c <= '9'; })) {
        return false;
    }
    const int p = std::stoi(ps);
    if (p < 1 || p > 65535) return false;
    out_port = p;
    return true;
}

SOCKET connect_loopback_nonblocking(int port, int timeout_ms) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return INVALID_SOCKET;
    u_long nb = 1;
    ioctlsocket(s, FIONBIO, &nb);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<u_short>(port));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int rc = connect(s, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr));
    if (rc == SOCKET_ERROR) {
        const int err = WSAGetLastError();
        if (err != WSAEWOULDBLOCK && err != WSAEINPROGRESS) {
            closesocket(s);
            return INVALID_SOCKET;
        }
        fd_set wfds, efds;
        FD_ZERO(&wfds);
        FD_ZERO(&efds);
        FD_SET(s, &wfds);
        FD_SET(s, &efds);
        timeval tv{};
        tv.tv_sec = timeout_ms / 1000;
        tv.tv_usec = (timeout_ms % 1000) * 1000;
        const int sel = select(0, nullptr, &wfds, &efds, &tv);
        if (sel <= 0 || FD_ISSET(s, &efds) || !FD_ISSET(s, &wfds)) {
            closesocket(s);
            return INVALID_SOCKET;
        }
        int so_err = 0;
        int so_len = sizeof(so_err);
        if (getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&so_err), &so_len) != 0 || so_err != 0) {
            closesocket(s);
            return INVALID_SOCKET;
        }
    }
    nb = 0;
    ioctlsocket(s, FIONBIO, &nb);
    DWORD io_to = static_cast<DWORD>(std::max(50, timeout_ms));
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&io_to), sizeof(io_to));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&io_to), sizeof(io_to));
    return s;
}

std::string probe_single_loopback_proxy_port(int port) {
    // 1. Test HTTP / mixed proxy via CONNECT handshake (200 / 407 / 502 / 503 / 504 / 403; excludes normal web servers returning 400/404/405).
    {
        SOCKET s = connect_loopback_nonblocking(port, 90);
        if (s == INVALID_SOCKET) return {};
        static constexpr const char kConnectReq[] =
            "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n";
        const int sent = send(s, kConnectReq, static_cast<int>(sizeof(kConnectReq) - 1U), 0);
        char buf[256]{};
        int got = 0;
        if (sent > 0) {
            got = recv(s, buf, static_cast<int>(sizeof(buf) - 1U), 0);
        }
        closesocket(s);
        if (got >= 12) {
            std::string_view resp(buf, static_cast<std::size_t>(got));
            if (resp.starts_with("HTTP/1.1 ") || resp.starts_with("HTTP/1.0 ")) {
                const std::string_view code = resp.substr(9, 3);
                if (code == "200" || code == "407" || code == "502" || code == "503" || code == "504" || code == "403") {
                    return "http://127.0.0.1:" + std::to_string(port);
                }
            }
        }
    }

    // 2. Test pure SOCKS5 proxy handshake (\x05\x01\x00 -> \x05 <method != 0xFF>).
    {
        SOCKET s = connect_loopback_nonblocking(port, 90);
        if (s == INVALID_SOCKET) return {};
        static constexpr unsigned char kSocksHello[3] = {0x05, 0x01, 0x00};
        const int sent = send(s, reinterpret_cast<const char*>(kSocksHello), sizeof(kSocksHello), 0);
        unsigned char resp[8]{};
        int got = 0;
        if (sent == sizeof(kSocksHello)) {
            got = recv(s, reinterpret_cast<char*>(resp), sizeof(resp), 0);
        }
        closesocket(s);
        if (got >= 2 && resp[0] == 0x05 && resp[1] != 0xFF) {
            return "socks5://127.0.0.1:" + std::to_string(port);
        }
    }
    return {};
}

} // namespace
#endif

std::vector<std::string> probe_active_local_proxies(const std::vector<std::string>& priority_urls,
                                                    bool force_refresh) {
#ifdef _WIN32
    static const bool wsa_ok = []() {
        WSADATA wsa{};
        return WSAStartup(MAKEWORD(2, 2), &wsa) == 0;
    }();
    if (!wsa_ok) return {};

    static std::mutex cache_mu;
    static std::vector<std::string> cached_results;
    static std::string cached_priority_sig;
    static std::chrono::steady_clock::time_point cached_at{};

    std::string priority_sig;
    for (const auto& u : priority_urls) {
        priority_sig += u;
        priority_sig.push_back('|');
    }
    const auto now = std::chrono::steady_clock::now();
    if (!force_refresh) {
        std::lock_guard lk(cache_mu);
        if (cached_at.time_since_epoch().count() != 0 &&
            cached_priority_sig == priority_sig &&
            now - cached_at < std::chrono::seconds(5)) {
            return cached_results;
        }
    }

    std::vector<int> ports;
    auto push_port = [&](int p) {
        if (p < 1 || p > 65535) return;
        if (std::find(ports.begin(), ports.end(), p) == ports.end()) {
            ports.push_back(p);
        }
    };
    for (const auto& u : priority_urls) {
        int p = 0;
        if (extract_loopback_port(u, p)) push_port(p);
    }
    // Common desktop proxy client ports (v2rayN, Clash Verge/Mihomo, FlClash, Shadowsocks, NekoRay, Hiddify, v2rayA).
    static constexpr int kCommonPorts[] = {
        10808, 7897, 7890, 10809, 7891, 1080, 1081, 2080, 2081, 10801, 10802, 20171, 20172, 9910, 12334
    };
    for (int p : kCommonPorts) push_port(p);

    std::vector<std::string> slot_results(ports.size());
    std::vector<std::jthread> workers;
    workers.reserve(ports.size());
    for (std::size_t i = 0; i < ports.size(); ++i) {
        workers.emplace_back([port = ports[i], &slot_results, i]() {
            slot_results[i] = probe_single_loopback_proxy_port(port);
        });
    }
    workers.clear(); // Join all probes concurrently (~100-180ms total wall time).

    std::vector<std::string> found;
    for (auto& r : slot_results) {
        if (!r.empty() && std::find(found.begin(), found.end(), r) == found.end()) {
            found.push_back(std::move(r));
        }
    }
    {
        std::lock_guard lk(cache_mu);
        cached_results = found;
        cached_priority_sig = std::move(priority_sig);
        cached_at = std::chrono::steady_clock::now();
    }
    return found;
#else
    (void)priority_urls;
    (void)force_refresh;
    return {};
#endif
}

SystemProxyInfo detect_system_proxy_info(bool force_probe) {
    SystemProxyInfo info;
    info.source = "none";
#ifdef _WIN32
    // Ensure startup environment snapshot is captured before any process-env mutation.
    const auto& init_env = startup_env_proxy();
    std::vector<std::string> priority_local_urls;

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
                    priority_local_urls.push_back(info.proxy_url);
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

    // 2. Direct HKCU Internet Settings inspection:
    //    - If ProxyEnable == 1, adopt immediately as windows-registry.
    //    - Even if ProxyEnable == 0 (e.g. proxy client switched to TUN mode), remember ProxyServer as top probe priority!
    {
        HKEY hkey = nullptr;
        if (RegOpenKeyExW(HKEY_CURRENT_USER,
                          L"Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                          0, KEY_READ, &hkey) == ERROR_SUCCESS) {
            DWORD enabled = 0;
            DWORD sz = sizeof(enabled);
            const bool has_enable = (RegQueryValueExW(hkey, L"ProxyEnable", nullptr, nullptr,
                                                      reinterpret_cast<LPBYTE>(&enabled), &sz) == ERROR_SUCCESS);
            wchar_t buf[1024]{};
            DWORD bsz = sizeof(buf);
            const bool has_server = (RegQueryValueExW(hkey, L"ProxyServer", nullptr, nullptr,
                                                      reinterpret_cast<LPBYTE>(buf), &bsz) == ERROR_SUCCESS && buf[0] != L'\0');
            if (has_server) {
                std::string reg_http, reg_https, reg_prim;
                parse_windows_proxy_server_string(wide_to_utf8(buf), reg_http, reg_https, reg_prim);
                if (!reg_prim.empty()) {
                    priority_local_urls.push_back(reg_prim);
                    if (!info.enabled && has_enable && enabled == 1) {
                        info.http_proxy = reg_http;
                        info.https_proxy = reg_https;
                        info.proxy_url = reg_prim;
                        info.enabled = true;
                        info.source = "windows-registry";
                    }
                }
            }
            if (!info.enabled && has_enable && enabled == 1) {
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
                priority_local_urls.push_back(norm);
                if (!init_env.no_proxy.empty()) {
                    info.bypass = normalize_no_proxy_csv(init_env.no_proxy);
                }
            }
        }
    }

    // 4. Probe active local desktop proxies (v2rayN / Clash Verge / Mihomo / etc.) via fast HTTP CONNECT / SOCKS5 handshake.
    //    Always populate detected_local_proxies for UI selection, and auto-adopt when Windows system proxy is off (e.g. TUN mode).
    info.detected_local_proxies = probe_active_local_proxies(priority_local_urls, force_probe);
    if (!info.enabled && !info.detected_local_proxies.empty()) {
        info.enabled = true;
        info.source = "local-probe";
        info.proxy_url = info.detected_local_proxies.front();
        info.http_proxy = info.proxy_url;
        info.https_proxy = info.proxy_url;
    }
#else
    (void)force_probe;
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
        out.summary = "无代理（全软件直连，已屏蔽系统代理与本机代理探测）";
        return out;
    }

    if (out.mode == "global") {
        std::string norm = normalize_proxy_url(settings.proxy_url);
        bool auto_picked = false;
        if (norm.empty()) {
            if (!system_info.proxy_url.empty()) {
                norm = normalize_proxy_url(system_info.proxy_url);
                auto_picked = !norm.empty();
            } else if (!system_info.detected_local_proxies.empty()) {
                norm = normalize_proxy_url(system_info.detected_local_proxies.front());
                auto_picked = !norm.empty();
            }
        }
        if (!norm.empty()) {
            out.use_proxy = true;
            out.use_winhttp_auto = false;
            out.active_proxy_url = norm;
            out.winhttp_proxy_spec = to_winhttp_proxy_spec(norm);
            if (settings.apply_to_sandbox && !is_loopback_proxy_url(norm)) {
                out.sandbox_proxy_url = norm;
            }
            out.summary = auto_picked
                ? ("全局代理（已自动识别可用代理：" + norm + "）")
                : ("全局代理：" + norm);
        } else {
            out.use_proxy = false;
            out.use_winhttp_auto = false;
            out.summary = "全局代理未检测到本机活跃代理，请开启代理软件或手动填写地址";
        }
        return out;
    }

    // mode == "auto"
    out.use_winhttp_auto = true;
    if (system_info.enabled && !system_info.proxy_url.empty()) {
        out.use_proxy = true;
        out.active_proxy_url = system_info.proxy_url;
        out.winhttp_proxy_spec = to_winhttp_proxy_spec(system_info.proxy_url);
        if (system_info.source == "environment" || system_info.source == "local-probe") {
            // WinHTTP AUTOMATIC_PROXY ignores env vars and disabled-IE-switch local proxies, so use NAMED_PROXY directly.
            out.use_winhttp_auto = false;
        }
        if (settings.apply_to_sandbox && !is_loopback_proxy_url(system_info.proxy_url)) {
            out.sandbox_proxy_url = system_info.proxy_url;
        }
        out.summary = (system_info.source == "local-probe")
            ? ("自动代理（已自动识别本机可用代理：" + system_info.proxy_url + "）")
            : ("自动代理（已读取电脑系统代理：" + system_info.proxy_url + "）");
    } else if (system_info.enabled && !system_info.auto_config_url.empty()) {
        out.use_proxy = true;
        out.summary = "自动代理（跟随系统 PAC 脚本：" + system_info.auto_config_url + "）";
    } else if (system_info.auto_detect) {
        out.use_proxy = false;
        out.summary = "自动代理（跟随系统 WPAD 自动检测，当前未检测到活跃代理）";
    } else {
        out.use_proxy = false;
        out.summary = "自动代理（当前未检测到系统代理或本机活跃代理，走直连）";
    }
    return out;
}

NetworkProxySettings get_network_proxy_settings() {
    std::lock_guard lk(state_mutex());
    return global_settings();
}

ResolvedNetworkProxy resolve_active_network_proxy() {
    NetworkProxySettings cur;
    SandboxTargetConfig sb;
    {
        std::lock_guard lk(state_mutex());
        cur = global_settings();
        sb = sandbox_target_config();
    }
    const SystemProxyInfo sys = detect_system_proxy_info(false);
    ResolvedNetworkProxy resolved = resolve_network_proxy(cur, sys);
#ifdef _WIN32
    if (cur.apply_to_sandbox && resolved.use_proxy && !resolved.active_proxy_url.empty() &&
        resolved.sandbox_proxy_url.empty() && is_loopback_proxy_url(resolved.active_proxy_url) &&
        !sb.distribution.empty()) {
        const std::string bridged = WslProxyBridge::instance().ensure_bridge_for(
            sb.wsl_executable, sb.distribution, resolved.active_proxy_url);
        if (!bridged.empty()) {
            resolved.sandbox_proxy_url = bridged;
        }
    } else if (!resolved.use_proxy || !cur.apply_to_sandbox) {
        WslProxyBridge::instance().stop();
    }
#endif
    return resolved;
}

std::uint64_t network_proxy_generation() {
    return g_proxy_generation.load(std::memory_order_acquire);
}

void configure_network_proxy_sandbox(const std::filesystem::path& wsl_executable,
                                     const std::string& sandbox_distribution) {
    std::lock_guard lk(state_mutex());
    sandbox_target_config().wsl_executable = wsl_executable;
    sandbox_target_config().distribution = sandbox_distribution;
}

void shutdown_network_proxy_bridge() {
#ifdef _WIN32
    WslProxyBridge::instance().stop();
#endif
}

ResolvedNetworkProxy apply_network_proxy_settings(const NetworkProxySettings& settings,
                                                  bool force_probe) {
#ifdef _WIN32
    (void)startup_env_proxy();
#endif
    NetworkProxySettings clean = settings;
    if (clean.mode != "global" && clean.mode != "none") clean.mode = "auto";
    clean.proxy_url = normalize_proxy_url(clean.proxy_url);
    clean.bypass = normalize_no_proxy_csv(clean.bypass);
    SandboxTargetConfig sb;
    {
        std::lock_guard lk(state_mutex());
        global_settings() = clean;
        sb = sandbox_target_config();
    }
    g_proxy_generation.fetch_add(1, std::memory_order_acq_rel);

    const SystemProxyInfo sys = detect_system_proxy_info(force_probe);
    ResolvedNetworkProxy resolved = resolve_network_proxy(clean, sys);
#ifdef _WIN32
    sync_process_env_for_resolved(resolved);
    if (clean.apply_to_sandbox && resolved.use_proxy && !resolved.active_proxy_url.empty() &&
        resolved.sandbox_proxy_url.empty() && is_loopback_proxy_url(resolved.active_proxy_url) &&
        !sb.distribution.empty()) {
        const std::string bridged = WslProxyBridge::instance().ensure_bridge_for(
            sb.wsl_executable, sb.distribution, resolved.active_proxy_url);
        if (!bridged.empty()) {
            resolved.sandbox_proxy_url = bridged;
        }
    } else if (!resolved.use_proxy || !clean.apply_to_sandbox || !is_loopback_proxy_url(resolved.active_proxy_url)) {
        WslProxyBridge::instance().stop();
    }
#endif
    return resolved;
}

std::vector<std::pair<std::string, std::string>> build_host_proxy_env_overrides() {
    const auto r = resolve_network_proxy(get_network_proxy_settings(), detect_system_proxy_info(false));
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

namespace {
struct ThreadBotProxyState {
    bool active = false;
    std::string egress_mode;
    std::string proxy_url;
    bool fail_closed = true;
};

thread_local ThreadBotProxyState tls_bot_proxy;
} // namespace

ScopedBotProxyOverride::ScopedBotProxyOverride(bool active,
                                               std::string egress_mode,
                                               std::string proxy_url,
                                               bool fail_closed)
    : active_(active) {
    if (!active_) return;
    prev_active_ = tls_bot_proxy.active;
    prev_mode_ = tls_bot_proxy.egress_mode;
    prev_url_ = tls_bot_proxy.proxy_url;
    prev_fail_closed_ = tls_bot_proxy.fail_closed;
    tls_bot_proxy.active = true;
    tls_bot_proxy.egress_mode = std::move(egress_mode);
    tls_bot_proxy.proxy_url = normalize_proxy_url(proxy_url);
    tls_bot_proxy.fail_closed = fail_closed;
}

ScopedBotProxyOverride::~ScopedBotProxyOverride() {
    if (!active_) return;
    tls_bot_proxy.active = prev_active_;
    tls_bot_proxy.egress_mode = std::move(prev_mode_);
    tls_bot_proxy.proxy_url = std::move(prev_url_);
    tls_bot_proxy.fail_closed = prev_fail_closed_;
}

#ifdef _WIN32
HINTERNET open_configured_winhttp_session(const wchar_t* user_agent, DWORD flags) {
    if (tls_bot_proxy.active) {
        if (tls_bot_proxy.egress_mode == "offline") {
            SetLastError(ERROR_WINHTTP_CANNOT_CONNECT);
            return nullptr;
        }
        const std::string spec = to_winhttp_proxy_spec(tls_bot_proxy.proxy_url);
        if (!spec.empty()) {
            const std::wstring wproxy = utf8_to_wide(spec);
            return WinHttpOpen(user_agent, WINHTTP_ACCESS_TYPE_NAMED_PROXY,
                               wproxy.c_str(), L"localhost;127.0.0.1;[::1];<local>", flags);
        }
        if (tls_bot_proxy.fail_closed) {
            SetLastError(ERROR_WINHTTP_CANNOT_CONNECT);
            return nullptr;
        }
    }
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
