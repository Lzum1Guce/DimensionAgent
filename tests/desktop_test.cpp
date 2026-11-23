#define NOMINMAX
#include <windows.h>
#include "dimension/desktop.hpp"
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;
unsigned checks = 0;
void check(bool value, const char *label) {
    ++checks;
    if (!value)
        throw std::runtime_error(label);
}
template <class F> std::string rejected(F action) {
    try {
        action();
    } catch (const std::exception &error) {
        return error.what();
    }
    throw std::runtime_error("Expected desktop action rejection");
}
template <class F> void until(F predicate) {
    const auto deadline = std::chrono::steady_clock::now() + 6s;
    while (!predicate()) {
        if (std::chrono::steady_clock::now() > deadline)
            throw std::runtime_error("Desktop fixture did not reach its synchronization point");
        std::this_thread::sleep_for(10ms);
    }
}
fs::path executable() {
    std::wstring path(32768, L'\0');
    auto count = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (!count || count >= path.size())
        throw std::runtime_error("Cannot locate desktop fixture");
    path.resize(count);
    return path;
}
fs::path path8(const std::string &text) {
    return fs::path(std::u8string_view(reinterpret_cast<const char8_t *>(text.data()), text.size()));
}
void send(const Json &value) { std::cout << value.dump() << std::endl; }

