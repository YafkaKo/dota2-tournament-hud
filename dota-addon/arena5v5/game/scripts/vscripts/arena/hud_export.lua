-- ============================================================================
--  Отправка состояния матча в худ.
--
--  Формат повторяет GSI клиента-наблюдателя Dota 2 (см. tools/mock-gsi.js в худе):
--  provider, map, player/hero/items (team2: player0–4, team3: player5–9),
--  buildings, draft, auth. Сервер худа принимает его на тот же адрес /gsi.
--  В provider есть метка custom = true — по ней сервер понимает, что данные
--  идут из кастомки (не нужно догружать OpenDota, это главный источник).
-- ============================================================================

ArenaHud = ArenaHud or {}

local ROSHAN_BASE = 480      -- минимальное время возрождения Рошана
local ROSHAN_VARIABLE = 180  -- плюс случайный разброс

function ArenaHud:Init()
	self.matchId = self:MakeMatchId()
	self.winTeam = "none"
	self.roshanKilledAt = nil
	self.towerDamage = {}
	self.buildings = nil
	self.inFlight = false
	self.inFlightSince = 0
	self.lastErrorLog = -100
	self.okCount = 0

	ArenaUtil.Log("matchid для худа: " .. self.matchId .. ", адрес: " .. ARENA_CONFIG.HUD_URL)

	GameRules:GetGameModeEntity():SetContextThink("arena_hud", function()
		self:Send()
		return ARENA_CONFIG.SEND_INTERVAL
	end, 1)
end

--- Уникальный matchid карты: 77 + ГГММДДччммсс. С настоящими id Dota не пересекается.
function ArenaHud:MakeMatchId()
	local d = ArenaUtil.Try(function() return GetSystemDate() end, "") -- "10/21/26"
	local t = ArenaUtil.Try(function() return GetSystemTime() end, "") -- "15:30:12"
	local mm, dd, yy = d:match("(%d+)/(%d+)/(%d+)")
	local hh, mi, ss = t:match("(%d+):(%d+):(%d+)")
	if mm and hh then
		return string.format("77%02d%02d%02d%02d%02d%02d", tonumber(yy) % 100, tonumber(mm), tonumber(dd),
			tonumber(hh), tonumber(mi), tonumber(ss))
	end
	return "77" .. tostring(RandomInt(100000000, 999999999))
end

-- ---------------------------------------------------------------- события игры

function ArenaHud:OnPreGame()
	self.buildings = nil  -- пересоберём список строений на готовой карте
end

function ArenaHud:OnPostGame()
	self:Send()
end

function ArenaHud:OnEntityKilled(unit)
	local name = unit.GetUnitName and unit:GetUnitName() or ""
	if name == "npc_dota_roshan" then
		self.roshanKilledAt = GameRules:GetDOTATime(false, false)
	end
	local class = unit.GetClassname and unit:GetClassname() or ""
	if class == "npc_dota_fort" then
		self.winTeam = unit:GetTeamNumber() == DOTA_TEAM_GOODGUYS and "dire" or "radiant"
		ArenaUtil.Log("трон разрушен, победа: " .. self.winTeam)
		self:Send()
	end
end

function ArenaHud:OnDamage(event)
	local attacker = event.entindex_attacker_const and EntIndexToHScript(event.entindex_attacker_const)
	local victim = event.entindex_victim_const and EntIndexToHScript(event.entindex_victim_const)
	if not attacker or not victim or not victim.IsBuilding then return end
	if not (victim:IsTower() or victim:IsBuilding()) then return end
	local pid = attacker.GetPlayerOwnerID and attacker:GetPlayerOwnerID() or -1
	if pid == nil or pid < 0 then return end
	self.towerDamage[pid] = (self.towerDamage[pid] or 0) + (event.damage or 0)
end

-- ---------------------------------------------------------------- сбор данных

function ArenaHud:GameState()
	local override = ArenaDraft:GsiStateOverride()
	if override then return override end
	return ArenaUtil.StateName(GameRules:State_Get())
end

function ArenaHud:Roshan(clock)
	if not self.roshanKilledAt then return "alive", 0 end
	local since = clock - self.roshanKilledAt
	if since < ROSHAN_BASE then return "respawn_base", math.floor(ROSHAN_BASE - since) end
	if since < ROSHAN_BASE + ROSHAN_VARIABLE then
		return "respawn_variable", math.floor(ROSHAN_BASE + ROSHAN_VARIABLE - since)
	end
	return "alive", 0
end

