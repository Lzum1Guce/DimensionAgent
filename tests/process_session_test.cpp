#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include "dimension/process_session.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include <fcntl.h>
#include <io.h>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
std::atomic<std::size_t> checks = 0;
std::mutex child_stdout;

void check(bool condition, const char* message) {
    ++checks;
    if (!condition) throw std::runtime_error(message);
}
std::string utf8(std::wstring_view value) {
    if (value.empty()) return {};
    const auto size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (!size) throw std::runtime_error("Fixture UTF-8 conversion failed");
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}
fs::path path8(const std::string& value) {
    return fs::path(std::u8string_view(reinterpret_cast<const char8_t*>(value.data()), value.size()));
}
fs::path extended(const fs::path& value) {
    auto path = value.lexically_normal(); path.make_preferred();
    const auto native = path.wstring();
    if (native.starts_with(L"\\\\?\\")) return native;
    if (native.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + native.substr(2);
    return L"\\\\?\\" + native;
}
std::wstring env(const wchar_t* name) {
    const auto size = GetEnvironmentVariableW(name, nullptr, 0);
    if (!size) return {};
    std::wstring value(size, L'\0');
    value.resize(GetEnvironmentVariableW(name, value.data(), size)); return value;
}
fs::path own_executable() {
    std::wstring value(32768, L'\0');
    const auto size = GetModuleFileNameW(nullptr, value.data(), static_cast<DWORD>(value.size()));
    if (!size || size >= value.size()) throw std::runtime_error("Cannot locate fixture executable");
    value.resize(size); return value;
}
std::wstring quote(std::wstring_view value) {
    std::wstring result = L"\""; std::size_t slashes = 0;
    for (const auto character : value) {
        if (character == L'\\') { ++slashes; continue; }
        result.append(character == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
        result += character; slashes = 0;
    }
    result.append(slashes * 2, L'\\'); return result + L'\"';
}
void raw(HANDLE pipe, std::string_view bytes) {
    while (!bytes.empty()) {
        DWORD written = 0;
        if (!WriteFile(pipe, bytes.data(), static_cast<DWORD>(std::min<std::size_t>(65536, bytes.size())), &written, nullptr) || !written) return;
        bytes.remove_prefix(written);
    }
}
void emit(Json value) {
    std::lock_guard guard(child_stdout);
    raw(GetStdHandle(STD_OUTPUT_HANDLE), value.dump() + '\n');
}
PROCESS_INFORMATION spawn(const std::vector<std::wstring>& args, bool inherit = true, const fs::path& cwd = {}) {
    const auto executable = own_executable();
    auto command = quote(executable.wstring());
    for (const auto& arg : args) command += L" " + quote(arg);
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
    if (inherit) {
        startup.dwFlags |= STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    }
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, inherit,
        CREATE_NO_WINDOW, nullptr, cwd.empty() ? nullptr : cwd.c_str(), &startup, &child)) throw std::runtime_error("Fixture launch failed");
    return child;
}

