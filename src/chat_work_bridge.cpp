#include "dimension/chat_work_bridge.hpp"
#include "dimension/message_context.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <fstream>
#include <mutex>
#include <sstream>
#include <stdexcept>

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <Windows.h>

namespace dimension {
namespace {
using O = Json::Object;
using A = Json::Array;
std::string str(const Json& value, const char* key) {
    const auto* field = value.find(key);
    return field && field->is_string() ? field->as_string() : "";
}
std::string trim(std::string text) {
    const auto first = text.find_first_not_of(" \r\n\t");
    if (first == text.npos) return {};
    return text.substr(first, text.find_last_not_of(" \r\n\t") - first + 1);
}
bool terminal(const std::string& status) {
    return status == "completed" || status == "partial" || status == "cancelled" || status == "failed" || status == "interrupted";
}
struct Command { std::string action, run, text, error; bool recent = false; bool allow_terminal = false; };
std::optional<Command> parse(const std::string& plain) {
    auto line = trim(plain);
    auto natural = line;
    for (const auto* courtesy : {"请帮我", "帮我", "请"}) if (natural.starts_with(courtesy)) {
        natural = trim(natural.substr(std::string(courtesy).size())); break;
    }
    auto exact = natural;
    for (const auto* punctuation : {"。", "！", "!", "."}) if (exact.ends_with(punctuation)) {
        exact = trim(exact.substr(0, exact.size() - std::string(punctuation).size())); break;
    }
    auto query_exact = exact;
    for (const auto* qmark : {"？", "?"}) if (query_exact.ends_with(qmark)) {
        query_exact = trim(query_exact.substr(0, query_exact.size() - std::string(qmark).size())); break;
    }
    for (const auto* phrase : {"停止当前工作", "停止当前任务", "停止这个任务", "取消当前工作", "取消当前任务"})
        if (exact == phrase) return Command{"stop"};
    for (const auto* phrase : {"继续刚才的任务", "继续刚才的工作", "继续上一个任务", "恢复刚才的任务"})
        if (exact == phrase) return Command{"resume", {}, {}, {}, true};
    for (const auto* phrase : {"查看当前工作", "查看工作状态", "查看任务进度", "看看任务进度", "看看工作进度",
        "当前工作进展怎么样", "当前工作怎么样", "工作进行到哪了", "现在任务做到哪了", "现在工作做到哪了",
        "任务进行得怎么样了", "后台工作怎么样了", "后台任务怎么样了", "工作进度怎么样", "任务进度怎么样"})
        if (query_exact == phrase) return Command{"status"};
    for (const auto* phrase : {"开始新任务", "创建新任务", "新建工作任务", "另开新任务"}) {
        const auto prefix = std::string(phrase);
        for (const auto* colon : {"：", ":"}) if (natural.starts_with(prefix + colon)) {
            auto text = trim(natural.substr(prefix.size() + std::string(colon).size()));
            return Command{"new", {}, text, text.empty() ? "新任务内容不能为空。" : ""};
        }
    }
    for (const auto* phrase : {"给当前任务补充要求", "给当前工作补充要求", "补充当前任务", "补充当前工作",
        "顺便给当前任务补充", "再给当前任务加一条", "当前任务补充"}) {
        const auto prefix = std::string(phrase);
        for (const auto* colon : {"：", ":"}) if (natural.starts_with(prefix + colon)) {
            auto text = trim(natural.substr(prefix.size() + std::string(colon).size()));
            return Command{"add", {}, text, text.empty() ? "补充要求不能为空。" : ""};
        }
    }
    for (const auto* phrase : {"评估任务变更", "评估当前任务变更", "预览任务变更", "先看变更影响"}) {
        const auto prefix = std::string(phrase);
        for (const auto* colon : {"：", ":"}) if (natural.starts_with(prefix + colon)) {
            auto text = trim(natural.substr(prefix.size() + std::string(colon).size()));
            return Command{"preview_change", {}, text, text.empty() ? "待评估的变更内容不能为空。" : "", false, true};
        }
    }
    // Only an anchored declarative command is a change authorization. Questions
    // such as “能否修改当前任务？” and unrelated prose stay in ordinary Chat.
    for (const auto* phrase : {"变更当前任务", "修改当前任务", "变更当前工作", "修改当前工作",
        "推翻当前任务已执行步骤", "更改当前任务已执行步骤"}) {
        const auto prefix = std::string(phrase);
        for (const auto* colon : {"：", ":"}) if (natural.starts_with(prefix + colon)) {
            auto text = trim(natural.substr(prefix.size() + std::string(colon).size()));
            return Command{"change", {}, text, text.empty() ? "变更内容不能为空。" : "", false, true};
        }
    }
    for (const auto* phrase : {"停止任务 ", "取消任务 ", "继续任务 ", "恢复任务 "}) {
        if (!exact.starts_with(phrase)) continue;
        const auto action = std::string(phrase).starts_with("停止") || std::string(phrase).starts_with("取消") ? "stop" : "resume";
        line = "/work " + std::string(action) + " " + trim(exact.substr(std::string(phrase).size()));
        break;
    }
    const auto first = line.find_first_of(" \t\r\n");
    const auto prefix = line.substr(0, first);
    if (prefix != "/work" && prefix != "/工作") return {};
    Command result;
    auto tail = first == line.npos ? std::string{} : trim(line.substr(first));
    const auto action_end = tail.find_first_of(" \t\r\n");
    result.action = tail.substr(0, action_end);
    if (result.action == "状态") result.action = "status";
    if (result.action == "停止") result.action = "stop";
    if (result.action == "补充") result.action = "add";
    if (result.action == "变更" || result.action == "修改") result.action = "change";
    if (result.action == "评估变更" || result.action == "preview-change") result.action = "preview_change";
    if (result.action == "继续") result.action = "resume";
    if (result.action == "新建") result.action = "new";
    if (result.action == "change" || result.action == "preview_change") result.allow_terminal = true;
    tail = action_end == tail.npos ? std::string{} : trim(tail.substr(action_end));
    if (result.action == "status" || result.action == "stop") result.run = tail;
    else if (result.action == "add" || result.action == "change" || result.action == "preview_change" || result.action == "resume" || result.action == "new") {
        const auto separator = tail.find("--");
        if (separator == tail.npos) result.run = tail;
        else {
            result.run = trim(tail.substr(0, separator));
            result.text = trim(tail.substr(separator + 2));
            if (separator && tail[separator - 1] != ' ' && tail[separator - 1] != '\t')
                result.error = "参数分隔符 -- 前需有空格。";
        }
        if (result.action == "add" && result.text.empty()) result.error = "补充需使用 /work add [runId] -- 内容。";
        if (result.action == "change" && result.text.empty()) result.error = "变更需使用 /work change [runId] -- 内容。";
        if (result.action == "preview_change" && result.text.empty()) result.error = "评估变更需使用 /work preview-change [runId] -- 内容。";
        if (result.action == "new" && result.text.empty()) result.error = "新任务需使用 /work new -- 内容。";
        if (result.action == "resume" && result.run.empty()) result.error = "继续需指定已有任务：/work resume runId [-- 内容]。";
    } else result.error = "可用命令：/work status [runId]、/work stop [runId]、/work add [runId] -- 内容、/work preview-change [runId] -- 内容、/work change [runId] -- 内容、/work resume runId [-- 内容]、/work new -- 内容。";
    if (!result.run.empty() && (result.run.size() > 128 || !result.run.starts_with("run-") ||
        result.run.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-") != std::string::npos))
        result.error = "任务编号格式无效；请先用 /work status 查看。";
    return result;
}
std::filesystem::path extended(const std::filesystem::path& path) {
    auto value = std::filesystem::absolute(path).wstring();
    if (value.starts_with(L"\\\\?\\")) return value;
    if (value.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + value.substr(2);
    return L"\\\\?\\" + value;
}
void write(const std::filesystem::path& target, const Json& value) {
    static std::atomic_uint64_t serial{};
    const auto temp = target.parent_path() / (L"bridge-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
        std::to_wstring(std::chrono::steady_clock::now().time_since_epoch().count()) + L"-" + std::to_wstring(++serial) + L".tmp");
    const auto bytes = value.dump();
    HANDLE file = CreateFileW(extended(temp).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot create Chat Work receipt");
    DWORD written{};
    const bool ok = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
        written == bytes.size() && FlushFileBuffers(file);
    CloseHandle(file);
    if (!ok || !MoveFileExW(extended(temp).c_str(), extended(target).c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(extended(temp).c_str());
        throw std::runtime_error("Cannot commit Chat Work receipt; control was not confirmed");
    }
}
Json read(const std::filesystem::path& path) {
    const auto size = std::filesystem::file_size(extended(path));
    if (size > 262144) throw std::runtime_error("Chat Work receipt exceeds its bound");
    std::ifstream input(extended(path), std::ios::binary);
    if (!input) throw std::runtime_error("Cannot read Chat Work receipt");
    return Json::parse(std::string(std::istreambuf_iterator<char>(input), {}), 262144);
}
std::string preview(std::string value, std::size_t maximum = 4000) {
    if (value.size() <= maximum) return value;
    auto end = maximum;
    while (end && (static_cast<unsigned char>(value[end]) & 0xc0U) == 0x80U) --end;
    return value.substr(0, end) + "…（展示已截断，完整决定仍保存在 run 中）";
}
std::string change_input(const std::string& decision) {
    return "【最新变更决定】\n" + decision +
        "\n【执行约束】与旧要求冲突时以本决定为准。已执行步骤和既有产物不会被自动撤销；"
        "重新核验受影响的步骤与产物，并保留不受影响的决定、产物及未解决项。";
}
Json bounded_unresolved(const Json& record) {
    A result;
    const auto* items = record.find("unresolvedItems");
    if (!items || !items->is_array()) return result;
    for (const auto& item : items->as_array()) {
        if (result.size() >= 32) break;
        if (!item.is_object()) continue;
        O row{{"kind", preview(str(item, "kind"), 80)}, {"status", preview(str(item, "status"), 80)},
            {"detail", preview(str(item, "detail"), 2000)}};
        if (item.find("key")) row["key"] = preview(str(item, "key"), 256);
        if (item.find("runId")) row["runId"] = preview(str(item, "runId"), 128);
        result.emplace_back(std::move(row));
    }
    return result;
}
Json bounded_decision(const Json& record) {
    const auto* decision = record.find("latestDecision");
    if (!decision || !decision->is_object()) return O{};
    O result{{"text", preview(str(*decision, "text"), 12000)}, {"time", str(*decision, "time")}};
    if (const auto* index = decision->find("inputIndex")) result["inputIndex"] = *index;
    return result;
}
Json change_impact(const Json& record) {
    const auto* artifacts = record.find("artifacts");
    return O{{"previousStatus", str(record, "status")}, {"previousAttempt", record.at("attempt")},
        {"existingArtifactCount", artifacts && artifacts->is_array() ? static_cast<double>(artifacts->as_array().size()) : 0},
        {"supersedesConflictingRequirements", true}, {"completedSideEffectsUndone", false},
        {"existingArtifactsDeleted", false}, {"affectedOutputsRequireReverification", true},
        {"unresolvedItems", bounded_unresolved(record)}};
}
Json run_state(const Json& record) {
    const auto* artifacts = record.find("artifacts");
    return O{{"id", str(record, "id")}, {"botId", str(record, "botId")}, {"groupId", str(record, "groupId")},
        {"status", str(record, "status")}, {"attempt", record.at("attempt")}, {"sequence", record.at("sequence")},
        {"updatedAt", str(record, "updatedAt")}, {"executing", record.at("executing")}, {"terminal", record.at("terminal")},
        {"inputCount", record.at("inputCount")}, {"artifactCount", artifacts && artifacts->is_array() ?
            static_cast<double>(artifacts->as_array().size()) : 0},
        {"latestDecision", bounded_decision(record)}, {"unresolvedItems", bounded_unresolved(record)}};
}
std::string intent(const std::string& action) {
    if (action == "status") return "consultation";
    if (action == "add") return "supplement";
    if (action == "preview_change") return "change_preview";
    if (action == "change") return "change";
    if (action == "new") return "new_task";
    return "control";
}
std::string status_text(const Json& value) {
    std::string text = "当前 Bot 的 Work 状态（直接读取真实 run）：\n";
    const auto append = [&](const Json& row) {
        auto line = str(row, "id") + " · " + str(row, "status") + " · attempt " + row.at("attempt").dump();
        const auto* executing = row.find("executing");
        if (executing && executing->is_bool() && executing->as_bool() && terminal(str(row, "status"))) line += "（回调正在停止）";
        if (!str(row, "groupId").empty()) line += " · 群 " + str(row, "groupId");
        if (const auto* decision = row.find("latestDecision"); decision && decision->is_object())
            line += "\n  最新决定：" + preview(str(*decision, "text"));
        if (const auto* artifacts = row.find("artifacts"); artifacts && artifacts->is_array())
            line += "\n  已保留产物：" + std::to_string(artifacts->as_array().size()) + " 项";
        if (const auto* unresolved = row.find("unresolvedItems"); unresolved && unresolved->is_array() && !unresolved->as_array().empty()) {
            line += "\n  未解决项：";
            for (const auto& item : unresolved->as_array()) line += "\n  - " + preview(str(item, "detail"), 1000);
        }
        return line + '\n';
    };
    if (value.find("id")) return text + append(value);
    for (const auto& row : value.at("active").as_array()) text += append(row);
    for (const auto& row : value.at("recent").as_array()) text += append(row);
    if (value.at("active").as_array().empty() && value.at("recent").as_array().empty()) text += "没有已有任务。";
    return text;
}
}

class ChatWorkBridge::Impl {
public:
    std::filesystem::path root;
    RunService& work;
    InputGuard guard;
    std::mutex mutex;
    HANDLE lock = INVALID_HANDLE_VALUE;
    Impl(std::filesystem::path path, RunService& service, InputGuard input_guard)
        : root(std::move(path)), work(service), guard(std::move(input_guard)) {
        std::filesystem::create_directories(extended(root));
        lock = CreateFileW(extended(root / L"bridge.lock").c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                            nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (lock == INVALID_HANDLE_VALUE) throw std::runtime_error("Chat Work bridge is already open or inaccessible");
    }
    ~Impl() { if (lock != INVALID_HANDLE_VALUE) CloseHandle(lock); }
    Json status(const std::string& bot, const std::string& run) const {
        if (guard) guard(bot, "");
        if (run.empty()) return work.bot_status(bot);
        const auto record = work.brief_json(run);
        if (str(record, "botId") != bot) throw std::invalid_argument("目标任务不属于当前 Bot。");
        if (guard) guard(bot, str(record, "groupId"));
        return record;
    }
    std::optional<ChatWorkReply> handle(const std::string& bot, const std::string& plain,
        const std::string& request, const Json& context) {
        const auto command = parse(plain);
        if (!command) return {};
        if (bot.empty() || bot.size() > 256 || request.empty() || request.size() > 256 || plain.size() > 64000)
            throw std::invalid_argument("Invalid Chat Work request");
        const auto key = source_data_digest(Json(A{bot, request}).dump());
        const auto digest = source_data_digest(Json(O{{"plain", plain}, {"context", context}}).dump());
        std::lock_guard held(mutex);
        const auto path = root / (key + ".json");
        Json receipt;
        if (std::filesystem::exists(extended(path))) {
            receipt = read(path);
            if (str(receipt, "botId") != bot || str(receipt, "requestId") != request || str(receipt, "digest") != digest)
                throw std::invalid_argument("Chat请求编号已绑定不同的工作指令。");
            if (str(receipt, "state") != "bound") return ChatWorkReply{str(receipt, "text"), receipt};
        } else {
            O binding{{"version", 1}, {"kind", "chat-work-bridge"}, {"botId", bot}, {"requestId", request},
                {"digest", digest}, {"action", command->action}, {"intent", intent(command->action)},
                {"runId", command->run}, {"state", "bound"}};
            std::string error = command->error;
            if (error.empty() && command->action != "status" && command->action != "new" && command->run.empty()) {
                A eligible;
                A running;
                const auto snapshot = work.bot_status(bot);
                bool has_private_activity = false;
                for (const auto& row : snapshot.at("active").as_array()) if (str(row, "groupId").empty()) {
                    has_private_activity = true;
                    if (!command->recent) {
                        eligible.push_back(row);
                        const auto* executing = row.find("executing");
                        if (str(row, "status") == "running" || (executing && executing->is_bool() && executing->as_bool())) running.push_back(row);
                    }
                }
                if (!running.empty()) eligible = std::move(running);
                if ((command->recent || command->allow_terminal) && !has_private_activity)
                    eligible = snapshot.at("latestPrivateTerminal").as_array();
                if (eligible.size() == 1) binding["runId"] = str(eligible.front(), "id");
                else {
                    error = (command->recent || command->allow_terminal) && has_private_activity ?
                        "当前已有活动的私聊任务，请先查看状态并明确目标。" :
                        eligible.empty() ? "当前 Bot 没有可明确定位的私聊 Work 任务。" : "当前 Bot 有多个可选任务，请指定 runId：";
                    for (const auto& row : eligible) error += " " + str(row, "id");
                }
            }
            if (error.empty() && !str(binding, "runId").empty()) {
                try {
                    const auto selected = status(bot, str(binding, "runId"));
                    binding["attempt"] = selected.at("attempt");
                    if (command->action == "change" || command->action == "preview_change")
                        binding["impact"] = change_impact(selected);
                } catch (const std::exception& failure) { error = failure.what(); }
            }
            if (!error.empty()) { binding["state"] = "error"; binding["text"] = "Work操作未执行：" + error; }
            receipt = binding;
            write(path, receipt); // Binding becomes durable before any mutation.
            if (!error.empty()) return ChatWorkReply{str(receipt, "text"), receipt};
        }
        auto result = receipt.as_object();
        const auto action = str(receipt, "action"), run_id = str(receipt, "runId");
        result["intent"] = intent(action);
        try {
            Json observed;
            const auto request_key = "chat-work:" + key;
            if (action == "new") {
                if (guard) guard(bot, "");
                // queue=true is essential: unrelated Chat prose and explicit new
                // tasks must never steer or inherit the active private run.
                const auto submission = work.submit(bot, "", command->text, request_key, true, {}, {}, true);
                result["runId"] = submission.run_id;
                observed = work.brief_json(submission.run_id);
            } else {
                const auto record = status(bot, run_id); // Recheck Bot and current group/private permission.
                const bool read_only = action == "status" || action == "preview_change";
                const bool applied = !read_only && action != "stop" && work.request_applied(run_id, request_key);
                if (!read_only && !applied && receipt.find("attempt") &&
                    receipt.at("attempt").dump() != record.at("attempt").dump())
                    throw std::invalid_argument("目标任务已有新的尝试，本条旧请求不会控制新的尝试。");
                if (read_only) observed = record;
                else if (applied) observed = record;
                else if (action == "stop") observed = work.cancel(run_id);
                else {
                    if (guard) guard(bot, str(record, "groupId"));
                    if (action == "add") (void)work.steer(run_id, command->text, request_key);
                    else if (action == "resume") (void)work.resume(run_id, request_key, command->text, {}, 0, true);
                    else if (action == "change") {
                        const auto decision = change_input(command->text);
                        if (terminal(str(record, "status"))) (void)work.resume(run_id, request_key, decision, {}, 0, true);
                        else (void)work.steer(run_id, decision, request_key);
                    } else throw std::invalid_argument("Unsupported persisted Chat Work action");
                    observed = work.brief_json(run_id);
                }
                if (action == "change" || action == "preview_change") {
                    auto impact = receipt.find("impact") ? receipt.at("impact").as_object() : change_impact(record).as_object();
                    impact["statusAfter"] = str(observed, "status"); impact["attemptAfter"] = observed.at("attempt");
                    impact["runId"] = run_id; impact["previewOnly"] = action == "preview_change";
                    result["impact"] = std::move(impact);
                }
            }
            result["state"] = "done";
            if (observed.find("id")) result["run"] = run_state(observed);
            // Store a bounded factual receipt; actual run events remain the
            // authority for all subsequent execution and completion claims.
            auto text = action == "status" ? status_text(observed) :
                action == "new" ? "已创建私聊 Work 新任务：" + str(result, "runId") + "。当前状态：" + str(observed, "status") + "。" :
                action == "preview_change" ? "【任务变更影响预评估（尚未修改任务）】\n目标任务：" + run_id +
                    " · 当前状态：" + str(observed, "status") + " · attempt " + observed.at("attempt").dump() +
                    "\n拟变更内容：" + preview(command->text, 1000) +
                    "\n影响说明：当前已保留 " +
                    std::to_string(static_cast<std::size_t>(result.at("impact").at("existingArtifactCount").as_number())) +
                    " 项产物不会自动删除，已执行的外部副作用不会自动回滚；若提交变更，冲突部分将以新决定为准并重新核验受影响产物。\n"
                    "确认执行请发送：变更当前任务：" + preview(command->text, 500) :
                action == "change" ? "已向 Work 提交变更：" + run_id + "。当前状态：" + str(observed, "status") +
                    "，attempt " + observed.at("attempt").dump() + "。\n变更影响：已有 " +
                    std::to_string(static_cast<std::size_t>(result.at("impact").at("existingArtifactCount").as_number())) +
                    " 项产物保留，已执行的外部副作用不会自动撤销；冲突要求以最新决定为准，受影响产物需重新核验，未解决项继续保留。" :
                "已向 Work 提交" + std::string(action == "stop" ? "停止请求" : action == "add" ? "补充" : "继续请求") +
                "：" + run_id + "。当前状态：" + str(observed, "status") + "。";
            if (text.size() > 12000) {
                std::size_t end = 12000;
                while (end && (static_cast<unsigned char>(text[end]) & 0xc0U) == 0x80U) --end;
                text = text.substr(0, end) + "\n状态过多，请指定 runId 查询。";
            }
            result["text"] = text;
        } catch (const std::exception& error) {
            result["state"] = "error";
            result["text"] = "Work操作未获确认：" + std::string(error.what());
        }
        receipt = result;
        write(path, receipt);
        return ChatWorkReply{str(receipt, "text"), receipt};
    }
};
ChatWorkBridge::ChatWorkBridge(std::filesystem::path root, RunService& work, InputGuard guard)
    : impl_(std::make_unique<Impl>(std::move(root), work, std::move(guard))) {}
ChatWorkBridge::~ChatWorkBridge() = default;
std::optional<ChatWorkReply> ChatWorkBridge::handle(const std::string& bot, const std::string& plain,
    const std::string& request, const Json& context) { return impl_->handle(bot, plain, request, context); }
Json ChatWorkBridge::status(const std::string& bot, const std::string& run) const { return impl_->status(bot, run); }
} // namespace dimension
