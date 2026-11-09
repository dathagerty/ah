-- Telling ah about this nvim when it runs in a Rex pane, so ah can open
-- files and lists in it over its RPC socket (v:servername, which nvim always
-- listens on): `ah hook editor start` on VimEnter, and `end` on VimLeavePre
-- (core/hook.ts). Not in the markdown page's pane (AH_PANE), whose nvim
-- belongs to the page and has a socket of its own, and not outside Rex.

local M = {}

-- How long quitting waits for `ah hook editor end`
local END_WAIT_MS = 300

local function set(name) return (vim.env[name] or "") ~= "" end

local function report(cmd, event)
  local args = vim.list_extend(vim.list_slice(cmd), { "hook", "editor", event, "--server", vim.v.servername })
  local ok, job = pcall(vim.system, args, { text = true })
  return ok and job or nil
end

-- Whether this nvim has said it started, so setting up again doesn't
local started = false

local function start(cmd)
  if started then return end
  started = true
  report(cmd, "start")
end

function M.setup(group, opts)
  if not set("REX_BLOCK") or set("AH_PANE") or vim.v.servername == "" then return end
  local cmd = opts.cmd
  if vim.v.vim_did_enter == 1 then
    start(cmd)
  else
    vim.api.nvim_create_autocmd("VimEnter", { group = group, once = true, callback = function() start(cmd) end })
  end
  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = group,
    callback = function()
      local job = report(cmd, "end")
      -- nvim is about to exit, which could cut the report off; ah drops an
      -- nvim whose socket is gone anyway
      if job then pcall(job.wait, job, END_WAIT_MS) end
    end,
  })
end

return M
