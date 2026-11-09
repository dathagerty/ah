import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { hasNvim } from "../../editors/neovim/testing.ts"
import { assetPath } from "../../platform/assets.ts"
import { neovimArgs } from "./neovim_command.ts"

test.skipIf(!hasNvim)(
  "the pane's nvim sets up the plugin from a path with spaces and commas",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-nvim-args-"))
    try {
      const plugin = join(dir, "a dir, with commas")
      cpSync(assetPath("editors/neovim/lua"), join(plugin, "lua"), { recursive: true })
      const file = join(dir, "notes.md")
      writeFileSync(file, "one\n")
      const done = spawnSync(
        "nvim",
        [
          "--headless",
          "--clean",
          ...neovimArgs(plugin, file),
          "-c",
          'lua io.stdout:write(#vim.api.nvim_get_autocmds({ group = "ah" }) > 0 and "set up" or "not set up")',
          "-c",
          "qa!",
        ],
        { encoding: "utf8", timeout: 5000 },
      )
      expect(done.stdout).toContain("set up")
      expect(done.stdout).not.toContain("not set up")
    } finally {
      rmSync(dir, { recursive: true })
    }
  },
)
