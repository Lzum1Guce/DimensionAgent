#define NOMINMAX
#include "dimension/preview.hpp"
#include "dimension/http.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <map>
#include <mutex>
#include <stdexcept>
#include <utility>
#include <vector>
namespace dimension {
namespace {
namespace fs=std::filesystem;
using Clock=std::chrono::steady_clock;
std::string utf8(const fs::path& p) { auto s=p.u8string(); return {s.begin(),s.end()}; }
fs::path path8(const std::string& s) { return fs::path(std::u8string(s.begin(),s.end())); }
std::string lower(std::string s) { for(auto& c:s) if(c>='A'&&c<='Z')c+=32;return s; }
std::string encode(std::string_view value) {
    const char* digits="0123456789ABCDEF";std::string out;
    for(unsigned char c:value) {
        if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'||c=='.')out+=char(c);
        else {out+='%';out+=digits[c>>4];out+=digits[c&15];}
    }return out;
}
std::string decode(std::string_view value) {
    auto digit=[](char c)->int {if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;if(c>='A'&&c<='F')return c-'A'+10;return -1;};
    std::string result;
    for(size_t i=0;i<value.size();++i) {
        unsigned char c=value[i];
        if(c=='%') {if(i+2>=value.size())throw std::runtime_error("invalid escape");int a=digit(value[++i]),b=digit(value[++i]);if(a<0||b<0)throw std::runtime_error("invalid escape");c=static_cast<unsigned char>(a*16+b);}
        if(c<32||c==127||c=='\\'||c==':'||c=='%')throw std::runtime_error("invalid path");
        result+=char(c);
    }return result;
}
std::string token() {
    std::array<unsigned char,32> bytes{};
    if(BCryptGenRandom(nullptr,bytes.data(),static_cast<ULONG>(bytes.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG)!=0)throw std::runtime_error("random failed");
    const char* digits="0123456789abcdef";std::string out;
    for(auto b:bytes){out+=digits[b>>4];out+=digits[b&15];}return out;
}
std::string mime(const fs::path& p) {
    static const std::map<std::string,std::string> types{
        {".html","text/html; charset=utf-8"},{".htm","text/html; charset=utf-8"},
        {".js","text/javascript; charset=utf-8"},{".mjs","text/javascript; charset=utf-8"},
        {".css","text/css; charset=utf-8"},{".json","application/json"},{".txt","text/plain; charset=utf-8"},
        {".svg","image/svg+xml"},{".png","image/png"},{".jpg","image/jpeg"},{".jpeg","image/jpeg"},
        {".gif","image/gif"},{".webp","image/webp"},{".avif","image/avif"},{".ico","image/x-icon"},
        {".woff","font/woff"},{".woff2","font/woff2"},{".ttf","font/ttf"},{".otf","font/otf"},
        {".wasm","application/wasm"},{".mp3","audio/mpeg"},{".wav","audio/wav"},{".ogg","audio/ogg"},
        {".mp4","video/mp4"},{".webm","video/webm"},{".glb","model/gltf-binary"},{".gltf","model/gltf+json"},
        {".bin","application/octet-stream"},{".hdr","application/octet-stream"}};
    const auto found=types.find(lower(utf8(p.extension())));return found==types.end()?"":found->second;
}
struct Handles {
    std::vector<HANDLE> values;
    ~Handles(){for(auto h:values)CloseHandle(h);}
    HANDLE open(const fs::path& p,bool directory) {
        auto name=p.wstring();if(!name.starts_with(L"\\\\?\\"))name=L"\\\\?\\"+name;
        HANDLE h=CreateFileW(name.c_str(),directory?(FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES):GENERIC_READ,
            directory?(FILE_SHARE_READ|FILE_SHARE_WRITE):FILE_SHARE_READ,nullptr,OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT|(directory?FILE_FLAG_BACKUP_SEMANTICS:FILE_FLAG_SEQUENTIAL_SCAN),nullptr);
        if(h==INVALID_HANDLE_VALUE)throw std::runtime_error("resource unavailable");
        values.push_back(h);BY_HANDLE_FILE_INFORMATION info{};
        if(!GetFileInformationByHandle(h,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||
            bool(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=directory||(!directory&&info.nNumberOfLinks!=1))
            throw std::runtime_error("resource is not a regular local file");
        return h;
    }
};
struct DirectoryIdentity {
    DWORD volume{},high{},low{};
    bool operator==(const DirectoryIdentity&) const = default;
};
DirectoryIdentity directory_identity(HANDLE handle) {
    BY_HANDLE_FILE_INFORMATION info{};
    if(!GetFileInformationByHandle(handle,&info))throw std::runtime_error("resource identity unavailable");
    return {info.dwVolumeSerialNumber,info.nFileIndexHigh,info.nFileIndexLow};
}
struct Resource {std::string bytes;DirectoryIdentity root;};
void validate_relative(const fs::path& relative) {
    if(relative.empty()||relative.is_absolute()||relative.has_root_name())throw std::runtime_error("invalid relative path");
    for(const auto& part:relative) {
        const auto name=lower(utf8(part));
        if(name.empty()||name.front()=='.'||name=="node_modules"||name=="credentials.json"||name=="secrets.json"||
            name=="package-lock.json"||name=="package.json"||name.ends_with(".pem")||name.ends_with(".key"))
            throw std::runtime_error("resource outside preview");
    }
}
Resource read_resource(const fs::path& root,const fs::path& relative,bool content=true,const DirectoryIdentity* expected=nullptr) {
    validate_relative(relative);
    // Hold each directory without DELETE sharing, so a reparse-point/rename
    // race cannot redirect the subsequent handle open outside the grant root.
    Handles pins;auto cursor=root.root_path();auto root_handle=pins.open(cursor,true);
    for(const auto& part:root.relative_path()){cursor/=part;root_handle=pins.open(cursor,true);}
    const auto identity=directory_identity(root_handle);
    if(expected&&identity!=*expected)throw std::runtime_error("preview root has changed");
    for(const auto& part:relative.parent_path()){cursor/=part;pins.open(cursor,true);}
    auto h=pins.open(cursor/relative.filename(),false);LARGE_INTEGER size{};
    if(!GetFileSizeEx(h,&size)||size.QuadPart<0||size.QuadPart>32*1024*1024)throw std::runtime_error("resource too large");
    if(!content)return {{},identity};
    std::string bytes(static_cast<size_t>(size.QuadPart),'\0');size_t offset=0;
    while(offset<bytes.size()){DWORD got=0;if(!ReadFile(h,bytes.data()+offset,static_cast<DWORD>(std::min<size_t>(65536,bytes.size()-offset)),&got,nullptr)||!got)throw std::runtime_error("read failed");offset+=got;}
    return {std::move(bytes),identity};
}
HttpResponse rejected(int status){HttpResponse r;r.status=status;r.headers={{"content-type","text/plain; charset=utf-8"},{"cache-control","no-store"}};r.body="Preview resource unavailable";return r;}
}
struct PreviewService::Impl {
    struct Grant{fs::path root;DirectoryIdentity identity;Clock::time_point touched;SnapshotPaths snapshots;};
    std::mutex mutex;
    std::map<std::string,Grant> grants;
    HttpServer server{0,[this](const HttpRequest& r){return handle(r);},HttpAccessPolicy::IsolatedStatic};
    bool stopped=false;
    std::string origin()const{return "http://127.0.0.1:"+std::to_string(server.port());}
    std::string url(const fs::path& html, const fs::path& entry, const SnapshotPaths& snapshots) {
        const auto ext=lower(utf8(html.extension()));if(ext!=".html"&&ext!=".htm")return {};
        const auto absolute=fs::absolute(html).lexically_normal(),root=absolute.parent_path();
        // Fail closed for links/unreadable entries before granting a URL.
        const auto resource=read_resource(root,absolute.filename(),false);
        const auto relative = snapshots.empty() ? absolute.filename() : entry;
        validate_relative(relative);
        if (!snapshots.empty() && snapshots.at(relative) != absolute.filename()) return {};
        std::string encoded_path;
        for (const auto& part : relative) {
            encoded_path += "/" + encode(utf8(part));
        }
        std::lock_guard lock(mutex);if(stopped)return {};
        server.start();const auto now=Clock::now();
        std::erase_if(grants,[&](const auto& item){return now-item.second.touched>std::chrono::minutes(30);});
        std::string key;
        for(auto& [id,g]:grants)if(g.root==root&&g.identity==resource.root&&g.snapshots==snapshots){key=id;g.touched=now;break;}
        if(key.empty()){
            if(grants.size()>=128){auto oldest=std::min_element(grants.begin(),grants.end(),[](const auto& a,const auto& b){return a.second.touched<b.second.touched;});grants.erase(oldest);}
            key=token();grants.emplace(key,Grant{root,resource.root,now,snapshots});
        }
        return origin()+"/v/"+key+encoded_path;
    }
    HttpResponse handle(const HttpRequest& request) {
        try {
            if(!request.path.starts_with("/v/"))return rejected(404);
            const auto slash=request.path.find('/',3);if(slash!=67)return rejected(404);
            const auto key=request.path.substr(3,64);fs::path root;DirectoryIdentity expected;
            const auto relative=path8(decode(std::string_view(request.path).substr(slash+1)));
            validate_relative(relative);
            auto physical = relative;
            {std::lock_guard lock(mutex);const auto found=grants.find(key);if(found==grants.end()||Clock::now()-found->second.touched>std::chrono::minutes(30))return rejected(404);
                root=found->second.root;expected=found->second.identity;found->second.touched=Clock::now();
                if (!found->second.snapshots.empty()) {
                    const auto file = found->second.snapshots.find(relative);
                    if (file == found->second.snapshots.end()) return rejected(404);
                    physical = file->second;
                }}
            const auto type=mime(relative);if(type.empty())return rejected(404);
            HttpResponse response;response.body=read_resource(root,physical,true,&expected).bytes;
            if(type.starts_with("text/html")&&request.target.find("shim=1")!=std::string::npos){
                static constexpr std::string_view kShim=
                    "<script>(()=>{try{void window.localStorage.length}catch{"
                    "const mk=()=>{const m=new Map();return new Proxy({"
                    "get length(){return m.size},key:i=>[...m.keys()][i]??null,"
                    "getItem:k=>m.has(String(k))?m.get(String(k)):null,"
                    "setItem:(k,v)=>{m.set(String(k),String(v))},"
                    "removeItem:k=>{m.delete(String(k))},clear:()=>{m.clear()}"
                    "},{get:(t,p)=>p in t?t[p]:(m.has(String(p))?m.get(String(p)):undefined),"
                    "set:(t,p,v)=>{if(!(p in t))m.set(String(p),String(v));return true},"
                    "deleteProperty:(t,p)=>m.delete(String(p))})};"
                    "const ls=mk(),ss=mk();"
                    "Object.defineProperty(window,'localStorage',{get:()=>ls,configurable:true});"
                    "Object.defineProperty(window,'sessionStorage',{get:()=>ss,configurable:true});"
                    "}})();</script>";
                std::string low=response.body.substr(0,std::min<std::size_t>(response.body.size(),1024));
                for(char& c:low)if(c>='A'&&c<='Z')c=static_cast<char>(c-'A'+'a');
                auto ins=low.find("<head");
                if(ins!=std::string::npos){
                    const auto gt=low.find('>',ins);
                    if(gt!=std::string::npos)response.body.insert(gt+1,kShim);
                    else response.body.insert(0,kShim);
                }else if(const auto dt=low.find("<!doctype");dt!=std::string::npos){
                    const auto gt=low.find('>',dt);
                    response.body.insert(gt!=std::string::npos?gt+1:0,kShim);
                }else{
                    response.body.insert(0,kShim);
                }
            }
            const auto scope=origin()+"/v/"+key+"/";
            response.headers={{"content-type",type},{"cache-control","no-store"},{"access-control-allow-origin","*"},
                {"referrer-policy","no-referrer"},{"cross-origin-resource-policy","cross-origin"},
                {"content-security-policy","default-src 'none'; sandbox allow-scripts; script-src "+scope+" 'unsafe-inline' 'unsafe-eval'; style-src "+scope+" 'unsafe-inline'; img-src "+scope+" data: blob:; font-src "+scope+" data:; media-src "+scope+" blob:; connect-src "+scope+"; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri "+scope+"; form-action 'none'"}};
            return response;
        }catch(...){return rejected(404);}
    }
};
PreviewService::PreviewService():impl_(std::make_unique<Impl>()){}
PreviewService::~PreviewService(){shutdown();}
std::string PreviewService::url(const fs::path& html,const fs::path& entry,const SnapshotPaths& snapshots){return impl_->url(html,entry,snapshots);}
void PreviewService::shutdown() noexcept{
    {std::lock_guard lock(impl_->mutex);impl_->stopped=true;}
    impl_->server.stop();
}
}
