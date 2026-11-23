#define NOMINMAX
#include <windows.h>
#include "dimension/app.hpp"
#include "dimension/json.hpp"
#include <atomic>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <fcntl.h>
#include <io.h>

namespace {
std::atomic_bool stopping{};
BOOL WINAPI signal_handler(DWORD) {
    stopping = true;
    return TRUE;
}
} // namespace
int wmain(int argc, wchar_t **argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    try {
        dimension::AppOptions options;
        unsigned port = 0;
        for (int i = 1; i < argc; ++i) {
            std::wstring arg = argv[i];
            if (i + 1 >= argc)
                throw std::runtime_error("Missing option value");
            if (arg == L"--data")
                options.data = argv[++i];
            else if (arg == L"--ui")
                options.ui = argv[++i];
            else if (arg == L"--provider-file")
                options.provider_file = argv[++i];
            else if (arg == L"--node")
                options.node = argv[++i];
            else if (arg == L"--plugin-host")
                options.plugin_host = argv[++i];
            else if (arg == L"--wsl")
                options.wsl = argv[++i];
            else if (arg == L"--desktop-helper")
                options.desktop_helper = argv[++i];
            else if (arg == L"--desktop-home-root") {
                auto value = std::filesystem::path(argv[++i]).u8string();
                options.desktop_home_root.assign(reinterpret_cast<const char *>(value.data()), value.size());
            } else if (arg == L"--sandbox-distro") {
                auto value = std::filesystem::path(argv[++i]).u8string();
                options.sandbox_distribution.assign(reinterpret_cast<const char *>(value.data()),
                                                    value.size());
            } else if (arg == L"--port") {
                auto s = std::wstring(argv[++i]);
                std::size_t used{};
                port = std::stoul(s, &used);
                if (used != s.size() || port > 65535)
                    throw std::runtime_error("Invalid port");
            } else
                throw std::runtime_error("Unknown option");
        }
        if (!options.data.is_absolute() || !options.ui.is_absolute())
            throw std::runtime_error("Use absolute --data and --ui paths");
        if (options.plugin_host.empty()) {
            wchar_t executable[32768]{};
            auto length = GetModuleFileNameW(nullptr, executable, 32768);
            if (length && length < 32768)
                options.plugin_host =
                    std::filesystem::path(executable).parent_path().parent_path().parent_path() / L"runtime" /
                    L"plugin-host.mjs";
        }
        if (options.desktop_helper.empty()) {
            wchar_t executable[32768]{};
            auto length = GetModuleFileNameW(nullptr, executable, 32768);
            if (length && length < 32768) {
                const auto candidate =
                    std::filesystem::path(executable).parent_path().parent_path() / L"linux" /
                    L"dimension-desktop-helper";
                std::error_code ec;
                if (std::filesystem::is_regular_file(candidate, ec))
                    options.desktop_helper = candidate;
            }
        }
        if (options.node.empty()) {
            wchar_t node[32768]{};
            auto length = SearchPathW(nullptr, L"node.exe", nullptr, 32768, node, nullptr);
            if (length && length < 32768)
                options.node = node;
        }
        if (options.wsl.empty()) {
            wchar_t system[32768]{};
            auto length = GetSystemDirectoryW(system, 32768);
            if (length && length < 32768)
                options.wsl = std::filesystem::path(system) / L"wsl.exe";
        }
        std::mutex output_mutex;
        options.notification = [&](const dimension::Json& notice) {
            std::lock_guard lock(output_mutex);
            const auto kind = notice.find("kind");
            const bool control = kind && kind->is_string() && kind->as_string() == "resolve-waiting";
            std::cout << dimension::Json(dimension::Json::Object{{control ? "notificationControl" : "notification", notice}}).dump() << std::endl;
        };
        std::atomic<dimension::HttpServer*> active_server{nullptr};
        options.http_stats = [&active_server]() {
            if (auto* srv = active_server.load(std::memory_order_acquire)) return srv->stats();
            return dimension::HttpServerStats{};
        };
        dimension::Application app(options);
        dimension::HttpServer server(static_cast<std::uint16_t>(port),
                                     [&](const auto &req) { return app.handle(req); });
        active_server.store(&server, std::memory_order_release);
        SetConsoleCtrlHandler(signal_handler, TRUE);
        server.start();
        std::cout << dimension::Json(dimension::Json::Object{{"ready", true},
                                                             {"port", int(server.port())},
                                                             {"phase", 3},
                                                             {"stageStatus", "native-ready"},
                                                             {"automaticDataMigration", false}})
                         .dump()
                  << std::endl;
        // Parent-owned stdin provides a clean stop path for the hidden test/preview process.
        std::jthread input([] {
            std::string line;
            while (std::getline(std::cin, line)) {
                if (line == "shutdown") {
                    stopping = true;
                    return;
                }
            }
            stopping = true;
        });
        while (!stopping)
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        active_server.store(nullptr, std::memory_order_release);
        app.shutdown();
        server.stop();
        if (input.joinable()) {
            CancelSynchronousIo(input.native_handle());
            input.join();
        }
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "Native server: " << e.what() << '\n';
        return 1;
    }
}
