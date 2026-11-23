// Group Work planning and execution share the same provider/model identifiers.
Json Application::Impl::group_route_inventory(const RunExecutionContext& ctx,std::stop_token stop) {
    const auto providers=provider_map(), metadata=meta.get(), settings=obj(metadata,"workModels");
    const auto configured=obj(settings,"routes"), members=group(ctx.group_id).at("members");
    const auto board=options.provider_file.empty()?work_benchmark.get(stop):Json{};
    std::vector<ProviderCatalogQuery> queries;
    for(const auto& [id,p]:providers.as_object())queries.push_back(catalog_query(id,p));
    std::vector<ProviderCatalogQuery> refresh;
    for(const auto& q:queries){
        auto state=model_catalog.query(q,false).status;
        if(state=="unrefreshed"||state=="stale")refresh.push_back(q);
    }
    if(!refresh.empty()&&!stop.stop_requested())model_catalog.query_all(refresh,true,stop);
    O catalogs;
    for(const auto& q:queries){
        auto view=model_catalog.query(q,false);A listed;
        for(const auto& id:view.listed_models)listed.emplace_back(id);
        catalogs[q.provider_id]=O{{"status",view.status},{"listed",listed},{"checkedAt",view.updated_at}};
    }
    auto describe=[&](const Json& selection,const std::string& tier)->Json{
        auto pid=str(selection,"providerId",default_provider());
        const auto* provider=providers.find(pid);if(!provider)return {};
        auto model=str(selection,"model",str(obj(obj(*provider,"entry"),"spec"),"model"));
        if(model.empty())return {};
        const auto& catalog=catalogs.at(pid);
        bool listed=false;
        for(const auto& row:catalog.at("listed").as_array())if(row.as_string()==model){listed=true;break;}
        Json scores;
        if(const auto* models=board.find("scores"))if(const auto* match=models->find(model))scores=*match;
        return O{{"tier",tier},{"providerId",pid},{"model",model},{"catalog",str(catalog,"status")},
            {"listed",listed},{"accountAccess","unverified"},{"benchmark",scores}};
    };
    A pool;
    if (const auto* entries = settings.find("pool"); entries && entries->is_array()) {
        const auto harnesses = cached_cli_harnesses(false);
        const auto native = cli_pool_catalog(harnesses);
        for (const auto& entry : entries->as_array()) {
            if (entry.find("engineId")) {
                auto candidate = entry;
                const bool custom = flag(entry,"custom") && std::any_of(harnesses.begin(), harnesses.end(), [&](const auto& h){return h.installed && h.id == str(entry,"engineId");});
                candidate["unavailable"] = !custom && !native.contains(pool_key(entry));
                if (const auto* scores = board.find("scores"))
                    if (const auto* match = scores->find(str(entry,"model"))) candidate["benchmark"] = *match;
                pool.push_back(std::move(candidate));
                continue;
            }
            auto candidate = describe(entry, "pool");
            if (!candidate.is_object()) {
                candidate = entry;
                candidate["unavailable"] = true;
            }
            pool.push_back(std::move(candidate));
        }
    }
    O tiers,roster;
    if(flag(settings,"enabled",true))for(auto tier:{"simple","standard","complex"}){
        const auto* choice=configured.find(tier);if(choice&&choice->is_object())tiers[tier]=describe(*choice,tier);
    }
    for(const auto& m:members.as_array()){
        const auto id=m.as_string(), engine=configured_cli_engine(id);
        const auto cli=active_cli_specific_config(id);
        roster[id]=O{{"member",describe(obj(obj(obj(metadata,"bots"),id),"modelSelection"),"member")},
            {"cliEngine",engine},{"cliModelSource",str(cli,"modelSource",configured_cli_model_source(id))},
            {"cliModel",str(cli,"model")}};
    }
    O catalog_summary;
    for(const auto& [pid,v]:catalogs){
        A suggestions;
        for(const auto& id:v.at("listed").as_array()){
            const auto* scores=board.find("scores");
            if(scores&&scores->find(id.as_string())&&suggestions.size()<12)suggestions.emplace_back(O{{"model",id},{"benchmark",*scores->find(id.as_string())}});
        }
        catalog_summary[pid]=O{{"status",str(v,"status")},{"listedCount",int(v.at("listed").as_array().size())},
            {"checkedAt",str(v,"checkedAt")},{"listedWithBenchmark",suggestions}};
    }
    return O{{"pool",pool},{"tiers",tiers},{"members",roster},{"catalogs",catalog_summary},{"source",str(board,"source")},
        {"release",str(board,"release")},{"benchmarkStatus",str(board,"status","unavailable")}};
}

