# Task completion

A backend change is locally verified only when all pass:

1. `npm run check` (typecheck, Biome, Vitest)
2. `npm run build`
3. `npm audit --audit-level=moderate`
4. Core experimental manifest parser check when runtimeAccess write fields change
5. Secret-leak review of schemas, outputs, fixtures, and Git status

Do not report live Tistory verification without an explicitly approved private smoke. Core issue #236 is complete and the target Cloud reports it deployed, but verify the exact target runtime before reporting runtime integration. Commit/push/deploy are separate states.