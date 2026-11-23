#include "dimension/model_catalog.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <utility>

namespace dimension {
namespace {
using Clock = std::chrono::steady_clock;
bool valid_id(std::string_view value) {
    return !value.empty() && value.size() <= 256 &&
        std::none_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c == 127; });
}
std::string stamp() {
    return std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}
std::string signature(const ProviderCatalogQuery& query) {
    return Json(Json::Array{query.revision, query.config.base_url, query.config.protocol}).dump();
}
void configured(ProviderCatalogView& view, const ProviderCatalogQuery& query) {
    std::set<std::string> ids(view.models.begin(), view.models.end());
    for (std::size_t i = 0; i < query.configured_models.size() && i < 16; ++i)
        if (valid_id(query.configured_models[i])) ids.insert(query.configured_models[i]);
    view.models.assign(ids.begin(), ids.end());
}
} // namespace

Json ProviderCatalogView::json() const {
    Json::Array rows;
    for (const auto& model : models) rows.emplace_back(model);
    return Json::Object{{"providerId", provider_id}, {"status", status}, {"updatedAt", updated_at},
        {"error", error}, {"cached", cached}, {"models", std::move(rows)}};
}
std::vector<std::string> normalize_model_catalog(const Json& value) {
    const auto* data = value.find("data");
    if (!data || !data->is_array() || data->as_array().size() > 1024)
        throw std::runtime_error("Model catalog requires a bounded data array");
    std::set<std::string> ids;
    for (const auto& row : data->as_array()) {
        const auto* id = row.find("id");
        if (!id || !id->is_string() || !valid_id(id->as_string()))
            throw std::runtime_error("Model catalog contains an invalid model ID");
        ids.insert(id->as_string());
        if (ids.size() > 512) throw std::runtime_error("Model catalog contains too many models");
    }
    return {ids.begin(), ids.end()};
}

struct ModelCatalogService::Impl {
    struct Entry {
        std::string signature, updated, status = "unrefreshed", error;
        std::vector<std::string> models;
        bool has_catalog = false, fetching = false;
        Clock::time_point refreshed{}, used{};
    };
    std::mutex mutex;
    std::map<std::string, std::shared_ptr<Entry>, std::less<>> entries;
    std::size_t active_refreshes = 0;
    ModelCatalogFetcher fetcher;
    explicit Impl(ModelCatalogFetcher supplied)
        : fetcher(supplied ? std::move(supplied) : ModelCatalogFetcher(fetch_model_catalog)) {}
    ProviderCatalogView view(const ProviderCatalogQuery& query, const std::shared_ptr<Entry>& entry) {
        ProviderCatalogView result;
        result.provider_id = query.provider_id;
        if (entry) {
            result.listed_models=entry->models; result.models = entry->models; result.cached = entry->has_catalog;
            result.updated_at = entry->updated; result.error = entry->error;
            result.status = entry->fetching ? "refreshing" : entry->status;
            if (!entry->fetching && entry->status == "ready" &&
                Clock::now() - entry->refreshed > std::chrono::minutes(5)) result.status = "stale";
        }
        configured(result, query);
        return result;
    }
};
ModelCatalogService::ModelCatalogService(ModelCatalogFetcher fetcher)
    : impl_(std::make_unique<Impl>(std::move(fetcher))) {}
