ArenaUtil = {}

function ArenaUtil.Log(msg)
	print("[Arena] " .. tostring(msg))
end

local STATE_NAMES = {}
local function addState(enumName)
	local v = _G[enumName]
	if v ~= nil then STATE_NAMES[v] = enumName end
end
for _, n in ipairs({
	"DOTA_GAMERULES_STATE_INIT",
	"DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD",
	"DOTA_GAMERULES_STATE_CUSTOM_GAME_SETUP",
	"DOTA_GAMERULES_STATE_PLAYER_DRAFT",
	"DOTA_GAMERULES_STATE_HERO_SELECTION",
	"DOTA_GAMERULES_STATE_STRATEGY_TIME",
	"DOTA_GAMERULES_STATE_TEAM_SHOWCASE",
	"DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD",
	"DOTA_GAMERULES_STATE_PRE_GAME",
	"DOTA_GAMERULES_STATE_SCENARIO_SETUP",
	"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
	"DOTA_GAMERULES_STATE_POST_GAME",
	"DOTA_GAMERULES_STATE_DISCONNECT",
}) do addState(n) end

function ArenaUtil.StateName(state)
	return STATE_NAMES[state] or ("DOTA_GAMERULES_STATE_" .. tostring(state))
end

function ArenaUtil.IsPlayTeam(team)
	return team == DOTA_TEAM_GOODGUYS or team == DOTA_TEAM_BADGUYS
end

--- ID игроков команды в порядке слотов.
function ArenaUtil.TeamPlayers(team)
	local out = {}
	local n = PlayerResource:GetPlayerCountForTeam(team)
	for i = 1, n do
		local pid = PlayerResource:GetNthPlayerIDOnTeam(team, i)
		if pid ~= nil and pid >= 0 and PlayerResource:IsValidPlayerID(pid) then
			out[#out + 1] = pid
		end
	end
	return out
end

--- Все подключённые игроки (включая зрителей и «без команды»).
function ArenaUtil.AllPlayers()
	local out = {}
	for pid = 0, DOTA_MAX_PLAYERS - 1 do
		if PlayerResource:IsValidPlayerID(pid) then out[#out + 1] = pid end
	end
	return out
end

--- Вызов, который не роняет скрипт, если функции нет в текущей версии Dota.
function ArenaUtil.Try(fn, fallback)
	local ok, res = pcall(fn)
	if ok and res ~= nil then return res end
	return fallback
end

function ArenaUtil.Shuffle(list)
	for i = #list, 2, -1 do
		local j = RandomInt(1, i)
		list[i], list[j] = list[j], list[i]
	end
	return list
end
