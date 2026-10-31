import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadCharacterEntry } from "./character-archive.js";

type JsonRecord = Record<string, unknown>;

export type FinalCharacterIssueCode =
  | "CHARACTER_REGISTRY_INVALID"
  | "PORTRAIT_STAGE_SKIPPED"
  | "CHARACTER_ID_UNREGISTERED"
  | "PORTRAIT_BINDING_REQUIRED"
  | "CHARACTER_ASSERTION_CONFLICT"
  | "CHARACTER_AUTHORIZATION_INVALID"
  | "PORTRAIT_SOURCE_TEXT_ONLY"
  | "PORTRAIT_REFERENCE_INVALID"
  | "CHARACTER_SYSTEM_MISMATCH";

export interface FinalCharacterQualificationIssue {
  code: FinalCharacterIssueCode;
  shotId: string | null;
  message: string;
}

export interface FinalCharacterShotQualification {
  shotId: string;
  characters: string[];
  portraitReferences: Array<{
    reference: string;
    valid: boolean;
    characterId: string | null;
    reason: string | null;
  }>;
  pass: boolean;
}

export interface FinalCharacterQualificationResult {
  pass: boolean;
  issues: FinalCharacterQualificationIssue[];
  shots: FinalCharacterShotQualification[];
  resolver: {
    studioCount: number;
    uploadedCount: number;
    textCount: number;
  };
}

interface RegistryModel {
  id: string;
  name: string;
  aliases?: string[];
  archive: string;
  authorization?: string;
}

interface RegisteredCharacter {
  model: RegistryModel;
  archivePath: string;
  activeFiles: Set<string>;
  authorized: boolean;
  authorizationReason: string | null;
}

interface CharacterQualificationInput {
  repoRoot: string;
  shots: JsonRecord[];
  characterSystem?: JsonRecord;
  portraitStudio?: JsonRecord;
  portraitResolver?: JsonRecord;
}

