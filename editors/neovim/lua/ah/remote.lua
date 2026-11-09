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

return M
