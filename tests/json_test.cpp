#include "dimension/json.hpp"

#include <bit>
#include <cmath>
#include <cstdint>
#include <functional>
#include <iostream>
#include <limits>
#include <random>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

using dimension::Json;

std::size_t assertions = 0;

void check(bool condition, std::string_view label) {
    ++assertions;
    if (!condition) {
        throw std::runtime_error(std::string(label));
    }
}

template <class Action>
std::string expect_runtime_error(Action action, std::string_view label) {
    ++assertions;
    try {
        action();
    } catch (const std::runtime_error& error) {
        return error.what();
    } catch (...) {
        throw std::runtime_error(std::string(label) + ": wrong exception type");
    }
    throw std::runtime_error(std::string(label) + ": expected rejection");
}

void reject(std::string_view input, std::string_view label) {
    const std::string error = expect_runtime_error([&] { Json::parse(input); }, label);
    check(error.find("byte offset ") != std::string::npos, "parse error includes a byte offset");
}

void constructors_and_access() {
    check(Json().is_null(), "default construction");
    check(Json(nullptr).is_null(), "null construction");
    check(Json(true).is_bool() && Json(true).as_bool(), "boolean construction");
    check(!Json(false).as_bool(), "false boolean");
    check(Json(3).is_number() && Json(3).as_number() == 3.0, "integer construction");
    check(Json(1.25).as_number() == 1.25, "double construction");
    check(Json("value").is_string(), "C string construction");
    check(Json(std::string("value")).as_string() == "value", "owned string construction");
    check(Json(Json::Array{}).is_array(), "array construction");
    check(Json(Json::Object{}).is_object(), "object construction");

    const Json object(Json::Object{{"name", "native"}, {"active", true}, {"version", 1}});
    check(object.at("name").as_string() == "native", "member access");
    check(object.find("active") != nullptr && object.find("active")->as_bool(), "member lookup");
    check(object.find("missing") == nullptr, "missing lookup");
    check(Json().find("missing") == nullptr, "lookup on non-object");
    const std::string key_with_suffix = "name-not-the-key";
    check(object.find(std::string_view(key_with_suffix.data(), 4)) != nullptr, "lookup honors view length");

    expect_runtime_error([&] { object.at("missing"); }, "missing member");
    expect_runtime_error([] { Json().at("anything"); }, "member access on non-object");
    expect_runtime_error([] { Json().as_bool(); }, "wrong boolean type");
    expect_runtime_error([] { Json(false).as_number(); }, "wrong numeric type");
    expect_runtime_error([] { Json(1).as_string(); }, "wrong string type");
    expect_runtime_error([] { Json("x").as_array(); }, "wrong array type");
    expect_runtime_error([] { Json(Json::Array{}).as_object(); }, "wrong object type");
    expect_runtime_error([] { Json(static_cast<const char*>(nullptr)); }, "null C string pointer");

    const std::string nul_key("a\0b", 3);
    const Json nul_object(Json::Object{{nul_key, "found"}});
    check(nul_object.at(std::string_view(nul_key)).as_string() == "found", "embedded NUL member name");
    check(nul_object.find("a") == nullptr, "embedded NUL key is not truncated");
}

