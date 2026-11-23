#include "dimension/json.hpp"
#include "dimension/store.hpp"
#include <charconv>
#include <filesystem>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

using dimension::Json;
using dimension::Store;
using dimension::Mode;
using dimension::MemoryState;
using Object = Json::Object;
using Array = Json::Array;

namespace {
std::string text(const Json& request, std::string_view key) {
    return request.at(key).as_string();
}
std::string optional_text(const Json& request, std::string_view key, std::string fallback = {}) {
    const auto* value = request.find(key);
    return value ? value->as_string() : fallback;
}
dimension::Id number_id(const Json& request, std::string_view key) {
    const auto value = text(request, key);
    dimension::Id id{};
    const auto result = std::from_chars(value.data(), value.data() + value.size(), id);
    if (result.ec != std::errc{} || result.ptr != value.data() + value.size() || id < 1)
        throw std::runtime_error("Expected a positive decimal ID in a JSON string");
    return id;
}
std::optional<dimension::Id> before(const Json& request) {
    return request.find("before") ? std::optional(number_id(request, "before")) : std::nullopt;
}
std::size_t page_limit(const Json& request) {
    const auto* value = request.find("limit");
    if (!value) return 30;
    const auto number = value->as_number();
    if (number < 1 || number > 100 || number != static_cast<int>(number))
        throw std::runtime_error("limit must be an integer from 1 through 100");
    return static_cast<std::size_t>(number);
}
Mode mode(const Json& request) {
    const auto value = text(request, "mode");
    if (value == "chat") return Mode::Chat;
    if (value == "work") return Mode::Work;
    throw std::runtime_error("mode must be chat or work");
}
const char* state_name(MemoryState state) {
    switch (state) {
    case MemoryState::Candidate: return "candidate";
    case MemoryState::Confirmed: return "confirmed";
    case MemoryState::Rejected: return "rejected";
    }
    throw std::runtime_error("Invalid memory state");
}
Json encode(const dimension::Bot& bot) {
    return Object{{"id", bot.id}, {"name", bot.name}, {"persona", bot.persona},
                  {"chat", bot.in_chat}, {"work", bot.in_work}};
}
Json encode(const dimension::Memory& memory) {
    return Object{{"id", std::to_string(memory.id)}, {"botId", memory.bot_id},
                  {"groupId", memory.group_id}, {"text", memory.text},
                  {"state", state_name(memory.state)}, {"revision", std::to_string(memory.revision)},
                  {"sourceActor", memory.source_actor}, {"kind", memory.kind},
                  {"eventTimeMs", std::to_string(memory.event_time_ms)}, {"sourceRef", memory.source_ref},
                  {"participants", memory.participants}, {"userChoice", memory.user_choice}, {"outcome", memory.outcome},
                  {"targetBotId", memory.target_bot_id}, {"evidence", memory.evidence},
                  {"applicableScenarios", memory.applicable_scenarios},
                  {"supersedesId", std::to_string(memory.supersedes_id)}};
}
Json encode(const dimension::Message& message) {
    return Object{{"id", std::to_string(message.id)}, {"botId", message.bot_id},
                  {"groupId", message.group_id}, {"mode", message.mode == Mode::Chat ? "chat" : "work"},
                  {"actor", message.actor}, {"text", message.text},
                  {"createdAtMs", std::to_string(message.created_at_ms)}};
}
template<class T> Json encode_list(const std::vector<T>& values) {
    Array rows; rows.reserve(values.size());
    for (const auto& value : values) rows.push_back(encode(value));
    return rows;
}
Json dispatch(Store& store, const Json& request) {
    const auto method = text(request, "method");
    if (method == "info") return Object{{"name", "DimensionAgent native core"}, {"version", "0.4.0"},
        {"phase", 1}, {"language", "C++20"}, {"dataFormat", "sqlite-v4"},
        {"capabilities", Array{"bots", "independent-rosters", "paged-messages", "reviewed-memory"}},
        {"modelExecution", false}, {"automaticDataMigration", false}};
    if (method == "bot.create") return encode(store.create_bot(text(request,"name"), optional_text(request,"persona"), optional_text(request,"botId")));
    if (method == "bot.list") return encode_list(store.list_bots(request.find("mode") ? std::optional(mode(request)) : std::nullopt));
    if (method == "bot.get") {
        const auto bot = store.find_bot(text(request,"botId"));
        return bot ? encode(*bot) : Json();
    }
    if (method == "bot.roster") return encode(store.set_roster(text(request,"botId"), mode(request), request.at("present").as_bool()));
    if (method == "bot.remove") {
        store.remove_bot(text(request,"botId"));
        return Object{{"memoryPreserved",true}, {"identityPreserved",true}};
    }
    if (method == "message.append") return encode(store.append_message(text(request,"botId"), mode(request), text(request,"actor"), text(request,"text"), optional_text(request,"groupId")));
    if (method == "message.list") return encode_list(store.messages(text(request,"botId"), mode(request), optional_text(request,"groupId"), page_limit(request), before(request)));
    if (method == "memory.propose") return encode(store.propose_memory(text(request,"botId"), optional_text(request,"groupId"), text(request,"text"), text(request,"sourceActor")));
    if (method == "memory.get") {
        const auto memory = store.find_memory(number_id(request,"memoryId"));
        return memory ? encode(*memory) : Json();
    }
    if (method == "memory.list") {
        const auto* group = request.find("groupId");
        return encode_list(store.list_memories(text(request,"botId"), group ? std::optional<std::string_view>(group->as_string()) : std::nullopt,
            true, page_limit(request), before(request)));
    }
    if (method == "memory.review") {
        const auto desired = text(request,"state");
        if (desired != "confirmed" && desired != "rejected") throw std::runtime_error("Review state must be confirmed or rejected");
        return encode(store.review_memory(number_id(request,"memoryId"), number_id(request,"revision"),
            desired == "confirmed" ? MemoryState::Confirmed : MemoryState::Rejected));
    }
    if (method == "memory.edit") return encode(store.edit_memory(number_id(request,"memoryId"), number_id(request,"revision"), text(request,"text")));
    if (method == "memory.delete") {
        store.delete_memory(number_id(request,"memoryId"), number_id(request,"revision"));
        return Object{{"deleted",true}};
    }
    if (method == "memory.recall") return encode_list(store.retrieve_memories(text(request,"botId"), optional_text(request,"groupId"), text(request,"query")));
    throw std::runtime_error("Unknown native method");
}
bool read_line(std::string& line, bool& oversized) {
    constexpr std::size_t max = 4u * 1024u * 1024u;
    line.clear(); oversized = false;
    char value; bool any = false;
    while (std::cin.get(value)) {
        any = true;
        if (value == '\n') break;
        if (line.size() < max) line.push_back(value); else oversized = true;
    }
    return any;
}
}

