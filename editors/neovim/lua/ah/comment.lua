-- Commenting to the agent on lines of a file, or the whole file, with
-- `ah message send`. In a Rex pane, the comment goes to an agent in the
-- tab; in the markdown page's pane, into the file's thread, as one made on
-- the page. Moved from the user's config.

local M = {}

-- How to run ah, from setup
local cmd = { "ah" }

-- The selected text goes as an argument, so it's cut to this many
-- characters, to stay well under the argument size limit
local MAX_SELECTION = 4000

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

-- TODO(david): document send(file, text, lines, selection, agent)
function M.send(file, text, lines, selection, agent)
  local args = vim.list_extend(vim.list_slice(cmd), { "message", "send", "--file", file })
  if lines then table.insert(args, "--lines=" .. lines) end
  if selection and selection ~= "" then
    table.insert(args, "--selection=" .. vim.fn.strcharpart(selection, 0, MAX_SELECTION))
  end
  if agent then vim.list_extend(args, { "--agent", agent }) end
  -- In a Rex pane, an answer about the lines can go in the tab's nvim too
  -- (the nvim skill), which the message then says
  if lines and (vim.env.REX_BLOCK or "") ~= "" then table.insert(args, "--quickfix-answers") end
  local ok, err = pcall(vim.system, args, { stdin = text, text = true }, vim.schedule_wrap(report))
  if not ok then vim.notify("ah: couldn't run ah: " .. tostring(err), vim.log.levels.ERROR) end
end

-- An agent as ah's terminal picker shows it: its part of the tab's title,
-- then its harness. A JSON null summary decodes to vim.NIL, so a missing one
-- is told by its type.
local function agent_line(agent)
  local summary = type(agent.summary) == "string" and (" | " .. agent.summary) or ""
  return agent.label .. summary .. " (" .. agent.harness .. (agent.busy and ", working" or "") .. ")"
end

-- The agents a comment from this pane can go to (`ah workspace agents`), to
-- done, back in the editor. None outside Rex, and none if listing them
-- failed, when `ah message send` picks as it does without --agent.
local function agents(done)
  local args = vim.list_extend(vim.list_slice(cmd), { "workspace", "agents" })
  local ok = pcall(vim.system, args, { text = true }, vim.schedule_wrap(function(result)
    local listed = {}
    if result.code == 0 then
      for line in vim.gsplit(result.stdout or "", "\n", { trimempty = true }) do
        local parsed, agent = pcall(vim.json.decode, line)
        if parsed and type(agent) == "table" then table.insert(listed, agent) end
      end
    end
    done(listed)
  end))
  if not ok then done({}) end
end

-- The pane's pick first, so the list starts on it; the rest in layout order
local function target_first(listed)
  local sorted = vim.tbl_filter(function(a) return a.target == true end, listed)
  return vim.list_extend(sorted, vim.tbl_filter(function(a) return a.target ~= true end, listed))
end

-- Opens the comment box (box.lua) by lines first to last of the current
-- window, for a comment on `lines` (`12` or `12-20`, or nil for the whole
-- file) with the selected text, if any.
--
-- Saves first, so the agent reads the lines the comment is on, and refuses
-- when the file on disk didn't merge and so may not have them.
--
-- With one agent in the tab, the box's title names it. With several, it
-- starts on the pane's pick and Tab changes it; the one shown goes as
-- --agent, which makes it the pane's pick for later comments.
local function prompt(first, last, lines, selection)
  local file = vim.api.nvim_buf_get_name(0)
  if file == "" or vim.bo.buftype ~= "" then
    vim.notify("ah: this buffer isn't a file", vim.log.levels.ERROR)
    return
  end
  if not require("ah.merge").save() then
    vim.notify(
      "ah: not sending: the file on disk didn't merge, so the agent may not see these lines. Try again once it merges.",
      vim.log.levels.ERROR
    )
    return
  end
  local win = vim.api.nvim_get_current_win()
  local name = vim.fn.fnamemodify(file, ":t")
  agents(function(listed)
    local sorted = target_first(listed)
    require("ah.box").open({
      win = win,
      first = first,
      last = last,
      label = lines and (name .. ":" .. lines) or name,
      agents = sorted,
      line_of = agent_line,
      send = function(text, agent) M.send(file, text, lines, selection, #sorted > 1 and agent.id or nil) end,
    })
  end)
end

local function range(first, last)
  if first == last then return tostring(first) end
  return first .. "-" .. last
end

-- TODO(david): document comment_line, comment_selection and comment_file
function M.comment_line()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  prompt(line, line, range(line, line))
end

function M.comment_selection()
  local from, to = vim.fn.getpos("v"), vim.fn.getpos(".")
  local selection = table.concat(vim.fn.getregion(from, to, { type = vim.fn.mode() }), "\n")
  local first, last = math.min(from[2], to[2]), math.max(from[2], to[2])
  vim.api.nvim_feedkeys(vim.keycode("<Esc>"), "nx", false)
  prompt(first, last, range(first, last), selection)
end

-- The box goes by the cursor's line
function M.comment_file()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  prompt(line, line, nil)
end

function M.setup(opts)
  cmd = opts.cmd
  vim.keymap.set("n", "<leader>ac", M.comment_line, { desc = "ah: comment on line" })
  vim.keymap.set("x", "<leader>ac", M.comment_selection, { desc = "ah: comment on selection" })
  vim.keymap.set("n", "<leader>aC", M.comment_file, { desc = "ah: comment on file" })
end

return M
