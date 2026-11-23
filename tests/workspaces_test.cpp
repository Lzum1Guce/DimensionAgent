#define NOMINMAX
#include "dimension/workspaces.hpp"
#include "dimension/managed_workspaces.hpp"
#include <windows.h>
#include <fstream>
#include <iostream>
namespace fs=std::filesystem;
int wmain(int argc,wchar_t**argv){
 try{
  if(argc!=2)return 2;const auto base=fs::absolute(argv[1])/std::to_wstring(GetCurrentProcessId());fs::create_directories(base);
  auto one=base/L"first",two=base/L"second";
  const auto sentinel=base/L"external-sentinel.txt";
  std::ofstream(sentinel,std::ios::binary)<<"external sentinel";
  fs::create_directories(base/L"bindings");
  if(!CreateHardLinkW((base/L"bindings"/L"run-1.json.pending").c_str(),sentinel.c_str(),nullptr))throw std::runtime_error("pending hardlink fixture");
  {dimension::WorkspaceBindings b(base/L"bindings",base/L"tasks");
   if(b.bind("run-1","bot-one",one)!=one)throw std::runtime_error("first root");
   if(b.bind("run-1","bot-one",two)!=one)throw std::runtime_error("old task retargeted");
   if(b.bind("run-2","bot-one",two)!=two)throw std::runtime_error("new task root");
   bool blocked=false;try{b.project("run-1","bot-two");}catch(...){blocked=true;}if(!blocked)throw std::runtime_error("cross bot binding");
   blocked=false;try{b.task("../escape");}catch(...){blocked=true;}if(!blocked)throw std::runtime_error("escaping task");
   if(!b.project("run-unknown","bot-one").empty())throw std::runtime_error("unbound task fabricated");
  }
  {dimension::WorkspaceBindings b(base/L"bindings",base/L"tasks");
   if(b.project("run-1","bot-one")!=one||b.project("run-2","bot-one")!=two)throw std::runtime_error("restart binding");
   if(b.describe("run-1","bot-one").at("sandboxProject").as_string()!="/workspace")throw std::runtime_error("sandbox contract");
   bool blocked=false;try{b.bind("run-3","bot-one",base.root_path());}catch(...){blocked=true;}if(!blocked)throw std::runtime_error("whole volume allowed");
   std::ofstream(base/L"file")<<"not a directory";
   blocked=false;try{b.bind("run-3","bot-one",base/L"file");}catch(...){blocked=true;}if(!blocked)throw std::runtime_error("file as project");
  }
  std::ifstream external(sentinel,std::ios::binary);const std::string unchanged{std::istreambuf_iterator<char>(external),std::istreambuf_iterator<char>()};
  if(unchanged!="external sentinel")throw std::runtime_error("workspace binding changed an external pending hardlink");
  namespace mw=dimension::managed_workspaces;const std::string key="bot-11111111111111111111111111111111";
  const auto managed=mw::windows_path("dimension-sandbox",key);
  if(mw::key_from_windows(managed,"dimension-sandbox")!=std::optional<std::string>(key))throw std::runtime_error("managed root identity");
  if(mw::key_from_windows_any(managed)!=std::optional<std::string>(key))throw std::runtime_error("managed root discovery");
  if(mw::key_from_windows_any_descendant(managed/L"incoming"/L"a.txt")!=std::optional<std::string>(key))throw std::runtime_error("managed descendant identity");
  if(mw::key_from_windows(managed,"other-distro"))throw std::runtime_error("cross-distro managed identity");
  std::cout<<"workspaces: 15 checks passed\n";return 0;
 }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}
}