Json Application::Impl::propose_work_routes(const RunExecutionContext& ctx, const ModelRoute& lead,
        const std::vector<ModelMessage>& history, const std::string& plan, std::stop_token stop) {
    const auto name = bot(ctx.bot_id).name;
    const auto label = lead.provider_id + " / " + lead.config.model;
    Json proposal = O{{"lead",O{{"providerId",lead.provider_id},{"model",lead.config.model},{"tier",lead.tier}}},
                      {"jobs",A{}}};
    std::string report = "预计模型分配\n• 拟定方案：" + name + " · " + label;
    if (ctx.group_id.empty()) {
        const auto selected = configured_cli_engine(ctx.bot_id);
        const auto harnesses = cached_cli_harnesses(false);
        const auto target = std::find_if(harnesses.begin(),harnesses.end(),[&](const auto& h){
            return h.installed && (selected=="auto" || h.id==selected);
        });
        if (selected!="builtin" && !sandbox_cli_required(ctx) && options.provider_file.empty() &&
            plugin_adaptation_for(ctx).as_object().empty() && target!=harnesses.end()) {
            const auto spec = active_cli_specific_config(ctx.bot_id,target->id);
            const bool native = !target->supports_custom_model || str(spec,"modelSource",configured_cli_model_source(ctx.bot_id))=="native";
            const auto provider = str(spec,"providerId");
            const auto model = str(spec,"model");
            const bool specific = !provider.empty() && !model.empty();
            Json cli = O{{"engineId",target->id},{"modelSource",native?"native":"work"},
                         {"providerId",native?provider:specific?provider:lead.provider_id},
                         {"model",native?(model.empty()?target->native_default_model:model):specific?model:lead.config.model}};
            if(spec.find("reasoningEffort")) cli["reasoningEffort"]=str(spec,"reasoningEffort");
            proposal["cli"] = cli;
            report += "\n• 执行：" + name + " · " + target->name + " · " +
                (str(cli,"model").empty()?"账号默认，具体型号未知":
                (str(cli,"providerId").empty()?"":str(cli,"providerId")+" / ")+str(cli,"model")) +
                (selected=="auto"?"（自动选择已安装的 CLI）":"（当前选定的 CLI）");
        } else {
            report += "\n• 执行：" + name + " · 内置 Work · " + label + "（当前工位使用内置工具）";
        }
    } else {
        auto inventory = group_route_inventory(ctx,stop);
        std::vector<ModelMessage> messages{{"system",
            "你负责模型分配。仅返回 JSON 对象 {\"jobs\":[{\"botId\":\"成员ID\",\"text\":\"具体职责\","
            "\"routeReason\":\"选择理由\",\"routeTier\":\"auto\",\"poolModel\":{\"engineId\":\"可选\","
            "\"providerId\":\"...\",\"model\":\"...\"},\"benchmarkCategory\":\"Coding\"}]}。"
            "依据用户最新修改和方案选择成员，每个成员最多一个职责。群主独立完成时返回空数组。"
            "池非空时必须从池中选择；池为空省略 poolModel，可选已配置档位。仅在确实使用对应榜单时填写 benchmarkCategory。"
            "群主ID："+ctx.bot_id+"。可用路线："+inventory.dump(),{}, {}}};
        for (const auto& m:history) if(m.role=="user") messages.push_back(m);
        messages.push_back({"user","为以下待确认方案分配模型：\n"+plan,{},{}});
        const auto reply=call_model(lead.config,messages,{}, {},stop);
        auto first=reply.text.find('{'), last=reply.text.rfind('}');
        if(first==reply.text.npos || last==reply.text.npos || last<first) throw ApiError(409,"分配模型未返回有效计划，请重新生成方案");
        const auto parsed=Json::parse(reply.text.substr(first,last-first+1));
        const auto& jobs=parsed.at("jobs").as_array();
        if(jobs.size()>16)throw ApiError(400,"分配计划超过16个工位");
        A normalized;
        std::set<std::string> seen;
        for(const auto& row:jobs){
            const auto member=required_string(row,"botId"), task=required_string(row,"text");
            if(member==ctx.bot_id || !inventory.at("members").find(member) || !seen.insert(member).second ||
                task.size()>1800 || str(row,"routeReason").size()>600)throw ApiError(409,"分配计划成员或职责无效，请重新规划");
            require_group_member(ctx.group_id,member,Mode::Work);
            Json job=O{{"botId",member},{"id","job"+std::to_string(normalized.size()+1)},{"text",task},
                {"routeTier",str(row,"routeTier","auto")},{"routeReason",str(row,"routeReason")},{"benchmarkCategory",str(row,"benchmarkCategory")}};
            if(const auto* pick=row.find("poolModel")){
                Json allowed=O{{"providerId",str(*pick,"providerId")},{"model",required_string(*pick,"model")}};
                if(!str(*pick,"engineId").empty())allowed["engineId"]=str(*pick,"engineId");
                job["poolModel"]=std::move(allowed);
            }
            normalized.push_back(std::move(job));
        }
        proposal["jobs"]=normalized;
        report += "\n• "+name+" · 内置 Work · "+label+(jobs.empty()?"（独立执行）":"（统筹与验收）");
        if(!jobs.empty()){
            report_dispatch(ctx,proposal.at("jobs"),false,stop,&proposal,&inventory);
            report+="\n"+str(proposal,"report");
        }
    }
    std::set<std::string> alternatives;
    const auto settings=obj(meta.get(),"workModels");
    const auto add_candidate=[&](const Json& entry){
        const auto model=str(entry,"model");
        if(model.empty())return;
        std::string candidate=str(entry,"engineId",str(entry,"providerId"))+" / "+model;
        if(candidate!=label)alternatives.insert(std::move(candidate));
    };
    if(const auto* pool=settings.find("pool");pool && !pool->as_array().empty()){
        for(const auto& entry:pool->as_array())add_candidate(entry);
    }else{
        const auto tiers=obj(settings,"routes");
        for(const auto& [tier,entry]:tiers.as_object())add_candidate(entry);
    }
    std::string next;
    for(const auto& candidate:alternatives){
        if(next.size()>600)break;
        next+=(next.empty()?"":"、")+candidate;
    }
    proposal["alternatives"]=next;
    proposal["report"]=report;
    return proposal;
}

