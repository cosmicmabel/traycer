import { describe, expect, it } from "vitest";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeIntent,
} from "@cic/protocol/host/worktree-schemas";
import {
  buildForkWorkspaceSeed,
  buildForkWorkspaceSeedFromWorkspaceFolders,
  visibleWorktreeIntent,
} from "@/lib/worktree/fork-workspace-seed";

function bindingEntry(
  overrides: Partial<WorktreeBindingEntry>,
): WorktreeBindingEntry {
  return {
    workspacePath: "/repo",
    mode: "local",
    repoIdentifier: { owner: "cicai", repo: "cic" },
    worktreePath: null,
    branch: "development",
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: 0,
    ownedSubmodules: [],
    ...overrides,
  };
}

describe("visibleWorktreeIntent", () => {
  it("overlays staged source-chat entries on top of the persisted binding", () => {
    const binding: WorktreeBinding = {
      entries: [
        bindingEntry({ workspacePath: "/repo-a", mode: "local" }),
        bindingEntry({
          workspacePath: "/repo-b",
          mode: "worktree",
          worktreePath: "/wt/repo-b-old",
          branch: "old",
          isPrimary: false,
        }),
      ],
    };
    const stagedIntent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          workspacePath: "/repo-b",
          repoIdentifier: { owner: "cicai", repo: "repo-b" },
          isPrimary: false,
          branch: {
            type: "new",
            name: "feature/fork",
            source: "development",
            carryUncommittedChanges: false,
          },
          scripts: null,
        },
      ],
    };

    expect(visibleWorktreeIntent(binding, stagedIntent)).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-a",
          repoIdentifier: { owner: "cicai", repo: "cic" },
          isPrimary: true,
        },
        stagedIntent.entries[0],
      ],
    });
  });

  it("appends staged-only folders after binding folders", () => {
    const intent = visibleWorktreeIntent(
      { entries: [bindingEntry({ workspacePath: "/repo-a" })] },
      {
        entries: [
          {
            kind: "local",
            workspacePath: "/repo-c",
            repoIdentifier: null,
            isPrimary: false,
          },
        ],
      },
    );

    expect(intent?.entries.map((entry) => entry.workspacePath)).toEqual([
      "/repo-a",
      "/repo-c",
    ]);
  });
});

describe("buildForkWorkspaceSeed", () => {
  it("returns a workspace snapshot matching the visible intent folders", () => {
    const seed = buildForkWorkspaceSeed({
      binding: {
        entries: [
          bindingEntry({
            workspacePath: "/Users/me/cic",
            repoIdentifier: { owner: "cicai", repo: "cic" },
          }),
        ],
      },
      stagedIntent: null,
    });

    expect(seed.workspace).toEqual({
      folders: ["/Users/me/cic"],
      folderInfoByPath: {
        "/Users/me/cic": {
          path: "/Users/me/cic",
          name: "cic",
          repoIdentifier: { owner: "cicai", repo: "cic" },
        },
      },
    });
  });

  it("builds a local fallback seed from persisted terminal-agent folders", () => {
    const seed = buildForkWorkspaceSeedFromWorkspaceFolders([
      "/Users/me/cic",
      "/Users/me/project/some-pkg",
    ]);

    expect(seed.intent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/Users/me/cic",
          repoIdentifier: null,
          isPrimary: true,
        },
        {
          kind: "local",
          workspacePath: "/Users/me/project/some-pkg",
          repoIdentifier: null,
          isPrimary: false,
        },
      ],
    });
    expect(seed.workspace.folders).toEqual([
      "/Users/me/cic",
      "/Users/me/project/some-pkg",
    ]);
  });
});
