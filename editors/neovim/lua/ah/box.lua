-- A float under some lines of a window, like a review comment, for writing
-- a comment in. It's a scratch markdown buffer, so editing is Neovim's own.
--
-- Enter sends, in insert or normal mode. Ctrl-J, Shift-Enter and Alt-Enter
-- add a line; Ctrl-J is the one every terminal sends. Esc in insert mode
-- goes to normal mode, and Esc or q there cancels, as does leaving the
-- float. Not Ctrl-C: typed, it interrupts before any mapping of it runs, so
-- it only leaves insert mode, as Esc does. With several agents, Tab and
-- Shift-Tab change which one the title shows, which is the one the comment
-- goes to.

local M = {}

local MAX_WIDTH, MAX_HEIGHT = 72, 8

-- TODO(david): document open(opts): win, first and last (1-based lines to
-- put it by), label, agents, line_of(agent) and send(text, agent)
function M.open(opts)
  local agents, index = opts.agents, 1
  local info = vim.fn.getwininfo(opts.win)[1]
  local width = math.max(20, math.min(MAX_WIDTH, info.width - info.textoff - 2))

  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].filetype = "markdown"

  local function title()
    local agent = agents[index]
    return " " .. opts.label .. (agent and (" → " .. opts.line_of(agent)) or "") .. " "
  end
  local footer = " ⏎ send · ⌃J newline · " .. (#agents > 1 and "⇥ agent · " or "") .. "esc cancel "

  -- The line's row in the window, from 0, or nil when it isn't shown
  local function row_of(line)
    local row = vim.fn.screenpos(opts.win, line, 1).row
    if row == 0 then return nil end
    return row - info.winrow
  end

  -- Under the last line, or above the first when there's no room under it
  -- and there is above. Two rows of border.
  local function placed(height)
    local last = row_of(opts.last) or 0
    local first = row_of(opts.first) or last
    local row = last + 1
    if row + height + 2 > info.height and first - height - 2 >= 0 then row = first - height - 2 end
    return {
      relative = "win",
      win = opts.win,
      row = row,
      col = info.textoff,
      width = width,
      height = height,
      title = title(),
      footer = footer,
      footer_pos = "right",
    }
  end

  local win = vim.api.nvim_open_win(
    buf,
    true,
    vim.tbl_extend("force", placed(1), {
      style = "minimal",
      -- A title needs a border: the user's ('winborder'), or rounded
      border = vim.o.winborder == "" and "rounded" or nil,
    })
  )
  vim.wo[win].wrap = true
  vim.wo[win].linebreak = true

  local function height()
    return math.min(MAX_HEIGHT, math.max(1, vim.api.nvim_win_text_height(win, {}).all))
  end
  local function update()
    if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_set_config(win, placed(height())) end
  end

  local closed = false
  -- refocus: go back to the window commented on, unless focus has already
  -- gone elsewhere, which is why it's closing
  local function close(refocus)
    if closed then return end
    closed = true
    vim.cmd("stopinsert")
    if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_close(win, true) end
    if refocus and vim.api.nvim_win_is_valid(opts.win) then vim.api.nvim_set_current_win(opts.win) end
  end
  local function cancel() close(true) end

  local function send()
    local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
    close(true)
    if vim.trim(text) ~= "" then opts.send(text, agents[index]) end
  end

  local function cycle(step)
    index = (index - 1 + step) % #agents + 1
    update()
  end

  local function map(modes, lhs, rhs) vim.keymap.set(modes, lhs, rhs, { buffer = buf, nowait = true }) end
  map({ "i", "n" }, "<CR>", send)
  for _, lhs in ipairs({ "<C-j>", "<S-CR>", "<M-CR>" }) do
    map("i", lhs, "<CR>")
  end
  map("n", "<Esc>", cancel)
  map("n", "q", cancel)
  if #agents > 1 then
    map({ "i", "n" }, "<Tab>", function() cycle(1) end)
    map({ "i", "n" }, "<S-Tab>", function() cycle(-1) end)
  end

  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, { buffer = buf, callback = update })
  vim.api.nvim_create_autocmd("WinLeave", {
    buffer = buf,
    callback = function() vim.schedule(function() close(false) end) end,
  })
  vim.cmd("startinsert")
end

return M
