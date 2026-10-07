import { describe, expect, it } from 'vitest';
import { resolveFilmCompletionPolicy, filmCompletionPolicyForDocument, filmTargetSecondsFromIntent, describeFilmCompletion } from './film-completion.mjs';
describe('作品完成度优先的时长合同',()=>{
  it.each([28,30,32,35])('30秒创作目标保留完整%d秒，不产生凑秒动作或质量分',actual=>{
    const policy=filmCompletionPolicyForDocument({durationSeconds:30}), record=describeFilmCompletion(policy,actual);
    expect(record.actualSeconds).toBe(actual); expect(record.deltaFromTargetSeconds).toBe(actual-30);
    expect(record.qualityScore).toBeNull(); expect(record.artisticQuality).toBe('unverified');
    expect(policy).toMatchObject({priority:'complete-work',fitByTrim:false,fitBySpeed:false,fitByPadding:false,fitByFreeze:false,fitByLoop:false});
    expect(Object.isFrozen(policy)).toBe(true);expect(Object.isFrozen(record)).toBe(true);
  });
  it('没有目标时仍保留实测时长，单一原话时长只作为软目标',()=>{
    expect(describeFilmCompletion(resolveFilmCompletionPolicy(),32).deltaFromTargetSeconds).toBeNull();
    expect(filmTargetSecondsFromIntent('抖音30秒宣传片')).toBe(30);
    expect(filmTargetSecondsFromIntent('30 seconds ad')).toBe(30);
    expect(filmTargetSecondsFromIntent('30秒，也可能35秒')).toBeNull();
    expect(filmTargetSecondsFromIntent('高完成度短片')).toBeNull();
  });
  it('显式硬上限超出时要求修订，不放宽或自动切片',()=>{
    const policy=filmCompletionPolicyForDocument({durationSeconds:28,durationIntent:{hardMaximumSeconds:30}});
    expect(()=>describeFilmCompletion(policy,30)).not.toThrow();
    expect(()=>describeFilmCompletion(policy,30.001)).toThrow('FILM_COMPLETION_HARD_LIMIT');
    expect(()=>resolveFilmCompletionPolicy({targetSeconds:35,hardMaximumSeconds:30})).toThrow('FILM_COMPLETION_INVALID');
  });
  it.each([0,-1,NaN,Infinity,'30',false])('非法时长%s不能被缺省或强转掩盖',bad=>{
    expect(()=>filmCompletionPolicyForDocument({durationSeconds:bad})).toThrow('FILM_COMPLETION_INVALID');
    expect(()=>describeFilmCompletion(resolveFilmCompletionPolicy(),bad as number)).toThrow('FILM_COMPLETION_INVALID');
  });
  it('未知、冲突和篡改政策保持拒绝',()=>{
    expect(()=>filmCompletionPolicyForDocument({durationIntent:{exact:true}})).toThrow('FILM_COMPLETION_INVALID');
    expect(()=>filmCompletionPolicyForDocument({durationSeconds:30,durationIntent:{targetSeconds:32}})).toThrow('FILM_COMPLETION_INVALID');
    expect(()=>describeFilmCompletion({...resolveFilmCompletionPolicy(),fitByTrim:true} as never,30)).toThrow('FILM_COMPLETION_INVALID');
  });
});
