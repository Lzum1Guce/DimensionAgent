#define NOMINMAX
#include "dimension/preview.hpp"
#include "dimension/http.hpp"
#include "dimension/atomic_file.hpp"
#include <windows.h>
#include <winhttp.h>
#include <filesystem>
#include <iostream>
#include <stdexcept>
namespace {
namespace fs=std::filesystem;
void check(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
std::wstring native(fs::path value){value.make_preferred();return L"\\\\?\\"+value.wstring();}
struct Result{unsigned long status;std::string body;std::wstring headers;};
Result request(std::string url,const wchar_t* method=L"GET",const wchar_t* headers=L"Origin: null\r\nSec-Fetch-Site: cross-site\r\n"){
    std::wstring target(url.begin(),url.end());URL_COMPONENTS parts{};parts.dwStructSize=sizeof(parts);parts.dwHostNameLength=parts.dwUrlPathLength=parts.dwExtraInfoLength=static_cast<DWORD>(-1);
    check(WinHttpCrackUrl(target.c_str(),0,0,&parts),"url");auto session=WinHttpOpen(L"preview-test",WINHTTP_ACCESS_TYPE_NO_PROXY,nullptr,nullptr,0);
    check(session,"session");auto host=std::wstring(parts.lpszHostName,parts.dwHostNameLength),path=std::wstring(parts.lpszUrlPath,parts.dwUrlPathLength);
    if(parts.lpszExtraInfo&&parts.dwExtraInfoLength)path.append(parts.lpszExtraInfo,parts.dwExtraInfoLength);
    auto connection=WinHttpConnect(session,host.c_str(),parts.nPort,0),req=WinHttpOpenRequest(connection,method,path.c_str(),nullptr,nullptr,nullptr,0);
    WinHttpSetTimeouts(req,3000,3000,3000,3000);
    check(WinHttpSendRequest(req,headers,static_cast<DWORD>(-1),nullptr,0,0,0)&&WinHttpReceiveResponse(req,nullptr),"request");
    Result result{};DWORD size=sizeof(result.status);check(WinHttpQueryHeaders(req,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,nullptr,&result.status,&size,nullptr),"status");
    DWORD length=0;WinHttpQueryHeaders(req,WINHTTP_QUERY_RAW_HEADERS_CRLF,nullptr,nullptr,&length,nullptr);result.headers.resize(length/sizeof(wchar_t));
    WinHttpQueryHeaders(req,WINHTTP_QUERY_RAW_HEADERS_CRLF,nullptr,result.headers.data(),&length,nullptr);
    for(;;){char bytes[4096];DWORD got=0;check(WinHttpReadData(req,bytes,sizeof bytes,&got),"read");if(!got)break;result.body.append(bytes,got);}
    WinHttpCloseHandle(req);WinHttpCloseHandle(connection);WinHttpCloseHandle(session);return result;
}
}
int wmain(int argc,wchar_t** argv){
    try{
        const auto root=fs::absolute(fs::path(argc>1?argv[1]:L"test-data/preview"))/std::to_string(GetCurrentProcessId());fs::create_directories(root);
        dimension::atomic_write_file(root/"index.html","<!doctype html><script src='main.js'></script>");
        dimension::atomic_write_file(root/"main.js","document.title='actual-script';");
        dimension::atomic_write_file(root/".env","SYNTHETIC_SECRET");
        dimension::atomic_write_file(root/"outside.txt","outside");
        fs::create_hard_link(root/"outside.txt",root/"linked.txt");
        {std::error_code sym_ec;fs::create_symlink(root/"outside.txt",root/"symlink.txt",sym_ec);}
        dimension::PreviewService preview;const auto url=preview.url(root/"index.html");check(!url.empty(),"url grant");
        const auto prefix=url.substr(0,url.find_last_of('/')+1),base=url.substr(0,url.find("/v/"));
        auto page=request(url);check(page.status==200&&page.body=="<!doctype html><script src='main.js'></script>","HTML cross-origin");
        auto shimmed=request(url+"?shim=1");
        check(shimmed.status==200&&shimmed.body.starts_with("<!doctype html><script>")&&shimmed.body.find("localStorage")!=std::string::npos,"opaque storage shim preserves doctype");
        check(page.headers.find(L"sandbox allow-scripts")!=page.headers.npos,"opaque document CSP");
        check(page.headers.find(L"Access-Control-Allow-Origin: *")!=page.headers.npos||page.headers.find(L"access-control-allow-origin: *")!=page.headers.npos,"module CORS");
        check(request(prefix+"main.js").body=="document.title='actual-script';","relative module");
        check(request(url,L"POST").status==403,"no mutations");
        check(request(base+"/api/status").status==404,"no app API");
        for(const auto* name:{".env","%2Eenv","../outside.txt","linked.txt","symlink.txt","%5Coutside.txt","C%3A/outside.txt"})
            check(request(prefix+name).status==404,"denies path escape or linked resource");
        check(request(base+"/v/"+std::string(64,'0')+"/index.html").status==404,"ungranted token");
        check(preview.url(root/"main.js").empty(),"only HTML is interactive");
        check(preview.url(root/"index.html")==url,"grant reuse");
        const auto granted=root/L"grant-identity",moved=root/L"grant-identity-moved";
        check(granted.is_absolute()&&granted.parent_path()==root&&moved.parent_path()==root,"owned preview fixture boundary");
        dimension::atomic_write_file(granted/L"index.html","original granted directory");
        const auto original_url=preview.url(granted/L"index.html");
        check(request(original_url).body=="original granted directory","initial root identity");
        check(MoveFileExW(native(granted).c_str(),native(moved).c_str(),0),"idle preview grant does not lock project moves");
        dimension::atomic_write_file(granted/L"index.html","replacement directory sentinel");
        const auto stale=request(original_url);
        check(stale.status==404&&stale.body.find("replacement directory sentinel")==std::string::npos,"stale grant rejects replaced directory identity");
        const auto replacement_url=preview.url(granted/L"index.html");
        check(replacement_url!=original_url&&request(replacement_url).body=="replacement directory sentinel","replacement root requires a new grant");
        check(DeleteFileW(native(granted/L"index.html").c_str()),"idle preview grant does not lock artifact deletion");
        check(RemoveDirectoryW(native(granted).c_str()),"idle preview grant does not lock project deletion");
        check(request(replacement_url).status==404,"deleted project is unavailable");
        dimension::HttpServer api(0,[](const auto&){dimension::HttpResponse r;r.body="private";r.headers["access-control-allow-origin"]="*";return r;});api.start();
        const auto api_url="http://127.0.0.1:"+std::to_string(api.port())+"/api/status";
        check(request(api_url).status==403,"default API still rejects opaque origin");
        auto normal=request(api_url,L"GET",L"");check(normal.status==200,"default API still works");
        check(normal.headers.find(L"allow-origin")==normal.headers.npos,"API cannot enable CORS");
        preview.shutdown();api.stop();std::cout<<"preview isolation, resource boundaries and default API protection passed\n";return 0;
    }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
