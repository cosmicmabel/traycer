SHELL := /bin/bash

GIT_ROOT := $(shell git rev-parse --show-toplevel)

.DEFAULT_GOAL := build

# ---------------------------------------------------------------------------
# Run the stack
#
# CIC is local-only software: the host server (host/) and the web GUI
# (clients/web) both run from source under bun, no accounts, no cloud.
#
#   make host                                        # start the host (loopback WS)
#   make serve-web                                   # http://127.0.0.1:8788
#   make serve-web ARGS="--bind 0.0.0.0 --port 8788" # expose on a trusted LAN
#   make docker-web                                  # build + run the container
# ---------------------------------------------------------------------------

host:
	@bun host/src/index.ts --port 47100 $(ARGS)

serve-web:
	@bunx nx run @traycer-clients/web:build
	@bun clients/web/src/server/serve.ts $(ARGS)

docker-web:
	@docker build -t cic-web .
	@docker run --rm -p 8788:8788 -v cic-home:/root/.cic cic-web

# ---------------------------------------------------------------------------
# Quality gates
# ---------------------------------------------------------------------------

install:
	@bun install

lint:
	@bun run lint

format:
	@bun run format

test:
	@bun run test

test-affected:
	@bun run test:affected

test-project:
	@bun run test:project $(ARGS)

workspace-checks:
	@scripts/pre_commit_workspace_checks.sh

pre-commit-checks:
	@pre-commit run --all-files

build:
	@bun install
	@bun run build

compile:
	@bun install
	@bun run compile

all: pre-commit-checks
	@echo "Done"

.PHONY: host serve-web docker-web \
	install lint format test test-affected test-project workspace-checks \
	pre-commit-checks build compile all
