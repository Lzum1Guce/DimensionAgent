#include "dimension/hybrid_workspace.hpp"
#include "dimension/atomic_file.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
using namespace dimension;
namespace fs = std::filesystem;

int checks = 0;
void check(bool cond, const char* msg) {
    if (!cond) throw std::runtime_error(msg);
    ++checks;
}

std::string read_bytes(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), {});
}

void write_raw(const fs::path& p, std::string_view s) {
    fs::create_directories(p.parent_path());
    std::ofstream out(p, std::ios::binary | std::ios::trunc);
    out.write(s.data(), static_cast<std::streamsize>(s.size()));
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        const fs::path root = argc > 1 ? fs::absolute(argv[1]) : fs::temp_directory_path() / L"dimension-hybrid-ws-test";
        std::error_code ec;
        fs::remove_all(root, ec);
        const fs::path host_proj = root / L"host-project";
        const fs::path win_proj  = root / L"win-sln-project";
        const fs::path state_dir = root / L"state";
        const fs::path slots_dir = root / L"slots";
        fs::create_directories(host_proj);
        fs::create_directories(win_proj);

        // 1. Project mode detection
        write_raw(win_proj / L"App.sln", "Microsoft Visual Studio Solution File\r\n");
        const auto m_win = HybridWorkspaceService::resolve_mode(win_proj, "auto");
        check(m_win.mode == "windows_native" && m_win.auto_detected, ".sln detected as windows_native");

        write_raw(host_proj / L"package.json", "{\r\n  \"name\": \"demo\"\r\n}\r\n");
        write_raw(host_proj / L"src" / L"index.js", "export const v = 1;\r\n");
        write_raw(host_proj / L"node_modules" / L"heavy" / L"lib.js", "SHOULD_NOT_COPY\r\n");
        const auto m_web = HybridWorkspaceService::resolve_mode(host_proj, "auto");
        check(m_web.mode == "sandbox_checkout" && m_web.auto_detected, "Web project defaults to sandbox_checkout");

        // 2. Fast filtered checkout
        HybridWorkspaceService svc({state_dir, {}, {}, slots_dir});
        const auto co = svc.checkout("run-hybrid-1", "bot-alpha", host_proj);
        check(co.at("copiedFiles").as_number() == 2, "Checkout copied 2 clean source files and skipped node_modules");
        const fs::path slot_path(co.at("slotWindowsPath").as_string());
        check(fs::exists(slot_path / L"src" / L"index.js") && !fs::exists(slot_path / L"node_modules"),
              "Slot contains clean source without node_modules");

        // 3. Simulate Linux tool editing with LF line endings + creating sandbox node_modules + adding file
        write_raw(slot_path / L"package.json", "{\n  \"name\": \"demo\"\n}\n"); // Pure CRLF->LF: should NOT count as modified!
        write_raw(slot_path / L"src" / L"index.js", "export const v = 2;\n");     // Real content modification (in LF)
        write_raw(slot_path / L"src" / L"helper.js", "export const h = true;\n"); // Added file
        write_raw(slot_path / L"node_modules" / L"tmp.js", "ignored\n");          // Sandbox build cache: ignored on diff/sync!

        const auto d1 = svc.diff("run-hybrid-1");
        check(d1.at("summary").at("modified").as_number() == 1 &&
              d1.at("summary").at("added").as_number() == 1 &&
              d1.at("summary").at("deleted").as_number() == 0 &&
              d1.at("summary").at("conflicts").as_number() == 0,
              "Diff ignores CRLF->LF noise and sandbox node_modules");

        // 4. Sync back restores original CRLF on modified file and cleans slot
        int backup_calls = 0;
        const auto sync_res = svc.sync_back("run-hybrid-1", {}, false, true,
            [&](const std::string&, const fs::path&, std::string_view) { ++backup_calls; });
        check(sync_res.at("ok").as_bool() && sync_res.at("syncedCount").as_number() == 2 && backup_calls == 2,
              "Sync back applied added + modified files and triggered host backup hook");
        check(read_bytes(host_proj / L"src" / L"index.js") == "export const v = 2;\r\n",
              "Original CRLF line endings restored on Windows host");
        check(fs::exists(host_proj / L"src" / L"helper.js") && !fs::exists(slot_path),
              "Added file written to host and sandbox slot reclaimed immediately");

        // 5. External modification conflict detection
        const auto co2 = svc.checkout("run-hybrid-2", "bot-beta", host_proj);
        const fs::path slot2(co2.at("slotWindowsPath").as_string());
        write_raw(slot2 / L"src" / L"index.js", "export const v = 3;\n");
        write_raw(host_proj / L"src" / L"index.js", "export const v = 999;\r\n"); // Concurrent external edit on host!
        bool blocked_conflict = false;
        try { (void)svc.sync_back("run-hybrid-2", {}, false, true); }
        catch (const std::exception&) { blocked_conflict = true; }
        check(blocked_conflict, "Sync back blocks when host file was modified externally unless force=true");
        const auto forced = svc.sync_back("run-hybrid-2", {}, true, true);
        check(forced.at("ok").as_bool(), "Force sync succeeds when explicitly confirmed");

        // 6. CLI profiles registry
        const auto profiles = svc.cli_profiles();
        check(profiles.at("profiles").as_array().size() >= 3, "Built-in CLI profiles (Claude Code, Codex, Blender) available");

        fs::remove_all(root, ec);
        std::cout << "hybrid_workspace: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "hybrid_workspace_test FAILED: " << e.what() << '\n';
        return 1;
    }
}
