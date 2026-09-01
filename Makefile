.PHONY: install build dev-server dev-web typecheck lint test check

install:               ## Install all JS + Python deps
	pnpm install
	cd apps/server && uv sync

build:                 ## Build the React SDK
	pnpm --filter @braincrew-lab/langchain-canvas build

dev-server:            ## Run the FastAPI reference server
	cd apps/server && uvicorn app.main:app --reload --port 8000

dev-web:               ## Run the Next.js reference app
	pnpm --filter langchain-canvas-web dev

typecheck:             ## Typecheck everything
	pnpm -r typecheck
	cd packages/canvas-py && mypy src

lint:                  ## Lint Python
	cd packages/canvas-py && ruff check .

test:                  ## Run both test suites
	cd packages/canvas-py && uv run --extra dev pytest tests -q
	pnpm --filter @braincrew-lab/langchain-canvas test

check:                 ## Everything CI runs: ruff (CI paths), mypy, pytest, tsc, vitest
	cd packages/canvas-py && uv run --extra dev ruff check src/langchain_canvas/store src/langchain_canvas/tools.py tests
	cd packages/canvas-py && uv run --extra dev mypy src
	cd packages/canvas-py && uv run --extra dev pytest tests -q
	pnpm --filter @braincrew-lab/langchain-canvas typecheck
	pnpm --filter @braincrew-lab/langchain-canvas test
