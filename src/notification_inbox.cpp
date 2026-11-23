#include "dimension/notification_inbox.hpp"
#include "dimension/atomic_file.hpp"
#include <algorithm>
#include <fstream>
#include <stdexcept>

namespace dimension {
namespace {
using O = Json::Object;
using A = Json::Array;
constexpr std::size_t max_file_bytes = 4U * 1024U * 1024U;

std::string text(const Json& value, std::string_view key, std::size_t maximum = 8192) {
    const auto* found = value.find(key);
    if (!found || !found->is_string() || found->as_string().size() > maximum)
        throw std::runtime_error("Invalid notification inbox text field");
    return found->as_string();
}
std::string optional_text(const Json& value, std::string_view key, std::size_t maximum = 8192) {
    const auto* found = value.find(key);
    if (!found) return {};
    return text(value, key, maximum);
}
bool boolean(const Json& value, std::string_view key, bool fallback = false) {
    const auto* found = value.find(key);
    if (!found) return fallback;
    if (!found->is_bool()) throw std::runtime_error("Invalid notification inbox boolean field");
    return found->as_bool();
}
std::wstring native_path(std::filesystem::path path) {
    path = std::filesystem::absolute(path).lexically_normal();
    auto value = path.wstring();
    if (value.starts_with(L"\\\\?\\")) return value;
    if (value.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + value.substr(2);
    return L"\\\\?\\" + value;
}
Json normalized(const Json& input) {
    const auto id = text(input, "id", 512), kind = text(input, "kind", 32);
    static const std::vector<std::string> kinds{"completed", "partial", "failed", "resource", "takeover", "proactive-reminder"};
    if (id.empty() || std::find(kinds.begin(), kinds.end(), kind) == kinds.end())
        throw std::runtime_error("Invalid notification inbox event identity or category");
    const auto run_id = text(input, "runId", 512);
    if (run_id.empty()) throw std::runtime_error("Notification inbox record requires a run ID");
    const auto detail = optional_text(input, "detail");
    const auto summary = optional_text(input, "summary").empty() ? detail : optional_text(input, "summary");
    return O{{"id", id}, {"kind", kind}, {"title", optional_text(input, "title", 160)},
             {"botId", optional_text(input, "botId", 512)}, {"groupId", optional_text(input, "groupId", 512)},
             {"botName", optional_text(input, "botName", 512)}, {"runId", run_id},
             {"summary", summary}, {"detail", detail}, {"time", optional_text(input, "time", 64)},
             {"read", false}, {"waiting", kind == "resource" || kind == "takeover"},
             {"resolvedAt", ""}};
}
Json validated(const Json& input) {
    auto object = normalized(input).as_object();
    const auto waiting = boolean(input, "waiting", object.at("waiting").as_bool());
    object["read"] = boolean(input, "read");
    object["waiting"] = waiting;
    object["resolvedAt"] = optional_text(input, "resolvedAt", 64);
    if (waiting && !object.at("resolvedAt").as_string().empty())
        throw std::runtime_error("A resolved inbox record cannot remain waiting");
    return object;
}
} // namespace

NotificationInbox::NotificationInbox(std::filesystem::path file, std::size_t limit)
    : file_(std::move(file)), limit_(limit) {
    if (!file_.is_absolute() || file_.filename() != L"notification-inbox.json" || limit_ == 0 || limit_ > default_limit)
        throw std::invalid_argument("Invalid notification inbox storage configuration");
    std::filesystem::create_directories(file_.parent_path());
    // A damaged history must never prevent the task service from starting.
    // The next successful mutation atomically replaces it with a valid snapshot.
    try { load(); } catch (...) { records_.clear(); }
}

void NotificationInbox::load() {
    std::lock_guard lock(mutex_);
    records_.clear();
    if (!std::filesystem::exists(native_path(file_))) return;
    if (!std::filesystem::is_regular_file(native_path(file_)) ||
        std::filesystem::file_size(native_path(file_)) > max_file_bytes)
        throw std::runtime_error("Invalid notification inbox file");
    std::ifstream stream(native_path(file_), std::ios::binary);
    if (!stream) throw std::runtime_error("Cannot read notification inbox");
    const std::string bytes((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    if (!stream.good() && !stream.eof()) throw std::runtime_error("Cannot read notification inbox");
    const auto document = Json::parse(bytes, max_file_bytes);
    if (!document.is_object() || !document.find("version") || !document.at("version").is_number() ||
        document.at("version").as_number() != 1 || !document.find("items") || !document.at("items").is_array())
        throw std::runtime_error("Unsupported notification inbox format");
    const auto& items = document.at("items").as_array();
    if (items.size() > limit_) throw std::runtime_error("Notification inbox exceeds its configured bound");
    for (const auto& item : items) {
        if (!item.is_object()) throw std::runtime_error("Invalid notification inbox item");
        auto record = validated(item);
        const auto& id = record.at("id").as_string();
        if (std::any_of(records_.begin(), records_.end(), [&](const Json& existing) {
            return existing.at("id").as_string() == id;
        })) throw std::runtime_error("Duplicate notification inbox event ID");
        records_.push_back(std::move(record));
    }
}

void NotificationInbox::persist(const std::vector<Json>& records) const {
    A items;
    items.reserve(records.size());
    for (const auto& record : records) items.push_back(record);
    AtomicWriteOptions options;
    options.existing_root = file_.parent_path();
    atomic_write_file(file_, Json(O{{"version", 1}, {"items", std::move(items)}}).dump(), options);
}

bool NotificationInbox::add(const Json& notification) {
    auto record = normalized(notification);
    std::lock_guard lock(mutex_);
    const auto& id = record.at("id").as_string();
    if (std::any_of(records_.begin(), records_.end(), [&](const Json& existing) {
        return existing.at("id").as_string() == id;
    })) return false;
    auto next = records_;
    next.insert(next.begin(), std::move(record));
    if (next.size() > limit_) next.resize(limit_);
    persist(next);
    records_ = std::move(next);
    return true;
}

std::size_t NotificationInbox::resolve_waiting(const std::string& run_id, const std::string& time) {
    if (run_id.empty()) return 0;
    std::lock_guard lock(mutex_);
    auto next = records_;
    std::size_t changed = 0;
    for (auto& record : next) {
        if (record.at("runId").as_string() != run_id || !record.at("waiting").as_bool()) continue;
        auto object = record.as_object();
        object["waiting"] = false;
        object["resolvedAt"] = time;
        record = std::move(object);
        ++changed;
    }
    if (!changed) return 0;
    persist(next);
    records_ = std::move(next);
    return changed;
}

bool NotificationInbox::mark_read(const std::string& event_id) {
    std::lock_guard lock(mutex_);
    auto next = records_;
    const auto found = std::find_if(next.begin(), next.end(), [&](const Json& record) {
        return record.at("id").as_string() == event_id;
    });
    if (found == next.end()) return false;
    if (found->at("read").as_bool()) return true;
    auto object = found->as_object();
    object["read"] = true;
    *found = std::move(object);
    persist(next);
    records_ = std::move(next);
    return true;
}

std::size_t NotificationInbox::mark_all_read() {
    std::lock_guard lock(mutex_);
    auto next = records_;
    std::size_t changed = 0;
    for (auto& record : next) {
        if (record.at("read").as_bool()) continue;
        auto object = record.as_object();
        object["read"] = true;
        record = std::move(object);
        ++changed;
    }
    if (!changed) return 0;
    persist(next);
    records_ = std::move(next);
    return changed;
}

Json NotificationInbox::list(bool unread_only) const {
    std::lock_guard lock(mutex_);
    A items;
    std::size_t unread = 0;
    for (const auto& record : records_) {
        const bool read = record.at("read").as_bool();
        if (!read) ++unread;
        if (!unread_only || !read) items.push_back(record);
    }
    return O{{"items", std::move(items)}, {"unreadCount", static_cast<double>(unread)},
             {"total", static_cast<double>(records_.size())}, {"limit", static_cast<double>(limit_)}};
}

std::size_t NotificationInbox::unread_count() const {
    std::lock_guard lock(mutex_);
    return static_cast<std::size_t>(std::count_if(records_.begin(), records_.end(), [](const Json& record) {
        return !record.at("read").as_bool();
    }));
}

std::size_t NotificationInbox::size() const {
    std::lock_guard lock(mutex_);
    return records_.size();
}

} // namespace dimension
