#define NOMINMAX
#include "dimension/application_bridge.hpp"
#include "dimension/desktop.hpp"
#include <windows.h>
#include <wincrypt.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <mutex>
#include <thread>

using namespace dimension;
namespace fs=std::filesystem;
using O=Json::Object;
using A=Json::Array;
std::atomic_int checks=0;
void check(bool value,const char*message){if(!value)throw std::runtime_error(message);++checks;}
template<class F>void rejects(F fn,int status,const char*message){try{fn();}catch(const ApplicationBridgeError&e){check(e.status==status,message);return;}throw std::runtime_error(message);}
template<class F>void rejects_effect(F fn,bool no_effects,const char*message){try{fn();}catch(const ApplicationBridgeError&e){check(e.status==409&&e.no_side_effects==no_effects,message);return;}throw std::runtime_error(message);}
std::string field(const Json&j,const char*k){auto v=j.find(k);return v&&v->is_string()?v->as_string():"";}
bool actual_file(const fs::path&p){const auto a=GetFileAttributesW((L"\\\\?\\"+p.wstring()).c_str());return a!=INVALID_FILE_ATTRIBUTES&&!(a&FILE_ATTRIBUTE_DIRECTORY);}
std::string base64(std::string_view bytes){
 DWORD n=0;CryptBinaryToStringA(reinterpret_cast<const BYTE*>(bytes.data()),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,nullptr,&n);
 std::string s(n,'\0');CryptBinaryToStringA(reinterpret_cast<const BYTE*>(bytes.data()),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,s.data(),&n);s.resize(n);return s;
}
std::string decode(const std::string&s){DWORD n=0;CryptStringToBinaryA(s.c_str(),static_cast<DWORD>(s.size()),CRYPT_STRING_BASE64,nullptr,&n,nullptr,nullptr);std::string out(n,'\0');CryptStringToBinaryA(s.c_str(),static_cast<DWORD>(s.size()),CRYPT_STRING_BASE64,reinterpret_cast<BYTE*>(out.data()),&n,nullptr,nullptr);return out;}
const std::string png64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
struct Fixture{
 std::mutex mutex;
 std::map<std::string,std::string> images;
 bool running=false,human=false;
 std::atomic_int launches=0,actions=0;
 ApplicationBridgeCallbacks callbacks(){
  ApplicationBridgeCallbacks c;
  c.status=[&](const std::string&id,std::stop_token){check(id=="@application/doubao"||id=="@application/studio","dedicated desktop identity");std::lock_guard l(mutex);return Json(O{{"available",true},{"running",running},{"humanControl",human},{"launchToken","launch-1"}});};
  c.action=[&](const std::string&,const Json&a,std::stop_token){
   std::lock_guard l(mutex);if(human)throw DesktopError("human_control","Human owns keyboard",true,true);
   auto op=field(a,"op");if(op=="launch"){++launches;running=true;}else if(op!="observe")++actions;
   return Json(O{{"png",png64},{"width",1},{"height",1},{"observationId","observe-1"},{"running",running},{"humanControl",false},{"windowTitle","Synthetic application window"}});
  };
  c.downloads=[&](const std::string&,const Json&j,std::stop_token){
   std::lock_guard l(mutex);
   if(j.find("name")){
    auto name=field(j,"name");auto it=images.find(name);if(it==images.end())throw DesktopError("missing","download missing");
    auto offset=static_cast<std::size_t>(j.at("offset").as_number());
    return Json(O{{"name",name},{"snapshot",name+"-snapshot"},{"offset",double(offset)},{"total",double(it->second.size())},{"data",base64(it->second.substr(offset))}});
   }
   A list;for(const auto&[name,bytes]:images)list.push_back(O{{"name",name},{"snapshot",name+"-snapshot"},{"bytes",double(bytes.size())}});
   return Json(O{{"files",list}});
  };
  c.inspect_image=[](std::string_view bytes){if(bytes.size()<8||bytes.substr(1,3)!="PNG")throw ApplicationBridgeError(415,"not PNG");return Json(O{{"mime","image/png"},{"width",1},{"height",1}});};
  return c;
 }
};
ToolExecution call(ApplicationBridge&bridge,const std::string&name,const Json&args,const RunExecutionContext&ctx,const std::string&id="call-1",std::stop_token stop={}){
 return bridge.execute(ToolCall{id,name,args.dump()},ctx,stop);
}
std::string await_job(ApplicationBridge& bridge,const std::string& run){
 const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(3);
 do{
  const auto state=bridge.list();for(const auto& j:state.at("jobs").as_array())if(field(j,"runId")==run)return field(j,"id");
  std::this_thread::sleep_for(std::chrono::milliseconds(2));
 }while(std::chrono::steady_clock::now()<deadline);
 throw std::runtime_error("queued job was not persisted");
}
void ownership_restart(const fs::path& base){
 Fixture fixture;fixture.images["old.png"]=decode(png64);
 RunExecutionContext a{"ownership-a","bot-alpha","",1},b{"ownership-b","bot-beta","",1};
 std::string first,second;
 const Json action=O{{"op","press"},{"key","Enter"},{"observationId","observe-1"}};
 {
  ApplicationBridge bridge(base/L"services",base/L"workspaces",fixture.callbacks());
  first=field(Json::parse(call(bridge,"application_start",O{{"appId","doubao"},{"prompt","first owner"}},a,"start-a").result).at("job"),"id");
  call(bridge,"application_wait",O{{"jobId",first},{"status","waiting-user"},{"reason","synthetic pause"}},a);
  bridge.resume(first);
  std::stop_source stop;
  auto queued=std::async(std::launch::async,[&]{return call(bridge,"application_start",O{{"appId","doubao"},{"prompt","queued second"}},b,"start-b",stop.get_token());});
  struct StopOnExit{std::stop_source& source;~StopOnExit(){source.request_stop();}} cleanup{stop};
  second=await_job(bridge,b.run_id);
  check(queued.wait_for(std::chrono::milliseconds(50))==std::future_status::timeout,"resume retains first desktop owner");
  rejects_effect([&]{call(bridge,"application_action",O{{"jobId",first},{"action",action}},a);},true,"resumed owner input rejects without dispatch");
  rejects_effect([&]{call(bridge,"application_collect",O{{"jobId",first}},a);},true,"resumed owner collection rejects without dispatch");
  rejects_effect([&]{call(bridge,"application_action",O{{"jobId",second},{"action",action}},b);},true,"queued job input rejects without dispatch");
  rejects_effect([&]{call(bridge,"application_collect",O{{"jobId",second}},b);},true,"queued job cannot collect another owner and remains retryable");
  check(fixture.actions==0,"rejected queued/resumed actions have no effect");
  stop.request_stop();rejects_effect([&]{queued.get();},true,"queued wait cancellation has not dispatched");
  check(field(bridge.job(second),"status")=="queued"&&!bridge.job(second).at("started").as_bool(),"cancelled wait remains an unstarted queue entry");
 }
 {
  ApplicationBridge bridge(base/L"services",base/L"workspaces",fixture.callbacks());
  check(field(bridge.job(first),"status")=="needs-review"&&field(bridge.job(second),"status")=="queued","restart preserves active owner plus unstarted queue");
  check(call(bridge,"application_observe",O{{"jobId",first}},a).images.size()==1,"active owner resumes without queued restart deadlock");
  {std::lock_guard lock(fixture.mutex);fixture.images["first.png"]=decode(png64);}
  check(call(bridge,"application_collect",O{{"jobId",first}},a).artifacts.size()==1,"first owner collects own output");
  check(call(bridge,"application_observe",O{{"jobId",second}},b).images.size()==1,"second acquires released desktop");
  rejects_effect([&]{call(bridge,"application_collect",O{{"jobId",second}},b);},true,"empty collection remains retryable when a later download arrives");
  {std::lock_guard lock(fixture.mutex);fixture.images["second.png"]=decode(png64);}
  check(call(bridge,"application_collect",O{{"jobId",second}},b).artifacts.size()==1,"second collects only its subsequent output");
 }
}
void cancellation_drain(const fs::path& base){
 Fixture fixture;
 std::promise<void> entered,release;auto arrived=entered.get_future();auto released=release.get_future().share();std::atomic_bool opened=false;
 auto callbacks=fixture.callbacks();auto original=callbacks.downloads;
 callbacks.downloads=[&](const std::string& desktop,const Json& args,std::stop_token stop){
  if(args.find("name")){entered.set_value();released.wait();}
  return original(desktop,args,stop);
 };
 ApplicationBridge bridge(base/L"services",base/L"workspaces",callbacks);
 RunExecutionContext a{"drain-a","bot-alpha","",1},b{"drain-b","bot-beta","",1};
 const auto first=field(Json::parse(call(bridge,"application_start",O{{"appId","doubao"},{"prompt","draining first"}},a,"start-a").result).at("job"),"id");
 {std::lock_guard lock(fixture.mutex);fixture.images["late-first.png"]=decode(png64);}
 std::future<ToolExecution> collecting,queued;std::stop_source stop;
 const auto open=[&]{if(!opened.exchange(true))release.set_value();};
 struct Cleanup{std::function<void()> fn;~Cleanup(){fn();}} cleanup{[&]{open();stop.request_stop();}};
 collecting=std::async(std::launch::async,[&]{return call(bridge,"application_collect",O{{"jobId",first}},a);});
 check(arrived.wait_for(std::chrono::seconds(3))==std::future_status::ready,"collection callback reached in-flight gate");
 rejects([&]{call(bridge,"application_collect",O{{"jobId",first}},a);},409,"same job cannot overlap desktop operations");
 bridge.cancel(first);
 queued=std::async(std::launch::async,[&]{return call(bridge,"application_start",O{{"appId","doubao"},{"prompt","draining second"}},b,"start-b",stop.get_token());});
 const auto second=await_job(bridge,b.run_id);
 check(queued.wait_for(std::chrono::milliseconds(50))==std::future_status::timeout,"cancellation reserves desktop until callback drains");
 rejects([&]{call(bridge,"application_collect",O{{"jobId",second}},b);},409,"successor cannot collect while prior callback drains");
 open();
 rejects_effect([&]{collecting.get();},false,"cancelled in-flight collect rejects late publication conservatively");
 check(queued.wait_for(std::chrono::seconds(3))==std::future_status::ready,"next job acquires after callback drains");
 check(queued.get().images.size()==1,"next job observes after drain");
 check(field(bridge.job(first),"status")=="cancelled"&&bridge.job(first).at("files").as_array().empty(),"cancelled job never publishes late files");
 rejects([&]{call(bridge,"application_collect",O{{"jobId",second}},b);},409,"late predecessor output enters successor baseline");
}
// Native HTTP integration can use this executable as its external JSON peer.
// It has no desktop, shell, network, account or keyboard/mouse implementation.
// All controls and evidence stay in the fixture-owned process working directory.
int protocol_peer(){
 const auto local=[](const char* name){return fs::path(L"\\\\?\\"+fs::absolute(name).wstring());};
 const auto send=[](const Json& j){std::cout<<j.dump()<<std::endl;};
 const auto log=[&](const std::string& op){std::ofstream file(local("peer-history.jsonl"),std::ios::app|std::ios::binary);
  file<<Json(O{{"op",op},{"milliseconds",double(GetTickCount64())}}).dump()<<'\n';};
 const auto names=[&] {
  std::ifstream file(local("peer-downloads.json"),std::ios::binary);if(!file)return A{};
  const std::string bytes{std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};return Json::parse(bytes).at("names").as_array();
 };
 log("peer_started");send(O{{"event","ready"},{"width",1},{"height",1},{"previewFps",0}});
 std::string line;
 while(std::getline(std::cin,line)){
  const auto request=Json::parse(line);const auto op=field(request,"op");log(op);Json result=O{};
  if(op=="observe")result=O{{"png",png64},{"width",1},{"height",1},{"windowTitle","Synthetic application peer"}};
  if(op=="downloads"){
   A files;for(const auto& name:names())files.push_back(O{{"name",name},{"snapshot",name.as_string()+"-snapshot"},{"bytes",double(decode(png64).size())}});
   result=O{{"files",files}};
  }
  if(op=="download_read"){
   if(fs::exists(local("peer-block-download"))){
    std::ofstream(local("peer-download-entered"),std::ios::binary)<<"entered";
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(3);
    while(!fs::exists(local("peer-release-download"))&&std::chrono::steady_clock::now()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(2));
    log("download_released");
   }
   const auto name=field(request,"name");const auto bytes=decode(png64);const auto offset=static_cast<std::size_t>(request.at("offset").as_number());
   if(offset>bytes.size())throw std::runtime_error("fixture offset outside image");
   result=O{{"name",name},{"snapshot",name+"-snapshot"},{"offset",double(offset)},{"total",double(bytes.size())},{"data",base64(bytes.substr(offset))},{"eof",true}};
  }
  send(O{{"id",request.at("id")},{"ok",true},{"result",result}});
 }
 log("peer_exited");return 0;
}
int wmain(int argc,wchar_t**argv){
 try{
  if(argc>2&&std::wstring(argv[1])==L"-d"&&std::wstring(argv[2])==L"application-ownership-fixture")return protocol_peer();
  if(argc!=2)throw std::runtime_error("isolated output directory required");
  const auto base=fs::absolute(argv[1])/std::to_wstring(GetTickCount64());fs::create_directories(base);
  const auto sentinel=base/L"external-sentinel.txt";std::ofstream(sentinel,std::ios::binary)<<"external sentinel";
  fs::create_directories(base/L"services");
  check(CreateHardLinkW((base/L"services"/L"services.json.pending").c_str(),sentinel.c_str(),nullptr),"application pending hardlink fixture");
  Fixture fixture;fixture.images["old.png"]=decode(png64);
  RunExecutionContext ctx{"run-fixture","bot-alpha","",1},other{"run-other","bot-beta","",1};
  std::string first,waiting;
  {
   ApplicationBridge bridge(base/L"services",base/L"workspaces",fixture.callbacks());
   check(bridge.list().at("apps").as_array().size()==1,"default official app");
   auto status=bridge.status("doubao");check(field(status,"accountStatus")=="unknown"&&!status.at("desktopRunning").as_bool(),"not falsely logged in");
   rejects([&]{bridge.register_app(O{{"id","../../escape"},{"name","bad"},{"url","https://example.invalid"}});},400,"reject app path");
   rejects([&]{bridge.register_app(O{{"id","bad"},{"name","bad"},{"url","file:///C:/"}});},400,"reject file URL");
   auto custom=bridge.register_app(O{{"id","studio"},{"name","工作室"},{"url","https://example.invalid/"},{"instructions","下载实际原图"}});
   check(!custom.at("enabled").as_bool(),"new app disabled");
   bridge.update_app("studio",O{{"enabled",true}});
   auto started=call(bridge,"application_start",O{{"appId","doubao"},{"prompt","合成测试图片"}},ctx);
   first=field(Json::parse(started.result).at("job"),"id");check(!first.empty()&&started.images.size()==1,"start returns real pixels/job");
   check(fixture.launches==1,"one actual launch");
   call(bridge,"application_start",O{{"appId","doubao"},{"prompt","合成测试图片"}},ctx,"call-new");
   check(fixture.launches==1,"same active request reuses app job");
   rejects([&]{call(bridge,"application_observe",O{{"jobId",first}},other);},403,"cross Bot cannot observe");
   auto private_status=Json::parse(call(bridge,"application_status",O{},other).result);
   bool saw_occupier=false;
   for(const auto& job:private_status.at("jobs").as_array())
    if(field(job,"id")==first&&field(job,"botId")==ctx.bot_id&&job.at("desktopOwned").as_bool())saw_occupier=true;
   check(saw_occupier,"status without jobId lists desktop occupiers from other bots/runs");
   rejects([&]{call(bridge,"application_collect",O{{"jobId",first}},ctx);},409,"old download is not new output");
   bridge.update_app("doubao",O{{"enabled",false}});
   rejects([&]{call(bridge,"application_action",O{{"jobId",first},{"action",O{{"op","press"},{"key","Enter"},{"observationId","observe-1"}}}},ctx);},409,"disabled blocks input");
   check(fixture.actions==0,"disabled no input effect");
   bridge.update_app("doubao",O{{"enabled",true}});
   call(bridge,"application_action",O{{"jobId",first},{"phase","submitting"},{"action",O{{"op","press"},{"key","Enter"},{"observationId","observe-1"}}}},ctx);
   check(fixture.actions==1,"explicit submit performed once");
   rejects([&]{call(bridge,"application_action",O{{"jobId",first},{"phase","submitting"},{"action",O{{"op","press"},{"key","Enter"},{"observationId","observe-1"}}}},ctx);},409,"repeated submit blocked");
   auto pause=call(bridge,"application_wait",O{{"jobId",first},{"status","waiting-verification"},{"reason","Synthetic site requires human verification"}},ctx);
   check(!pause.pause_reason.empty()&&field(bridge.job(first),"status")=="waiting-verification","verification pauses transparently");
   bridge.resume(first);call(bridge,"application_observe",O{{"jobId",first}},ctx);
   check(fixture.launches==1&&fixture.actions==1,"resume only observes");
   {
    std::lock_guard lock(fixture.mutex);fixture.images["bad.png"]="not an image";
   }
   rejects([&]{call(bridge,"application_collect",O{{"jobId",first}},ctx);},415,"bad image never completes");
   check(field(bridge.job(first),"status")!="completed","bad image no completion");
   {std::lock_guard lock(fixture.mutex);fixture.images.erase("bad.png");fixture.images["new.png"]=decode(png64);}
   auto result=call(bridge,"application_collect",O{{"jobId",first},{"names",A{"new.png"}}},ctx);
   check(result.artifacts.size()==1&&!result.verification.empty(),"verified real file evidence");
   check(actual_file(bridge.file(first,0))&&field(bridge.job(first),"status")=="completed","file persists before complete");
   rejects([&]{bridge.file(first,1);},404,"invalid file index");
   rejects([&]{bridge.file("../../escape",0);},404,"file path escape rejected");
   auto next=call(bridge,"application_start",O{{"appId","doubao"},{"prompt","下一张图"}},other,"next");
   waiting=field(Json::parse(next.result).at("job"),"id");
   fixture.human=true;
   auto human=call(bridge,"application_observe",O{{"jobId",waiting}},other);
   check(human.error&&!human.pause_reason.empty()&&field(bridge.job(waiting),"status")=="waiting-user","human takeover pauses");
   fixture.human=false;
   bridge.shutdown();
  }
  {
   ApplicationBridge bridge(base/L"services",base/L"workspaces",fixture.callbacks());
   check(field(bridge.job(first),"status")=="completed"&&actual_file(bridge.file(first,0)),"restart completed file stable");
   check(field(bridge.job(waiting),"status")=="needs-review","restart unfinished needs review");
   check(!bridge.job(waiting).at("desktopOwned").as_bool(),"needs-review releases desktop ownership");
   auto resumed=call(bridge,"application_observe",O{{"jobId",waiting}},other);
   check(resumed.images.size()==1&&fixture.launches==1,"restart observes existing browser instead of resubmitting");
   bridge.cancel(waiting);check(field(bridge.job(waiting),"status")=="cancelled","cancel durable");
   std::stop_source stop;stop.request_stop();
   rejects([&]{call(bridge,"application_start",O{{"appId","doubao"},{"prompt","取消中"}},ctx,"cancelled",stop.get_token());},409,"cancel token no new action");
  }
  std::ifstream external(sentinel,std::ios::binary);const std::string unchanged{std::istreambuf_iterator<char>(external),std::istreambuf_iterator<char>()};
  check(unchanged=="external sentinel","application save never touches external pending hardlink");
  ownership_restart(base/L"ownership");cancellation_drain(base/L"drain");
  std::cout<<"PASS application_bridge "<<checks.load()<<" checks\n";return 0;
 }catch(const std::exception&e){std::cerr<<"FAIL application_bridge: "<<e.what()<<"\n";return 1;}
}
