#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include "dimension/process.hpp"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stop_token>
#include <string>
#include <thread>
#include <vector>
#include <fcntl.h>
#include <io.h>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
std::size_t checks = 0;

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

std::wstring env(const wchar_t* name) {
    const auto size = GetEnvironmentVariableW(name, nullptr, 0);
    if (!size) return {};
    std::wstring value(size, L'\0');
    value.resize(GetEnvironmentVariableW(name, value.data(), size));
    return value;
}

fs::path executable_path() {
    std::wstring value(32768, L'\0');
    const auto size = GetModuleFileNameW(nullptr, value.data(), static_cast<DWORD>(value.size()));
    if (!size || size >= value.size()) throw std::runtime_error("Cannot locate fixture executable");
    value.resize(size); return value;
}

void send(Json value) { std::cout << value.dump() << '\n'; std::cout.flush(); }

void write_raw(HANDLE pipe, std::string_view bytes) {
    while (!bytes.empty()) {
        DWORD written = 0;
        const auto size = static_cast<DWORD>(std::min<std::size_t>(bytes.size(), 65536));
        if (!WriteFile(pipe, bytes.data(), size, &written, nullptr) || !written) return;
        bytes.remove_prefix(written);
    }
}

PROCESS_INFORMATION spawn_fixture(const std::wstring& suffix) {
    const auto executable = executable_path();
    std::wstring command = L"\"" + executable.wstring() + L"\" --worker " + suffix;
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                         CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
        throw std::runtime_error("Cannot launch process-tree fixture");
    }
    return process;
}

int worker(int argc, wchar_t** argv) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);
    const std::wstring mode = argv[2];
    if (mode == L"no-read" || mode == L"sleep") { Sleep(60000); return 0; }
    if (mode == L"descendant") {
        if (argc != 5) return 91;
        auto grandchild = spawn_fixture(L"sleep");
        Json::Array pids{static_cast<double>(std::stoul(argv[4])), static_cast<double>(GetCurrentProcessId()), static_cast<double>(grandchild.dwProcessId)};
        { std::ofstream file(fs::path(argv[3]), std::ios::binary); file << Json(pids).dump(); file.flush(); }
        CloseHandle(grandchild.hThread); CloseHandle(grandchild.hProcess);
        Sleep(60000); return 0;
    }
    if (mode == L"tree-timeout" || mode == L"tree-normal") {
        if (argc != 4) return 92;
        const auto marker = fs::path(argv[3]);
        auto descendant = spawn_fixture(L"descendant \"" + marker.wstring() + L"\" " + std::to_wstring(GetCurrentProcessId()));
        CloseHandle(descendant.hThread); CloseHandle(descendant.hProcess);
        if (mode == L"tree-timeout") { Sleep(60000); return 0; }
        for (int i = 0; i < 200; ++i) {
            std::error_code error;
            if (fs::exists(marker, error) && fs::file_size(marker, error) > 0 && !error) {
                send(Json::Object{{"treeStarted", true}}); return 0;
            }
            Sleep(10);
        }
        return 93;
    }
    std::string line;
    std::getline(std::cin, line);
    const auto request = Json::parse(line);
    if (mode == L"echo") {
        Json::Array args;
        for (int i = 3; i < argc; ++i) args.emplace_back(utf8(argv[i]));
        send(Json::Object{{"input", request}, {"args", args}, {"cwd", utf8(fs::current_path().wstring())},
            {"temp", utf8(env(L"TEMP"))}, {"tmp", utf8(env(L"TMP"))},
            {"apiVisible", !env(L"OPENAI_API_KEY").empty() || !env(L"DEEPSEEK_API_KEY").empty() || !env(L"AWS_SECRET_ACCESS_KEY").empty()},
            {"custom", utf8(env(L"DIMENSION_TEST_VALUE"))},
            {"pathSet", !env(L"PATH").empty()}, {"systemRootSet", !env(L"SYSTEMROOT").empty()},
            {"console", GetConsoleWindow() != nullptr}});
    } else if (mode == L"stderr-flood") {
        const std::string noise(8192, 'e');
        for (int i = 0; i < 1024; ++i) write_raw(GetStdHandle(STD_ERROR_HANDLE), noise);
        send(Json::Object{{"ok", true}, {"inputBytes", static_cast<double>(line.size())}});
    } else if (mode == L"oversize") {
        write_raw(GetStdHandle(STD_OUTPUT_HANDLE), std::string(4 * 1024 * 1024 + 100, 'x'));
    } else if (mode == L"exit-error") {
        write_raw(GetStdHandle(STD_ERROR_HANDLE), "STDERR_SECRET_42 " + line);
        send(Json::Object{{"untrusted", "STDOUT_SECRET_42"}}); return 17;
    } else if (mode == L"malformed") {
        write_raw(GetStdHandle(STD_OUTPUT_HANDLE), "STDOUT_SECRET_42 not JSON\n");
    } else if (mode == L"two-lines") {
        write_raw(GetStdHandle(STD_OUTPUT_HANDLE), "{}\n{}\n");
    } else if (mode == L"no-newline") {
        write_raw(GetStdHandle(STD_OUTPUT_HANDLE), "{}");
    } else if (mode == L"crlf") {
        write_raw(GetStdHandle(STD_OUTPUT_HANDLE), "{\"ok\":true}\r\n");
    } else if (mode == L"touch-handle") {
        if (argc != 4) return 94;
        auto inherited = reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(std::stoull(argv[3])));
        SetEvent(inherited); send(Json::Object{{"attempted", true}});
    } else return 95;
    return 0;
}

