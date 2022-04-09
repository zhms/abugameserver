const server = require('abue')
let config
let user_leave_callback = null
let users = {}

function init(icfg) {
	config = icfg
}

function getControlData(userinfo) {
	let sql = 'select * from x_user_control where UserId = ?'
	server.db.exectue(sql, [userinfo.UserId], (controldata) => {
		if (controldata.length == 0) return
		controldata = controldata[0]
		if (controldata.FinishPercent >= 100) return
		if (controldata.State == 0) return
		if (controldata.ControlLevel == 0) return
		if (controldata.StartScore > controldata.DestScore && (controldata.State != 2 || controldata.ControlLevel > 0)) return
		if (controldata.StartScore < controldata.DestScore && (controldata.State != 1 || controldata.ControlLevel < 0)) return
		delete controldata.UserId
		userinfo.control = controldata
		server.setToken(userinfo.Token, userinfo)
	})
}

server.ws.addMsgCallback('login', (ctx, data) => {
	if (!data.Token) {
		ctx.send('login_result', { errcode: 0, errmsg: '参数错误' })
		return
	}
	let tokenkey = `GameLoginToken:${data.Token}`
	server.redis.get(tokenkey).then((tokendata) => {
		if (!tokendata) {
			ctx.send('login_result', { errcode: 0, errmsg: '登录失败,token验证失败' })
			return
		}
		server.redis.del(tokenkey)
		tokendata = JSON.parse(tokendata)
		if (tokendata.GameId != config.gameid) {
			ctx.send('login_result', { errcode: 0, errmsg: '登录失败,游戏Id不匹配' })
			return
		}
		let sql = 'select ScoreCny,ScoreVnd,ScoreThb,GameToken as Token,Custom from x_user where UserId = ?'
		server.db.exectue(sql, [tokendata.UserId], ctx, (result) => {
			let authdata = result[0]
			if (authdata.Token) {
				server.delToken(authdata.Token)
			}
			let CurrencyType = tokendata.CurrencyType
			let UserId = tokendata.UserId
			let SellerId = tokendata.SellerId
			tokendata = {}
			if (CurrencyType == 1) tokendata.Score = authdata.ScoreCny
			if (CurrencyType == 2) tokendata.Score = authdata.ScoreVnd
			if (CurrencyType == 3) tokendata.Score = authdata.ScoreThb
			tokendata.SellerId = SellerId
			tokendata.UserId = UserId
			tokendata.CurrencyType = CurrencyType
			tokendata.Token = server.guid()
			tokendata.Custom = authdata.Custom
			server.setToken(tokendata.Token, tokendata)
			getControlData(tokendata)
			sql = 'update x_user set GameLoginToken = null,GameToken = ? where UserId = ?'
			server.db.exectue(sql, [tokendata.Token, tokendata.UserId], ctx, () => {
				ctx.token = tokendata.Token
				ctx.UserId = tokendata.UserId
				users[tokendata.UserId] = ctx
				ctx.send('login_result', { Score: tokendata.Score })
			})
		})
	})
})
//玩家信息,score金币变化值,gamedata游戏记录,taxscore税收
function writeSocre(userinfo, serial, betscore, winscore, flowscore, gamerecord, taxscore, callback) {
	if (typeof taxscore == 'function') {
		callback = taxscore
		taxscore = 0
	}
	userinfo.Score += winscore
	server.setToken(userinfo.Token, userinfo)
	let procdata = [userinfo.UserId, userinfo.CurrencyType, winscore, config.gameid, config.roomlevel, config.serverid, serial]
	server.db.callProc('WriteScore', procdata, () => {
		callback()
	})
	let sql = 'insert into x_game_detail(Serial,Data)values(?,?)'
	server.db.exectue(sql, [serial, JSON.stringify(gamerecord)], () => {})
	sql = 'insert into x_game_record(SellerId,Serial,UserId,GameId,Custom,CurrencyType,TotalScore,BetScore,WinScore,FlowScore,TaxScore)values(?,?,?,?,?,?,?,?,?,?,?)'
	let dbdata = [userinfo.SellerId, serial, userinfo.UserId, config.gameid, userinfo.Custom, userinfo.CurrencyType, userinfo.Score, betscore, winscore, flowscore, taxscore]
	server.db.exectue(sql, dbdata, () => {})
}
function getSerial(callback) {
	server.db.callProc('GetSerial', (result) => {
		callback(result.Serial)
	})
}
function addMsgCallback(msgid, callback) {
	server.ws.addMsgCallback(msgid, (ctx, data) => {
		if (!ctx.token) {
			server.ws.close(ctx)
			return
		}
		server.getToken(ctx.token, (tokendata) => {
			if (!tokendata) {
				ctx.send(msgid, { errcode: 0, errmsg: '未登录' })
				return
			}
			callback(ctx, data, tokendata)
		})
	})
}

