# Repository working rules

## Sources of truth

Before starting a stage, read:

- `docs/PROJECT_CONTEXT.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/DECISIONS.md`
- `docs/IMPLEMENTATION_STATUS.md`, when present

These documents define the project context. Do not duplicate their full content
here.

## Project language

- Communication displayed to the user may be written in Polish.
- Every file stored in the repository must be written in English.
- Internal documentation must not be written in Polish.
- All public and internal Markdown documents must use English.
- All source code, identifiers, API contracts and messages, database objects,
  tests, fixtures, code comments, docstrings, application logs, environment
  variable names, and configuration comments must be written in English.
- Norwegian is allowed only as a future user-interface translation value added
  through i18n. Translation keys and the fallback language remain English, and
  localization must not change English source code, API contracts, or database
  identifiers.
- Existing repository files containing Polish must be translated before Stage
  2 begins.

## Stage workflow

- Work on one explicitly approved roadmap stage at a time.
- Before implementation, present the plan and exact files to be changed.
- Do not expand scope or start the next stage without user approval.
- Stop after completing and verifying the approved stage.
- Update `docs/IMPLEMENTATION_STATUS.md` after every completed stage.

## Engineering quality

- Prefer simple, justified solutions; do not add technologies or abstractions
  without a demonstrated need.
- Keep business logic separate from integrations and make it testable.
- Use type hints for public Python functions and concise public docstrings.
- Catch specific exceptions, preserve error context without secrets, and never
  use a bare `except:`.
- Run the tests and quality checks required by the active roadmap stage. Python
  code will use pytest, Ruff, Black, and isort when those tools are introduced.

## Safety and Git

- Never store secrets in the repository.
- Warn before database migrations, environment changes, manual configuration,
  data removal, or potentially destructive operations.
- Do not commit or push without an explicit user command.
- Preserve unrelated and user-authored changes.

## Financial concurrency

When payment code exists, follow the approved `Order -> Payment` locking
protocol in the architecture and decisions. Use short transactions, preserve
database constraints, and never hold a database lock during a Stripe call.
