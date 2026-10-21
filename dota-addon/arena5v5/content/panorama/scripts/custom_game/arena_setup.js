"use strict";
// ============================================================================
//  Экран подготовки Arena 5x5: выбор команд, капитаны, драфт Captains Mode.
//  Состояние живёт на сервере (CustomNetTable "arena_draft"), экран только
//  показывает его и отправляет действия событиями arena_*.
// ============================================================================

var TEAM_RADIANT = 2;
var TEAM_DIRE = 3;
var TEAM_NONE = 5;
var TEAM_OBSERVERS = 6;

var heroPanels = {};   // name -> panel
var heroList = [];     // [{ n, id, a }]
var state = {};
var board = {};
var lastSig = {};      // panelId -> подпись содержимого, чтобы не пересоздавать панели каждый опрос

function changed(panelId, sig) {
	if (lastSig[panelId] === sig) return false;
	lastSig[panelId] = sig;
	return true;
}

function toArr(obj) {
	if (!obj) return [];
	if (Array.isArray(obj)) return obj;
	var out = [];
	var keys = Object.keys(obj).map(Number).sort(function (a, b) { return a - b; });
	for (var i = 0; i < keys.length; i++) out.push(obj[keys[i]]);
	return out;
}

function localPid() { return Players.GetLocalPlayer(); }
function isHost() {
	var info = Game.GetLocalPlayerInfo();
	return !!(info && info.player_has_host_privileges);
}
function playerName(pid) {
	var info = Game.GetPlayerInfo(pid);
	return info ? info.player_name : ("Игрок " + pid);
}
function heroName(n) { return n ? $.Localize("#" + n) : ""; }
function fmtTime(sec) {
	sec = Math.max(0, Math.floor(sec || 0));
	var m = Math.floor(sec / 60), s = sec % 60;
	return m + ":" + (s < 10 ? "0" : "") + s;
}

// ---------------------------------------------------------------- действия

function JoinTeam(team) {
	if (state.phase && state.phase !== "teams") return;
	Game.PlayerJoinTeam(team);
}
function ClaimCaptain() { GameEvents.SendCustomGameEventToServer("arena_captain", {}); }
function ToggleFirstPick() {
	GameEvents.SendCustomGameEventToServer("arena_first_pick", { side: state.first === "dire" ? "radiant" : "dire" });
}
function AutoTeams() { GameEvents.SendCustomGameEventToServer("arena_auto_teams", {}); }
function StartDraft() { GameEvents.SendCustomGameEventToServer("arena_start_draft", {}); }
function SkipDraft() { GameEvents.SendCustomGameEventToServer("arena_skip_draft", {}); }
function SelectHero(n) { GameEvents.SendCustomGameEventToServer("arena_select", { hero: n }); }

// ---------------------------------------------------------------- команды

function fillPlayerList(panelId, ids, captain) {
	var list = $("#" + panelId);
	if (!list) return;
	var sig = ids.map(function (id) { return id + ":" + playerName(id); }).join(",") + "|" + captain;
	if (!changed(panelId, sig)) return;
	list.RemoveAndDeleteChildren();
	for (var i = 0; i < ids.length; i++) {
		var pid = ids[i];
		var row = $.CreatePanel("Panel", list, "");
		row.AddClass("PlayerRow");
		if (pid === localPid()) row.AddClass("Local");
		var avatar = $.CreatePanel("DOTAAvatarImage", row, "");
		avatar.AddClass("Avatar");
		var info = Game.GetPlayerInfo(pid);
		if (info) avatar.steamid = info.player_steamid;
		var label = $.CreatePanel("Label", row, "");
		label.text = playerName(pid) + (pid === captain ? "  ★ капитан" : "");
	}
}

function updateTeams() {
	fillPlayerList("RadiantList", Game.GetPlayerIDsOnTeam(TEAM_RADIANT), state.captain2);
	fillPlayerList("DireList", Game.GetPlayerIDsOnTeam(TEAM_DIRE), state.captain3);
	fillPlayerList("UnassignedList", Game.GetUnassignedPlayerIDs(), -1);
	fillPlayerList("ObserverList", Game.GetPlayerIDsOnTeam(TEAM_OBSERVERS), -1);

	var myTeam = Players.GetTeam(localPid());
	$("#RadiantCaptainBtn").visible = myTeam === TEAM_RADIANT;
	$("#DireCaptainBtn").visible = myTeam === TEAM_DIRE;
	$("#HostControls").visible = isHost();
	$("#WaitHostLabel").visible = !isHost();
	$("#FirstPickLabel").text = "Первый выбор: " + (state.first === "dire" ? "Dire" : "Radiant");

	var observerTeam = Game.GetTeamDetails(TEAM_OBSERVERS);
	var hasObserverTeam = !!(observerTeam && observerTeam.team_max_players > 0);
	$("#ObserverBlock").visible = hasObserverTeam;
	$("#UnassignedHint").visible = !hasObserverTeam;
}

// ---------------------------------------------------------------- драфт

