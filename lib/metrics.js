export class SessionMetrics {
  constructor() {
    this.reset()
  }

  reset() {
    this.inputTokens = 0
    this.outputTokens = 0
    this.cacheReadTokens = 0
    this.cacheWriteTokens = 0
    this.ttftTotalMs = 0
    this.ttftSamples = 0
    this.decodeMs = 0
    this.decodeTokens = 0
    this.steps = new Map()
    this.sampledTurns = new Set()
  }

  consume(event) {
    if (event.type === 'step/start') {
      this.steps.set(stepKey(event.data), { start: event.time, first: null })
      return
    }
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return
      const step = this.steps.get(stepKey(event.data))
      if (step && step.first === null) step.first = event.time
      return
    }
    if (event.type !== 'assistant/message') return

    const usage = event.data.usage
    if (usage) {
      this.inputTokens += usage.inputTokens ?? 0
      this.outputTokens += usage.outputTokens ?? 0
      this.cacheReadTokens += usage.cacheReadTokens ?? 0
      this.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    }

    const step = this.steps.get(stepKey(event.data))
    if (!step || step.first === null) return
    if (!this.sampledTurns.has(event.data.turn)) {
      this.sampledTurns.add(event.data.turn)
      this.ttftTotalMs += Math.max(0, step.first - step.start)
      this.ttftSamples++
    }
    if (usage && event.time > step.first) {
      this.decodeMs += event.time - step.first
      this.decodeTokens += usage.outputTokens ?? 0
    }
  }

  snapshot() {
    const billedInput = this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      cacheHitRate: billedInput > 0 ? Math.round((this.cacheReadTokens / billedInput) * 100) : undefined,
      ttftAverageMs: this.ttftSamples > 0 ? this.ttftTotalMs / this.ttftSamples : undefined,
      tokensPerSecond: this.decodeMs > 0 ? this.decodeTokens / (this.decodeMs / 1000) : undefined,
    }
  }
}

function stepKey(data) {
  return data.turn + ':' + data.step
}
