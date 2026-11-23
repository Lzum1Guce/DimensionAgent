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

std::map<std::string,Json> Application::Impl::report_dispatch(const RunExecutionContext& ctx,const Json& jobs,bool direct,std::stop_token stop){
    const auto inventory=group_route_inventory(ctx,stop);
    const auto parent=str(work->brief_json(ctx.run_id),"text");
    std::map<std::string,Json> pinned;
    std::string report="分配计划";
    static const std::map<std::string,std::string> categories={{"Coding","编码"},{"Agentic Coding","工程编码"},{"Reasoning","推理"},{"Data Analysis","数据分析"},{"Mathematics","数学"},{"Language","语言"},{"IF","指令遵循"}};
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
        report+="\n• "+bot(member).name+"："+excerpt(task,240)+"\n  Work 模型："+route.provider_id+" / "+route.config.model+"（"+route.tier+"）";
        if (native) report+="（编排与解读）\n  执行 CLI："+str(selection,"engineId")+" / "+str(selection,"model")+"，账号权限以实际调用为准";
        else report+=flag(selection,"listed")?"，目录已列出，账号调用权限待验证":"，使用配置值，目录未确认";
        const auto category=str(item,"benchmarkCategory");
        const auto score=obj(obj(selection,"benchmark"),category);
        if(categories.contains(category)&&score.find("rank"))
            report+="；LiveBench "+categories.at(category)+"第 "+std::to_string(int(num(score,"rank")))+"/"+std::to_string(int(num(score,"of")))+" 名";
        else report+="；该任务维度暂无可核实排名";
        auto why=str(item,"routeReason");report+="。"+(why.empty()?"沿用当前任务难度和已配置路线。":excerpt(why,240));
        const auto engine=str(item,"preferredEngine",str(roster,"cliEngine"));
        if(!native && engine!="builtin"){
            if(engine!=str(roster,"cliEngine")) {
                report+=" 建议 CLI："+engine+"（实际引擎及模型以启动记录为准）。";
                continue;
            }
            const auto fixed=str(roster,"cliModel");
            report+=" CLI："+engine+"，"+(fixed.empty()?(str(roster,"cliModelSource")=="native"?"沿用原生模型":"按执行引擎配置"):"配置模型 "+fixed)+"（以启动记录为准）。";
        }
    }
    if(!str(inventory,"source").empty())report+="\n榜单：LiveBench "+str(inventory,"release")+
        (str(inventory,"benchmarkStatus")=="stale"?"（刷新失败，沿用缓存）":"")+" "+str(inventory,"source");
    else report+="\n榜单暂不可用，本次依据已配置路线分配。";
    work->custom_event(ctx,"group_dispatch_plan",O{{"text",report}});
    return pinned;
}