// A deliberately unresponsive JSON peer validates cancellation deterministically.
// Real X11, Chrome and frame rate are exercised by the separate Linux/UI suites.
int peer(const std::wstring &mode) {
    if (mode == L"slow-home") {
        std::string request;
        if (std::getline(std::cin, request)) {
            std::ofstream("home-starting.marker") << "waiting";
            while (std::getline(std::cin, request)) {
            }
        }
        return 0;
    }
    if (mode == L"slow-start")
        std::ofstream("starting.marker") << "started";
    else
        send(O{{"event", "ready"}, {"width", 1280}, {"height", 800}, {"previewFps", 30}});
    std::string line;
    unsigned launches = 0;
    while (std::getline(std::cin, line)) {
        if (mode == L"slow-start")
            continue;
        auto value = Json::parse(line);
        if (value.at("op").as_string() == "launch")
            std::ofstream("launch-count.marker") << ++launches;
        if (value.at("op").as_string() == "press" && value.at("key").as_string() == "F1") {
            std::ofstream("waiting.marker") << "waiting";
            continue;
        }
        if (value.at("op").as_string() == "press" && value.at("key").as_string() == "F3") {
            std::ofstream("short-action.marker") << "sent";
            std::this_thread::sleep_for(200ms);
        }
        send(O{{"id", value.at("id")}, {"ok", true}, {"result", O{}}});
    }
    return 0;
}
void lifecycle(const fs::path &root) {
    DesktopManager manager({root, executable(), executable(), "desktop-test"});
    const std::string bot = "cancel-fixture";
    manager.set_software(
        A{O{{"id", "fixture"}, {"name", "Synthetic peer"}, {"executable", "/usr/bin/true"}, {"args", A{}}}});
    const auto state = manager.status(bot);
    const auto folder = path8(state.at("workspace").as_string()).parent_path();
    check(!state.at("running").as_bool(), "Status must not start a desktop");
    auto launched = manager.action(bot, O{{"op", "launch"}, {"appId", "fixture"}});
    check(launched.at("running").as_bool(), "Peer desktop starts");
    bool protected_observation = false;
    try {
        manager.action(bot, O{{"op", "observe"}}, false, false);
    } catch (const DesktopError &error) {
        protected_observation =
            error.waiting_for_user && error.no_side_effects && error.code == "human_control";
    }
    check(protected_observation, "Automated screenshot cannot observe a user-controlled login or desktop");
    const auto old_id = launched.at("observationId").as_string();
    auto oversized = rejected([&] {
        manager.action(bot,
                       O{{"op", "type"}, {"text", std::string(300 * 1024, 'x')}, {"observationId", old_id}});
    });
    check(oversized.find("256 KiB") != std::string::npos, "Oversized helper request rejected immediately");
    check(manager.status(bot).at("running").as_bool(), "Rejected payload does not destroy the desktop");
    manager.control(bot, false);
    auto observed = manager.action(bot, O{{"op", "observe"}}, false, false);
    auto changed = manager.action(
        bot, O{{"op", "press"}, {"key", "F2"}, {"observationId", observed.at("observationId")}}, true, false);
    check(changed.at("observationId").as_string() != observed.at("observationId").as_string(),
          "Automated input advances its observation");
    check(!rejected([&] {
               manager.action(
                   bot, O{{"op", "press"}, {"key", "F2"}, {"observationId", observed.at("observationId")}},
                   true, false);
           }).empty(),
          "Automatic fast input cannot bypass observation freshness");
    std::stop_source supplement;
    observed = manager.action(bot, O{{"op", "observe"}}, false, false);
    auto settling = std::async(std::launch::async, [&] {
        return manager.action(
            bot, O{{"op", "press"}, {"key", "F3"}, {"observationId", observed.at("observationId")}}, false,
            false, supplement.get_token());
    });
    until([&] { return fs::exists(folder / "short-action.marker"); });
    supplement.request_stop();
    auto settled = settling.get();
    check(settled.at("actionCompleted").as_bool(),
          "A promptly completed interrupted action keeps its acknowledgement");
    check(settled.at("observationRequired").as_bool(),
          "A settled interruption requires fresh observation before more input");
    check(manager.status(bot).at("running").as_bool(),
          "Normal in-flight action cancellation preserves the application");
    manager.control(bot, true);
    observed = manager.action(bot, O{{"op", "observe"}});
    auto active = std::async(std::launch::async, [&] {
        return rejected([&] {
            manager.action(
                bot, O{{"op", "press"}, {"key", "F1"}, {"observationId", observed.at("observationId")}});
        });
    });
    until([&] { return fs::exists(folder / "waiting.marker"); });
    std::atomic_bool queued_started{};
    auto queued = std::async(std::launch::async, [&] {
        queued_started = true;
        return rejected([&] { manager.action(bot, O{{"op", "observe"}}); });
    });
    until([&] { return queued_started.load(); });
    std::this_thread::sleep_for(50ms);
    const auto began = std::chrono::steady_clock::now();
    check(!manager.stop(bot).at("running").as_bool(), "Explicit stop stops an unresponsive desktop");
    check(std::chrono::steady_clock::now() - began < 6s, "Stop interrupts the 20 second request wait");
    check(!active.get().empty(), "In-flight action is cancelled");
    check(!queued.get().empty(), "Previously queued action is cancelled");
    launched = manager.action(bot, O{{"op", "launch"}, {"appId", "fixture"}});
    check(launched.at("observationId").as_string() != old_id,
          "Explicit relaunch creates a new desktop session");
    check(!rejected([&] {
               manager.action(bot, O{{"op", "press"}, {"key", "F2"}, {"observationId", old_id}}, true);
           }).empty(),
          "Old session input remains invalid after relaunch");
    manager.shutdown();
    check(!rejected([&] { manager.action(bot, O{{"op", "launch"}, {"appId", "fixture"}}); }).empty(),
          "Shutdown prevents future launches");
}
void starting(const fs::path &root) {
    DesktopManager manager({root, executable(), executable(), "slow-start"});
    const auto state = manager.status("starting");
    const auto folder = path8(state.at("workspace").as_string()).parent_path();
    auto launch = std::async(std::launch::async, [&] {
        return rejected([&] { manager.action("starting", O{{"op", "launch"}}); });
    });
    until([&] { return fs::exists(folder / "starting.marker"); });
    const auto began = std::chrono::steady_clock::now();
    manager.stop("starting");
    check(std::chrono::steady_clock::now() - began < 6s, "Stop interrupts the 25 second startup wait");
    check(!launch.get().empty(), "Cancelled startup reports failure");
    check(!manager.status("starting").at("running").as_bool(), "Cancelled startup leaves no running desktop");
}
void launch_tokens(const fs::path &root) {
    const std::string bot = "launch-token-fixture";
    std::string previous_instance;
    {
        DesktopManager manager({root, executable(), executable(), "desktop-test"});
        manager.set_software(
            A{O{{"id", "fixture"}, {"name", "Counter"}, {"executable", "/usr/bin/true"}, {"args", A{}}}});
        auto state = manager.status(bot);
        const auto folder = path8(state.at("workspace").as_string()).parent_path();
        auto count = [&] {
            unsigned n = 0;
            std::ifstream(folder / "launch-count.marker") >> n;
            return n;
        };
        auto token = [](const Json &value) { return value.at("launchToken").as_string(); };
        auto launch = [&](const Json &value) {
            return manager.action(bot, O{{"op", "launch"}, {"appId", "fixture"}, {"launchToken", value}},
                                  false, false);
        };
        auto invalid = [&](const Json &value, const char *code) {
            try {
                launch(value);
            } catch (const DesktopError &error) {
                return error.code == code && error.no_side_effects;
            }
            return false;
        };
        const auto initial = token(state);
        check(!initial.empty() && token(manager.status(bot)) == initial,
              "Stopped desktop has a stable launch identity");
        check(invalid("", "invalid_arguments") && invalid(42, "invalid_arguments"),
              "Empty or non-string launch tokens are rejected before launch");
        check(!manager.status(bot).at("running").as_bool(), "Invalid launch tokens do not start a helper");
        state = launch(initial);
        check(count() == 1 && token(state) != initial, "A valid launch consumes the current state");
        const auto first = token(state);
        state = manager.action(bot, O{{"op", "observe"}}, false, false);
        check(token(state) == first && token(manager.status(bot)) == first,
              "Observation and status do not create new launch intentions");
        const auto other = token(manager.status("other-bot"));
        check(invalid(initial, "launch_state_stale") && invalid(other, "launch_state_stale") && count() == 1,
              "Stale and other-Bot tokens cannot dispatch a second launch");
        state = launch(first);
        check(count() == 2 && token(state) != first,
              "A subsequent explicit launch with current state reaches the helper");
        const auto before_control = token(state);
        state = manager.control(bot, true);
        check(token(state) != before_control, "Human takeover invalidates launch state");
        state = manager.control(bot, false);
        check(invalid(before_control, "launch_state_stale"), "Returning control does not revive old state");
        state = manager.action(bot, O{{"op", "observe"}}, false, false);
        const auto before_input = token(state);
        state = manager.action(
            bot, O{{"op", "press"}, {"key", "F2"}, {"observationId", state.at("observationId")}}, false,
            false);
        check(token(state) != before_input, "Keyboard input advances launch state");
        const auto before_stop = token(state);
        state = manager.stop(bot);
        check(token(state) != before_stop && invalid(before_stop, "launch_state_stale") &&
                  !manager.status(bot).at("running").as_bool(),
              "Stopped desktop rejects an old launch state without restarting");
        state = launch(token(state));
        check(state.at("running").as_bool() && count() == 1,
              "Current stopped-state token deliberately restarts the helper");
        previous_instance = token(state);
    }
    DesktopManager restored({root, executable(), executable(), "desktop-test"});
    check(restored.status(bot).at("launchToken").as_string() != previous_instance,
          "Manager restart creates a fresh launch identity");
    bool stale = false;
    try {
        restored.action(bot, O{{"op", "launch"}, {"appId", "fixture"}, {"launchToken", previous_instance}},
                        false, false);
    } catch (const DesktopError &error) {
        stale = error.code == "launch_state_stale" && error.no_side_effects;
    }
    check(stale && !restored.status(bot).at("running").as_bool(),
          "Previous process state cannot relaunch after restart");
}
void long_paths(fs::path root) {
    while (root.native().size() < 265)
        root /= L"long-desktop-state";
    {
        DesktopManager manager({root, executable(), executable(), "desktop-test"});
        manager.set_software(A{O{{"id", "long-path"},
                                 {"name", "Persistent long path"},
                                 {"executable", "/usr/bin/true"},
                                 {"args", A{}}}});
        const auto state = manager.status("long-path-bot");
        check(path8(state.at("workspace").as_string()).native().size() > 300,
              "Long desktop directory is created without MAX_PATH truncation");
        (void)manager.set_settings("long-path-bot", O{{"networkAccess", false}});
    }
    DesktopManager restored({root, executable(), executable(), "desktop-test"});
    check(restored.software().at("apps").as_array().front().at("id").as_string() == "long-path",
          "Software settings beyond MAX_PATH survive restart");
    check(!restored.status("long-path-bot").at("networkAccess").as_bool(),
          "Bot settings beyond MAX_PATH survive restart");
}
void preparing_home(const fs::path &root) {
    {
        DesktopManager legacy({root, executable(), executable(), "slow-home"});
        (void)legacy.status("already-ready");
    }
    DesktopManager manager({root, executable(), executable(), "slow-home", "/home/fixture"});
    (void)manager.status("already-ready");
    auto active =
        std::async(std::launch::async, [&] { return rejected([&] { (void)manager.status("preparing"); }); });
    until([&] { return fs::exists(root / "home-starting.marker"); });
    const auto began = std::chrono::steady_clock::now();
    check(!manager.status("already-ready").at("running").as_bool(),
          "A slow home preparation does not block a different ready Bot");
    check(std::chrono::steady_clock::now() - began < 1s,
          "Ready Bot status does not wait for the global preparation timeout");
    const auto stopped = std::chrono::steady_clock::now();
    check(!manager.stop("preparing").at("running").as_bool(),
          "Stop can reach a Bot while its home is still being prepared");
    check(!active.get().empty() && std::chrono::steady_clock::now() - stopped < 3s,
          "Stop cancels preparation without allowing a delayed desktop launch");
}
} // namespace
int wmain(int argc, wchar_t **argv) {
    try {
        if (argc > 2 && std::wstring(argv[1]) == L"-d")
            return peer(argv[2]);
        if (argc != 2)
            throw std::runtime_error("Expected isolated test data path");
        SetEnvironmentVariableW(L"DIMENSION_LEGACY_DEFAULT_WORKSPACE", L"1");
        auto root = fs::absolute(argv[1]) / (L"run-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
                                             std::to_wstring(GetTickCount64()));
        // The synthetic peer is the WSL/helper fixture. Production now also
        // requires the root supervisor beside it, so provide an isolated empty
        // regular file without weakening that availability check.
        const auto supervisor = executable().parent_path() / L"dimension-sandbox-root.sh";
        check(!fs::exists(supervisor), "Desktop fixture must not replace a real supervisor");
        std::ofstream(supervisor).put('\n');
        struct SupervisorCleanup {
            fs::path path;
            ~SupervisorCleanup() { std::error_code error; fs::remove(path, error); }
        } cleanup{supervisor};
        lifecycle(root / "lifecycle");
        starting(root / "starting");
        launch_tokens(root / "launch-tokens");
        long_paths(root / "long-paths");
        preparing_home(root / "preparing-home");
        std::cout << "desktop: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "desktop: " << error.what() << '\n';
        return 1;
    }
}
