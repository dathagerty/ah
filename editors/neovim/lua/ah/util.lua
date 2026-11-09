-- Helpers the plugin's modules share

local M = {}

-- The file at `path` as it is on disk, or nil if it can't be read
function M.read(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end

-- The buffer's text as a save would write it
function M.text_of(buf)
  local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
  if vim.bo[buf].eol then text = text .. "\n" end
  return text
end

return M
