-- Taking the agent's edits, in every buffer, by the rules in
-- views/markdown/editor.ts:
--
-- - Check the file on disk every 300ms and when nvim gains focus
--   (`checktime`). An unmodified buffer reloads. A modified one gets the
--   file on disk merged into it by `ah view merge --words` (views/cli.ts),
--   with the text as of the last read or save as the base. The agent's
--   edits and the unsaved typing both survive, with both versions marked
--   where they overlap (views/markdown/merge.ts).
-- - To merge, the buffer reloads from disk and then takes the merged text
--   back, changing only the lines that differ. Reloading keeps Neovim's
--   idea of when the file was read current, so a later `:w` doesn't ask
--   whether to write over a file changed since.
-- - If a merge fails, saves stop until the next change on disk merges.
--
-- In the markdown pane (AH_PANE), it also saves 650ms after typing stops and
-- when the pane loses focus, since the preview follows the file. ⌘S saves
-- anywhere a terminal sends it (the pane sends it as a kitty keyboard
-- protocol super chord, which Neovim reads as <D-s>).

local M = {}

local SAVE_DELAY, CHECK_EVERY = 650, 300

-- State lives here rather than in setup, so it survives setting up again.
-- The file's text as of the last read or save, per buffer: the merge base
local base = {}
-- Buffers whose last merge failed, which mustn't be saved over the file
local unmerged = {}
-- Merge results waiting for FileChangedShell's reload to finish, per buffer
local pending = {}
-- How to run ah, from setup
local cmd = { "ah" }
local check_timer, save_timer

local util = require("ah.util")
local read, text_of = util.read, util.text_of

-- Make the buffer's text `text`, replacing only the lines that differ, so the
-- cursor, marks and extmarks elsewhere stay where they are
local function set_text(buf, text)
  local eol = text:sub(-1) == "\n"
  local lines = vim.split(eol and text:sub(1, -2) or text, "\n", { plain = true })
  local old = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local diff = vim.text and vim.text.diff or vim.diff
  local hunks = diff(table.concat(old, "\n") .. "\n", table.concat(lines, "\n") .. "\n", {
    result_type = "indices",
  })
  -- From the bottom up, so each hunk's line numbers still hold
  for i = #hunks, 1, -1 do
    local old_start, old_count, new_start, new_count = unpack(hunks[i])
    local start = old_count == 0 and old_start or old_start - 1
    local replacement = vim.list_slice(lines, new_start, new_start + new_count - 1)
    vim.api.nvim_buf_set_lines(buf, start, start + old_count, false, replacement)
  end
  vim.bo[buf].eol = eol
end

-- `ah view merge` on the buffer's unsaved text and `disk`, or nil if it
-- failed. vim.system throws if ah isn't on the PATH, and the JSON calls on
-- text that isn't UTF-8.
local function merged(buf, disk)
  local ok, result = pcall(function()
    local input = vim.json.encode({ base = base[buf] or disk, unsaved = text_of(buf), disk = disk })
    local args = vim.list_extend(vim.list_slice(cmd), { "view", "merge", "--words" })
    local done = vim.system(args, { stdin = input, text = true }):wait()
    assert(done.code == 0, done.stderr)
    return vim.json.decode(done.stdout)
  end)
  return ok and result or nil
end

local function on_changed(ev)
  if vim.v.fcs_reason == "deleted" then return end
  if not vim.bo[ev.buf].modified then
    vim.v.fcs_choice = "reload"
    return
  end
  local disk = read(vim.api.nvim_buf_get_name(ev.buf))
  if not disk then return end
  local result = merged(ev.buf, disk)
  if not result then
    -- Handled: the buffer keeps its text, and saves stop
    vim.v.fcs_choice = ""
    unmerged[ev.buf] = true
    vim.notify("ah: couldn't merge the file on disk, not saving: is ah on the PATH?", vim.log.levels.ERROR)
    return
  end
  unmerged[ev.buf] = nil
  pending[ev.buf] = result
  vim.v.fcs_choice = "reload"
end

-- After the reload, which set the base to the file on disk (BufReadPost)
local function on_reloaded(ev)
  local result = pending[ev.buf]
  if not result then return end
  pending[ev.buf] = nil
  set_text(ev.buf, result.text)
  local conflicts = result.conflicts
  if conflicts > 0 then
    vim.notify(
      "ah: merged the file on disk, with " .. conflicts .. (conflicts == 1 and " conflict" or " conflicts") .. " marked",
      vim.log.levels.WARN
    )
  end
end

local function check()
  if vim.fn.getcmdwintype() == "" then vim.cmd("silent! checktime") end
end

-- update! rather than update: the check just before has merged whatever is
-- on disk, and a file the agent writes in between mustn't leave a save
-- stuck at a prompt
local function save()
  check()
  local buf = vim.api.nvim_get_current_buf()
  if vim.bo.modified and vim.bo.buftype == "" and vim.api.nvim_buf_get_name(0) ~= "" and not unmerged[buf] then
    vim.cmd("silent! update!")
  end
end

function M.setup(group, opts)
  cmd = opts.cmd
  local autocmd = function(events, callback) vim.api.nvim_create_autocmd(events, { group = group, callback = callback }) end

  autocmd({ "BufReadPost", "BufWritePost" }, function(ev) base[ev.buf] = read(vim.api.nvim_buf_get_name(ev.buf)) end)
  autocmd("BufWipeout", function(ev)
    base[ev.buf], unmerged[ev.buf], pending[ev.buf] = nil, nil, nil
  end)
  autocmd("FileChangedShell", on_changed)
  autocmd("FileChangedShellPost", on_reloaded)
  autocmd("FocusGained", check)
  if not check_timer then
    check_timer = vim.uv.new_timer()
    check_timer:start(CHECK_EVERY, CHECK_EVERY, vim.schedule_wrap(check))
  end

  vim.keymap.set({ "n", "i", "v" }, "<D-s>", save, { desc = "ah: save, merging the file on disk first" })
  if opts.pane then
    save_timer = save_timer or vim.uv.new_timer()
    autocmd({ "TextChanged", "TextChangedI" }, function()
      save_timer:stop()
      save_timer:start(SAVE_DELAY, 0, vim.schedule_wrap(save))
    end)
    autocmd("FocusLost", save)
  end
end

return M