function ArenaHud:MapBlock()
	local clock = math.floor(GameRules:GetDOTATime(false, true))
	local roshanState, roshanLeft = self:Roshan(clock)
	return {
		name = "start",
		matchid = self.matchId,
		game_time = math.floor(GameRules:GetGameTime()),
		clock_time = clock,
		daytime = GameRules:IsDaytime(),
		nightstalker_night = false,
		game_state = self:GameState(),
		paused = GameRules:IsGamePaused(),
		win_team = self.winTeam,
		customgamename = "arena5v5",
		ward_purchase_cooldown = 0,
		radiant_score = PlayerResource:GetTeamKills(DOTA_TEAM_GOODGUYS),
		dire_score = PlayerResource:GetTeamKills(DOTA_TEAM_BADGUYS),
		roshan_state = roshanState,
		roshan_state_end_seconds = roshanLeft,
	}
end

function ArenaHud:PlayerBlock(pid, team)
	local T = ArenaUtil.Try
	return {
		steamid = tostring(PlayerResource:GetSteamID(pid)),
		accountid = tostring(PlayerResource:GetSteamAccountID(pid)),
		name = PlayerResource:GetPlayerName(pid),
		activity = "playing",
		kills = PlayerResource:GetKills(pid),
		deaths = PlayerResource:GetDeaths(pid),
		assists = PlayerResource:GetAssists(pid),
		last_hits = PlayerResource:GetLastHits(pid),
		denies = PlayerResource:GetDenies(pid),
		kill_streak = 0,
		team_name = team == DOTA_TEAM_GOODGUYS and "radiant" or "dire",
		gold = PlayerResource:GetGold(pid),
		gold_reliable = PlayerResource:GetReliableGold(pid),
		gold_unreliable = PlayerResource:GetUnreliableGold(pid),
		gpm = math.floor(T(function() return PlayerResource:GetGoldPerMin(pid) end, 0)),
		xpm = math.floor(T(function() return PlayerResource:GetXPPerMin(pid) end, 0)),
		net_worth = T(function() return PlayerResource:GetNetWorth(pid) end, 0),
		hero_damage = math.floor(T(function() return PlayerResource:GetRawPlayerDamage(pid) end, 0)),
		tower_damage = math.floor(self.towerDamage[pid] or 0),
		hero_healing = math.floor(T(function() return PlayerResource:GetHealing(pid) end, 0)),
	}
end

function ArenaHud:HeroBlock(pid)
	local hero = PlayerResource:GetSelectedHeroEntity(pid)
	if not hero or hero:IsNull() then
		local name = PlayerResource:GetSelectedHeroName(pid) or ""
		return { id = ArenaDraft:HeroId(name), name = name, level = 0, alive = false }
	end
	local alive = hero:IsAlive()
	return {
		id = ArenaDraft:HeroId(hero:GetUnitName()),
		name = hero:GetUnitName(),
		level = hero:GetLevel(),
		xp = ArenaUtil.Try(function() return hero:GetCurrentXP() end, 0),
		alive = alive,
		respawn_seconds = alive and 0 or math.ceil(ArenaUtil.Try(function() return hero:GetTimeUntilRespawn() end, 0)),
		health = hero:GetHealth(),
		max_health = hero:GetMaxHealth(),
		health_percent = math.floor(hero:GetHealthPercent()),
		mana = math.floor(hero:GetMana()),
		max_mana = math.floor(hero:GetMaxMana()),
		mana_percent = math.floor(hero:GetManaPercent()),
		buyback_cooldown = math.ceil(ArenaUtil.Try(function() return hero:GetBuybackCooldownTime() end, 0)),
	}
end

local function itemInfo(item)
	if not item or item:IsNull() then return { name = "empty" } end
	local out = { name = item:GetAbilityName() }
	local charges = ArenaUtil.Try(function() return item:GetCurrentCharges() end, 0)
	if charges and charges > 0 then out.charges = charges end
	return out
end

function ArenaHud:ItemsBlock(pid)
	local hero = PlayerResource:GetSelectedHeroEntity(pid)
	local out = {}
	for s = 0, 5 do
		out["slot" .. s] = itemInfo(hero and not hero:IsNull() and hero:GetItemInSlot(s) or nil)
	end
	-- Нейтральный предмет и зачарование (в патчах 7.38+ два слота).
	local active = DOTA_ITEM_NEUTRAL_ACTIVE_SLOT or DOTA_ITEM_NEUTRAL_SLOT or 16
	local passive = DOTA_ITEM_NEUTRAL_PASSIVE_SLOT or 17
	local alive = hero and not hero:IsNull()
	out.neutral0 = itemInfo(alive and hero:GetItemInSlot(active) or nil)
	out.neutral1 = itemInfo(alive and hero:GetItemInSlot(passive) or nil)
	return out
