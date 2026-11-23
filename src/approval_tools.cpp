#include "dimension/approval_tools.hpp"
#include "dimension/atomic_file.hpp"
#include "dimension/managed_workspaces.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
[[noreturn]] void reject(int status, const char* code, const char* detail) {
    throw ApprovalError(status, code, detail);
}
void require(bool value, const char* detail) {
    if (!value) reject(400, "manual_tool_invalid", detail);
}
std::string utf8(const fs::path& value) {
    const auto text = value.u8string();
    return {reinterpret_cast<const char*>(text.data()), text.size()};
}
fs::path path8(const std::string& value) {
    return fs::path(std::u8string_view(reinterpret_cast<const char8_t*>(value.data()), value.size()));
}
void component(const fs::path& value) {
    const auto part = value.wstring();
    require(!part.empty() && part != L"." && part != L".." && part.back() != L' ' &&
        part.back() != L'.' && part.find_first_of(L":*?\"<>|") == part.npos &&
        std::none_of(part.begin(), part.end(), [](wchar_t c) { return c < 32; }),
        "Invalid project-relative filename");
    auto name = part.substr(0, part.find(L'.'));
    std::transform(name.begin(), name.end(), name.begin(), [](wchar_t c) {
        return c >= L'a' && c <= L'z' ? wchar_t(c - L'a' + L'A') : c;
    });
    require(name != L"CON" && name != L"PRN" && name != L"AUX" && name != L"NUL" &&
        !(name.size() == 4 && (name.starts_with(L"COM") || name.starts_with(L"LPT")) &&
          name[3] >= L'0' && name[3] <= L'9'), "Reserved project-relative filename");
}
fs::path target_path(const fs::path& root, const std::string& relative) {
    const auto name = root.root_name().wstring();
    const bool local=name.size()==2&&name[1]==L':'&&((name[0]>=L'A'&&name[0]<=L'Z')||(name[0]>=L'a'&&name[0]<=L'z'));
    const bool managed=name.starts_with(L"\\\\")&&managed_workspaces::key_from_windows_any_descendant(root).has_value();
    require(root.is_absolute() && (local||managed) && !root.relative_path().empty(),
        "Project root must be an absolute local directory or a managed WSL workspace");
    for (const auto& part : root.relative_path()) component(part);
    require(!relative.empty() && relative.size() <= 1200, "Invalid project-relative path length");
    auto text = relative;
    std::replace(text.begin(), text.end(), '\\', '/');
    const auto sub = path8(text);
    require(!sub.is_absolute() && !sub.has_root_name(), "Only project-relative file paths are allowed");
    for (const auto& part : sub) component(part);
    const auto result = root / sub;
    require(result.wstring().size() < 31000, "Project file path is too long");
    return result;
}
std::string preview(std::string value, std::size_t size) {
    if (value.size() <= size) return value;
    while (size && (static_cast<unsigned char>(value[size]) & 0xc0U) == 0x80U) --size;
    return value.substr(0, size) + " …（预览截断）";
}
Json atomic_project_write(const fs::path& root, const std::string& relative, const std::string& content,
                          const std::string& approval, std::stop_token stop) {
    const auto target = target_path(root, relative);
    AtomicWriteOptions options; options.existing_root = root;
    try {
        atomic_write_file(target, content, options, stop);
        return O{{"ok", true}, {"pending", false}, {"path", relative}, {"approvalId", approval}};
    } catch (const AtomicFileError& error) {
        if (error.committed) reject(503, "manual_tool_uncertain", error.what());
        if (error.kind == AtomicFileFailure::Cancelled) reject(409, "manual_tool_cancelled", error.what());
        if (error.kind == AtomicFileFailure::InvalidPath || error.kind == AtomicFileFailure::UnsafePath)
            reject(400, "manual_tool_invalid", error.what());
        reject(503, "manual_tool_storage", error.what());
    }
}
} // namespace

struct ApprovalToolQueue::Impl {
    struct State {
        ApprovalRequest request;
        ApprovalTicket ticket;
        fs::path root;
        std::string relative, content;
        std::stop_source lifetime;
        std::atomic_bool done{};
        std::size_t budget = 0;
    };
    struct Worker {
        std::shared_ptr<State> state;
        std::jthread thread;
    };
    ApprovalService& approvals;
    std::mutex mutex;
    std::vector<std::unique_ptr<Worker>> workers;
    bool closing = false;
    explicit Impl(ApprovalService& value) : approvals(value) {}

