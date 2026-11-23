#include "dimension/task_handoff.hpp"
#include "dimension/message_context.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winioctl.h>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;
std::size_t checks{};
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
template<class F> void rejects(F action, int status, const char* code = nullptr) {
    try { action(); } catch (const TaskHandoffError& error) {
        CHECK(error.status == status);
        if (code) CHECK(std::string(error.what()) == code);
        CHECK(std::string(error.what()).find(":") == std::string::npos);
        return;
    }
    throw std::runtime_error("Expected rejected handoff request");
}
std::wstring native(fs::path p) { p.make_preferred(); return L"\\\\?\\" + p.wstring(); }
std::string utf8(const fs::path& p) { const auto v = p.u8string(); return {v.begin(), v.end()}; }
void directory(const fs::path& p) { fs::create_directories(native(p)); }
void write(const fs::path& p, const std::string& bytes) {
    std::ofstream file(native(p), std::ios::binary); CHECK(file.good());
    file.write(bytes.data(), static_cast<std::streamsize>(bytes.size())); file.close(); CHECK(file.good());
}
std::string read(const fs::path& p) {
    std::ifstream file(native(p), std::ios::binary); CHECK(file.good());
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
bool symlink(const fs::path& link, const fs::path& target) {
    if (CreateSymbolicLinkW(native(link).c_str(), native(target).c_str(), SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)) return true;
    CHECK(GetLastError() == ERROR_PRIVILEGE_NOT_HELD);
    return false;
}
void junction(const fs::path& link, const fs::path& target) {
    directory(link);
    struct Reparse { DWORD tag; WORD length, reserved, sub_offset, sub_length, print_offset, print_length; WCHAR path[2048]; } data{};
    const auto destination = L"\\??\\" + target.wstring();
    CHECK(destination.size() + 2 < 2048);
    data.tag = IO_REPARSE_TAG_MOUNT_POINT; data.sub_length = static_cast<WORD>(destination.size() * sizeof(WCHAR));
    data.print_offset = data.sub_length + sizeof(WCHAR); data.length = static_cast<WORD>(8 + data.print_offset + sizeof(WCHAR));
    std::copy(destination.begin(), destination.end(), data.path);
    const auto handle = CreateFileW(native(link).c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    CHECK(handle != INVALID_HANDLE_VALUE); DWORD bytes{};
    const auto ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &data, data.length + 8, nullptr, 0, &bytes, nullptr);
    CloseHandle(handle); CHECK(ok);
}
TaskHandoffSource source() {
    TaskHandoffSource value;
    MessageContext context{"quote", {}};
    MessageSource quoted;
    quoted.source_namespace = "fixture"; quoted.message_id = 17; quoted.bot_id = "alpha";
    quoted.mode = Mode::Work; quoted.actor = "user"; quoted.text = "quoted reference";
    quoted.total_codepoints = quoted.text.size(); context.sources.push_back(quoted);
    value.run_snapshot = O{{"id", "run-fixture"}, {"botId", "alpha"}, {"groupId", "group-fixture"},
        {"status", "completed"}, {"attempt", 2}, {"sequence", 8}, {"createdAt", "2026-11-15T00:00:00Z"},
        {"updatedAt", "2026-11-15T00:01:00Z"}, {"executing", false}, {"terminal", true},
        {"inputs", A{O{{"text", "Original request 猫"}, {"time", "first"}, {"context", message_context_json(context)}},
            O{{"text", "Supplement exact tail"}, {"time", "second"}}}},
        {"answer", "Verified result"}, {"error", ""},
        {"messages", A{"MODEL_TRANSCRIPT_CANARY"}}, {"tools", A{"TOOL_ARGUMENT_CANARY"}},
        {"requests", O{{"id", "REQUEST_CANARY"}}}, {"receipt", "RECEIPT_CANARY"},
        {"provider", "PROVIDER_CANARY"}, {"browserAccount", "ACCOUNT_CANARY"}};
    value.children = A{
        O{{"key", "first:a"}, {"runId", "child-a"}, {"botId", "beta"}, {"job", "first job"}, {"status", "completed"},
            {"answer", "child result"}, {"dependsOn", A{}}},
        O{{"key", "first:b"}, {"runId", "child-b"}, {"job", "dependent job"}, {"status", "waiting"}, {"dependsOn", A{"first:a"}}},
        O{{"key", "legacy"}, {"runId", "child-legacy"}, {"job", "legacy job"}, {"status", "unknown"}}};
    return value;
}
void set(TaskHandoffSource& value, const char* key, Json next) {
    auto run = value.run_snapshot.as_object(); run[key] = std::move(next); value.run_snapshot = std::move(run);
}
void checksum(const TaskHandoffPackage& package) {
    CHECK(Json::parse(package.bytes, 24U * 1024U * 1024U).dump() == package.document.dump());
    auto body = package.document.as_object();
    const auto expected = body.at("contentSha256").as_string(); body.erase("contentSha256");
    CHECK(expected == source_data_digest(Json(body).dump()));
}
}

