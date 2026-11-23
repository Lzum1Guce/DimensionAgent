#define NOMINMAX
#include "dimension/workspaces.hpp"
#include "dimension/atomic_file.hpp"
#include "dimension/managed_workspaces.hpp"
#include <windows.h>
#include <fstream>
#include <map>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace dimension {
namespace {
namespace fs=std::filesystem;
using O=Json::Object;
fs::path native(const fs::path& p){auto v=fs::absolute(p).lexically_normal().wstring();if(v.starts_with(L"\\\\?\\"))return v;if(v.starts_with(L"\\\\"))return L"\\\\?\\UNC\\"+v.substr(2);return L"\\\\?\\"+v;}
std::string text(const fs::path& p){auto v=p.u8string();return {reinterpret_cast<const char*>(v.data()),v.size()};}
fs::path path(std::string_view v){return fs::path(std::u8string_view(reinterpret_cast<const char8_t*>(v.data()),v.size()));}
void id(const std::string& run){
    if(run.empty()||run.size()>128)throw std::runtime_error("任务工作区编号无效");
    for(const char c:run){
        if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='_'||c=='-'))
            throw std::runtime_error("任务工作区编号无效");
    }
}
Json read(const fs::path& p){
    const auto attrs=GetFileAttributesW(native(p).c_str());
    if(attrs==INVALID_FILE_ATTRIBUTES)return {};
    if(attrs&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))throw std::runtime_error("工作区绑定不能是链接或目录");
    const auto size=fs::file_size(native(p));if(size>16384)throw std::runtime_error("工作区绑定过大");
    std::string data(static_cast<std::size_t>(size),'\0');std::ifstream f(native(p),std::ios::binary);
    f.read(data.data(),static_cast<std::streamsize>(data.size()));if(!f&&size)throw std::runtime_error("工作区绑定无法读取");
    return Json::parse(data);
}
void write(const fs::path& p,const Json& j){
    AtomicWriteOptions options;options.replace_existing=false;
    atomic_write_file(p,j.dump(),options);
}
std::string string(const Json& j,const char* key){auto p=j.find(key);if(!p||!p->is_string())throw std::runtime_error("工作区绑定字段无效");return p->as_string();}
}
struct WorkspaceBindings::Impl {
    fs::path metadata,tasks;mutable std::mutex mutex;
    mutable std::map<std::string,std::pair<std::string,fs::path>> binding_cache;
    Impl(fs::path m,fs::path t):metadata(std::move(m)),tasks(std::move(t)){
        metadata=WorkspaceBindings::validate_project(metadata);tasks=WorkspaceBindings::validate_project(tasks);
    }
    fs::path raw_saved_unlocked(const std::string& run,const std::string& bot)const{
        id(run);
        if(const auto hit=binding_cache.find(run);hit!=binding_cache.end()){
            if(hit->second.first!=bot)throw std::runtime_error("任务工作区归属不一致");
            return hit->second.second;
        }
        auto j=read(metadata/path(run+".json"));if(j.is_null())return {};
        if(!j.is_object()||!j.find("version")||!j.at("version").is_number()||j.at("version").as_number()!=1||
            string(j,"run")!=run||string(j,"bot")!=bot)throw std::runtime_error("任务工作区归属不一致");
        auto raw_p=path(string(j,"project")).lexically_normal();
        if(!raw_p.is_absolute()||raw_p==raw_p.root_path())throw std::runtime_error("项目根路径无效");
        binding_cache.emplace(run,std::make_pair(bot,raw_p));
        return raw_p;
    }
    fs::path saved(const std::string& run,const std::string& bot)const{
        const auto raw_p=raw_saved_unlocked(run,bot);
        if(raw_p.empty())return {};
        return WorkspaceBindings::validate_project(raw_p,false);
    }
};
WorkspaceBindings::WorkspaceBindings(fs::path m,fs::path t):impl_(std::make_unique<Impl>(std::move(m),std::move(t))){}
WorkspaceBindings::~WorkspaceBindings()=default;
fs::path WorkspaceBindings::validate_project(const fs::path& input,bool create){
    if(!input.is_absolute())throw std::runtime_error("项目根需为绝对目录");
    auto value=input.lexically_normal();if(value==value.root_path())throw std::runtime_error("请选择项目文件夹，不能把整个磁盘作为项目根");
    const auto raw=value.wstring();if(raw.size()>16000||raw.find(L'\0')!=raw.npos)throw std::runtime_error("项目根路径无效");
    if(value.root_name().wstring().starts_with(L"\\\\")){
        if(!managed_workspaces::key_from_windows_any(value))throw std::runtime_error("仅允许应用创建的WSL托管工作区");
        auto attrs=GetFileAttributesW(native(value).c_str());
        for(int attempt=0;attempt<3 && attrs==INVALID_FILE_ATTRIBUTES;++attempt){
            if(create){
                std::error_code ec;
                fs::create_directories(native(value),ec);
            }
            attrs=GetFileAttributesW(native(value).c_str());
            if(attrs!=INVALID_FILE_ATTRIBUTES)break;
            ::Sleep(350);
            attrs=GetFileAttributesW(native(value).c_str());
        }
        if(attrs==INVALID_FILE_ATTRIBUTES||!(attrs&FILE_ATTRIBUTE_DIRECTORY)||(attrs&FILE_ATTRIBUTE_REPARSE_POINT))
            throw std::runtime_error("托管工作区未准备完成或路径不安全");
        return value;
    }
    fs::path part;
    for(const auto& segment:value){
        part/=segment;const auto attrs=GetFileAttributesW(native(part).c_str());
        if(attrs==INVALID_FILE_ATTRIBUTES){const auto error=GetLastError();if(error!=ERROR_FILE_NOT_FOUND&&error!=ERROR_PATH_NOT_FOUND)throw std::runtime_error("项目根无法访问");continue;}
        if(attrs&FILE_ATTRIBUTE_REPARSE_POINT)throw std::runtime_error("项目根不能经过目录链接");
        if(!(attrs&FILE_ATTRIBUTE_DIRECTORY))throw std::runtime_error("项目根必须是目录");
    }
    if(create)fs::create_directories(native(value));
    return value;
}
fs::path WorkspaceBindings::bind(const std::string& run,const std::string& bot,const fs::path& project){
    if(bot.empty()||bot.size()>256)throw std::runtime_error("任务工作区Bot无效");
    std::lock_guard lock(impl_->mutex);const auto old=impl_->saved(run,bot);if(!old.empty())return old;
    auto value=validate_project(project);write(impl_->metadata/path(run+".json"),O{{"version",1},{"run",run},{"bot",bot},{"project",text(value)}});
    impl_->binding_cache.insert_or_assign(run,std::make_pair(bot,value));
    return value;
}
fs::path WorkspaceBindings::project(const std::string& run,const std::string& bot)const{
    std::lock_guard lock(impl_->mutex);return impl_->saved(run,bot);
}
fs::path WorkspaceBindings::peek_project(const std::string& run,const std::string& bot)const{
    try{std::lock_guard lock(impl_->mutex);return impl_->raw_saved_unlocked(run,bot);}catch(...){return {};}
}
fs::path WorkspaceBindings::task(const std::string& run)const{id(run);return impl_->tasks/path(run);}
Json WorkspaceBindings::describe(const std::string& run,const std::string& bot)const{
    fs::path p;
    {std::lock_guard lock(impl_->mutex);p=impl_->raw_saved_unlocked(run,bot);}
    return O{{"task",text(task(run))},{"project",p.empty()?Json():Json(text(p))},
        {"sandboxProject",p.empty()?Json():Json("/workspace")},{"incoming",p.empty()?Json():Json("incoming")}};
}
}
