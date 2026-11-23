#define NOMINMAX
#include "dimension/desktop.hpp"
#include "dimension/desktop_homes.hpp"
#include "dimension/workspaces.hpp"
#include "dimension/managed_workspaces.hpp"
#include "dimension/process_session.hpp"
// clang-format off
#include <windows.h>
#include <bcrypt.h>
// clang-format on
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <condition_variable>
#include <fstream>
#include <map>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <thread>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
std::string text(const Json &j, std::string_view key, std::string fallback = {}) {
    auto p = j.find(key);
    return p && p->is_string() ? p->as_string() : fallback;
}
bool boolean(const Json &j, std::string_view key, bool fallback = false) {
    auto p = j.find(key);
    return p && p->is_bool() ? p->as_bool() : fallback;
}
std::string utf8(const fs::path &p) {
    auto u = p.u8string();
    return {reinterpret_cast<const char *>(u.data()), u.size()};
}
fs::path path8(const std::string &s) {
    return fs::path(std::u8string_view(reinterpret_cast<const char8_t *>(s.data()), s.size()));
}
std::wstring wide(const std::string &s) { return path8(s).wstring(); }
std::wstring windows_path(const fs::path &p) {
    auto value = p.lexically_normal().wstring();
    if (value.starts_with(L"\\\\?\\"))
        return value;
    if (value.starts_with(L"\\\\"))
        return L"\\\\?\\UNC\\" + value.substr(2);
    return L"\\\\?\\" + value;
}
std::string unique_id() {
    unsigned char bytes[16]{};
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        throw std::runtime_error("无法创建桌面标识");
    constexpr char hex[] = "0123456789abcdef";
    std::string s;
    for (auto b : bytes) {
        s += hex[b >> 4];
        s += hex[b & 15];
    }
    return s;
}
std::string bot_key(const std::string &id) {
    if (id.empty() || id.size() > 256)
        throw std::runtime_error("Bot 标识无效");
    BCRYPT_ALG_HANDLE alg{};
    BCRYPT_HASH_HANDLE h{};
    unsigned char hash[32]{};
    auto ok = BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0;
    if (ok)
        ok = BCryptCreateHash(alg, &h, nullptr, 0, nullptr, 0, 0) >= 0;
    if (ok)
        ok = BCryptHashData(h, reinterpret_cast<PUCHAR>(const_cast<char *>(id.data())),
                            static_cast<ULONG>(id.size()), 0) >= 0;
    if (ok)
        ok = BCryptFinishHash(h, hash, sizeof(hash), 0) >= 0;
    if (h)
        BCryptDestroyHash(h);
    if (alg)
        BCryptCloseAlgorithmProvider(alg, 0);
    if (!ok)
        throw std::runtime_error("无法定位 Bot 工作区");
    constexpr char hex[] = "0123456789abcdef";
    std::string s = "bot-";
    for (unsigned i = 0; i < 16; ++i) {
        s += hex[hash[i] >> 4];
        s += hex[hash[i] & 15];
    }
    return s;
}
std::string linux_path(const fs::path &p,const std::string& distribution="") {
    if(!distribution.empty())if(const auto key=managed_workspaces::key_from_windows(p,distribution))return managed_workspaces::linux_path(*key);
    auto s = utf8(p.lexically_normal());
    if (s.size() < 3 || s[1] != ':' || (s[2] != '/' && s[2] != '\\') ||
        !std::isalpha(static_cast<unsigned char>(s[0])))
        throw std::runtime_error("当前 WSL 桌面要求本机目录或匹配的托管工作区路径");
    std::replace(s.begin(), s.end(), '\\', '/');
    auto drive = static_cast<char>(std::tolower(static_cast<unsigned char>(s[0])));
    return "/mnt/" + std::string(1, drive) + s.substr(2);
}
void directory(const fs::path &p) {
    const fs::path native(windows_path(p));
    fs::create_directories(native);
    if (!fs::is_directory(native) || fs::is_symlink(fs::symlink_status(native)))
        throw std::runtime_error("桌面目录不能是链接或普通文件");
}
Json read_state(const fs::path &file) {
    const fs::path native(windows_path(file));
    if (!fs::exists(native))
        return O{{"schema", 1},
                 {"apps", A{O{{"id", "chrome"},
                              {"name", "Chrome"},
                              {"executable", "/usr/bin/google-chrome"},
                              {"args", A{}}}}},
                 {"bots", O{}}};
    if (fs::is_symlink(fs::symlink_status(native)) || fs::file_size(native) > 4 * 1024 * 1024)
        throw std::runtime_error("桌面设置文件无效");
    std::ifstream in(native, std::ios::binary);
    std::string s((std::istreambuf_iterator<char>(in)), {});
    auto j = Json::parse(s);
    if (!j.find("schema") || j.at("schema").as_number() != 1 || !j.at("apps").is_array() ||
        !j.at("bots").is_object())
        throw std::runtime_error("桌面设置版本无效");
    return j;
}
void save_state(const fs::path &file, const Json &state) {
    auto serialized = state.dump();
    if (serialized.size() > 4U * 1024U * 1024U)
        throw std::runtime_error("桌面设置超过保存上限，原设置未修改");
    auto tmp = file;
    tmp += L"." + wide(unique_id()) + L".tmp";
    try {
        {
            std::ofstream out(fs::path(windows_path(tmp)), std::ios::binary | std::ios::trunc);
            out.write(serialized.data(), static_cast<std::streamsize>(serialized.size()));
            if (!out)
                throw std::runtime_error("无法保存桌面设置");
        }
        if (!MoveFileExW(windows_path(tmp).c_str(), windows_path(file).c_str(),
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("无法更新桌面设置");
    } catch (...) {
        std::error_code ec;
        fs::remove(fs::path(windows_path(tmp)), ec);
        throw;
    }
}
std::string decode64(const std::string &encoded) {
    static constexpr std::string_view alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (encoded.size() > 3 * 1024 * 1024 || encoded.size() % 4)
        throw std::runtime_error("预览帧大小或编码无效");
    std::string out;
    out.reserve(encoded.size() / 4 * 3);
    unsigned bits = 0, buffer = 0;
    bool pad = false;
    for (char c : encoded) {
        if (c == '=') {
            pad = true;
            continue;
        }
        auto v = alphabet.find(c);
        if (pad || v == alphabet.npos)
            throw std::runtime_error("预览帧编码无效");
        buffer = (buffer << 6) | static_cast<unsigned>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<char>((buffer >> bits) & 255));
        }
    }
    if (out.size() < 4 || static_cast<unsigned char>(out[0]) != 255 ||
        static_cast<unsigned char>(out[1]) != 216)
        throw std::runtime_error("预览未返回 JPEG 图像");
    return out;
}
} // namespace

