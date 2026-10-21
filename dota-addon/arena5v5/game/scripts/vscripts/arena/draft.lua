-- ============================================================================
--  Драфт Captains Mode на экране подготовки (CUSTOM_GAME_SETUP).
--
--  Стадии (state.phase):
--    teams    — игроки выбирают команды, назначаются капитаны;
--    draft    — капитаны по очереди банят и пикают (порядок из ARENA_CONFIG.CM_ORDER);
--    strategy — драфт закончен, короткая пауза, затем стандартный выбор героев,
--               где каждому игроку доступны только пики его команды;
--    done     — экран подготовки закрыт;
--    skipped  — хост пропустил драфт, дальше обычный All Pick.
--
--  Всё состояние лежит в CustomNetTable "arena_draft" — экран (Panorama) и
--  экспорт в худ читают его оттуда.
-- ============================================================================

ArenaDraft = ArenaDraft or {}

local TABLE = "arena_draft"
local TEAM_KEY = { [DOTA_TEAM_GOODGUYS] = "team2", [DOTA_TEAM_BADGUYS] = "team3" }

function ArenaDraft:Init()
	local cfg = ARENA_CONFIG
	self.order = cfg.CM_ORDER
	self.heroes, self.heroById, self.heroByName = self:LoadHeroPool()
	self.used = {}
	self.board = {
		team2 = { picks = {}, bans = {} },
		team3 = { picks = {}, bans = {} },
	}
	self.state = {
		phase = cfg.DRAFT_MODE == "cm" and "teams" or "skipped",
		step = 0,
		total = #self.order,
		activeteam = 0,
		pick = 0,
		main = cfg.CM_MAIN_TIME,
		reserve2 = cfg.CM_RESERVE_TIME,
		reserve3 = cfg.CM_RESERVE_TIME,
		captain2 = -1,
		captain3 = -1,
		first = cfg.CM_FIRST_PICK == "dire" and "dire" or "radiant",
		strategy_left = 0,
		mode = cfg.DRAFT_MODE,
	}

	CustomNetTables:SetTableValue(TABLE, "heroes", self:HeroListForClient())
	self:Publish()

	CustomGameEventManager:RegisterListener("arena_captain", function(_, e) self:OnClaimCaptain(e) end)
	CustomGameEventManager:RegisterListener("arena_first_pick", function(_, e) self:OnFirstPick(e) end)
	CustomGameEventManager:RegisterListener("arena_start_draft", function(_, e) self:OnStart(e) end)
	CustomGameEventManager:RegisterListener("arena_skip_draft", function(_, e) self:OnSkip(e) end)
	CustomGameEventManager:RegisterListener("arena_select", function(_, e) self:OnSelect(e) end)
	CustomGameEventManager:RegisterListener("arena_auto_teams", function(_, e) self:OnAutoTeams(e) end)

	ArenaUtil.Log("героев в пуле: " .. #self.heroes)
end

-- ---------------------------------------------------------------- пул героев

function ArenaDraft:LoadHeroPool()
	local kv = LoadKeyValues("scripts/npc/npc_heroes.txt") or {}
	local active = LoadKeyValues("scripts/npc/activelist.txt")
	local list, byId, byName = {}, {}, {}

	local function add(name)
		if byName[name] then return end
		if name == "npc_dota_hero_base" or name == "npc_dota_hero_target_dummy" then return end
		local data = kv[name] or {}
		if data.Enabled ~= nil and tonumber(data.Enabled) == 0 then return end
		local id = ArenaUtil.Try(function() return DOTAGameManager:GetHeroIDByName(name) end, tonumber(data.HeroID) or -1)
		if not id or id <= 0 then return end
		local attr = tostring(data.AttributePrimary or "")
		local entry = {
			name = name,
			id = id,
			attr = attr:gsub("DOTA_ATTRIBUTE_", ""):lower(),
		}
		list[#list + 1] = entry
		byId[id] = entry
		byName[name] = entry
	end

	if type(active) == "table" then
		for name, on in pairs(active) do
			if tostring(on) == "1" and type(name) == "string" and name:find("^npc_dota_hero_") then add(name) end
		end
	end
	if #list == 0 then
		for name, data in pairs(kv) do
			if type(name) == "string" and name:find("^npc_dota_hero_") and type(data) == "table" then add(name) end
		end
	end
	table.sort(list, function(a, b) return a.name < b.name end)
	return list, byId, byName
end

function ArenaDraft:HeroListForClient()
	local out = {}
	for i, h in ipairs(self.heroes) do out[i] = { n = h.name, id = h.id, a = h.attr } end
	return out
end

function ArenaDraft:HeroId(name)
	local h = self.heroByName[name]
	return h and h.id or -1
end

-- ---------------------------------------------------------------- состояние

function ArenaDraft:Publish()
	CustomNetTables:SetTableValue(TABLE, "state", self.state)
	CustomNetTables:SetTableValue(TABLE, "board", self.board)
end

function ArenaDraft:IsActive()
	local p = self.state.phase
	return p == "draft" or p == "strategy"
end

--- Сторона (2/3), которая ходит на шаге step (0-based).
function ArenaDraft:TeamForStep(step)
	local code = self.order[step + 1]
	if not code then return 0 end
	local firstTeam = self.state.first == "dire" and DOTA_TEAM_BADGUYS or DOTA_TEAM_GOODGUYS
	local secondTeam = firstTeam == DOTA_TEAM_GOODGUYS and DOTA_TEAM_BADGUYS or DOTA_TEAM_GOODGUYS
	return code:sub(2, 2) == "A" and firstTeam or secondTeam
end

function ArenaDraft:IsPickStep(step)
	local code = self.order[step + 1]
	return code ~= nil and code:sub(1, 1) == "p"
end

local function isHost(pid)
	local player = PlayerResource:GetPlayer(pid)
	if not player then return false end
	if ArenaUtil.Try(function() return GameRules:PlayerHasCustomGameHostPrivileges(player) end, false) then return true end
	local host = ArenaUtil.Try(function() return GetListenServerHost() end, nil)
	return host ~= nil and host == player
end

-- ---------------------------------------------------------------- события экрана

function ArenaDraft:OnClaimCaptain(e)
	if self.state.phase ~= "teams" and self.state.phase ~= "draft" then return end
	local pid = e.PlayerID
	local team = PlayerResource:GetTeam(pid)
	if not ArenaUtil.IsPlayTeam(team) then return end
	local key = team == DOTA_TEAM_GOODGUYS and "captain2" or "captain3"
	local current = self.state[key]
	-- Занять свободное место может любой игрок команды, переназначить — только хост.
	if current >= 0 and current ~= pid and PlayerResource:GetTeam(current) == team and not isHost(pid) then return end
	self.state[key] = pid
	ArenaUtil.Log("капитан " .. (team == DOTA_TEAM_GOODGUYS and "Radiant" or "Dire") .. ": " .. PlayerResource:GetPlayerName(pid))
	self:Publish()
end

function ArenaDraft:OnFirstPick(e)
	if self.state.phase ~= "teams" or not isHost(e.PlayerID) then return end
	self.state.first = e.side == "dire" and "dire" or "radiant"
	self:Publish()
end

function ArenaDraft:OnAutoTeams(e)
	if self.state.phase ~= "teams" or not isHost(e.PlayerID) then return end
	-- Раскидываем «без команды» по свободным местам. Наблюдателей (команда «Наблюдатели») не трогаем.
	for _, pid in ipairs(ArenaUtil.AllPlayers()) do
		local team = PlayerResource:GetTeam(pid)
		if not ArenaUtil.IsPlayTeam(team) and team ~= DOTA_TEAM_CUSTOM_1 then
			local r = PlayerResource:GetPlayerCountForTeam(DOTA_TEAM_GOODGUYS)
			local d = PlayerResource:GetPlayerCountForTeam(DOTA_TEAM_BADGUYS)
			local target = r <= d and DOTA_TEAM_GOODGUYS or DOTA_TEAM_BADGUYS
			if math.min(r, d) < ARENA_CONFIG.PLAYERS_PER_TEAM then
				PlayerResource:SetCustomTeamAssignment(pid, target)
			end
		end
	end
end

function ArenaDraft:OnSkip(e)
	if self.state.phase ~= "teams" or not isHost(e.PlayerID) then return end
	self.state.phase = "skipped"
	self:Publish()
	ArenaUtil.Log("хост пропустил драфт — обычный выбор героев")
	GameRules:FinishCustomGameSetup()
end

function ArenaDraft:OnStart(e)
	if self.state.phase ~= "teams" or not isHost(e.PlayerID) then return end
	for team, key in pairs({ [DOTA_TEAM_GOODGUYS] = "captain2", [DOTA_TEAM_BADGUYS] = "captain3" }) do
		local cap = self.state[key]
		if cap < 0 or PlayerResource:GetTeam(cap) ~= team then
			local players = ArenaUtil.TeamPlayers(team)
			self.state[key] = players[1] or -1
		end
	end
	self.state.phase = "draft"
	self.state.step = 0
	self:BeginStep()
	ArenaUtil.Log("драфт начался, первый выбор: " .. self.state.first)
	GameRules:GetGameModeEntity():SetContextThink("arena_draft_tick", function() return self:Tick() end, 1)
end

function ArenaDraft:OnSelect(e)
	if self.state.phase ~= "draft" then return end
	local pid = e.PlayerID
	local team = self.state.activeteam
	local captain = team == DOTA_TEAM_GOODGUYS and self.state.captain2 or self.state.captain3
	-- Ходит капитан активной команды. Хост может ходить за команду без капитана (репетиция в одиночку).
	local allowed = pid == captain or (captain < 0 and isHost(pid))
	if not allowed then return end
	local name = tostring(e.hero or "")
	if not self.heroByName[name] or self.used[name] then return end
	self:Apply(name)
end

-- ---------------------------------------------------------------- ход драфта

function ArenaDraft:BeginStep()
	local s = self.state
	s.activeteam = self:TeamForStep(s.step)
	s.pick = self:IsPickStep(s.step) and 1 or 0
	s.main = ARENA_CONFIG.CM_MAIN_TIME
	self:Publish()
end

function ArenaDraft:Apply(name)
	local s = self.state
	local key = TEAM_KEY[s.activeteam]
	local isPick = s.pick == 1
	local list = isPick and self.board[key].picks or self.board[key].bans
	list[#list + 1] = name
	self.used[name] = true
	if not isPick then
		ArenaUtil.Try(function() GameRules:AddHeroToBlacklist(name); return true end)
	end
	ArenaUtil.Log(string.format("ход %d/%d: %s %s %s", s.step + 1, s.total,
		s.activeteam == DOTA_TEAM_GOODGUYS and "Radiant" or "Dire",
		isPick and "пикает" or "банит", name))

	s.step = s.step + 1
	if s.step >= s.total then
		s.phase = "strategy"
		s.activeteam = 0
		s.pick = 0
		s.main = 0
		s.strategy_left = ARENA_CONFIG.CM_STRATEGY_TIME
		self:Publish()
		ArenaUtil.Log("драфт окончен")
	else
		self:BeginStep()
	end
end

function ArenaDraft:RandomFree()
	local free = {}
	for _, h in ipairs(self.heroes) do
		if not self.used[h.name] then free[#free + 1] = h.name end
	end
	if #free == 0 then return nil end
	return free[RandomInt(1, #free)]
end

--- Раз в секунду: таймеры хода, резерв, авто-выбор по истечении времени.
function ArenaDraft:Tick()
	local s = self.state
	if s.phase == "strategy" then
		s.strategy_left = s.strategy_left - 1
		self:Publish()
		if s.strategy_left <= 0 then
			s.phase = "done"
			self:Publish()
			GameRules:FinishCustomGameSetup()
			return nil
		end
		return 1
	end
	if s.phase ~= "draft" then return nil end

	local reserveKey = s.activeteam == DOTA_TEAM_GOODGUYS and "reserve2" or "reserve3"
	if s.main > 0 then
		s.main = s.main - 1
	else
		s[reserveKey] = math.max(0, s[reserveKey] - 1)
	end

	if s.main <= 0 and s[reserveKey] <= 0 then
		local hero = self:RandomFree()
		if hero then
			ArenaUtil.Log("время вышло — случайный " .. (s.pick == 1 and "пик" or "бан"))
			self:Apply(hero)
		end
	else
		self:Publish()
	end
	return 1
end

-- ---------------------------------------------------------------- выбор героев

--- Начался стандартный выбор героев: каждому игроку — только пики его команды.
function ArenaDraft:OnHeroSelection()
	if self.state.phase ~= "done" and self.state.phase ~= "strategy" then return end
	self.state.phase = "done"
	self:Publish()

	for team, key in pairs(TEAM_KEY) do
		local picks = self.board[key].picks
		for _, pid in ipairs(ArenaUtil.TeamPlayers(team)) do
			ArenaUtil.Try(function()
				GameRules:ClearPlayerHeroAvailability(pid)
				for _, name in ipairs(picks) do
					GameRules:AddHeroToPlayerAvailability(pid, self:HeroId(name))
				end
				return true
			end)
		end
	end

	-- За несколько секунд до конца выбора раздаём оставшихся героев тем, кто не выбрал
	-- (или выбрал героя не из пиков своей команды).
	local delay = math.max(1, ARENA_CONFIG.HERO_SELECTION_TIME - 3)
	GameRules:GetGameModeEntity():SetContextThink("arena_assign_heroes", function()
		self:AssignRemaining()
		return nil
	end, delay)
end

function ArenaDraft:AssignRemaining()
	if GameRules:State_Get() ~= DOTA_GAMERULES_STATE_HERO_SELECTION then return end
	for team, key in pairs(TEAM_KEY) do
		local picks = self.board[key].picks
		local inPicks, taken = {}, {}
		for _, n in ipairs(picks) do inPicks[n] = true end

		local needHero = {}
		for _, pid in ipairs(ArenaUtil.TeamPlayers(team)) do
			local sel = PlayerResource:GetSelectedHeroName(pid) or ""
			if sel ~= "" and inPicks[sel] and not taken[sel] then
				taken[sel] = true
			else
				if sel ~= "" and not inPicks[sel] then
					ArenaUtil.Log("игрок " .. PlayerResource:GetPlayerName(pid) .. " выбрал " .. sel .. " — не из пиков команды, меняю")
				end
				needHero[#needHero + 1] = pid
			end
		end

		for _, pid in ipairs(needHero) do
			for _, n in ipairs(picks) do
				if not taken[n] then
					taken[n] = true
					local player = PlayerResource:GetPlayer(pid)
					if player then
						ArenaUtil.Try(function() player:SetSelectedHero(n); return true end)
						ArenaUtil.Log("выдан герой " .. n .. " игроку " .. PlayerResource:GetPlayerName(pid))
					end
					break
				end
			end
		end
	end
end

-- ---------------------------------------------------------------- для худа

--- Блок draft в формате GSI наблюдателя (как в tools/mock-gsi.js).
function ArenaDraft:GsiBlock()
	local s = self.state
	local function teamBlock(team)
		local key = TEAM_KEY[team]
		local b = self.board[key]
		local out = { home_team = (team == DOTA_TEAM_GOODGUYS) }
		local picks = b.picks
		-- Если драфта не было (All Pick), берём героев, которых выбрали игроки.
		if s.phase == "skipped" then
			picks = {}
			for _, pid in ipairs(ArenaUtil.TeamPlayers(team)) do
				local n = PlayerResource:GetSelectedHeroName(pid)
				if n and n ~= "" then picks[#picks + 1] = n end
			end
		end
		for i = 0, 4 do
			local n = picks[i + 1] or ""
			out["pick" .. i .. "_id"] = n ~= "" and self:HeroId(n) or -1
			out["pick" .. i .. "_class"] = n
		end
		for i = 0, 6 do
			local n = b.bans[i + 1] or ""
			out["ban" .. i .. "_id"] = n ~= "" and self:HeroId(n) or -1
			out["ban" .. i .. "_class"] = n
		end
		return out
	end
	return {
		activeteam = s.phase == "draft" and s.activeteam or 0,
		pick = s.phase == "draft" and s.pick == 1,
		activeteam_time_remaining = s.phase == "draft" and s.main or 0,
		radiant_bonus_time = s.reserve2,
		dire_bonus_time = s.reserve3,
		team2 = teamBlock(DOTA_TEAM_GOODGUYS),
		team3 = teamBlock(DOTA_TEAM_BADGUYS),
	}
end

--- Какую стадию показывать худу, пока идёт наш драфт (худ ждёт стадии Dota).
function ArenaDraft:GsiStateOverride()
	local p = self.state.phase
	if p == "draft" then return "DOTA_GAMERULES_STATE_HERO_SELECTION" end
	if p == "strategy" then return "DOTA_GAMERULES_STATE_STRATEGY_TIME" end
	return nil
end

--- Свободный герой (не пик и не бан) для скрытого наблюдателя; помечается занятым.
function ArenaDraft:ReserveFreeHero()
	local n = self:RandomFree()
	if n then self.used[n] = true end
	return n
end
