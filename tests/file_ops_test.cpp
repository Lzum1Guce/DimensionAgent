#include "dimension/file_ops.hpp"
#include "dimension/host_exec.hpp"
#include "dimension/atomic_file.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

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
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        const fs::path root = argc > 1 ? fs::absolute(argv[1]) : fs::temp_directory_path() / L"dimension-file-ops-test";
        std::error_code ec;
        fs::remove_all(root, ec);
        fs::create_directories(root);

        // 1. CRLF preservation when LLM passes LF target & replacement
        const fs::path src = root / L"sample.cpp";
        atomic_write_file(src, "int alpha() {\r\n    return 1;\r\n}\r\n\r\nint beta() {\r\n    return 2;\r\n}\r\n");
        const auto res1 = edit_file_locked({root, src, "sample.cpp", "int alpha() {\n    return 1;\n}", "int alpha() {\n    return 42;\n}", false});
        check(res1.ok && res1.replacements == 1 && res1.line_ending == "CRLF", "CRLF file edited via LF target");
        const std::string after1 = read_bytes(src);
        check(after1.find("return 42;\r\n") != std::string::npos && after1.find("return 2;\r\n") != std::string::npos,
              "CRLF line endings preserved cleanly");

        // 2. Ambiguous target rejection unless replace_all = true
        atomic_write_file(root / L"dup.txt", "foo = 1\nbar = 2\nfoo = 1\n");
        const auto amb = edit_file_locked({root, root / L"dup.txt", "dup.txt", "foo = 1", "foo = 9", false});
        check(!amb.ok, "Ambiguous match rejected when replace_all is false");
        const auto all_ok = edit_file_locked({root, root / L"dup.txt", "dup.txt", "foo = 1", "foo = 9", true});
        check(all_ok.ok && all_ok.replacements == 2, "replace_all replaces all matches");

        // 3. Multi-Bot concurrent per-file lock safety on distinct regions of the same file
        const fs::path shared = root / L"concurrent.js";
        atomic_write_file(shared, "const A = 'initA';\nconst B = 'initB';\nconst C = 'initC';\nconst D = 'initD';\n");
        std::vector<std::thread> workers;
        bool t_ok[4]{};
        const char* targets[4] = {"const A = 'initA';", "const B = 'initB';", "const C = 'initC';", "const D = 'initD';"};
        const char* repls[4]   = {"const A = 'doneA';", "const B = 'doneB';", "const C = 'doneC';", "const D = 'doneD';"};
        for (int i = 0; i < 4; ++i) {
            workers.emplace_back([&, i] {
                const auto r = edit_file_locked({root, shared, "concurrent.js", targets[i], repls[i], false});
                t_ok[i] = r.ok;
            });
        }
        for (auto& th : workers) th.join();
        const std::string merged = read_bytes(shared);
        check(t_ok[0] && t_ok[1] && t_ok[2] && t_ok[3], "All 4 concurrent Bot edits succeeded");
        check(merged.find("doneA") != std::string::npos && merged.find("doneB") != std::string::npos &&
              merged.find("doneC") != std::string::npos && merged.find("doneD") != std::string::npos,
              "No concurrent edit was lost under per-file lock");

        // 4. grep_files skips node_modules and finds source matches
        fs::create_directories(root / L"node_modules" / L"pkg");
        atomic_write_file(root / L"node_modules" / L"pkg" / L"ignored.js", "MAGIC_NEEDLE_XYZ\n");
        atomic_write_file(root / L"real_code.js", "// header\nfunction MAGIC_NEEDLE_XYZ() {}\n");
        const auto grep_res = grep_files(root, {"MAGIC_NEEDLE_XYZ"});
        check(grep_res.at("count").as_number() == 1 &&
              grep_res.at("matches").as_array().front().at("path").as_string() == "real_code.js",
              "grep_files skips node_modules and returns exact match");

        // 5. Host command classifier & JobObject execution
        const auto safe_risk = classify_host_command("cmake --version", root, true);
        check(!safe_risk.requires_approval && safe_risk.risk_level == "safe_in_project",
              "In-project build command auto-approved");
        const auto danger_del = classify_host_command("Remove-Item -Recurse -Force foo", root, true);
        check(danger_del.requires_approval, "Destructive Remove-Item requires approval");
        const auto danger_sys = classify_host_command("reg add HKCU\\Software\\Test", root, true);
        check(danger_sys.requires_approval, "Registry modification requires approval");
        const auto danger_unconfined = classify_host_command("git status", root, false);
        check(danger_unconfined.requires_approval, "Unconfined cwd requires approval");

        const auto exec_res = execute_host_command({root, "Write-Output 'HELLO_HOST_044'", "powershell", 15});
        check(exec_res.at("ok").as_bool() && exec_res.at("stdout").as_string().find("HELLO_HOST_044") != std::string::npos,
              "execute_host_command runs hidden PowerShell and captures UTF-8 stdout");

        fs::remove_all(root, ec);
        std::cout << "file_ops: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "file_ops_test FAILED: " << e.what() << '\n';
        return 1;
    }
}
