/** Execute the actual normal CLI duration policy and both default factual verdicts. No paid I/O. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { filmCompletionPolicyForDocument, describeFilmCompletion, type FilmCompletionRecord } from './film-completion.mjs';
import type { ProducerGateOptions, ProducerVerdict } from './producer-gate.js';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const cli=join(repo,'scripts/tools/full-chain-film.mts'), worker=join(repo,'apps/server/src/video/film-worker.ts');
const cliSource=readFileSync(cli,'utf8'),workerSource=readFileSync(worker,'utf8');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const hashes=[hash(cliSource),hash(workerSource)];
interface Node {name?:{text:string};getFullText(source:Source):string}
interface Source {statements:readonly Node[]}
interface Compiler {
  ScriptTarget:{Latest:number;ES2022:number};ModuleKind:{CommonJS:number};
  createSourceFile(path:string,source:string,target:number,parents:boolean):Source;
  isFunctionDeclaration(node:Node):boolean;isArrowFunction(node:Node):boolean;
  forEachChild(node:Node|Source,callback:(child:Node)=>void):void;
  transpileModule(source:string,options:{compilerOptions:{target:number;module:number}}):{outputText:string};
}
const ts=createRequire(join(repo,'packages/video-studio/package.json'))('typescript') as Compiler;
const parsed=ts.createSourceFile(cli,cliSource,ts.ScriptTarget.Latest,true);
const names=new Set(['completionForShots','syntheticReviewVerdict','deterministicHardFailures','reviewStage']);
const declarations=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&names.has(node.name.text));
if(declarations.length!==names.size) throw new Error('COMPLETION_FIXTURE_INVALID: CLI functions missing');
const workerAst=ts.createSourceFile(worker,workerSource,ts.ScriptTarget.Latest,true),arrows:Node[]=[];
const visit=(node:Node|Source):void=>{
  if('getFullText' in node&&ts.isArrowFunction(node)&&node.getFullText(workerAst).includes('buildProducerReviewContract(filmReviewContracts(ctx.contractSource')) arrows.push(node);
  ts.forEachChild(node,visit);
};visit(workerAst);
if(arrows.length!==1) throw new Error('COMPLETION_FIXTURE_INVALID: worker factual callback ambiguous');
const compiled=ts.transpileModule(declarations.map(node=>node.getFullText(parsed)).join('\n')
  +`\nexports.api={completionForShots,reviewStage,workerReview:(${arrows[0]!.getFullText(workerAst)})};`,
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
interface Api {
  completionForShots(doc:Record<string,unknown>,shots:Array<Record<string,unknown>>):FilmCompletionRecord;
  reviewStage(options:Omit<ProducerGateOptions,'contracts'>):Promise<ProducerVerdict>;
  workerReview(options:ProducerGateOptions):Promise<ProducerVerdict>;
}
const exports={} as {api:Api};
runInNewContext(compiled,{exports,filmCompletionPolicyForDocument,describeFilmCompletion,REVIEW_POLICY:'off',WORKER_RUNTIME:null,
  POST_RENDER_STAGES:new Set(['shot','compose','color','subtitle','danmaku','bgm','sfx','cover','mux','master']),POST_TECHNICAL_CHECKS:{},
  REVIEW_DISABLED_REASON:'unreviewed by owner instruction',reviewFilmStage:()=>{throw new Error('UNEXPECTED_MODEL_REVIEW');},
  ctx:{contractSource:{}},frame:{shotId:null},resolvedArtifacts:[{path:'explicit local fixture'}],
  buildProducerReviewContract:()=>({contractHash:'explicit fixture contract'}),filmReviewContracts:()=>({})});
afterAll(()=>{expect(hash(readFileSync(cli,'utf8'))).toBe(hashes[0]);expect(hash(readFileSync(worker,'utf8'))).toBe(hashes[1]);});
describe('实际制作入口完成度优先',()=>{
  it.each([28,32,35])('actual CLI keeps %d planned seconds for a 30s creative target',total=>{
    const shots=[total-24,12,12].map((duration,index)=>({shotId:`S${index}`,duration}));
    expect(exports.api.completionForShots({durationSeconds:30},shots)).toMatchObject({actualSeconds:total,deltaFromTargetSeconds:total-30,qualityScore:null});
  });
  it('actual CLI rejects hard overflow, missing duration, empty selection and non-numeric time before rendering',()=>{
    expect(()=>exports.api.completionForShots({durationSeconds:30,durationIntent:{hardMaximumSeconds:30}},[{duration:32}])).toThrow('FILM_COMPLETION_HARD_LIMIT');
    for(const shots of [[],[{}],[{duration:'4'}],[{duration:0}]]) expect(()=>exports.api.completionForShots({durationSeconds:30},shots)).toThrow('FILM_COMPLETION_INVALID');
  });
  it.each([true,false])('CLI and service default factual result %s never claims an artistic score',async pass=>{
    const options={stage:'prompt' as const,projectId:'LOCAL-FIXTURE',artifacts:[],deterministic:[{id:'fixture-fact',pass,hard:true,detail:'explicit deterministic fixture'}]};
    for(const verdict of [await exports.api.reviewStage(options),await exports.api.workerReview(options)]) {
      expect(verdict.approved).toBe(pass);expect(verdict.score).toBeNull();expect(verdict.qualityStatus).toBe('unverified');
    }
  });
});
