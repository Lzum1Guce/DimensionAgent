#include "dimension/json.hpp"

#include <charconv>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <system_error>
#include <utility>

namespace dimension {
namespace {

constexpr std::size_t max_container_depth = 64U;

[[noreturn]] void fail_at(std::size_t offset, const char* reason) {
    throw std::runtime_error("JSON error at byte offset " + std::to_string(offset) + ": " + reason);
}

bool is_digit(char value) noexcept {
    return value >= '0' && value <= '9';
}

// The caller supplies an offset into the original byte sequence. Accept only
// shortest UTF-8 encodings of Unicode scalar values, excluding surrogates.
std::size_t utf8_width(std::string_view text, std::size_t offset) {
    const auto first = static_cast<unsigned char>(text[offset]);
    if (first < 0x80U) {
        return 1U;
    }

    std::size_t width = 0;
    std::uint32_t codepoint = 0;
    std::uint32_t minimum = 0;
    if (first >= 0xC2U && first <= 0xDFU) {
        width = 2U;
        codepoint = first & 0x1FU;
        minimum = 0x80U;
    } else if (first >= 0xE0U && first <= 0xEFU) {
        width = 3U;
        codepoint = first & 0x0FU;
        minimum = 0x800U;
    } else if (first >= 0xF0U && first <= 0xF4U) {
        width = 4U;
        codepoint = first & 0x07U;
        minimum = 0x10000U;
    } else {
        fail_at(offset, "invalid UTF-8 leading byte");
    }

    if (text.size() - offset < width) {
        fail_at(offset, "incomplete UTF-8 sequence");
    }
    for (std::size_t index = 1U; index < width; ++index) {
        const auto next = static_cast<unsigned char>(text[offset + index]);
        if ((next & 0xC0U) != 0x80U) {
            fail_at(offset + index, "invalid UTF-8 continuation byte");
        }
        codepoint = (codepoint << 6U) | (next & 0x3FU);
    }
    if (codepoint < minimum || codepoint > 0x10FFFFU ||
        (codepoint >= 0xD800U && codepoint <= 0xDFFFU)) {
        fail_at(offset, "invalid UTF-8 scalar value");
    }
    return width;
}

void append_utf8(std::string& output, std::uint32_t codepoint) {
    if (codepoint <= 0x7FU) {
        output.push_back(static_cast<char>(codepoint));
    } else if (codepoint <= 0x7FFU) {
        output.push_back(static_cast<char>(0xC0U | (codepoint >> 6U)));
        output.push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
    } else if (codepoint <= 0xFFFFU) {
        output.push_back(static_cast<char>(0xE0U | (codepoint >> 12U)));
        output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3FU)));
        output.push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
    } else {
        output.push_back(static_cast<char>(0xF0U | (codepoint >> 18U)));
        output.push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3FU)));
        output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3FU)));
        output.push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
    }
}

class Parser {
public:
    explicit Parser(std::string_view input, std::size_t limit) noexcept : input_(input), input_limit_(limit) {}

    Json run() {
        if (input_.size() > input_limit_) {
            fail_at(input_limit_, "input exceeds configured byte limit");
        }
        Json result = read_value(0U);
        skip_space();
        if (offset_ != input_.size()) {
            fail_at(offset_, "unexpected trailing bytes");
        }
        return result;
    }

private:
    std::string_view input_;
    std::size_t input_limit_;
    std::size_t offset_ = 0;

    void skip_space() noexcept {
        while (offset_ < input_.size()) {
            const char current = input_[offset_];
            if (current != ' ' && current != '\t' && current != '\r' && current != '\n') {
                break;
            }
            ++offset_;
        }
    }

    bool consume(char expected) noexcept {
        if (offset_ < input_.size() && input_[offset_] == expected) {
            ++offset_;
            return true;
        }
        return false;
    }

    void expect(char expected, const char* reason) {
        if (!consume(expected)) {
            fail_at(offset_, reason);
        }
    }

    void literal(std::string_view expected) {
        if (input_.substr(offset_, expected.size()) != expected) {
            fail_at(offset_, "invalid literal");
        }
        offset_ += expected.size();
    }

    Json read_value(std::size_t depth) {
        skip_space();
        if (offset_ == input_.size()) {
            fail_at(offset_, "expected a value");
        }
        switch (input_[offset_]) {
        case 'n':
            literal("null");
            return Json();
        case 't':
            literal("true");
            return Json(true);
        case 'f':
            literal("false");
            return Json(false);
        case '"':
            return Json(read_string());
        case '[':
        case '{':
            if (depth == max_container_depth) {
                fail_at(offset_, "container nesting exceeds 64");
            }
            return input_[offset_] == '[' ? read_array(depth + 1U) : read_object(depth + 1U);
        default:
            if (input_[offset_] == '-' || is_digit(input_[offset_])) {
                return read_number();
            }
            fail_at(offset_, "expected a JSON value");
        }
    }

