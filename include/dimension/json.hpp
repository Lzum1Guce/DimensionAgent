#pragma once

#include <cstddef>
#include <map>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace dimension {

// A value-owning JSON type. Numbers use double; exact identifiers should be strings.
class Json {
public:
    using Array = std::vector<Json>;
    using Object = std::map<std::string, Json>;

    Json() noexcept;
    Json(std::nullptr_t) noexcept;
    Json(bool value) noexcept;
    Json(double value) noexcept;
    Json(int value) noexcept;
    Json(std::string value);
    Json(const char* value);
    Json(Array value);
    Json(Object value);

    // Defaults to at most 4 MiB and 64 nested containers. A trusted transport
    // may supply its own byte limit. Throws std::runtime_error
    // with a byte offset for malformed input, without including payload text.
    static Json parse(std::string_view input, std::size_t max_bytes = 4U * 1024U * 1024U);
    std::string dump() const;

    bool is_null() const noexcept;
    bool is_bool() const noexcept;
    bool is_number() const noexcept;
    bool is_string() const noexcept;
    bool is_array() const noexcept;
    bool is_object() const noexcept;

    bool as_bool() const;
    double as_number() const;
    const std::string& as_string() const &;
    std::string as_string() &&;
    std::string as_string() const &&;
    Array& as_array() &;
    const Array& as_array() const &;
    Array as_array() &&;
    Array as_array() const &&;
    Object& as_object() &;
    const Object& as_object() const &;
    Object as_object() &&;
    Object as_object() const &&;

    Json& at(std::string_view key) &;
    const Json& at(std::string_view key) const &;
    Json at(std::string_view key) &&;
    Json at(std::string_view key) const &&;
    Json& operator[](std::string_view key);
    // Returns nullptr for both a missing member and a non-object value.
    const Json* find(std::string_view key) const noexcept;

private:
    using Value = std::variant<std::monostate, bool, double, std::string, Array, Object>;
    Value value_;
};

} // namespace dimension
