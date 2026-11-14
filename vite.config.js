import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = `http://localhost:${process.env.PORT || 3001}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on the LAN so phones can reach /play
    port: 5173,
    proxy: {
      '/api': API,
      '/media': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  preview: { host: true },
});