void objects_and_strings() {
    const Json value = Json::parse(R"json(
        {"request":"run","active":true,"optional":null,
         "items":[false,12,-1.25,1e2,{"name":"中文(回信)"}],
         "path":"C:\\test\\(folder)","escaped":"\"\\\/\b\f\n\r\t"}
    )json");
    check(value.is_object() && value.as_object().size() == 6, "nested object member count");
    check(value.at("request").as_string() == "run", "string member");
    check(value.at("active").as_bool(), "true literal");
    check(value.at("optional").is_null(), "null literal");
    const auto& items = value.at("items").as_array();
    check(items.size() == 5, "array size");
    check(!items[0].as_bool(), "false literal");
    check(items[1].as_number() == 12.0 && items[2].as_number() == -1.25 && items[3].as_number() == 100.0,
          "mixed number formats");
    check(items[4].at("name").as_string() == "中文(回信)", "raw Chinese and parentheses");
    check(value.at("path").as_string() == "C:\\test\\(folder)", "backslashes and parentheses");
    check(value.at("escaped").as_string() == "\"\\/\b\f\n\r\t", "all short escapes");
    check(Json::parse(" \r\n\t true\t\n ").as_bool(), "legal JSON whitespace");
    check(Json::parse("[]").as_array().empty(), "empty array");
    check(Json::parse("{}").as_object().empty(), "empty object");
    check(Json::parse("\"\"").as_string().empty(), "empty string");

    const Json unicode = Json::parse(R"json({"中文":"\u4e2d\u6587","emoji":"\uD83D\uDE00","raw":"😀"})json");
    check(unicode.at("中文").as_string() == "中文", "Unicode escape decoding");
    check(unicode.at("emoji").as_string() == "😀", "surrogate-pair decoding");
    check(unicode.at("emoji").as_string() == unicode.at("raw").as_string(), "raw and escaped emoji agree");
    check(unicode.dump().find("中文") != std::string::npos, "dump retains Chinese UTF-8");
    check(unicode.dump().find("😀") != std::string::npos, "dump retains emoji UTF-8");
    const Json escaped_nul = Json::parse(R"json({"a\u0000b":"x\u0000y"})json");
    check(escaped_nul.at(std::string("a\0b", 3)).as_string() == std::string("x\0y", 3), "NUL escapes retained");

    const std::vector<std::pair<std::string, std::string>> unicode_boundaries{
        {R"json("\u007F")json", std::string("\x7F", 1)},
        {R"json("\u0080")json", std::string("\xC2\x80", 2)},
        {R"json("\u07FF")json", std::string("\xDF\xBF", 2)},
        {R"json("\u0800")json", std::string("\xE0\xA0\x80", 3)},
        {R"json("\uD7FF")json", std::string("\xED\x9F\xBF", 3)},
        {R"json("\uE000")json", std::string("\xEE\x80\x80", 3)},
        {R"json("\uFFFF")json", std::string("\xEF\xBF\xBF", 3)},
        {R"json("\uD800\uDC00")json", std::string("\xF0\x90\x80\x80", 4)},
        {R"json("\uDBFF\uDFFF")json", std::string("\xF4\x8F\xBF\xBF", 4)}
    };
    for (const auto& sample : unicode_boundaries) {
        check(Json::parse(sample.first).as_string() == sample.second, "Unicode boundary decoding");
        check(Json::parse("\"" + sample.second + "\"").as_string() == sample.second, "raw UTF-8 boundary decoding");
    }
    std::string every_control;
    for (int value_byte = 0; value_byte < 32; ++value_byte) {
        every_control.push_back(static_cast<char>(value_byte));
    }
    check(Json::parse(Json(every_control).dump()).as_string() == every_control, "every control byte survives escaping");

    const Json ordered(Json::Object{{"z", 1}, {"a", Json::Array{1, true, nullptr}}, {"m", "(plain)"}});
    check(ordered.dump() == R"json({"a":[1,true,null],"m":"(plain)","z":1})json", "stable compact key ordering");
    check(Json::parse(value.dump()).dump() == value.dump(), "nested round trip");
}