const NO_PERSON = /^(?:none|null|n\/a|无|无人物|无角色)$/iu;
const NO_PERSON_TEXT =
  /空镜|无人物|无角色|没有(?:任何)?(?:人|人物|角色)|不出现(?:任何)?(?:人|人物|角色)|不得出现任何(?:人|人物)|不允许出现任何(?:人|人物)|禁止任何人物入镜|\bno (?:people|person|human|characters?)\b/iu;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(list);
  if (value && typeof value === "object") {
    const item = record(value);
    return list(item.characterId ?? item.id ?? item.name ?? item.lead);
  }
  const valueText = text(value);
  return valueText && !NO_PERSON.test(valueText) ? [valueText] : [];
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function pathIdentity(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function identityTokens(model: RegistryModel): string[] {
  return [
    model.id,
    model.name,
    ...(model.aliases ?? []),
    basename(model.archive),
  ].map((item) => item.trim()).filter(Boolean);
}

function loadRegistry(repoRoot: string): {
  root: string;
  models: RegisteredCharacter[];
  byToken: Map<string, RegisteredCharacter>;
  problems: string[];
} {
  const root = resolve(repoRoot, "bundles/ai-video/library/characters");
  const registryPath = join(root, "registry.json");
  const problems: string[] = [];
  const models: RegisteredCharacter[] = [];
  const byToken = new Map<string, RegisteredCharacter>();
  if (!existsSync(registryPath)) {
    return { root, models, byToken, problems: [`人物注册表不存在：${registryPath}`] };
  }
  let parsed: JsonRecord;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf8")) as JsonRecord;
  } catch (error) {
    return {
      root,
      models,
      byToken,
      problems: [`人物注册表无法解析：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const rawModels = Array.isArray(parsed.models) ? parsed.models.map(record) : [];
  if (rawModels.length === 0) problems.push("人物注册表没有 models");
  for (const [index, raw] of rawModels.entries()) {
    const id = text(raw.id);
    const name = text(raw.name);
    const archive = text(raw.archive);
    if (!id || !name || !archive) {
      problems.push(`人物注册表 models[${index}] 缺 id/name/archive`);
      continue;
    }
    const archivePath = resolve(repoRoot, archive);
    if (!inside(root, archivePath)) {
      problems.push(`${id} 的人物档案逃出角色库：${archive}`);
      continue;
    }
    let entry: ReturnType<typeof loadCharacterEntry>;
    try {
      entry = loadCharacterEntry(archivePath);
    } catch (error) {
      problems.push(`${id} 的人物档案无效：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!entry || entry.verification.status !== "passed" || Object.keys(entry.files).length === 0) {
      problems.push(`${id} 没有通过核验的当前定妆照：${entry?.verification.issues.join("；") ?? "档案不存在"}`);
      continue;
    }
    const expiresAt = text(entry.authorization?.expiresAt);
    const realAuthorized = entry.authorization?.status === "real-authorized"
      && (!expiresAt || Date.parse(expiresAt) > Date.now());
    const generated = entry.kind === "generated"
      && (text(raw.authorization) === "generated-original"
        || Object.keys(record(entry.generation)).length > 0
        || existsSync(join(archivePath, "provenance.json")));
    const authorized = realAuthorized || generated;
    const character: RegisteredCharacter = {
      model: {
        id,
        name,
        aliases: stringList(raw.aliases),
        archive,
        ...(text(raw.authorization) ? { authorization: text(raw.authorization) } : {}),
      },
      archivePath: pathIdentity(archivePath) ?? archivePath,
      activeFiles: new Set(
        Object.values(entry.files)
          .filter((file) => file && !file.startsWith("asset://"))
          .map((file) => pathIdentity(file))
          .filter((file): file is string => Boolean(file)),
      ),
      authorized,
      authorizationReason: authorized
        ? null
        : `${id} 缺有效授权：status=${String(entry.authorization?.status ?? "none")}，expiresAt=${expiresAt || "none"}`,
    };
    models.push(character);
    for (const token of identityTokens(character.model)) byToken.set(token, character);
  }
  return { root, models, byToken, problems };
}

function resolveCharacter(token: string, byToken: Map<string, RegisteredCharacter>): RegisteredCharacter | null {
  const normalized = token.trim();
  if (!normalized) return null;
  return byToken.get(normalized)
    ?? byToken.get(normalized.split(/[:：]/u)[0]!.trim())
    ?? null;
}

function collectCharacterTokens(shot: JsonRecord): string[] {
  const fields = record(shot.fields);
  const values = [
    ...list(shot.characters),
    ...list(fields.characters),
  ];
  for (const key of ["characterRef", "character_ref", "characterId"]) {
    const value = text(shot[key] ?? fields[key]);
    if (value && !/^(?:none|null|n\/a|无|无人物|无角色)$/iu.test(value)) values.push(value);
  }
  return [...new Set(values)];
}

function collectPortraitReferences(shot: JsonRecord): string[] {
  const fields = record(shot.fields);
  const values: string[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    const item = text(value);
    if (item && !/^(?:none|null|n\/a|无|无定妆照)$/iu.test(item)) values.push(item);
  };
  add(shot.portraitPath);
  add(shot.portraits);
  add(fields.portraitPath);
  add(fields.portraits);
  const prompt = text(shot.prompt);
  for (const match of prompt.matchAll(/image:\/\/characters\/[^\s,，;；。]+/gu)) {
    values.push(match[0]!.replace(/[)\]}]+$/u, ""));
  }
  return [...new Set(values)];
}

