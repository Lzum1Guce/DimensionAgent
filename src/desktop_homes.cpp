#include "dimension/desktop_homes.hpp"
#include "dimension/process_session.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <map>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
using namespace std::chrono_literals;
constexpr std::size_t manifest_limit = 4U * 1024U * 1024U;
constexpr std::size_t home_limit = 4096;
constexpr std::string_view namespace_prefix = ".dimension-native-";
[[noreturn]] void fail(const char* reason) { throw std::runtime_error(reason); }
void require(bool value, const char* reason) { if (!value) fail(reason); }

class Handle final {
public:
    Handle() = default;
    explicit Handle(HANDLE value) : value_(value) {}
    ~Handle() { if (valid()) CloseHandle(value_); }
    Handle(Handle&& other) noexcept : value_(std::exchange(other.value_, INVALID_HANDLE_VALUE)) {}
    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) { if (valid()) CloseHandle(value_); value_ = std::exchange(other.value_, INVALID_HANDLE_VALUE); }
        return *this;
    }
    Handle(const Handle&) = delete;
    HANDLE get() const { return value_; }
    bool valid() const { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
private:
    HANDLE value_ = INVALID_HANDLE_VALUE;
};

std::string utf8(const fs::path& value) {
    auto text = value.u8string();
    return {reinterpret_cast<const char*>(text.data()), text.size()};
}
fs::path path8(std::string_view value) {
    return fs::path(std::u8string_view(reinterpret_cast<const char8_t*>(value.data()), value.size()));
}
std::wstring extended(const fs::path& value) {
    auto path = value; path.make_preferred();
    const auto text = path.wstring();
    if (text.starts_with(L"\\\\?\\")) return text;
    if (text.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + text.substr(2);
    return L"\\\\?\\" + text;
}
fs::path local_path(const fs::path& input) {
    require(input.is_absolute(), "Desktop home data path must be absolute");
    const auto root = input.root_name().wstring();
    require(root.size() == 2 && root[1] == L':' &&
        ((root[0] >= L'a' && root[0] <= L'z') || (root[0] >= L'A' && root[0] <= L'Z')),
        "Desktop home data path must use a local drive");
    for (const auto& component : input.relative_path()) {
        const auto part = component.wstring();
        require(!part.empty() && part != L"." && part != L".." && part.back() != L'.' && part.back() != L' ',
                "Desktop home path contains an ambiguous component");
        require(part.find_first_of(L":*?\"<>|") == part.npos &&
            std::none_of(part.begin(), part.end(), [](wchar_t c) { return c < 32; }),
            "Desktop home path contains an invalid component");
    }
    auto value = input.lexically_normal(); value.make_preferred();
    require(value.wstring().size() < 32000, "Desktop home path is too long");
    return value;
}
bool same_path(const fs::path& first, const fs::path& second) {
    return CompareStringOrdinal(first.c_str(), -1, second.c_str(), -1, TRUE) == CSTR_EQUAL;
}
BY_HANDLE_FILE_INFORMATION info(HANDLE handle, bool directory) {
    BY_HANDLE_FILE_INFORMATION result{};
    require(GetFileInformationByHandle(handle, &result) != FALSE, "Cannot inspect desktop home path");
    require(!(result.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT), "Desktop home paths cannot be reparse points");
    require(bool(result.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory, "Desktop home path has an unexpected type");
    if (!directory) require(result.nNumberOfLinks == 1, "Desktop home files cannot have multiple links");
    return result;
}
struct Walk { bool exists = true; std::vector<Handle> handles; };
Walk directories(const fs::path& path, bool create) {
    Walk result;
    auto open = [&](const fs::path& item) {
        Handle handle(CreateFileW(extended(item).c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
        if (!handle.valid()) {
            const auto error = GetLastError();
            if (!create && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)) {
                result.exists = false; return false;
            }
            fail("Cannot open desktop home directory");
        }
        (void)info(handle.get(), true);
        result.handles.push_back(std::move(handle)); return true;
    };
    auto current = path.root_path();
    if (!open(current)) return result;
    for (const auto& part : path.relative_path()) {
        current /= part;
        if (create && !CreateDirectoryW(extended(current).c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS)
            fail("Cannot create desktop home directory");
        if (!open(current)) break;
    }
    return result;
}
std::string random_hex() {
    unsigned char bytes[16]{};
    require(BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0,
            "Cannot create desktop home identity");
    constexpr char alphabet[] = "0123456789abcdef";
    std::string result;
    for (const auto byte : bytes) { result += alphabet[byte >> 4U]; result += alphabet[byte & 15U]; }
    return result;
}
bool hex32(std::string_view value) {
    return value.size() == 32 && std::all_of(value.begin(), value.end(),
        [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}
void fields(const Json& value, std::initializer_list<std::string_view> names) {
    require(value.is_object() && value.as_object().size() == names.size(), "Invalid desktop home manifest shape");
    for (const auto name : names) require(value.find(name) != nullptr, "Invalid desktop home manifest fields");
}
std::string text(const Json& value, const char* key) {
    const auto* field = value.find(key);
    require(field && field->is_string() && field->as_string().find('\0') == std::string::npos,
            "Invalid desktop home manifest text");
    return field->as_string();
}
std::optional<Json> read_manifest(const fs::path& file) {
    Handle handle(CreateFileW(extended(file).c_str(), GENERIC_READ, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!handle.valid()) {
        if (GetLastError() == ERROR_FILE_NOT_FOUND) return {};
        fail("Cannot read desktop home manifest");
    }
    const auto metadata = info(handle.get(), false);
    const auto size = (static_cast<unsigned long long>(metadata.nFileSizeHigh) << 32U) | metadata.nFileSizeLow;
    require(size <= manifest_limit, "Desktop home manifest exceeds size limit");
    std::string bytes(static_cast<std::size_t>(size), '\0');
    DWORD read{};
    require(ReadFile(handle.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) &&
        read == bytes.size(), "Cannot read complete desktop home manifest");
    try { return Json::parse(bytes, manifest_limit); }
    catch (...) { fail("Invalid desktop home manifest JSON"); }
}
void save_manifest(const fs::path& file, const Json& value) {
    const auto bytes = value.dump();
    require(bytes.size() <= manifest_limit, "Desktop home manifest exceeds size limit");
    auto temporary = file; temporary += L"." + path8(random_hex()).wstring() + L".tmp";
    try {
        {
            Handle handle(CreateFileW(extended(temporary).c_str(), GENERIC_WRITE, 0, nullptr,
                CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
            require(handle.valid(), "Cannot stage desktop home manifest");
            (void)info(handle.get(), false);
            DWORD written{};
            require(WriteFile(handle.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
                written == bytes.size() && FlushFileBuffers(handle.get()), "Cannot flush desktop home manifest");
        }
        require(MoveFileExW(extended(temporary).c_str(), extended(file).c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH), "Cannot commit desktop home manifest");
    } catch (...) {
        // An exact unique file below the held data directory; no recursive cleanup.
        DeleteFileW(extended(temporary).c_str());
        throw;
    }
}

constexpr std::string_view prepare_script = R"PY(import ctypes,errno,json,os,pwd,secrets,stat,sys
def reject():
    raise RuntimeError("native_home_rejected")
def strict(pairs):
    value={}
    for k,v in pairs:
        if k in value: reject()
        value[k]=v
    return value
def load(fd):
    s=os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>2048 or s.st_uid!=uid or s.st_gid!=gid or stat.S_IMODE(s.st_mode)!=0o600: reject()
    raw=os.read(fd,2049)
    return json.loads(raw.decode("utf-8"),object_pairs_hook=strict)
def marker(parent,name,value,create):
    if create:
        f=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
        try:
            raw=json.dumps(value,separators=(",",":")).encode()
            if os.write(f,raw)!=len(raw): reject()
            os.fsync(f)
        finally: os.close(f)
        os.fsync(parent)
    else:
        f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
        try:
            if load(f)!=value: reject()
        finally: os.close(f)
def directory(parent,name,create):
    made=False
    if create:
        try:
            os.mkdir(name,0o700,dir_fd=parent)
            made=True
        except FileExistsError: raise
    f=os.open(name,flags,dir_fd=parent)
    s=os.fstat(f)
    if s.st_uid!=uid or s.st_gid!=gid or stat.S_IMODE(s.st_mode) not in (0o700,0o770) or s.st_dev!=device:
        os.close(f); reject()
    return f,made,s
def publish(parent,source,target):
    libc.renameat2.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    libc.renameat2.restype=ctypes.c_int
    if libc.renameat2(parent,source.encode(),parent,target.encode(),1)!=0:
        raise OSError(ctypes.get_errno(),"publish_failed")
    os.fsync(parent)
def stage_cleanup(parent,name,fd,marker_name=None):
    # Only this worker's unpublished stage, no recursive deletion or profile cleanup.
    try:
        s=os.stat(name,dir_fd=parent,follow_symlinks=False)
        if s.st_ino!=os.fstat(fd).st_ino or s.st_dev!=device: return
        if marker_name:
            try: os.unlink(marker_name,dir_fd=fd)
            except FileNotFoundError: pass
        os.rmdir(name,dir_fd=parent)
    except OSError: pass
def namespace_dir(parent,name,owner,create):
    expected={"schema":1,"namespace":name,"owner":owner}
    try: f,_,_=directory(parent,name,False)
    except FileNotFoundError:
        if not create: raise
        stage=name+".preparing-"+secrets.token_hex(8)
        f,_,_=directory(parent,stage,True)
        try:
            marker(f,".dimension-owner.json",expected,True)
            try: publish(parent,stage,name)
            except OSError as e:
                if e.errno!=errno.EEXIST: raise
        finally:
            stage_cleanup(parent,stage,f,".dimension-owner.json"); os.close(f)
        f,_,_=directory(parent,name,False)
    try: marker(f,".dimension-owner.json",expected,False)
    except BaseException: os.close(f); raise
    return f
def home_dir(parent,name,owner,create):
    marker_name=".owner-"+name+".json"
    try: f,_,s=directory(parent,name,False)
    except FileNotFoundError:
        if not create: raise
        # A prior cancelled publish may leave our metadata, but never permits
        # recreating a missing home that C++ already recorded as ready.
        try:
            mf=os.open(marker_name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
        except FileNotFoundError: mf=None
        if mf is not None:
            try:
                prior=load(mf)
                if set(prior)!={"schema","owner","botHash","device","inode"} or prior["schema"]!=1 or prior["owner"]!=owner or prior["botHash"]!=name: reject()
            finally: os.close(mf)
        stage=".preparing-"+name+"-"+secrets.token_hex(8)
        f,_,s=directory(parent,stage,True)
        temporary=marker_name+".preparing-"+secrets.token_hex(8)
        try:
            value={"schema":1,"owner":owner,"botHash":name,"device":str(s.st_dev),"inode":str(s.st_ino)}
            marker(parent,temporary,value,True)
            if mf is None: publish(parent,temporary,marker_name)
            else: os.replace(temporary,marker_name,src_dir_fd=parent,dst_dir_fd=parent)
            os.fsync(parent)
            publish(parent,stage,name)
        finally:
            stage_cleanup(parent,stage,f); os.close(f)
            try: os.unlink(temporary,dir_fd=parent)
            except FileNotFoundError: pass
        f,_,s=directory(parent,name,False)
    try:
        marker(parent,marker_name,{"schema":1,"owner":owner,"botHash":name,"device":str(s.st_dev),"inode":str(s.st_ino)},False)
    except BaseException: os.close(f); raise
    return f
def run():
    global uid,gid,flags,device,libc
    uid,gid=os.getuid(),os.getgid()
    if uid==0: reject()
    line=sys.stdin.buffer.readline(16385)
    if len(line)>16384: reject()
    q=json.loads(line.decode("utf-8"),object_pairs_hook=strict)
    if set(q)!={"root","namespace","owner","botHash","expectedExisting"}: reject()
    root,ns,owner,bot=q["root"],q["namespace"],q["owner"],q["botHash"]
    host_home=pwd.getpwuid(uid).pw_dir.rstrip("/")
    if not host_home.startswith("/home/") or not(root==host_home or root.startswith(host_home+"/")): reject()
    if not isinstance(q["expectedExisting"],bool): reject()
    if not ns.startswith(".dimension-native-") or len(ns)!=50 or len(owner)!=32 or len(bot)!=36 or not bot.startswith("bot-"): reject()
    if any(c not in "0123456789abcdef" for c in ns[18:]+owner+bot[4:]): reject()
    if root.startswith("//") or any(c in ("",".","..") for c in root.split("/")[1:]): reject()
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    f=os.open("/",flags)
    try:
        for part in root.split("/")[1:]:
            following=os.open(part,flags,dir_fd=f)
            os.close(f); f=following
        s=os.fstat(f)
        if s.st_uid!=uid or s.st_gid!=gid: reject()
        # Use the actual fd, not a path-prefix guess: tmpfs/DrvFS are not persistent ext4.
        libc=ctypes.CDLL(None,use_errno=True)
        buf=ctypes.create_string_buffer(512)
        libc.fstatfs.argtypes=[ctypes.c_int,ctypes.c_void_p]
        libc.fstatfs.restype=ctypes.c_int
        if libc.fstatfs(f,buf)!=0 or ctypes.c_long.from_buffer(buf).value!=0xEF53: reject()
        device=s.st_dev
        os.umask(0o007)
        nf=namespace_dir(f,ns,owner,not q["expectedExisting"])
        try:
            # Host and managed guest share only the controlled group. Keep
            # these verified directories inaccessible to unrelated users.
            os.fchmod(nf,0o770)
            hf=home_dir(nf,bot,owner,not q["expectedExisting"])
            os.fchmod(hf,0o770)
            try:
                os.fsync(hf)
            finally: os.close(hf)
            os.fsync(nf)
        finally: os.close(nf)
        os.fsync(f)
    finally: os.close(f)
try:
    run()
    print('{"ok":true}',flush=True)
except BaseException:
    print('{"ok":false}',flush=True)
)PY";

Json default_prepare(const fs::path& executable, const std::vector<std::wstring>& args,
                     const fs::path& cwd, const Json& request, std::stop_token stop) {
    require(!stop.stop_requested(), "Desktop home initialization cancelled");
    struct State {
        std::mutex mutex;
        std::condition_variable_any changed;
        bool exit = false, exit_ok = false, reply = false, reply_ok = false, invalid = false;
    };
    auto state = std::make_shared<State>();
    const auto deadline = std::chrono::steady_clock::now() + 10s;
    JsonProcessSession session(executable, args, cwd, [state](const Json& line) {
        std::lock_guard lock(state->mutex);
        if (const auto* event = line.find("event"); event && event->is_string() && event->as_string() == "exit") {
            state->exit = true;
            const auto* ok = line.find("ok");
            state->exit_ok = ok && ok->is_bool() && ok->as_bool();
        } else {
            const auto* ok = line.find("ok");
            if (state->reply || !line.is_object() || line.as_object().size() != 1 || !ok || !ok->is_bool())
                state->invalid = true;
            state->reply = true;
            state->reply_ok = ok && ok->is_bool() && ok->as_bool();
        }
        state->changed.notify_all();
    });
    require(session.send(request), "Cannot dispatch desktop home initialization");
    std::unique_lock lock(state->mutex);
    state->changed.wait_until(lock, stop, deadline, [&] { return state->exit; });
    const bool complete = state->exit && state->exit_ok && state->reply && state->reply_ok && !state->invalid;
    lock.unlock();
    session.close();
    require(!stop.stop_requested(), "Desktop home initialization cancelled");
    require(complete, "Desktop home initialization failed or timed out");
    return O{{"ok", true}};
}
} // namespace

void DesktopHomes::validate_distribution(std::string_view value) {
    require(!value.empty() && value.size() <= 80 &&
        std::all_of(value.begin(), value.end(), [](char c) {
            return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                   (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.';
        }) && value != "." && value != "..", "Invalid desktop home distribution");
}
void DesktopHomes::validate_bot_hash(std::string_view value) {
    require(value.starts_with("bot-") && hex32(value.substr(4)), "Invalid desktop home Bot hash");
}
void DesktopHomes::validate_linux_root(std::string_view value) {
    require(value.starts_with("/home/") && value.size() <= 1024 && value.back() != '/',
            "Native desktop home root must be an absolute path below /home");
    std::size_t begin = 1;
    while (begin < value.size()) {
        const auto end = value.find('/', begin);
        const auto part = value.substr(begin, end == value.npos ? value.size() - begin : end - begin);
        require(!part.empty() && part.size() <= 255 && part != "." && part != ".." &&
            std::all_of(part.begin(), part.end(), [](char c) {
                return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                       (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.';
            }), "Native desktop home root contains an invalid component");
        if (end == value.npos) break;
        begin = end + 1;
    }
}

struct DesktopHomes::Impl {
    fs::path data, file, wsl;
    std::string distribution;
    NativeHomePrepare prepare;
    Walk data_guard;
    Handle lock;
    Json state;
    std::timed_mutex mutex;
    std::map<std::string, Walk> legacy_guards;

    Impl(fs::path directory, std::string distro, std::optional<std::string> root,
         fs::path executable, NativeHomePrepare worker)
        : data(local_path(directory)), file(data / L"desktop-homes.json"), wsl(std::move(executable)),
          distribution(std::move(distro)), prepare(worker ? std::move(worker) : default_prepare) {
        if (!distribution.empty()) DesktopHomes::validate_distribution(distribution);
        if (root) DesktopHomes::validate_linux_root(*root);
        data_guard = directories(data, true);
        lock = Handle(CreateFileW(extended(data / L"desktop-homes.lock").c_str(), GENERIC_READ | GENERIC_WRITE,
            0, nullptr, OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        require(lock.valid(), "Desktop home data is already in use or cannot be locked");
        (void)info(lock.get(), false);
        const auto saved = read_manifest(file);
        if (!saved) {
            require(!root || !distribution.empty(), "Native desktop homes require a configured distribution");
            state = O{{"schema", 1}, {"distribution", distribution}, {"linuxRoot", root.value_or("")},
                {"namespace", std::string(namespace_prefix) + random_hex()}, {"owner", random_hex()},
                {"dataDirectory", utf8(data)}, {"homes", O{}}};
            save_manifest(file, state);
            return;
        }
        state = *saved;
        fields(state, {"schema", "distribution", "linuxRoot", "namespace", "owner", "dataDirectory", "homes"});
        require(state.at("schema").is_number() && state.at("schema").as_number() == 1,
                "Unsupported desktop home manifest schema");
        const auto saved_distribution = text(state, "distribution");
        if (!saved_distribution.empty()) {
            DesktopHomes::validate_distribution(saved_distribution);
            if (distribution.empty()) distribution = saved_distribution;
        }
        require(same_path(local_path(path8(text(state, "dataDirectory"))), data),
                "Desktop home manifest belongs to another data directory");
        const auto ns = text(state, "namespace");
        require(ns.starts_with(namespace_prefix) && hex32(std::string_view(ns).substr(namespace_prefix.size())) &&
            hex32(text(state, "owner")), "Invalid desktop home ownership identity");
        const auto selected_root = text(state, "linuxRoot");
        if (!selected_root.empty()) {
            DesktopHomes::validate_linux_root(selected_root);
            require(!saved_distribution.empty(), "Native home manifest has no bound distribution");
        }
        require(state.at("homes").is_object() && state.at("homes").as_object().size() <= home_limit,
                "Invalid desktop home manifest entries");
        bool has_linux_home = false;
        for (const auto& [hash, home] : state.at("homes").as_object()) {
            DesktopHomes::validate_bot_hash(hash);
            fields(home, {"storage", "legacyHome"});
            const auto storage = text(home, "storage");
            require(storage == "windows" || (storage == "linux" && !selected_root.empty()), "Invalid saved desktop home storage");
            if (storage == "linux") has_linux_home = true;
            require(same_path(local_path(path8(text(home, "legacyHome"))), data / L"desktops" / path8(hash) / L"home"),
                    "Invalid saved legacy home path");
        }
        require(!has_linux_home || saved_distribution == distribution, "Desktop home distribution cannot change after native selection");
        auto updated = state.as_object();
        bool changed = false;
        if (saved_distribution != distribution) {
            updated["distribution"] = distribution; changed = true;
        }
        if (root && *root != selected_root) {
            require(!has_linux_home, "Configured native desktop home root cannot change after native selection");
            require(!distribution.empty(), "Native desktop homes require a configured distribution");
            updated["linuxRoot"] = *root; changed = true;
        }
        if (changed) { save_manifest(file, updated); state = std::move(updated); }
    }

    DesktopHome resolve(std::string_view hash_view, const fs::path& legacy_input, std::stop_token stop) {
        std::unique_lock guard(mutex, std::defer_lock);
        while (!guard.try_lock_for(20ms)) require(!stop.stop_requested(), "Desktop home selection cancelled");
        require(!stop.stop_requested(), "Desktop home selection cancelled");
        DesktopHomes::validate_bot_hash(hash_view);
        const std::string hash(hash_view);
        const auto legacy = local_path(legacy_input);
        require(same_path(legacy, data / L"desktops" / path8(hash) / L"home"), "Legacy desktop home is outside its data location");
        const auto* saved = state.at("homes").find(hash);
        require(saved || state.at("homes").as_object().size() < home_limit, "Desktop home entry limit exceeded");
        auto walk = directories(legacy, false);
        const auto root = text(state, "linuxRoot");
        const auto storage = saved ? text(*saved, "storage") : walk.exists || root.empty() ? "windows" : "linux";
        std::optional<Json> pending;
        if (!saved) {
            auto next = state.as_object();
            auto homes = state.at("homes").as_object();
            homes.emplace(hash, O{{"storage", storage}, {"legacyHome", utf8(legacy)}});
            next["homes"] = std::move(homes);
            require(Json(next).dump().size() <= manifest_limit, "Desktop home manifest exceeds size limit");
            pending = Json(std::move(next));
        }
        DesktopHome result;
        result.storage = storage;
        if (storage == "windows") {
            require(!saved || walk.exists, "Recorded legacy desktop home is missing; refusing an empty replacement");
            if (!walk.exists) walk = directories(legacy, true);
            result.windows_path = legacy;
            auto path = utf8(legacy); std::replace(path.begin(), path.end(), '\\', '/');
            auto drive = path.front();
            if (drive >= 'A' && drive <= 'Z') drive = static_cast<char>(drive - 'A' + 'a');
            result.linux_path = "/mnt/" + std::string(1, drive) + path.substr(2);
            legacy_guards[hash] = std::move(walk);
        } else {
            require(wsl.is_absolute(), "Native desktop homes require an absolute WSL executable");
            const auto ns = text(state, "namespace");
            result.linux_path = root + "/" + ns + "/" + hash;
            auto network = std::string("\\\\wsl.localhost\\") + distribution + result.linux_path;
            std::replace(network.begin() + static_cast<std::ptrdiff_t>(std::string("\\\\wsl.localhost\\").size()),
                         network.end(), '/', '\\');
            result.windows_path = path8(network);
            std::vector<std::wstring> args{L"-d", path8(distribution).wstring(), L"--exec", L"/usr/bin/python3", L"-c",
                                           path8(prepare_script).wstring()};
            const auto reply = prepare(wsl, args, data,
                O{{"root", root}, {"namespace", ns}, {"owner", text(state, "owner")},
                  {"botHash", hash}, {"expectedExisting", saved != nullptr}}, stop);
            require(reply.is_object() && reply.as_object().size() == 1 && reply.find("ok") &&
                reply.at("ok").is_bool() && reply.at("ok").as_bool(), "Native desktop home preparation was rejected");
        }
        require(!stop.stop_requested(), "Desktop home selection cancelled");
        if (pending) {
            save_manifest(file, *pending);
            state = std::move(*pending);
        }
        return result;
    }
};
DesktopHomes::DesktopHomes(fs::path data, std::string distribution, std::optional<std::string> linux_root,
                           fs::path wsl, NativeHomePrepare prepare)
    : impl_(std::make_unique<Impl>(std::move(data), std::move(distribution), std::move(linux_root),
                                  std::move(wsl), std::move(prepare))) {}
DesktopHomes::~DesktopHomes() = default;
std::string DesktopHomes::distribution() const { return impl_->distribution; }
DesktopHome DesktopHomes::resolve(std::string_view hash, const fs::path& legacy, std::stop_token stop) {
    return impl_->resolve(hash, legacy, stop);
}
} // namespace dimension
