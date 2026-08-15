import z from '@deepseek-ai/schemastery'

const WEB_SETTING_SCHEMAS = [
  ['ui-theme', z.object({ preference: z.union(['light', 'dark', 'system']).default('system') })],
  ['locale', z.object({ preference: z.union(['zh', 'en']).required(false) })],
  ['ui-conversation', z.object({ busyEnter: z.union(['queue', 'steer']).default('queue') })],
  ['agent-presets', z.object({ default: z.string().required(false) })],
]

function valueAt(source, path) {
  let value = source
  for (const part of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = value[part]
  }
  return value
}

function hasPath(source, path) {
  let value = source
  for (const part of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) return false
    value = value[part]
  }
  return true
}

function keyRef(provider) {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
}

function effortOptions(models, selectedModel) {
  const efforts = models.find((model) => model.id === selectedModel)?.reasoningEfforts
  if (Array.isArray(efforts)) return efforts.map(String)
  if (efforts && typeof efforts === 'object') return Object.keys(efforts)
  return undefined
}

export function installWebSettingSchemas(ctx) {
  const settings = ctx.get('settings')
  if (!settings) return
  const registered = new Set(settings.describe().map((entry) => String(entry.ns)))
  for (const [namespace, schema] of WEB_SETTING_SCHEMAS) {
    if (!registered.has(namespace)) settings.register(namespace, schema)
  }
}

export async function loadWebSettings(ctx) {
  installWebSettingSchemas(ctx)
  const settings = ctx.get('settings')
  if (!settings) return { settings: null, items: [{ label: 'DSH settings', value: 'unavailable', disabled: true }] }
  const descriptors = new Map(settings.describe({ redactSecrets: true }).map((entry) => [String(entry.ns), entry]))
  const items = []
  const add = (ns, field, label, options, extra = {}) => {
    const descriptor = descriptors.get(ns)
    if (!descriptor || typeof descriptor.value !== 'object' || descriptor.value === null) return
    const value = descriptor.value[field]
    items.push({ kind: options?.length ? 'choice' : 'text', ns, field, label, value: value === undefined ? 'system' : String(value), options, revision: descriptor.revision, disabled: !settings.writable, ...extra })
  }
  // `ui-theme` (General · Appearance) and `locale` (General · Language) are
  // WebUI-only settings; they have no effect inside the TUI, so they are not
  // projected here.
  add('ui-conversation', 'busyEnter', 'Conversation · Busy Enter', ['queue', 'steer'])
  const agentPresets = ctx.get('agentPresets')
  let presetOptions
  if (agentPresets) {
    try {
      // The roster is best-effort: an unreadable root must not take down the
      // whole settings panel. Broken presets are excluded because no session
      // can be composed from one.
      presetOptions = (await agentPresets.list())
        .filter((preset) => preset.broken === undefined)
        .map((preset) => preset.id)
    } catch { /* roster unavailable; fall back to the free-text row below */ }
  }
  add('agent-presets', 'default', 'Agent · Default preset', presetOptions, presetOptions?.length ? { kind: 'agent-preset', value: agentPresets.defaultId } : undefined)
  const permissionPresets = ctx.get('permissionPresets')
  add('permission', 'defaultPreset', 'Permissions · Access and approval', permissionPresets ? [...permissionPresets.names] : undefined, { confirmValue: 'danger-full-access', confirmText: 'Enable unrestricted tool and file access?' })

  const providers = descriptors.get('llm-pi-ai')?.value?.providers
  const providerEntries = providers && typeof providers === 'object' ? Object.entries(providers) : []
  const defaultModel = descriptors.get('agent-default-model')?.value
  const selectedProvider = defaultModel && typeof defaultModel === 'object' ? defaultModel.provider : undefined
  const selectedModel = defaultModel && typeof defaultModel === 'object' ? defaultModel.model : undefined
  const llm = ctx.get('llm')
  const liveProviders = llm?.listProviders?.() ?? []
  const providerOptions = liveProviders.length > 0 ? liveProviders.map((provider) => provider.id) : providerEntries.map(([id]) => id)
  let models = providerEntries.find(([id]) => id === selectedProvider)?.[1]?.models
  if (llm?.listModels && selectedProvider) {
    try { models = await llm.listModels(selectedProvider) } catch { /* keep settings catalog fallback */ }
  }
  models = Array.isArray(models) ? models : []
  add('agent-default-model', 'provider', 'Default provider', providerOptions, { kind: 'default-provider' })
  add('agent-default-model', 'model', 'Default model', models.map((model) => model.id), { kind: 'default-model' })
  let reasoningOptions = effortOptions(models, selectedModel)
  let reasoningDefault
  if (llm?.resolveModelInfo && selectedProvider && selectedModel) {
    try {
      const info = await llm.resolveModelInfo(selectedProvider, selectedModel)
      reasoningOptions = info.reasoning?.efforts.map((effort) => String(effort.id))
      reasoningDefault = info.reasoning?.defaultEffort === undefined ? undefined : String(info.reasoning.defaultEffort)
    } catch { /* keep catalog fallback */ }
  }
  const configuredEffort = defaultModel?.reasoningEffort === undefined ? undefined : String(defaultModel.reasoningEffort)
  const reasoningValue = reasoningOptions?.includes(configuredEffort)
    ? configuredEffort
    : reasoningOptions?.includes(reasoningDefault) ? reasoningDefault : undefined
  const reasoningExtra = reasoningOptions?.length
    ? { kind: 'effort', ...reasoningValue === undefined ? {} : { value: reasoningValue } }
    : undefined
  add('agent-default-model', 'reasoningEffort', 'Reasoning effort', reasoningOptions, reasoningExtra)

  items.push({ kind: 'provider-config-info', label: 'Provider / API configuration', value: 'Use settings file or WebUI', disabled: true })
  items.push({ kind: 'new-session', label: 'New session', value: 'Enter', disabled: false })
  items.push({ kind: 'manage-sessions', label: 'Manage sessions', value: 'Enter', disabled: false })
  if (settings.documentPath) items.push({ label: 'Settings document', value: settings.documentPath, disabled: true })
  return { settings, items, title: 'Settings', subtitle: 'General and Models · Enter opens · ←/→ changes' }
}