    std::uint32_t read_hex_quad() {
        std::uint32_t result = 0;
        for (int index = 0; index < 4; ++index) {
            if (offset_ == input_.size()) {
                fail_at(offset_, "incomplete Unicode escape");
            }
            const char digit = input_[offset_];
            std::uint32_t value = 0;
            if (digit >= '0' && digit <= '9') {
                value = static_cast<std::uint32_t>(digit - '0');
            } else if (digit >= 'a' && digit <= 'f') {
                value = static_cast<std::uint32_t>(digit - 'a' + 10);
            } else if (digit >= 'A' && digit <= 'F') {
                value = static_cast<std::uint32_t>(digit - 'A' + 10);
            } else {
                fail_at(offset_, "invalid hexadecimal digit in Unicode escape");
            }
            ++offset_;
            result = (result << 4U) | value;
        }
        return result;
    }

    void read_unicode_escape(std::string& output) {
        const std::size_t first_offset = offset_;
        std::uint32_t codepoint = read_hex_quad();
        if (codepoint >= 0xD800U && codepoint <= 0xDBFFU) {
            expect('\\', "high surrogate requires a low-surrogate escape");
            expect('u', "high surrogate requires a low-surrogate escape");
            const std::size_t second_offset = offset_;
            const std::uint32_t low = read_hex_quad();
            if (low < 0xDC00U || low > 0xDFFFU) {
                fail_at(second_offset, "invalid low surrogate");
            }
            codepoint = 0x10000U + ((codepoint - 0xD800U) << 10U) + (low - 0xDC00U);
        } else if (codepoint >= 0xDC00U && codepoint <= 0xDFFFU) {
            fail_at(first_offset, "unpaired low surrogate");
        }
        append_utf8(output, codepoint);
    }

    std::string read_string() {
        expect('"', "expected a string");
        std::string result;
        while (offset_ < input_.size()) {
            const auto current = static_cast<unsigned char>(input_[offset_]);
            if (current == '"') {
                ++offset_;
                return result;
            }
            if (current < 0x20U) {
                fail_at(offset_, "unescaped control byte in string");
            }
            if (current == '\\') {
                ++offset_;
                if (offset_ == input_.size()) {
                    fail_at(offset_, "incomplete string escape");
                }
                const std::size_t escape_offset = offset_;
                const char escape = input_[offset_++];
                switch (escape) {
                case '"': result.push_back('"'); break;
                case '\\': result.push_back('\\'); break;
                case '/': result.push_back('/'); break;
                case 'b': result.push_back('\b'); break;
                case 'f': result.push_back('\f'); break;
                case 'n': result.push_back('\n'); break;
                case 'r': result.push_back('\r'); break;
                case 't': result.push_back('\t'); break;
                case 'u': read_unicode_escape(result); break;
                default: fail_at(escape_offset, "unknown string escape");
                }
            } else if (current < 0x80U) {
                result.push_back(static_cast<char>(current));
                ++offset_;
            } else {
                const std::size_t width = utf8_width(input_, offset_);
                result.append(input_.substr(offset_, width));
                offset_ += width;
            }
        }
        fail_at(offset_, "unterminated string");
    }

    Json read_number() {
        const std::size_t start = offset_;
        consume('-');
        if (consume('0')) {
            if (offset_ < input_.size() && is_digit(input_[offset_])) {
                fail_at(offset_, "leading zero in number");
            }
        } else {
            if (offset_ == input_.size() || input_[offset_] < '1' || input_[offset_] > '9') {
                fail_at(offset_, "expected an integer digit");
            }
            while (offset_ < input_.size() && is_digit(input_[offset_])) {
                ++offset_;
            }
        }
        if (consume('.')) {
            const std::size_t first_digit = offset_;
            while (offset_ < input_.size() && is_digit(input_[offset_])) {
                ++offset_;
            }
            if (offset_ == first_digit) {
                fail_at(offset_, "fraction requires a digit");
            }
        }
        if (consume('e') || consume('E')) {
            if (!consume('+')) {
                consume('-');
            }
            const std::size_t first_digit = offset_;
            while (offset_ < input_.size() && is_digit(input_[offset_])) {
                ++offset_;
            }
            if (offset_ == first_digit) {
                fail_at(offset_, "exponent requires a digit");
            }
        }

        double result = 0.0;
        const char* begin = input_.data() + start;
        const char* end = input_.data() + offset_;
        const auto converted = std::from_chars(begin, end, result, std::chars_format::general);
        if (converted.ec != std::errc() || converted.ptr != end || !std::isfinite(result)) {
            fail_at(start, "number is outside the supported finite double range");
        }
        return Json(result);
    }

