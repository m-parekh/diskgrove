import { registerPlugin } from '@capacitor/core'
import type { DiskGroveNativePlugin } from './native-api'

export const DiskGroveNative = registerPlugin<DiskGroveNativePlugin>('DiskGroveNative')