int worker(int argc, wchar_t** argv) {
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY); _setmode(_fileno(stderr), _O_BINARY);
    const std::wstring mode = argv[2];
    if (mode == L"raw-options" && std::wstring(GetCommandLineW()).find(L"\"--worker\"") != std::wstring::npos)
        return 127; // WSL-style option parsers do not recognize quoted switches.
    if (mode == L"sleep") { Sleep(60000); return 0; }
    if (mode == L"empty") return 0;
    if (mode == L"invalid") { raw(GetStdHandle(STD_ERROR_HANDLE), "STDERR_PRIVATE_SECRET"); raw(GetStdHandle(STD_OUTPUT_HANDLE), "STDOUT_PRIVATE_SECRET not JSON\n"); Sleep(60000); return 0; }
    if (mode == L"oversized") { raw(GetStdHandle(STD_OUTPUT_HANDLE), std::string(8 * 1024 * 1024 + 20, 'x')); Sleep(60000); return 0; }
    if (mode == L"unterminated") { raw(GetStdHandle(STD_OUTPUT_HANDLE), "{}"); return 0; }
    if (mode == L"blank") { raw(GetStdHandle(STD_OUTPUT_HANDLE), "\n"); return 0; }
    if (mode == L"exit-error") { emit(Json::Object{{"event", "data"}}); raw(GetStdHandle(STD_ERROR_HANDLE), "PRIVATE_SECRET"); return 17; }
    if (mode == L"early-eof") { _close(_fileno(stdout)); Sleep(60000); return 0; }
    if (mode == L"large") {
        emit(Json(std::string(5 * 1024 * 1024, 'a')));
        raw(GetStdHandle(STD_OUTPUT_HANDLE), "\"" + std::string(8 * 1024 * 1024 - 2, 'b') + "\"\r\n");
        return 0;
    }
    if (mode == L"tree-child") {
        auto grandchild = spawn({L"--worker", L"sleep"});
        emit(Json::Object{{"event", "tree"}, {"pids", Json::Array{static_cast<double>(std::stoul(argv[3])),
            static_cast<double>(GetCurrentProcessId()), static_cast<double>(grandchild.dwProcessId)}}});
        CloseHandle(grandchild.hThread); CloseHandle(grandchild.hProcess); Sleep(60000); return 0;
    }
    if (mode == L"tree") {
        auto child = spawn({L"--worker", L"tree-child", std::to_wstring(GetCurrentProcessId())});
        CloseHandle(child.hThread); CloseHandle(child.hProcess); Sleep(60000); return 0;
    }
    if (mode == L"handle") {
        SetEvent(reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(std::stoull(argv[3]))));
        emit(Json::Object{{"event", "attempted"}}); return 0;
    }
    Json::Array args;
    for (int i = 3; i < argc; ++i) args.emplace_back(utf8(argv[i]));
    bool temp_written = false;
    {
        std::ofstream file(fs::path(env(L"TEMP")) / L"session-temp-probe.txt", std::ios::binary);
        file << "task-local temporary file"; file.close(); temp_written = static_cast<bool>(file);
    }
    emit(Json::Object{{"event", "ready"}, {"args", args}, {"cwd", utf8(fs::current_path().wstring())},
        {"temp", utf8(env(L"TEMP"))}, {"tmp", utf8(env(L"TMP"))}, {"custom", utf8(env(L"SESSION_TEST_VALUE"))},
        {"tempWritten", temp_written},
        {"secretVisible", !env(L"SESSION_PRIVATE_SECRET").empty()}, {"console", GetConsoleWindow() != nullptr},
        {"pathSet", !env(L"PATH").empty()}, {"systemRootSet", !env(L"SYSTEMROOT").empty()}});
    if (mode == L"no-read") { Sleep(60000); return 0; }
    std::thread ticks, noise;
    if (mode == L"concurrent") {
        ticks = std::thread([] { for (int i = 0; i < 128; ++i) emit(Json::Object{{"event", "tick"}, {"n", i}}); });
        noise = std::thread([] { for (int i = 0; i < 1024; ++i) raw(GetStdHandle(STD_ERROR_HANDLE), std::string(8192, 'e')); });
    }
    std::string line;
    int seen = 0;
    while (std::getline(std::cin, line)) {
        const auto request = Json::parse(line);
        if (const auto* op = request.find("op"); op && op->is_string() && op->as_string() == "quit") break;
        emit(Json::Object{{"event", "echo"}, {"value", request}}); ++seen;
    }
    if (ticks.joinable()) ticks.join(); if (noise.joinable()) noise.join();
    if (mode == L"eof") {
        std::ofstream marker(fs::path(argv[3]), std::ios::binary); marker << "EOF"; marker.close();
        emit(Json::Object{{"event", "eof"}, {"seen", seen}}); Sleep(150);
    }
    return 0;
}

