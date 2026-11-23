#include "dimension/work_checkpoints.hpp"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>

namespace fs = std::filesystem;
using namespace dimension;

namespace {

int g_checks = 0;

void check(bool cond, const char* msg) {
    if (!cond) {
        std::cerr << "FAIL: " << msg << "\n";
        std::exit(1);
    }
    ++g_checks;
}

void write_str(const fs::path& p, const std::string& content) {
    fs::create_directories(p.parent_path());
    std::ofstream ofs(p, std::ios::binary | std::ios::trunc);
    ofs << content;
}

std::string read_str(const fs::path& p) {
    std::ifstream ifs(p, std::ios::binary);
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return oss.str();
}

} // namespace

int main(int argc, char** argv) {
    const fs::path root = argc > 1
        ? fs::path(argv[1])
        : (fs::temp_directory_path() / "dimension_work_checkpoints_test");
    std::error_code ec;
    fs::remove_all(root, ec);
    fs::create_directories(root, ec);

    const fs::path cp_store = root / "checkpoints";
    const fs::path ws = root / "workspace";
    WorkCheckpointService svc(cp_store);

    // Turn 1: Create initial v1 pelican animation
    write_str(ws / "deliverables" / "index.html", "<html><body>Pelican v1 - Retro Paper</body></html>");
    write_str(ws / "deliverables" / "style.css", "body { background: #f2eee0; }");
    write_str(ws / "scratch" / "draft.md", "temporary scratch note that should be skipped");
    write_str(ws / "incoming" / "ref.png", "PNG_BYTES_PRESERVED");

    const auto cp1 = svc.capture("run-demo-1", "第一版：博物学旧图鉴风鹈鹕骑车", ws);
    check(cp1.has_value(), "v1 checkpoint captured");
    check(cp1->version_number == 1, "version is v1");
    check(cp1->file_count == 2, "captured 2 deliverable files and skipped scratch/ & incoming/");
    check(cp1->primary_html_rel == "deliverables/index.html", "detected primary HTML deliverable");

    // Turn 2: Modify index.html and add extra broken script
    write_str(ws / "deliverables" / "index.html", "<html><body>Pelican v2 - Broken Neon</body></html>");
    write_str(ws / "deliverables" / "broken.js", "throw new Error('oops');");

    const auto cp2 = svc.capture("run-demo-1", "第二版：尝试加霓虹特效", ws);
    check(cp2.has_value() && cp2->version_number == 2, "v2 checkpoint captured");

    const auto listed = svc.list("run-demo-1");
    check(listed.size() == 2, "two user-visible checkpoints listed");

    // Read historical v1 HTML without touching live workspace (for Live Canvas v1/v2 preview)
    const auto v1_html = svc.read_checkpoint_file("run-demo-1", cp1->id, "deliverables/index.html");
    check(v1_html.has_value() && v1_html->find("Retro Paper") != std::string::npos,
          "historical v1 HTML readable for side-by-side preview");
    check(read_str(ws / "deliverables" / "index.html").find("Broken Neon") != std::string::npos,
          "live workspace still at v2 before restore");

    // Time-Machine Restore back to v1!
    const auto restored = svc.restore("run-demo-1", cp1->id, ws);
    check(restored.ok, "restore to v1 succeeded");
    check(restored.restored_files == 2, "2 files restored");
    check(restored.removed_extra_files == 1, "extra broken.js from v2 removed cleanly");
    check(!fs::exists(ws / "deliverables" / "broken.js"), "broken.js no longer exists on disk");
    check(read_str(ws / "deliverables" / "index.html") == "<html><body>Pelican v1 - Retro Paper</body></html>",
          "index.html rolled back byte-for-byte to v1");
    check(fs::exists(ws / "incoming" / "ref.png"), "incoming/ user attachments untouched during restore");
    check(!restored.backup_checkpoint_id.empty(), "automatic safety backup created prior to restore");

    fs::remove_all(root, ec);
    std::cout << "work_checkpoints: " << g_checks << " checks passed\n";
    return 0;
}