    Json read_array(std::size_t depth) {
        ++offset_; // The opening bracket was checked by read_value.
        Json::Array result;
        skip_space();
        if (consume(']')) {
            return Json(std::move(result));
        }
        for (;;) {
            result.push_back(read_value(depth));
            skip_space();
            if (consume(']')) {
                return Json(std::move(result));
            }
            expect(',', "expected comma or closing bracket");
        }
    }

    Json read_object(std::size_t depth) {
        ++offset_; // The opening brace was checked by read_value.
        Json::Object result;
        skip_space();
        if (consume('}')) {
            return Json(std::move(result));
        }
        for (;;) {
            skip_space();
            const std::size_t key_offset = offset_;
            std::string key = read_string();
            if (result.find(key) != result.end()) {
                fail_at(key_offset, "duplicate object member");
            }
            skip_space();
            expect(':', "expected colon after object member name");
            Json value = read_value(depth);
            result.emplace(std::move(key), std::move(value));
            skip_space();
            if (consume('}')) {
                return Json(std::move(result));
            }
            expect(',', "expected comma or closing brace");
        }
    }
};

void dump_string(std::string& output, std::string_view value) {
    constexpr char hex[] = "0123456789abcdef";
    output.push_back('"');
    for (std::size_t offset = 0; offset < value.size();) {
        const auto current = static_cast<unsigned char>(value[offset]);
        switch (current) {
        case '"': output += "\\\""; break;
        case '\\': output += "\\\\"; break;
        case '\b': output += "\\b"; break;
        case '\f': output += "\\f"; break;
        case '\n': output += "\\n"; break;
        case '\r': output += "\\r"; break;
        case '\t': output += "\\t"; break;
        default:
            if (current < 0x20U) {
                output += "\\u00";
                output.push_back(hex[current >> 4U]);
                output.push_back(hex[current & 0x0FU]);
            } else if (current >= 0x80U) {
                const std::size_t width = utf8_width(value, offset);
                output.append(value.substr(offset, width));
                offset += width;
                continue;
            } else {
                output.push_back(static_cast<char>(current));
            }
            break;
        }
        ++offset;
    }
    output.push_back('"');
}

void dump_value(std::string& output, const Json& value, std::size_t depth) {
    if (value.is_null()) {
        output += "null";
    } else if (value.is_bool()) {
        output += value.as_bool() ? "true" : "false";
    } else if (value.is_number()) {
        const double number = value.as_number();
        if (!std::isfinite(number)) {
            throw std::runtime_error("JSON cannot serialize a non-finite number");
        }
        char buffer[128];
        const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), number, std::chars_format::general);
        if (converted.ec != std::errc()) {
            throw std::runtime_error("JSON number serialization failed");
        }
        output.append(buffer, converted.ptr);
    } else if (value.is_string()) {
        dump_string(output, value.as_string());
    } else {
        if (depth == max_container_depth) {
            throw std::runtime_error("JSON cannot serialize more than 64 nested containers");
        }
        if (value.is_array()) {
            output.push_back('[');
            bool first = true;
            for (const auto& member : value.as_array()) {
                if (!first) {
                    output.push_back(',');
                }
                first = false;
                dump_value(output, member, depth + 1U);
            }
            output.push_back(']');
        } else {
            output.push_back('{');
            bool first = true;
            for (const auto& member : value.as_object()) {
                if (!first) {
                    output.push_back(',');
                }
                first = false;
                dump_string(output, member.first);
                output.push_back(':');
                dump_value(output, member.second, depth + 1U);
            }
            output.push_back('}');
        }
    }
}

} // namespace

Json::Json() noexcept : value_(std::monostate()) {}
Json::Json(std::nullptr_t) noexcept : Json() {}
Json::Json(bool value) noexcept : value_(value) {}
Json::Json(double value) noexcept : value_(value) {}
Json::Json(int value) noexcept : value_(static_cast<double>(value)) {}
Json::Json(std::string value) : value_(std::move(value)) {}
Json::Json(const char* value) : Json(value ? std::string(value) :
    throw std::runtime_error("JSON string pointer is null")) {}
Json::Json(Array value) : value_(std::move(value)) {}
Json::Json(Object value) : value_(std::move(value)) {}

Json Json::parse(std::string_view input, std::size_t max_bytes) {
    return Parser(input, max_bytes).run();
}

std::string Json::dump() const {
    std::string result;
    dump_value(result, *this, 0U);
    return result;
}