std::string event_name(const Json& value) {
    const auto* event = value.find("event"); return event && event->is_string() ? event->as_string() : std::string{};
}
struct Collector {
    std::mutex mutex;
    std::condition_variable changed;
    std::vector<Json> lines;
    std::atomic<int> inside{0};
    std::atomic_bool overlap{false};
    void receive(const Json& value) {
        if (++inside != 1) overlap = true;
        { std::lock_guard guard(mutex); lines.push_back(value); }
        --inside; changed.notify_all();
    }
    JsonProcessSession::LineCallback callback() { return [this](const Json& value) { receive(value); }; }
    std::size_t count(const std::string& name) {
        std::lock_guard guard(mutex);
        return static_cast<std::size_t>(std::count_if(lines.begin(), lines.end(), [&](const Json& value) { return event_name(value) == name; }));
    }
    void wait_for(const std::string& name, std::size_t count = 1, std::chrono::milliseconds timeout = 8s) {
        std::unique_lock guard(mutex);
        check(changed.wait_for(guard, timeout, [&] {
            return static_cast<std::size_t>(std::count_if(lines.begin(), lines.end(), [&](const Json& value) { return event_name(value) == name; })) >= count;
        }), "Timed out waiting for session callback");
    }
    Json first(const std::string& name) {
        std::lock_guard guard(mutex);
        for (const auto& value : lines) if (event_name(value) == name) return value;
        throw std::runtime_error("Missing session event");
    }
    void verify_exit(const std::string& error = {}) {
        wait_for("exit");
        std::lock_guard guard(mutex);
        check(!overlap, "Session callbacks overlapped");
        check(event_name(lines.back()) == "exit", "Exit notification was not the final callback");
        check(std::count_if(lines.begin(), lines.end(), [](const auto& value) { return event_name(value) == "exit"; }) == 1, "Exit notification duplicated");
        const auto& exit = lines.back();
        check(exit.at("ok").as_bool() == error.empty(), "Exit success flag differs from expectation");
        if (!error.empty()) check(exit.at("error").at("code").as_string() == error, "Unexpected session exit category");
        check(exit.dump().find("SECRET") == std::string::npos, "Exit notification leaked private diagnostics");
    }
};

void stopped_tree(const Json& pids) {
    check(pids.as_array().size() == 3, "Expected three levels of fixture processes");
    for (const auto& id : pids.as_array()) {
        HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(id.as_number()));
        if (!process) { check(GetLastError() == ERROR_INVALID_PARAMETER, "Cannot inspect fixture descendant"); continue; }
        const auto waited = WaitForSingleObject(process, 2000); CloseHandle(process);
        check(waited == WAIT_OBJECT_0, "Session descendant survived cleanup");
    }
}
template<class Function>
void expect_launch_error(Function function) {
    bool caught = false;
    try { function(); }
    catch (const ProcessError& error) {
        caught = true;
        check(std::string(error.what()).find("SECRET") == std::string::npos, "Launch error leaked private arguments");
    }
    check(caught, "Expected redacted launch error");
}