ModelCatalogService::~ModelCatalogService() = default;
ProviderCatalogView ModelCatalogService::query(const ProviderCatalogQuery& query, bool refresh,
                                              std::stop_token stop) {
    if (!valid_id(query.provider_id) || query.revision.size() > 256)
        throw std::invalid_argument("Invalid provider catalog identity");
    if (query.config.base_url.empty() || query.config.base_url.size() > 16384 ||
        (query.config.protocol != "chat-completions" && query.config.protocol != "responses")) {
        ProviderCatalogView invalid;
        invalid.provider_id = query.provider_id; invalid.status = "error";
        invalid.error = "接口目录配置不完整或无效，可继续编辑已配置模型";
        configured(invalid, query); return invalid;
    }
    const auto key = signature(query);
    std::shared_ptr<Impl::Entry> entry;
    {
        std::lock_guard lock(impl_->mutex);
        const auto found = impl_->entries.find(query.provider_id);
        if (found != impl_->entries.end() && found->second->signature == key) entry = found->second;
        if (!refresh || (entry && entry->fetching)) return impl_->view(query, entry);
        if (impl_->active_refreshes >= 4) {
            auto result = impl_->view(query, entry);
            result.status = "deferred"; result.error = "模型目录刷新繁忙，请稍后重试";
            return result;
        }
        if (!entry) {
            if (found == impl_->entries.end() && impl_->entries.size() >= 64) {
                auto oldest = impl_->entries.end();
                for (auto item = impl_->entries.begin(); item != impl_->entries.end(); ++item)
                    if (!item->second->fetching && (oldest == impl_->entries.end() ||
                        item->second->used < oldest->second->used)) oldest = item;
                if (oldest == impl_->entries.end()) {
                    auto result = impl_->view(query, {});
                    result.status = "deferred"; result.error = "模型目录刷新繁忙，请稍后重试";
                    return result;
                }
                impl_->entries.erase(oldest);
            }
            entry = std::make_shared<Impl::Entry>(); entry->signature = key;
            impl_->entries[query.provider_id] = entry;
        }
        entry->fetching = true; entry->used = Clock::now(); ++impl_->active_refreshes;
    }
    std::vector<std::string> models;
    std::string state = "ready", error;
    try { models = normalize_model_catalog(impl_->fetcher(query.config, stop)); }
    catch (const ModelError& failure) {
        if (failure.http_status() == 404 || failure.http_status() == 405 || failure.http_status() == 501) {
            state = "unsupported"; error = "此接口不提供模型目录，可继续使用已配置模型或手动输入";
        } else if (failure.kind() == ModelFailure::Cancelled) {
            state = "cancelled"; error = "模型目录刷新已取消";
        } else if (failure.http_status() == 401 || failure.http_status() == 403) {
            state = "error"; error = "模型目录认证失败，请检查接口凭据";
        } else {
            state = "error"; error = "模型目录请求未完成，已保留现有模型";
        }
    } catch (...) { state = "error"; error = "模型目录不可用或响应格式不受支持，已保留现有模型"; }
    std::lock_guard lock(impl_->mutex);
    --impl_->active_refreshes;
    entry->fetching = false; entry->status = state; entry->error = std::move(error);
    if (state == "ready") {
        entry->models = std::move(models); entry->has_catalog = true;
        entry->refreshed = Clock::now(); entry->updated = stamp();
    }
    return impl_->view(query, entry);
}
std::vector<ProviderCatalogView> ModelCatalogService::query_all(
    const std::vector<ProviderCatalogQuery>& queries, bool refresh, std::stop_token stop) {
    std::vector<ProviderCatalogView> result;
    result.reserve(queries.size());
    for (const auto& query : queries) result.push_back(this->query(query, false, stop));
    if (!refresh || queries.empty()) return result;
    const auto deadline = Clock::now() + std::chrono::seconds(10);
    const auto limit = std::min<std::size_t>(queries.size(), 64);
    std::atomic_size_t index{0};
    std::vector<std::jthread> workers;
    for (std::size_t i = 0; i < std::min<std::size_t>(limit, 4); ++i) workers.emplace_back([&] {
        for (;;) {
            const auto current = index.fetch_add(1);
            if (current >= limit) return;
            auto query = queries[current];
            const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
            if (remaining <= 0 || stop.stop_requested()) {
                result[current].status = "deferred"; result[current].error = "本次刷新达到时间预算，请稍后重试";
                continue;
            }
            query.config.timeout_ms = static_cast<int>(std::min<std::int64_t>(remaining, 5000));
            try { result[current] = this->query(query, true, stop); }
            catch (...) { result[current].status = "error"; result[current].error = "接口目录配置无效，已保留现有模型"; }
        }
    });
    for (auto& worker : workers) worker.join();
    for (std::size_t i = limit; i < result.size(); ++i) {
        result[i].status = "deferred"; result[i].error = "本次刷新达到接口数量预算，请单独刷新此接口";
    }
    return result;
}
} // namespace dimension