export async function loadProviderSettings(ctx, providerId) {
  const settings = ctx.get('settings')
  const entry = ctx.get('llm')?.listConfigurableProviders?.().find((candidate) => candidate.provider === providerId)
  if (!settings || !entry) throw new Error('provider is no longer available')
  const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === entry.settingsNs)
  if (!descriptor) throw new Error('provider settings namespace is unavailable')
  const profile = valueAt(descriptor.value, entry.settingsPath)
  const configured = entry.settingsPath.length === 0 || profile !== undefined
  const removable = entry.settingsPath.length > 0 && hasPath(descriptor.user, entry.settingsPath) && !hasPath(descriptor.base, entry.settingsPath)
  const record = typeof profile === 'object' && profile !== null ? profile : {}
  const ref = typeof record.apiKeyEnv === 'string' && record.apiKeyEnv ? record.apiKeyEnv : keyRef(entry.provider)
  const credentials = ctx.get('credentials')
  let credential
  try { credential = credentials ? await credentials.describe(ref) : undefined } catch { credential = undefined }
  const items = [{ kind: 'secret', label: 'API key', value: credential?.configured ? 'configured (' + (credential.source ?? 'stored') + ')' : 'not configured', credentialRef: ref, disabled: !credentials || credential?.writable === false }]
  if (entry.settingsNs === 'llm-deepseek' || entry.settingsNs === 'llm-pi-ai') items.push({ kind: 'path', label: 'Base URL', value: typeof record.baseURL === 'string' ? record.baseURL : 'default', ns: entry.settingsNs, path: [...entry.settingsPath, 'baseURL'], revision: descriptor.revision, disabled: !settings.writable })
  if (entry.settingsNs === 'llm-pi-ai' && entry.declared === true) {
    items.push({ kind: 'path', label: 'Display name', value: typeof record.displayName === 'string' ? record.displayName : entry.displayName, ns: entry.settingsNs, path: [...entry.settingsPath, 'displayName'], revision: descriptor.revision, disabled: !settings.writable })
    const choices = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
    items.push({ kind: 'path-choice', label: 'Wire protocol', value: typeof record.api === 'string' ? record.api : choices[0], options: choices, ns: entry.settingsNs, path: [...entry.settingsPath, 'api'], revision: descriptor.revision, disabled: !settings.writable })
  }
  items.push({ label: 'Models', value: String(Array.isArray(record.models) ? record.models.length : 0), disabled: true })
  if (!configured) items.push({ kind: 'enable-provider', label: 'Enable provider', value: 'Enter', ns: entry.settingsNs, path: entry.settingsPath, revision: descriptor.revision, disabled: !settings.writable })
  if (removable) items.push({ kind: 'remove-provider', label: 'Remove provider', value: 'Enter', ns: entry.settingsNs, path: entry.settingsPath, revision: descriptor.revision, credentialRef: credential?.configured && credential?.writable ? ref : undefined, confirmText: 'Remove ' + entry.displayName + ' and its managed credential?', disabled: !settings.writable })
  return { settings, items, title: entry.displayName, subtitle: entry.provider + ' · ' + (configured ? 'configured' : 'not configured') + ' · Esc back' }
}

export async function saveWebSetting(ctx, settings, item, value) {
  if (!item || item.disabled) return
  if (item.kind === 'secret') {
    if (!value.trim()) throw new Error('API key cannot be empty')
    const credentials = ctx.get('credentials')
    if (!credentials) throw new Error('credentials service is unavailable')
    await credentials.set(item.credentialRef, value.trim())
    return
  }
  if (item.kind === 'path' || item.kind === 'path-choice') {
    const trimmed = value.trim()
    const op = trimmed === '' || trimmed === 'default' ? { op: 'unset', path: item.path } : { op: 'set', path: item.path, value: trimmed }
    await settings.mutate(item.ns, [op], item.revision)
    return
  }
  if (item.kind === 'enable-provider') return settings.mutate(item.ns, [{ op: 'set', path: item.path, value: {} }], item.revision)
  if (item.kind === 'remove-provider') {
    const credentials = ctx.get('credentials')
    if (item.credentialRef && credentials) await credentials.unset(item.credentialRef)
    return settings.mutate(item.ns, [{ op: 'unset', path: item.path }], item.revision)
  }
  if (item.kind === 'default-provider') {
    const models = await ctx.get('llm')?.listModels?.(value)
    const model = models?.[0]?.id
    if (!model) throw new Error('selected provider has no available models')
    return settings.mutate(item.ns, [
      { op: 'set', path: ['provider'], value },
      { op: 'set', path: ['model'], value: model },
      { op: 'unset', path: ['reasoningEffort'] },
    ], item.revision)
  }
  if (item.kind === 'default-model') {
    return settings.mutate(item.ns, [
      { op: 'set', path: ['model'], value },
      { op: 'unset', path: ['reasoningEffort'] },
    ], item.revision)
  }
  if (!item.ns || !item.field) return
  if (item.ns === 'locale' && item.field === 'preference' && value === 'system') return settings.replace(item.ns, {}, item.revision)
  return settings.update(item.ns, { [item.field]: value }, item.revision)
}
