import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // src/integrations/supabase/client.ts builds its client at MODULE LOAD and
    // throws "supabaseUrl is required" without these, so any test importing a
    // module that transitively reaches it fails at collection — before a single
    // assertion runs. These are placeholders: nothing under test makes a
    // request, and a test that tried to would fail on the fake host rather
    // than quietly hitting the real project, which is the safer failure.
    env: {
      VITE_SUPABASE_URL: "http://localhost:54321",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-anon-key-not-a-real-credential",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
