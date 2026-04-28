import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0', // 监听所有接口，支持局域网访问
    port: parseInt(process.env.VITE_FRONTEND_PORT || '5173'),
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE_URL || 'http://localhost:3100',
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://${process.env.VITE_API_HOST || 'localhost'}:${process.env.VITE_API_PORT || '3100'}`,
        ws: true,
      },
    },
  },
})