function buildHeroGrid() {
	if (heroList.length > 0) return;
	heroList = toArr(CustomNetTables.GetTableValue("arena_draft", "heroes"));
	heroList.sort(function (a, b) { return heroName(a.n).localeCompare(heroName(b.n)); });
	for (var i = 0; i < heroList.length; i++) {
		var h = heroList[i];
		var parent = $("#Grid_" + h.a) || $("#Grid_all");
		var card = $.CreatePanel("Button", parent, "");
		card.AddClass("HeroCard");
		var img = $.CreatePanel("DOTAHeroImage", card, "");
		img.heroname = h.n;
		img.heroimagestyle = "portrait";
		img.AddClass("HeroImg");
		var lbl = $.CreatePanel("Label", card, "");
		lbl.AddClass("HeroName");
		lbl.text = heroName(h.n);
		(function (name) {
			card.SetPanelEvent("onactivate", function () { SelectHero(name); });
		})(h.n);
		heroPanels[h.n] = card;
	}
}

function FilterHeroes() {
	var q = ($("#SearchEntry").text || "").toLowerCase();
	for (var n in heroPanels) {
		var match = !q || heroName(n).toLowerCase().indexOf(q) !== -1 || n.indexOf(q) !== -1;
		heroPanels[n].SetHasClass("Filtered", !match);
	}
}

function fillSlots(panelId, names, count, cls) {
	var root = $("#" + panelId);
	if (!changed(panelId, names.join(","))) return;
	root.RemoveAndDeleteChildren();
	for (var i = 0; i < count; i++) {
		var slot = $.CreatePanel("Panel", root, "");
		slot.AddClass(cls);
		if (names[i]) {
			var img = $.CreatePanel("DOTAHeroImage", slot, "");
			img.heroname = names[i];
			img.heroimagestyle = cls === "PickSlot" ? "portrait" : "icon";
			img.AddClass("SlotImg");
		}
	}
}

function myTurn() {
	if (state.phase !== "draft") return false;
	var captain = state.activeteam === TEAM_RADIANT ? state.captain2 : state.captain3;
	return captain === localPid() || (captain < 0 && isHost());
}

function updateDraft() {
	buildHeroGrid();
	var t2 = board.team2 || {}, t3 = board.team3 || {};
	var used = {};
	var lists = [toArr(t2.picks), toArr(t2.bans), toArr(t3.picks), toArr(t3.bans)];
	for (var l = 0; l < lists.length; l++) for (var i = 0; i < lists[l].length; i++) used[lists[l][i]] = l % 2 === 0 ? "picked" : "banned";

	fillSlots("RadiantPicks", toArr(t2.picks), 5, "PickSlot");
	fillSlots("RadiantBans", toArr(t2.bans), 7, "BanSlot");
	fillSlots("DirePicks", toArr(t3.picks), 5, "PickSlot");
	fillSlots("DireBans", toArr(t3.bans), 7, "BanSlot");

	$("#RadiantCaptainLabel").text = state.captain2 >= 0 ? "Капитан: " + playerName(state.captain2) : "Нет капитана";
	$("#DireCaptainLabel").text = state.captain3 >= 0 ? "Капитан: " + playerName(state.captain3) : "Нет капитана";
	$("#RadiantReserve").text = "Резерв " + fmtTime(state.reserve2);
	$("#DireReserve").text = "Резерв " + fmtTime(state.reserve3);

	var mine = myTurn();
	for (var n in heroPanels) {
		var p = heroPanels[n];
		p.SetHasClass("Picked", used[n] === "picked");
		p.SetHasClass("Banned", used[n] === "banned");
		p.SetHasClass("Clickable", mine && !used[n]);
	}

	if (state.phase === "draft") {
		var side = state.activeteam === TEAM_RADIANT ? "Radiant" : "Dire";
		$("#TurnLabel").text = side + (state.pick ? " выбирает" : " банит");
		$("#TurnLabel").SetHasClass("RadiantTurn", state.activeteam === TEAM_RADIANT);
		$("#TurnLabel").SetHasClass("DireTurn", state.activeteam === TEAM_DIRE);
		$("#MainTimeLabel").text = state.main > 0 ? String(state.main) : "резерв";
		$("#StepLabel").text = "Ход " + (state.step + 1) + " из " + state.total;
		$("#YourTurnLabel").text = mine ? (state.pick ? "ВАШ ХОД: ВЫБЕРИТЕ ГЕРОЯ" : "ВАШ ХОД: ЗАБАНЬТЕ ГЕРОЯ") : "";
	} else if (state.phase === "strategy") {
		$("#TurnLabel").text = "Драфт окончен";
		$("#MainTimeLabel").text = String(state.strategy_left);
		$("#StepLabel").text = "Дальше — выбор героев из пиков своей команды";
		$("#YourTurnLabel").text = "";
	}
}

// ---------------------------------------------------------------- общее

var PHASE_TEXT = {
	teams: "Выбор команд",
	draft: "Драфт Captains Mode",
	strategy: "Драфт окончен",
	done: "Выбор героев",
	skipped: "All Pick"
};

function refresh() {
	var s = CustomNetTables.GetTableValue("arena_draft", "state");
	var b = CustomNetTables.GetTableValue("arena_draft", "board");
	if (s) state = s;
	if (b) board = b;

	var drafting = state.phase === "draft" || state.phase === "strategy";
	$("#TeamsView").visible = !drafting;
	$("#DraftView").visible = drafting;
	$("#PhaseLabel").text = PHASE_TEXT[state.phase] || "";
	$("#TimerLabel").text = "";

	if (drafting) updateDraft(); else updateTeams();
}

function poll() {
	refresh();
	$.Schedule(0.3, poll);
}

(function () {
	// Без автозапуска: экран держится, пока хост не начнёт драфт.
	Game.SetAutoLaunchEnabled(false);
	CustomNetTables.SubscribeNetTableListener("arena_draft", refresh);
	poll();
})();
