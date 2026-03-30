# AI Workflow

## Tool Allocation

- **Claude**: Architecture decisions, code review, complex logic, debugging. Primary tool for planning and problem-solving.
- **Cursor**: Rapid code generation, iteration, refactoring. Primary tool for hands-on development.
- **Codex / Copilot**: Inline completions during coding sessions.
- **Other tools**: Gemini for image assets, DeepSeek for alternatives when rate-limited. Use whatever works.

## Guidelines

1. All AI-generated code must be reviewed and tested before merging to main.
2. Save effective prompts in a shared doc for the team. Good prompts are reusable.
3. When stuck, switch tools. Different models have different strengths.
4. Use AI for boilerplate, testing, and documentation. Spend human time on design decisions and edge cases.
5. Commit frequently. AI can regenerate code but not your thought process.