struct DesktopManager::Impl {
    struct Desktop {
        std::string bot, id, failure;
        // Separate from screenshot identity: stopped desktops also need a
        // state-bound identity for an intentional subsequent launch. This is
        // not a permission token and never survives a manager restart.
        const std::string launch_instance = unique_id();
        unsigned long long launch_revision = 0;
        fs::path folder, home, workspace, preferred_workspace;
        std::string home_linux, home_storage;
        bool network = true, human = false, managed = false;
        std::mutex operation, mutex;
        std::timed_mutex preparing;
        std::atomic_bool home_ready{};
        std::stop_source preparation_stop;
        std::condition_variable changed;
        std::shared_ptr<JsonProcessSession> process;
        bool ready = false, exited = false;
        // A stop request must wake an in-flight helper request before waiting
        // for its operation lock. Epochs also invalidate actions queued earlier.
        unsigned pending_stops = 0;
        unsigned long long stop_epoch = 0;
        bool preview_failed = false;
        unsigned long long requests = 0, revision = 0, frame_seq = 0;
        unsigned viewers = 0;
        std::shared_ptr<const std::string> jpeg;
        std::map<std::string, Json> replies;
        std::string waiting;
        Clock::time_point observed{};
        unsigned long long observed_revision = 0;
        std::string observation() const { return id.empty() ? "" : id + ":" + std::to_string(revision); }
        std::string launch_token() const { return launch_instance + ":" + std::to_string(launch_revision); }
    };
    DesktopOptions options;
    std::mutex mutex;
    std::timed_mutex installation_mutex;
    Json state;
    std::unique_ptr<DesktopHomes> homes;
    std::map<std::string, std::shared_ptr<Desktop>> desktops;
    std::atomic_bool closing{};
    bool legacy_default = false;
    explicit Impl(DesktopOptions o) : options(std::move(o)) {
        if (!options.data.is_absolute())
            throw std::runtime_error("桌面数据目录必须是绝对路径");
        wchar_t legacy[16]{};
        legacy_default=GetEnvironmentVariableW(L"DIMENSION_LEGACY_DEFAULT_WORKSPACE",legacy,16)>0&&std::wstring(legacy)==L"1";
        directory(options.data);
        state = read_state(options.data / L"desktop-settings.json");
        if(auto installations=state.find("installations");installations&&installations->is_object()) {
            auto items=installations->as_object();bool interrupted=false;
            for(auto& [id,value]:items)if(text(value,"status")=="installing") {
                (void)id;auto item=value.as_object();item["status"]="needs-review";
                item["detail"]="上次安装被中断，需核对Linux中的实际安装状态";value=std::move(item);interrupted=true;
            }
            if(interrupted){auto next=state.as_object();next["installations"]=std::move(items);save_state(options.data/L"desktop-settings.json",next);state=std::move(next);}
        }
        const auto native_root = options.linux_home_root.empty()
                                     ? std::optional<std::string>{}
                                     : std::optional<std::string>{options.linux_home_root};
        homes = std::make_unique<DesktopHomes>(options.data, options.distribution, native_root, options.wsl);
        options.distribution = homes->distribution();
    }
    fs::path provision_managed(const std::string& key,std::stop_token stop) {
        auto helper=options.helper.parent_path()/L"dimension-workspace-root.py";
        if(!fs::is_regular_file(helper))throw std::runtime_error("托管工作区助手未安装");
        struct Reply{std::mutex mutex;std::condition_variable_any changed;Json result;bool exited=false;};
        auto reply=std::make_shared<Reply>();
        JsonProcessSession worker(options.wsl,
            {L"-d",wide(options.distribution),L"-u",L"root",L"--exec",L"/usr/bin/python3",wide(linux_path(helper))},
            options.data,[reply](const Json& line){std::lock_guard lock(reply->mutex);
                if(text(line,"event")=="exit")reply->exited=true;else reply->result=line;reply->changed.notify_all();});
        if(!worker.send(O{{"operation","ensure"},{"key",key}}))throw std::runtime_error("托管工作区请求发送失败");
        {std::unique_lock lock(reply->mutex);reply->changed.wait_for(lock,stop,30s,[&]{return !reply->result.is_null()||reply->exited;});}
        worker.close();
        const auto transport=worker.transport_exit();
        if(reply->result.is_null()||!boolean(transport,"ok",false))throw std::runtime_error("托管工作区助手会话失败");
        const auto response=reply->result;
        if(!boolean(response,"ok",false))throw std::runtime_error("托管工作区助手失败："+text(response,"error","未知错误"));
        if(text(response,"key")!=key||
           text(response,"linuxPath")!=managed_workspaces::linux_path(key)||
           response.at("writeQuotaBytes").as_number()!=448.0*1024.0*1024.0)
            throw std::runtime_error("托管工作区配额收据无效");
        return WorkspaceBindings::validate_project(managed_workspaces::windows_path(options.distribution,key),false);
    }
    bool available() const {
        auto supervisor=options.helper;supervisor.replace_filename(L"dimension-sandbox-root.sh");
        return !closing && options.wsl.is_absolute() && options.helper.is_absolute() &&
               fs::is_regular_file(options.wsl) && fs::is_regular_file(options.helper) && fs::is_regular_file(supervisor) &&
               std::regex_match(options.distribution, std::regex("[A-Za-z0-9_.-]{1,80}"));
    }
    std::shared_ptr<Desktop> get(const std::string &bot, std::stop_token stop = {}) {
        std::shared_ptr<Desktop> d;
        unsigned long long epoch;
        bool needs_managed = false;
        {
            std::lock_guard guard(mutex);
            if (closing || stop.stop_requested())
                throw std::runtime_error("桌面初始化已取消");
            if (auto it = desktops.find(bot); it != desktops.end())
                d = it->second;
            else {
                d = std::make_shared<Desktop>();
                d->bot = bot;
                const auto key=bot_key(bot);
                d->folder = options.data / L"desktops" / wide(key);
                const auto default_workspace = d->folder / L"workspace";
                d->workspace = default_workspace;
                bool saved_project=false;
                if (auto saved = state.at("bots").find(bot)) {
                    d->network = false; // Legacy shared-WSL network settings are never honored.
                    if (!text(*saved, "projectCwd").empty()) {
                        d->workspace = path8(text(*saved, "projectCwd"));
                        saved_project=true;
                    }
                }
                if (!d->workspace.is_absolute())
                    throw std::runtime_error("Bot 工作区路径无效");
                d->managed=managed_workspaces::key_from_windows(d->workspace,options.distribution)==std::optional<std::string>(key);
                // Managed ext4 workspaces need an explicitly configured sandbox
                // distribution and its provisioning helper. Without that optional
                // configuration (for example a direct --data/--ui launch) keep the
                // previous per-Bot Windows workspace instead of failing every
                // Work settings read with a provisioning error.
                const bool managed_configured = !options.distribution.empty() && !options.helper.empty() &&
                    fs::is_regular_file(windows_path(options.helper.parent_path()/L"dimension-workspace-root.py"));
                needs_managed=d->managed||(managed_configured&&!legacy_default&&!saved_project&&!fs::exists(windows_path(default_workspace)));
                d->managed=needs_managed;
                d->preferred_workspace = d->workspace;
                desktops.emplace(bot, d);
            }
            needs_managed = d->managed;
            std::lock_guard state_guard(d->mutex);
            epoch = d->stop_epoch;
        }
        if (d->home_ready.load())
            return d;
        auto cancelled = [&] {
            std::lock_guard guard(d->mutex);
            return closing || stop.stop_requested() || d->pending_stops || epoch != d->stop_epoch;
        };
        std::unique_lock preparing(d->preparing, std::defer_lock);
        while (!preparing.try_lock_for(20ms))
            if (cancelled())
                throw std::runtime_error("桌面初始化已取消");
        std::stop_source preparation;
        {
            std::lock_guard guard(d->mutex);
            if (closing || stop.stop_requested() || d->pending_stops || epoch != d->stop_epoch)
                throw std::runtime_error("桌面初始化已取消");
            if (d->home_ready.load())
                return d;
            d->preparation_stop = preparation;
        }
        std::stop_callback interrupted(stop, [&] { preparation.request_stop(); });
        // Filesystem/WSL work must not hold the shared Bot registry lock.
        directory(d->folder);
        if(needs_managed){
            const auto checked=provision_managed(bot_key(bot),preparation.get_token());
            std::lock_guard guard(d->mutex);
            d->workspace=checked;d->preferred_workspace=checked;d->managed=true;
        }
        directory(d->workspace);
        const auto home = homes->resolve(bot_key(bot), d->folder / L"home", preparation.get_token());
        {
            std::lock_guard guard(d->mutex);
            if (closing || stop.stop_requested() || d->pending_stops || epoch != d->stop_epoch)
                throw std::runtime_error("桌面初始化已取消");
            d->home = home.windows_path;
            d->home_linux = home.linux_path;
            d->home_storage = home.storage;
            d->home_ready = true;
        }
        return d;
    }
    A apps() {
        std::lock_guard guard(mutex);
        return state.at("apps").as_array();
    }
    void stop_locked(const std::shared_ptr<Desktop> &d) {
        std::shared_ptr<JsonProcessSession> child;
        {
            std::lock_guard guard(d->mutex);
            child = std::move(d->process);
            ++d->launch_revision;
            d->ready = false;
            d->human = false;
            d->viewers = 0;
            d->exited = true;
            d->jpeg.reset();
            d->changed.notify_all();
        }
        if (child)
            child->close();
    }
    static void receive(const std::weak_ptr<Desktop> &weak, const Json &line) {
        auto d = weak.lock();
        if (!d)
            return;
        auto event = text(line, "event");
        std::shared_ptr<const std::string> jpeg;
        if (event == "frame")
            jpeg = std::make_shared<const std::string>(decode64(text(line, "jpeg")));
        std::lock_guard guard(d->mutex);
        if (event == "ready")
            d->ready = true;
        else if (event == "exit") {
            if (!d->exited)
                ++d->launch_revision;
            d->ready = false;
            d->exited = true;
            d->failure = boolean(line, "ok") ? "" : "桌面进程已经退出";
            if (auto error = line.find("error")) {
                auto code = text(*error, "code");
                if (std::regex_match(code, std::regex("[a-z_]{1,40}")))
                    d->failure += " (" + code + ")";
            }
        } else if (event == "frame") {
            d->jpeg = std::move(jpeg);
            ++d->frame_seq;
            d->preview_failed = false;
            d->failure.clear();
        } else {
            auto id = text(line, "id");
            if (id == "preview-on" && !boolean(line, "ok")) {
                d->preview_failed = true;
                d->failure = "桌面预览暂时不可用，正在等待重新连接";
            }
            if (id == d->waiting)
                d->replies[id] = line;
        }
        d->changed.notify_all();
    }
    void start_locked(const std::shared_ptr<Desktop> &d, std::stop_token stop) {
        {
            std::lock_guard guard(d->mutex);
            if (d->pending_stops || stop.stop_requested() || closing)
                throw std::runtime_error("桌面操作已取消");
            if (d->ready && d->process && d->process->running())
                return;
        }
        stop_locked(d);
        if (!available())
            throw std::runtime_error("Linux 桌面运行环境未配置，请设置 WSL 发行版和原生桌面程序");
        auto supervisor=options.helper;supervisor.replace_filename(L"dimension-sandbox-root.sh");
        static std::atomic<std::uint64_t> cgroup_serial{0};
        const auto cgroup_name="dimension-"+std::to_string(GetCurrentProcessId())+"-"+std::to_string(GetTickCount64())+"-"+std::to_string(++cgroup_serial);
        std::vector<std::wstring> args{L"-d",wide(options.distribution),L"-u",L"root",L"--exec",wide(linux_path(supervisor)),wide(cgroup_name),
                                       L"2147483648",L"200000",L"100000",L"512"};
        if(d->managed){
            const auto launcher=options.helper.parent_path()/L"dimension-userns.py";
            if(!fs::is_regular_file(launcher))throw std::runtime_error("托管桌面身份映射助手未安装");
            args.insert(args.end(),{L"/usr/bin/python3",wide(linux_path(launcher)),L"--unshare-ipc",L"--unshare-pid",L"--unshare-net",L"--unshare-uts",L"--unshare-cgroup"});
        }else args.insert(args.end(),{L"/usr/bin/bwrap",L"--unshare-all"});
        args.insert(args.end(),{L"--die-with-parent",L"--new-session"});
        // No --share-net path remains: every desktop has a private loopback namespace.
        auto add = [&](std::initializer_list<std::wstring> entries) {
            args.insert(args.end(), entries.begin(), entries.end());
        };
        // Resolve selected system configuration files into a fresh /etc. In
        // WSL resolv.conf is a symlink into /mnt/wsl, which is deliberately not
        // mounted wholesale into a Bot's filesystem.
        for (const auto *leaf :
             {L"passwd", L"group", L"hosts", L"resolv.conf", L"nsswitch.conf", L"fonts", L"ssl"}) {
            std::wstring file = std::wstring(L"/etc/") + leaf;
            add({L"--ro-bind", file, file});
        }
        for (const auto *leaf : {L"alternatives", L"ld.so.cache", L"localtime", L"xdg", L"gtk-3.0"}) {
            std::wstring file = std::wstring(L"/etc/") + leaf;
            add({L"--ro-bind-try", file, file});
        }
        add({L"--ro-bind",
             L"/usr",
             L"/usr",
             L"--symlink",
             L"usr/bin",
             L"/bin",
             L"--symlink",
             L"usr/sbin",
             L"/sbin",
             L"--symlink",
             L"usr/lib",
             L"/lib",
             L"--symlink",
             L"usr/lib64",
             L"/lib64",
             L"--ro-bind",
             L"/opt",
             L"/opt",
             L"--proc",
             L"/proc",
             L"--dev",
             L"/dev",
             // Share one 16 MiB filesystem between all temporary mounts.
             L"--size",
             L"16777216",
             L"--tmpfs",
             L"/dev/shm",
             L"--dir",
             L"/dev/shm/tmp",
             L"--dir",
             L"/dev/shm/run/user/1000",
             L"--symlink",
             L"/dev/shm/tmp",
             L"/tmp",
             L"--symlink",
             L"/dev/shm/run",
             L"/run",
             L"--bind",
             wide(d->home_linux),
             L"/home/bot",
             L"--bind",
             wide(linux_path(d->workspace,options.distribution)),
             L"/workspace",
             L"--ro-bind",
             wide(linux_path(options.helper)),
             L"/dimension-helper",
             L"--uid",
             L"1000",
             L"--gid",
             d->managed?L"1002":L"1000",
             L"--cap-drop",
             L"ALL",
             L"--clearenv",
             L"--setenv",
             L"PATH",
             L"/usr/bin:/bin",
             L"--setenv",
             L"HOME",
             L"/home/bot",
             L"--setenv",
             L"USER",
             L"bot",
             L"--setenv",
             L"LANG",
             L"C.UTF-8",
             L"--setenv",
             L"DISPLAY",
             L":99",
             L"--setenv",
             L"TMPDIR",
             L"/tmp",
             L"--chdir",
             L"/workspace",
             L"/dimension-helper"});
        {
            std::lock_guard guard(d->mutex);
            if (d->pending_stops || stop.stop_requested() || closing)
                throw std::runtime_error("桌面操作已取消");
            d->id = unique_id();
            d->revision = 0;
            d->ready = false;
            d->exited = false;
            d->failure.clear();
            d->jpeg.reset();
            d->frame_seq = 0;
            d->replies.clear();
            d->waiting.clear();
        }
        auto child = std::make_shared<JsonProcessSession>(
            options.wsl, args, d->folder,
            [weak = std::weak_ptr(d)](const Json &line) { receive(weak, line); });
        {
            std::lock_guard guard(d->mutex);
            d->process = std::move(child);
        }
        std::stop_callback cancelled(stop, [&] { d->changed.notify_all(); });
        std::unique_lock guard(d->mutex);
        d->changed.wait_for(guard, 25s, [&] {
            return d->ready || d->exited || d->pending_stops || stop.stop_requested() || closing;
        });
        bool ready = d->ready && !d->pending_stops && !stop.stop_requested() && !closing;
        auto failure = d->failure;
        guard.unlock();
        if (!ready) {
            stop_locked(d);
            throw std::runtime_error(failure.empty() ? "Linux 桌面未能启动或操作已取消" : failure);
        }
    }
    Json request(const std::shared_ptr<Desktop> &d, Json command, std::stop_token stop = {}) {
        if (stop.stop_requested() || closing)
            throw std::runtime_error("桌面操作已取消");
        std::shared_ptr<JsonProcessSession> child;
        std::string id;
        {
            std::lock_guard guard(d->mutex);
            if (!d->ready || !d->process)
                throw DesktopError("not_running", "桌面未启动，请先启动公共软件");
            if (d->pending_stops || stop.stop_requested() || closing)
                throw std::runtime_error("桌面操作已取消");
            id = std::to_string(++d->requests);
            child = d->process;
        }
        auto payload = command.as_object();
        payload["id"] = id;
        // The Linux protocol has a tighter bound than the generic Windows
        // session. Reject before sending instead of waiting on a discarded line.
        if (Json(payload).dump().size() + 1 > 256U * 1024U)
            throw std::runtime_error("桌面操作参数超过 256 KiB 上限");
        {
            std::lock_guard guard(d->mutex);
            if (d->pending_stops || stop.stop_requested() || closing)
                throw std::runtime_error("桌面操作已取消");
            d->waiting = id;
            if (!child->send(payload)) {
                d->waiting.clear();
                throw std::runtime_error("桌面输入队列不可用");
            }
        }
        std::stop_callback cancelled(stop, [&] { d->changed.notify_all(); });
        std::unique_lock guard(d->mutex);
        d->changed.wait_for(guard, 20s, [&] {
            return d->replies.contains(id) || d->exited || d->pending_stops || stop.stop_requested() ||
                   closing;
        });
        // Drain a short in-flight action during Work cancellation. A promptly
        // acknowledged action has a real receipt and need not destroy the app.
        // A stalled helper is stopped so that no delayed input can leak through.
        if (stop.stop_requested() && !d->pending_stops && !closing && !d->exited && !d->replies.contains(id))
            d->changed.wait_for(guard, 500ms, [&] {
                return d->replies.contains(id) || d->exited || d->pending_stops || closing;
            });
        auto found = d->replies.find(id);
        if (found == d->replies.end() || d->pending_stops || closing) {
            d->waiting.clear();
            d->replies.clear();
            guard.unlock();
            stop_locked(d);
            throw std::runtime_error("桌面操作超时或已取消，桌面已停止以避免延迟输入");
        }
        auto reply = found->second;
        d->replies.erase(found);
        d->waiting.clear();
        guard.unlock();
        if (!boolean(reply, "ok"))
            throw std::runtime_error(
                text(reply.find("error") ? reply.at("error") : Json(O{}), "message", "桌面操作失败"));
        return reply.find("result") ? reply.at("result") : Json(O{});
    }
    Json view(const std::shared_ptr<Desktop> &d) {
        O result{{"botId", d->bot},
                 {"workspace", utf8(d->workspace)},
                 {"networkAccess", false},
                 {"networkPolicy", "isolated-loopback-only"},
                 {"networkCapability", "unavailable"},
                 {"managedWorkspace", d->managed},
                 {"workspaceWriteQuota", d->managed},
                 {"workspaceWriteQuotaBytes", d->managed?448.0*1024.0*1024.0:0},
                 {"workspaceStorage", d->managed?"managed-wsl-ext4":"legacy-windows-drvfs"},
                 {"apps", apps()},
                 {"available", available()},
                 {"width", 1280},
                 {"height", 800},
                 {"previewFps", 30}};
        {
            std::lock_guard guard(mutex);A installations;
            if(const auto rows=state.find("installations");rows&&rows->is_object())
                for(const auto& [id,row]:rows->as_object()){(void)id;installations.push_back(row);}
            result["installations"]=std::move(installations);
        }
        {
            std::lock_guard guard(d->mutex);
            result["running"] = d->ready && d->process && d->process->running();
            result["profileStorage"] = d->home_storage;
            result["humanControl"] = d->human;
            result["desktopId"] = d->id;
            result["observationId"] = d->observation();
            result["launchToken"] = d->launch_token();
            result["error"] = d->failure;
        }
        return result;
    }
    Json observe(const std::shared_ptr<Desktop> &d, bool pixels, std::stop_token stop) {
        auto result = pixels ? request(d, O{{"op", "observe"}}, stop).as_object() : O{};
        if (pixels) {
            d->observed = Clock::now();
            d->observed_revision = d->revision;
        }
        auto snapshot = view(d).as_object();
        result.insert(snapshot.begin(), snapshot.end());
        return result;
    }
};

