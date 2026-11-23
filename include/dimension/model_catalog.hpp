#pragma once

#include "dimension/model.hpp"
#include <functional>
#include <memory>

namespace dimension {

struct ProviderCatalogQuery {
    std::string provider_id, revision;
    ModelConfig config;
    std::vector<std::string> configured_models;
};
struct ProviderCatalogView {
    std::string provider_id, status = "unrefreshed", updated_at, error;
    std::vector<std::string> models;
    std::vector<std::string> listed_models; // IDs actually returned by the catalog
    bool cached = false;
    Json json() const;
};

// Only model IDs are retained, never arbitrary provider metadata or error bodies.
std::vector<std::string> normalize_model_catalog(const Json&);
using ModelCatalogFetcher = std::function<Json(const ModelConfig&, std::stop_token)>;

// Bounded process cache (64 providers, <=512 IDs/provider, <=256 UTF-8 bytes/ID).
// Read-only views make no network request. Explicit refresh preserves both the
// last successful catalog and configured models on error/unsupported endpoints.
class ModelCatalogService {
public:
    explicit ModelCatalogService(ModelCatalogFetcher fetcher = {});
    ~ModelCatalogService();
    ModelCatalogService(const ModelCatalogService&) = delete;
    ModelCatalogService& operator=(const ModelCatalogService&) = delete;
    ProviderCatalogView query(const ProviderCatalogQuery&, bool refresh,
                              std::stop_token stop = {});
    // At most four network requests at once, ten seconds total, 64 providers.
    // Entries beyond the total budget are reported deferred, never fabricated.
    std::vector<ProviderCatalogView> query_all(const std::vector<ProviderCatalogQuery>&,
                                             bool refresh, std::stop_token stop = {});
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace dimension
