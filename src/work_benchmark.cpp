#include "dimension/work_benchmark.hpp"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <map>
#include <set>
#include <sstream>

namespace dimension {
namespace {
using A=Json::Array; using O=Json::Object;
std::vector<std::string> fields(std::string line){
    while(!line.empty() && line.back()=='\r')line.pop_back();
    std::vector<std::string> out; size_t i=0;
    for(;;){auto j=line.find(',',i);out.emplace_back(line.substr(i,j-i));if(j==line.npos)return out;i=j+1;}
}
}
Json parse_livebench_scores(const Json& categories,const std::string& csv){
    std::istringstream in(csv);std::string line;
    if(!std::getline(in,line))throw std::runtime_error("empty benchmark");
    auto header=fields(line);if(header.empty()||header.front()!="model")throw std::runtime_error("unknown benchmark schema");
    std::map<std::string,std::vector<size_t>> columns;
    for(auto key:{"Coding","Agentic Coding","Reasoning","Data Analysis","Mathematics","Language","IF"}){
        const auto* tasks=categories.find(key);if(!tasks||!tasks->is_array()||tasks->as_array().empty())continue;
        std::vector<size_t> cols;
        for(const auto& t:tasks->as_array()){auto it=std::find(header.begin()+1,header.end(),t.as_string());if(it==header.end()){cols.clear();break;}cols.push_back(it-header.begin());}
        if(!cols.empty())columns[key]=std::move(cols);
    }
    std::map<std::string,std::vector<std::pair<double,std::string>>> scores;
    std::set<std::string> models;
    while(std::getline(in,line)){
        auto row=fields(line);if(row.size()!=header.size()||row[0].empty()||row[0].size()>256)continue;
        if(!models.insert(row[0]).second)throw std::runtime_error("duplicate leaderboard model");
        for(const auto& [key,cols]:columns){
            double sum=0;bool valid=true;
            for(auto c:cols){double x=0;const auto& v=row[c];auto p=std::from_chars(v.data(),v.data()+v.size(),x);
                if(p.ec!=std::errc{}||p.ptr!=v.data()+v.size()||!std::isfinite(x)||x<0||x>100){valid=false;break;}sum+=x;}
            if(valid)scores[key].emplace_back(sum/cols.size(),row[0]);
        }
    }
    O result;
    for(auto& [key,rows]:scores){
        std::sort(rows.rbegin(),rows.rend());int rank=0;
        for(size_t i=0;i<rows.size();i++){const auto& [score,id]=rows[i];if(!i||score!=rows[i-1].first)rank=int(i)+1;
            if(!result.contains(id)) result[id]=O{};
            result[id][key]=O{{"rank",rank},{"of",static_cast<int>(rows.size())},{"score",std::round(score*100)/100}};
        }
    }
    if(result.empty())throw std::runtime_error("missing leaderboard scores");
    return result;
}
Json WorkBenchmark::get(std::stop_token stop){
    using Clock=std::chrono::steady_clock;
    {
        std::lock_guard guard(mutex_);
        if(loading_||Clock::now()<retry_)return snapshot_;
        loading_=true;
    }
    Json next;bool ok=false;
    try{
        const auto index=Json::parse(fetch_livebench_file("index",stop));std::set<std::string> names;
        for(const auto& f:index.as_array()){const auto* n=f.find("name");if(n&&n->is_string())names.insert(n->as_string());}
        std::string date;
        for(const auto& n:names)if(n.size()==20 && n.starts_with("table_")&&n.ends_with(".csv")){
            auto d=n.substr(6,10);if(names.contains("categories_"+d+".json") && d>date)date=d;
        }
        if(date.empty())throw std::runtime_error("no paired benchmark release");
        auto cats=Json::parse(fetch_livebench_file("categories_"+date+".json",stop));
        auto scores=parse_livebench_scores(cats,fetch_livebench_file("table_"+date+".csv",stop));
        auto source="https://github.com/LiveBench/LiveBench.github.io/blob/main/public/table_"+date+".csv";
        std::replace(date.begin(),date.end(),'_','-');
        next=O{{"release",date},{"source",source},{"scores",std::move(scores)},{"status","available"}};ok=true;
    }catch(const std::exception&){}
    std::lock_guard guard(mutex_);loading_=false;
    if(ok)snapshot_=std::move(next);
    else if(snapshot_.is_object())snapshot_["status"]="stale";
    retry_=Clock::now()+(ok?std::chrono::minutes(360):std::chrono::minutes(5));
    return snapshot_;
}
}
