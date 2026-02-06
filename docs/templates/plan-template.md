# Epic: [Epic Title]

[Brief description of the epic - what is the overall goal?]

---

## Story: [Story Title]
**Priority**: 2
**Type**: task

[Detailed description of what needs to be done]

- Acceptance criteria
- Technical details
- Any constraints

---

## Story: [Another Story Title]
**Priority**: 2
**Type**: task
**Depends on**: [Story Title]

[Description - this story depends on the one above]

---

<!--
PLANNING DOCUMENT REFERENCE
============================

This is a template for creating planning documents that can be imported
into While Humans Sleep using `whs import`.

STRUCTURE
---------
- Each `# Epic:` header creates a parent epic bead
- Each `## Story:` header creates a task bead under the epic
- Stories are processed in order, so put foundational work first

METADATA (all optional)
-----------------------
**Priority**: 0-4 (0=critical, 4=low) - defaults to 2
**Type**: task | bug | feature | chore - defaults to task
**Depends on**: Comma-separated list of story titles this depends on

DESCRIPTION
-----------
Everything after the metadata block becomes the story description.
Markdown formatting is preserved.

DEPENDENCIES
------------
Use **Depends on** to create blocking dependencies between stories.
Reference stories by their exact title (case-insensitive).
Stories will be created with beads dependencies so they execute in order.

EXAMPLE
-------

# Epic: User Authentication

Implement JWT-based authentication for the API.

## Story: Set up auth database tables
**Priority**: 1
**Type**: task

Create the database migrations for:
- users table (id, email, password_hash, created_at)
- sessions table (id, user_id, token, expires_at)

## Story: Implement login endpoint
**Priority**: 1
**Type**: feature
**Depends on**: Set up auth database tables

Create POST /api/auth/login:
- Accept { email, password } in request body
- Validate credentials
- Return JWT token on success
- Return 401 on failure

## Story: Implement logout endpoint
**Priority**: 2
**Type**: feature
**Depends on**: Implement login endpoint

Create POST /api/auth/logout:
- Require valid JWT in Authorization header
- Invalidate the session
- Return 204 on success

## Story: Add auth middleware
**Priority**: 1
**Type**: task
**Depends on**: Set up auth database tables

Create middleware that:
- Extracts JWT from Authorization header
- Validates token signature and expiry
- Attaches user to request context
- Returns 401 if invalid

## Story: Protect API routes
**Priority**: 2
**Type**: task
**Depends on**: Add auth middleware, Implement login endpoint

Apply auth middleware to:
- All /api/users/* routes
- All /api/admin/* routes

USAGE
-----
1. Copy this template
2. Fill in your epic and stories
3. Run: whs import path/to/your-plan.md --project <project-name>

The import command will:
- Create the epic bead
- Create all story beads under it
- Set up dependencies between stories
- Report what was created

-->
