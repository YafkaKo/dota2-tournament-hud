-- Скрытый герой наблюдателя: не участвует в игре, его не видно и не выбрать.
modifier_arena_observer = class({})

function modifier_arena_observer:IsHidden() return true end
function modifier_arena_observer:IsPurgable() return false end
function modifier_arena_observer:RemoveOnDeath() return false end
function modifier_arena_observer:IsPermanent() return true end

function modifier_arena_observer:CheckState()
	return {
		[MODIFIER_STATE_INVULNERABLE] = true,
		[MODIFIER_STATE_OUT_OF_GAME] = true,
		[MODIFIER_STATE_NO_HEALTH_BAR] = true,
		[MODIFIER_STATE_UNSELECTABLE] = true,
		[MODIFIER_STATE_UNTARGETABLE] = true,
		[MODIFIER_STATE_NOT_ON_MINIMAP] = true,
		[MODIFIER_STATE_NO_UNIT_COLLISION] = true,
		[MODIFIER_STATE_INVISIBLE] = true,
		[MODIFIER_STATE_COMMAND_RESTRICTED] = true,
	}
end
