export class InterruptState {
  constructor({ confirmMs = 1500 } = {}) {
    this.confirmMs = confirmMs
    this.armedUntil = 0
    this.exiting = false
  }

  interrupt({ running, hasInput = false, now = Date.now() }) {
    if (this.exiting) return 'none'
    if (hasInput) {
      this.armedUntil = 0
      return 'clear'
    }
    if (running) {
      this.armedUntil = 0
      return 'cancel'
    }
    if (now <= this.armedUntil) {
      this.exiting = true
      return 'exit'
    }
    this.armedUntil = now + this.confirmMs
    return 'arm-exit'
  }

  requestExit() {
    if (this.exiting) return false
    this.exiting = true
    return true
  }
}
