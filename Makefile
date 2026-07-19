.PHONY: install build dev-server dev-web typecheck lint

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
