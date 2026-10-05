/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Replaces the Discord invite in src/components/discord.ts. Was NEXT_PUBLIC_DISCORD_URL. */
  readonly VITE_DISCORD_URL?: string;
}
