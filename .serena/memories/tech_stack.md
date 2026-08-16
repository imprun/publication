# Tech stack

- TypeScript ESM, Node >=24, Windforce TypeScript runtime entrypoint `src/main.ts`.
- Runtime: Playwright, marked, sanitize-html, Zod.
- Verification: TypeScript 6, Biome 2, Vitest 4, npm lockfile.
- ResourceType schema: `resource-types/publication.connection@1.schema.json`.
- JSON action contracts live under `schemas/`; manifest is `windforce.json`.