void numbers() {
    const std::vector<std::pair<std::string, double>> valid{
        {"0", 0.0}, {"-0", -0.0}, {"1", 1.0}, {"-25", -25.0}, {"0.5", 0.5},
        {"-0.125", -0.125}, {"2e3", 2000.0}, {"-2E-3", -0.002}, {"1E+4", 10000.0},
        {"123.456e-2", 1.23456}, {"5e-324", std::numeric_limits<double>::denorm_min()},
        {"1.7976931348623157e308", std::numeric_limits<double>::max()}
    };
    for (const auto& sample : valid) {
        const double parsed = Json::parse(sample.first).as_number();
        check(parsed == sample.second, "numeric value");
        check(std::signbit(parsed) == std::signbit(sample.second), "numeric sign including negative zero");
    }
    const std::vector<double> edges{
        0.0, -0.0, 0.1, 1.0, -1.0, 1.0 / 3.0,
        std::numeric_limits<double>::min(), std::numeric_limits<double>::denorm_min(),
        std::numeric_limits<double>::max(), std::numeric_limits<double>::lowest()
    };
    for (double value : edges) {
        const double round_trip = Json::parse(Json(value).dump()).as_number();
        check(std::bit_cast<std::uint64_t>(round_trip) == std::bit_cast<std::uint64_t>(value), "edge double round trip");
    }
    std::mt19937_64 random(0x396C4017B113ULL);
    for (int iteration = 0; iteration < 10000; ++iteration) {
        const auto bits = static_cast<std::uint64_t>(random());
        const double value = std::bit_cast<double>(bits);
        if (!std::isfinite(value)) {
            continue;
        }
        check(std::bit_cast<std::uint64_t>(Json::parse(Json(value).dump()).as_number()) == bits,
              "random finite double round trip");
    }
    expect_runtime_error([] { Json(std::numeric_limits<double>::infinity()).dump(); }, "positive infinity dump");
    expect_runtime_error([] { Json(-std::numeric_limits<double>::infinity()).dump(); }, "negative infinity dump");
    expect_runtime_error([] { Json(std::numeric_limits<double>::quiet_NaN()).dump(); }, "NaN dump");
}

