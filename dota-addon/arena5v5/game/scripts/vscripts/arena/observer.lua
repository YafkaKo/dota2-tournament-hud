-- ============================================================================
--  Наблюдатель для трансляции.
--
--  OBSERVER_MODE = "unassigned": ничего не делаем — игрок остаётся «Без команды»
--  и смотрит матч как зритель.
--
--  OBSERVER_MODE = "team": отдельная команда (DOTA_TEAM_CUSTOM_1). Dota всё равно
--  выдаёт каждому игроку героя, поэтому героя наблюдателя прячем: неуязвимый,
--  невидимый, без полоски здоровья, в углу карты. Команде открываем обзор всей карты.
-- ============================================================================

ArenaObserver = ArenaObserver or {}

function ArenaObserver:Init()
	self.enabled = ARENA_CONFIG.OBSERVER_MODE == "team"
	if not self.enabled then return end
	LinkLuaModifier("modifier_arena_observer", "modifiers/modifier_arena_observer", LUA_MODIFIER_MOTION_NONE)
end

function ArenaObserver:IsObserverTeam(team)
	return self.enabled and team == DOTA_TEAM_CUSTOM_1
end

function ArenaObserver:OnHeroSelection()
	if not self.enabled then return end

	for _, pid in ipairs(ArenaUtil.TeamPlayers(DOTA_TEAM_CUSTOM_1)) do
		local hero = ArenaDraft:ReserveFreeHero()
		local player = PlayerResource:GetPlayer(pid)
		if hero and player then
			ArenaUtil.Try(function() player:SetSelectedHero(hero); return true end)
			ArenaUtil.Log("наблюдатель " .. PlayerResource:GetPlayerName(pid) .. " получил скрытого героя " .. hero)
		end
	end

	-- Обзор всей карты для команды наблюдателей; обновляем с запасом.
	GameRules:GetGameModeEntity():SetContextThink("arena_observer_vision", function()
		AddFOWViewer(DOTA_TEAM_CUSTOM_1, Vector(0, 0, 0), 30000, 40, false)
		return 30
	end, 0)
end

function ArenaObserver:OnHeroSpawned(hero)
	if not self:IsObserverTeam(hero:GetTeamNumber()) then return end
	hero:AddNewModifier(hero, nil, "modifier_arena_observer", {})
	hero:AddNoDraw()
	local corner = Vector(GetWorldMinX() + 300, GetWorldMinY() + 300, 0)
	FindClearSpaceForUnit(hero, corner, true)
end
