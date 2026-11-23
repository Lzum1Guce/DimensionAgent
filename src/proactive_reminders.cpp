#include "dimension/proactive_reminders.hpp"
#include "dimension/atomic_file.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <limits>
#include <random>
#include <set>
#include <sstream>
#include <utility>
#include <vector>

namespace dimension {
namespace {
using O = Json::Object;
using A = Json::Array;
namespace fs = std::filesystem;
constexpr std::size_t max_rules = 128;
constexpr std::size_t max_seen_events = 1024;
constexpr std::int64_t max_interval_minutes = 525600;
constexpr std::int64_t max_budget = 1000;

[[noreturn]] void reject(std::string message, int status = 400) {
    throw ProactiveReminderError(status, std::move(message));
}
std::int64_t system_now() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}
std::string text(const Json& value, std::string_view key, std::string fallback = {}) {
    const auto* found = value.find(key);
    return found && found->is_string() ? found->as_string() : fallback;
}
double number(const Json& value, std::string_view key, double fallback = 0) {
    const auto* found = value.find(key);
    return found && found->is_number() ? found->as_number() : fallback;
}
bool boolean(const Json& value, std::string_view key, bool fallback = false) {
    const auto* found = value.find(key);
    return found && found->is_bool() ? found->as_bool() : fallback;
}
std::int64_t integer(const Json& value, std::string_view key, std::int64_t fallback,
                     std::int64_t minimum, std::int64_t maximum) {
    const auto* found = value.find(key);
    if (!found || found->is_null()) return fallback;
    if (!found->is_number() || !std::isfinite(found->as_number()) ||
        std::floor(found->as_number()) != found->as_number() ||
        found->as_number() < static_cast<double>(minimum) ||
        found->as_number() > static_cast<double>(maximum)) reject("提醒规则的数值字段无效");
    return static_cast<std::int64_t>(found->as_number());
}
void bounded_text(const std::string& value, std::size_t maximum, bool required, const char* message) {
    if ((required && value.find_first_not_of(" \t\r\n") == std::string::npos) || value.size() > maximum ||
        value.find('\0') != std::string::npos) reject(message);
}
bool allowed_event(const std::string& type) {
    return type == "run_completed" || type == "run_partial" || type == "run_failed";
}
void only_keys(const Json& input, const std::set<std::string>& allowed) {
    if (!input.is_object()) reject("提醒规则必须为JSON对象");
    for (const auto& [key, unused] : input.as_object()) {
        (void)unused;
        if (!allowed.contains(key)) reject("提醒规则包含未知字段: " + key);
    }
}
std::string iso_time(std::int64_t milliseconds) {
    const std::time_t stamp = static_cast<std::time_t>(milliseconds / 1000);
    std::tm utc{};
    if (gmtime_s(&utc, &stamp) != 0) return {};
    std::ostringstream out;
    out << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.'
        << std::setw(3) << std::setfill('0') << (milliseconds % 1000 + 1000) % 1000 << 'Z';
    return out.str();
}
std::string new_id() {
    static std::atomic_uint64_t sequence{};
    std::random_device random;
    std::ostringstream out;
    out << "reminder-" << std::hex << system_now() << '-' << sequence.fetch_add(1) << '-'
        << random() << random();
    return out.str();
}
void check_revision(const Json& input, const Json& existing) {
    const auto revision = integer(input, "revision", 0, 0, 9007199254740991LL);
    if (revision <= 0) reject("修改提醒必须携带当前revision", 409);
    if (revision != integer(existing, "revision", 0, 0, 9007199254740991LL))
        reject("提醒规则已被其他窗口修改，请刷新后重试", 409);
}
Json* find_rule(Json& document, const std::string& id) {
    auto& rules = document.at("rules").as_array();
    const auto found = std::find_if(rules.begin(), rules.end(), [&](const Json& rule) {
        return rule.is_object() && text(rule, "id") == id;
    });
    return found == rules.end() ? nullptr : &*found;
}
const Json* find_rule(const Json& document, const std::string& id) {
    const auto& rules = document.at("rules").as_array();
    const auto found = std::find_if(rules.begin(), rules.end(), [&](const Json& rule) {
        return rule.is_object() && text(rule, "id") == id;
    });
    return found == rules.end() ? nullptr : &*found;
}
void complete(Json& rule, const std::string& reason) {
    rule["enabled"] = false;
    rule["status"] = "completed";
    rule["nextTriggerAt"] = 0;
    rule["lastReason"] = reason;
}
bool scope_matches(const Json& rule, const Json& event) {
    const auto* scope = rule.find("scope");
    if (!scope || !scope->is_object()) return false;
    for (const std::string_view key : {"botId", "groupId", "runId"}) {
        const auto expected = text(*scope, key);
        if (!expected.empty() && text(event, key) != expected) return false;
    }
    return true;
}
std::string event_key(const Json& event) {
    if (!event.is_object()) return {};
    const auto type = text(event, "type"), run = text(event, "runId");
    const auto sequence = number(event, "seq", -1);
    if (!allowed_event(type) || run.empty() || run.size() > 512 || sequence < 0 ||
        !std::isfinite(sequence) || std::floor(sequence) != sequence ||
        sequence > 9007199254740991.0) return {};
    return run + ":" + std::to_string(static_cast<std::uint64_t>(sequence)) + ":" + type;
}
bool seen(const Json& rule, const std::string& key) {
    const auto* values = rule.find("seenEventIds");
    if (!values || !values->is_array()) return false;
    return std::any_of(values->as_array().begin(), values->as_array().end(), [&](const Json& value) {
        return value.is_string() && value.as_string() == key;
    });
}
void remember(Json& rule, const std::string& key) {
    auto values = rule.at("seenEventIds").as_array();
    values.emplace_back(key);
    if (values.size() > max_seen_events) values.erase(values.begin());
    rule["seenEventIds"] = std::move(values);
}
void mark_trigger(Json& rule, std::int64_t time, std::int64_t missed, const std::string& event_key,
                  const std::string& dynamic_detail = {}) {
    const auto count = integer(rule, "triggerCount", 0, 0, max_budget) + 1;
    rule["triggerCount"] = static_cast<double>(count);
    rule["lastTriggeredAt"] = static_cast<double>(time);
    rule["lastReason"] = missed > 0 ? "已合并错过的间隔，只触发这一次" : "已按规则触发一次";
    const auto full_text = dynamic_detail.empty() ? text(rule, "message")
        : (text(rule, "message") + "\n\n" + dynamic_detail);
    if (text(rule, "delivery") == "draft") {
        rule["latestDraft"] = O{{"text", full_text}, {"preparedAt", static_cast<double>(time)},
            {"eventKey", event_key}, {"coalesced", missed > 0}, {"missedOccurrences", static_cast<double>(missed)},
            {"status", "draft-only-not-sent"}};
    }
    if (count >= integer(rule, "budget", 1, 1, max_budget)) complete(rule, "已达到最大触发次数，规则停止");
}
std::string read_storage(const fs::path& path) {
    std::error_code error;
    if (!fs::exists(path, error)) {
        if (error) throw std::runtime_error("无法检查提醒规则存储");
        return {};
    }
    if (!fs::is_regular_file(path, error) || error) throw std::runtime_error("提醒规则存储不是普通文件");
    const auto size = fs::file_size(path, error);
    if (error || size > 4U * 1024U * 1024U) throw std::runtime_error("提醒规则存储超过4MiB或不可读取");
    std::ifstream input(path, std::ios::binary);
    std::string bytes(static_cast<std::size_t>(size), '\0');
    input.read(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    if (!input && !bytes.empty()) throw std::runtime_error("提醒规则存储读取失败");
    return bytes;
}
} // namespace

ProactiveReminderService::ProactiveReminderService(ProactiveReminderOptions options)
    : options_(std::move(options)), storage_file_(std::move(options_.storage_file)),
      document_(O{{"version", 1}, {"rules", A{}}}) {
    if (storage_file_.empty() || !storage_file_.is_absolute()) reject("提醒规则存储必须使用绝对路径", 500);
    if (!options_.now) options_.now = system_now;
    fs::create_directories(storage_file_.parent_path());
    load();
}

std::int64_t ProactiveReminderService::now() const { return options_.now(); }

void ProactiveReminderService::load() {
    const auto bytes = read_storage(storage_file_);
    if (bytes.empty()) return;
    const auto stored = Json::parse(bytes);
    only_keys(stored, {"version", "rules"});
    if (integer(stored, "version", 0, 0, 1) != 1 || !stored.at("rules").is_array() ||
        stored.at("rules").as_array().size() > max_rules) reject("提醒规则存储格式无效", 500);
    A restored;
    std::set<std::string> ids;
    for (const auto& saved : stored.at("rules").as_array()) {
        only_keys(saved, {"id", "revision", "name", "kind", "scope", "message", "delivery", "budget",
            "endAt", "endEventType", "intervalMinutes", "eventType", "dynamicSummary", "enabled", "status", "triggerCount",
            "skippedCount", "silentCheckCount", "nextTriggerAt", "lastTriggeredAt", "createdAt", "updatedAt", "seenEventIds",
            "latestDraft", "lastReason", "lastSnapshotDigest", "lastProgressDigest", "lastDispatchedRunId"});
        O configuration;
        for (const char* key : {"name", "kind", "scope", "message", "delivery", "budget", "endAt",
            "endEventType", "intervalMinutes", "eventType", "dynamicSummary"}) if (const auto* value = saved.find(key)) configuration[key] = *value;
        auto rule = normalized_rule(configuration);
        const auto id = text(saved, "id");
        bounded_text(id, 160, true, "提醒规则ID无效");
        if (!id.starts_with("reminder-") || !ids.insert(id).second) reject("提醒规则ID无效或重复", 500);
        rule["id"] = id;
        rule["revision"] = static_cast<double>(integer(saved, "revision", 0, 1, 9007199254740991LL));
        rule["createdAt"] = static_cast<double>(integer(saved, "createdAt", 0, 0, 9007199254740991LL));
        rule["updatedAt"] = static_cast<double>(integer(saved, "updatedAt", 0, 0, 9007199254740991LL));
        rule["triggerCount"] = static_cast<double>(integer(saved, "triggerCount", 0, 0, max_budget));
        rule["skippedCount"] = static_cast<double>(integer(saved, "skippedCount", 0, 0, 9007199254740991LL));
        if (saved.find("silentCheckCount"))
            rule["silentCheckCount"] = static_cast<double>(integer(saved, "silentCheckCount", 0, 0, 9007199254740991LL));
        if (saved.find("lastSnapshotDigest")) rule["lastSnapshotDigest"] = text(saved, "lastSnapshotDigest");
        if (saved.find("lastProgressDigest")) rule["lastProgressDigest"] = text(saved, "lastProgressDigest");
        if (saved.find("lastDispatchedRunId")) rule["lastDispatchedRunId"] = text(saved, "lastDispatchedRunId");
        rule["nextTriggerAt"] = static_cast<double>(integer(saved, "nextTriggerAt", 0, 0, 9007199254740991LL));
        rule["lastTriggeredAt"] = static_cast<double>(integer(saved, "lastTriggeredAt", 0, 0, 9007199254740991LL));
        rule["enabled"] = boolean(saved, "enabled");
        const auto status = text(saved, "status");
        if (status != "active" && status != "paused" && status != "completed") reject("提醒规则状态无效", 500);
        rule["status"] = status;
        rule["lastReason"] = text(saved, "lastReason");
        const bool periodic = text(rule, "kind") == "interval" || text(rule, "kind") == "project_watch";
        if (status == "active" && (!rule.at("enabled").as_bool() ||
            (periodic && number(rule, "nextTriggerAt") <= 0))) reject("提醒规则调度状态无效", 500);
        if (status != "active" && rule.at("enabled").as_bool()) reject("提醒规则启用状态无效", 500);
        if (number(rule, "triggerCount") > number(rule, "budget")) reject("提醒规则预算状态无效", 500);
        const auto* seen_values = saved.find("seenEventIds");
        if (!seen_values || !seen_values->is_array() || seen_values->as_array().size() > max_seen_events)
            reject("提醒规则去重状态无效", 500);
        std::set<std::string> unique;
        for (const auto& value : seen_values->as_array()) {
            if (!value.is_string() || value.as_string().empty() || value.as_string().size() > 1024 ||
                !unique.insert(value.as_string()).second) reject("提醒规则去重状态无效", 500);
        }
        rule["seenEventIds"] = *seen_values;
        const auto* draft = saved.find("latestDraft");
        if (!draft || (!draft->is_null() && !draft->is_object())) reject("提醒草稿状态无效", 500);
        if (draft->is_object()) {
            only_keys(*draft, {"text", "preparedAt", "eventKey", "coalesced", "missedOccurrences", "status"});
            if (text(*draft, "status") != "draft-only-not-sent") reject("提醒草稿状态无效", 500);
        }
        rule["latestDraft"] = *draft;
        restored.push_back(std::move(rule));
    }
    document_ = O{{"version", 1}, {"rules", std::move(restored)}};
}

Json ProactiveReminderService::normalized_rule(const Json& input, const Json* existing) const {
    const bool ext = options_.enable_extended_modes;
    std::set<std::string> allowed_keys{"revision", "name", "kind", "scope", "message", "delivery", "budget", "endAt",
        "endEventType", "intervalMinutes", "eventType"};
    if (ext) allowed_keys.insert("dynamicSummary");
    only_keys(input, allowed_keys);
    if (existing) check_revision(input, *existing);
    const auto kind = text(input, "kind");
    const bool periodic = kind == "interval" || (ext && kind == "project_watch");
    if (!periodic && kind != "condition")
        reject(ext ? "提醒类型须为interval、condition或project_watch" : "提醒类型须为interval或condition");
    const auto name = text(input, "name"), message = text(input, "message"), delivery = text(input, "delivery", "notification");
    bounded_text(name, 160, true, "提醒名称必填且最多160字节");
    bounded_text(message, 2000, true, "通知文案必填且最多2000字节");
    const bool allow_work_delivery = ext && static_cast<bool>(options_.dispatch_work);
    if (delivery != "notification" && delivery != "draft" && !(allow_work_delivery && delivery == "authorized_work"))
        reject(allow_work_delivery ? "交付档位须为notification、draft或authorized_work" : "提醒结果须为notification或draft");
    const auto max_rule_budget = delivery == "authorized_work" ? std::int64_t{20} : max_budget;
    const auto budget = integer(input, "budget", 1, 1, max_rule_budget);
    const auto end_at = integer(input, "endAt", 0, 0, 9007199254740991LL);
    const auto end_event = text(input, "endEventType");
    if (!end_event.empty() && !allowed_event(end_event)) reject("结束条件只接受只读调度终态事件");
    if (!end_at && end_event.empty()) reject("必须明确结束时间或结束条件");
    const auto interval = integer(input, "intervalMinutes", periodic ? 0 : 1, 0, max_interval_minutes);
    if (periodic && interval < 1) reject("间隔或项目巡检须设置1到525600分钟");
    const auto event_type = text(input, "eventType");
    if (kind == "condition" && !allowed_event(event_type)) reject("条件提醒只接受只读调度终态事件");
    const auto* scope = input.find("scope");
    if (!scope || !scope->is_object()) reject("必须明确只读范围");
    std::set<std::string> scope_keys{"source", "botId", "groupId", "runId"};
    if (ext) scope_keys.insert("projectPath");
    only_keys(*scope, scope_keys);
    const auto source_type = text(*scope, "source");
    if (kind == "project_watch") {
        if (source_type != "project") reject("项目变化巡检须指定scope.source=project");
    } else if (source_type != "scheduler") {
        reject("条件与普通间隔提醒只能观察scheduler范围");
    }
    O clean_scope{{"source", source_type}};
    for (const std::string_view key : {"botId", "groupId", "runId"}) {
        const auto value = text(*scope, key);
        bounded_text(value, 512, false, "只读范围标识最多512字节");
        clean_scope[std::string(key)] = value;
    }
    if (ext) {
        const auto project_path = text(*scope, "projectPath");
        bounded_text(project_path, 1024, kind == "project_watch", "项目巡检必须填写有效的本地项目目录路径");
        if (!project_path.empty()) clean_scope["projectPath"] = project_path;
    }
    if (delivery == "authorized_work" && text(clean_scope, "botId").empty())
        reject("第3档「按明确授权执行」必须指定负责执行的Bot ID");
    const bool dynamic_summary = ext && boolean(input, "dynamicSummary", false);
    const auto time = now();
    Json rule = existing ? *existing : Json(O{});
    rule["id"] = existing ? text(*existing, "id") : new_id();
    rule["revision"] = existing ? number(*existing, "revision") + 1 : 1;
    rule["name"] = name; rule["kind"] = kind; rule["scope"] = std::move(clean_scope);
    rule["message"] = message; rule["delivery"] = delivery; rule["budget"] = static_cast<double>(budget);
    rule["endAt"] = static_cast<double>(end_at); rule["endEventType"] = end_event;
    rule["intervalMinutes"] = static_cast<double>(periodic ? interval : 0);
    rule["eventType"] = kind == "condition" ? event_type : "";
    if (ext) rule["dynamicSummary"] = dynamic_summary;
    if (!existing) {
        rule["enabled"] = false; rule["status"] = "paused"; rule["triggerCount"] = 0;
        rule["skippedCount"] = 0; rule["nextTriggerAt"] = 0; rule["lastTriggeredAt"] = 0;
        rule["createdAt"] = static_cast<double>(time); rule["seenEventIds"] = A{};
        rule["latestDraft"] = Json(); rule["lastReason"] = "已创建，默认禁用";
        if (ext) {
            rule["silentCheckCount"] = 0;
            rule["lastSnapshotDigest"] = "";
            rule["lastProgressDigest"] = "";
            rule["lastDispatchedRunId"] = "";
        }
    } else {
        rule["updatedAt"] = static_cast<double>(time);
        if (number(rule, "triggerCount") >= number(rule, "budget")) complete(rule, "已达到最大触发次数，规则停止");
        else if (end_at && end_at <= time) complete(rule, "已到达结束时间，规则停止");
        else if (rule.at("enabled").as_bool()) {
            rule["nextTriggerAt"] = periodic ? static_cast<double>(time + interval * 60000) : 0;
            rule["lastReason"] = "规则已更新；间隔从更新时间重新计算";
        }
    }
    if (!existing) rule["updatedAt"] = static_cast<double>(time);
    return rule;
}

Json ProactiveReminderService::capabilities() const {
    const bool ext = options_.enable_extended_modes;
    const bool allow_work = ext && static_cast<bool>(options_.dispatch_work);
    return O{{"version", ext ? 2 : 1}, {"defaultEnabled", false},
        {"readSources", ext ? A{"scheduler", "project"} : A{"scheduler"}},
        {"eventTypes", A{"run_completed", "run_partial", "run_failed"}},
        {"deliveries", allow_work ? A{"notification", "draft", "authorized_work"} : A{"notification", "draft"}},
        {"maxRules", static_cast<double>(max_rules)},
        {"maxBudget", static_cast<double>(max_budget)}, {"missedPolicy", "coalesce-one-no-backlog"},
        {"quietPolicy", "drop-current-no-replay"}, {"automaticWork", false}, {"authorizedQueuedWork", allow_work},
        {"projectWatch", ext && static_cast<bool>(options_.inspect_project)},
        {"dynamicProgressSummary", ext && static_cast<bool>(options_.dynamic_progress)},
        {"automaticTools", false}, {"automaticUserFileWrites", false}, {"externalSending", false}, {"draftOnly", !allow_work}};
}

Json ProactiveReminderService::rules() const {
    std::lock_guard lock(mutex_);
    return document_.at("rules");
}
Json ProactiveReminderService::rule(const std::string& id) const {
    std::lock_guard lock(mutex_);
    const auto* found = find_rule(document_, id);
    if (!found) reject("提醒规则不存在", 404);
    return *found;
}
Json ProactiveReminderService::create(const Json& input) {
    std::lock_guard lock(mutex_);
    if (document_.at("rules").as_array().size() >= max_rules) reject("提醒规则最多128条", 413);
    auto next = document_;
    auto created = normalized_rule(input);
    next.at("rules").as_array().push_back(created);
    AtomicWriteOptions write; write.existing_root = storage_file_.parent_path();
    atomic_write_file(storage_file_, next.dump(), write);
    document_ = std::move(next);
    return created;
}
Json ProactiveReminderService::update(const std::string& id, const Json& input) {
    std::lock_guard lock(mutex_);
    const auto* current = find_rule(document_, id);
    if (!current) reject("提醒规则不存在", 404);
    auto next = document_;
    auto updated = normalized_rule(input, current);
    *find_rule(next, id) = updated;
    AtomicWriteOptions write; write.existing_root = storage_file_.parent_path();
    atomic_write_file(storage_file_, next.dump(), write);
    document_ = std::move(next);
    return updated;
}
Json ProactiveReminderService::set_enabled(const std::string& id, bool enabled, const Json& input) {
    only_keys(input, {"revision"});
    std::lock_guard lock(mutex_);
    const auto* current = find_rule(document_, id);
    if (!current) reject("提醒规则不存在", 404);
    check_revision(input, *current);
    auto next = document_;
    auto* rule = find_rule(next, id);
    if (text(*rule, "status") == "completed") reject("已结束的规则不能再次启用", 409);
    const auto time = now();
    if (enabled && number(*rule, "endAt") > 0 && number(*rule, "endAt") <= time) {
        complete(*rule, "已到达结束时间，规则停止");
    } else {
        rule->at("enabled") = Json(enabled);
        (*rule)["status"] = enabled ? "active" : "paused";
        const bool periodic = text(*rule, "kind") == "interval" || text(*rule, "kind") == "project_watch";
        (*rule)["nextTriggerAt"] = enabled && periodic
            ? static_cast<double>(time + static_cast<std::int64_t>(number(*rule, "intervalMinutes")) * 60000) : 0;
        if (enabled && text(*rule, "kind") == "project_watch" && options_.inspect_project) {
            try {
                const auto proj = text((*rule).at("scope"), "projectPath");
                const auto snap = options_.inspect_project(proj, "");
                (*rule)["lastSnapshotDigest"] = text(snap, "digest");
            } catch (...) {}
        }
        (*rule)["lastReason"] = enabled ? "已启用；不补播暂停期间的事件或间隔" : "已暂停；不补播暂停期间的事件或间隔";
    }
    (*rule)["revision"] = number(*rule, "revision") + 1;
    (*rule)["updatedAt"] = static_cast<double>(time);
    auto result = *rule;
    AtomicWriteOptions write; write.existing_root = storage_file_.parent_path();
    atomic_write_file(storage_file_, next.dump(), write);
    document_ = std::move(next);
    return result;
}
Json ProactiveReminderService::remove(const std::string& id, const Json& input) {
    only_keys(input, {"revision"});
    std::lock_guard lock(mutex_);
    const auto* current = find_rule(document_, id);
    if (!current) reject("提醒规则不存在", 404);
    check_revision(input, *current);
    auto next = document_;
    auto& values = next.at("rules").as_array();
    values.erase(std::remove_if(values.begin(), values.end(), [&](const Json& value) { return text(value, "id") == id; }), values.end());
    AtomicWriteOptions write; write.existing_root = storage_file_.parent_path();
    atomic_write_file(storage_file_, next.dump(), write);
    document_ = std::move(next);
    return O{{"ok", true}, {"removed", id}};
}

void ProactiveReminderService::deliver(const Json& rule_value, std::int64_t event_time,
                                       std::int64_t missed, const std::string& key) const {
    const auto delivery = text(rule_value, "delivery");
    if (delivery == "draft") return;
    auto detail = text(rule_value, "message");
    if (const auto extra = text(rule_value, "_dynamicDetail"); !extra.empty()) {
        detail += "\n" + extra;
    }
    if (missed > 0) detail += "（已合并" + std::to_string(missed) + "次错过提醒，不补播）";
    if (delivery == "authorized_work" && options_.dispatch_work) {
        std::string run_id;
        try { run_id = options_.dispatch_work(rule_value, detail); }
        catch (const std::exception& err) { detail += "\n[受控任务提交受阻：" + std::string(err.what()) + "]"; }
        if (!run_id.empty()) detail += "\n[已按授权排队 Work 任务：" + run_id + "]";
    }
    if (!options_.notify) return;
    options_.notify(O{{"id", "proactive:" + text(rule_value, "id") + ":" + std::to_string(static_cast<std::int64_t>(number(rule_value, "triggerCount")))},
        {"kind", "proactive-reminder"}, {"title", text(rule_value, "name")}, {"detail", detail},
        {"ruleId", text(rule_value, "id")}, {"scope", rule_value.at("scope")},
        {"time", iso_time(event_time)}, {"coalesced", missed > 0}, {"missedOccurrences", static_cast<double>(missed)},
        {"sourceEventKey", key}, {"automaticActions", delivery == "authorized_work"}});
}

void ProactiveReminderService::tick() {
    const auto time = now();
    const bool quiet = options_.do_not_disturb && options_.do_not_disturb();
    std::vector<Json> pending;
    {
        std::lock_guard lock(mutex_);
        auto next = document_;
        bool changed = false;
        for (auto& rule : next.at("rules").as_array()) {
            if (!boolean(rule, "enabled") || text(rule, "status") != "active") continue;
            if (number(rule, "endAt") > 0 && number(rule, "endAt") <= time) {
                complete(rule, "已到达结束时间，规则停止"); changed = true; continue;
            }
            const auto kind = text(rule, "kind");
            if (kind != "interval" && kind != "project_watch") continue;
            const auto next_time = static_cast<std::int64_t>(number(rule, "nextTriggerAt"));
            if (next_time <= 0 || time < next_time) continue;
            const auto interval = static_cast<std::int64_t>(number(rule, "intervalMinutes")) * 60000;
            const auto missed = interval > 0 ? (time - next_time) / interval : 0;

            std::string dynamic_detail;
            bool should_stay_silent = false;
            if (kind == "project_watch" && options_.inspect_project) {
                try {
                    const auto proj = text(rule.at("scope"), "projectPath");
                    const auto prev_digest = text(rule, "lastSnapshotDigest");
                    const auto snap = options_.inspect_project(proj, prev_digest);
                    const auto new_digest = text(snap, "digest");
                    if (prev_digest.empty()) {
                        rule["lastSnapshotDigest"] = new_digest;
                        should_stay_silent = true;
                        rule["lastReason"] = "已记录项目初始基线，等待后续新变化";
                    } else if (!boolean(snap, "changed") || new_digest == prev_digest) {
                        should_stay_silent = true;
                        rule["silentCheckCount"] = number(rule, "silentCheckCount") + 1;
                        rule["lastReason"] = "项目无实质新变化，保持安静（不扣预算）";
                    } else {
                        rule["lastSnapshotDigest"] = new_digest;
                        dynamic_detail = text(snap, "summary");
                    }
                } catch (const std::exception& err) {
                    complete(rule, std::string("项目巡检受阻已安全停止：") + err.what());
                    changed = true;
                    continue;
                }
            }
            if (!should_stay_silent && boolean(rule, "dynamicSummary") && options_.dynamic_progress) {
                try {
                    const auto prev_prog = text(rule, "lastProgressDigest");
                    const auto prog = options_.dynamic_progress(rule.at("scope"), prev_prog);
                    const auto new_prog = text(prog, "digest");
                    if (!prev_prog.empty() && new_prog == prev_prog && kind == "interval") {
                        should_stay_silent = true;
                        rule["silentCheckCount"] = number(rule, "silentCheckCount") + 1;
                        rule["lastReason"] = "任务进度无新变化，保持安静（不扣预算）";
                    } else {
                        rule["lastProgressDigest"] = new_prog;
                        const auto summary = text(prog, "summary");
                        if (!summary.empty()) {
                            if (!dynamic_detail.empty()) dynamic_detail += "\n";
                            dynamic_detail += summary;
                        }
                    }
                } catch (...) {}
            }

            if (!should_stay_silent) {
                if (quiet) {
                    rule["skippedCount"] = number(rule, "skippedCount") + 1;
                    rule["lastReason"] = "免打扰期间已丢弃本次提醒，不补播";
                } else {
                    mark_trigger(rule, time, missed, {}, dynamic_detail);
                    auto delivery_copy = rule;
                    if (!dynamic_detail.empty()) delivery_copy["_dynamicDetail"] = dynamic_detail;
                    pending.push_back(O{{"rule", std::move(delivery_copy)}, {"eventTime", static_cast<double>(time)},
                        {"missed", static_cast<double>(missed)}, {"eventKey", ""}});
                }
            }
            if (text(rule, "status") == "active") rule["nextTriggerAt"] = static_cast<double>(time + interval);
            changed = true;
        }
        if (!changed) return;
        AtomicWriteOptions write; write.existing_root = storage_file_.parent_path();
        atomic_write_file(storage_file_, next.dump(), write);
        document_ = std::move(next);
    }
    for (const auto& item : pending) {
        const auto& rule_value = item.at("rule");
        deliver(rule_value, static_cast<std::int64_t>(number(item, "eventTime")),
            static_cast<std::int64_t>(number(item, "missed")), text(item, "eventKey"));
    }
}

void ProactiveReminderService::observe(const Json& event) {
    const auto key = event_key(event);
    if (key.empty()) return;
    const auto time = now();
    const bool quiet = options_.do_not_disturb && options_.do_not_disturb();
    const auto type = text(event, "type");
    std::vector<Json> pending;
    {
        std::lock_guard lock(mutex_);
        auto next = document_;
        bool changed = false;
        for (auto& rule : next.at("rules").as_array()) {
            if (!boolean(rule, "enabled") || text(rule, "status") != "active" || text(rule, "kind") != "condition") continue;
            if (number(rule, "endAt") > 0 && number(rule, "endAt") <= time) {
                complete(rule, "已到达结束时间，规则停止"); changed = true; continue;
            }
            if (!scope_matches(rule, event) || seen(rule, key)) continue;
            const auto trigger = text(rule, "eventType") == type;
            const auto ending = text(rule, "endEventType") == type;
            if (!trigger && !ending) continue;
            remember(rule, key); changed = true;
            if (trigger) {
                if (quiet) {
                    rule["skippedCount"] = number(rule, "skippedCount") + 1;
                    rule["lastReason"] = "免打扰期间已丢弃匹配事件，不补播";
                } else {
                    mark_trigger(rule, time, 0, key);
                    pending.push_back(O{{"rule", rule}, {"eventTime", static_cast<double>(time)},
                        {"missed", 0}, {"eventKey", key}});
                }
            }
            if (ending && text(rule, "status") == "active") complete(rule, "已满足结束条件，规则停止");
        }
        if (!changed) return;
        AtomicWriteOptions write; write.existing_root = storage_file_.parent_path();
        atomic_write_file(storage_file_, next.dump(), write);
        document_ = std::move(next);
    }
    for (const auto& item : pending)
        deliver(item.at("rule"), static_cast<std::int64_t>(number(item, "eventTime")), 0, text(item, "eventKey"));
}

} // namespace dimension
