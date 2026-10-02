import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { DirectorFilmPlan } from "@hyperreality/video-studio";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { useNavigationAccess } from "../../../shell/NavigationAccess";
import "./DirectorStudio.css";

type Job=Awaited<ReturnType<typeof trpc.video.creative.job.query>>;
type Variant={id:string;label:string;platform:string;kind:string;status:string;videoUrl:string|null;coverUrl:string|null;
  recommended:boolean;recommendationReason?:string;durationSec?:number;copy?:{title?:string;caption?:string};error?:string};
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const key=()=>`director-${crypto.randomUUID()}`;
const active=(job:Job|null)=>job?.status==="queued"||job?.status==="running";
const platformName:Record<string,string>={douyin:"抖音",xiaohongshu:"小红书","wechat-channels":"视频号"};
const placeholder="为江边民宿拍一支电影：雨后的光落在窗边，一个人终于慢下来。";

export default function DirectorStudio(){
  const [params,setParams]=useSearchParams();
  const {canAction}=useNavigationAccess();
  const [intent,setIntent]=useState("");
  const [job,setJob]=useState<Job|null>(null);
  const [history,setHistory]=useState<Job[]>([]);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [feedback,setFeedback]=useState("");
  const [variantId,setVariantId]=useState("");
  const [blind,setBlind]=useState(false);
  const [budget,setBudget]=useState("");
  const [consent,setConsent]=useState(false);
  const [identityIds,setIdentityIds]=useState<string[]>([]);
  const mounted=useRef(true),serial=useRef(0),requestKey=useRef(key());
  const write=canAction("workspace.write");
  const film=job?.filmPlan && typeof job.filmPlan==="object" && "schemaVersion" in job.filmPlan
    ? job.filmPlan as DirectorFilmPlan : null;
  const variants=(job?.variants??[]) as unknown as Variant[];
  const targets=film?.deliveryTargetPlan.targets??[];
  const visibleVariants:Variant[]=variants.length?variants:targets.map(t=>({id:t.variantId,label:t.label,platform:t.platform,kind:t.kind,
    status:"planned",videoUrl:null,coverUrl:null,recommended:t.recommended}));
  const needsIdentity=Array.isArray(job?.requiredInputs)&&job.requiredInputs.includes("IDENTITY_ASSET_REQUIRED");

  const load=useCallback(async(jobId?:string)=>{
    const turn=++serial.current;
    try{
      await ensureDemoLogin();
      const jobs=await trpc.video.creative.jobs.query({limit:12});
      const chosen=jobId??params.get("directorJob")??jobs[0]?.id;
      const result=chosen?await trpc.video.creative.job.query({jobId:chosen}):null;
      if(mounted.current && turn===serial.current){setHistory(jobs);setJob(result);setError(null);}
    }catch(e){if(mounted.current && turn===serial.current)setError(message(e));}
    finally{if(mounted.current)setLoading(false);}
  },[params]);
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;serial.current++;};},[load]);
  useEffect(()=>{
    if(!active(job)) return;
    const timer=setInterval(()=>void load(job!.id),2500);
    return()=>clearInterval(timer);
  },[job?.id,job?.status,load]);
  const adopt=(next:Job)=>{
    setJob(next);setParams(previous=>{previous.set("directorJob",next.id);return previous;});setNotice(null);requestKey.current=key();
  };
  const operation=async(name:string,run:()=>Promise<void>)=>{
    if(busy)return;setBusy(name);setError(null);setNotice(null);
    try{await ensureDemoLogin();await run();}catch(e){setError(message(e));}finally{if(mounted.current)setBusy(null);}
  };
  const start=(mode:"produce"|"plan")=>operation("start",async()=>{
    if(intent.trim().length<2)throw new Error("请写一句想拍的内容或感觉。");
    const amount=budget.trim()?Number(budget):undefined;
    if(amount!==undefined && (!Number.isFinite(amount)||amount<0||amount>100000))throw new Error("预算上限应是 0–100000 元之间的数值。");
    const next=await trpc.video.creative.start.mutate({intent:intent.trim(),mode,idempotencyKey:requestKey.current,
      maxBudgetCny:amount,identityAssetRefs:identityIds});adopt(next);setIntent("");
  });
  const resume=()=>operation("resume",async()=>{
    if(!job?.planHash||!job.planRevision)throw new Error("导演方案尚未完成，请稍后刷新。");
    const amount=Number(budget);
    if(!(amount>0)||amount>100000)throw new Error("继续付费制作前，请设定本项目预算上限。");
    adopt(await trpc.video.creative.renderVariants.mutate({projectId:job.projectId,expectedPlanHash:job.planHash,revision:job.planRevision,
      maxBudgetCny:amount,identityAssetRefs:identityIds,idempotencyKey:requestKey.current}));
  });
  const upload=(file:File)=>operation("identity",async()=>{
    if(!consent)throw new Error("请确认这是你自己的形象素材，并授权在本工作区内使用。");
    if(!file.type.startsWith("image/"))throw new Error("本人素材请选择图片文件。");
    const ticket=await trpc.video.media.uploadTicket.mutate({filename:file.name,bytes:file.size,kind:"upload_image"});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
    let uploaded:{sha256:string;relPath:string};
    try{
      const response=await fetch(ticket.uploadUrl,{method:"POST",body:file,signal:controller.signal});
      if(!response.ok)throw new Error(`素材上传失败（${response.status}），可以重试。`);
      uploaded=await response.json();
      if(!uploaded.sha256||!uploaded.relPath)throw new Error("素材上传回执不完整。");
    }finally{clearTimeout(timer);}
    const asset=await trpc.video.media.registerUpload.mutate({...uploaded,kind:"upload_image",title:file.name,tags:["本人素材"]});
    await trpc.video.creative.authorizeIdentity.mutate({assetId:asset.assetId,selfConsent:true});
    setIdentityIds(current=>[...current,asset.assetId].slice(-4));setNotice("本人素材与授权已保存，后续项目可自动复用。正式生成还会核对模型所需的真人素材授权。");
  });
  const sendFeedback=()=>operation("feedback",async()=>{
    if(!job?.planHash||!job.planRevision)throw new Error("作品版本信息未就绪，请刷新。");
    if(!feedback.trim())throw new Error("请写一句想调整的地方。");
    const next=await trpc.video.creative.feedback.mutate({projectId:job.projectId,expectedPlanHash:job.planHash,revision:job.planRevision,
      feedback:feedback.trim(),variantId:variantId||undefined,idempotencyKey:requestKey.current});adopt(next);setFeedback("");
  });
  const choose=(variant:Variant,index:number)=>operation(`choose-${variant.id}`,async()=>{
    if(!job?.planHash||!job.planRevision)throw new Error("作品版本未就绪。");
    await trpc.video.creative.choose.mutate({projectId:job.projectId,expectedPlanHash:job.planHash,revision:job.planRevision,
      variantId:variant.id,blindLabel:blind?(["A","B","C","D","E","F"][index%6] as "A"|"B"|"C"|"D"|"E"|"F"):undefined});
    setNotice(`已记录你对${blind?`版本 ${String.fromCharCode(65+index)}`:variant.label}的选择。`);
  });

  return <main className="director-studio" aria-busy={loading||Boolean(busy)}>
    <header className="director-heading"><div><p className="director-eyebrow">一句话，交给导演</p>
      <h1>把你的想法，拍成电影。</h1><p>先说想表达什么。妆造、光线、表演、剪辑和声音，由制作团队安排。</p></div>
      <Link className="director-link" to="/ai-video/assets?tab=studio&advanced=1">专业工作台 ↗</Link></header>
    {error&&<div role="alert" className="director-message director-error"><span>{error}</span><button onClick={()=>void load(job?.id)} disabled={Boolean(busy)}>重新连接</button></div>}
    {notice&&<p role="status" className="director-message">{notice}</p>}
    <section className="director-composer" aria-label="电影创作需求">
      <label htmlFor="director-intent">你想拍什么？</label>
      <textarea id="director-intent" value={intent} onChange={e=>{setIntent(e.target.value);requestKey.current=key();}}
        placeholder={placeholder} maxLength={10000} rows={3} disabled={!write||Boolean(busy)||active(job)} />
      <div className="director-composer-footer"><p>默认交付抖音、小红书、视频号三版，再加一支导演惊喜版。你在原话中指定的平台、数量和否定要求优先。</p>
        <div className="director-actions"><button className="director-secondary" disabled={!write||Boolean(busy)||active(job)||intent.trim().length<2}
          onClick={()=>void start("plan")}>{busy==="start"?"正在提交…":"只做文字方案"}</button>
          <button className="director-primary" disabled={!write||Boolean(busy)||active(job)||intent.trim().length<2}
            onClick={()=>void start("produce")}>{busy==="start"?"正在提交…":"交给导演 →"}</button></div></div>
      <details className="director-budget"><summary>制作预算</summary><label htmlFor="director-budget">本项目可用上限（元）</label>
        <input id="director-budget" type="number" min="0" max="100000" inputMode="decimal" placeholder="沿用客户端设置" value={budget} onChange={e=>setBudget(e.target.value)} disabled={Boolean(busy)||!write}/>
        <p>付费镜头提交前会显示冻结的报价与预算请求。文字方案不会触发生图或生视频。</p></details>
      {!write&&<p className="director-muted">当前身份可以查看作品；创作需要工作区修改权限。</p>}
    </section>
    {loading&&!job?<div className="director-progress" role="status">正在读取作品记录…</div>:job&&<section className="director-progress" aria-live="polite">
      <span className={active(job)?"director-status-dot is-running":"director-status-dot"}/><div><strong>{job.stage}</strong>
        <p>{job.message??(active(job)?"制作过程会自动更新。你可以离开页面，回来后查看进展。":film?String(film.brief.logline??film.brief.title??""):job.errorCode??"任务记录已保存")}</p></div>
      {active(job)&&<button className="director-secondary" disabled={!write||Boolean(busy)} onClick={()=>void operation("cancel",async()=>{
        await trpc.video.creative.cancel.mutate({jobId:job.id});await load(job.id);})}>停止制作</button>}
    </section>}
    {needsIdentity&&<section className="director-input-required"><h2>添加一次本人素材</h2><p>拍摄你本人需要已有形象素材。添加后，同一工作区内可以自动复用。</p>
      <label className="director-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} disabled={!write||Boolean(busy)}/>
        这是我本人的照片，我授权用于本工作区内的形象制作。</label>
      <input type="file" accept="image/*" disabled={!write||!consent||Boolean(busy)} aria-label="选择本人图片"
        onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value="";}}/>
      <Link className="director-link" to="/ai-video/media">查看已上传素材</Link></section>}
    {job?.requiredApproval==="G8"&&<section className="director-input-required"><h2>共享镜头的制作预算</h2>
      <p>本批预估 ¥{String(job.estimatedCny??"待核实")}，项目上限 ¥{String(job.budgetCny??"待核实")}。批准后制作共享镜头，再合成各版作品。</p>
      <button className="director-primary" disabled={!canAction("approval.decide")||Boolean(busy)} onClick={()=>void operation("budget",async()=>{
        if(!job.planHash)throw new Error("预算请求缺少冻结版本。");adopt(await trpc.video.creative.approveBudget.mutate({jobId:job.id,approve:true,
          expectedPlanHash:job.planHash,idempotencyKey:requestKey.current}));})}>批准这批制作费用并继续</button></section>}
    {job?.requiredApproval!=="G8"&&job?.status==="requires-generation-plan"&&<section className="director-input-required"><h2>继续制作</h2>
      <label htmlFor="director-resume-budget">项目预算上限（元）</label><input id="director-resume-budget" type="number" value={budget} min="1" max="100000" onChange={e=>setBudget(e.target.value)} disabled={!write||Boolean(busy)}/>
      <button className="director-primary" disabled={!write||Boolean(busy)||!(Number(budget)>0)} onClick={()=>void resume()}>按已保存方案继续</button></section>}
    {(targets.length>0||variants.length>0)&&<section aria-label="版本作品" className="director-results"><div className="director-section-title">
      <div><p className="director-eyebrow">{variants.length?"作品交付":"文字方案 · 尚未生成媒体"}</p><h2>{variants.length?"同一个故事，多种表达。":"导演已经安排好各版表达。"}</h2></div>
      {variants.length>0&&<label className="director-consent"><input type="checkbox" checked={blind} onChange={e=>setBlind(e.target.checked)}/>隐藏版本名称，先看作品</label>}</div>
      <div className="director-grid">{visibleVariants.map((v,index)=>{
          const narrative=film?.narrativePlans.find(n=>n.variantId===v.id);
          return <article className={`director-card ${v.kind==="surprise"?"director-card-surprise":""}`} key={v.id}>
            <div className="director-cover">{v.videoUrl?<video controls playsInline preload="metadata" poster={v.coverUrl??undefined} src={v.videoUrl} aria-label={`${v.label}视频`}/>
              :v.coverUrl?<img src={v.coverUrl} alt={`${v.label}封面`} loading="lazy"/>:<div className="director-plan-cover"><span>{String(index+1).padStart(2,"0")}</span>
                <p>{v.status==="failed"?"本版制作未完成":"文字方案"}</p></div>}</div>
            <div className="director-card-body"><div className="director-card-meta"><span>{blind?`版本 ${String.fromCharCode(65+index)}`:v.kind==="surprise"?"导演惊喜版":platformName[v.platform]??v.platform}</span>
              {!blind&&v.recommended&&<span className="director-recommended">导演推荐</span>}</div><h3>{blind?`作品 ${String.fromCharCode(65+index)}`:v.label}</h3>
              <p>{v.error??String(narrative?.differenceReason??v.recommendationReason??"独立编排画面、声音、字幕与封面。")}</p>
              {v.videoUrl&&<div className="director-actions"><button className="director-secondary" disabled={!write||Boolean(busy)} onClick={()=>void choose(v as Variant,index)}>选这一版</button>
                <a className="director-link" href={v.videoUrl} download>下载作品 ↗</a></div>}
              {v.copy?.title&&<p className="director-copy">{v.copy.title}</p>}
            </div></article>;
        })}</div></section>}
    {job?.mediaReady&&<section className="director-feedback"><h2>说一句想改的地方。</h2><p>例如“音乐柔和一点”“封面更简洁”“第三个镜头太快”。系统会定位影响范围，再保留其他已完成的部分。</p>
      <label htmlFor="director-feedback-target">修改范围</label><select id="director-feedback-target" value={variantId} onChange={e=>setVariantId(e.target.value)} disabled={Boolean(busy)||active(job)}>
        <option value="">这组作品</option>{variants.map(v=><option value={v.id} key={v.id}>{v.label}</option>)}</select>
      <label htmlFor="director-feedback">你的意见</label><textarea id="director-feedback" rows={2} value={feedback} maxLength={10000} onChange={e=>{setFeedback(e.target.value);requestKey.current=key();}}
        placeholder="人物保持自然，音乐再轻一点。" disabled={!write||Boolean(busy)||active(job)}/>
      <button className="director-primary" disabled={!write||Boolean(busy)||active(job)||!feedback.trim()} onClick={()=>void sendFeedback()}>{busy==="feedback"?"正在提交…":"按这句意见调整"}</button>
    </section>}
    {history.length>0&&<details className="director-history"><summary>最近的作品记录</summary><div>{history.map(h=><button key={h.id} disabled={Boolean(busy)} onClick={()=>{setParams(previous=>{previous.set("directorJob",h.id);return previous;});void load(h.id);}}>
      <span>{h.projectId}</span><span>{h.stage}</span></button>)}</div></details>}
    {!loading&&!job&&<p className="director-empty">第一支作品，从上面的一句话开始。</p>}
  </main>;
}
