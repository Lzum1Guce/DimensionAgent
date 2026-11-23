#include "dimension/work_templates.hpp"

#include "dimension/atomic_file.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <set>
#include <sstream>
#include <utility>

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>

namespace dimension {
namespace {
using O = Json::Object;
using A = Json::Array;
namespace fs = std::filesystem;

constexpr std::size_t max_templates = 200;
constexpr std::size_t max_receipts = 128;
constexpr std::size_t max_name_bytes = 240;
constexpr std::size_t max_description_bytes = 4000;
constexpr std::size_t max_body_bytes = 65536;
constexpr std::size_t max_file_bytes = 32U * 1024U * 1024U;

[[noreturn]] void fail(int status, const char* message) {
    throw WorkTemplateError(status, message);
}

std::string random_id() {
    std::array<unsigned char, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        fail(500, "无法生成模板编号");
    std::ostringstream out;
    for (const auto byte : bytes)
        out << std::hex << std::setfill('0') << std::setw(2) << static_cast<int>(byte);
    return out.str();
}

std::string digest(const std::string& bytes) {
    std::array<BYTE, 32> hash{};
    DWORD size = static_cast<DWORD>(hash.size());
    if (!CryptHashCertificate2(BCRYPT_SHA256_ALGORITHM, 0, nullptr,
                               reinterpret_cast<const BYTE*>(bytes.data()),
                               static_cast<DWORD>(bytes.size()), hash.data(), &size))
        fail(500, "无法计算模板请求指纹");
    std::ostringstream out;
    for (const auto byte : hash)
        out << std::hex << std::setfill('0') << std::setw(2) << static_cast<int>(byte);
    return out.str();
}

std::string iso_now() {
    using namespace std::chrono;
    const auto time = system_clock::now();
    const auto milliseconds = duration_cast<std::chrono::milliseconds>(time.time_since_epoch()) % 1000;
    const std::time_t stamp = system_clock::to_time_t(time);
    std::tm utc{};
    if (gmtime_s(&utc, &stamp) != 0) fail(500, "无法记录模板时间");
    std::ostringstream out;
    out << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.'
        << std::setfill('0') << std::setw(3) << milliseconds.count() << 'Z';
    return out.str();
}

std::string read_file(const fs::path& path) {
    std::error_code error;
    const auto size = fs::file_size(path, error);
    if (error) fail(500, "无法读取任务模板");
    if (size > max_file_bytes) fail(413, "任务模板文件超过上限");
    std::ifstream input(path, std::ios::binary);
    if (!input) fail(500, "无法打开任务模板");
    std::string bytes(static_cast<std::size_t>(size), '\0');
    input.read(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    if (!input && !bytes.empty()) fail(500, "任务模板读取不完整");
    return bytes;
}

const std::string& required_string(const Json& object, std::string_view key) {
    const auto* value = object.find(key);
    if (!value || !value->is_string()) fail(400, "模板字段类型无效");
    return value->as_string();
}

void exact_fields(const Json& input, const std::set<std::string>& allowed,
                  const std::set<std::string>& required) {
    if (!input.is_object()) fail(400, "模板请求必须是对象");
    for (const auto& [key, value] : input.as_object()) {
        (void)value;
        if (!allowed.contains(key)) fail(400, "模板只能保存名称、说明、范围和任务正文");
    }
    for (const auto& key : required)
        if (!input.find(key)) fail(400, "模板请求缺少必要字段");
}

std::string request_id(const Json& input) {
    const auto& id = required_string(input, "requestId");
    if (id.empty() || id.size() > 128) fail(400, "模板请求编号无效");
    return id;
}

std::int64_t revision(const Json& input) {
    const auto* value = input.find("revision");
    if (!value || !value->is_number() || !std::isfinite(value->as_number()) ||
        value->as_number() < 1 || value->as_number() > 9007199254740991.0 ||
        std::floor(value->as_number()) != value->as_number())
        fail(400, "模板版本号无效");
    return static_cast<std::int64_t>(value->as_number());
}

Json validated_template(Json value) {
    exact_fields(value, {"id", "name", "description", "scope", "body", "revision", "createdAt", "updatedAt"},
                 {"id", "name", "description", "scope", "body", "revision", "createdAt", "updatedAt"});
    const auto& id = required_string(value, "id");
    if (id.size() != 32 || !std::all_of(id.begin(), id.end(), [](unsigned char c) {
            return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        })) fail(500, "持久化模板编号无效");
    const auto& name = required_string(value, "name");
    const auto& description = required_string(value, "description");
    const auto& scope = required_string(value, "scope");
    const auto& body = required_string(value, "body");
    if (name.empty() || name.size() > max_name_bytes ||
        name.find_first_not_of(" \t\r\n") == std::string::npos)
        fail(400, "模板名称不能为空或超过240字节");
    if (description.size() > max_description_bytes) fail(413, "模板说明超过4000字节");
    if (scope != "private" && scope != "group") fail(400, "模板范围只能是private或group");
    if (body.empty() || body.size() > max_body_bytes ||
        body.find_first_not_of(" \t\r\n") == std::string::npos)
        fail(400, "任务正文不能为空或超过65536字节");
    (void)revision(value);
    (void)required_string(value, "createdAt");
    (void)required_string(value, "updatedAt");
    return value;
}

Json new_content(const Json& input) {
    exact_fields(input, {"name", "description", "scope", "body", "requestId"},
                 {"name", "description", "scope", "body", "requestId"});
    return O{{"name", required_string(input, "name")},
             {"description", required_string(input, "description")},
             {"scope", required_string(input, "scope")},
             {"body", required_string(input, "body")}};
}

Json find_template(Json& state, const std::string& id) {
    auto& rows = state.at("templates").as_array();
    const auto found = std::find_if(rows.begin(), rows.end(), [&](const Json& row) {
        return row.at("id").as_string() == id;
    });
    if (found == rows.end()) fail(404, "任务模板不存在");
    return *found;
}

Json receipt_response(const Json& state, const std::string& id, const std::string& fingerprint,
                      bool& duplicate) {
    duplicate = false;
    const auto& receipts = state.at("receipts").as_object();
    const auto found = receipts.find(id);
    if (found == receipts.end()) return Json{};
    if (found->second.at("digest").as_string() != fingerprint)
        fail(409, "请求编号已用于不同的模板操作");
    duplicate = true;
    return found->second.at("response");
}

void add_receipt(Json& state, const std::string& id, const std::string& fingerprint,
                 const Json& response) {
    auto receipts = state.at("receipts").as_object();
    receipts[id] = O{{"digest", fingerprint}, {"response", response}};
    while (receipts.size() > max_receipts) receipts.erase(receipts.begin());
    auto root = state.as_object(); root["receipts"] = std::move(receipts); state = Json(std::move(root));
}

void commit(const fs::path& file, Json& state, Json next) {
    const auto bytes = next.dump();
    if (bytes.size() > max_file_bytes) fail(413, "任务模板总容量已满");
    atomic_write_file(file, bytes);
    state = std::move(next);
}

} // namespace

WorkTemplates::WorkTemplates(fs::path root)
    : file_(fs::absolute(root / L"templates.json").lexically_normal()),
      state_(O{{"format", "dimension-work-templates"}, {"version", 1}, {"templates", A{}}, {"receipts", O{}}}) {
    std::error_code error;
    if (!fs::exists(file_, error)) {
        if (error) fail(500, "无法检查任务模板存储");
        return;
    }
    state_ = Json::parse(read_file(file_), max_file_bytes);
    exact_fields(state_, {"format", "version", "templates", "receipts"},
                 {"format", "version", "templates", "receipts"});
    if (required_string(state_, "format") != "dimension-work-templates" ||
        !state_.at("version").is_number() || state_.at("version").as_number() != 1 ||
        !state_.at("templates").is_array() || !state_.at("receipts").is_object())
        fail(500, "任务模板存储格式无效");
    auto rows = state_.at("templates").as_array();
    if (rows.size() > max_templates) fail(413, "任务模板数量超过上限");
    std::set<std::string> ids;
    for (auto& row : rows) {
        row = validated_template(std::move(row));
        if (!ids.insert(row.at("id").as_string()).second) fail(500, "任务模板编号重复");
    }
    auto document = state_.as_object(); document["templates"] = std::move(rows); state_ = Json(std::move(document));
    const auto& receipts = state_.at("receipts").as_object();
    if (receipts.size() > max_receipts) fail(500, "模板请求收据超过上限");
    for (const auto& [id, receipt] : receipts) {
        if (id.empty() || id.size() > 128 || !receipt.is_object() || receipt.as_object().size() != 2 ||
            !receipt.find("digest") || !receipt.at("digest").is_string() ||
            receipt.at("digest").as_string().size() != 64 || !receipt.find("response"))
            fail(500, "模板请求收据无效");
    }
}

Json WorkTemplates::list() const {
    std::lock_guard lock(mutex_);
    return state_.at("templates");
}

Json WorkTemplates::get(const std::string& id) const {
    std::lock_guard lock(mutex_);
    auto copy = state_;
    return find_template(copy, id);
}

WorkTemplateMutation WorkTemplates::create(const Json& input) {
    const auto content = new_content(input);
    const auto request = request_id(input);
    const auto fingerprint = digest("create\n" + content.dump());
    std::lock_guard lock(mutex_);
    bool duplicate = false;
    if (auto prior = receipt_response(state_, request, fingerprint, duplicate); duplicate)
        return {std::move(prior), true};
    auto next = state_;
    auto rows = next.at("templates").as_array();
    if (rows.size() >= max_templates) fail(413, "最多保存200个任务模板");
    const auto now = iso_now();
    std::string id;
    do { id = random_id(); } while (std::any_of(rows.begin(), rows.end(), [&](const Json& row) {
        return row.at("id").as_string() == id;
    }));
    auto value = content.as_object();
    value["id"] = id; value["revision"] = 1; value["createdAt"] = now; value["updatedAt"] = now;
    auto saved = validated_template(Json(std::move(value)));
    rows.push_back(saved);
    auto root = next.as_object(); root["templates"] = std::move(rows); next = Json(std::move(root));
    Json response = O{{"template", saved}};
    add_receipt(next, request, fingerprint, response);
    commit(file_, state_, std::move(next));
    return {std::move(response), false};
}

WorkTemplateMutation WorkTemplates::update(const std::string& id, const Json& input) {
    exact_fields(input, {"name", "description", "scope", "body", "requestId", "revision"},
                 {"name", "description", "scope", "body", "requestId", "revision"});
    Json content = O{{"name", required_string(input, "name")},
                     {"description", required_string(input, "description")},
                     {"scope", required_string(input, "scope")},
                     {"body", required_string(input, "body")}};
    const auto expected = revision(input);
    const auto request = request_id(input);
    const auto fingerprint = digest("update\n" + id + "\n" + std::to_string(expected) + "\n" + content.dump());
    std::lock_guard lock(mutex_);
    bool duplicate = false;
    if (auto prior = receipt_response(state_, request, fingerprint, duplicate); duplicate)
        return {std::move(prior), true};
    auto next = state_;
    auto rows = next.at("templates").as_array();
    const auto found = std::find_if(rows.begin(), rows.end(), [&](const Json& row) {
        return row.at("id").as_string() == id;
    });
    if (found == rows.end()) fail(404, "任务模板不存在");
    if (revision(*found) != expected) fail(409, "模板已被其他窗口修改，请重新加载");
    if (expected == 9007199254740991LL) fail(409, "模板版本号已用尽");
    auto value = content.as_object();
    value["id"] = id; value["revision"] = static_cast<double>(expected + 1);
    value["createdAt"] = found->at("createdAt"); value["updatedAt"] = iso_now();
    auto saved = validated_template(Json(std::move(value)));
    *found = saved;
    auto root = next.as_object(); root["templates"] = std::move(rows); next = Json(std::move(root));
    Json response = O{{"template", saved}};
    add_receipt(next, request, fingerprint, response);
    commit(file_, state_, std::move(next));
    return {std::move(response), false};
}

WorkTemplateMutation WorkTemplates::erase(const std::string& id, const Json& input) {
    exact_fields(input, {"requestId", "revision"}, {"requestId", "revision"});
    const auto expected = revision(input);
    const auto request = request_id(input);
    const auto fingerprint = digest("delete\n" + id + "\n" + std::to_string(expected));
    std::lock_guard lock(mutex_);
    bool duplicate = false;
    if (auto prior = receipt_response(state_, request, fingerprint, duplicate); duplicate)
        return {std::move(prior), true};
    auto next = state_;
    auto rows = next.at("templates").as_array();
    const auto found = std::find_if(rows.begin(), rows.end(), [&](const Json& row) {
        return row.at("id").as_string() == id;
    });
    if (found == rows.end()) fail(404, "任务模板不存在");
    if (revision(*found) != expected) fail(409, "模板已被其他窗口修改，请重新加载");
    rows.erase(found);
    auto root = next.as_object(); root["templates"] = std::move(rows); next = Json(std::move(root));
    Json response = O{{"id", id}, {"deleted", true}};
    add_receipt(next, request, fingerprint, response);
    commit(file_, state_, std::move(next));
    return {std::move(response), false};
}

} // namespace dimension
