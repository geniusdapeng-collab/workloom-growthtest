import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { productionHash } from "./production-lineage.js";
import {
  assertStandardPostTimeline, buildStandardPostContract, validateStandardNativeClock, STANDARD_POST_SCHEMA,
  type StandardPostBuildInput, type StandardPostTimelineEntry,
} from "./standard-post-contract.js";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const durations = [5, 6, 5, 4, 5, 5];
function fixture(): StandardPostBuildInput {
  const json = JSON.stringify({ projectId: "V-STANDARD", durationSeconds: 30, title: "保留原片与原声",
    shots: durations.map((duration, index) => ({ shotId: `GT-0${index + 1}`, duration, dialogue: [{ text: "原文" }] })) });
  return { projectId: "V-STANDARD", submitted: { json, sha256: digest(json), bytes: Buffer.byteLength(json) },
    originals: durations.map((duration, index) => ({ shotId: `GT-0${index + 1}`, role: "original-render",
      path: `/originals/GT-0${index + 1}.mp4`, sha256: digest(`original-${index}`), bytes: 1000 + index,
      media: { fps: 24, width: 1080, height: 1920, videoFrames: duration * 24, videoDurationSec: duration,
        audioDurationSec: index === 3 ? 3.996 : duration, audioSampleRate: 48000, audioChannels: 2 },
      authority: { kind: "legacy-user-adopted", evidenceId: `historical-receipt-${index}`, evidenceSha256: digest(`receipt-${index}`) } })) };
}
function changed(change: (input: StandardPostBuildInput) => void): StandardPostBuildInput { const input = fixture(); change(input); return input; }
it.each([28,32,35])("目标30秒接受完整%d秒镜头池，仍拒绝把4秒原片截成2秒", total => {
  const input=fixture(), selected=[total-24,12,12];
  input.originals=input.originals.slice(0,3).map((original,index)=>({...original,
    media:{...original.media,videoFrames:selected[index]!*24,videoDurationSec:selected[index]!,audioDurationSec:selected[index]!}}));
  editSubmitted(input,value=>{value.shots=input.originals.map((original,index)=>({shotId:original.shotId,duration:selected[index]}));});
  const contract=buildStandardPostContract(input);
  expect(contract.durationSec).toBe(total); expect(contract.timeline.map(row=>row.durationSec)).toEqual(selected);
  expect((contract as unknown as {completion:{deltaFromTargetSeconds:number;qualityScore:null}}).completion).toMatchObject({deltaFromTargetSeconds:total-30,qualityScore:null});
  const clipped=structuredClone(contract.timeline) as StandardPostTimelineEntry[];clipped[0]!.durationSec=2;
  expect(()=>assertStandardPostTimeline(contract,clipped)).toThrow('STANDARD_POST_TIMELINE_INVALID');
});
it("显式硬上限同时检查分镜合计和实测完整钟，不截去供应商端点帧",()=>{
  const input=fixture();editSubmitted(input,value=>{value.durationIntent={hardMaximumSeconds:30};});
  expect(()=>buildStandardPostContract(input)).not.toThrow();
  const media=input.originals[0]!.media;media.videoFrames++;media.videoDurationSec=media.videoFrames/media.fps;media.audioDurationSec=media.videoDurationSec;
  expect(()=>buildStandardPostContract(input)).toThrow('FILM_COMPLETION_HARD_LIMIT');
});
function timeline(): StandardPostTimelineEntry[] { return structuredClone(buildStandardPostContract(fixture()).timeline) as StandardPostTimelineEntry[]; }
function rejectTimeline(change: (value: StandardPostTimelineEntry[]) => void): void {
  const contract = buildStandardPostContract(fixture()); const actual = timeline(); change(actual);
  expect(() => assertStandardPostTimeline(contract, actual)).toThrow(/STANDARD_POST_TIMELINE_INVALID/);
}
function editSubmitted(input: StandardPostBuildInput, change: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(input.submitted.json) as Record<string, unknown>; change(value);
  const json = JSON.stringify(value); input.submitted = { json, sha256: digest(json), bytes: Buffer.byteLength(json) };
}