template<class Function>
ProcessError expect_error(ProcessErrorCode code, Function function) {
    try { function(); }
    catch (const ProcessError& error) {
        check(error.code() == code, "Wrong JSON worker error category");
        const std::string message = error.what();
        check(message.find("SECRET") == std::string::npos && message.find("private-input") == std::string::npos,
              "Worker exception exposed payload or stderr contents");
        return error;
    }
    throw std::runtime_error("Expected JSON worker error");
}

void tree_is_stopped(const fs::path& marker) {
    std::ifstream input(marker, std::ios::binary);
    check(static_cast<bool>(input), "Descendant fixture did not produce its PID marker");
    std::string bytes((std::istreambuf_iterator<char>(input)), {});
    const auto ids = Json::parse(bytes);
    check(ids.as_array().size() == 3, "Expected worker, child and grandchild PID evidence");
    for (const auto& id : ids.as_array()) {
        HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(id.as_number()));
        if (!process) { check(GetLastError() == ERROR_INVALID_PARAMETER, "Cannot inspect terminated fixture process"); continue; }
        const auto state = WaitForSingleObject(process, 1000);
        CloseHandle(process);
        check(state == WAIT_OBJECT_0, "A worker descendant escaped process-tree cleanup");
    }
}

bool marker_ready(const fs::path& marker) {
    std::error_code error;
    return fs::exists(marker, error) && fs::file_size(marker, error) > 0 && !error;
}

int crash_bridge(const fs::path& executable, const fs::path& cwd, const fs::path& marker) {
    std::thread running([&] {
        try { run_json_worker(executable, {L"--worker", L"tree-timeout", marker.wstring()}, cwd, Json{}, {}, 15s); }
        catch (...) {}
    });
    for (int i = 0; i < 300; ++i) {
        if (marker_ready(marker)) std::_Exit(0); // Deliberately bypasses Session's destructor.
        Sleep(10);
    }
    std::_Exit(96);
}

void initialize_invalid_image_path(const fs::path& invalid_executable, const fs::path& cwd) {
    // Windows initializes process-loader compatibility resources lazily on its
    // first invalid-image launch. This direct OS call creates no Session, pipes,
    // Job Object or helper threads, so its one-time handle delta is independently
    // attributable to the OS path. Warm it before strict bridge leak checks.
    DWORD before = 0, after = 0;
    check(GetProcessHandleCount(GetCurrentProcess(), &before), "Cannot count pre-initialization handles");
    std::wstring command = L"\"" + invalid_executable.wstring() + L"\"";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION process{};
    const BOOL launched = CreateProcessW(invalid_executable.c_str(), command.data(), nullptr, nullptr, FALSE,
                                         CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, cwd.c_str(), &startup, &process);
    const auto native_error = GetLastError();
    const bool returned_handles = process.hProcess || process.hThread;
    if (process.hProcess) { TerminateProcess(process.hProcess, 98); CloseHandle(process.hProcess); }
    if (process.hThread) CloseHandle(process.hThread);
    check(!launched && (native_error == ERROR_BAD_EXE_FORMAT || native_error == ERROR_EXE_MACHINE_TYPE_MISMATCH) && !returned_handles,
          "Expected the raw Windows invalid-image path to return no owned handles");
    check(GetProcessHandleCount(GetCurrentProcess(), &after), "Cannot count initialized loader handles");
    std::cout << "invalid-image OS initialization handles=" << before << "->" << after << '\n';
}

