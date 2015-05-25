require('array.prototype.find');

var hock = require('hock');
var http = require('http');
var fs = require('fs');
var raml = require('raml-parser');
var Q = require('q');
var proxy = require('express-http-proxy');
var express = require('express');
var validate = require('jsonschema').validate;

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
            var requestBody;
            app.use(proxy(self.config.proxy.target, {
                decorateRequest: function(request) {
                    if (request.bodyContent.length > 0) {
                        requestBody = JSON.parse(request.bodyContent.toString('utf8'));
                    }

                    return request;
                },
                intercept: function (originalRequest, body, request, response, callback) {

                    response.body = body;
                    request.body = requestBody;

                    self.validate(request, response);

                    callback(null, body);
                }
            }));
        }

        http.createServer(app).listen(self.config.server.port, function() {
            console.log("\n*** hock-n-raml server started on port " + self.config.server.port + " ***");
            console.log("*** press ctrl+c to shutdown ***\n");
        });
    };

    this.validate = function(request, response) {
        if (!this.isValid(request, response)) {
            console.log('-> invalid request\n\tURL =', request.url);
            console.log('\n*** shutting down server due to errors *** \n');
            process.exit();
        }
    };

    this.isValid = function(request, response) {
        var valid = false;
        this.contracts.forEach(function(contract) {
            if (contract.isValid(request, response)) {
                valid = true;
            }
        });
        return valid;
    };
}

function Contract(data) {

    this.isValid = function(request, response) {
        var definition = this.getDefinition(request.url);
        if (definition) {
            return definition.matchesRequest(request) && definition.matchesResponse(request, response);
        }
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
    var defaultSchema =           {
        type: 'object',
        $schema: 'http://json-schema.org/draft-03/schema',
        id: 'http://jsonschema.net',
        required: true
    };

    this.getResource = function(uri) {
        if (uriEquals(data.relativeUri, uri)) {
            return this;
        }
        else {
            var relativeUri = getUriPart(uri, 1);
            if (uriEquals(data.relativeUri, relativeUri)) {
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

    this.matchesRequest = function(request) {
        return this.matchRequestParams(request) && this.matchRequestHeaders(request);
    };

    this.matchRequestParams = function(request) {
        if (request.method.toLowerCase() === 'get') {
            return this.matchQueryParams(request);
        }
        else {
            return this.matchRequestBody(request);
        }
    };

    this.matchRequestBody = function(request) {
        var definition = data.methods.filter(function(def) {
            return def.method == request.method.toLowerCase();
        })[0];

        if (definition) {
            var schema = JSON.parse(definition.body['application/json'].schema);
            return validate(request.body, schema).errors.length === 0;
        }
    };

    this.matchQueryParams = function(request) {
        var definition = data.methods.filter(function(def) {
            return def.method == request.method.toLowerCase();
        })[0];

        var schema = clone(defaultSchema);
        schema.properties = definition.queryParameters;

        return !definition.queryParameters || validate(request.query, schema).errors.length === 0;
    };

    this.matchRequestHeaders = function(request) {
        var definition = data.methods.filter(function(def) {
            return def.method == request.method.toLowerCase();
        })[0];

        var schema = clone(defaultSchema);
        schema.properties = definition.headers;

        return validate(request.headers, schema).errors.length === 0;
    };

    this.matchesResponse = function(request, response) {
        var definition = data.methods.filter(function(def) {
            return def.method == request.method.toLowerCase();
        })[0];

        return definition.responses[response.statusCode];
    };
}

function uriMatch(uriContract, uriChecked) {
    return isUriPlaceholder(uriContract) || uriChecked.indexOf(uriContract) == 0;
}

function isUriPlaceholder(uriContract) {
    return (uriContract.indexOf('/{') == 0 && uriContract.lastIndexOf('}') + 1 == uriContract.length);
}

function uriEquals(uriContract, uriChecked) {
    return (isUriPlaceholder(uriContract) && uriChecked.indexOf('/', 1) < 0) || uriChecked.substring(0, uriChecked.indexOf('?')) == uriContract;
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

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

var config = process.argv[2];
new RAMLServer(config).start();