int serve(const std::filesystem::path& database_path) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    try {
        Store store(database_path);
        std::string line; bool oversized;
        while (read_line(line, oversized)) {
            Json request_id;
            try {
                if (oversized) throw std::runtime_error("Request exceeds 4 MiB");
                const auto request = Json::parse(line);
                if (const auto* id = request.find("id")) {
                    if (!id->is_string() && !id->is_number() && !id->is_null()) throw std::runtime_error("Request id must be a string or number");
                    request_id = *id;
                }
                const auto result = dispatch(store, request);
                std::cout << Json(Object{{"ok",true}, {"id",request_id}, {"result",result}}).dump() << '\n';
            } catch (const dimension::StoreError& error) {
                const char* code = "storage";
                if (error.code() == dimension::StoreErrorCode::Conflict) code = "conflict";
                else if (error.code() == dimension::StoreErrorCode::NotFound) code = "not-found";
                else if (error.code() == dimension::StoreErrorCode::InvalidArgument) code = "invalid-argument";
                else if (error.code() == dimension::StoreErrorCode::LimitExceeded) code = "limit-exceeded";
                std::cout << Json(Object{{"ok",false}, {"id",request_id}, {"error",Object{{"code",code},{"message",error.what()}}}}).dump() << '\n';
            } catch (const std::exception& error) {
                std::cout << Json(Object{{"ok",false}, {"id",request_id}, {"error",Object{{"code","invalid-request"},{"message",error.what()}}}}).dump() << '\n';
            }
            std::cout.flush();
        }
    } catch (const std::exception& error) { std::cerr << "Native storage could not open: " << error.what() << '\n'; return 1; }
    return 0;
}

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring_view(argv[1]) == L"--version") {
        std::cout << "DimensionAgent native core 0.1.0 (phase 1)\n"; return 0;
    }
    if (argc != 3 || std::wstring_view(argv[1]) != L"--database") {
        std::cerr << "Usage: DImensionagent-core --database <isolated-database.sqlite>\n"; return 2;
    }
    return serve(std::filesystem::path(argv[2]));
}
#else
int main(int argc, char** argv) {
    if (argc == 2 && std::string_view(argv[1]) == "--version") {
        std::cout << "DimensionAgent native core 0.1.0 (phase 1)\n"; return 0;
    }
    if (argc != 3 || std::string_view(argv[1]) != "--database") {
        std::cerr << "Usage: DImensionagent-core --database <isolated-database.sqlite>\n"; return 2;
    }
    return serve(std::filesystem::path(argv[2]));
}
#endif