    Json execute(const std::shared_ptr<State>& state, std::stop_token stop) {
        const auto grant = approvals.wait_and_consume(state->ticket, state->request, stop);
        if (!grant.allowed)
            return O{{"ok", false}, {"pending", false}, {"error", "File operation was rejected, cancelled or stale"},
                {"approvalId", state->ticket.id}, {"state", approval_state_name(grant.state)}};
        Json result;
        try { result = atomic_project_write(state->root, state->relative, state->content, state->ticket.id, stop); }
        catch (const ApprovalError& error) {
            result = O{{"ok", false}, {"pending", false}, {"approvalId", state->ticket.id},
                {"error", error.what()}, {"code", error.code()}};
        }
        catch (...) {
            result = O{{"ok", false}, {"pending", false}, {"approvalId", state->ticket.id},
                {"error", "Project write outcome is uncertain; inspect the target before retry"}};
        }
        try { (void)approvals.complete(state->ticket, state->request, result); }
        catch (...) {
            auto fields = result.as_object();
            fields["approvalAuditError"] = "Execution outcome could not be saved; no automatic retry";
            result = std::move(fields);
        }
        return result;
    }
};
ApprovalToolQueue::ApprovalToolQueue(ApprovalService& service) : impl_(std::make_unique<Impl>(service)) {}
ApprovalToolQueue::~ApprovalToolQueue() { shutdown(); }
Json ApprovalToolQueue::write(const std::string& bot, const fs::path& root, const std::string& relative,
                             const std::string& content, ApprovalMode mode, const std::string& request_id) {
    std::lock_guard lock(impl_->mutex);
    if (impl_->closing) reject(409, "manual_tool_closed", "File operation queue is shutting down");
    require(!request_id.empty() && request_id.size() <= 120, "Invalid file operation request ID");
    require(content.size() <= 512U * 1024U, "New task text file exceeds 512 KiB");
    (void)target_path(root, relative);
    std::erase_if(impl_->workers, [](const auto& worker) { return worker->state->done.load(); });
    std::size_t used = 0;
    for (const auto& worker : impl_->workers) used += worker->state->budget;
    auto state = std::make_shared<Impl::State>();
    state->root = root; state->relative = relative; state->content = content;
    O display{{"tool", "write"}, {"risk", "write"}, {"path", relative},
        {"command", "项目根：" + preview(utf8(root), 600)}, {"content", preview(content, 320)}};
    if (Json(display).dump().size() > 3500) display.erase("content");
    const auto args = Json(O{{"projectRoot", utf8(root)}, {"path", relative}, {"content", content}}).dump();
    state->budget = args.size() + content.size() + Json(display).dump().size();
    if (impl_->workers.size() >= 16 || state->budget > 8U * 1024U * 1024U - used)
        reject(429, "manual_tool_capacity", "Pending file operation queue is full");
    state->request = {bot, "manual-" + request_id, 1, request_id, "write", args, true, Json(display)};
    state->ticket = impl_->approvals.request(state->request, mode, state->lifetime.get_token());
    const auto record = impl_->approvals.get(state->ticket.id, bot);
    if (record.at("state").as_string() != "pending") {
        if (!record.at("result").is_null()) return record.at("result");
        return impl_->execute(state, state->lifetime.get_token());
    }
    auto worker = std::make_unique<Impl::Worker>();
    worker->state = state;
    worker->thread = std::jthread([this, state](std::stop_token stop) {
        try { (void)impl_->execute(state, stop); }
        catch (...) {} // The gate fails closed; its durable record remains inspectable.
        state->done.store(true);
    });
    impl_->workers.push_back(std::move(worker));
    return O{{"ok", true}, {"pending", true}, {"path", relative}, {"approvalId", state->ticket.id}};
}
void ApprovalToolQueue::shutdown() noexcept {
    std::vector<std::unique_ptr<Impl::Worker>> workers;
    {
        std::lock_guard lock(impl_->mutex);
        if (impl_->closing) return;
        impl_->closing = true;
        for (auto& worker : impl_->workers) {
            worker->state->lifetime.request_stop();
            worker->thread.request_stop();
        }
        workers.swap(impl_->workers);
    }
    workers.clear();
}
} // namespace dimension