bool Json::is_null() const noexcept { return std::holds_alternative<std::monostate>(value_); }
bool Json::is_bool() const noexcept { return std::holds_alternative<bool>(value_); }
bool Json::is_number() const noexcept { return std::holds_alternative<double>(value_); }
bool Json::is_string() const noexcept { return std::holds_alternative<std::string>(value_); }
bool Json::is_array() const noexcept { return std::holds_alternative<Array>(value_); }
bool Json::is_object() const noexcept { return std::holds_alternative<Object>(value_); }

bool Json::as_bool() const {
    if (const auto* value = std::get_if<bool>(&value_)) {
        return *value;
    }
    throw std::runtime_error("JSON value is not a boolean");
}

double Json::as_number() const {
    if (const auto* value = std::get_if<double>(&value_)) {
        return *value;
    }
    throw std::runtime_error("JSON value is not a number");
}

const std::string& Json::as_string() const & {
    if (const auto* value = std::get_if<std::string>(&value_)) {
        return *value;
    }
    throw std::runtime_error("JSON value is not a string");
}

std::string Json::as_string() && {
    if (auto* value = std::get_if<std::string>(&value_)) {
        return std::move(*value);
    }
    throw std::runtime_error("JSON value is not a string");
}

std::string Json::as_string() const && {
    return static_cast<const Json&>(*this).as_string();
}

Json::Array& Json::as_array() & {
    if (auto* value = std::get_if<Array>(&value_)) {
        return *value;
    }
    throw std::runtime_error("JSON value is not an array");
}

const Json::Array& Json::as_array() const & {
    if (const auto* value = std::get_if<Array>(&value_)) {
        return *value;
    }
    throw std::runtime_error("JSON value is not an array");
}

Json::Array Json::as_array() && {
    if (auto* value = std::get_if<Array>(&value_)) {
        return std::move(*value);
    }
    throw std::runtime_error("JSON value is not an array");
}

Json::Array Json::as_array() const && {
    return static_cast<const Json&>(*this).as_array();
}

Json::Object& Json::as_object() & {
    if (auto* value = std::get_if<Object>(&value_)) {
        return *value;
    }
    throw std::runtime_error("JSON value is not an object");
}

const Json::Object& Json::as_object() const & {
    if (const auto* value = std::get_if<Object>(&value_)) {
        return *value;
    }
    throw std::runtime_error("JSON value is not an object");
}

Json::Object Json::as_object() && {
    if (auto* value = std::get_if<Object>(&value_)) {
        return std::move(*value);
    }
    throw std::runtime_error("JSON value is not an object");
}

Json::Object Json::as_object() const && {
    return static_cast<const Json&>(*this).as_object();
}

Json& Json::at(std::string_view key) & {
    auto* object = std::get_if<Object>(&value_);
    if (!object) throw std::runtime_error("JSON value is not an object");
    const auto found = std::find_if(object->begin(), object->end(), [&](const auto& member) {
        return std::string_view(member.first) == key;
    });
    if (found == object->end()) throw std::runtime_error("JSON object member is missing");
    return found->second;
}

const Json& Json::at(std::string_view key) const & {
    if (!is_object()) {
        throw std::runtime_error("JSON value is not an object");
    }
    if (const Json* member = find(key)) {
        return *member;
    }
    throw std::runtime_error("JSON object member is missing");
}

Json Json::at(std::string_view key) && {
    auto* object = std::get_if<Object>(&value_);
    if (!object) throw std::runtime_error("JSON value is not an object");
    const auto found = std::find_if(object->begin(), object->end(), [&](const auto& member) {
        return std::string_view(member.first) == key;
    });
    if (found == object->end()) throw std::runtime_error("JSON object member is missing");
    return std::move(found->second);
}

Json Json::at(std::string_view key) const && {
    return static_cast<const Json&>(*this).at(key);
}

Json& Json::operator[](std::string_view key) {
    auto* object = std::get_if<Object>(&value_);
    if (!object) throw std::runtime_error("JSON value is not an object");
    for (auto& member : *object) if (std::string_view(member.first) == key) return member.second;
    return object->emplace(std::string(key), Json{}).first->second;
}

const Json* Json::find(std::string_view key) const noexcept {
    const auto* object = std::get_if<Object>(&value_);
    if (object == nullptr) {
        return nullptr;
    }
    // Object uses the public, non-transparent std::map<string, Json> type.
    // Comparing views avoids allocating inside this noexcept method.
    for (const auto& member : *object) {
        if (std::string_view(member.first) == key) {
            return &member.second;
        }
    }
    return nullptr;
}

} // namespace dimension
