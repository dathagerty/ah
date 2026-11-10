-- What ah calls in nvim over its RPC socket (editors/neovim/remote.ts), with
-- nvim_exec_lua. Each function returns plain values, never buffer, window or
-- tab handles, which the node client can't decode without taking over the
-- server's console.

local M = {}

-- The column as the page counts it, in UTF-16 code units (JavaScript's
-- string indexes), as a byte index into `text`, clamped to the line
local function byte_column(text, column)
  local ok, index = pcall(vim.str_byteindex, text, "utf-16", column, false)
  if not ok then index = column end
  return math.max(0, math.min(index, math.max(#text - 1, 0)))
end

-- TODO(david): document reveal(line, column, row): ⌘-click in the preview
function M.reveal(line, column, row)
  -- Normal mode from insert, visual or command-line mode, as Ctrl-\ Ctrl-N
  if vim.api.nvim_get_mode().mode ~= "n" then
    vim.api.nvim_feedkeys(vim.keycode("<C-\\><C-n>"), "nx", false)
  end
  local win = vim.api.nvim_get_current_win()
  local buf = vim.api.nvim_win_get_buf(win)
  local lnum = math.max(1, math.min(line + 1, vim.api.nvim_buf_line_count(buf)))
  local text = vim.api.nvim_buf_get_lines(buf, lnum - 1, lnum, false)[1] or ""
  local col = byte_column(text, column)
  vim.api.nvim_win_set_cursor(win, { lnum, col })

  -- The first line shown: up from the cursor's line while the lines above
  -- still fit in `row` screen rows, each line as the rows it wraps to. A
  -- wrapped line that would only partly fit goes in too if that's nearer to
  -- `row`, while the cursor's line stays in the window.
  local height = vim.api.nvim_win_get_height(win)
  row = math.max(0, math.min(row, height - 1))
  local top, above = lnum, 0
  while top > 1 do
    local rows = vim.api.nvim_win_text_height(win, { start_row = top - 2, end_row = top - 2 }).all
    if above + rows > row then
      if above + rows - row < row - above and above + rows < height then top = top - 1 end
      break
    end
    above = above + rows
    top = top - 1
  end
  vim.fn.winrestview({ topline = top, lnum = lnum, col = col })
end

-- TODO(david): document open(path, line): the dashboard's ⌥-click and
-- `ah edit`, with a 1-based line as links and +line have it
function M.open(path, line)
  if vim.api.nvim_get_mode().mode ~= "n" then
    vim.api.nvim_feedkeys(vim.keycode("<C-\\><C-n>"), "nx", false)
  end
  -- :drop goes to a window already showing the file, or else edits it in the
  -- current one, leaving the buffer there hidden with any unsaved text
  vim.cmd.drop(vim.fn.fnameescape(path))
  local last = vim.api.nvim_buf_line_count(0)
  vim.api.nvim_win_set_cursor(0, { math.max(1, math.min(line, last)), 0 })
  vim.cmd("normal! zz")
end

-- TODO(david): document quickfix(title, items, open): `ah edit --quickfix`,
-- items as { file, line, col, text }, 1-based
function M.quickfix(title, items, open)
  local entries = vim.tbl_map(function(item)
    return { filename = item.file, lnum = item.line, col = item.col, text = item.text }
  end, items)
  -- The list with this title, if the stack has one, is filled again in place,
  -- so asking twice doesn't pile up lists
  local found
  for nr = 1, vim.fn.getqflist({ nr = "$" }).nr do
    if vim.fn.getqflist({ nr = nr, title = 1 }).title == title then
      found = nr
      break
    end
  end
  if found then
    vim.fn.setqflist({}, "r", { nr = found, title = title, items = entries })
    -- Current, so ]q steps through it
    vim.cmd("silent " .. found .. "chistory")
  else
    vim.fn.setqflist({}, " ", { title = title, items = entries })
  end
  if open then
    vim.cmd("copen")
  else
    vim.notify(("ah: %d in '%s' (:copen)"):format(#entries, title))
  end
end


-- How often, at most, the cursor's line goes to ah
local FOLLOW_EVERY_MS = 80

-- TODO(david): document follow(channel): the markdown pane's preview follows
-- the cursor, as the 0-based line in the buffer that's current now, sent as
-- an ah_cursor notification on `channel` when it changes
function M.follow(channel)
  local buf = vim.api.nvim_get_current_buf()
  local last
  local function send()
    -- Only for the pane's file, not a buffer opened over it
    if vim.api.nvim_get_current_buf() ~= buf then return end
    local line = vim.api.nvim_win_get_cursor(0)[1] - 1
    if line == last then return end
    last = line
    pcall(vim.rpcnotify, channel, "ah_cursor", line)
  end
  -- The first move in a while starts the timer, and the line when it fires
  -- goes, so the last of a run of moves always does
  local timer, waiting = vim.uv.new_timer(), false
  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
    group = vim.api.nvim_create_augroup("ah_follow", { clear = true }),
    callback = function()
      if waiting then return end
      waiting = true
      timer:start(FOLLOW_EVERY_MS, 0, vim.schedule_wrap(function()
        waiting = false
        send()
      end))
    end,
  })
  send()
end

return M
