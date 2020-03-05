const fs = require('fs');
const yaml = require('js-yaml');
var moduleAlias = require('module-alias');

function loadTemplate(templateName, parameterOverrides) {
    let input = fs.readFileSync(process.cwd() + '/' + templateName, 'utf8')
    let stack;
    try {
        input = input.replace(new RegExp("\"Fn\:\:(.*?)\"", "g"), " \"_____$1\"");
        input = input.replace(new RegExp("\"(Ref)\"\:", "g"), " \"_____$1\":");
        stack = JSON.parse(input)
    }
    catch (err) {
        input = processToYaml(input)
        //input = input.replace(new RegExp("Fn\:\:(.*?)\:(.*?)", "g"), " _____$1:");
        //input = input.replace(new RegExp("\!(.*?) (.*?)", "g"), " _____$1: ");
        stack = yaml.load(input)
    }
    for (i in stack.Resources) {
        var resource = stack.Resources[i]
        if (resource.Type == 'AWS::Serverless::Api') {
            if (resource.Properties.DefinitionBody) {
                var paths = resource.Properties.DefinitionBody.Paths
                if (!paths && resource.Properties.DefinitionBody._____Transform &&
                    resource.Properties.DefinitionBody._____Transform.Parameters &&
                    resource.Properties.DefinitionBody._____Transform.Parameters.Location) {
                    swaggerString = fs.readFileSync(process.cwd() + '/' + resource.Properties.DefinitionBody._____Transform.Parameters.Location, 'utf8')
                    try {
                        paths = JSON.parse(swaggerString)
                    }
                    catch (err) {
                        paths = yaml.load(swaggerString)
                    }
                }
                if (paths) {
                    for (_p in paths) {
                        var pathObject = paths[_p]
                        for (path in pathObject) {
                            var methodObject = pathObject[path]
                            for (method in methodObject) {
                                var proxy = methodObject[method]
                                if (proxy['x-amazon-apigateway-integration']) {
                                    if (proxy['x-amazon-apigateway-integration'].type == 'aws_proxy') {
                                        var lambdaName = proxy['x-amazon-apigateway-integration'].uri
                                        lambdaName = JSON.stringify(lambdaName)
                                        lambdaName = lambdaName.substring(lambdaName.indexOf('functions/${') + 12)
                                        lambdaName = lambdaName.substring(0, lambdaName.indexOf('.Arn'))
                                        if (stack.Resources[lambdaName]) {
                                            var lambda = stack.Resources[lambdaName]
                                            if (!lambda.Properties.Events) {
                                                lambda.Properties.Events = {}
                                            }
                                            var event = {}
                                            lambda.Properties.Events[path.replace(new RegExp('\/', 'g'), '_') + method] = event
                                            event.Type = 'Api'
                                            event.Properties = {}
                                            event.Properties.Path = path
                                            event.Properties.Method = method
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    stack.getLambda = getLambda;
    stack.getHandlerforLambda = getHandlerforLambda;
    stack.getLayersforLambda = getLayersforLambda;
    stack.getEnvironmentVariablesforLambda = getEnvironmentVariablesforLambda;
    stack.resolveParameter = resolveParameter;
    stack.prepareLambdaForExecution = prepareLambdaForExecution;
    stack.executeLambda = executeLambda;
    stack.parameterOverrides = parameterOverrides;
    return stack
}

function getLambda(event) {
    for (var i in this.Resources) {
        let resource = this.Resources[i]
        if (resource.Type == 'AWS::Serverless::Function' && resource.Properties.CodeUri) {
            for (var j in resource.Properties.Events) {
                let resourceEvent = resource.Properties.Events[j]
                if (resourceEvent.Type == 'Api'
                    && (resourceEvent.Properties.Method == event.httpMethod
                        || resourceEvent.Properties.Method == 'any')
                ) {
                    let incomingPath = event.path.split('/')
                    let lambdaPath = resourceEvent.Properties.Path.split('/')
                    let pathMatch = true
                    if (incomingPath.length == lambdaPath.length) {
                        for (var _index in incomingPath) {
                            if (incomingPath[_index] != lambdaPath[_index] &&
                                (lambdaPath[_index].indexOf('{') != 0 ||
                                    lambdaPath[_index].lastIndexOf('}') != lambdaPath[_index].length - 1)) {
                                pathMatch = false
                                break
                            }
                        }
                    } else {
                        pathMatch = false
                    }
                    if (pathMatch) {
                        return resource
                    }
                }
            }
        }
    }
}
function prepareLambdaForExecution(lambda) {

    let layers = this.getLayersforLambda(lambda);
    if (layers) {
        for (var l in layers) {
            let layer = layers[l]
            let contentUri = layer.Properties.ContentUri
            if (contentUri.charAt(0) == '/') {
                contentUri = contentUri.substring(1)
            }
            if (contentUri.lastIndexOf('/') == contentUri.length) {
                contentUri = contentUri.substring(0, contentUri.length - 1)
            }
            moduleAlias.addPath(process.cwd() + '/' + contentUri + '/nodejs')
            moduleAlias.addPath(process.cwd() + '/' + contentUri + '/nodejs/node_modules')
        }
    }
    let variables = this.getEnvironmentVariablesforLambda(lambda)
    if (variables) {
        for (var v in variables) {
            let variable = variables[v]
            for (var w in variable) {
                process.env[w] = variable[w]
            }
        }
    }
    /*
    Most AWS functions can or may as well be called from the real aws-sdk - a call to DynamoDB or S3, for example,
    but in the context of CrockStack there are some that won't work - such as invoking another lambda or leveraging
    websockets. So the following replaces the AWS sdk with a mocked version, which delegates everything to the real
    AWS SDK except that which we can execute within CrockStack.
    */
    moduleAlias.addPath(`${__dirname}/crock_node_modules`);
    moduleAlias.addAlias("real-aws-sdk", "aws-sdk");
    moduleAlias.addAlias("aws-sdk", "crock-aws-sdk");
    //Our fake AWS SDK is going to need to call back into the stack, for instance to send a message
    //to a websocket and the only way I can think to do that is to expose it globally.
    global.stack=this;
}
async function executeLambda(lambda, event) {

    let codeUri = lambda.Properties.CodeUri
    if (codeUri.charAt(0) == '/') {
        codeUri = codeUri.substring(1)
    }
    if (codeUri.lastIndexOf('/') == codeUri.length) {
        codeUri = codeUri.substring(0, codeUri.length - 1)
    }
    let lambdaFunction = require(process.cwd() + '/' + codeUri)
    let handler = stack.getHandlerforLambda(lambda)
    var context = {}
    let result;
    if (lambdaFunction[handler].constructor.name === 'AsyncFunction') {
        result = await lambdaFunction[handler](event, context)
    } else {
        let syncReply = await new Promise((resolve, reject) => {
            context.done = (error, reply) => {
                resolve({ error, reply });
            }
            context.succeed = (reply) => {
                resolve({ reply });
            }
            context.fail = (error) => {
                if (!error) {
                    error = {}
                }
                resolve({ error });
            }
            lambdaFunction[handler](event, context, function (err, reply) {
                context.done(err, reply);
            })
        })
        if (syncReply.reply && (syncReply.reply.body || syncReply.reply.statusCode)) {
            result = syncReply.reply;
            if (!result.statusCode) {
                result.statusCode = 200;
            }
        } else if (syncReply.error) {
            let _body = typeof (syncReply.error) == 'object' ? JSON.stringify(syncReply.error) : syncReply.error;
            result = { body: _body };
            result.statusCode = 400;
        } else {
            let _body = typeof (syncReply.reply) == 'object' ? JSON.stringify(syncReply.reply) : syncReply.reply;
            result = { body: _body };
            result.statusCode = 200;
        }
    }
    return result;
} 
function getHandlerforLambda(lambda) {
    let handler = lambda.Properties.Handler
    if (!handler && this.Globals && this.Globals.Function) {
        handler = this.Globals.Function.Handler
    }
    if (handler && handler.indexOf('.') > -1) {
        handler = handler.substring(handler.indexOf('.') + 1)
    }
    return handler;
}
function getLayersforLambda(lambda) {
    let layerArray = []
    if (lambda.Properties.Layers) {
        for (var l in lambda.Properties.Layers) {
            let layerName = lambda.Properties.Layers[l]
            layerArray.push(this.resolveParameter(layerName))
        }
    }
    if (this.Globals && this.Globals.Function && this.Globals.Function.Layers) {
        for (var l in this.Globals.Function.Layers) {
            let layerName = this.Globals.Function.Layers[l]
            layerArray.push(this.resolveParameter(layerName))
        }
    }
    return layerArray
}
function getEnvironmentVariablesforLambda(lambda) {
    let lambdaVariables;
    let globalVariables;
    if (this.Globals && this.Globals.Function && this.Globals.Function.Environment.Variables) {
        globalVariables = this.Globals.Function.Environment.Variables
    }
    if (lambda.Properties.Environment && lambda.Properties.Environment.Variables) {
        lambdaVariables = lambda.Properties.Environment.Variables
    }
    var variablesObjects = []
    if (lambdaVariables) {
        for (var v in lambdaVariables) {
            let variablesName = lambdaVariables[v]
            let variable = {}
            variable[v] = this.resolveParameter(variablesName)
            variablesObjects.push(variable)
        }
    }
    if (globalVariables) {
        for (var v in globalVariables) {
            let variablesName = globalVariables[v]
            let variable = {}
            variable[v] = this.resolveParameter(variablesName)
            variablesObjects.push(variable)
        }
    }
    return variablesObjects
}

function processToYaml(input) {
    input = input.replace(new RegExp("Fn\:\:(.*?)\:(.*?)", "g"), "_____$1:");
    input = input.replace(new RegExp("\!(.*?) (.*?)", "g"), "_____$1: ");
    var inputLines = input.split('\n')
    var inputString = ''
    for (var i in inputLines) {
        var line = inputLines[i]
        var match = line.match(new RegExp(" *?.*?\: _____(.*?)"))
        if (match) {
            let totalSpaces = line.length - line.trimLeft().length
            let spaces = ''
            for (var i = 0; i < totalSpaces + 2; i++) {
                spaces += ' '
            }
            line = line.replace(':', ':\n' + spaces)
        }
        inputString += line + '\n'
    }
    return inputString
}
function resolveParameter(reference) {
    if (typeof (reference) == 'object') {
        if (reference._____Ref) {
            if (this.parameterOverrides[reference._____Ref]) {
                return this.parameterOverrides[reference._____Ref]
            }
            if (this.Parameters && this.Parameters[reference._____Ref]) {
                return this.Parameters[reference._____Ref].Default
            }
            if (reference._____Ref.indexOf('.Arn')>-1){
                return reference._____Ref.replace('.Arn', '')
            }
            return this.Resources[reference._____Ref]
        } else if (reference._____Join) {
            if (typeof (reference._____Join) == 'object') {
                let newArray = []
                for (var i in reference._____Join[1]) {
                    let entry = reference._____Join[1][i]
                    if (typeof (entry) == 'object') {
                        let resolved = this.resolveParameter(entry)
                        newArray.push(resolved)
                    } else {
                        newArray.push(entry)
                    }
                }
                return newArray.join(reference._____Join[0])
            }
        } else if (reference._____FindInMap) {
            if (typeof (reference._____FindInMap) == 'object') {
                let newArray = []
                for (var i in reference._____FindInMap) {
                    let entry = reference._____FindInMap[i]
                    if (typeof (entry) == 'object') {
                        let resolved = this.resolveParameter(entry)
                        newArray.push(resolved)
                    } else {
                        newArray.push(entry)
                    }
                }
                return this.Mappings[newArray[0]][newArray[1]][newArray[2]]
            }
        } else if (reference._____Sub) {
            var subValue = reference._____Sub
            var matches = subValue.match(new RegExp("(\\${.*?})", 'g'));
            for (var i in matches) {
                var match = matches[i]
                let variableNameToResolve = match.replace(new RegExp("\\${(.*?)}"), '$1')
                variableNameToResolve = this.resolveParameter({ _____Ref: variableNameToResolve })
                subValue = subValue.replace(match, variableNameToResolve)
            }
            return subValue
        }
    }
    return reference
}

module.exports = { loadTemplate }