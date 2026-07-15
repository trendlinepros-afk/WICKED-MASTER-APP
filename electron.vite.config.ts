import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@modules': resolve(__dirname, 'modules'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@modules': resolve(__dirname, 'modules'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    server: {
      fs: {
        // modules/ lives outside the renderer root
        allow: [resolve(__dirname)]
      }
    }
  }
})