DesktopManager::DesktopManager(DesktopOptions o) : impl_(std::make_unique<Impl>(std::move(o))) {}
DesktopManager::~DesktopManager() { shutdown(); }
bool DesktopManager::available() const { return impl_->available(); }
Json DesktopManager::software() {
    const auto apps=impl_->apps();std::lock_guard lock(impl_->mutex);
    A installations;if(const auto rows=impl_->state.find("installations");rows&&rows->is_object())for(const auto& [id,row]:rows->as_object()){(void)id;installations.push_back(row);}
    return O{{"apps",apps},{"installations",installations},{"installerAvailable",impl_->available()&&
        fs::is_regular_file(fs::path(windows_path(impl_->options.helper.parent_path()/L"dimension-software-helper")))}};
}
Json DesktopManager::install_software(const std::string& bot,const Json& request,const std::string& request_id,std::stop_token stop){
    const auto package=text(request,"package"),executable=text(request,"executable"),id=text(request,"appId"),name=text(request,"name");
    if(!request.is_object()||!std::regex_match(package,std::regex("[a-z0-9][a-z0-9+.-]{0,79}"))||
        !std::regex_match(id,std::regex("[A-Za-z0-9_-]{1,80}"))||name.empty()||name.size()>200||
        !std::regex_match(executable,std::regex("/(usr/bin|usr/local/bin|bin|opt)/[A-Za-z0-9_./+-]{1,480}"))||
        executable.find("..")!=executable.npos||executable.find("//")!=executable.npos||request_id.empty()||request_id.size()>200)
        throw DesktopError("invalid_package","软件安装需要有效的Debian包名、软件编号、名称和程序路径");
    for(const auto&[key,value]:request.as_object()){(void)value;if(key!="package"&&key!="executable"&&key!="appId"&&key!="name")throw DesktopError("invalid_arguments","软件安装参数包含未知字段");}
    if(!impl_->available())throw DesktopError("sandbox_unavailable","Linux沙盒尚未配置");
    const auto helper=impl_->options.helper.parent_path()/L"dimension-software-helper";
    if(!fs::is_regular_file(fs::path(windows_path(helper))))throw DesktopError("installer_unavailable","Linux安装组件不存在");
    auto d=impl_->get(bot,stop);{std::lock_guard lock(d->operation);if(!d->network)throw DesktopError("network_disabled","当前Bot已禁用联网，不能下载软件包");}
    std::unique_lock installation(impl_->installation_mutex,std::defer_lock);
    while(!installation.try_lock_for(50ms))if(stop.stop_requested()||impl_->closing)throw DesktopError("cancelled","安装等待已取消");
    if(stop.stop_requested()||impl_->closing)throw DesktopError("cancelled","安装已取消");
    auto update=[&](const std::string& status,const std::string& detail,const Json& verified=Json()){
        std::lock_guard guard(impl_->mutex);auto root=impl_->state.as_object();
        O installs;if(auto rows=root.find("installations");rows!=root.end()&&rows->second.is_object())installs=rows->second.as_object();
        // Active installation is serialized. Retain the latest bounded status
        // history without imposing a lifetime quota on installation attempts;
        // the owning Work runs keep their durable full execution receipts.
        if(!installs.contains(id)&&installs.size()>=50) {
            auto oldest=installs.end();
            for(auto entry=installs.begin();entry!=installs.end();++entry)if(text(entry->second,"status")!="installing") {
                const auto time=entry->second.find("updatedAtMs");
                const auto old=oldest==installs.end()?nullptr:oldest->second.find("updatedAtMs");
                if(oldest==installs.end()||!time||!old||time->as_number()<old->as_number())oldest=entry;
            }
            if(oldest==installs.end())throw DesktopError("catalog_capacity","软件安装仍在进行，请稍后重试");
            installs.erase(oldest);
        }
        installs[id]=O{{"appId",id},{"name",name},{"package",package},{"executable",executable},
            {"requestId",request_id},{"botId",bot},{"status",status},{"detail",detail},{"verification",verified},
            {"updatedAtMs",double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())}};
        root["installations"]=std::move(installs);
        if(status=="installed") {
            A apps=root.at("apps").as_array();bool exists=false;
            for(const auto& app:apps)if(text(app,"id")==id){if(text(app,"executable")!=executable)throw DesktopError("catalog_conflict","软件已安装，但公共清单中的同名编号已改变，请核对后登记",false);exists=true;}
            if(!exists){if(apps.size()>=50)throw DesktopError("catalog_capacity","软件已安装，公共清单已满，请整理后登记",false);apps.push_back(O{{"id",id},{"name",name},{"executable",executable},{"args",A{}}});}
            root["apps"]=std::move(apps);
        }
        save_state(impl_->options.data/L"desktop-settings.json",root);impl_->state=std::move(root);
    };
    {const auto apps=impl_->apps();for(const auto& app:apps)if(text(app,"id")==id&&text(app,"executable")!=executable)throw DesktopError("catalog_conflict","公共软件编号已被其他程序占用");}
    update("installing","正在Linux中安装并验证软件包");
    struct Reply {std::mutex mutex;std::condition_variable_any changed;Json result;bool exited=false;};
    auto reply=std::make_shared<Reply>();Json result;
    try {
        JsonProcessSession worker(impl_->options.wsl,{L"-d",wide(impl_->options.distribution),L"-u",L"root",L"--exec",wide(linux_path(helper))},impl_->options.data,
            [reply](const Json& line){std::lock_guard lock(reply->mutex);if(text(line,"event")=="exit")reply->exited=true;else reply->result=line;reply->changed.notify_all();});
        if(!worker.send(O{{"operation","install"},{"package",package},{"executable",executable}}))throw std::runtime_error("installer_request_failed");
        {std::unique_lock lock(reply->mutex);reply->changed.wait_for(lock,stop,610s,[&]{return !reply->result.is_null()||reply->exited;});result=reply->result;}
        worker.close();
        if(result.is_null())result=O{{"ok",false},{"code",stop.stop_requested()?"interrupted":"installer_disconnected"},{"uncertain",true}};
        if(boolean(result,"ok")&&boolean(result,"installed")&&boolean(result,"verified"))update("installed","已验证程序存在且属于该Linux软件包",result);
        else update(boolean(result,"uncertain")?"needs-review":"failed","软件未通过安装核验，未加入公共软件清单",result);
    }catch(...){try{update("needs-review","安装或登记未完成，需核对Linux中的实际状态");}catch(...){}throw;}
    return result;
}
Json DesktopManager::set_software(const Json &entries) {
    if (!entries.is_array() || entries.as_array().size() > 50)
        throw std::runtime_error("公共软件清单最多包含 50 项");
    A apps;
    std::map<std::string, bool> ids;
    for (const auto &item : entries.as_array()) {
        auto id = text(item, "id"), name = text(item, "name"), executable = text(item, "executable");
        if (!std::regex_match(id, std::regex("[A-Za-z0-9_-]{1,80}")) || !ids.emplace(id, true).second ||
            name.empty() || name.size() > 200 || executable.empty() || executable[0] != '/' ||
            executable.size() > 1024 || executable.find('\0') != executable.npos)
            throw std::runtime_error("公共软件名称、编号或程序路径无效");
        auto args = item.find("args") ? item.at("args") : Json(A{});
        if (!args.is_array() || args.as_array().size() > 100)
            throw std::runtime_error("公共软件参数无效");
        for (auto &arg : args.as_array())
            if (!arg.is_string() || arg.as_string().size() > 8192 ||
                arg.as_string().find('\0') != arg.as_string().npos)
                throw std::runtime_error("公共软件参数无效");
        apps.push_back(O{{"id", id}, {"name", name}, {"executable", executable}, {"args", args}});
    }
    std::lock_guard guard(impl_->mutex);
    auto state = impl_->state.as_object();
    state["apps"] = apps;
    save_state(impl_->options.data / L"desktop-settings.json", state);
    impl_->state = state;
    return O{{"apps", apps}};
}
Json DesktopManager::status(const std::string &bot, std::stop_token stop) {
    auto d = impl_->get(bot, stop);
    std::lock_guard guard(d->operation);
    return impl_->view(d);
}
Json DesktopManager::settings(const std::string &bot) {
    auto d = impl_->get(bot);
    std::lock_guard guard(d->operation);
    std::lock_guard state(impl_->mutex);
    auto existing = impl_->state.at("bots").find(bot);
    auto result = existing ? existing->as_object() : O{};
    result["projectCwd"] = utf8(d->preferred_workspace);
    result["activeProjectCwd"] = utf8(d->workspace);
    result["networkAccess"] = false;
    result["networkPolicy"] = "isolated-loopback-only";
    result["networkCapability"] = "unavailable";
    result["managedWorkspace"] = d->managed;
    result["workspaceWriteQuota"] = d->managed;
    result["workspaceWriteQuotaBytes"] = d->managed?448.0*1024.0*1024.0:0;
    result["workspaceStorage"] = d->managed?"managed-wsl-ext4":"legacy-windows-drvfs";
    if (!result.contains("approvalMode"))
        result["approvalMode"] = "auto";
    result["sandboxBackend"] = "wsl-native";
    return O{{"settings", result}};
}
Json DesktopManager::set_settings(const std::string &bot, const Json &patch) {
    auto d = impl_->get(bot);
    {
        std::lock_guard guard(d->operation);
        if (auto value = patch.find("networkAccess"); value && !value->is_bool())
            throw std::runtime_error("联网设置必须是布尔值");
        std::string approval;
        if (auto mode = patch.find("approvalMode")) {
            approval = mode->as_string();
            if (approval != "auto" && approval != "ask" && approval != "full")
                throw std::runtime_error("审批模式无效");
        }
        if (boolean(patch, "networkAccess", false))
            throw std::runtime_error("WSL沙盒联网能力已移除，仅支持独立回环网络");
        const bool network = false;
        auto folder = d->preferred_workspace;
        if (const auto* project = patch.find("projectCwd")) {
            folder = project->is_null() ? impl_->provision_managed(bot_key(bot), {}) :
                WorkspaceBindings::validate_project(path8(text(patch, "projectCwd")));
        }
        const auto managed_key=managed_workspaces::key_from_windows(folder,impl_->options.distribution);
        if(managed_key&&*managed_key!=bot_key(bot))throw std::runtime_error("不能绑定其他Bot的托管工作区");
        const auto workspace = utf8(folder);
        {
            std::lock_guard saved(impl_->mutex);
            auto root = impl_->state.as_object();
            auto bots = root["bots"].as_object();
            auto settings = bots.contains(bot) ? bots[bot].as_object() : O{};
            settings["networkAccess"] = network;
            settings["projectCwd"] = workspace;
            if (!approval.empty())
                settings["approvalMode"] = approval;
            bots[bot] = settings;
            root["bots"] = bots;
            save_state(impl_->options.data / L"desktop-settings.json", root);
            impl_->state = root;
        }
        const bool project_changed = patch.find("projectCwd") && folder != d->workspace;
        if (network != d->network || project_changed)
            impl_->stop_locked(d);
        d->network = network;
        d->managed = managed_key.has_value();
        d->preferred_workspace = folder;
        if (patch.find("projectCwd")) d->workspace = folder;
    }
    return settings(bot);
}
void DesktopManager::activate_project(const std::string& bot,const fs::path& project,std::stop_token stop) {
    auto checked=project.lexically_normal();
    const auto managed_key=managed_workspaces::key_from_windows(checked,impl_->options.distribution);
    if(managed_key){
        if(*managed_key!=bot_key(bot))throw std::runtime_error("不能激活其他Bot的托管工作区");
        checked=impl_->provision_managed(*managed_key,stop);
    }else checked=WorkspaceBindings::validate_project(checked);
    auto d=impl_->get(bot,stop);std::lock_guard lock(d->operation);
    if(checked==d->workspace)return;
    {std::lock_guard guard(d->mutex);if(d->human)throw DesktopError("human_control","用户正在接管桌面，交还后再恢复任务",true,true);}
    if(stop.stop_requested())throw DesktopError("cancelled","工作区切换已取消");
    impl_->stop_locked(d);d->workspace=std::move(checked);d->managed=managed_key.has_value();
}
Json DesktopManager::control(const std::string &bot, bool human) {
    auto d = impl_->get(bot);
    std::lock_guard guard(d->operation);
    {
        std::lock_guard state(d->mutex);
        if (human && !d->ready)
            throw std::runtime_error("桌面未启动");
        if (d->human != human) {
            d->human = human;
            ++d->revision;
            ++d->launch_revision;
        }
    }
    return impl_->view(d);
}
Json DesktopManager::stop(const std::string &bot) {
    std::shared_ptr<Impl::Desktop> d;
    {
        std::lock_guard saved(impl_->mutex);
        auto existing = impl_->desktops.find(bot);
        if (existing == impl_->desktops.end())
            return O{{"botId", bot}, {"running", false}, {"humanControl", false}};
        d = existing->second;
    }
    std::stop_source preparation;
    {
        std::lock_guard state(d->mutex);
        ++d->pending_stops;
        ++d->stop_epoch;
        preparation = d->preparation_stop;
        d->changed.notify_all();
    }
    preparation.request_stop();
    std::lock_guard guard(d->operation);
    impl_->stop_locked(d);
    {
        std::lock_guard state(d->mutex);
        --d->pending_stops;
    }
    return impl_->view(d);
}
Json DesktopManager::action(const std::string &bot, const Json &action, bool fast, bool user,
                            std::stop_token stop) {
    if (stop.stop_requested() || impl_->closing)
        throw std::runtime_error("桌面操作已取消");
    if (!user)
        fast = false;
    auto d = impl_->get(bot, stop);
    unsigned long long epoch;
    {
        std::lock_guard state(d->mutex);
        epoch = d->stop_epoch;
    }
    std::lock_guard guard(d->operation);
    {
        std::lock_guard state(d->mutex);
        if (d->pending_stops || epoch != d->stop_epoch || stop.stop_requested() || impl_->closing)
            throw std::runtime_error("桌面操作已取消");
    }
    auto op = text(action, "op");
    if (!user && d->human)
        throw DesktopError("human_control", "用户正在接管键鼠；交还后可继续任务", true, true);
    if (op == "launch") {
        if (const auto token = action.find("launchToken")) {
            if (!token->is_string() || token->as_string().empty() || token->as_string().size() > 128)
                throw DesktopError("invalid_arguments", "启动状态标识格式无效");
            std::lock_guard state(d->mutex);
            if (token->as_string() != d->launch_token())
                throw DesktopError("launch_state_stale", "桌面状态已变化，请查看当前状态后再启动");
        }
        Json selected;
        for (auto &app : impl_->apps())
            if (text(app, "id") == text(action, "appId", "chrome"))
                selected = app;
        if (selected.is_null())
            throw DesktopError("app_not_found", "公共软件不存在，请先登记");
        auto executable = text(selected, "executable");
        auto args = selected.at("args").as_array();
        if (const auto url = action.find("url")) {
            if (!url->is_string() || url->as_string().size() > 4096 ||
                (!url->as_string().starts_with("https://") && !url->as_string().starts_with("http://")) ||
                url->as_string().find_first_of("\r\n") != std::string::npos ||
                url->as_string().find('\0') != std::string::npos)
                throw DesktopError("invalid_url", "应用地址必须是 HTTP(S) 网页");
            if (executable.find("chrome") == executable.npos && executable.find("chromium") == executable.npos)
                throw DesktopError("invalid_url", "只有浏览器支持打开应用网页");
            args.emplace_back(url->as_string());
        }
        if (executable.find("chrome") != executable.npos || executable.find("chromium") != executable.npos) {
            for (const auto &value : args) {
                auto s = value.as_string();
                if (s.starts_with("--user-data-dir") || s.starts_with("--profile-directory") ||
                    s.starts_with("--remote-debugging"))
                    throw std::runtime_error("浏览器登录目录与调试端口由独立桌面管理");
            }
            A flags{"--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-sync",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--window-size=1280,800",
                    "--start-maximized",
                    "--user-data-dir=/home/bot/chrome"};
            flags.insert(flags.end(), args.begin(), args.end());
            args = std::move(flags);
        }
        impl_->start_locked(d, stop);
        {
            std::lock_guard state(d->mutex);
            ++d->launch_revision;
        }
        impl_->request(d, O{{"op", "launch"}, {"executable", executable}, {"args", args}}, stop);
        {
            std::lock_guard state(d->mutex);
            d->human = user;
            ++d->revision;
        }
        if (stop.stop_requested()) {
            auto state = impl_->view(d).as_object();
            state["actionCompleted"] = true;
            state["observationRequired"] = true;
            return state;
        }
        return impl_->observe(d, true, stop);
    }
    if (op == "observe")
        return impl_->observe(d, true, stop);
    if (op != "click" && op != "drag" && op != "scroll" && op != "type" && op != "press")
        throw DesktopError("invalid_action", "未知桌面操作");
    {
        std::lock_guard state(d->mutex);
        if (!d->ready)
            throw DesktopError("not_running", "桌面未启动，请先启动公共软件");
        if (user != d->human)
            throw std::runtime_error(user ? "请先接管键鼠" : "用户正在接管键鼠，Bot 操作已暂停");
        auto observation = text(action, "observationId");
        if (observation.empty() ||
            (!user || !fast ? observation != d->observation() : !observation.starts_with(d->id + ":")))
            throw DesktopError("observation_stale", "桌面画面已变化，请重新观察后再操作");
        if (!user && (Clock::now() - d->observed > 30s || d->observed_revision != d->revision))
            throw DesktopError("observation_stale", "桌面观察已过期，请重新观察");
    }
    auto command = action.as_object();
    command.erase("observationId");
    {
        std::lock_guard state(d->mutex);
        ++d->launch_revision;
    }
    impl_->request(d, command, stop);
    {
        std::lock_guard state(d->mutex);
        ++d->revision;
    }
    if (stop.stop_requested()) {
        auto state = impl_->view(d).as_object();
        state["actionCompleted"] = true;
        state["observationRequired"] = true;
        return state;
    }
    return impl_->observe(d, !fast, stop);
}
Json DesktopManager::downloads(const std::string &bot, const Json &request, std::stop_token stop) {
    if (!request.is_object()) throw DesktopError("invalid_arguments", "下载请求无效");
    auto d = impl_->get(bot, stop);
    std::lock_guard guard(d->operation);
    {
        std::lock_guard state(d->mutex);
        if (!d->ready) throw DesktopError("not_running", "桌面未启动");
        if (d->human) throw DesktopError("human_control", "用户正在接管；交还后继续收取文件", true, true);
    }
    auto command = request.as_object();
    command["op"] = request.find("name") ? "download_read" : "downloads";
    return impl_->request(d, command, stop);
}
HttpResponse DesktopManager::stream(const std::string &bot) {
    auto d = impl_->get(bot);
    std::string id;
    {
        std::lock_guard guard(d->operation);
        std::lock_guard state(d->mutex);
        if (!d->ready)
            throw std::runtime_error("桌面未启动");
        id = d->id;
    }
    HttpResponse response;
    response.headers = {{"Content-Type", "multipart/x-mixed-replace; boundary=dimension-frame"},
                        {"Cache-Control", "no-store"},
                        {"X-Content-Type-Options", "nosniff"}};
    response.stream = [d, id](HttpStream &stream) {
        {
            std::lock_guard guard(d->mutex);
            if (!d->ready || d->id != id)
                return;
            if (++d->viewers == 1) {
                d->preview_failed = false;
                d->jpeg.reset();
                d->frame_seq = 0;
                d->process->send(O{{"id", "preview-on"}, {"op", "preview"}, {"enabled", true}});
            }
        }
        std::stop_callback cancelled(stream.stop_token(), [&] { d->changed.notify_all(); });
        unsigned long long last = 0;
        auto received = Clock::now();
        while (stream.alive() && !stream.stop_token().stop_requested()) {
            std::shared_ptr<const std::string> frame;
            {
                std::unique_lock guard(d->mutex);
                d->changed.wait_for(guard, 250ms, [&] {
                    return d->frame_seq != last || d->preview_failed || !d->ready || d->id != id ||
                           stream.stop_token().stop_requested();
                });
                if (!d->ready || d->preview_failed || d->id != id || stream.stop_token().stop_requested() ||
                    Clock::now() - received > 10s)
                    break;
                if (d->frame_seq == last)
                    continue;
                last = d->frame_seq;
                frame = d->jpeg;
                received = Clock::now();
            }
            if (frame && !stream.write("--dimension-frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                                       std::to_string(frame->size()) + "\r\n\r\n" + *frame + "\r\n"))
                break;
        }
        {
            std::lock_guard guard(d->mutex);
            if (d->id == id && d->viewers && --d->viewers == 0 && d->process)
                d->process->send(O{{"id", "preview-off"}, {"op", "preview"}, {"enabled", false}});
        }
    };
    return response;
}
void DesktopManager::shutdown() noexcept {
    if (!impl_ || impl_->closing.exchange(true))
        return;
    std::vector<std::shared_ptr<Impl::Desktop>> all;
    {
        std::lock_guard guard(impl_->mutex);
        for (auto &[key, d] : impl_->desktops)
            all.push_back(d);
    }
    for (auto &d : all) {
        std::stop_source preparation;
        {
            std::lock_guard guard(d->mutex);
            preparation = d->preparation_stop;
        }
        preparation.request_stop();
        d->changed.notify_all();
    }
    for (auto &d : all) {
        try {
            std::lock_guard preparing(d->preparing);
            std::lock_guard guard(d->operation);
            impl_->stop_locked(d);
        } catch (...) {
        }
    }
}
} // namespace dimension
