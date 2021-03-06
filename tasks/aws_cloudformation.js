/*
 * grunt-aws-setup
 * https://github.com/TeamPraxis/grunt-aws-setup
 *
 * Copyright (c) 2014 Keith Hamasaki
 * Licensed under the MIT license.
 */

/*jshint node: true */
'use strict';

var AWS = require('aws-sdk'),
    async = require('async'),
    _ = require('lodash');

_.str = require('underscore.string');
_.mixin(_.str.exports());

module.exports = function(grunt) {

  grunt.registerMultiTask('aws_cloudformation', 'Execute a CloudFormation stack.', function() {
    // Merge task-specific and/or target-specific options with these defaults.
    var options = this.options({
      region: 'us-west-1',
      configVariable: this.nameArgs
    });

    // check for required options
    if (!options.stackName) {
      grunt.log.error('stackName must be defined.');
      return;
    }

    if (!options.definitionFile) {
      grunt.log.error('definitionFile must be defined.');
      return;
    }

    if (!grunt.file.isFile(options.definitionFile)) {
      grunt.log.error('Could not find definitionFile.');
      return;
    }

    var done = this.async();

    // load all events, taking into account the next token returned
    // by the server; caches previously loaded events so we can
    // always start from the last retrieved token
    var nextEventToken, allEvents = [];
    var loadAllEvents = function(callback) {
      async.doUntil(function (callback) {
        var opts = { StackName: options.stackName };
        if (nextEventToken) {
          opts.NextToken = nextEventToken;
        }
        cf.describeStackEvents(opts, function (err, data) {
          allEvents = _.union(allEvents, data.StackEvents);
          nextEventToken = data.NextToken;
          callback();
        });
      }, function () {
        return !nextEventToken;
      }, function () {
        callback(null, allEvents);
      });
    };

    var cf;
    var noUpdateFlag = false;
    var previousEvents;

    async.waterfall([
      // Check if this should be run on another account
      function (callback) {
        if (!options.assumeRole) {
          cf = new AWS.CloudFormation({ region: options.region });
          grunt.verbose.writeln('No assumeRole provided');
          callback();
          return;
        }
        grunt.log.writeln('Assuming role: ' + options.assumeRole);
        var sts = new AWS.STS();
        sts.assumeRole({
          RoleArn: options.assumeRole,
          RoleSessionName:'GruntSession'
        }, function (err, data) {
          if (err) {
            callback(err);
            return;
          }
          cf = new AWS.CloudFormation({
            region: options.region,
            accessKeyId: data.Credentials.AccessKeyId,
            secretAccessKey: data.Credentials.SecretAccessKey,
            sessionToken: data.Credentials.SessionToken
          });
          callback();
        });
      },

      // check to see if the stack exists and create or update it
      function (callback) {
        cf.describeStacks(callback);
      },
      function (data, callback) {
        var stack = _.findWhere(data.Stacks, { StackName: options.stackName });
        var params = {
          StackName: options.stackName,
          TemplateBody: grunt.file.read(options.definitionFile)
        };
        if (options.capabilities) {
          params.Capabilities = options.capabilities;
        }
        if (options.params) {
          params.Parameters = _.chain(options.params)
            .pairs()
            .map(function (val) {
              return {
                ParameterKey: val[0],
                ParameterValue: val[1]
              };
            })
            .value();
        }
        if (options.replace) {
          _.each(_.pairs(options.replace), function (item) {
            params.TemplateBody = params.TemplateBody.replace(item[0], item[1]);
          });
        }
        if (stack) {
          // load the list of previous stack events so we can start from the next one
          loadAllEvents(function (err, data) {
            previousEvents = data || [];

            grunt.log.writeln('Updating CloudFormation stack: ' + options.stackName);
            cf.updateStack(params, function (err, data) {
              // ignore errors about no updates
              if (err && err.message === 'No updates are to be performed.') {
                grunt.log.writeln('No updates required, retrieving current outputs.');
                callback(null, 'NO_UPDATES');
                return;
              }
              callback(err, data);
            });
          });
        } else {
          grunt.log.writeln('Creating CloudFormation stack: ' + options.stackName);
          cf.createStack(params, callback);
        }
      },
      // wait until it is complete
      function (data, callback) {
        noUpdateFlag = (data === 'NO_UPDATES');
        var status, reason, outputs;
        var events = [];
        grunt.log.writeln('Starting...');
        async.doUntil(function (callback) {
          loadAllEvents(function (err, data) {
            if (err) {
              grunt.log.writeln('Error:', err);
            }
            // Ignore errors
            if (data) {
              var newEvents = _.difference(_.pluck(data, 'EventId'), _.pluck(previousEvents, 'EventId'));
              _.forEach(newEvents, function (item) {
                var newEvent = _.find(data, {'EventId': item});
                events.push(newEvent);
                grunt.log.writeln(newEvent.ResourceType, ' - ', newEvent.LogicalResourceId, ' - ', newEvent.ResourceStatus);
              });
              previousEvents = data;
            }
            cf.describeStacks({ StackName: options.stackName }, function (err, data) {
              if (err) {
                callback(err);
                return;
              }
              status = data.Stacks[0].StackStatus;
              reason = data.Stacks[0].StackStatusReason;
              outputs = data.Stacks[0].Outputs;
              
              setTimeout(callback, noUpdateFlag ? 1 : 5000);
            });
          });
        }, function () {
          return _.endsWith(status, 'COMPLETE') || _.endsWith(status, 'FAILED');
        }, function (err) {
          grunt.log.writeln();
          callback(err, status, reason, outputs);
        });
      }
    ], function (err, status, reason, outputs) {
      if (err) {
        grunt.log.error('An error occurred: ' + JSON.stringify(err, null, 2));
        done(false);
        return;
      }
      // if no updates were made, ignore the status
      if (noUpdateFlag) {
        status = 'NO_UPDATE';
      }
      switch (status) {
        case 'CREATE_FAILED':
        case 'UPDATE_ROLLBACK_FAILED':
        case 'UPDATE_ROLLBACK_COMPLETE':
        case 'ROLLBACK_COMPLETE':
          grunt.log.error('CloudFormation Failed.');
          grunt.log.error('Status: ' + status);
          if (reason) {
            grunt.log.error('Reason: ' + reason);
          }
          done(false);
          break;
        default:
          grunt.log.writeln('CloudFormation Complete.');
          grunt.log.writeln('Status: ' + status);
          if (reason) {
            grunt.log.writeln('Reason: ' + reason);
          }
          var configOutput = {};
          grunt.log.writeln(' Outputs');
          grunt.log.writeln('---------');
          _.each(outputs, function (output) {
            grunt.log.writeln(output.OutputKey + ' = ' + output.OutputValue);
            configOutput[output.OutputKey] = output.OutputValue;
          });
          grunt.config.set(options.configVariable, configOutput);
          done();
        }
    });
  });
};
