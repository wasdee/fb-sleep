var request = require('request-promise');
var _ = require('lodash');
var database = require('./database');
var db = database.get();
var RECENTLY_ACTIVE_DURATION = 1000 * 60 * 10; // 10 minutes

var service = {};
service.scrape = function(config) {
    getAndSaveUsers(config, RECENTLY_ACTIVE_DURATION);
};

service.getUsers = function() {
    var db = database.get();
    return db('users').cloneDeep();
};

function getAndSaveUsers(config, timeSinceLastCheck) {
    getRecentlyActiveUsers(config, timeSinceLastCheck)
        .then(function(users) {
            console.log(new Date().toLocaleString(), ' - ', users.length, 'active users');
            return saveUsers(users);
        })
        .then(function() {
            var delay = _.random(RECENTLY_ACTIVE_DURATION * 0.9, RECENTLY_ACTIVE_DURATION);
            setTimeout(getAndSaveUsers.bind(null, config, delay), delay);
        })
        .done();
}

function saveUsers(users) {
    db('updates').push(Date.now());

    users.forEach(function(user) {
        if (!db.object.users[user.userId]) {
            db.object.users[user.userId] = [];
        }
        db.object.users[user.userId].push(user.timestamp);
    });
    db.write();
}

function getCookieJar(config, domain) {
    var jar = request.jar();
    jar.setCookie(
        request.cookie('c_user=' + config.c_user),
        domain
    );

    jar.setCookie(
        request.cookie('xs=' + config.xs),
        domain
    );

    return jar;
}

var getFbDtsg = _.memoize(function(config) {
    var jar = getCookieJar(config, 'https://www.facebook.com');
    return request({
            url: 'https://www.facebook.com/?_rdr',
            jar: jar,
            gzip: true,
            headers: {
                'User-Agent': 'curl/7.43.0'
            }
        })
        .then(function(body) {
            var matches = body.match(/name="fb_dtsg" value="([-_A-Za-z0-9]+)"/);
            if (!matches) {
                throw new Error('fb_dtsg could not be found. Make sure config is correct');
            }
            return matches[1];
        });
});

function getLastActiveTimes(config) {
    return getFbDtsg(config)
        .then(function(fbDtsg) {
            var jar = getCookieJar(config, 'https://www.messenger.com');
            return request({
                url: 'https://www.messenger.com/ajax/chat/buddy_list.php',
                jar: jar,
                gzip: true,
                method: 'POST',
                form: {
                    user: config.c_user,
                    fetch_mobile: true,
                    get_now_available_list: true,
                    __a: 1,
                    fb_dtsg: fbDtsg,
                },
            });
        })
        .then(function(body) {
            var parsedResponse = JSON.parse(body.replace('for (;;);', ''));
            var lastActiveTimes = parsedResponse.payload.buddy_list.last_active_times;
            return lastActiveTimes;
        });
}

function getRecentlyActiveUsers(config, timeSinceLastCheck) {
    return getLastActiveTimes(config)
        .then(function(lastActiveTimes) {
            return _(lastActiveTimes)
                .pairs()
                .filter(function(user) {
                    var lastActive = user[1];
                    var timeSinceActive = Date.now() - lastActive * 1000;
                    return timeSinceActive <= timeSinceLastCheck;
                })
                .map(function(user) {
                    return {
                        userId: user[0],
                        timestamp: user[1]
                    };
                })
                .value();
        });
}

service.refactorPosts = function() {
    var usersPromise = db('posts').cloneDeep();
    usersPromise.then(function(posts) {
        var users = posts.reduce(function(memo, post) {
            var timestamp = post.time;
            post.users.forEach(function(user) {
                if (!memo[user]) {
                    memo[user] = [];
                }
                memo[user].push(timestamp);
            });

            return memo;
        }, {});

        var usersDb = _.reduce(users, function(memo, timestamps, userId) {
            memo[userId] = timestamps;
            return memo;
        }, {});

        db.object.users = usersDb;

        db.object.updates = _.map(posts, 'time');
        delete db.object.posts;
        db.write();
        console.log('DB refactored!');
    });
};

module.exports = service;