describe("标准后期只能沿用提交原稿的完整画面与同文件原声", () => {
  it("从已核对原稿字节派生六镜完整顺序和720帧，忽略素材登记顺序", () => {
    const input = fixture(); input.originals = [...input.originals].reverse();
    const contract = buildStandardPostContract(input);
    expect(contract.schemaVersion).toBe(STANDARD_POST_SCHEMA);
    expect(contract.durationSec).toBe(30); expect(contract.totalFrames).toBe(720);
    expect(contract.timeline.map((entry) => entry.shotId)).toEqual(["GT-01", "GT-02", "GT-03", "GT-04", "GT-05", "GT-06"]);
    expect(contract.timeline.map((entry) => entry.durationSec)).toEqual(durations);
    expect(contract.timeline.every((entry) => entry.video.inSec === 0 && entry.audio.inSec === 0 && entry.speed === 1
      && entry.video.path === entry.audio.path && entry.video.sha256 === entry.audio.sha256 && entry.video.bytes === entry.audio.bytes)).toBe(true);
    expect(() => assertStandardPostTimeline(contract, structuredClone(contract.timeline))).not.toThrow();
  });
  it("GT04实际3.996秒原声仅记4毫秒边界，不声称已有完整4秒对白", () => {
    const contract = buildStandardPostContract(fixture()); const boundary = contract.nativeAudioProof[3]!;
    expect(boundary.sourceDurationSec).toBe(3.996); expect(boundary.videoDurationSec).toBe(4);
    expect(boundary.deltaSec).toBeCloseTo(-0.004, 12); expect(boundary.maximumBoundarySec).toBeCloseTo(2048 / 48000, 12);
    expect(boundary.disposition).toBe("preserve-presented-native-clock");
    expect(boundary.certification).toBe("duration-only-no-speech-certification");
  });
  it("合同深度冻结并拷贝输入，不受登记数组、媒体与证据后续修改影响", () => {
    const input = fixture(); const contract = buildStandardPostContract(input); const hash = contract.contractSha256;
    expect(Object.isFrozen(contract)).toBe(true); expect(Object.isFrozen(contract.timeline)).toBe(true);
    expect(Object.isFrozen(contract.timeline[0]!.audio)).toBe(true); expect(Object.isFrozen(contract.originals[0]!.media)).toBe(true);
    input.originals[0]!.media.videoFrames = 1; input.originals[0]!.authority.evidenceId = "changed";
    expect(contract.originals[0]!.media.videoFrames).toBe(120); expect(contract.contractSha256).toBe(hash);
    expect(() => assertStandardPostTimeline(contract, contract.timeline)).not.toThrow();
  });
  it("JSON持久化后重读同样的合同仍可检查", () => {
    const contract = buildStandardPostContract(fixture()); const loaded = JSON.parse(JSON.stringify(contract));
    expect(() => assertStandardPostTimeline(loaded, loaded.timeline)).not.toThrow();
  });
  it("特殊字符原文按UTF8字节绑定；空白变化必须重新取得原稿收据", () => {
    const input = fixture(); const contract = buildStandardPostContract(input);
    expect(input.submitted.bytes).toBeGreaterThan(input.submitted.json.length);
    input.submitted.json += " "; expect(() => buildStandardPostContract(input)).toThrow(/SUBMITTED/);
    expect(contract.submitted.sha256).toBe(digest(contract.submitted.json));
  });

  const timelineChanges: Array<[string, (entries: StandardPostTimelineEntry[]) => void]> = [
    ["删除镜头", (entries) => { entries.splice(2, 1); }],
    ["新增镜头", (entries) => { entries.push(structuredClone(entries[0]!)); }],
    ["重复镜头替代下一镜", (entries) => { entries[2] = structuredClone(entries[1]!); }],
    ["镜头重排", (entries) => { [entries[1], entries[2]] = [entries[2]!, entries[1]!]; }],
    ["切分原镜头", (entries) => { const part = structuredClone(entries[0]!); part.durationSec = 2; entries[0]!.durationSec = 3; entries.splice(1, 0, part); }],
    ["缩短画面", (entries) => { entries[0]!.durationSec = 4.999; }],
    ["延长画面", (entries) => { entries[0]!.durationSec = 5.001; }],
    ["替换原视频路径", (entries) => { entries[2]!.video.path = "/replacement.mp4"; }],
    ["替换原视频摘要", (entries) => { entries[2]!.video.sha256 = digest("replacement"); }],
    ["替换原视频字节数", (entries) => { entries[2]!.video.bytes++; }],
    ["新增独立配音路径", (entries) => { entries[2]!.audio.path = "/tts.wav"; }],
    ["另一镜原声串接", (entries) => { entries[2]!.audio = structuredClone(entries[1]!.audio); }],
    ["独立原声摘要", (entries) => { entries[2]!.audio.sha256 = digest("tts"); }],
    ["独立原声字节数", (entries) => { entries[2]!.audio.bytes++; }],
    ["画面入点偏移", (entries) => { entries[0]!.video.inSec = 0.001; }],
    ["原声入点偏移", (entries) => { entries[0]!.audio.inSec = 0.001; }],
    ["变速", (entries) => { entries[0]!.speed = 1.01; }],
    ["不认识的剪辑字段", (entries) => { Object.assign(entries[0]!, { crop: "face" }); }],
    ["不认识的画面字段", (entries) => { Object.assign(entries[0]!.video, { replacementAllowed: true }); }],
    ["不认识的原声字段", (entries) => { Object.assign(entries[0]!.audio, { gainDb: 6 }); }],
    ["空时间线", (entries) => { entries.length = 0; }],
    ["稀疏时间线", (entries) => { delete entries[2]; }],
    ["数组附加秘密字段", (entries) => { Object.assign(entries, { allowVoiceReplacement: true }); }],
  ];
  it.each(timelineChanges)("拒绝%s", (_name, change) => rejectTimeline(change));

  const sourceChanges: Array<[string, (input: StandardPostBuildInput) => void]> = [
    ["原稿摘要不符", (input) => { input.submitted.sha256 = digest("wrong"); }],
    ["原稿字节数不符", (input) => { input.submitted.bytes++; }],
    ["原稿项目不符", (input) => { editSubmitted(input, (value) => { value.projectId = "another"; }); }],
    ["项目为空", (input) => { input.projectId = ""; }],
    ["原稿没有镜头", (input) => { editSubmitted(input, (value) => { value.shots = []; }); }],
    ["原稿重复镜头ID", (input) => { editSubmitted(input, (value) => { const shots = value.shots as Array<{shotId: string}>; shots[1]!.shotId = shots[0]!.shotId; }); }],
    ["原稿缺镜头时长", (input) => { editSubmitted(input, (value) => { delete (value.shots as Array<Record<string, unknown>>)[0]!.duration; }); }],
    ["原稿总时长不是正数", (input) => { editSubmitted(input, (value) => { value.durationSeconds = 0; }); }],
    ["原稿JSON无效", (input) => { input.submitted = { json: "{", sha256: digest("{"), bytes: 1 }; }],
    ["少原镜头", (input) => { input.originals = input.originals.slice(1); }],
    ["多原镜头", (input) => { input.originals = [...input.originals, structuredClone(input.originals[0]!)]; }],
    ["未知原镜头", (input) => { input.originals[0]!.shotId = "UNKNOWN"; }],
    ["非原始render角色", (input) => { Object.assign(input.originals[0]!, { role: "tts" }); }],
    ["空原视频摘要", (input) => { input.originals[0]!.sha256 = ""; }],
    ["相对原视频路径", (input) => { input.originals[0]!.path = "clips/raw.mp4"; }],
    ["空原视频", (input) => { input.originals[0]!.bytes = 0; }],
    ["缺原声音轨", (input) => { input.originals[0]!.media.audioChannels = 0; }],
    ["无效采样率", (input) => { input.originals[0]!.media.audioSampleRate = 0; }],
    ["无来源证据标识", (input) => { input.originals[0]!.authority.evidenceId = ""; }],
    ["无来源证据摘要", (input) => { input.originals[0]!.authority.evidenceSha256 = ""; }],
    ["未知顶层选项", (input) => { Object.assign(input, { allowDrop: true }); }],
    ["未知提交源字段", (input) => { Object.assign(input.submitted, { trustCaller: true }); }],
    ["未知原素材字段", (input) => { Object.assign(input.originals[0]!, { audioPath: "/tts.wav" }); }],
    ["未知媒体字段", (input) => { Object.assign(input.originals[0]!.media, { speed: 2 }); }],
    ["未知证据字段", (input) => { Object.assign(input.originals[0]!.authority, { identityCertified: true }); }],
    ["非有限值", (input) => { input.originals[0]!.media.fps = Infinity; }],
  ];
  it.each(sourceChanges)("构建时拒绝%s", (_name, change) => {
    expect(() => buildStandardPostContract(changed(change))).toThrow(/STANDARD_POST_/);
  });
  it("原始画幅、帧率和音轨可不同；完整实测钟不按名义秒数裁片", () => {
    const input = fixture();
    Object.assign(input.originals[0]!.media, { fps: 241, width: 321, height: 241, videoFrames: 242,
      videoDurationSec: 242 / 241, audioDurationSec: 0, audioSampleRate: 0, audioChannels: 0 });
    input.originals[1]!.path = input.originals[0]!.path; input.originals[1]!.sha256 = input.originals[0]!.sha256;
    input.originals[2]!.media.audioDurationSec = 4.2;
    const contract = buildStandardPostContract(input);
    expect(contract.timeline.map(row => row.shotId)).toEqual(fixture().originals.map(row => row.shotId));
    expect(contract.timeline[0]!.durationSec).toBe(242 / 241);
    expect(contract.nativeAudioProof[0]!.disposition).toBe("silent-source");
    expect(contract.width % 2).toBe(0); expect(contract.height % 2).toBe(0);
    expect(contract.timeline[0]!.video.sha256).toBe(input.originals[0]!.sha256);
    expect(contract.compositionClock.entries[0]!.plannedOutputFrames).toBe(25);
    expect(contract.compositionClock.sourceDurationSec).toBe(242 / 241 + 25);
  });
  it.each([-1, 1])("AAC元数据边界方向%d超出两帧仍仅留实际观察，不触发品质重做", direction => {
    const input = fixture(), media = input.originals[0]!.media;
    media.audioDurationSec += direction * (2048 + 1) / 48000;
    const contract = buildStandardPostContract(input);
    expect(contract.nativeAudioProof[0]!.disposition).toBe("preserve-available-native-audio");
    expect(contract.nativeAudioProof[0]!.sourceDurationSec).toBe(media.audioDurationSec);
    expect(contract.nativeAudioProof[0]!.certification).toBe("duration-only-no-speech-certification");
  });
  it("供应商5秒任务的121帧全部保留；冻结原稿不改写，派生钟不舍入", () => {
    const input = fixture(), originalSubmitted = structuredClone(input.submitted), media = input.originals[0]!.media;
    media.videoFrames = 121; media.videoDurationSec = 5.041667; media.audioDurationSec = 5.08;
    const clock = validateStandardNativeClock(media, 5);
    expect(clock.frameDelta).toBe(1); expect(clock.requestedFrames).toBe(120); expect(clock.durationSec).toBe(121 / 24);
    const contract = buildStandardPostContract(input);
    expect(contract.totalFrames).toBe(721); expect(contract.durationSec).toBe(721 / 24);
    expect(contract.timeline[0]!.durationSec).toBe(121 / 24); expect(input.submitted).toEqual(originalSubmitted);
    expect(contract.submitted).toEqual(originalSubmitted);
    const trimmed = structuredClone(contract.timeline) as StandardPostTimelineEntry[]; trimmed[0]!.durationSec = 5;
    expect(() => assertStandardPostTimeline(contract, trimmed)).toThrow(/TIMELINE_INVALID/);
  });
  it.each([-1, 2, 24])("成功供应商实际帧数相差%d按完整实测钟采用，旧名义范围不作品质否决", delta => {
    const input = fixture(), media = input.originals[0]!.media;
    media.videoFrames += delta; media.videoDurationSec = media.videoFrames / media.fps; media.audioDurationSec = media.videoDurationSec;
    const contract = buildStandardPostContract(input);
    expect(contract.totalFrames).toBe(720 + delta); expect(contract.timeline[0]!.durationSec).toBe(media.videoFrames / media.fps);
    expect(() => assertStandardPostTimeline(contract, contract.timeline)).not.toThrow();
  });
  it("实测帧数与视频流钟矛盾仍是处理事实错误，不能用整数秒替代", () => {
    const input = fixture(); input.originals[0]!.media.videoFrames++;
    expect(() => buildStandardPostContract(input)).toThrow(/MEDIA_INVALID/);
  });
  it("非整帧名义镜长不修改完整原片或补帧", () => {
    const input = fixture(); editSubmitted(input, value => {
      (value.shots as Array<Record<string, unknown>>)[0]!.duration = 5.001; value.durationSeconds = 30.001;
    });
    const contract = buildStandardPostContract(input);
    expect(contract.durationSec).toBe(30); expect(contract.totalFrames).toBe(720);
    expect(contract.originals[0]!.media.videoFrames).toBe(120);
  });
  it("名义2秒实际4.25秒按全部102帧自然完成，计划钟与原片钟分别记录", () => {
    const input = fixture(), original = input.originals[0]!;
    input.originals = [{ ...original, media: { ...original.media, videoFrames: 102, videoDurationSec: 4.25, audioDurationSec: 4.25 } }];
    editSubmitted(input, value => { value.durationSeconds = 2; value.shots = [{ shotId: original.shotId, duration: 2 }]; });
    const before = input.submitted.json, contract = buildStandardPostContract(input);
    expect(contract.durationSec).toBe(4.25); expect(contract.totalFrames).toBe(102); expect(contract.timeline[0]!.durationSec).toBe(4.25);
    expect(contract.completion.deltaFromTargetSeconds).toBe(2.25); expect(contract.submitted.json).toBe(before);
    expect(contract.compositionClock).toMatchObject({ sourceDurationSec: 4.25, entries: [{ sourceFrames: 102, sourceFps: 24, plannedOutputFrames: 102, roundingDeltaSec: 0 }] });
  });
  it.each(["workloom.standard-post/v1", "workloom.standard-post/v2"])("已封存%s按原规则读取，字节不改写且篡改/新规则冒充旧规则仍拒绝", schemaVersion => {
    const current = buildStandardPostContract(fixture());
    const { compositionClock: _clock, completion, contractSha256: _hash, ...facts } = structuredClone(current);
    const nativeAudioProof = facts.nativeAudioProof.map(row => ({ ...row, maximumBoundarySec: (schemaVersion.endsWith("v1") ? 1024 : 2048) / 48000 }));
    const body = { ...facts, schemaVersion, nativeAudioProof, ...(schemaVersion.endsWith("v2") ? { completion } : {}) };
    const sealed = { ...body, contractSha256: productionHash(body) }, serialized = JSON.stringify(sealed);
    expect(() => assertStandardPostTimeline(sealed, sealed.timeline)).not.toThrow(); expect(JSON.stringify(sealed)).toBe(serialized);
    const changed = structuredClone(sealed); changed.durationSec--; expect(() => assertStandardPostTimeline(changed, changed.timeline)).toThrow(/CONTRACT_INVALID/);
    const wrongClock = structuredClone(sealed); wrongClock.originals[0]!.media.videoFrames += 24;
    wrongClock.originals[0]!.media.videoDurationSec++; wrongClock.originals[0]!.media.audioDurationSec++;
    const { contractSha256: ignored, ...changedBody } = wrongClock; wrongClock.contractSha256 = productionHash(changedBody);
    expect(() => assertStandardPostTimeline(wrongClock, wrongClock.timeline)).toThrow(/CONTRACT_INVALID/);
  });
  it("持久化合同篡改内容、摘要、未知字段均不能放行", () => {
    const contract = buildStandardPostContract(fixture());
    for (const change of [(value: Record<string, unknown>) => { value.durationSec = 29; },
      (value: Record<string, unknown>) => { value.contractSha256 = digest("fake"); },
      (value: Record<string, unknown>) => { value.allowAudioReplacement = true; }]) {
      const loaded = JSON.parse(JSON.stringify(contract)) as Record<string, unknown>; change(loaded);
      expect(() => assertStandardPostTimeline(loaded, contract.timeline)).toThrow(/STANDARD_POST_CONTRACT_INVALID/);
    }
  });
  it("非数组、null和畸形运行时时间线保持明确拒绝", () => {
    const contract = buildStandardPostContract(fixture());
    for (const bad of [null, {}, "timeline", [null], [1]]) {
      expect(() => assertStandardPostTimeline(contract, bad)).toThrow(/STANDARD_POST_TIMELINE_INVALID/);
    }
  });
  it("单镜到100镜边界都沿用原稿；101镜明确拒绝", () => {
    for (const count of [1, 100, 101]) {
      const input = fixture(); const first = input.originals[0]!;
      const originals = Array.from({ length: count }, (_, index) => ({ ...structuredClone(first), shotId: `S${index}`,
        path: `/originals/S${index}.mp4`, sha256: digest(`boundary-original-${index}`) }));
      const json = JSON.stringify({ projectId: input.projectId, durationSeconds: count * 5,
        shots: originals.map((original) => ({ shotId: original.shotId, duration: 5 })) });
      input.submitted = { json, sha256: digest(json), bytes: Buffer.byteLength(json) }; input.originals = originals;
      if (count > 100) expect(() => buildStandardPostContract(input)).toThrow(/STANDARD_POST_/);
      else {
        const contract = buildStandardPostContract(input); expect(contract.totalFrames).toBe(count * 120);
        expect(() => assertStandardPostTimeline(contract, contract.timeline)).not.toThrow();
      }
    }
  });
  it("运行时Symbol、隐藏字段与getter编辑覆盖保持拒绝", () => {
    const contract = buildStandardPostContract(fixture());
    for (const change of [(entry: StandardPostTimelineEntry) => { Object.assign(entry, { [Symbol("replace")]: true }); },
      (entry: StandardPostTimelineEntry) => { Object.defineProperty(entry, "replaceAudio", { value: true }); },
      (entry: StandardPostTimelineEntry) => { Object.defineProperty(entry.video, "path", { enumerable: true, get: () => contract.timeline[0]!.video.path }); }]) {
      const entries = timeline(); change(entries[0]!);
      expect(() => assertStandardPostTimeline(contract, entries)).toThrow(/STANDARD_POST_TIMELINE_INVALID/);
    }
  });
  it("源记录缺原声音轨元数据、非整数字节、稀疏数组拒绝", () => {
    for (const change of [(input: StandardPostBuildInput) => { delete (input.originals[0]!.media as unknown as Record<string, unknown>).audioDurationSec; },
      (input: StandardPostBuildInput) => { input.originals[0]!.bytes = 1000.5; },
      (input: StandardPostBuildInput) => { const originals = [...input.originals]; delete originals[2]; input.originals = originals; }]) {
      expect(() => buildStandardPostContract(changed(change))).toThrow(/STANDARD_POST_/);
    }
  });
});
