-- omp-herdr-collab のワーカー名 <task>-<role>-<model> を task ごとにまとめ、
-- blocked（ユーザー待ち）を先頭に出す roster。規約外の名前は「その他」へ。
local ui = require("@herdr/ui")

local ORDER = { blocked = 1, working = 2, idle = 3, done = 4 }
local TONE = { blocked = "attention", working = "accent", idle = "muted", done = "success" }

local function parse(name)
  for _, role in { "impl", "review" } do
    local task, model = string.match(name, "^(.+)%-" .. role .. "%-([%w_]+)$")
    if task then
      return task, role, model
    end
  end
  return nil
end

local function rank(agent)
  return ORDER[agent.status] or 5
end

return herdr.mod({
  watch = { "agents" },
  init = function()
    return {}
  end,
  update = function(state)
    return state
  end,
  view = function(_, app)
    local agents = app.agents.all
    if #agents == 0 then
      return nil
    end

    local groups, keys = {}, {}
    for _, agent in agents do
      local name = agent.name or tostring(agent.id)
      local task, role, model = parse(name)
      local key = task or "その他"
      if not groups[key] then
        groups[key] = { blocked = 0, rows = {} }
        table.insert(keys, key)
      end
      local group = groups[key]
      if agent.status == "blocked" then
        group.blocked += 1
      end
      table.insert(group.rows, {
        agent = agent,
        label = if task then role .. " · " .. model else name,
      })
    end
    -- blocked を含む task を先に、あとは名前順。
    table.sort(keys, function(a, b)
      if (groups[a].blocked > 0) ~= (groups[b].blocked > 0) then
        return groups[a].blocked > 0
      end
      return a < b
    end)

    local root = ui.column({ gap = "small" })
    local blocked = #app.agents.blocked
    table.insert(root, ui.badge({
      text = blocked .. " blocked / " .. #agents,
      tone = if blocked > 0 then "attention" else "muted",
    }))
    for _, key in keys do
      local group = groups[key]
      table.sort(group.rows, function(a, b)
        if rank(a.agent) ~= rank(b.agent) then
          return rank(a.agent) < rank(b.agent)
        end
        return a.label < b.label
      end)
      local list = ui.list({})
      for _, row in group.rows do
        table.insert(list, ui.row({
          gap = "small",
          align = "center",
          ui.badge({ text = row.agent.status, tone = TONE[row.agent.status] or "normal" }),
          ui.text({ text = row.label, truncate = true }),
        }))
      end
      table.insert(root, ui.text({ text = key, weight = "bold", truncate = true }))
      table.insert(root, list)
    end
    return root
  end,
})
