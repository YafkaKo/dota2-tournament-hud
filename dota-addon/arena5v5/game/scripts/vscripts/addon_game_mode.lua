-- ============================================================================
--  Arena 5x5 — обычная Dota 5x5 на карте dota для студенческого турнира.
--
--  Что добавляет к стандартной игре:
--    • экран подготовки: выбор команд, капитаны, драфт Captains Mode;
--    • отправку состояния матча в худ (формат GSI наблюдателя) по HTTP;
--    • наблюдателя для трансляции (см. OBSERVER_MODE в arena/config.lua).
--
--  Всё остальное — крипы, Рошан, руны, башни, предметы — делает сама Dota.
-- ============================================================================

require("arena/config")
require("arena/json")
require("arena/util")
require("arena/draft")
require("arena/observer")
require("arena/hud_export")

if ArenaGameMode == nil then
	ArenaGameMode = class({})
end

function Precache(context)
	PrecacheResource("particle", "particles/generic_gameplay/generic_stunned.vpcf", context)
end

function Activate()
	GameRules.Arena = ArenaGameMode()
	GameRules.Arena:Init()
end

function ArenaGameMode:Init()
	local cfg = ARENA_CONFIG
	local mode = GameRules:GetGameModeEntity()

	ArenaUtil.Log("Arena 5x5 запускается, режим драфта: " .. cfg.DRAFT_MODE ..
		", наблюдатель: " .. cfg.OBSERVER_MODE)

	-- Команды
	GameRules:SetCustomGameTeamMaxPlayers(DOTA_TEAM_GOODGUYS, cfg.PLAYERS_PER_TEAM)
	GameRules:SetCustomGameTeamMaxPlayers(DOTA_TEAM_BADGUYS, cfg.PLAYERS_PER_TEAM)
	if cfg.OBSERVER_MODE == "team" then
		GameRules:SetCustomGameTeamMaxPlayers(DOTA_TEAM_CUSTOM_1, cfg.OBSERVER_SLOTS)
	end

	-- Экран подготовки держим, пока хост не запустит драфт (или не пропустит его).
	GameRules:EnableCustomGameSetupAutoLaunch(false)
	GameRules:SetCustomGameSetupAutoLaunchDelay(0)
	GameRules:SetCustomGameSetupTimeout(-1)

	-- Стадии
	GameRules:SetHeroSelectionTime(cfg.HERO_SELECTION_TIME)
	GameRules:SetHeroSelectPenaltyTime(0)
	GameRules:SetStrategyTime(cfg.STRATEGY_TIME)
	GameRules:SetShowcaseTime(0)
	GameRules:SetPreGameTime(cfg.PRE_GAME_TIME)
	GameRules:SetStartingGold(cfg.STARTING_GOLD)
	GameRules:SetSameHeroSelectionEnabled(false)

	-- Правила как в обычной Dota
	mode:SetPauseEnabled(cfg.PAUSE_ENABLED)
	mode:SetFreeCourierModeEnabled(true)
	mode:SetUseDefaultDOTARuneSpawnLogic(true)
	mode:SetAllowNeutralItemDrops(true)
	mode:SetTowerBackdoorProtectionEnabled(true)
	mode:SetSelectionGoldPenaltyEnabled(false)

	-- Урон по строениям для худа (tower_damage)
	mode:SetDamageFilter(Dynamic_Wrap(ArenaGameMode, "DamageFilter"), self)

	ListenToGameEvent("game_rules_state_change", Dynamic_Wrap(ArenaGameMode, "OnStateChange"), self)
	ListenToGameEvent("entity_killed", Dynamic_Wrap(ArenaGameMode, "OnEntityKilled"), self)
	ListenToGameEvent("npc_spawned", Dynamic_Wrap(ArenaGameMode, "OnNpcSpawned"), self)

	ArenaDraft:Init()
	ArenaObserver:Init()
	ArenaHud:Init()
end

function ArenaGameMode:OnStateChange()
	local state = GameRules:State_Get()
	ArenaUtil.Log("стадия: " .. ArenaUtil.StateName(state))

	if state == DOTA_GAMERULES_STATE_HERO_SELECTION then
		ArenaDraft:OnHeroSelection()
		ArenaObserver:OnHeroSelection()
	elseif state == DOTA_GAMERULES_STATE_PRE_GAME then
		ArenaHud:OnPreGame()
	elseif state == DOTA_GAMERULES_STATE_POST_GAME then
		ArenaHud:OnPostGame()
	end
end

function ArenaGameMode:OnEntityKilled(event)
	local killed = event.entindex_killed and EntIndexToHScript(event.entindex_killed)
	if not killed then return end
	ArenaHud:OnEntityKilled(killed)
end

function ArenaGameMode:OnNpcSpawned(event)
	local npc = event.entindex and EntIndexToHScript(event.entindex)
	if not npc or not npc.IsRealHero or not npc:IsRealHero() then return end
	ArenaObserver:OnHeroSpawned(npc)
end

function ArenaGameMode:DamageFilter(event)
	ArenaHud:OnDamage(event)
	return true
end
