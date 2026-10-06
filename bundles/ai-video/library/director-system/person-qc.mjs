/** Collect real event-boundary frames. Visual evidence is never a fabricated face verdict. */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { planPersonQualitySamples } from "./core.mjs";
import { extractFrame, sha256File, runBin } from "../../connectors/subtitle-bridge/measure.mjs";

export async function collectDirectorPersonQc({input,plan,filmPlan=null,outDir,bins,personRegions=[]}) {
  const events=[];
  for(const edit of plan.pictureEdl) {
    events.push({atSec:edit.startFrame/plan.fps},{atSec:(edit.startFrame+edit.outFrame-edit.inFrame-1)/plan.fps});
    for(const event of filmPlan?.shots?.find(s=>s.shotId===edit.sourceId)?.events??[]) {
      const frame=Math.round(Number(event.atSec)*plan.fps);
      if(frame>=edit.inFrame&&frame<edit.outFrame) events.push({atSec:(edit.startFrame+frame-edit.inFrame)/plan.fps});
    }
  }
  const schedule=planPersonQualitySamples({durationSec:plan.durationFrames/plan.fps,events,personRegions});
  const frames=[...new Set(schedule.samples.map(t=>Math.min(plan.durationFrames-1,Math.round(t*plan.fps))))];
  if(frames.length>512) throw new Error("QC_SAMPLE_LIMIT: 人物检查样本过多，需要分段检查");
  await mkdir(outDir,{recursive:true});const samples=[];
  for(const [index,frame] of frames.entries()) {
    const atSec=frame/plan.fps,edit=plan.pictureEdl.find(e=>frame>=e.startFrame&&frame<e.startFrame+e.outFrame-e.inFrame);
    const file=path.join(outDir,`sample-${index+1}.png`);
    await extractFrame({input,output:file,at:atSec,bins});
    const regions=[];
    for(const [regionIndex,region] of personRegions.entries()) {
      if(region.sourceId!==edit?.sourceId) continue;
      if(!["x","y","width","height"].every(k=>Number.isFinite(region[k])&&region[k]>=0&&region[k]<=1)
        || region.width<=0||region.height<=0||region.x+region.width>1||region.y+region.height>1
        || !["human-registered","detector"].includes(region.origin)) throw new Error("QC_REGION_INVALID: 人物区域缺少合法范围或来源");
      const cropped=path.join(outDir,`sample-${index+1}-roi-${regionIndex+1}.png`);
      await runBin(bins.ffmpeg,["-hide_banner","-v","error","-n","-i",file,"-vf",
        `crop=iw*${region.width}:ih*${region.height}:iw*${region.x}:ih*${region.y}`,"-frames:v","1",cropped]);
      regions.push({...region,path:cropped,sha256:await sha256File(cropped),identityVerdict:"unverified"});
    }
    samples.push({frame,atSec,sourceId:edit?.sourceId,sourceAtSec:edit?(edit.inFrame+frame-edit.startFrame)/plan.fps:null,
      path:file,sha256:await sha256File(file),regions,faceDetection:personRegions.length?"registered-regions-only":"unverified"});
  }
  const receipt={...schedule,schemaVersion:"workloom.person-qc-evidence/v2",samples,status:personRegions.length?"evidence-collected":"detection-unverified",
    temporalFramesCollected:true,personRegionsCollected:samples.some(s=>s.regions.length>0),
    identityVerified:false,beautyImprovementVerified:false,fullPlaybackRequired:true,sourceGenerationCalls:0,
    limitation:"已抽取时间序列与动作边界；未配置人物检测器时，不把全帧检查写成人脸、手部或颜值通过"};
  await writeFile(path.join(outDir,"person-qc.json"),JSON.stringify(receipt,null,2)+"\n");return receipt;
}
