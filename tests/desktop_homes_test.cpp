#include "dimension/desktop_homes.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winioctl.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <thread>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
using O = Json::Object;
std::size_t checks{};
void check(bool value, const char* description, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + description);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
template<class F> void rejected(F action) {
    ++checks;
    try { action(); } catch (const std::exception&) { return; }
    throw std::runtime_error("Expected desktop-home rejection");
}
std::wstring native(const fs::path& path) {
    auto normalized = path.lexically_normal();
    normalized.make_preferred();
    return L"\\\\?\\" + normalized.wstring();
}
std::string read(const fs::path& file) {
    std::ifstream input(native(file), std::ios::binary);
    if (!input) throw std::runtime_error("Cannot read fixture");
    return {std::istreambuf_iterator<char>(input), {}};
}
void write(const fs::path& file, const std::string& bytes) {
    std::ofstream output(native(file), std::ios::binary | std::ios::trunc);
    output << bytes;
    if (!output) throw std::runtime_error("Cannot write fixture");
}
std::string hash(char c) { return "bot-" + std::string(32, c); }
fs::path legacy(const fs::path& data, char c) { return data / L"desktops" / fs::path(hash(c)) / L"home"; }
void mkdir(const fs::path& path) { fs::create_directories(native(path)); }
Json manifest(const fs::path& data) { return Json::parse(read(data / L"desktop-homes.json")); }
struct Mock {
    std::atomic<int> calls = 0;
    std::vector<Json> requests;
    NativeHomePrepare worker() {
        return [&](const fs::path& exe, const std::vector<std::wstring>& args, const fs::path& cwd,
                   const Json& request, std::stop_token stop) -> Json {
            CHECK(exe.is_absolute()); CHECK(cwd.is_absolute()); CHECK(!stop.stop_requested());
            CHECK(args.size() == 6); CHECK(args[0] == L"-d"); CHECK(args[2] == L"--exec");
            CHECK(args[3] == L"/usr/bin/python3"); CHECK(args[4] == L"-c");
            CHECK(request.as_object().size() == 5);
            CHECK(request.at("namespace").as_string().starts_with(".dimension-native-"));
            CHECK(request.at("owner").as_string().size() == 32);
            requests.push_back(request); ++calls;
            return O{{"ok", true}};
        };
    }
};
void validation() {
    DesktopHomes::validate_linux_root("/home/dimension");
    DesktopHomes::validate_linux_root("/home/dimension/.local/homes");
    DesktopHomes::validate_distribution("dimension-sandbox");
    DesktopHomes::validate_bot_hash(hash('a'));
    for (const auto* root : {"", "/", "/home", "/home/", "/mnt/l/homes", "/proc/x", "/sys/x",
            "/dev/x", "/usr/x", "/etc/x", "/tmp/x", "/var/x", "relative", "~/homes",
            "/home/user/../other", "/home//user", "/home/user/.", "/home/user/", "/home/user/a b"}) {
        rejected([&] { DesktopHomes::validate_linux_root(root); });
    }
    for (const auto* distro : {"", ".", "..", "bad/name", "bad\\name", "has space"})
        rejected([&] { DesktopHomes::validate_distribution(distro); });
    rejected([] { DesktopHomes::validate_bot_hash("bot-../escape"); });
    rejected([] { DesktopHomes::validate_bot_hash("bot-ABC"); });
}
void sticky_and_scope(const fs::path& output) {
    const auto data = output / L"sticky";
    Mock mock;
    std::string ns, owner;
    {
        DesktopHomes homes(data, "");
        CHECK(homes.distribution().empty());
        const auto old = homes.resolve(hash('a'), legacy(data, 'a'));
        CHECK(old.storage == "windows"); CHECK(old.windows_path == legacy(data, 'a'));
        CHECK(old.linux_path.starts_with("/mnt/"));
        write(old.windows_path / L"synthetic-profile.txt", "synthetic login marker");
        rejected([&] { DesktopHomes another(data, ""); });
    }
    {
        DesktopHomes homes(data, "fixture", "/home/default", output / L"fake-wsl.exe", mock.worker());
        CHECK(homes.distribution() == "fixture");
        const auto old = homes.resolve(hash('a'), legacy(data, 'a'));
        CHECK(old.storage == "windows"); CHECK(mock.calls == 0);
        CHECK(read(old.windows_path / L"synthetic-profile.txt") == "synthetic login marker");
        const auto selected = homes.resolve(hash('b'), legacy(data, 'b'));
        CHECK(selected.storage == "linux"); CHECK(selected.windows_path.wstring().starts_with(L"\\\\wsl.localhost\\fixture\\home\\default\\"));
        CHECK(!fs::exists(native(legacy(data, 'b'))));
        CHECK(!mock.requests.back().at("expectedExisting").as_bool());
        ns = manifest(data).at("namespace").as_string(); owner = manifest(data).at("owner").as_string();
        CHECK(selected.linux_path == "/home/default/" + ns + "/" + hash('b'));
        (void)homes.resolve(hash('b'), legacy(data, 'b'));
        CHECK(mock.requests.back().at("expectedExisting").as_bool());
        rejected([&] { (void)homes.resolve(hash('c'), output / L"outside"); });
        std::stop_source stopped; stopped.request_stop();
        const auto calls = mock.calls.load();
        rejected([&] { (void)homes.resolve(hash('c'), legacy(data, 'c'), stopped.get_token()); });
        CHECK(mock.calls == calls);
    }
    {
        DesktopHomes homes(data, "", {}, output / L"fake-wsl.exe", mock.worker());
        CHECK(homes.distribution() == "fixture");
        CHECK(homes.resolve(hash('b'), legacy(data, 'b')).storage == "linux");
        CHECK(manifest(data).at("namespace").as_string() == ns);
        CHECK(manifest(data).at("owner").as_string() == owner);
        CHECK(homes.resolve(hash('a'), legacy(data, 'a')).storage == "windows");
    }
    const auto before = read(data / L"desktop-homes.json");
    rejected([&] { DesktopHomes changed(data, "another", {}, output / L"fake-wsl.exe", mock.worker()); });
    rejected([&] { DesktopHomes changed(data, "fixture", "/home/other", output / L"fake-wsl.exe", mock.worker()); });
    CHECK(read(data / L"desktop-homes.json") == before);
    const auto other = output / L"other-instance";
    {
        DesktopHomes homes(other, "fixture", "/home/default", output / L"fake-wsl.exe", mock.worker());
        CHECK(homes.resolve(hash('b'), legacy(other, 'b')).linux_path != "/home/default/" + ns + "/" + hash('b'));
        CHECK(manifest(other).at("owner").as_string() != owner);
    }
    const auto preexisting = output / L"legacy-existing";
    mkdir(legacy(preexisting, 'd'));
    write(legacy(preexisting, 'd') / L"keep.txt", "keep");
    DesktopHomes homes(preexisting, "fixture", "/home/default", output / L"fake-wsl.exe", mock.worker());
    CHECK(homes.resolve(hash('d'), legacy(preexisting, 'd')).storage == "windows");
    CHECK(read(legacy(preexisting, 'd') / L"keep.txt") == "keep");
}
void pinned_legacy_directory(const fs::path& output) {
    const auto data = output / L"directory-pin", source = legacy(data, 'a');
    const auto moved = source.parent_path() / L"home-moved";
    CHECK(source.is_absolute() && moved.parent_path() == source.parent_path());
    {
        DesktopHomes homes(data, "");
        CHECK(homes.resolve(hash('a'), source).storage == "windows");
        write(source / L"synthetic-marker.txt", "owned home");
        const auto renamed = MoveFileExW(native(source).c_str(), native(moved).c_str(), 0);
        const auto error = GetLastError();
        if (renamed) CHECK(MoveFileExW(native(moved).c_str(), native(source).c_str(), 0));
        CHECK(!renamed && error == ERROR_SHARING_VIOLATION);
        CHECK(read(source / L"synthetic-marker.txt") == "owned home");
    }
    CHECK(MoveFileExW(native(source).c_str(), native(moved).c_str(), 0));
    CHECK(read(moved / L"synthetic-marker.txt") == "owned home");
    CHECK(MoveFileExW(native(moved).c_str(), native(source).c_str(), 0));
}
void failure_and_configuration(const fs::path& output) {
    const auto data = output / L"retry";
    NativeHomePrepare failure = [](const auto&, const auto&, const auto&, const auto&, auto) -> Json {
        return O{{"ok", false}};
    };
    {
        DesktopHomes homes(data, "first", "/home/missing", output / L"fake.exe", failure);
        rejected([&] { (void)homes.resolve(hash('a'), legacy(data, 'a')); });
        CHECK(manifest(data).at("homes").as_object().empty());
    }
    Mock mock;
    {
        // A failed first initialization must not permanently pin a mistaken root/distro.
        DesktopHomes homes(data, "corrected", "/home/default", output / L"fake.exe", mock.worker());
        CHECK(homes.resolve(hash('a'), legacy(data, 'a')).storage == "linux");
        CHECK(manifest(data).at("distribution").as_string() == "corrected");
    }
    const auto invalid = output / L"invalid";
    rejected([&] { DesktopHomes homes(invalid, "", "/home/default"); });
    const auto corrupt = output / L"corrupt";
    { DesktopHomes homes(corrupt, ""); }
    auto value = manifest(corrupt).as_object();
    value["unknown"] = true; write(corrupt / L"desktop-homes.json", Json(value).dump());
    const auto bytes = read(corrupt / L"desktop-homes.json");
    rejected([&] { DesktopHomes homes(corrupt, ""); });
    CHECK(read(corrupt / L"desktop-homes.json") == bytes);

    const auto missing = output / L"missing-recorded-home";
    { DesktopHomes homes(missing, ""); }
    value = manifest(missing).as_object();
    auto path = legacy(missing, 'a').u8string();
    value["homes"] = O{{hash('a'), O{{"storage", "windows"},
        {"legacyHome", std::string(reinterpret_cast<const char*>(path.data()), path.size())}}}};
    write(missing / L"desktop-homes.json", Json(value).dump());
    DesktopHomes homes(missing, "");
    rejected([&] { (void)homes.resolve(hash('a'), legacy(missing, 'a')); });
    CHECK(!fs::exists(native(legacy(missing, 'a'))));
}
void cancellation_while_waiting(const fs::path& output) {
    const auto data = output / L"cancel-wait";
    std::mutex mutex; std::condition_variable condition;
    bool entered = false, release = false;
    NativeHomePrepare slow = [&](const auto&, const auto&, const auto&, const auto&, auto) -> Json {
        std::unique_lock guard(mutex); entered = true; condition.notify_all();
        condition.wait(guard, [&] { return release; });
        return O{{"ok", true}};
    };
    DesktopHomes homes(data, "fixture", "/home/default", output / L"fake.exe", slow);
    std::exception_ptr first_error;
    std::thread first([&] { try { (void)homes.resolve(hash('a'), legacy(data, 'a')); } catch (...) { first_error = std::current_exception(); } });
    { std::unique_lock guard(mutex); condition.wait(guard, [&] { return entered; }); }
    std::stop_source stopped;
    std::atomic_bool cancelled = false;
    const auto began = std::chrono::steady_clock::now();
    std::thread second([&] { try { (void)homes.resolve(hash('b'), legacy(data, 'b'), stopped.get_token()); }
        catch (...) { cancelled = true; } });
    stopped.request_stop(); second.join();
    const auto elapsed = std::chrono::steady_clock::now() - began;
    { std::lock_guard guard(mutex); release = true; condition.notify_all(); }
    first.join();
    if (first_error) std::rethrow_exception(first_error);
    CHECK(cancelled); CHECK(elapsed < 1s);
    CHECK(manifest(data).at("homes").as_object().size() == 1);
}
void junction(const fs::path& source, const fs::path& target) {
    mkdir(source);
    const auto destination = L"\\??\\" + target.wstring();
    struct Data {
        DWORD tag; WORD length, reserved, substitute_offset, substitute_length, print_offset, print_length;
        WCHAR path[2048];
    } data{};
    CHECK(destination.size() + 2 < 2048);
    data.tag = IO_REPARSE_TAG_MOUNT_POINT;
    data.substitute_length = static_cast<WORD>(destination.size() * sizeof(WCHAR));
    data.print_offset = data.substitute_length + sizeof(WCHAR);
    data.length = static_cast<WORD>(8 + data.print_offset + sizeof(WCHAR));
    std::copy(destination.begin(), destination.end(), data.path);
    HANDLE handle = CreateFileW(native(source).c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    CHECK(handle != INVALID_HANDLE_VALUE);
    DWORD written{};
    const auto ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &data, data.length + 8,
                                    nullptr, 0, &written, nullptr);
    CloseHandle(handle); CHECK(ok);
}
void path_and_reparse_guards(const fs::path& output) {
    const auto target = output / L"foreign"; mkdir(target);
    const auto link = output / L"link"; junction(link, target);
    rejected([&] { DesktopHomes homes(link / L"should-not-exist", ""); });
    CHECK(!fs::exists(native(target / L"should-not-exist")));
    const auto data = output / L"legacy-link";
    { DesktopHomes homes(data, ""); }
    junction(legacy(data, 'a'), target);
    Mock mock;
    DesktopHomes homes(data, "fixture", "/home/default", output / L"fake.exe", mock.worker());
    rejected([&] { (void)homes.resolve(hash('a'), legacy(data, 'a')); });
    auto long_data = output / L"long";
    while (long_data.wstring().size() < 310) long_data /= L"long-component";
    {
        DesktopHomes long_homes(long_data, "");
        CHECK(long_homes.resolve(hash('a'), legacy(long_data, 'a')).storage == "windows");
    }
    CHECK(manifest(long_data).at("homes").as_object().size() == 1);
    rejected([&] { DesktopHomes bad(output / L".." / L"escape", ""); });
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto output = fs::path(argv[1]) /
            ("homes-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        mkdir(output);
        validation(); sticky_and_scope(output); pinned_legacy_directory(output); failure_and_configuration(output);
        cancellation_while_waiting(output); path_and_reparse_guards(output);
        std::cout << "desktop_homes: " << checks << " checks passed (Windows fixtures and injected native preparation; no WSL test)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
