SHELL := /bin/bash
.DEFAULT_GOAL := help
CLI := node packages/cli/dist/index.js

.PHONY: help
help: ## show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

# --- setup ------------------------------------------------------------------

.PHONY: install
install: ## install node dependencies
	npm install

.PHONY: build
build: install ## build every package
	npx tsc -p packages/core/tsconfig.json
	npx tsc -p packages/cli/tsconfig.json
	npm run build -w @blast/dashboard

.PHONY: env
env: ## create .env from .env.example if absent
	@test -f .env || (cp .env.example .env && echo "created .env")

# --- database ---------------------------------------------------------------

.PHONY: db-up
db-up: ## start HydraDB (docker compose) and wait for readiness
	docker compose up -d hydradb
	@echo "waiting for HydraDB…"
	@for i in $$(seq 1 60); do \
		if curl -sf -o /dev/null http://127.0.0.1:9090/readyz; then echo "HydraDB ready"; exit 0; fi; \
		sleep 2; \
	done; \
	echo "HydraDB did not become ready; check 'docker compose logs hydradb'"; exit 1

.PHONY: db-down
db-down: ## stop HydraDB
	docker compose down

.PHONY: db-reset
db-reset: ## destroy and recreate HydraDB storage (fast, total wipe)
	docker compose down -v
	$(MAKE) db-up

.PHONY: db-logs
db-logs: ## tail HydraDB logs
	docker compose logs -f hydradb

# --- data -------------------------------------------------------------------

.PHONY: ingest
ingest: ## rebuild the graph snapshot from the live npm registry + OSV.dev
	node scripts/run-ingest.mjs

.PHONY: load
load: ## load the vendored snapshot into a running HydraDB
	$(CLI) load

.PHONY: demo
demo: env build db-reset load mark ## one command: fresh DB, loaded graph, incident marked
	@echo ""
	@$(CLI) stats
	@echo ""
	@echo "Ready. Try:"
	@echo "  make exposure"
	@echo "  make time-machine"
	@echo "  make simulate"
	@echo "  make remediate  (what to change to fix it)"
	@echo "  make scan       (scan this very repo's lockfile)"
	@echo "  make serve      (dashboard on http://127.0.0.1:4000)"

.PHONY: mark
mark: ## mark the demo incident compromised (09:00-09:06 window)
	@$(CLI) arm

# --- queries ----------------------------------------------------------------

# The compromised package is whatever ingestion recorded in the snapshot, so the
# targets below stay correct even after a fresh `make ingest`.
SEED = $(shell $(CLI) incident --key 2>/dev/null)

.PHONY: exposure
exposure: ## blast radius for the demo incident
	$(CLI) exposure $(SEED)

.PHONY: time-machine
time-machine: ## point-in-time exposure for the demo incident
	$(CLI) time-machine $(SEED)

.PHONY: maintainers
maintainers: ## shared-maintainer risk for the demo package
	$(CLI) maintainers $$($(CLI) incident --json | node -pe "JSON.parse(require('fs').readFileSync(0)).package_key")

.PHONY: typosquats
typosquats: ## typosquat proximity check
	$(CLI) typosquats

.PHONY: remediate
remediate: ## what to change to clear the exposure
	$(CLI) remediate $(SEED)

.PHONY: scan
scan: ## scan THIS repository's own lockfile into the graph
	$(CLI) scan . --name blast-radius-itself

.PHONY: simulate
simulate: ## replay the TanStack-worm scenario against the live graph
	$(CLI) simulate --scenario tanstack-worm-2026

.PHONY: doctor
doctor: ## verify HydraDB connectivity and every engine capability used
	$(CLI) doctor --bolt

.PHONY: serve
serve: ## run the dashboard + API
	$(CLI) serve

.PHONY: dev
dev: ## dashboard with hot reload (API must be running via `make serve`)
	npm run dev -w @blast/dashboard

# --- quality ----------------------------------------------------------------

.PHONY: test
test: ## run the test suite
	npm test

.PHONY: typecheck
typecheck: ## typecheck every package
	npx tsc -p packages/core/tsconfig.json --noEmit
	npx tsc -p packages/cli/tsconfig.json --noEmit

.PHONY: clean
clean: ## remove build output
	rm -rf packages/*/dist packages/*/*.tsbuildinfo
