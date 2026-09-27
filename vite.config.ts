import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { fs: { allow: [resolve(fileURLToPath(new URL('.', import.meta.url)), '..')] } },
})
