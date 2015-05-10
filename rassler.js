process.chdir(__dirname);

var http = require('http');
var https = require('https');
var url = require('url');
var fs = require('fs');
var path = require('path');
var rss = require('rss');
var moment = require('moment');

var server, youtube, config,  // Objects
    loadConfig, log; // Functions

loadConfig = function() {
    config = JSON.parse(fs.readFileSync('rassler.conf'));
}
loadConfig();

process.on('SIGHUP', loadConfig);

youtube = (function() {
    var cache = {};
    fs.readFile("./channelInfoCache.json", function(error, data) {
        if (!error) {
            cache = JSON.parse(data);
        }
    });

    return {
        channelInfo: function(username, callback) {
            if (cache[username]) {
                callback(cache[username]);
                return;
            }

            https.get("https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&forUsername=" + username + "&key=" + config["api_key"], function(response) {
                var responseData = "";
                response.on('data', function(chunk) { responseData += chunk });
                response.on('end', function() {
                    var userData = JSON.parse(responseData);
                    if (userData.error || userData.items.length != 1) {
                        log(userData.error, 9);
                        log(userData.items, 9);
                        log("Failed to retrieve channel info for " + username, 1);
                        callback(null);
                        return;
                    }
                    
                    var item = userData.items[0];
                    cache[username] = {
                        id: item.contentDetails.relatedPlaylists.uploads,
                        metadata: {
                            title: item.snippet.title,
                            description: item.snippet.description,
                            timestamp: item.snippet.publishedAt,
                            thumbnailURL: item.snippet.thumbnails.high.url
                        }
                    };
                    fs.writeFile("./channelInfoCache.json", JSON.stringify(cache, null, 4));

                    callback(cache[username]);
                });
            }).on('error', function(error) {
                log("Failed to retrieve channel info for " + username, 1);
            });
        },

        latestUploads: function(playlistID, count, callback) {
            https.get("https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=" + count + "&playlistId=" + playlistID + "&key=" + config["api_key"], function(response) {
                var responseData = "";
                response.on('data', function(chunk) { responseData += chunk });
                response.on('end', function() {
                    var playlistData = JSON.parse(responseData);
                    if (playlistData.error) {
                        log(playlistData.error, 9);
                        log("Failed to retrieve latest uploads for " + playlistID, 1);
                        callback(null);
                        return;
                    }

                    callback(playlistData.items.map(function(item) { return item.contentDetails.videoId; }));
                });
            }).on('error', function(error) {
                log("Failed to retrieve playlist " + playlistID, 1);
            });
        },

        videoInfo: function(videos, callback) {
            https.get("https://www.googleapis.com/youtube/v3/videos?part=snippet&id=" + videos.join(",") + "&key=" + config["api_key"], function(response) {
                var responseData = "";
                response.on('data', function(chunk) { responseData += chunk });
                response.on('end', function() {
                    var videoData = JSON.parse(responseData);
                    if (videoData.error) {
                        log(videoData.error, 9);
                        log("Failed to retrieve video info for " + videos, 1);
                        callback(null);
                        return;
                    }

                    callback(videoData.items.map(function(item) { 
                        return {
                            id: item.id,
                            title: item.snippet.localized.title,
                            timestamp: item.snippet.publishedAt,
                            description: item.snippet.localized.description,
                            thumbnailURL: item.snippet.thumbnails.maxres.url,
                        };
                    }));
                });
            }).on('error', function(error) {
                log("Failed to retrieve video info for " + videos, 1);
            });
        }
    };
})();

server = http.createServer(function(request, response) {
    log(request.url, 9);
    var requestPath = path.parse(url.parse(request.url).pathname);

    if (request.method === 'GET') {
        var viewPath = requestPath.dir.split(path.sep);
        var view = viewPath[viewPath.length - 1];
        var name = requestPath.base;

        log(view + " ➔ " + name, 9);
        if (view === "feed") {
            youtube.channelInfo(name, function(info) {
                if (!info) {
                    log("Failed to generate RSS feed for " + name, 0);
                    response.writeHead(404);
                    response.end();
                    return;
                }

                var feed = new rss({
                    title: info.metadata.title,
                    description: info.metadata.description,
                    generator: "rassler.js",
                    feed_url: request.url,
                    site_url: "https://www.youtube.com/user/" + name + "/videos",
                    image_url: info.metadata.thumbnailURL,
                    pubDate: info.metadata.timestamp,
                    ttl: config["feed_ttl"]
                });

                youtube.latestUploads(info.id, config["item_count"], function(videos) {
                    if (!videos) {
                        log("Failed to generate RSS feed for " + name, 0);
                        response.writeHead(404);
                        response.end();
                        return;
                    }

                    youtube.videoInfo(videos, function(videoInfo) {
                        if (!videoInfo) {
                            log("Failed to generate RSS feed for " + name, 0);
                            response.writeHead(404);
                            response.end();
                            return;
                        }

                        videoInfo.forEach(function(item) {
                            var itemURL = "https://www.youtube.com/watch?v=" + item.id;
                            feed.item({
                                title: item.title,
                                description: "<a href='" + itemURL + "'><img src='" + item.thumbnailURL + "' /></a><br />" + item.description,
                                date: moment(item.timestamp).format(),
                                url: itemURL
                            });
                        });

                        response.writeHead(200);
                        response.write(feed.xml(), function() { response.end(); });
                        log("Generated RSS feed for " + name, 0);
                    });
                });
            });
        }
        else {
            response.writeHead(404);
            response.end();
        }
    }
});

server.listen(config["port"], config["host"], null, function() {
    try {
        log("Dropping root privileges...", 0);
        process.setgid(config["group"]);
        process.setuid(config["user"]);
        log("Success! Server running on " + config["host"] + ":" + config["port"] + " with uid " + process.getuid() + ".", 0);
    }
    catch (err) {
        log("Failed. Cowardly refusing to run as root.", 0);
        process.exit(1);
    }
});

log = function(message, level) {
    var debug = (process.env.DEBUG === undefined) ? 0 : process.env.DEBUG;
    if (level > debug) return;

    console.log(message);
}

