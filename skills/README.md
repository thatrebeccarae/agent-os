# Agent Skills

Skills are local `.ts` files that register additional tools into the Agent agent at startup.
Each skill file must export a `manifest` object and a `register()` function.

## Skill Structure

```typescript
import { register } from '../src/agent/tools.js';
import type { SkillManifest } from '../src/skills/types.js';

export const manifest: SkillManifest = {
  name: 'my-skill',
  description: 'What this skill does',
  version: '1.0.0',
  tools: ['my_tool_name'],
};

export function register(): void {
  register({
    name: 'my_tool_name',
    description: 'Tool description for the LLM',
    input_schema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Some input' },
      },
      required: ['input'],
    },
    handler: async (input) => {
      return `Result: ${input.input}`;
    },
  });
}
```

## Rules

- The `manifest.name` and `manifest.description` fields are required.
- `manifest.tools` should list all tool names that `register()` will add.
- One broken skill will not crash the agent — errors are caught and logged.
- Skills are loaded after core tools, so they can safely depend on `toolRegistry`.

## Configuration

| Env Var | Default | Description |
|---|---|---|
| `SKILLS_ENABLED` | `true` | Set to `false` to disable all skills |
| `SKILLS_DIR` | `skills/` | Path to the skills directory |

See `skills/example-hello.ts` for a working example.
