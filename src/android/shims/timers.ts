// node:timers/promises for the Android WebView. A message round trip yields to rendering and to
// bridge callbacks without the 4 ms clamp nested setTimeout calls get.

const waiting: Array<() => void> = []
const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null
if (channel) channel.port1.onmessage = () => waiting.shift()?.()

export function setImmediate<T = void>(value?: T): Promise<T> {
  return new Promise((resolve) => {
    const done = () => resolve(value as T)
    if (!channel) {
      setTimeout(done, 0)
      return
    }
    waiting.push(done)
    channel.port2.postMessage(null)
  })
}

export default { setImmediate }