void invalid_input() {
    const std::vector<std::string> cases{
        "", " ", "\t\n\r", "NULL", "True", "False", "nul", "tru", "falSe", "undefined",
        "null true", "{}x", "[]0", "truefalse", "{", "[", "[1", "[1,]", "[,1]", "[1,,2]",
        "[1 2]", "{\"a\"}", "{\"a\" 1}", "{a:1}", "{\"a\":}", "{\"a\":1,}", "{,}",
        "{\"a\":1 \"b\":2}", "{\"same\":1,\"same\":2}", R"json({"a":1,"\u0061":2})json",
        "'single'", "\"unclosed", "\"ending\\", R"json("\x41")json", R"json("\a")json",
        R"json("\v")json", R"json("\0")json", R"json("\(")json", R"json("\u12")json",
        R"json("\uGGGG")json", R"json("\uD800")json", R"json("\uDC00")json",
        R"json("\uD800\u0041")json", R"json("\uD800\uD800")json", R"json("\uD800x")json",
        R"json("\uD800\\uDC00")json", R"json("\uD800\n")json",
        "+1", "01", "-01", "00.1", "-", ".1", "-.1", "1.", "1e", "1e+", "1e-",
        "1E+-2", "1e--2", "--1", "0x10", "1_000", "1,5", "NaN", "nan", "Infinity",
        "-Infinity", "inf", "1e309", "-1e309", "1e-4000", "[1e309]", "/* comment */null",
        "// comment\nnull", std::string("null\0", 5), "\vnull", "\fnull", "\xEF\xBB\xBF{}"
    };
    for (std::size_t index = 0; index < cases.size(); ++index) {
        reject(cases[index], "invalid syntax case " + std::to_string(index));
    }
    for (int value_byte = 0; value_byte < 32; ++value_byte) {
        reject(std::string("\"") + static_cast<char>(value_byte) + "\"", "raw control byte");
    }

    const std::vector<std::string> invalid_utf8{
        "\x80", "\xBF", "\xC0\x80", "\xC1\xBF", "\xC2", "\xC2 ",
        "\xE0\x80\x80", "\xED\xA0\x80", "\xED\xBF\xBF", "\xE2\x82",
        "\xF0\x80\x80\x80", "\xF4\x90\x80\x80", "\xF5\x80\x80\x80",
        "\xF0\x9F\x98", "\xF8\x88\x80\x80\x80", "\xFC\x84\x80\x80\x80\x80", "\xFF"
    };
    for (const auto& bytes : invalid_utf8) {
        reject("\"" + bytes + "\"", "invalid UTF-8 string");
        reject("{\"" + bytes + "\":0}", "invalid UTF-8 member name");
        expect_runtime_error([&] { Json(bytes).dump(); }, "invalid UTF-8 constructed string");
        expect_runtime_error([&] { Json(Json::Object{{bytes, 0}}).dump(); }, "invalid UTF-8 constructed key");
    }

    const std::string sensitive = R"json({"secret":"private-value-marker-4917",})json";
    const std::string error = expect_runtime_error([&] { Json::parse(sensitive); }, "sensitive input rejection");
    check(error.find("private-value-marker-4917") == std::string::npos, "error does not echo payload");
    const std::string trailing_error = expect_runtime_error([] { Json::parse("null?"); }, "trailing offset");
    check(trailing_error.find("byte offset 4:") != std::string::npos, "offset identifies trailing byte");
}

void limits() {
    constexpr std::size_t max_bytes = 4U * 1024U * 1024U;
    const std::string deepest = std::string(64, '[') + "0" + std::string(64, ']');
    check(Json::parse(deepest).dump() == deepest, "64 containers accepted");
    check(Json::parse(std::string(64, '[') + std::string(64, ']')).is_array(), "64 empty nested containers accepted");
    reject(std::string(65, '[') + "0" + std::string(65, ']'), "65 containers rejected");
    reject(std::string(65, '[') + std::string(65, ']'), "65 empty nested containers rejected");

    std::string nested_object = "true";
    for (int depth = 0; depth < 64; ++depth) {
        nested_object = "{\"a\":" + nested_object + "}";
    }
    check(Json::parse(nested_object).dump() == nested_object, "64 object containers accepted");
    reject("[" + nested_object + "]", "combined object and array depth limit");

    Json built_tree;
    for (int depth = 0; depth < 64; ++depth) {
        Json::Array parent;
        parent.emplace_back(std::move(built_tree));
        built_tree = Json(std::move(parent));
    }
    check(!built_tree.dump().empty(), "constructed 64-container tree serializes");
    Json::Array extra_parent;
    extra_parent.emplace_back(std::move(built_tree));
    built_tree = Json(std::move(extra_parent));
    expect_runtime_error([&] { built_tree.dump(); }, "constructed over-depth tree rejected");

    const std::string limit_payload(max_bytes - 2U, 'x');
    const std::string limit_input = "\"" + limit_payload + "\"";
    check(Json::parse(limit_input).as_string() == limit_payload, "exact 4 MiB input accepted intact");
    reject(limit_input + " ", "over 4 MiB input rejected including whitespace");
    check(Json::parse(std::string(max_bytes - 4U, ' ') + "null").is_null(), "whitespace included at input boundary");
    reject(std::string(max_bytes - 3U, ' ') + "null", "whitespace-only size excess rejected");
    const std::string larger_output(max_bytes + 17U, 'x');
    const std::string dumped = Json(larger_output).dump();
    check(dumped.size() == larger_output.size() + 2U, "serialization never truncates a long string");
    check(dumped.front() == '"' && dumped.back() == '"' &&
          std::string_view(dumped).substr(1U, larger_output.size()) == larger_output, "long output content preserved");
    check(Json::parse(dumped, 8U * 1024U * 1024U).as_string() == larger_output,
          "explicit transport limit accepts a larger frame without changing default");
    reject(dumped, "explicit larger parse does not widen the default limit");
    expect_runtime_error([] { Json::parse("null", 3); }, "smaller explicit byte limit enforced");
}

Json generated_value(std::mt19937_64& random, unsigned depth) {
    const auto choice = random() % (depth == 0U ? 5U : 7U);
    switch (choice) {
    case 0: return Json();
    case 1: return Json((random() & 1U) != 0U);
    case 2: return Json(static_cast<double>(static_cast<std::int64_t>(random() % 2000000U) - 1000000) / 7.0);
    case 3: return Json("中文(随机)😀");
    case 4: {
        std::string value;
        const auto length = random() % 40U;
        for (std::uint64_t index = 0; index < length; ++index) {
            value.push_back(static_cast<char>(random() % 128U));
        }
        return Json(std::move(value));
    }
    case 5: {
        Json::Array values;
        const auto length = random() % 5U;
        for (std::uint64_t index = 0; index < length; ++index) {
            values.push_back(generated_value(random, depth - 1U));
        }
        return Json(std::move(values));
    }
    default: {
        Json::Object values;
        const auto length = random() % 5U;
        for (std::uint64_t index = 0; index < length; ++index) {
            values.emplace("key" + std::to_string(index), generated_value(random, depth - 1U));
        }
        return Json(std::move(values));
    }
    }
}

void randomized_inputs() {
    std::mt19937_64 random(0xA430FC91279ULL);
    for (int iteration = 0; iteration < 1000; ++iteration) {
        const Json value = generated_value(random, 6U);
        const std::string encoded = value.dump();
        check(Json::parse(encoded).dump() == encoded, "generated value round trip");
    }

    constexpr std::string_view json_alphabet = "{}[],:0123456789-+.eEtruefalsn \t\r\n\\\"abcdefu";
    for (int iteration = 0; iteration < 25000; ++iteration) {
        std::string input;
        const auto length = random() % 128U;
        for (std::uint64_t index = 0; index < length; ++index) {
            input.push_back(iteration % 2 == 0 ? static_cast<char>(random() % 256U) :
                            json_alphabet[static_cast<std::size_t>(random() % json_alphabet.size())]);
        }
        bool parsed = false;
        Json value;
        try {
            value = Json::parse(input);
            parsed = true;
        } catch (const std::runtime_error& error) {
            check(std::string_view(error.what()).find("byte offset ") != std::string_view::npos,
                  "random input rejection has offset");
        }
        if (parsed) {
            const std::string encoded = value.dump();
            check(Json::parse(encoded).dump() == encoded, "accepted random input round trip");
        }
    }

    // Corrupt valid nested documents to explore syntax-adjacent parser paths.
    for (int iteration = 0; iteration < 5000; ++iteration) {
        std::string input = generated_value(random, 5U).dump();
        const auto position = static_cast<std::size_t>(random() % input.size());
        input[position] = static_cast<char>(random() % 256U);
        bool parsed = false;
        Json value;
        try {
            value = Json::parse(input);
            parsed = true;
        } catch (const std::runtime_error& error) {
            check(std::string_view(error.what()).find("byte offset ") != std::string_view::npos,
                  "mutated input rejection has offset");
        }
        if (parsed) {
            const std::string encoded = value.dump();
            check(Json::parse(encoded).dump() == encoded, "accepted mutation round trip");
        }
    }
}

} // namespace

int main() {
    const std::vector<std::pair<const char*, std::function<void()>>> groups{
        {"constructors and access", constructors_and_access},
        {"objects and Unicode strings", objects_and_strings},
        {"numbers and exact double round trips", numbers},
        {"invalid input and diagnostic privacy", invalid_input},
        {"size and depth boundaries", limits},
        {"generated values and deterministic fuzz", randomized_inputs}
    };
    int failures = 0;
    for (const auto& group : groups) {
        try {
            group.second();
            std::cout << "PASS " << group.first << '\n';
        } catch (const std::exception& error) {
            ++failures;
            std::cerr << "FAIL " << group.first << ": " << error.what() << '\n';
        }
    }
    std::cout << assertions << " assertions; " << failures << " failed groups\n";
    return failures == 0 ? 0 : 1;
}