int wmain(int argc, wchar_t** argv) {
 try {
    if (argc != 2) throw std::runtime_error("isolated absolute output directory required");
    const fs::path supplied(argv[1]);
    if (!supplied.is_absolute() || supplied == supplied.root_path())
        throw std::runtime_error("handoff tests require a non-root isolated output directory");
    const auto root = supplied / (std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
    const auto project = root / L"project", outside = root / L"outside";
    directory(project / L"sub"); directory(outside);
    const auto sentinel = outside / L"sentinel.txt"; write(sentinel, "external sentinel");
    auto value = source(); const auto before = value.run_snapshot.dump();
    auto package = make_task_handoff(value); checksum(package);
    const auto& task = package.document.at("task");
    CHECK(task.at("requirements").as_array().size() == 2);
    CHECK(task.at("requirements").as_array()[0].at("kind").as_string() == "original");
    CHECK(task.at("requirements").as_array()[0].at("text").as_string() == "Original request 猫");
    CHECK(task.at("requirements").as_array()[1].at("kind").as_string() == "supplement");
    CHECK(task.at("requirements").as_array()[1].at("text").as_string() == "Supplement exact tail");
    CHECK(task.at("requirements").as_array()[0].at("references").as_array()[0].at("text").as_string() == "quoted reference");
    CHECK(task.at("status").as_string() == "completed" && task.at("result").as_string() == "Verified result");
    CHECK(task.at("latestDecision").at("kind").as_string() == "supplement");
    CHECK(task.at("latestDecision").at("text").as_string() == "Supplement exact tail");
    CHECK(task.at("artifactIds").as_array().empty());
    CHECK(task.at("unresolvedItems").as_array().size() == 2); // Waiting and unknown child runs remain factual open items.
    const auto& children = package.document.at("children").as_array();
    CHECK(children[0].at("dependenciesKnown").as_bool() && children[0].at("dependsOn").as_array().empty());
    CHECK(children[1].at("dependsOn").as_array()[0].as_string() == "first:a");
    CHECK(!children[2].at("dependenciesKnown").as_bool());
    CHECK(package.document.at("purpose").as_string() == "task-reference-material");
    CHECK(!package.document.at("automaticResume").as_bool() && !package.document.at("executable").as_bool());
    CHECK(package.document.at("requiresNewUserTask").as_bool() && !package.document.at("containsToolReceipts").as_bool());
    CHECK(package.document.at("readmeMarkdown").as_string().find("quoted reference") != std::string::npos);
    CHECK(package.filename == "dimension-task-" + source_data_digest("run-fixture").substr(0, 16) + ".json");
    for (const auto* secret : {"MODEL_TRANSCRIPT_CANARY", "TOOL_ARGUMENT_CANARY", "REQUEST_CANARY", "RECEIPT_CANARY", "PROVIDER_CANARY", "ACCOUNT_CANARY"})
        CHECK(package.bytes.find(secret) == std::string::npos);
    CHECK(before == value.run_snapshot.dump());

    auto continuity = source();
    auto decisions = continuity.run_snapshot.at("inputs").as_array();
    decisions.push_back(O{{"text", "【最新变更决定】\n改为最新版中文摘要\n【执行约束】与旧要求冲突时以本决定为准。"}, {"time", "third"}});
    set(continuity, "inputs", decisions); set(continuity, "status", "partial"); set(continuity, "error", "Remaining verification");
    const auto continued = make_task_handoff(continuity); checksum(continued);
    const auto& continued_task = continued.document.at("task");
    CHECK(continued_task.at("requirements").as_array().back().at("kind").as_string() == "change");
    CHECK(continued_task.at("latestDecision").at("kind").as_string() == "change");
    CHECK(continued_task.at("latestDecision").at("text").as_string() == "改为最新版中文摘要");
    CHECK(continued_task.at("unresolvedItems").as_array().size() == 3);
    CHECK(continued_task.at("unresolvedItems").as_array()[0].at("detail").as_string() == "Remaining verification");
    CHECK(continued.document.at("readmeMarkdown").as_string().find("## Latest decision") != std::string::npos);
    CHECK(continued.document.at("readmeMarkdown").as_string().find("## Unresolved items") != std::string::npos);
    CHECK(!continued.document.at("automaticResume").as_bool() && continued.document.at("requiresNewUserTask").as_bool());

    const std::string sensitive = "C:\\Users\\Synthetic\\file.txt \\\\server\\private\\file /home/synthetic/private /mnt/l/private " 
        "file:///C:/private http://localhost:1234/private https://127.0.0.1:5555/private "
        "Bearer BEARER_CANARY Basic BASIC_CANARY api_key=KEY_CANARY password='PASSWORD_CANARY' "
        "sk-SYNTHETIC_CANARY https://synthetic:CREDENTIAL_CANARY@example.invalid/path EXACT_SECRET_CANARY";
    set(value, "answer", sensitive);
    value.sensitive_values = {"EXACT_SECRET_CANARY", utf8(project)};
    set(value, "error", utf8(project) + "/private problem");
    package = make_task_handoff(value); checksum(package);
    for (const auto* marker : {"C:", "server", "/home/", "/mnt/", "file://", "localhost", "127.0.0.1", "BEARER_CANARY", "BASIC_CANARY",
         "KEY_CANARY", "PASSWORD_CANARY", "SYNTHETIC_CANARY", "CREDENTIAL_CANARY", "EXACT_SECRET_CANARY"})
        CHECK(package.bytes.find(marker) == std::string::npos);
    CHECK(package.bytes.find(utf8(project)) == std::string::npos);
    CHECK(package.document.at("readmeMarkdown").as_string().find("[redacted local path]") != std::string::npos);
    CHECK(package.document.at("readmeMarkdown").as_string().find("[redacted credential]") != std::string::npos);

    value = source();
    value.artifacts.push_back({project, "missing.txt", "complete.txt", "text/plain", 7, false, true});
    package = make_task_handoff(value); checksum(package);
    const auto metadata = package.document.at("artifacts").as_array()[0];
    CHECK(metadata.at("sha256").is_null() && !metadata.at("included").as_bool());
    CHECK(metadata.at("declaredBytes").as_string() == "7" && !metadata.find("data") && !metadata.find("bytes"));
    CHECK(metadata.at("name").as_string() == "complete.txt");
    CHECK(package.document.at("task").at("artifactIds").as_array()[0].as_string() == "artifact-1");
    rejects([&] { (void)make_task_handoff(value, {true}); }, 409, "handoff_file_missing");
    value.artifacts[0].available = true;
    rejects([&] { (void)make_task_handoff(value, {true}); }, 409, "handoff_file_unavailable");
    value.artifacts = {{fs::path(), "", "unmapped-child.txt", "", 5, false, false}};
    package = make_task_handoff(value, {true});
    CHECK(package.document.at("artifacts").as_array()[0].at("reason").as_string() == "protected-runtime-or-account-material");
    for (const auto* relative : {"profile/account.txt", "settings.json", "nested/file.db", "tool-receipts/receipt.txt", ".hidden/file.txt"}) {
        value.artifacts = {{project, relative, "protected.txt", "", 999, true, true}};
        package = make_task_handoff(value, {true});
        CHECK(!package.document.at("artifacts").as_array()[0].at("included").as_bool());
    }
    value.artifacts = {{project, "missing.txt", "COM1.txt", "", 0, false, true}};
    CHECK(make_task_handoff(value).document.at("artifacts").as_array()[0].at("name").as_string() == "artifact-1.bin");
    value.artifacts[0].name = "NUL.json";
    CHECK(make_task_handoff(value).document.at("artifacts").as_array()[0].at("name").as_string() == "artifact-1.bin");

    const std::string binary{char(0), char(1), char(2), char(255)};
    write(project / L"sub" / L"data.bin", binary); write(project / L"empty.txt", "");
    const auto unicode = fs::path(L"sub") / L"中文 100%.txt"; write(project / unicode, "Unicode and spaces");
    CHECK(read_handoff_artifact(project, utf8(unicode)) == "Unicode and spaces");
    CHECK(read_handoff_artifact(project, "sub\\data.bin") == binary);
    value = source();
    value.artifacts = {{project, "sub/data.bin", "data.bin", "application/octet-stream", 4, true, true},
        {project, "empty.txt", "empty.txt", "text/plain; charset=utf-8", 0, true, true}};
    package = make_task_handoff(value, {true}); checksum(package);
    const auto& files = package.document.at("artifacts").as_array();
    CHECK(files[0].at("data").as_string() == "AAEC/w==");
    CHECK(files[0].at("sha256").as_string() == source_data_digest(binary));
    CHECK(files[0].at("bytes").as_string() == "4" && files[0].at("included").as_bool());
    CHECK(files[1].at("data").as_string().empty() && files[1].at("sha256").as_string() == source_data_digest(""));
    CHECK(files[1].at("mediaType").as_string() == "text/plain");
    CHECK(package.document.at("attachments").at("contentsNotAutomaticallyAnonymized").as_bool());
    CHECK(package.bytes.find(utf8(project)) == std::string::npos && !files[0].find("root") && !files[0].find("relative"));
    value.artifacts[0].declared_bytes = 3;
    rejects([&] { (void)make_task_handoff(value, {true}); }, 409, "handoff_file_changed");
    value.artifacts[0].declared_bytes = 4;
    TaskHandoffLimits limits; limits.max_file_bytes = 3;
    rejects([&] { (void)make_task_handoff(value, {true}, limits); }, 413, "handoff_file_too_large");
    limits = {}; limits.max_total_file_bytes = 3;
    rejects([&] { (void)make_task_handoff(value, {true}, limits); }, 413, "handoff_attachment_limit");
    rejects([&] { (void)read_handoff_artifact(project, "sub/data.bin", 3); }, 413, "handoff_file_too_large");
    limits = {}; limits.max_package_bytes = 10;
    rejects([&] { (void)make_task_handoff(value, {}, limits); }, 413, "handoff_package_limit");
    limits = {}; limits.max_text_bytes = 8;
    rejects([&] { (void)make_task_handoff(value, {}, limits); }, 413, "handoff_text_limit");
    limits = {}; limits.max_files = 0;
    rejects([&] { (void)make_task_handoff(value, {}, limits); }, 400, "handoff_invalid_limits");
    value.artifacts = {{project, "review.txt", "review.txt", "text/plain", sensitive.size(), true, true}};
    write(project / L"review.txt", sensitive);
    rejects([&] { (void)make_task_handoff(value, {true}); }, 409, "handoff_attachment_requires_privacy_review");
    CHECK(read(project / L"review.txt") == sensitive);
    value.artifacts.assign(33, TaskHandoffArtifact{fs::path(), "", "", "", 0, false, false});
    rejects([&] { (void)make_task_handoff(value); }, 413, "handoff_item_limit");
    value = source(); value.children = A(65, O{});
    rejects([&] { (void)make_task_handoff(value); }, 413, "handoff_item_limit");
    value = source(); set(value, "inputs", A(513, O{{"text", "request"}}));
    rejects([&] { (void)make_task_handoff(value); }, 409, "handoff_inputs_unavailable");
    value = source(); set(value, "answer", std::string("\xc0\xaf", 2));
    rejects([&] { (void)make_task_handoff(value); }, 409, "handoff_invalid_source_text");
    value = source(); set(value, "inputs", A{O{{"text", 17}}});
    rejects([&] { (void)make_task_handoff(value); }, 409, "handoff_invalid_source_field");
    value = source(); set(value, "inputs", A{O{{"text", "request"}, {"context", O{}}}});
    rejects([&] { (void)make_task_handoff(value); }, 409, "handoff_invalid_quote_context");
    value = source(); value.children = A{O{{"dependsOn", 1}}};
    rejects([&] { (void)make_task_handoff(value); }, 409, "handoff_invalid_dependencies");
    value = source(); set(value, "attempt", -1);
    rejects([&] { (void)make_task_handoff(value); }, 409, "handoff_invalid_source_number");
    value = source(); set(value, "deleted", true);
    rejects([&] { (void)make_task_handoff(value); }, 404, "handoff_task_unavailable");

    for (const auto* relative : {"../outside/sentinel.txt", "sub/../empty.txt", "sub//data.bin", "sub/./data.bin", "sub/data.bin:secret",
        "C:/outside/file", "\\\\server\\share\\file", "/absolute/file", "sub/data.bin.", "sub/data.bin "})
        rejects([&] { (void)read_handoff_artifact(project, relative); }, 400, "handoff_invalid_relative_path");
    rejects([&] { (void)read_handoff_artifact(project / L"..", "outside/sentinel.txt"); }, 400, "handoff_invalid_root");
    rejects([&] { (void)read_handoff_artifact(project, "settings.json"); }, 403, "handoff_protected_artifact");
    CHECK(CreateHardLinkW(native(project / L"hardlink.txt").c_str(), native(sentinel).c_str(), nullptr));
    rejects([&] { (void)read_handoff_artifact(project, "hardlink.txt"); }, 409, "handoff_unsafe_file");
    if (symlink(project / L"symbol.txt", sentinel)) {
        rejects([&] { (void)read_handoff_artifact(project, "symbol.txt"); }, 409, "handoff_unsafe_file");
    }
    junction(project / L"junction", outside);
    rejects([&] { (void)read_handoff_artifact(project, "junction/sentinel.txt"); }, 409, "handoff_unsafe_file");
    {
        HandoffFileReader reader(project, "sub/data.bin");
        CHECK(reader.size() == 4 && reader.read() == binary && reader.read() == binary);
        const auto writer = CreateFileW(native(project / L"sub" / L"data.bin").c_str(), GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
        const auto write_error = GetLastError(); if (writer != INVALID_HANDLE_VALUE) CloseHandle(writer);
        CHECK(writer == INVALID_HANDLE_VALUE && write_error == ERROR_SHARING_VIOLATION);
        const auto renamed = MoveFileExW(native(project / L"sub").c_str(), native(project / L"renamed").c_str(), 0);
        CHECK(!renamed && GetLastError() == ERROR_SHARING_VIOLATION);
        CHECK(reader.read() == binary);
    }
    CHECK(MoveFileExW(native(project / L"sub").c_str(), native(project / L"renamed").c_str(), 0));
    CHECK(read(project / L"renamed" / L"data.bin") == binary);
    CHECK(read(sentinel) == "external sentinel");
    std::cout << "task_handoff: " << checks << " checks passed\n"; return 0;
 } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
