export interface FilmCompletionPolicy {
  readonly schemaVersion:'workloom.film-completion/v1'; readonly priority:'complete-work';
  readonly targetSeconds:number|null; readonly hardMaximumSeconds:number|null;
  readonly durationMode:'creative-target'|'explicit-hard-maximum';
  readonly preserveCompleteAction:true; readonly preserveCompleteSpeech:true; readonly nominalDurationMayVary:true;
  readonly fitByTrim:false; readonly fitBySpeed:false; readonly fitByPadding:false; readonly fitByFreeze:false; readonly fitByLoop:false;
}
export interface FilmCompletionRecord {
  readonly policy:FilmCompletionPolicy; readonly actualSeconds:number; readonly deltaFromTargetSeconds:number|null;
  readonly durationDisposition:'target-met'|'preserve-complete-work'; readonly artisticQuality:'unverified'; readonly qualityScore:null;
}
export const FILM_COMPLETION_GUIDANCE:string;
export function resolveFilmCompletionPolicy(input?:{targetSeconds?:number|null;hardMaximumSeconds?:number|null}):FilmCompletionPolicy;
export function filmCompletionPolicyForDocument(document:unknown, fallbackTargetSeconds?:number|null):FilmCompletionPolicy;
export function filmTargetSecondsFromIntent(intent:string):number|null;
export function describeFilmCompletion(policy:FilmCompletionPolicy,actualSeconds:number):FilmCompletionRecord;