function resolvePortraitReference(
  reference: string,
  repoRoot: string,
  characterRoot: string,
  models: RegisteredCharacter[],
): { valid: boolean; characterId: string | null; reason: string | null } {
  let candidate: string;
  if (reference.startsWith("image://characters/")) {
    candidate = join(characterRoot, reference.slice("image://characters/".length));
  } else if (reference.startsWith("bundles/ai-video/library/characters/")) {
    candidate = resolve(repoRoot, reference);
  } else if (reference.startsWith("/characters/")) {
    return {
      valid: false,
      characterId: null,
      reason: "厂商占位路径 /characters/… 不是已登记的当前定妆照",
    };
  } else if (isAbsolute(reference)) {
    candidate = reference;
  } else {
    return {
      valid: false,
      characterId: null,
      reason: "定妆照必须是 image://characters/…、仓内注册表路径或当前活动文件绝对路径",
    };
  }
  const lexicalRoot = resolve(characterRoot);
  const lexicalCandidate = resolve(candidate);
  if (!inside(lexicalRoot, lexicalCandidate)) {
    return { valid: false, characterId: null, reason: "定妆照文件逃出人物库边界" };
  }
  const canonicalRoot = pathIdentity(lexicalRoot);
  const canonicalCandidate = pathIdentity(lexicalCandidate);
  if (!canonicalRoot || !canonicalCandidate) {
    return { valid: false, characterId: null, reason: "定妆照文件不存在或不可读" };
  }
  if (!inside(canonicalRoot, canonicalCandidate)) {
    return { valid: false, characterId: null, reason: "定妆照 realpath 逃出人物库边界" };
  }
  let size = 0;
  try {
    const stat = statSync(canonicalCandidate);
    size = stat.size;
    if (!stat.isFile() || size < 1024) {
      return { valid: false, characterId: null, reason: "定妆照不是有效非空图片文件" };
    }
  } catch {
    return { valid: false, characterId: null, reason: "定妆照文件不存在或不可读" };
  }
  const model = models.find((item) => item.activeFiles.has(canonicalCandidate));
  if (!model) {
    return {
      valid: false,
      characterId: null,
      reason: "定妆照不是任何注册角色当前活动版本的文件",
    };
  }
  if (!model.authorized) {
    return {
      valid: false,
      characterId: model.model.id,
      reason: model.authorizationReason ?? "角色授权无效",
    };
  }
  return { valid: true, characterId: model.model.id, reason: null };
}

function characterSystemCharacters(characterSystem: JsonRecord | undefined): JsonRecord[] {
  const characters = record(characterSystem).characters;
  return Array.isArray(characters) ? characters.map(record) : [];
}

function findCharacterSystemEntry(
  token: string,
  models: RegisteredCharacter[],
  characters: JsonRecord[],
): JsonRecord | null {
  const model = models.find((item) => identityTokens(item.model).includes(token));
  const aliases = new Set(model ? identityTokens(model.model) : [token]);
  return characters.find((item) =>
    [text(item.characterId), text(item.id), text(item.name)].some((value) => aliases.has(value)),
  ) ?? null;
}

