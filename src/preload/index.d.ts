import type { WickedApi } from './index'

declare global {
  interface Window {
    wicked: WickedApi
  }
}

export {}