void basic(const fs::path& executable, const fs::path& cwd) {
    Collector collector;
    const std::vector<std::wstring> special{L"", L"普通中文", L"space value", L"literal\"quote", L"slash\\", L"space trailing\\",
        L"tab\tvalue", L"line\r\nbreak", L"\\\\\"", L"& | %COMSPEC% $(PRIVATE_SECRET)"};
    auto args = std::vector<std::wstring>{L"--worker", L"echo"}; args.insert(args.end(), special.begin(), special.end());
    const auto prior = env(L"SESSION_PRIVATE_SECRET");
    SetEnvironmentVariableW(L"SESSION_PRIVATE_SECRET", L"PRIVATE_SECRET");
    JsonProcessSession session(executable, args, cwd, collector.callback(),
        {{L"SESSION_TEST_VALUE", L"显式值"}, {L"TEMP", L"C:\\ignored"}, {L"tmp", L"C:\\ignored"}});
    SetEnvironmentVariableW(L"SESSION_PRIVATE_SECRET", prior.empty() ? nullptr : prior.c_str());
    collector.wait_for("ready"); check(session.running(), "Session did not remain running");
    const auto ready = collector.first("ready");
    check(ready.at("args").as_array().size() == special.size(), "Argument count changed");
    for (std::size_t i = 0; i < special.size(); ++i) check(ready.at("args").as_array()[i].as_string() == utf8(special[i]), "Argument content changed");
    check(fs::equivalent(path8(ready.at("cwd").as_string()), cwd), "Explicit cwd was not used");
    check(!ready.at("secretVisible").as_bool() && !ready.at("console").as_bool(), "Secret environment or console leaked");
    check(ready.at("custom").as_string() == "显式值", "Explicit environment missing");
    check(ready.at("pathSet").as_bool() && ready.at("systemRootSet").as_bool(), "Windows runtime environment missing");
    check(fs::equivalent(path8(ready.at("temp").as_string()).parent_path(), cwd / L".dimension-session-cache") &&
          ready.at("temp").as_string() == ready.at("tmp").as_string(), "Session temporary directory escaped cwd");
    check(ready.at("tempWritten").as_bool(), "Child cannot write its task-local temporary file");
    for (int i = 0; i < 8; ++i) check(session.send(Json::Object{{"n", i}, {"value", "中文\nquote\"\\"}}), "Accepted request was rejected");
    collector.wait_for("echo", 8);
    check(session.send(Json(std::string(1024 * 1024 - 2, 'x'))), "Exact input limit was rejected");
    collector.wait_for("echo", 9);
    check(!session.send(Json(std::string(1024 * 1024 - 1, 'x'))), "Oversized input was accepted");
    check(session.running(), "Rejected oversized input killed the session");
    check(session.send(Json::Object{{"op", "quit"}}), "Quit request failed");
    collector.verify_exit(); session.close(); session.close();
    check(session.transport_exit().at("ok").as_bool(), "Host-owned transport exit remains available after close");
    check(!session.running() && !session.send(Json{}), "Stopped session still accepts input");
}

void long_paths(const fs::path& executable, const fs::path& root) {
    auto cwd = root / std::wstring(90, L'a') / std::wstring(90, L'b');
    while (cwd.wstring().size() <= 305) cwd /= std::wstring(64, L'd');
    fs::create_directories(extended(cwd));
    const auto nested_executable = cwd / L"长路径 worker.exe";
    fs::copy_file(extended(executable), extended(nested_executable));
    check(cwd.wstring().size() > 300 && nested_executable.wstring().size() > 300, "Long-path fixture is not long enough");
    {
        Collector collector;
        try {
            JsonProcessSession session(nested_executable, {L"--worker", L"echo"}, cwd, collector.callback());
            collector.wait_for("ready");
            const auto ready = collector.first("ready");
            check(fs::equivalent(extended(path8(ready.at("cwd").as_string())), extended(cwd)), "Long cwd was silently relocated");
            check(ready.at("tempWritten").as_bool(), "Long cwd temporary file could not be written");
            check(session.send(Json::Object{{"op", "quit"}}), "Long-path session send failed");
            collector.verify_exit(); session.close();
            std::cout << ">300-character cwd supported through an equivalent existing short-path alias\n";
        } catch (const ProcessError& error) {
            check(error.code() == ProcessErrorCode::InvalidArgument && std::string(error.what()) ==
                  "Session cwd exceeds Windows limits and has no usable short-path alias",
                  "Long cwd failed without its explicit OS-limit diagnostic");
            check(collector.lines.empty(), "Unsupported long cwd launched a relocated worker");
            std::cout << ">300-character cwd explicitly rejected: no usable existing short-path alias\n";
        }
    }
    // The real UI failure is a valid cwd below MAX_PATH whose cache and files
    // exceed it. Exercise that independently, with an executable itself >300.
    check(root.wstring().size() + 8 < 252, "Fixture root leaves no room for a bounded-length cwd");
    const auto cache_cwd = root / std::wstring(252 - root.wstring().size() - 1, L'c');
    fs::create_directories(extended(cache_cwd));
    Collector collector;
    JsonProcessSession session(nested_executable, {L"--worker", L"echo"}, cache_cwd, collector.callback());
    collector.wait_for("ready");
    const auto ready = collector.first("ready");
    const auto temporary = path8(ready.at("temp").as_string());
    check(fs::equivalent(extended(path8(ready.at("cwd").as_string())), extended(cache_cwd)), "Cache fixture cwd changed");
    check(fs::equivalent(temporary.parent_path(), extended(cache_cwd / L".dimension-session-cache")), "Long TEMP escaped its selected cwd");
    check((temporary / L"session-temp-probe.txt").wstring().size() > 300, "Temporary file did not cross the long-path boundary");
    check(ready.at("tempWritten").as_bool() && fs::file_size(temporary / L"session-temp-probe.txt") == 25,
          "Child cannot write a real file in its long TEMP path");
    check(session.send(Json::Object{{"op", "quit"}}), "Long-cache session send failed");
    collector.verify_exit(); session.close();
}