std::map<std::string,Json> Application::Impl::report_dispatch(const RunExecutionContext& ctx,const Json& jobs,bool direct,std::stop_token stop,Json* proposal,const Json* catalog){
    const auto record=work->brief_json(ctx.run_id);
    const auto saved=obj(record,"routePlan");
    if(!proposal && str(record,"planPhase")=="approved" && saved.find("lead")){
        std::map<std::string,Json> result;
        unsigned index=0;
        const auto pool=obj(meta.get(),"workModels");
        for(const auto& job:jobs.as_array()){
            const auto member=required_string(job,"botId"), task=required_string(job,direct?"task":"text");
            const auto& approved=saved.at("jobs").as_array();
            const auto match=std::find_if(approved.begin(),approved.end(),[&](const Json& j){
                return str(j,"botId")==member && str(j,"text")==task;
            });
            if(match==approved.end())throw ApiError(409,"派单不符合确认的分工，请沿用方案中的成员与职责或重新确认");
            auto route=saved.at("assignments").at(str(*match,"id"));
            const auto* entries=pool.find("pool");
            if(entries && !entries->as_array().empty()){
                const auto key=pool_key(route.find("cli")?route.at("cli"):route);
                if(std::none_of(entries->as_array().begin(),entries->as_array().end(),[&](const auto& e){return pool_key(e)==key;}))
                    throw WorkRouteUnavailable("原分配模型已移出允许池，请在群模型池中重新选择并确认");
            }
            route["parentAttempt"]=int(ctx.attempt);
            const auto key=direct?"m"+std::to_string(++index)+"_"+member:required_string(job,"id");
            result[key]=route;
        }
        work->custom_event(ctx,"group_dispatch_plan",O{{"text",str(saved,"report")}});
        return result;
    }
    const auto inventory=catalog?*catalog:group_route_inventory(ctx,stop);
    const auto parent=str(work->brief_json(ctx.run_id),"text");
    std::map<std::string,Json> pinned;
    std::string report="分配计划";
    static const std::map<std::string,std::string> categories={{"Coding","编码"},{"Agentic Coding","工程编码"},{"Reasoning","推理"},{"Data Analysis","数据分析"},{"Mathematics","数学"},{"Language","语言"},{"IF","指令遵循"}};
    bool used_board=false;
    unsigned index=0;
    for(const auto& item:jobs.as_array()){
        if(stop.stop_requested())throw ApiError(409,"派单已取消");
        const auto member=required_string(item,"botId"),task=required_string(item,direct?"task":"text");
        const auto key=direct?"m"+std::to_string(++index)+"_"+member:required_string(item,"id");
        const auto roster=obj(obj(inventory,"members"),member);
        auto tier=str(item,"routeTier","auto");Json selection;
        const auto& pool = inventory.at("pool").as_array();
        const auto* requested = item.find("poolModel");
        if (!pool.empty() || requested) {
            for (const auto& candidate : pool) {
                if (flag(candidate, "unavailable")) continue;
                if (requested && pool_key(*requested) != pool_key(candidate)) continue;
                selection = candidate;
                break;
            }
            if (!selection.is_object()) throw ApiError(400, "请从群聊可选模型池选择可用的服务商与模型");
        } else if(tier!="auto"){
            selection=tier=="member"?obj(roster,"member"):obj(obj(inventory,"tiers"),tier);
            if(str(selection,"model").empty())throw ApiError(400,"该路线未配置，请选用已有档位或沿用成员模型");
        }
        auto child=ctx;child.bot_id=member;
        const auto input=task+"\n"+parent;
        const bool native = selection.find("engineId") != nullptr;
        if (native && (sandbox_cli_required(ctx) || sandbox_cli_required(child)))
            throw ApiError(409,"该工位要求沙盒执行，请选择 Work 模型或 Windows 本机工位");
        const auto route=model_routes(child,&input,native ? Json{} : selection).front();
        pinned[key]=O{{"providerId",route.provider_id},{"model",route.config.model},{"tier",route.tier},{"parent",ctx.run_id},{"parentAttempt",int(ctx.attempt)}};
        if (native) pinned[key]["cli"] = O{{"engineId",str(selection,"engineId")},{"providerId",str(selection,"providerId")},{"model",str(selection,"model")}};
        if(str(selection,"model").empty()){
            selection=obj(obj(inventory,"tiers"),route.tier);
            if(str(selection,"model")!=route.config.model||str(selection,"providerId")!=route.provider_id)selection=obj(roster,"member");
        }
        auto excerpt=[](std::string text,size_t cap){if(text.size()<=cap)return text;while(cap && (static_cast<unsigned char>(text[cap])&0xc0)==0x80)--cap;return text.substr(0,cap)+"…";};
        report+="\n• "+bot(member).name+"："+(proposal?task:excerpt(task,240))+"\n  Work 模型："+route.provider_id+" / "+route.config.model+"（"+route.tier+"）";
        if (native) report+="（编排与解读）\n  执行 CLI："+str(selection,"engineId")+" / "+str(selection,"model")+"，账号权限以实际调用为准";
        else report+=flag(selection,"listed")?"，目录已列出，账号调用权限待验证":"，使用配置值，目录未确认";
        const auto category=str(item,"benchmarkCategory");
        const auto score=obj(obj(selection,"benchmark"),category);
        if(categories.contains(category)&&score.find("rank")){
            used_board=true;
            report+="；LiveBench "+categories.at(category)+"第 "+std::to_string(int(num(score,"rank")))+"/"+std::to_string(int(num(score,"of")))+" 名";
        } else if(!proposal) report+="；该任务维度暂无可核实排名";
        auto why=str(item,"routeReason");report+="。"+(why.empty()?"沿用当前任务难度和已配置路线。":excerpt(why,240));
        if(proposal && !native) report+=" 执行引擎：内置 Work。";
        const auto engine=str(item,"preferredEngine",str(roster,"cliEngine"));
        if(!proposal && !native && engine!="builtin"){
            if(engine!=str(roster,"cliEngine")) {
                report+=" 建议 CLI："+engine+"（实际引擎及模型以启动记录为准）。";
                continue;
            }
            const auto fixed=str(roster,"cliModel");
            report+=" CLI："+engine+"，"+(fixed.empty()?(str(roster,"cliModelSource")=="native"?"沿用原生模型":"按执行引擎配置"):"配置模型 "+fixed)+"（以启动记录为准）。";
        }
    }
    if((!proposal || used_board) && !str(inventory,"source").empty())report+="\n榜单：LiveBench "+str(inventory,"release")+
        (str(inventory,"benchmarkStatus")=="stale"?"（刷新失败，沿用缓存）":"")+" "+str(inventory,"source");
    else if(!proposal) report+="\n榜单暂不可用，本次依据已配置路线分配。";
    if(proposal){
        O routes;
        for(auto& [key,route]:pinned){route["locked"]=true;routes[key]=route;}
        (*proposal)["assignments"]=std::move(routes);
        (*proposal)["report"]=report;
    } else work->custom_event(ctx,"group_dispatch_plan",O{{"text",report}});
    return pinned;
}
