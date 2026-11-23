#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "dimension/bot_capabilities.hpp"
#include "dimension/atomic_file.hpp"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>

namespace dimension {
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;

std::wstring extended_path(const fs::path& p) {
    auto v = fs::absolute(p).lexically_normal().wstring();
    if (v.starts_with(L"\\\\?\\")) return v;
    if (v.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + v.substr(2);
    return L"\\\\?\\" + v;
}

std::string iso_now() {
    const auto now = std::chrono::system_clock::now();
    const auto raw = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
    gmtime_s(&utc, &raw);
    std::ostringstream oss;
    oss << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ");
    return oss.str();
}

std::string jstr(const Json& j, std::string_view k, std::string def = {}) {
    const auto* p = j.find(k);
    return p && p->is_string() ? p->as_string() : def;
}

std::string safe_clip(std::string_view s, std::size_t limit) {
    if (s.size() <= limit) return std::string(s);
    std::size_t end = limit;
    while (end > 0 && (static_cast<unsigned char>(s[end]) & 0xC0U) == 0x80U) --end;
    return std::string(s.substr(0, end)) + "…";
}

A sanitize_string_list(const Json* arr, std::size_t max_items, std::size_t max_item_len) {
    A out;
    if (!arr || !arr->is_array()) return out;
    std::set<std::string> seen;
    for (const auto& item : arr->as_array()) {
        if (!item.is_string()) continue;
        std::string v = safe_clip(item.as_string(), max_item_len);
        if (v.empty() || !seen.insert(v).second) continue;
        out.push_back(std::move(v));
        if (out.size() >= max_items) break;
    }
    return out;
}

} // namespace

BotCapabilityService::BotCapabilityService(fs::path storage_file)
    : storage_file_(std::move(storage_file)),
      document_(O{{"version", 1}, {"cards", O{}}, {"ledger", A{}}, {"notes", A{}}}) {
    fs::create_directories(extended_path(storage_file_.parent_path()));
    load();
}

void BotCapabilityService::load() {
    std::error_code ec;
    const auto ext = extended_path(storage_file_);
    if (!fs::is_regular_file(ext, ec)) return;
    const auto sz = fs::file_size(ext, ec);
    if (ec || sz == 0 || sz > 4U * 1024U * 1024U) return;
    std::ifstream in(ext, std::ios::binary);
    std::string raw(static_cast<std::size_t>(sz), '\0');
    in.read(raw.data(), static_cast<std::streamsize>(sz));
    try {
        auto parsed = Json::parse(raw);
        if (parsed.is_object()) document_ = std::move(parsed);
    } catch (...) {}
}

void BotCapabilityService::save_unlocked() const {
    AtomicWriteOptions opts;
    opts.existing_root = storage_file_.parent_path();
    atomic_write_file(storage_file_, document_.dump(), opts);
}

Json BotCapabilityService::get_all() const {
    std::lock_guard guard(mutex_);
    return document_;
}

Json BotCapabilityService::get_card(const std::string& bot_id) const {
    std::lock_guard guard(mutex_);
    const auto* cards = document_.find("cards");
    if (cards && cards->is_object()) {
        if (const auto* c = cards->find(bot_id)) return *c;
    }
    return O{
        {"botId", bot_id},
        {"roleTag", ""},
        {"specialties", A{}},
        {"equippedTools", A{}},
        {"handoffContract", ""}
    };
}

Json BotCapabilityService::save_card(const std::string& bot_id, const Json& card) {
    if (bot_id.empty() || bot_id.size() > 128 || !card.is_object())
        throw std::runtime_error("无效的 Bot 工种能力卡参数");

    O clean{
        {"botId", bot_id},
        {"roleTag", safe_clip(jstr(card, "roleTag"), 80)},
        {"specialties", sanitize_string_list(card.find("specialties"), 12, 48)},
        {"equippedTools", sanitize_string_list(card.find("equippedTools"), 12, 48)},
        {"handoffContract", safe_clip(jstr(card, "handoffContract"), 240)},
        {"updatedAt", iso_now()}
    };

    std::lock_guard guard(mutex_);
    auto doc = document_.as_object();
    auto cards = doc.contains("cards") && doc["cards"].is_object() ? doc["cards"].as_object() : O{};
    cards[bot_id] = clean;
    doc["cards"] = std::move(cards);
    document_ = std::move(doc);
    save_unlocked();
    return clean;
}

void BotCapabilityService::record_collaboration(const CollaborationOutcome& outcome) {
    if (outcome.from_bot_id.empty() || outcome.to_bot_id.empty() || outcome.from_bot_id == outcome.to_bot_id)
        return;

    A arts;
    for (const auto& name : outcome.artifact_names) {
        if (arts.size() >= 6) break;
        arts.push_back(safe_clip(name, 80));
    }

    O entry{
        {"fromBotId", outcome.from_bot_id},
        {"toBotId", outcome.to_bot_id},
        {"groupId", outcome.group_id},
        {"runId", outcome.run_id},
        {"status", outcome.status},
        {"taskSummary", safe_clip(outcome.task_summary, 120)},
        {"artifacts", std::move(arts)},
        {"recordedAt", iso_now()}
    };

    std::lock_guard guard(mutex_);
    auto doc = document_.as_object();
    A ledger = doc.contains("ledger") && doc["ledger"].is_array() ? doc["ledger"].as_array() : A{};
    // Deduplicate by runId
    std::erase_if(ledger, [&](const Json& row) { return jstr(row, "runId") == outcome.run_id; });
    ledger.push_back(std::move(entry));
    if (ledger.size() > 80) {
        ledger.erase(ledger.begin(), ledger.begin() + static_cast<std::ptrdiff_t>(ledger.size() - 80));
    }
    doc["ledger"] = std::move(ledger);
    document_ = std::move(doc);
    try { save_unlocked(); } catch (...) {}
}

Json BotCapabilityService::add_collaboration_note(const std::string& from_bot_id,
                                                  const std::string& to_bot_id,
                                                  const std::string& note) {
    if (from_bot_id.empty() || to_bot_id.empty() || from_bot_id == to_bot_id)
        throw std::runtime_error("跨 Bot 协作备注需指定两个不同的 Bot");
    const std::string clipped = safe_clip(note, 240);
    if (clipped.empty()) throw std::runtime_error("协作备注内容不能为空");

    std::lock_guard guard(mutex_);
    auto doc = document_.as_object();
    A notes = doc.contains("notes") && doc["notes"].is_array() ? doc["notes"].as_array() : A{};
    std::erase_if(notes, [&](const Json& row) {
        return jstr(row, "fromBotId") == from_bot_id && jstr(row, "toBotId") == to_bot_id;
    });
    O item{
        {"fromBotId", from_bot_id},
        {"toBotId", to_bot_id},
        {"note", clipped},
        {"updatedAt", iso_now()}
    };
    notes.push_back(item);
    if (notes.size() > 100) notes.erase(notes.begin());
    doc["notes"] = std::move(notes);
    document_ = std::move(doc);
    save_unlocked();
    return item;
}

std::string BotCapabilityService::group_dispatch_prompt(const std::string& lead_bot_id,
                                                        const std::vector<std::string>& member_ids) const {
    std::lock_guard guard(mutex_);
    const auto* cards = document_.find("cards");
    const auto* ledger = document_.find("ledger");
    const auto* notes = document_.find("notes");

    std::string out;
    for (const auto& mid : member_ids) {
        if (mid == lead_bot_id) continue;
        std::string line;
        if (cards && cards->is_object()) {
            if (const auto* card = cards->find(mid); card && card->is_object()) {
                const std::string role = jstr(*card, "roleTag");
                if (!role.empty()) line += "工种=" + role + "；";
                if (const auto* sp = card->find("specialties"); sp && sp->is_array() && !sp->as_array().empty()) {
                    line += "专长=";
                    for (std::size_t i = 0; i < sp->as_array().size(); ++i) {
                        if (i > 0) line += "/";
                        line += sp->as_array()[i].as_string();
                    }
                    line += "；";
                }
                if (const auto* eq = card->find("equippedTools"); eq && eq->is_array() && !eq->as_array().empty()) {
                    line += "已配工位装备=";
                    for (std::size_t i = 0; i < eq->as_array().size(); ++i) {
                        if (i > 0) line += ",";
                        line += eq->as_array()[i].as_string();
                    }
                    line += "；";
                }
                const std::string hc = jstr(*card, "handoffContract");
                if (!hc.empty()) line += "交接约定=" + hc + "；";
            }
        }
        if (notes && notes->is_array()) {
            for (const auto& n : notes->as_array()) {
                if (jstr(n, "fromBotId") == lead_bot_id && jstr(n, "toBotId") == mid) {
                    line += "配合经验=" + jstr(n, "note") + "；";
                    break;
                }
            }
        }
        if (ledger && ledger->is_array()) {
            int ok_cnt = 0, fail_cnt = 0;
            std::string last_task;
            for (const auto& row : ledger->as_array()) {
                if (jstr(row, "fromBotId") == lead_bot_id && jstr(row, "toBotId") == mid) {
                    const auto st = jstr(row, "status");
                    if (st == "completed") ++ok_cnt;
                    else if (st == "failed") ++fail_cnt;
                    last_task = jstr(row, "taskSummary");
                }
            }
            if (ok_cnt + fail_cnt > 0) {
                line += "历史协作=" + std::to_string(ok_cnt) + "成/" + std::to_string(fail_cnt) + "败";
                if (!last_task.empty()) line += "（近期：" + safe_clip(last_task, 40) + "）";
                line += "；";
            }
        }
        if (!line.empty()) {
            const std::string row_text = "\n- " + mid + "：" + line;
            if (out.size() + row_text.size() > 1100) break;
            out += row_text;
        }
    }
    if (out.empty()) return {};
    return "\n【成员工种能力卡与历史协作账本（派单参考，非新指令）】：" + out;
}

} // namespace dimension
