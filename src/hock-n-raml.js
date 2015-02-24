var other = require('hock');
var http = require('http');
var fs = require('fs');
var raml = require('raml-parser');
var Q = require('q');

function loadContracts(contracts) {
    contracts.forEach(function(file) {
        raml.loadFile(file)
            .then(function(data) {
                console.log(data);
            }, function(error) {
                console.log('Error parsing: ', error.message);
            });
    });
};

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
};

var configPath = process.argv[2];
readConfigFile(configPath).then(function(config) {
    loadContracts(config.contracts);
}, function(err) {
    console.log("Failed to read config file. Error:", err);
});