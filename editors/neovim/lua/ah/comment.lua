-- Commenting to the agent on lines of a file, or the whole file, with
-- `ah message send`. In a Rex pane, the comment goes to an agent in the
-- tab; in the markdown page's pane, into the file's thread, as one made on
-- the page. Moved from the user's config as it was; editors/helix/ah.scm is
-- the Helix version.

local M = {}

-- How to run ah, from setup
local cmd = { "ah" }

local function report(done)
  local out = vim.trim(done.stdout or "")
  if vim.startswith(out, "sent") then
    vim.notify("ah: sent to agent")
  elseif vim.startswith(out, "held") then
    vim.notify("ah: held until an agent is here")
  else
    local err = vim.trim(done.stderr or "")
    vim.notify("ah: " .. (err ~= "" and err or ("printed: " .. out)), vim.log.levels.ERROR)
  end
end

-- TODO(david): document send(file, text, lines, selection)
function M.send(file, text, lines, selection)
  local args = vim.list_extend(vim.list_slice(cmd), { "message", "send", "--file", file })
  if lines then table.insert(args, "--lines=" .. lines) end
  if selection and selection ~= "" then table.insert(args, "--selection=" .. selection) end
  local ok, err = pcall(vim.system, args, { stdin = text, text = true }, vim.schedule_wrap(report))
  if not ok then vim.notify("ah: couldn't run ah: " .. tostring(err), vim.log.levels.ERROR) end
end

local function prompt(lines, selection)
  local file = vim.api.nvim_buf_get_name(0)
  if file == "" or vim.bo.buftype ~= "" then
    vim.notify("ah: this buffer isn't a file", vim.log.levels.ERROR)
    return
  end
  vim.ui.input({ prompt = "Comment: " }, function(text)
    if text and vim.trim(text) ~= "" then M.send(file, text, lines, selection) end
  end)
end

local function range(first, last)
  if first == last then return tostring(first) end
  return first .. "-" .. last
end

-- TODO(david): document comment_line, comment_selection and comment_file
function M.comment_line()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  prompt(range(line, line))
end

function M.comment_selection()
  local from, to = vim.fn.getpos("v"), vim.fn.getpos(".")
  local selection = table.concat(vim.fn.getregion(from, to, { type = vim.fn.mode() }), "\n")
  local first, last = math.min(from[2], to[2]), math.max(from[2], to[2])
  vim.api.nvim_feedkeys(vim.keycode("<Esc>"), "nx", false)
  prompt(range(first, last), selection)
end

function M.comment_file() prompt(nil) end

function M.setup(opts)
  cmd = opts.cmd
  vim.keymap.set("n", "<leader>ac", M.comment_line, { desc = "ah: comment on line" })
  vim.keymap.set("x", "<leader>ac", M.comment_selection, { desc = "ah: comment on selection" })
  vim.keymap.set("n", "<leader>aC", M.comment_file, { desc = "ah: comment on file" })
end

return M