server.ws.addCloseCallback((ctx) => {
	if (!ctx.token) return
	if (ctx.UserId) delete users[ctx.UserId]
	if (user_leave_callback) {
		server.getToken(ctx.token, (tokendata) => {
			server.delToken(ctx.token)
			if (!tokendata) return
			user_leave_callback(tokendata)
		})
	}
})

function addUserLeaveCallback(callback) {
	user_leave_callback = callback
}

function saveUserData(userinfo, savekey, data) {
	let sql = `replace into x_saved_data(UserId,SaveKey,data)values(?,?,?)`
	server.db.exectue(sql, [userinfo.UserId, savekey, JSON.stringify(data)], () => {})
}

function getUserData(userinfo, savekey, callback) {
	let sql = 'select data from x_saved_data where UserId = ? and GameId = 0 and RoomLevel = 0 and ServerId = 0 and SaveKey = ?'
	server.db.exectue(sql, [userinfo.UserId, savekey], (data) => {
		if (data.length == 0) {
			data = null
		} else {
			data = data[0].data
		}
		if (data == null) data = '{}'
		data = JSON.parse(data)
		callback(data)
	})
}

function saveUserGameData(userinfo, savekey, data) {
	let sql = `replace into x_saved_data(UserId,Gameid,SaveKey,data)values(?,?,?,?)`
	server.db.exectue(sql, [userinfo.UserId, config.gameid, savekey, JSON.stringify(data)], () => {})
}

function getUserGameData(userinfo, savekey, callback) {
	let sql = 'select data from x_saved_data where UserId = ? and GameId = ? and RoomLevel = 0 and ServerId = 0 and SaveKey = ?'
	server.db.exectue(sql, [userinfo.UserId, config.gameid, savekey], (data) => {
		if (data.length == 0) {
			data = null
		} else {
			data = data[0].data
		}
		if (data == null) data = '{}'
		data = JSON.parse(data)
		callback(data)
	})
}

function saveUserRoomData(userinfo, savekey, data) {
	let sql = `replace into x_saved_data(UserId,Gameid,RoomLevel,SaveKey,data)values(?,?,?,?,?)`
	server.db.exectue(sql, [userinfo.UserId, config.gameid, config.roomlevel, savekey, JSON.stringify(data)], () => {})
}

function getUserRoomData(userinfo, savekey, callback) {
	let sql = 'select data from x_saved_data where UserId = ? and GameId = ? and RoomLevel = ? and ServerId = 0 and SaveKey = ?'
	server.db.exectue(sql, [userinfo.UserId, config.gameid, config.roomlevel, savekey], (data) => {
		if (data.length == 0) {
			data = null
		} else {
			data = data[0].data
		}
		if (data == null) data = '{}'
		data = JSON.parse(data)
		callback(data)
	})
}

function saveUserServerData(userinfo, savekey, data) {
	let sql = `replace into x_saved_data(UserId,Gameid,RoomLevel,ServerId,SaveKey,data)values(?,?,?,?,?,?)`
	server.db.exectue(sql, [userinfo.UserId, config.gameid, config.roomlevel, config.serverid, savekey, JSON.stringify(data)], () => {})
}

function getUserServerData(userinfo, savekey, callback) {
	let sql = 'select data from x_saved_data where UserId = ? and GameId = ? and RoomLevel = ? and ServerId = ? and SaveKey = ?'
	server.db.exectue(sql, [userinfo.UserId, config.gameid, config.roomlevel, config.serverid, savekey], (data) => {
		if (data.length == 0) {
			data = null
		} else {
			data = data[0].data
		}
		if (data == null) data = '{}'
		data = JSON.parse(data)
		callback(data)
	})
}

function saveData(savekey, data) {
	let sql = `replace into x_saved_data(SaveKey,data)values(?,?)`
	server.db.exectue(sql, [savekey, JSON.stringify(data)], () => {})
}

function getData(savekey, callback) {
	let sql = 'select data from x_saved_data where UserId = 0 and GameId = 0 and RoomLevel = 0 and ServerId = 0 and SaveKey = ?'
	server.db.exectue(sql, [savekey], (data) => {
		if (data.length == 0) {
			data = null
		} else {
			data = data[0].data
		}
		if (data == null) data = '{}'
		data = JSON.parse(data)
		callback(data)
	})
}