void concurrent_traffic(const fs::path& executable, const fs::path& cwd) {
    Collector collector;
    JsonProcessSession session(executable, {L"--worker", L"concurrent"}, cwd, collector.callback());
    collector.wait_for("ready");
    std::atomic<int> accepted = 0;
    std::atomic_bool failed = false;
    std::vector<std::thread> producers;
    for (int producer = 0; producer < 4; ++producer) producers.emplace_back([&, producer] {
        for (int n = 0; n < 40; ++n) {
            const Json request = Json::Object{{"id", producer * 40 + n}, {"payload", std::string(32768, static_cast<char>('a' + producer))}};
            const auto deadline = std::chrono::steady_clock::now() + 8s;
            while (!session.send(request)) {
                if (!session.running() || std::chrono::steady_clock::now() >= deadline) { failed = true; return; }
                std::this_thread::yield();
            }
            ++accepted;
        }
    });
    for (auto& thread : producers) thread.join();
    check(!failed && accepted == 160, "Concurrent producer lost a request");
    collector.wait_for("echo", 160); collector.wait_for("tick", 128);
    check(session.send(Json::Object{{"op", "quit"}}), "Concurrent worker quit failed");
    collector.verify_exit(); session.close();
    std::set<int> ids;
    for (const auto& line : collector.lines) if (event_name(line) == "echo") {
        const auto& value = line.at("value"); ids.insert(static_cast<int>(value.at("id").as_number()));
        check(value.at("payload").as_string().size() == 32768, "Concurrent JSON line was corrupted");
    }
    check(ids.size() == 160, "Concurrent requests were duplicated or omitted");
}

void eof_and_backpressure(const fs::path& executable, const fs::path& cwd) {
    const auto marker = cwd / L"eof-marker.txt";
    {
        Collector collector;
        JsonProcessSession session(executable, {L"--worker", L"eof", marker.wstring()}, cwd, collector.callback());
        collector.wait_for("ready");
        const auto before = std::chrono::steady_clock::now(); session.close();
        check(std::chrono::steady_clock::now() - before >= 100ms, "EOF grace did not wait for cooperative cleanup");
        collector.verify_exit(); check(collector.count("eof") == 1 && fs::file_size(marker) == 3, "Child did not receive EOF before termination");
    }
    {
        Collector collector;
        JsonProcessSession session(executable, {L"--worker", L"no-read"}, cwd, collector.callback());
        collector.wait_for("ready");
        const Json request(std::string(1024 * 1024 - 2, 'x'));
        bool rejected = false;
        for (int i = 0; i < 16; ++i) if (!session.send(request)) { rejected = true; break; }
        check(rejected && session.running(), "Writer queue is not bounded or backpressure killed the session");
        const auto before = std::chrono::steady_clock::now();
        std::thread other([&] { session.close(); }); session.close(); other.join();
        check(std::chrono::steady_clock::now() - before < 4s, "Blocked stdin prevented timely close");
        collector.verify_exit("closed");
    }
}

