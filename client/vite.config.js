import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@element-plus/icons-vue')) return 'vendor-icons'
          if (id.includes('element-plus')) return 'vendor-element-plus'
          if (id.includes('axios')) return 'vendor-axios'
          if (id.includes('/vue/')) return 'vendor-vue'
          return 'vendor'
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: parseInt(process.env.VITE_FRONTEND_PORT || '5173'),
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE_URL || 'http://localhost:3101',
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://${process.env.VITE_API_HOST || 'localhost'}:${process.env.VITE_API_PORT || '3101'}`,
        ws: true,
      },
    },
  },
})
