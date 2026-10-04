/** Internal media-worker authority. No CLI/MCP signing endpoint; callers supply a trusted job ledger reader. */
import { createHmac } from "node:crypto";
import { audioStemDigest, describeAudioStemSources, AudioStemError } from "../../connectors/bgm-bridge/audio-stems.mjs";
import { audioStemReceiptPayload, AUDIO_STEM_RECEIPT_SCHEMA, AUDIO_STEM_RECEIPT_PURPOSE } from "../../connectors/bgm-bridge/audio-stems-trust.mjs";
import { runBin, sha256File } from "../../connectors/subtitle-bridge/measure.mjs";

const fail=message=>{throw new AudioStemError(message,"audio_stems_source_unverified");};
/**
 * readEvidence must read the scoped, append-only INTERNAL job store, never a request-provided JSON document.
 * Ready evidence records exact audio-only output bytes and placement. N/A is an explicit worker decision.
 */
export async function issueAudioSourceReceipts({scope,shots,readEvidence,env=process.env,bins,now=Date.now()}) {
  const secret=env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET;
  if(typeof secret!=="string" || Buffer.byteLength(secret)<32 || typeof readEvidence!=="function") fail("媒体工人缺少签发密钥或内部作业证据读取器");
  const bindings=describeAudioStemSources({scope,shots,transitions:{mode:"hard"}});
  const result=structuredClone(shots);
  for(const item of bindings) {
    const binding=item.binding,shot=result.find(s=>s.shotId===binding.shotId),source=shot.stems[binding.role];
    if(typeof source.jobId!=="string" || !source.jobId.trim()) fail("独立音轨未绑定内部媒体作业");
    const evidence=await readEvidence(source.jobId,scope);
    if(!evidence || evidence.status!=="done" || evidence.issuer!=="workloom.media-source-worker"
      || ["tenantId","workspaceId","projectId","revision"].some(k=>evidence.scope?.[k]!==scope[k])
      || evidence.shotId!==binding.shotId || evidence.role!==binding.role || evidence.videoSha256!==binding.videoSha256
      || evidence.bindingSha256!==item.bindingSha256) fail("内部媒体作业与镜头、角色或作用域不一致");
    if(binding.status==="ready") {
      if(evidence.outputSha256!==binding.sourceSha256 || evidence.sourceKind!==binding.sourceKind
        || evidence.outputPath!==source.path || await sha256File(source.path)!==binding.sourceSha256) fail("独立音轨字节与已完成媒体作业不一致");
      const doc=JSON.parse((await runBin(bins.ffprobe,["-v","error","-show_streams","-of","json",source.path],{label:"media-authority(audio-only)"})).stdout);
      if(doc.streams?.some(s=>s.codec_type==="video") || doc.streams?.filter(s=>s.codec_type==="audio").length!==1) fail("含画面或混合成片不能签发为独立音轨");
    } else if(evidence.decision!=="not_applicable" || evidence.reason!==binding.reason) fail("不适用决定缺内部工人证据");
    const receipt={schemaVersion:AUDIO_STEM_RECEIPT_SCHEMA,purpose:AUDIO_STEM_RECEIPT_PURPOSE,
      bindingSha256:item.bindingSha256,workerId:evidence.issuer,jobId:source.jobId,evidenceSha256:audioStemDigest(JSON.parse(JSON.stringify(evidence))),
      issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+24*60*60_000).toISOString(),
      keyId:env.WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID||"audio-stems-v1"};
    source.receipt={...receipt,signature:createHmac("sha256",secret).update(audioStemReceiptPayload(receipt)).digest("hex")};
  }
  return result;
}