void run_checks(const fs::path& root) {
    fs::create_directories(root / L"可执行 程序");
    const auto executable = root / L"可执行 程序" / L"JSON worker 空格.exe";
    fs::copy_file(executable_path(), executable);
    const auto cwd = root / L"中文 工作目录";
    fs::create_directories(cwd);
    const auto original_openai = env(L"OPENAI_API_KEY"), original_deepseek = env(L"DEEPSEEK_API_KEY"), original_aws = env(L"AWS_SECRET_ACCESS_KEY");
    SetEnvironmentVariableW(L"OPENAI_API_KEY", L"INHERITED_SECRET_42");
    SetEnvironmentVariableW(L"DEEPSEEK_API_KEY", L"INHERITED_SECRET_42");
    SetEnvironmentVariableW(L"AWS_SECRET_ACCESS_KEY", L"INHERITED_SECRET_42");
    const std::vector<std::wstring> special{L"", L"普通中文", L"a b", L"literal\"quote", L"back\\slash", L"trailing\\", L"two\\\\\"quotes", L"& | < > ^ %COMSPEC% $(private-input)"};
    std::vector<std::wstring> args{L"--worker", L"echo"}; args.insert(args.end(), special.begin(), special.end());
    const Json request = Json::Object{{"message", "private-input 中文 \\ \"\n"}, {"count", 3}};
    auto result = run_json_worker(executable, args, cwd, request, {}, 5s,
        {{L"DIMENSION_TEST_VALUE", L"显式配置"}, {L"TEMP", L"C:\\must-not-use"}});
    SetEnvironmentVariableW(L"OPENAI_API_KEY", original_openai.empty() ? nullptr : original_openai.c_str());
    SetEnvironmentVariableW(L"DEEPSEEK_API_KEY", original_deepseek.empty() ? nullptr : original_deepseek.c_str());
    SetEnvironmentVariableW(L"AWS_SECRET_ACCESS_KEY", original_aws.empty() ? nullptr : original_aws.c_str());
    check(result.at("input").dump() == request.dump(), "JSON request was not preserved exactly");
    check(result.at("args").as_array().size() == special.size(), "Windows argv count changed");
    for (std::size_t i = 0; i < special.size(); ++i) check(result.at("args").as_array()[i].as_string() == utf8(special[i]), "Windows argument quoting changed content");
    check(result.at("cwd").as_string() == utf8(cwd.wstring()), "Worker cwd differs from the explicit directory");
    check(!result.at("apiVisible").as_bool(), "Sensitive environment variables leaked by inheritance");
    check(result.at("custom").as_string() == "显式配置", "Explicit worker environment was not passed");
    check(result.at("pathSet").as_bool() && result.at("systemRootSet").as_bool(), "Required Windows environment was missing");
    check(!result.at("console").as_bool(), "Worker acquired a visible console");
    check(result.at("temp").as_string().starts_with(utf8((cwd / L".dimension-worker-cache").wstring())) &&
          result.at("temp").as_string() == result.at("tmp").as_string(), "Worker temporary files escaped the explicit cwd");
    check(run_json_worker(executable, {L"--worker", L"crlf"}, cwd, Json{}, {}, 5s).at("ok").as_bool(), "CRLF JSON reply was rejected");
    const auto invalid_executable = cwd / L"not-an-executable.exe";
    { std::ofstream output(invalid_executable); output << "private-input invalid executable"; }
    initialize_invalid_image_path(invalid_executable, cwd);
    DWORD baseline_handles = 0;
    check(GetProcessHandleCount(GetCurrentProcess(), &baseline_handles), "Cannot count fixture handles");

    const auto flood = run_json_worker(executable, {L"--worker", L"stderr-flood"}, cwd,
        Json::Object{{"large", std::string(2 * 1024 * 1024, 'a')}}, {}, 5s);
    check(flood.at("ok").as_bool() && flood.at("inputBytes").as_number() > 2 * 1024 * 1024,
          "Concurrent stdin/stderr pipe draining deadlocked or lost input");

    expect_error(ProcessErrorCode::OutputLimit, [&] { run_json_worker(executable, {L"--worker", L"oversize"}, cwd, request, {}, 5s); });
    for (auto mode : {L"malformed", L"two-lines", L"no-newline"}) {
        expect_error(ProcessErrorCode::Protocol, [&] { run_json_worker(executable, {L"--worker", mode}, cwd, request, {}, 5s); });
    }
    const auto failed = expect_error(ProcessErrorCode::Exit, [&] { run_json_worker(executable, {L"--worker", L"exit-error"}, cwd, request, {}, 5s); });
    check(failed.native_code() == 17, "Worker exit status was not preserved");
    const auto begin = std::chrono::steady_clock::now();
    expect_error(ProcessErrorCode::Timeout, [&] {
        run_json_worker(executable, {L"--worker", L"no-read"}, cwd,
                        Json::Object{{"large", std::string(2 * 1024 * 1024, 'a')}}, {}, 200ms);
    });
    check(std::chrono::steady_clock::now() - begin < 3s, "Timeout failed to unblock a full stdin pipe promptly");
    std::stop_source cancellation;
    std::jthread cancel([&] { std::this_thread::sleep_for(150ms); cancellation.request_stop(); });
    expect_error(ProcessErrorCode::Cancelled, [&] { run_json_worker(executable, {L"--worker", L"sleep"}, cwd, request, cancellation.get_token(), 5s); });
    cancel.join();
    expect_error(ProcessErrorCode::Cancelled, [&] { run_json_worker(executable, {L"--worker", L"echo"}, cwd, request, cancellation.get_token(), 5s); });

    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE unrelated = CreateEventW(&attributes, TRUE, FALSE, nullptr);
    check(unrelated != nullptr, "Cannot create inheritance fixture event");
    run_json_worker(executable, {L"--worker", L"touch-handle", std::to_wstring(reinterpret_cast<std::uintptr_t>(unrelated))}, cwd, Json{}, {}, 5s);
    const auto inherited = WaitForSingleObject(unrelated, 0); CloseHandle(unrelated);
    check(inherited == WAIT_TIMEOUT, "An unrelated inheritable parent handle reached the worker");

    const auto timeout_marker = cwd / L"超时子孙 PID.json";
    expect_error(ProcessErrorCode::Timeout, [&] { run_json_worker(executable, {L"--worker", L"tree-timeout", timeout_marker.wstring()}, cwd, Json{}, {}, 800ms); });
    tree_is_stopped(timeout_marker);
    const auto cancellation_marker = cwd / L"取消子孙 PID.json";
    std::stop_source tree_cancel;
    std::jthread cancel_tree([&] {
        for (int i = 0; i < 300; ++i) {
            if (marker_ready(cancellation_marker)) { tree_cancel.request_stop(); return; }
            std::this_thread::sleep_for(10ms);
        }
        tree_cancel.request_stop();
    });
    expect_error(ProcessErrorCode::Cancelled, [&] { run_json_worker(executable, {L"--worker", L"tree-timeout", cancellation_marker.wstring()}, cwd, Json{}, tree_cancel.get_token(), 5s); });
    cancel_tree.join(); tree_is_stopped(cancellation_marker);
    const auto normal_marker = cwd / L"正常退出子孙 PID.json";
    check(run_json_worker(executable, {L"--worker", L"tree-normal", normal_marker.wstring()}, cwd, Json{}, {}, 5s).at("treeStarted").as_bool(), "Normal process-tree fixture failed");
    tree_is_stopped(normal_marker);

    const auto crash_marker = cwd / L"桥接宿主崩溃子孙 PID.json";
    std::wstring crash_command = L"\"" + executable.wstring() + L"\" --bridge-crash \"" + executable.wstring() +
        L"\" \"" + cwd.wstring() + L"\" \"" + crash_marker.wstring() + L"\"";
    STARTUPINFOW crash_startup{}; crash_startup.cb = sizeof(crash_startup);
    PROCESS_INFORMATION bridge{};
    check(CreateProcessW(executable.c_str(), crash_command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                         nullptr, cwd.c_str(), &crash_startup, &bridge), "Cannot start abrupt bridge-exit fixture");
    const auto crash_waited = WaitForSingleObject(bridge.hProcess, 5000);
    if (crash_waited != WAIT_OBJECT_0) TerminateProcess(bridge.hProcess, 97);
    DWORD bridge_exit = 0; GetExitCodeProcess(bridge.hProcess, &bridge_exit);
    CloseHandle(bridge.hThread); CloseHandle(bridge.hProcess);
    check(crash_waited == WAIT_OBJECT_0 && bridge_exit == 0, "Abrupt bridge-exit fixture failed");
    tree_is_stopped(crash_marker);

    std::atomic<int> parallel_errors = 0;
    std::vector<std::jthread> parallel;
    for (int i = 0; i < 4; ++i) {
        parallel.emplace_back([&, i] {
            try {
                const auto response = run_json_worker(executable, {L"--worker", L"echo"}, cwd,
                                                       Json::Object{{"parallel", i}}, {}, 5s);
                if (response.at("input").at("parallel").as_number() != i) ++parallel_errors;
            } catch (...) { ++parallel_errors; }
        });
    }
    parallel.clear();
    check(parallel_errors == 0, "Concurrent workers cross-wired pipes or lifecycle resources");

    expect_error(ProcessErrorCode::InvalidArgument, [&] { run_json_worker(L"relative.exe", {}, cwd, Json{}); });
    expect_error(ProcessErrorCode::InvalidArgument, [&] { run_json_worker(executable, {}, cwd, Json(std::string(4 * 1024 * 1024, 'a'))); });
    expect_error(ProcessErrorCode::InvalidArgument, [&] { run_json_worker(executable, {std::wstring(L"embedded\0NUL", 12)}, cwd, Json{}); });
    expect_error(ProcessErrorCode::InvalidArgument, [&] { run_json_worker(executable, {}, cwd, Json{}, {}, 0ms); });
    expect_error(ProcessErrorCode::InvalidArgument, [&] { run_json_worker(executable, {}, cwd, Json{}, {}, 5s, {{L"BAD=NAME", L"x"}}); });
    expect_error(ProcessErrorCode::Launch, [&] { run_json_worker(invalid_executable, {}, cwd, Json{}, {}, 5s); });
    for (int repeat = 0; repeat < 4; ++repeat) {
        run_json_worker(executable, {L"--worker", L"echo"}, cwd, Json{}, {}, 5s);
        expect_error(ProcessErrorCode::Protocol, [&] { run_json_worker(executable, {L"--worker", L"malformed"}, cwd, request, {}, 5s); });
        expect_error(ProcessErrorCode::Launch, [&] { run_json_worker(invalid_executable, {}, cwd, Json{}, {}, 5s); });
        expect_error(ProcessErrorCode::Timeout, [&] { run_json_worker(executable, {L"--worker", L"no-read"}, cwd, Json{}, {}, 100ms); });
        DWORD after_batch = 0;
        check(GetProcessHandleCount(GetCurrentProcess(), &after_batch), "Cannot count mixed-batch fixture handles");
        check(after_batch == baseline_handles, "A mixed success/error/timeout worker batch leaked handles");
    }
    DWORD final_handles = 0;
    check(GetProcessHandleCount(GetCurrentProcess(), &final_handles), "Cannot count final fixture handles");
    check(final_handles == baseline_handles, "JSON worker calls leaked Windows handles");
    std::cout << "strict mixed-batch handle checks=" << baseline_handles << "->" << final_handles << '\n';
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc >= 3 && std::wstring_view(argv[1]) == L"--worker") return worker(argc, argv);
        if (argc == 5 && std::wstring_view(argv[1]) == L"--bridge-crash") return crash_bridge(argv[2], argv[3], argv[4]);
        if (argc != 2) throw std::runtime_error("Pass an isolated process-test output root");
        const auto root = fs::absolute(argv[1]) /
            (L"process-" + std::to_wstring(std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        run_checks(root);
        std::cout << "process_test PASS checks=" << checks << "\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "process_test FAIL after " << checks << " checks: " << error.what() << '\n'; return 1;
    }
}
