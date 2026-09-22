import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 5240 is the port every document here quotes, so pin it rather than letting vite pick. It was
  // unpinned until 26 Aug 2026 and vite had been landing on 5173, or on whatever was free after
  // it — so a printed URL could point at nothing, or worse, at another project's dev server.
  // `strictPort` makes a clash an error instead of a silent move.
  server: { port: 5240, strictPort: true },
})
