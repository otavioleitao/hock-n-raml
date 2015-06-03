require('array.prototype.find');

var hock = require('hock');
var http = require('http');
var fs = require('fs');
var raml = require('raml-parser');
var Q = require('q');
var proxy = require('express-http-proxy');
var express = require('express');
var tv4 = require('tv4');

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
            var requestBody = [];
            app.use(proxy(self.config.proxy.target, {
                decorateRequest: function(request) {
                    if (request.bodyContent.length > 0) {
                        requestBody[request.path] = JSON.parse(request.bodyContent.toString('utf8'));
                    }

                    return request;
                },
                intercept: function (originalRequest, body, request, response, callback) {
                    try {
                        response.body = JSON.parse(body.toString('utf-8'));
                    }
                    catch(err) {

                    }

                    request.body = requestBody[request.url];

                    if (!self.validate(request, response)) {
                        body = '### ERROR: INVALID REQUEST ###';
                    }

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
            console.log('\n*** invalid request received: ' + request.url +  '  *** \n');
            if (self.config.server.exitOnError) {
                console.log('\n*** shutting down server due to errors *** \n');
                process.exit();
            }
            response.statusCode = 9999;

            return false;
        }

        return true;
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
        return findResourcebyRelativeUri(data, uri, data);
    };
}

function Resource(contract, data) {
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
            return findResourcebyRelativeUri(data, uri, contract);
        }
    };

    this.matchesRequest = function(request) {
        var requestDefinition = data.methods.filter(function(def) {
            return def.method == request.method.toLowerCase();
        })[0];

        if (requestDefinition) {
            return this.matchRequestParams(requestDefinition, request) && this.matchRequestHeaders(requestDefinition, request);
        }
        else {
            console.log("no definition for " + request.method.toLowerCase() + " HTTP method");
        }
    };

    this.matchRequestParams = function(definition, request) {
        return this.matchQueryParams(definition, request) && this.matchRequestBody(definition, request);
    };

    this.matchRequestBody = function(definition, request) {
        if (!definition.body || (definition.body['application/json'] && this.matchObject(definition.body['application/json'].schema, request.body))) {
            return true;
        }
        else {
            console.log("request body doesn't match");
        }
    };

    this.matchQueryParams = function(definition, request) {
        if (this.matchObject(this.createSchema(definition.queryParameters), request.query)) {
            return true;
        }
        else {
            console.log("request query params don't match");
        }
    };

    this.matchRequestHeaders = function(definition, request) {
        if (this.matchObject(this.createSchema(definition.headers), request.headers)) {
            return true;
        }
        else {
            console.log("request headers don't match");
        }
    };

    this.matchesResponse = function(request, response) {
        var definition = data.methods.filter(function(def) {
            return def.method == request.method.toLowerCase();
        })[0];
        var responseDefinition = definition.responses[response.statusCode];

        if (definition && (responseDefinition === null || responseDefinition)) {
            return this.matchResponseHeaders(responseDefinition, response) && this.matchResponseBody(responseDefinition, response);
        }
        else {
            console.log("no definition for " + request.method.toLowerCase() + " HTTP method with response status " + response.statusCode);
        }
    };

    this.matchResponseHeaders = function(definition, response) {
        if (!definition || this.matchObject(this.createSchema(definition.headers), response._headers)) {
            return true;
        }
        else {
            console.log("response headers don't match");
        }
    };

    this.matchResponseBody = function(definition, response) {
        if (!definition || (definition.body['application/json'] && this.matchObject(definition.body['application/json'].schema, response.body, false))) {
            return true;
        }
        else {
            console.log("response body doesn't match");
        }
    };

    this.createSchema = function(properties) {
        return {
            type: 'object',
            required: true,
            properties: properties
        };
    };

    this.matchObject = function(schema, object) {
        if (typeof schema === 'string') {
            schema = JSON.parse(schema);
        }

        if (schema) {
            var result = tv4.validateMultiple(object, schema);
            if (result.errors) {
                for (var i = 0; i < result.errors.length; i++) {
                    console.log('error #' + i);
                    console.log(result.errors[i].message);
                    console.log(result.errors[i].dataPath);
                    console.log(result.errors[i].schemaPath);
                    console.log('');
                }
            }

            return result.valid;
        }
        else {
            return true;
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
    uriChecked = uriChecked.indexOf('?') >= 0 ? uriChecked.substring(0, uriChecked.indexOf('?')) : uriChecked;
    return (isUriPlaceholder(uriContract) && uriChecked.indexOf('/', 1) < 0) || uriChecked == uriContract;
}

function findResourcebyRelativeUri(data, uri, contract) {
    var resource = data.resources.find(function(element) {
        return uriMatch(element.relativeUri, uri);
    });

    if (resource) {
        return new Resource(contract, resource);
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