end

function ArenaHud:CollectBuildings()
	local list = {}
	for _, class in ipairs({ "npc_dota_tower", "npc_dota_barracks", "npc_dota_fort" }) do
		for _, ent in ipairs(Entities:FindAllByClassname(class)) do
			local team = ent:GetTeamNumber()
			if ArenaUtil.IsPlayTeam(team) then
				list[#list + 1] = {
					ent = ent,
					name = ent:GetName() ~= "" and ent:GetName() or (class .. "_" .. ent:entindex()),
					side = team == DOTA_TEAM_GOODGUYS and "radiant" or "dire",
					max = ent:GetMaxHealth(),
				}
			end
		end
	end
	if #list > 0 then
		local names = {}
		for _, b in ipairs(list) do names[#names + 1] = b.name end
		ArenaUtil.Log("строений найдено: " .. #list .. " (" .. table.concat(names, ", ") .. ")")
	end
	return list
end

function ArenaHud:BuildingsBlock()
	if not self.buildings or #self.buildings == 0 then self.buildings = self:CollectBuildings() end
	local out = { radiant = {}, dire = {} }
	for _, b in ipairs(self.buildings) do
		local alive = b.ent and not b.ent:IsNull() and b.ent:IsAlive()
		out[b.side][b.name] = { health = alive and b.ent:GetHealth() or 0, max_health = b.max }
	end
	return out
end

function ArenaHud:Payload()
	local body = {
		provider = {
			name = "Arena 5x5 (custom game)",
			appid = 570,
			version = 1,
			timestamp = math.floor(Time()),
			custom = true,
		},
		map = self:MapBlock(),
		auth = { token = ARENA_CONFIG.HUD_TOKEN },
	}

	local player = { team2 = {}, team3 = {} }
	local hero = { team2 = {}, team3 = {} }
	local items = { team2 = {}, team3 = {} }
	local any = false
	for team, key in pairs({ [DOTA_TEAM_GOODGUYS] = "team2", [DOTA_TEAM_BADGUYS] = "team3" }) do
		local base = team == DOTA_TEAM_GOODGUYS and 0 or 5
		for i, pid in ipairs(ArenaUtil.TeamPlayers(team)) do
			if i <= 5 then
				local slot = "player" .. (base + i - 1)
				player[key][slot] = self:PlayerBlock(pid, team)
				hero[key][slot] = self:HeroBlock(pid)
				items[key][slot] = self:ItemsBlock(pid)
				any = true
			end
		end
	end
	if any then
		body.player = player
		body.hero = hero
		body.items = items
	end

	local state = GameRules:State_Get()
	if state >= DOTA_GAMERULES_STATE_PRE_GAME then
		body.buildings = self:BuildingsBlock()
	end
	if ArenaDraft.state and ArenaDraft.state.mode == "cm" or state <= DOTA_GAMERULES_STATE_PRE_GAME then
		body.draft = ArenaDraft:GsiBlock()
	end
	return body
end

-- ---------------------------------------------------------------- отправка

function ArenaHud:Send()
	local now = Time()
	-- Не копим запросы, если худ не отвечает; через 5 с считаем запрос потерянным.
	if self.inFlight and now - self.inFlightSince < 5 then return end

	local ok, body = pcall(function() return ArenaJSON.encode(self:Payload()) end)
	if not ok then
		self:LogError("ошибка сборки данных: " .. tostring(body))
		return
	end

	local req = CreateHTTPRequestScriptVM("POST", ARENA_CONFIG.HUD_URL)
	if not req then
		self:LogError("CreateHTTPRequestScriptVM вернул nil — HTTP из скриптов недоступен")
		return
	end
	req:SetHTTPRequestRawPostBody("application/json", body)
	req:SetHTTPRequestAbsoluteTimeoutMS(3000)
	self.inFlight = true
	self.inFlightSince = now
	req:Send(function(res)
		self.inFlight = false
		local code = res and res.StatusCode or 0
		if code == 200 then
			self.okCount = self.okCount + 1
			if self.okCount == 1 then ArenaUtil.Log("худ принял первый пакет — связь есть") end
		elseif code == 403 then
			self:LogError("худ отклонил пакет (403): проверьте HUD_TOKEN и token в config/server.json")
		else
			self:LogError("худ не ответил (код " .. tostring(code) .. "): проверьте HUD_URL и что сервер худа запущен")
		end
	end)
end

function ArenaHud:LogError(msg)
	if not ARENA_CONFIG.LOG_HTTP then return end
	local now = Time()
	if now - self.lastErrorLog < 10 then return end
	self.lastErrorLog = now
	ArenaUtil.Log(msg)
end