export function inspectFinalCharacterQualification(
  input: CharacterQualificationInput,
): FinalCharacterQualificationResult {
  const issues: FinalCharacterQualificationIssue[] = [];
  const registry = loadRegistry(input.repoRoot);
  for (const problem of registry.problems) {
    issues.push({ code: "CHARACTER_REGISTRY_INVALID", shotId: null, message: problem });
  }
  const prdCharacters = characterSystemCharacters(input.characterSystem);
  const resolver = record(input.portraitResolver);
  const resolverCounts = {
    studioCount: Number.isInteger(resolver.studioCount) ? Number(resolver.studioCount) : 0,
    uploadedCount: Number.isInteger(resolver.uploadedCount) ? Number(resolver.uploadedCount) : 0,
    textCount: Number.isInteger(resolver.textCount) ? Number(resolver.textCount) : 0,
  };
  const shotResults: FinalCharacterShotQualification[] = [];
  const referencedModels = new Map<string, RegisteredCharacter>();
  let anyCharacterRequired = false;
  let anyValidPortrait = false;

  for (const [index, shot] of input.shots.entries()) {
    const shotId = text(shot.shotId) || `shot-${index + 1}`;
    const fields = record(shot.fields);
    const tokens = collectCharacterTokens(shot);
    const requiresCharacter = tokens.length > 0;
    const references = requiresCharacter ? collectPortraitReferences(shot) : [];
    const resolvedReferences = references.map((reference) => ({
      reference,
      ...resolvePortraitReference(reference, input.repoRoot, registry.root, registry.models),
    }));
    const validReferences = resolvedReferences.filter((item) => item.valid);
    anyCharacterRequired ||= requiresCharacter;
    anyValidPortrait ||= validReferences.length > 0;

    if (!requiresCharacter) {
      shotResults.push({
        shotId,
        characters: [],
        portraitReferences: [],
        pass: true,
      });
      continue;
    }

    const characterIds: string[] = [];
    for (const token of tokens) {
      const model = resolveCharacter(token, registry.byToken);
      if (!model) {
        issues.push({
          code: "CHARACTER_ID_UNREGISTERED",
          shotId,
          message: `人物 ${token} 不在当前注册表或没有通过核验的活动定妆照`,
        });
        continue;
      }
      characterIds.push(model.model.id);
      referencedModels.set(model.model.id, model);
      if (!model.authorized) {
        issues.push({
          code: "CHARACTER_AUTHORIZATION_INVALID",
          shotId,
          message: model.authorizationReason ?? `${model.model.id} 授权无效`,
        });
      }
      const prdCharacter = findCharacterSystemEntry(model.model.id, registry.models, prdCharacters);
      if (!prdCharacter) {
        issues.push({
          code: "CHARACTER_SYSTEM_MISMATCH",
          shotId,
          message: `production 使用 ${token}/${model.model.id}，PRD characterSystem 没有对应角色`,
        });
      } else {
        const prdPortrait = text(prdCharacter.portraitPath);
        const prdPortraitResult = prdPortrait
          ? resolvePortraitReference(prdPortrait, input.repoRoot, registry.root, registry.models)
          : { valid: false, reason: "PRD characterSystem 未绑定 portraitPath" };
        if (!prdPortraitResult.valid) {
          issues.push({
            code: "PORTRAIT_REFERENCE_INVALID",
            shotId,
            message: `PRD ${model.model.id} 定妆照无效：${prdPortraitResult.reason}`,
          });
        }
      }
    }

    const pending = /\bPENDING(?:_GENERATION)?\b/iu.test(
      [
        text(shot.characterRef),
        text(shot.character_ref),
        text(fields.characterRef),
        text(fields.character_ref),
      ].join(" "),
    );
    if (pending) {
      issues.push({
        code: "PORTRAIT_BINDING_REQUIRED",
        shotId,
        message: "人物仍是 PENDING_GENERATION，不能进入 G8",
      });
    }
    for (const item of resolvedReferences.filter((reference) => !reference.valid)) {
      issues.push({
        code: "PORTRAIT_REFERENCE_INVALID",
        shotId,
        message: `${item.reference}：${item.reason}`,
      });
    }
    if (validReferences.length === 0) {
      issues.push({
        code: "PORTRAIT_BINDING_REQUIRED",
        shotId,
        message: "本镜声明了人物，但没有绑定任何已注册角色的当前活动定妆照",
      });
    }

    const noPersonAssertion = [
      text(shot.characterConstraint),
      text(shot.character_constraint),
      text(fields.characterConstraint),
      text(fields.character_constraint),
    ].filter(Boolean).join("；");
    if (NO_PERSON_TEXT.test(noPersonAssertion)) {
      issues.push({
        code: "CHARACTER_ASSERTION_CONFLICT",
        shotId,
        message: "镜头声明了人物，同时人物约束又要求空镜/无人，两者不能同时放行",
      });
    }

    shotResults.push({
      shotId,
      characters: [...new Set(characterIds)],
      portraitReferences: resolvedReferences,
      pass: !issues.some((issue) => issue.shotId === shotId),
    });
  }

  const portraitStudio = record(input.portraitStudio);
  const studioStatus = text(portraitStudio.status);
  const studioReason = text(portraitStudio.reason);
  if (
    anyCharacterRequired
    && studioStatus === "skipped"
    && studioReason !== "no-characters-or-products"
  ) {
    issues.push({
      code: "PORTRAIT_STAGE_SKIPPED",
      shotId: null,
      message: `存在出镜人物，但 G5 定妆照阶段被跳过：${studioReason || "原因未记录"}`,
    });
  }
  if (
    anyCharacterRequired
    && !anyValidPortrait
    && resolverCounts.studioCount + resolverCounts.uploadedCount === 0
    && resolverCounts.textCount > 0
  ) {
    issues.push({
      code: "PORTRAIT_SOURCE_TEXT_ONLY",
      shotId: null,
      message: "portraitResolver 只有文字定妆，没有任何真实定妆照来源",
    });
  }

  return {
    pass: issues.length === 0,
    issues,
    shots: shotResults,
    resolver: resolverCounts,
  };
}
