var hock = require('hock');
var http = require('http');
var fs = require('fs');
var raml = require('raml-parser');
var Q = require('q');
var httpProxy = require('http-proxy');

function loadContracts(contracts) {
    contracts.forEach(function(file) {
        raml.loadFile(file)
            .then(function(data) {
                console.log('Contract ' + file + ' loaded successfully.');
            }, function(error) {
                console.log('Error parsing: ', error.message);
            });
    });
}

function readConfigFile(path) {
    var config = Q.defer();

    fs.readFile(configPath, 'utf8', function (err, data) {
        if (data) {
            config.resolve(JSON.parse(data));
        }
        else {
            config.reject(err);
        }
    });

    return config.promise;
}

function startServer(config) {
    var mock = hock.createHock();

    if (config.proxy) {
        var proxy = httpProxy.createProxyServer({ target: config.proxy.target });
        mock.handler = function(request, response) {
            proxy.web(request, response);
        };
    }

    var server = http.createServer(mock.handler);
    server.listen(config.server.port, function() {
        console.log("\n*** hock-n-raml server started on port " + config.server.port + " ***");
        console.log("*** press ctrl+c to shutdown ***\n");
    });
}

var configPath = process.argv[2];
readConfigFile(configPath).then(function(config) {
    loadContracts(config.contracts);
    startServer(config);
}, function(error) {
    console.log("Failed to read config file. Error:", error);
});