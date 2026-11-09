-- ah's Neovim plugin. The markdown page's editor pane loads it before the
-- user's config (views/markdown/neovim_command.ts), and the user's config
-- can load it again for every other nvim; setting up twice is the same as
-- once.

local M = {}

-- TODO(david): document setup() and its options (cmd: how to run ah, as a
-- list, default { "ah" })
function M.setup(opts)
  opts = opts or {}
  local cmd = opts.cmd or { "ah" }
  local group = vim.api.nvim_create_augroup("ah", { clear = true })
  require("ah.merge").setup(group, { cmd = cmd, pane = (vim.env.AH_PANE or "") ~= "" })
  require("ah.comment").setup({ cmd = cmd })
end

return M
