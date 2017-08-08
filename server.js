console.log('Loading...');

var app = require('express')();
var http = require('http').Server(app);
var bodyParser = require('body-parser');
var fs = require('fs');
var config = require('./config.json');
var session = require('express-session')({
    secret: 'hahaha',
    resave: true,
    saveUninitialized: true,
    cookie: {secure: false}
});
var sharedsession = require("express-socket.io-session");
var shortid = require('shortid');

//Setup middleware
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());
app.use(session);

//Game functions
var games = [];
function Game(owner) {
    var _this = this;

    _this.id = shortid.generate();
    _this.numQuestions = 5;
    _this.owner = owner;
    _this.state = 0;
    _this.players = {};

    _this.checkFinished = function () {
        if (_this.state != 1) return;

        var kys = Object.keys(_this.players);

        var qs = {};
        var as = {};
        var pairs = {};
        var cur = 1;

        for (var i = 0; i < kys.length; i++) {
            var plr = _this.players[kys[i]];
            if (plr.answers.length < _this.numQuestions) return;
            for (var j = 0; j < _this.numQuestions; j++) {
                var qid = cur++;
                var aid = cur++;
                qs[qid] = plr.questions[j];
                as[aid] = plr.answers[j];
                pairs[qid] = aid;
            }
        }

        var final = [];
        var qids = Object.keys(qs);
        var aids = Object.keys(as);
        while (qids.length > 0) {
            var qid = qids.splice(0, 1)[0];
            var aid;
            var valid = false;
            while (!valid) {
                valid = true;
                aid = aids[parseInt(Math.random() * aids.length)];
                if (pairs[qid] == aid) valid = false;
            }
            aids.splice(aids.indexOf(aid), 1);
            final.push({q: qs[qid], a: as[aid]});
        }
        _this.final = final;

        _this.state = 2;
        _this.massUpdate();
    };

    _this.massUpdate = function () {
        var kys = Object.keys(_this.players);
        for (var i = 0; i < kys.length; i++) {
            _this.players[kys[i]].sendGameData();
        }
    };

    _this.destroy = function () {
        var idx = games.indexOf(_this);
        games.splice(idx, 1);
        console.log('Game \"' + name + '\" destroyed');
    };

    _this.export = function () {
        return {
            id: _this.id,
            numQuestions: _this.numQuestions,
            state: _this.state,
            final: _this.final
        };
    };

    games.push(_this);
    console.log('Game \"' + name + '\" created');
}

function getGameList() {
    var gms = [];
    for (var i = 0; i < games.length; i++) {
        gms.push(games[i].export());
    }
    return gms;
}

function getGameById(id) {
    for (var i = 0; i < games.length; i++) {
        if (games[i].id == id) return games[i];
    }
}

//Lobby user
var lobbyUsers = [];
function LobbyUser(socket) {
    var _this = this;

    _this.socket = socket;

    _this.sendGameList = function () {
        _this.socket.emit('games', getGameList());
    };

    socket.on('disconnect', function () {
        var idx = lobbyUsers.indexOf(_this);
        lobbyUsers.splice(idx, 1);
    });

    lobbyUsers.push(_this);
}

//Game user
function GameUser(socket) {
    var _this = this;

    _this.socket = socket;
    _this.game = getGameById(socket.handshake.session.gameid);
    _this.questions = [];
    _this.answers = [];

    _this.sendGameData = function () {
        var data = _this.game.export();
        data.questions = _this.questions;
        data.answers = _this.answers;

        if (_this.game.owner == socket.handshake.session.myid) {
            data.owner = true;
        }

        _this.socket.emit('gamedata', data);
    };
}

//Start socket server
var io = require('socket.io')(http);
io.use(sharedsession(session, {
    autoSave: true
}));
io.on('connection', function (socket) {
    socket.on('type', function (type) {
        if (type == 'lobby') {
            var user = new LobbyUser(socket);
            user.sendGameList();

            socket.on('joingame', function (id, callback) {
                socket.handshake.session.gameid = id;
                socket.handshake.session.save();
                callback('game.html?id=' + id);
            });
        }
        else if (type == 'game') {
            var sess = socket.handshake.session;
            var game = getGameById(sess.gameid);
            var user = game.players[sess.myid];
            if (!user) {
                user = new GameUser(socket);
                game.players[sess.myid] = user;
            } else {
                user.socket = socket;
            }
            user.sendGameData();

            socket.on('startgame', function () {
                game.state = 1;
                game.massUpdate();
            });

            socket.on('text', function (txt) {
                if (user.questions.length > user.answers.length) {
                    user.answers.push(txt);
                } else {
                    user.questions.push(txt);
                }
                user.sendGameData();
                game.checkFinished();
            });
        }
    });
});

//Handle get requests
app.get('*', function (req, res) {
    var sess = req.session;

    if (!sess.myid) {
        sess.myid = shortid.generate();
    }

    var url = req.url.split('?')[0];
    if (url === '/')url += 'index.html';

    if (url == '/pregame.html') {
        if (!sess.gameid) {
            return res.redirect('/index.html');
        }

        var game = getGameById(sess.gameid);
        if (game.state != 0) {
            return res.redirect('/game.html');
        }
    }

    if (url == '/game.html') {
        if (!sess.gameid) {
            return res.redirect('/index.html');
        }

        var game = getGameById(sess.gameid);
        if (game.state == 0) {
            return res.redirect('/pregame.html');
        }
    }

    if (url == '/index.html') {
        if (sess.gameid) {
            var game = getGameById(sess.gameid);
            if (game.state == 0) {
                return res.redirect('/pregame.html');
            } else {
                return res.redirect('/game.html');
            }
        }
    }

    var path = __dirname + '/public/' + url;
    try {
        fs.accessSync(path, fs.F_OK);
    } catch (e) {
        path = __dirname + '/public/err404.html';
    }

    res.sendFile(path);
});

app.post('/newgame', function (req, res) {
    var sess = req.session;

    var name = req.body.gamename;
    var num = parseInt(req.body.numQuestions);

    if (!name || !num || isNaN(num) || num == 0) {
        return res.redirect('/index.html');
    }

    var game = new Game(name, num, sess.myid);
    sess.gameid = game.id;
    res.redirect('/game.html?id=' + game.id);

    for (var i = 0; i < lobbyUsers.length; i++) {
        lobbyUsers[i].sendGameList();
    }
});

app.post('/leavegame', function (req, res) {
    req.session.gameid = undefined;
    res.redirect('/index.html');
})

//Start http server
http.listen(config.port, function () {
    console.log('Listening on *:' + config.port);
});