void protocol_cases(const fs::path& executable, const fs::path& cwd) {
    {
        Collector collector;
        JsonProcessSession session(executable, {L"--worker", L"raw-options", L"--distribution", L"fixture", L"--exec"}, cwd, collector.callback());
        collector.wait_for("ready");
        check(session.send(Json::Object{{"op", "quit"}}), "Raw-option parser fixture rejected its command");
        collector.verify_exit(); session.close();
    }
    for (const auto& [mode, expected] : std::vector<std::pair<std::wstring, std::string>>{
        {L"empty", ""}, {L"invalid", "invalid_json"}, {L"oversized", "output_limit"},
        {L"unterminated", "invalid_json"}, {L"blank", "invalid_json"}, {L"exit-error", "process_exit"}, {L"early-eof", "peer_closed"}}) {
        Collector collector;
        JsonProcessSession session(executable, {L"--worker", mode, L"PRIVATE_ARGUMENT_SECRET"}, cwd, collector.callback());
        collector.verify_exit(expected); session.close();
        const auto transport = session.transport_exit();
        check(transport.at("ok").as_bool() == expected.empty() &&
              (expected.empty() || transport.at("error").at("code").as_string() == expected),
              "Host-owned transport exit preserves the failure category");
        check(!session.running(), "Ended protocol still marked running");
    }
    {
        Collector collector;
        JsonProcessSession session(executable, {L"--worker", L"large"}, cwd, collector.callback());
        collector.verify_exit(); session.close();
        check(collector.lines.size() == 3, "Large JSON line count differs");
        check(collector.lines[0].as_string().size() == 5 * 1024 * 1024, "JSON above previous 4 MiB limit was rejected");
        check(collector.lines[1].as_string().size() == 8 * 1024 * 1024 - 2, "Exact 8 MiB CRLF line was rejected");
    }
    {
        Collector collector;
        JsonProcessSession session(executable, {L"--worker", L"echo"}, cwd, [&](const Json& line) {
            if (event_name(line) == "echo") throw std::runtime_error("CALLBACK_PRIVATE_SECRET");
            collector.receive(line);
        });
        collector.wait_for("ready"); check(session.send(Json{}), "Callback failure request rejected");
        collector.verify_exit("callback_failed"); session.close();
    }
}

void tree_cleanup(const fs::path& executable, const fs::path& cwd) {
    Collector collector;
    JsonProcessSession session(executable, {L"--worker", L"tree"}, cwd, collector.callback());
    collector.wait_for("tree"); const auto pids = collector.first("tree").at("pids");
    session.close(); collector.verify_exit("closed"); stopped_tree(pids);
    SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE unrelated = CreateEventW(&inherit, TRUE, FALSE, nullptr);
    check(unrelated != nullptr, "Cannot create inheritance fixture");
    {
        Collector events;
        JsonProcessSession child(executable, {L"--worker", L"handle", std::to_wstring(reinterpret_cast<std::uintptr_t>(unrelated))}, cwd, events.callback());
        events.verify_exit(); child.close();
        check(WaitForSingleObject(unrelated, 0) == WAIT_TIMEOUT, "Unrelated inheritable handle reached child");
    }
    CloseHandle(unrelated);
}

int crash_host(const fs::path& cwd, const fs::path& marker) {
    Collector collector;
    JsonProcessSession session(own_executable(), {L"--worker", L"tree"}, cwd, collector.callback());
    collector.wait_for("tree");
    { std::ofstream file(marker, std::ios::binary); file << collector.first("tree").at("pids").dump(); file.flush(); }
    std::_Exit(0);
}
void host_crash_cleanup(const fs::path& cwd) {
    const auto marker = cwd / L"crash-pids.json";
    auto host = spawn({L"--host-crash", cwd.wstring(), marker.wstring()}, false, cwd);
    const auto waited = WaitForSingleObject(host.hProcess, 10000);
    if (waited != WAIT_OBJECT_0) TerminateProcess(host.hProcess, 97);
    DWORD code = 0; GetExitCodeProcess(host.hProcess, &code);
    CloseHandle(host.hThread); CloseHandle(host.hProcess);
    check(waited == WAIT_OBJECT_0 && code == 0, "Abrupt host fixture did not finish");
    std::ifstream file(marker, std::ios::binary); const std::string bytes((std::istreambuf_iterator<char>(file)), {});
    stopped_tree(Json::parse(bytes));
}

