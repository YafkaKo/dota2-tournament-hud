-- Минимальный JSON-кодировщик: в VScripts Dota нет встроенного.
-- Таблица с ключами 1..n кодируется как массив, остальные — как объект.
-- Пустая таблица — {} (объект): худу так удобнее.

ArenaJSON = {}

local escapes = {
	['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
	['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encodeString(s)
	s = s:gsub('[%c"\\]', function(c)
		return escapes[c] or string.format("\\u%04x", c:byte())
	end)
	return '"' .. s .. '"'
end

local function isArray(t)
	local n = 0
	for k in pairs(t) do
		if type(k) ~= "number" or k <= 0 or k % 1 ~= 0 then return false end
		n = n + 1
	end
	if n == 0 then return false end
	for i = 1, n do
		if t[i] == nil then return false end
	end
	return true
end

local encode

local function encodeNumber(v)
	if v ~= v or v == math.huge or v == -math.huge then return "0" end
	if v % 1 == 0 and v > -1e15 and v < 1e15 then
		return string.format("%d", v)
	end
	return string.format("%.4f", v)
end

encode = function(v, depth)
	depth = depth or 0
	if depth > 20 then return "null" end
	local t = type(v)
	if t == "nil" then return "null"
	elseif t == "boolean" then return v and "true" or "false"
	elseif t == "number" then return encodeNumber(v)
	elseif t == "string" then return encodeString(v)
	elseif t == "table" then
		local out = {}
		if isArray(v) then
			for i = 1, #v do out[#out + 1] = encode(v[i], depth + 1) end
			return "[" .. table.concat(out, ",") .. "]"
		end
		for k, val in pairs(v) do
			if type(val) ~= "function" and type(val) ~= "userdata" then
				out[#out + 1] = encodeString(tostring(k)) .. ":" .. encode(val, depth + 1)
			end
		end
		return "{" .. table.concat(out, ",") .. "}"
	end
	return encodeString(tostring(v))
end

function ArenaJSON.encode(v)
	return encode(v, 0)
end
