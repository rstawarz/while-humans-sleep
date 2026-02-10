# Code Review Output Format

AI code reviews in WHS-managed projects **must** use this structured format. The quality review agent parses this format to make routing decisions.

## Format

Every review comment must include a **Verdict** line and categorized findings:

```markdown
## Code Review Summary

**Verdict:** PASS | NEEDS_CHANGES

### Critical (must fix before merge)
- [file:line] Description of the issue

### Major (should fix before merge)
- [file:line] Description of the issue

### Minor (non-blocking, nice to have)
- [file:line] Description of the issue

### Positive
- What was done well
```

## Rules

1. **Verdict** is required and must be either `PASS` or `NEEDS_CHANGES`
2. `PASS` means zero Critical and zero Major findings
3. `NEEDS_CHANGES` means at least one Critical or Major finding
4. Omit empty sections (e.g., if no Critical items, skip that section)
5. Always include the **Positive** section — balanced reviews are better reviews
6. Use `[file:line]` format for findings so developers can locate issues quickly
7. Be specific — "potential null reference in `auth.ts:42`" not "might have bugs"

## Severity Guide

| Severity | Meaning | Examples |
|----------|---------|---------|
| Critical | Will cause bugs, security issues, or data loss | SQL injection, missing auth check, race condition |
| Major | Significant quality issue that should be fixed | Missing error handling, broken edge case, wrong algorithm |
| Minor | Style, naming, or small improvements | Naming inconsistency, missing comment, unused import |

## Example

```markdown
## Code Review Summary

**Verdict:** NEEDS_CHANGES

### Critical (must fix before merge)
- [api/src/auth.ts:42] Password comparison uses `===` instead of constant-time comparison, vulnerable to timing attacks

### Major (should fix before merge)
- [api/src/users.ts:89] Missing error handling for database query — unhandled rejection will crash the server
- [web/src/hooks/useAuth.ts:15] Token refresh race condition when multiple tabs are open

### Minor (non-blocking, nice to have)
- [api/src/routes.ts:12] Unused import `Request` from express
- [web/src/App.tsx:5] Consider extracting auth context to a separate file

### Positive
- Good test coverage for the new user registration flow
- Clean separation between API routes and business logic
- Proper input validation using zod schemas
```