void launch_errors_and_handles(const fs::path& executable, const fs::path& cwd) {
    const auto invalid = cwd / L"invalid-PRIVATE_SECRET.exe";
    { std::ofstream file(invalid, std::ios::binary); file << "invalid image"; }
    // Warm the independently known Windows invalid-image loader initialization,
    // with no session resources, before exact baseline handle comparisons.
    auto command = quote(invalid.wstring()); STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    const auto launched = CreateProcessW(invalid.c_str(), command.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, cwd.c_str(), &startup, &child);
    if (child.hProcess) { TerminateProcess(child.hProcess, 98); CloseHandle(child.hProcess); }
    if (child.hThread) CloseHandle(child.hThread);
    check(!launched, "Invalid image unexpectedly launched");
    Collector events;
    expect_launch_error([&] { JsonProcessSession session(L"relative.exe", {}, cwd, events.callback()); });
    expect_launch_error([&] { JsonProcessSession session(executable, {std::wstring(L"a\0b", 3)}, cwd, events.callback()); });
    expect_launch_error([&] { JsonProcessSession session(executable, {}, cwd, events.callback(), {{L"bad=name", L"PRIVATE_SECRET"}}); });
    expect_launch_error([&] { JsonProcessSession session(executable, {}, cwd, {}); });
    DWORD baseline = 0; check(GetProcessHandleCount(GetCurrentProcess(), &baseline), "Cannot count initial handles");
    for (int batch = 0; batch < 4; ++batch) {
        {
            Collector lines; JsonProcessSession session(executable, {L"--worker", L"echo"}, cwd, lines.callback());
            lines.wait_for("ready"); check(session.send(Json::Object{{"op", "quit"}}), "Handle fixture send failed");
            lines.verify_exit(); session.close();
            DWORD closed = 0; check(GetProcessHandleCount(GetCurrentProcess(), &closed), "Cannot count closed session handles");
            check(closed == baseline, "Explicit close retained handles until destruction");
        }
        {
            Collector lines; JsonProcessSession session(executable, {L"--worker", L"invalid"}, cwd, lines.callback());
            lines.verify_exit("invalid_json"); session.close();
        }
        {
            Collector lines; JsonProcessSession session(executable, {L"--worker", L"no-read"}, cwd, lines.callback());
            lines.wait_for("ready"); session.close(); lines.verify_exit("closed");
        }
        expect_launch_error([&] { JsonProcessSession session(invalid, {L"PRIVATE_ARGUMENT_SECRET"}, cwd, events.callback()); });
        DWORD after = 0; check(GetProcessHandleCount(GetCurrentProcess(), &after), "Cannot count final handles");
        check(after == baseline, "Session resources leaked Windows handles");
    }
    std::cout << "strict handle baseline=" << baseline << " (four mixed batches unchanged)\n";
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc >= 3 && std::wstring(argv[1]) == L"--worker") return worker(argc, argv);
        if (argc == 4 && std::wstring(argv[1]) == L"--host-crash") return crash_host(argv[2], argv[3]);
        if (argc != 2) throw std::runtime_error("Pass an isolated L-drive output directory");
        const auto root = fs::path(argv[1]) / (L"session-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
        const auto cwd = root / L"中文 会话目录"; fs::create_directories(cwd);
        const auto executable = root / L"JSON 会话 fixture.exe"; fs::copy_file(own_executable(), executable);
        basic(executable, cwd);
        long_paths(executable, root);
        concurrent_traffic(executable, cwd);
        eof_and_backpressure(executable, cwd);
        protocol_cases(executable, cwd);
        tree_cleanup(executable, cwd);
        host_crash_cleanup(cwd);
        launch_errors_and_handles(executable, cwd);
        std::cout << "process_session tests passed (" << checks.load() << " checks; real JSONL children, concurrency, EOF, trees and host crash)\n";
        return 0;
    } catch (const ProcessError& error) {
        std::cerr << "process_session test failed: " << error.what() << " (native=" << error.native_code() << ")\n"; return 1;
    } catch (const std::exception& error) {
        std::cerr << "process_session test failed: " << error.what() << '\n'; return 1;
    }
}
