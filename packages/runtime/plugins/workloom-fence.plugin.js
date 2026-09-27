// dsh pre-execute is an additional guard, never a production qualification issuer.
// A configured rule source must explicitly authorize an action. Unavailable or
// unsupported policy cannot become permission; no stale allow cache is retained.
export const name = 'workloom-fence'
const LEVEL_RANK = { auto: 0, review: 1, block: 2 }
const MAX_BYTES = 512 * 1024
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const actionValid = value => text(value) && value.length <= 200 && /^(?:\*|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\.\*)?)$/.test(value)
const deny = code => ({ kind: 'deny', reason: `WorkLoom 围栏拒绝：${code}；请使用已配置的受控工具与服务生产流程` })

function endpoint(value) {
  if (!text(value)) throw new Error('RULES_SOURCE_REQUIRED')
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('RULES_SOURCE_INVALID')
  return url.toString()
}
async function jsonBody(response) {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_BYTES) { await response.body?.cancel(); throw new Error('RULES_TOO_LARGE') }
  if (!response.body) throw new Error('RULES_EMPTY_BODY')
  const reader = response.body.getReader()
  const chunks = []; let bytes = 0
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('RULES_TOO_LARGE') }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const joined = new Uint8Array(bytes); let at = 0
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined))
}
function rulesOf(envelope) {
  const value = Array.isArray(envelope) ? envelope : record(envelope) && !envelope.error && record(envelope.result) ? envelope.result.data : null
  if (!Array.isArray(value) || value.length === 0 || value.length > 2000) throw new Error('RULES_INVALID')
  const ids = new Set()
  return value.map(rule => {
    if (!record(rule) || !text(rule.rule_id) || ids.has(rule.rule_id) || !Object.hasOwn(LEVEL_RANK, rule.level)) throw new Error('RULES_INVALID')
    if (Object.keys(rule).some(key => !['rule_id', 'level', 'match', 'actions', 'when', 'objectTypes', 'name', 'version', 'is_baseline', 'note'].includes(key))) throw new Error('RULES_INVALID')
    ids.add(rule.rule_id)
    const match = rule.match === undefined ? {} : rule.match
    if (!record(match)) throw new Error('RULES_INVALID')
    const actions = match.actions ?? rule.actions
    if (!Array.isArray(actions) || actions.length === 0 || !actions.every(actionValid)) throw new Error('RULES_INVALID')
    if (match.actions !== undefined && rule.actions !== undefined && JSON.stringify(match.actions) !== JSON.stringify(rule.actions)) throw new Error('RULES_AMBIGUOUS')
    // The compact adapter does not evaluate business DSL, identities, or object
    // state. Conditional/object-scoped rules cannot authorize a tool by name alone.
    const when = match.when ?? rule.when ?? 'true'
    if (typeof when !== 'string') throw new Error('RULES_INVALID')
    if (match.when !== undefined && rule.when !== undefined && match.when !== rule.when) throw new Error('RULES_AMBIGUOUS')
    const objectTypes = match.object_types ?? rule.objectTypes ?? []
    if (!Array.isArray(objectTypes) || !objectTypes.every(text)) throw new Error('RULES_INVALID')
    if (match.object_types !== undefined && rule.objectTypes !== undefined && JSON.stringify(match.object_types) !== JSON.stringify(rule.objectTypes)) throw new Error('RULES_AMBIGUOUS')
    const unsupported = !['', 'true'].includes(when.trim()) || objectTypes.length > 0
      || Object.keys(match).some(key => !['actions', 'when', 'object_types'].includes(key))
    return { level: rule.level, actions: [...actions], unsupported }
  })
}
function actionMatches(action, tool, restrictive) {
  if (action === '*' || action === tool) return true
  if (action.endsWith('.*')) { const base = action.slice(0, -2); return tool === base || tool.startsWith(`${base}.`) }
  // Preserve the old conservative namespace guard only for restrictions; an
  // auto rule for video.read must never authorize video.render.submit.
  const prefix = action.split('.')[0]
  return restrictive && (tool === prefix || tool.startsWith(`${prefix}.`))
}

export function apply(ctx, config = {}) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    let level; let matched = false
    try {
      if (exec?.signal?.aborted) return { kind: 'cancel', reason: 'WorkLoom 围栏：调用已取消' }
      const toolName = exec?.name ?? exec?.tool?.name
      if (!actionValid(toolName) || toolName.includes('*')) return deny('TOOL_IDENTITY_INVALID')
      const url = endpoint(config.rulesUrl)
      const timeoutMs = config.timeoutMs ?? 5000
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) return deny('TIMEOUT_CONFIG_INVALID')
      const tokenName = config.tokenEnv ?? 'WORKLOOM_TOKEN'
      if (!/^[A-Z][A-Z0-9_]*$/.test(tokenName)) return deny('AUTH_CONFIG_INVALID')
      if (config.requireAuth !== undefined && typeof config.requireAuth !== 'boolean') return deny('AUTH_CONFIG_INVALID')
      const token = process.env[tokenName] ?? ''
      if (/[\r\n]/.test(token) || (config.requireAuth === true && !token.trim())) return deny('RULES_AUTH_REQUIRED')
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = exec?.signal ? AbortSignal.any([exec.signal, timeout]) : timeout
      // Re-read at every action. A previous auto result does not survive a
      // source outage or policy revocation, nor leak across identities.
      const response = await fetch(url, { headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal, redirect: 'error' })
      if (!response.ok) { await response.body?.cancel(); return deny('RULES_HTTP_REJECTED') }
      const rules = rulesOf(await jsonBody(response))
      if (signal.aborted) return exec?.signal?.aborted ? { kind: 'cancel', reason: 'WorkLoom 围栏：调用已取消' } : deny('RULES_TIMEOUT')
      for (const rule of rules) {
        if (!rule.actions.some(action => actionMatches(action, toolName, rule.level !== 'auto' || rule.unsupported))) continue
        matched = true
        if (rule.unsupported) return deny('RULES_REQUIRE_SERVICE_EVALUATION')
        if (level === undefined || LEVEL_RANK[rule.level] > LEVEL_RANK[level]) level = rule.level
      }
      console.log(`[workloom-fence] judge tool=${toolName} level=${level ?? 'block'} matched=${matched}`)
    } catch {
      // Never echo source URLs, response bodies, request args or credentials.
      return exec?.signal?.aborted ? { kind: 'cancel', reason: 'WorkLoom 围栏：调用已取消' } : deny('RULES_UNVERIFIED')
    }
    if (!matched || level === undefined) return deny('ACTION_NOT_AUTHORIZED')
    if (level === 'block') return deny('POLICY_BLOCK')
    if (level === 'review') return { kind: 'ask', reason: 'WorkLoom 围栏要求审批；审批不替代服务的生产资格校验' }
    // Keep downstream errors intact; they are execution failures, not policy fetch failures.
    return next()
  })
  console.log('[workloom-fence] mounted · 未配置或未核实的工具调用默认拒绝')
}