function saveGameData(savekey, data) {
	let sql = `replace into x_saved_data(Gameid,SaveKey,data)values(?,?,?)`
	server.db.exectue(sql, [config.gameid, savekey, JSON.stringify(data)], () => {})
}

function getGameData(savekey, callback) {
	let sql = 'select data from x_saved_data where UserId = 0 and GameId = ? and RoomLevel = 0 and ServerId = 0 and SaveKey = ?'
	server.db.exectue(sql, [config.gameid, savekey], (data) => {
		if (data.length == 0) {
			data = null
		} else {
			data = data[0].data
		}
		if (data == null) data = '{}'
		data = JSON.parse(data)
		callback(data)
	})
}

function saveRoomData(savekey, data) {
	let sql = `replace into x_saved_data(Gameid,RoomLevel,SaveKey,data)values(?,?,?,?)`
	server.db.exectue(sql, [config.gameid, config.roomlevel, savekey, JSON.stringify(data)], () => {})
}

function getRoomData(savekey, callback) {
	let sql = 'select data from x_saved_data where UserId = 0 and GameId = ? and RoomLevel = ? and ServerId = 0 and SaveKey = ?'
	server.db.exectue(sql, [config.gameid, config.roomlevel, savekey], (data) => {
		if (data.length == 0) {
			data = null
		} else {
			data = data[0].data
		}
		if (data == null) data = '{}'
		data = JSON.parse(data)
		callback(data)
	})
}

function saveServerData(savekey, data) {
	let sql = `replace into x_saved_data(UserId,Gameid,RoomLevel,ServerId,SaveKey,data)values(?,?,?,?,?,?)`
	server.db.exectue(sql, [0, config.gameid, config.roomlevel, config.serverid, savekey, JSON.stringify(data)], () => {})
}

function getServerData(savekey, callback) {
	let sql = 'select data from x_saved_data where UserId = 0 and GameId = ? and RoomLevel = ? and ServerId = ? and SaveKey = ?'
	server.db.exectue(sql, [config.gameid, config.roomlevel, config.serverid, savekey], (data) => {
		if (data.length == 0) {
			data = null
		} else {
			data = data[0].data
		}
		if (data == null) data = '{}'
		data = JSON.parse(data)
		callback(data)
	})
}

function randomIntRange(minNum, maxNum) {
	return parseInt(Math.random() * (maxNum - minNum) + minNum, 10)
}

function getXSetting(settingname, callback) {
	let sql = `select SettingValue from x_setting where SettingName = ?`
	server.db.exectue(sql, [settingname], (data) => {
		if (data.length == 0) {
			callback()
			return
		}
		callback(data[0].SettingValue)
	})
}
function getGameId() {
	return config.gameid
}

function getRoomLevel() {
	return config.roomlevel
}
function getServerId() {
	return config.serverid
}
function updateUserControl(userinfo) {
	if (!userinfo.control) return
	if (userinfo.control.DestScore > userinfo.control.StartScore) {
		userinfo.control.FinishPercent = (userinfo.Score - userinfo.control.StartScore) / (userinfo.control.DestScore - userinfo.control.StartScore)
	}
	if (userinfo.control.DestScore < userinfo.control.StartScore) {
		userinfo.control.FinishPercent = (userinfo.control.StartScore - userinfo.Score) / (userinfo.control.StartScore - userinfo.control.DestScore)
	}
	userinfo.control.FinishPercent = Math.floor(userinfo.control.FinishPercent * 10000)
	userinfo.control.FinishPercent = parseFloat(userinfo.control.FinishPercent / 10000)
	let sql = 'update x_user_control set Score = ?,FinishPercent = ?,UpdateTime = now() where UserId = ?'
	server.db.exectue(sql, [userinfo.Score, userinfo.control.FinishPercent, userinfo.UserId], () => {})
	if (userinfo.control.FinishPercent >= 1) {
		delete userinfo.control
		sql = 'update x_user_control set State = 0,UpdateTime = now() where UserId = ?'
		server.db.exectue(sql, [userinfo.UserId], () => {})
	}
}
module.exports = {
	init,
	writeSocre,
	getSerial,
	addMsgCallback,
	addUserLeaveCallback,
	getUserData,
	getUserGameData,
	getUserRoomData,
	getUserServerData,
	saveUserData,
	saveUserGameData,
	saveUserRoomData,
	saveUserServerData,
	getData,
	getGameData,
	getRoomData,
	getServerData,
	saveData,
	saveGameData,
	saveRoomData,
	saveServerData,
	randomIntRange,
	getXSetting,
	getGameId,
	getRoomLevel,
	getServerId,
	updateUserControl,
}
