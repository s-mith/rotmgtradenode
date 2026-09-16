// Next used to load .env.local / .env for us. Same precedence here: values
// already in the environment win, then .env.local, then .env.
export function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // absent — fine
    }
  }
}
