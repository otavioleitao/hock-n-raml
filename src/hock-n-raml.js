require('array.prototype.find');

var hock = require('hock');
var http = require('http');
var fs = require('fs');
var raml = require('raml-parser');
var Q = require('q');
var proxy = require('express-http-proxy');
var express = require('express');

function RAMLServer(config) {
    var self = this;
    this.contracts = [];
    this.config = {};

    this.start = function() {
        this.loadConfig(config)
            .then(this.loadContracts)
            .then(this.startServer);
    };

    this.loadConfig = function(path) {
        var config = Q.defer();

        fs.readFile(path, 'utf8', function (err, data) {
            if (data) {
                self.config = JSON.parse(data);
                config.resolve(self.config);
            }
            else {
                config.reject(err);
            }
        });

        return config.promise;
    };

    this.loadContracts = function() {
        var loaded = [];

        self.config.contracts.forEach(function(file) {
            var contractLoaded = Q.defer();
            loaded.push(contractLoaded.promise);
            raml.loadFile(file).then(function(contractData) {
                var contract = new Contract(contractData);
                self.contracts.push(contract);
                contractLoaded.resolve(contract);
                console.log('Contract ' + file + ' loaded successfully.');
            }, function(error) {
                console.log('Error parsing:', error.message);
            });
        });

        return Q.all(loaded);
    };

    this.startServer = function() {
        var app = express();

        if (self.config.proxy != null) {
            app.use(proxy('localhost', {
                intercept: function (body, request, response, callback) {
                    self.validate(request, response, body);
                    callback(null, body);
                }
            }));
        }

        if (self.config.mock != null) {
            var mock = hock.createHock({throwOnUnmatched: false});
            mock.get('/bagagem/view/test.txt').any().reply(200, 'Mock!');
            app.use(function (request, response, next) {
                self.setupRequest(request, response);
                mock.handler(request, response);
            });
        }

        http.createServer(app).listen(self.config.server.port, function() {
            console.log("\n*** hock-n-raml server started on port " + self.config.server.port + " ***");
            console.log("*** press ctrl+c to shutdown ***\n");
        });
    };

    var orig = http.ServerResponse.prototype.write;
    var origEnd = http.ServerResponse.prototype.end;

    this.setupRequest = function(request, response) {

        function newWrite (chunk, encoding, callback) {
            if (chunk) {
                var data = chunk.toString('utf8');
                if (!response.body) {
                    response.body = data;
                } else {
                    response.body += data;
                }
            }
            orig.call(this, chunk, encoding, callback);
        }
        response.write = newWrite;

        function newEnd (chunk, encoding, callback) {
            if (chunk) {
                this.write(chunk, encoding);
            }
            this.validate(request, response, response.body);
            origEnd.call(this);
        }
        response.end = newEnd;
    };

    this.validate = function(request, response, body) {
        try {
            this.isRequestValid(request);
        }
        catch (err) {
            console.log('-> invalid request\n\tURL =', request.url, '\n\t' + err);
            console.log('\n*** shutting down server due to errors *** \n');
            process.exit();
        }

        var validResponse = this.isResponseValid(response, body);
        if (!validResponse) {
            console.log('invalid response. \n\tURL =', request.url);
        }
    };

    this.isRequestValid = function(request) {
        var valid = false;

        this.contracts.forEach(function(contract) {
            if (contract.isRequestValid(request)) {
                valid = true;
            }
        });

        return valid;
    };

    this.isResponseValid = function(response, body) {
        var valid = false;

        this.contracts.forEach(function(contract) {
            if (contract.isResponseValid(response, body)) {
                valid = true;
            }
        });

        return valid;
    };
}

function Contract(data) {

    this.isRequestValid = function(request) {
        var definition = this.getDefinition(request.url);
        if (definition) {
            console.log(definition);
        }
        else {
            throw "URL not defined in any RAML contract.";
        }
    };

    this.isResponseValid = function(response, body) {
        return true;
    };

    this.getDefinition = function(url) {
        var baseUri = this.getRoot();
        if (url.indexOf(baseUri) == 0) {
            var uri = url.slice(baseUri.length);
            var rootResource = this.getRootResource(uri);
            if (rootResource) {
                return rootResource.getResource(uri);
            }
        }
    };

    this.getRoot = function() {
        return getUriStrech(data.baseUri, 3);
    };

    this.getRootResource = function(uri) {
        return findResourcebyRelativeUri(data.resources, uri);
    };
}

function Resource(data) {

    this.getResource = function(uri) {
        if (uriEquals(data.relativeUri, uri)) {
            return this;
        }
        else {
            var relativeUri = getUriPart(uri, 1);
            if (relativeUri == data.relativeUri) {
                relativeUri = uri.slice(relativeUri.length);
                var currentUri = getUriPart(uri, 2);
                if (currentUri != '/') {
                    var subResource = this.getResourceByRelativeUri(currentUri);
                    if (subResource) {
                        return subResource.getResource(relativeUri);
                    }
                }
                else {
                    return this;
                }
            }
        }
    };
    this.getResourceByRelativeUri = function(uri) {
        if (data.resources) {
            return findResourcebyRelativeUri(data.resources, uri);
        }
    };
}

function uriMatch(uriContract, uriChecked) {
    return isUriPlaceholder(uriContract) || uriChecked.indexOf(uriContract) == 0;
}

function isUriPlaceholder(uriContract) {
    return (uriContract.indexOf('/{') == 0 && uriContract.lastIndexOf('}') + 1 == uriContract.length);
}

function uriEquals(uriContract, uriChecked) {
    return (isUriPlaceholder(uriContract) && uriChecked.indexOf('/', 1) < 0) || uriChecked == uriContract;
}

function findResourcebyRelativeUri(resources, uri) {
    var resource = resources.find(function(element) {
        return uriMatch(element.relativeUri, uri);
    });

    if (resource) {
        return new Resource(resource);
    }
}

function getUriPart(uri, begin) {
    return getUriStrech(uri, begin, begin + 1);
}

function getUriStrech(uri, begin, end) {
    var tokens = uri.split('/').slice(begin, end);
    return '/' + tokens.join('/');
}

var config = process.argv[2];
new RAMLServer(config).start();