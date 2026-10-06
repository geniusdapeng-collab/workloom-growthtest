/** Pure preview of the same policy used by the authenticated director worker. */
import { buildDirectorDefaults, resolveDeliveryTargets } from '../../ai-video/library/director-system/core.mjs';
export function previewDirector(input={}) {
 const {intent,options}=input;
 if(typeof intent!=='string'||!intent.trim()||intent.length>10000) throw new TypeError('请提供 1–10000 字符的创作需求');
 const targets=resolveDeliveryTargets(intent,options);
 const profile=buildDirectorDefaults({intent});
 return {schemaVersion:'workloom.director-preview/v2',previewOnly:true,mediaReady:false,
  textApiCalls:0,imageApiCalls:0,renderApiCalls:0,confirmationSteps:profile.confirmationSteps,
  requiredInputs:profile.requiredInputs,targetPlan:targets,profile,
  nextStep:'需要真实语言模型方案时，使用 workloom-director.mjs plan；制作走同一服务端预算与授权流程。'};
}
