#!/usr/bin/env node

'use strict';

const _ = require('lodash');
const request = require('request-promise');
const validate = require('./validate');
const env = process.env;
const stdin = process.stdin;

stdin.setEncoding('utf8');

let inputChunks = [];
stdin.on('data', function (chunk) {
    inputChunks.push(chunk);
});

stdin.on('end', function () {
    const input = inputChunks.join('');
    if (!input) {
        log('STDIN ended with empty input. Exiting.');
        return;
    }

    let resourceConfig;
    try {
        resourceConfig = JSON.parse(input);
        validate.env(process.env);
        validate.config(resourceConfig);
    } catch(error) {
        log(`Error: ${error.message}`);
        process.exit(1);
    }

    const source = resourceConfig.source || {};
    const params = resourceConfig.params || {};

    if (params.events === undefined || params.events.length === 0) {
        params.events = ['push']
    }

    // Remove duplicates
    params.events = [...new Set(params.events)];

    processWebhook(source, params);
});

function buildUrl(source, params) {
    const instanceVars = buildInstanceVariables(params);
    if (source.concourse_url) {
        return encodeURI(`${source.concourse_url}/api/v1/teams/${env.BUILD_TEAM_NAME}/pipelines/${params.pipeline ? params.pipeline : env.BUILD_PIPELINE_NAME}/resources/${params.resource_name}/check/webhook?webhook_token=${params.webhook_token}${instanceVars}`);
    }

    return encodeURI(`${env.ATC_EXTERNAL_URL}/api/v1/teams/${env.BUILD_TEAM_NAME}/pipelines/${params.pipeline ? params.pipeline : env.BUILD_PIPELINE_NAME}/resources/${params.resource_name}/check/webhook?webhook_token=${params.webhook_token}${instanceVars}`);
}

function buildInstanceVariables(params) {
    let vars = "";
    if (env.BUILD_PIPELINE_INSTANCE_VARS) {
        try {
            const instanceVars = JSON.parse(env.BUILD_PIPELINE_INSTANCE_VARS)
            for (const [key, value] of Object.entries(instanceVars)) {
                vars += `&vars.${key}="${value}"`;
            }
        } catch(exception) {
            throw new Error(exception);
        }
    }
    if ("pipeline_instance_vars" in params && params.pipeline_instance_vars) {
        try {
            for (const [key, value] of Object.entries(params.pipeline_instance_vars)) {
                vars += `&vars.${key}="${value}"`;
            }
        } catch(exception) {
            throw new Error(exception);
        }
    }
    return vars;
}

async function processWebhook(source, params) {

    const webhookEndpoint = `${source.github_api}/repos/${params.org}/${params.repo}/hooks`;
    const url = buildUrl(source, params)

    log(`Webhook location: ${webhookEndpoint}\n` +
        `Target Concourse resource: ${url}\n`);

    const config = {
        'url': url,
        'content-type': 'json'
    };

    const body = {
        'name': 'web',  // NOTE: Github plans to deprecate this field. https://developer.github.com/v3/repos/hooks/#create-a-hook
        'config': config,
        'events': params.events
    };

    const existingHookList = await getExistingHooks(webhookEndpoint, source.github_token);
    const existingHook = existingHookList.find(hook => _.isMatch(hook.config, config));

    switch (params.operation) {
        case 'create':
            if (existingHook == null) {
                createWebhook(webhookEndpoint, 'POST', source.github_token, body);
            } else if (!_.isEqual(_.sortBy(existingHook.events), _.sortBy(body.events))) {
                updateWebhook(`${webhookEndpoint}/${existingHook.id}`, 'PATCH', source.github_token, body, existingHook)
            } else {
                log('Webhook already exists');
                emit(existingHook);
            }
            break;
        case 'delete':
            if (existingHook == null) {
                log('Webhook does not exist');
                emit({id: Date.now()});
            } else {
                deleteWebhook(webhookEndpoint, existingHook, source.github_token);
            }
            break;
    }
}

function getExistingHooks(webhookEndpoint, githubToken) {
    return callGithub(webhookEndpoint, 'GET', githubToken)
        .then(res => JSON.parse(res.body));
}

function createWebhook(webhookEndpoint, method, githubToken, body) {
    const bodyString = JSON.stringify(body);

    callGithub(webhookEndpoint, method, githubToken, bodyString)
        .then(res => {
            log(`Successfully created webhook: ${res.body}`);
            emit(JSON.parse(res.body));
        })
        .catch(error => {
            log(error.stack);
            process.exit(1);
        });
}

function updateWebhook(webhookEndpoint, method, githubToken, body, existingHook) {
    const bodyString = JSON.stringify(body);

    callGithub(webhookEndpoint, method, githubToken, bodyString)
        .then(res => {
            log(`Successfully updated webhook configuration from:\n${JSON.stringify(existingHook)}\n\nto:\n${res.body}`);
            emit(JSON.parse(res.body));
        })
        .catch(error => {
            log(error.stack);
            process.exit(1);
        });
}

function deleteWebhook(webhookEndpoint, webhook, githubToken) {
    const deleteUri = `${webhookEndpoint}/${webhook.id}`;

    callGithub(deleteUri, 'DELETE', githubToken)
        .then(() => {
            log('Webhook deleted successfully');
            emit(webhook);
        });
}

function callGithub(uri, method, githubToken, body) {
    const options = {
        uri: uri,
        method: method,
        body: body,
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'Authorization': `token ${githubToken}`,
            'User-Agent': 'node.js'
        },
        resolveWithFullResponse: true
    };

    return request(options)
        .catch(err => {
            log(`Error while calling Github: ${err.name}\n` +
                `Response Status: ${err.statusCode}\n` +
                `Message: ${JSON.stringify(JSON.parse(err.error), null, 2)}`);
            if (err.statusCode === 404) {
                log(`Response was 404:\n` +
                    `    Your token's account must be an Administrator of your repo. ${uri.replace('//api.', '//')
                                                                                          .replace('/repos', '')
                                                                                          .replace('/hooks', '/settings/collaboration')}\n` +
                    `    Additionally, your token must have the 'admin:repo_hook' scope. https://github.com/settings/tokens/new?scopes=admin:repo_hook`);
            }
            process.exit(1);
        });
}

function emit(result) {
    const output = {
        version: {
            id: result.id.toString()
        }
    };

    // Output version to Concourse using stdout
    console.log(JSON.stringify(output, null, 2));

    process.exit(0);
}

function log(message) {
    // Concourse only prints stderr to user
    console.error(message);
}

module.exports = { buildInstanceVariables, buildUrl };
