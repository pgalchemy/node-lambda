'use strict';

var path = require('path');
var aws = require('aws-sdk');
var exec = require('child_process').exec;
var fs = require('fs-extra');
var os = require('os');
var packageJson = require(path.join(__dirname, '..', 'package.json'));
var minimatch = require('minimatch');
var async = require('async');
var zip = new require('node-zip')();
var dotenv = require('dotenv');
var ScheduleEvents = require(path.join(__dirname, 'schedule_events'));

var maxBufferSize = 50 * 1024 * 1024;

var Lambda = function () {
  this.version = packageJson.version;

  return this;
};

Lambda.prototype._createSampleFile = function (file, boilerplateName) {
  var exampleFile = path.join(process.cwd(), file);
  var boilerplateFile = path.join(
    __dirname,
    (boilerplateName || file) + '.example'
  );

  if (!fs.existsSync(exampleFile)) {
    fs.writeFileSync(exampleFile, fs.readFileSync(boilerplateFile));
    console.log(exampleFile + ' file successfully created');
  }
};

Lambda.prototype.setup = function (program) {
  console.log('Running setup.');
  this._createSampleFile('.env', '.env');
  this._createSampleFile(program.eventFile, 'event.json');
  this._createSampleFile('deploy.env', 'deploy.env');
  this._createSampleFile(program.contextFile, 'context.json');
  this._createSampleFile('event_sources.json', 'event_sources.json');
  console.log('Setup done. Edit the .env, deploy.env, ' + program.contextFile + ' and ' + program.eventFile +
    ' files as needed.');
};

Lambda.prototype.run = function (program) {
  this._createSampleFile(program.eventFile, 'event.json');
  var splitHandler = program.handler.split('.');
  var filename = splitHandler[0] + '.js';
  var handlername = splitHandler[1];

  // Set custom environment variables if program.configFile is defined
  if (program.configFile) {
    this._setRunTimeEnvironmentVars(program);
  }

  var handler = require(path.join(process.cwd(), filename))[handlername];
  var event = require(path.join(process.cwd(), program.eventFile));
  var context = require(path.join(process.cwd(), program.contextFile));

  this._runHandler(handler, event, program, context);
};

Lambda.prototype._runHandler = function (handler, event, program, context) {
  var startTime = new Date();
  var timeout = Math.min(program.timeout, 300) * 1000; // convert the timeout into milliseconds

  var callback = function (err, result) {
    if (err) {
      console.log('Error: ' + err);
      process.exit(-1);
    }
    console.log('Success:');
    if (result) {
      console.log(JSON.stringify(result));
    }
    process.exit(0);
  };

  context.getRemainingTimeInMillis = function () {
    var currentTime = new Date();
    return timeout - (currentTime - startTime);
  };

  if (['nodejs4.3', 'nodejs6.10'].indexOf(program.runtime) == -1) {
    console.error("Runtime [" + program.runtime + "] is not supported.");
    process.exit(-2);
  }
  handler(event, context, callback);
};

Lambda.prototype._params = function (program, buffer) {
  var params = {
    FunctionName: program.functionName + (program.environment ? '-' + program.environment : ''),
    Code: {
      ZipFile: buffer
    },
    Handler: program.handler,
    Role: program.role,
    Runtime: program.runtime,
    Description: program.description,
    MemorySize: program.memorySize,
    Timeout: program.timeout,
    Publish: program.publish,
    VpcConfig: {
      SubnetIds: [],
      SecurityGroupIds: []
    },
    Environment: {
      Variables: null
    },
    DeadLetterConfig: {
      TargetArn: null
    },
    TracingConfig: {
      Mode: null
    }
  };
  if (program.lambdaVersion) {
    params.FunctionName += ('-' + program.lambdaVersion);
  }
  if (program.vpcSubnets && program.vpcSecurityGroups) {
    params.VpcConfig = {
      'SubnetIds': program.vpcSubnets.split(','),
      'SecurityGroupIds': program.vpcSecurityGroups.split(',')
    };
  }
  if (program.configFile) {
    var configValues = fs.readFileSync(program.configFile);
    var config = dotenv.parse(configValues);
    // If `configFile` is an empty file, `config` value will be `{}`
    params.Environment = {
      Variables: config
    }
  }
  if (program.deadLetterConfigTargetArn !== undefined) {
    params.DeadLetterConfig = {
      TargetArn: program.deadLetterConfigTargetArn
    };
  }
  if (program.tracingConfig) {
    params.TracingConfig.Mode = program.tracingConfig;
  }

  return params;
};

Lambda.prototype._eventSourceList = function (program) {
  if (!program.eventSourceFile) {
    return {
      EventSourceMappings: [],
      ScheduleEvents: []
    };
  }
  const list = (function() {
    try {
      return fs.readJsonSync(program.eventSourceFile);
    } catch(err) {
      throw err;
    }
  })();

  if (Object.prototype.toString.call(list) === '[object Array]') {
    // backward-compatible
    return {
      EventSourceMappings: list,
      ScheduleEvents: []
    };
  }
  if (!list.EventSourceMappings) {
    list.EventSourceMappings = [];
  }
  if (!list.ScheduleEvents) {
    list.ScheduleEvents = [];
  }
  return list;
};

/**
 * @deprecated
 */
Lambda.prototype._zipfileTmpPath = function (program) {
  var ms_since_epoch = +new Date();
  var filename = program.functionName + '-' + ms_since_epoch + '.zip';
  var zipfile = path.join(os.tmpDir(), filename);

  return zipfile;
};

Lambda.prototype._fileCopy = function (program, src, dest, excludeNodeModules, callback) {
  const srcAbsolutePath = path.resolve(src);
  const excludes = (function () {
    return [
      '.git*',
      '*.swp',
      '.editorconfig',
      '.lambda',
      'deploy.env',
      '*.log',
      '/build/'
    ]
    .concat(program.excludeGlobs ? program.excludeGlobs.split(' ') : [])
    .concat(excludeNodeModules ? ['/node_modules'] : []);
  })();

  const pattern = '{' + excludes.map(function (str) {
    if (str.charAt(0) == '/')
      return path.join(srcAbsolutePath, str);
    return str;
  }).join(',') + '}'

  fs.mkdirs(dest, function (err) {
    if (err) {
      return callback(err);
    }
    const options = {
      dereference: true, // same meaning as `-L` of `rsync` command
      filter: function (src, dest) {
        if (!program.prebuiltDirectory && path.basename(src) == 'package.json') {
          // include package.json unless prebuiltDirectory is set
          return true;
        }
        return !minimatch(src, pattern, { matchBase: true });
      }
    };
    fs.copy(src, dest, options, function (err) {
      if (err) {
        return callback(err);
      }

      return callback(null, true);
    });
  });
};

Lambda.prototype._rsync = function (program, src, dest, excludeNodeModules, callback) {
  var excludes = ['.git*', '*.swp', '.editorconfig', '.lambda', 'deploy.env', '*.log', '/build/'],
      excludeGlobs = [];
  if (program.excludeGlobs) {
    excludeGlobs = program.excludeGlobs.split(' ');
  }
  var excludeArgs = excludeGlobs
    .concat(excludes)
    .concat(excludeNodeModules ? ['/node_modules'] : [])
    .map(function (exclude) {
      return '--exclude=' + exclude;
    }).join(' ');

  fs.mkdirs(dest, function (err) {
    if (err) {
      return callback(err);
    }

    // include package.json unless prebuiltDirectory is set
    var includeArgs = program.prebuiltDirectory ? '' : '--include package.json ';

    // we need the extra / after src to make sure we are copying the content
    // of the directory, not the directory itself.
    exec('rsync -rL ' + includeArgs + excludeArgs + ' ' + src.trim() + '/ ' + dest, {
      maxBuffer: maxBufferSize,
      env: process.env
    }, function (err) {
      if (err) {
        return callback(err);
      }

      return callback(null, true);
    });
  });
};

Lambda.prototype._npmInstall = function (program, codeDirectory, callback) {
  var command = program.dockerImage ?
    'docker run --rm -v ' + codeDirectory + ':/var/task ' + program.dockerImage + ' npm -s install --production' :
    'npm -s install --production --prefix ' + codeDirectory;
  exec(command, {
    maxBuffer: maxBufferSize,
    env: process.env
  }, function (err) {
    if (err) {
      return callback(err);
    }

    return callback(null, true);
  });
};

Lambda.prototype._postInstallScript = function (program, codeDirectory, callback) {
  var scriptFilename = 'post_install.sh';
  var cmd = path.join(codeDirectory, scriptFilename) + ' ' + program.environment;

  var filePath = path.join(codeDirectory, scriptFilename);

  fs.exists(filePath, function (exists) {
    if (exists) {
      console.log('=> Running post install script ' + scriptFilename);
      exec(cmd, { env: process.env, cwd: codeDirectory, maxBuffer: maxBufferSize },
        function (error, stdout, stderr) {

        if (error) {
          callback(error + " stdout: " + stdout + " stderr: " + stderr);
        } else {
          console.log("\t\t" + stdout);
          callback(null);
        }
      });
    } else {
      callback(null);
    }
  });
};

Lambda.prototype._zip = function (program, codeDirectory, callback) {
  var options = {
    type: 'nodebuffer',
    compression: 'DEFLATE'
  };

  console.log('=> Zipping repo. This might take up to 30 seconds');
  fs.walk(codeDirectory)
    .on('data', function (file) {
      if (!file.stats.isDirectory()) {
        var content = fs.readFileSync(file.path);
        var filePath = file.path.replace(codeDirectory + '/', '');
        zip.file(filePath, content);
      }
    })
    .on('end', function () {
      var data = zip.generate(options);
      return callback(null, data);
    });
};

Lambda.prototype._nativeZip = function (program, codeDirectory, callback) {
  var zipfile = this._zipfileTmpPath(program),
    cmd = 'zip -r ' + zipfile + ' .';

  exec(cmd, {
    env: process.env,
    cwd: codeDirectory,
    maxBuffer: maxBufferSize
  }, function (err) {
    if (err !== null) {
      return callback(err, null);
    }

    var data = fs.readFileSync(zipfile);
    callback(null, data);
  });
};

Lambda.prototype._codeDirectory = function (program) {
  var epoch_time = +new Date();

  return path.resolve('.', '.lambda');
};

Lambda.prototype._cleanDirectory = function (program, codeDirectory, callback) {
  if (program.skipInstall) return callback();
  fs.remove(codeDirectory, function (err) {
    if (err) {
      throw err;
    }

    fs.mkdirs(codeDirectory, function (err) {
      if (err) {
        throw err;
      }

      return callback(null, true);
    });
  });
};

Lambda.prototype._setRunTimeEnvironmentVars = function (program) {
  var configValues = fs.readFileSync(program.configFile);
  var config = dotenv.parse(configValues);

  for (var k in config) {
    if (!config.hasOwnProperty(k)) {
      continue;
    }

    process.env[k] = config[k];
  }
};

Lambda.prototype._uploadExisting = function (lambda, params, cb) {
  return lambda.updateFunctionCode({
    'FunctionName': params.FunctionName,
    'ZipFile': params.Code.ZipFile,
    'Publish': params.Publish
  }, function (err, data) {
    if(err) {
      return cb(err, data);
    }

    return lambda.updateFunctionConfiguration({
      'FunctionName': params.FunctionName,
      'Description': params.Description,
      'Handler': params.Handler,
      'MemorySize': params.MemorySize,
      'Role': params.Role,
      'Timeout': params.Timeout,
      'Runtime': params.Runtime,
      'VpcConfig': params.VpcConfig,
      'Environment': params.Environment,
      'DeadLetterConfig': params.DeadLetterConfig,
      'TracingConfig': params.TracingConfig,
    }, function (err, data) {
      return cb(err, data);
    });
  });
};

Lambda.prototype._uploadNew = function (lambda, params, cb) {
  return lambda.createFunction(params, function (err, data) {
    return cb(err, data);
  });
};

Lambda.prototype._readArchive = function (program, archive_callback) {
  if (!fs.existsSync(program.deployZipfile)) {
    var err = new Error('No such Zipfile [' + program.deployZipfile + ']');
    return archive_callback(err);
  }
  fs.readFile(program.deployZipfile, archive_callback);
};

Lambda.prototype._archive = function (program, archive_callback) {
  if (program.deployZipfile && fs.existsSync(program.deployZipfile)) {
    return this._readArchive(program, archive_callback);
  }
  return program.prebuiltDirectory ?
    this._archivePrebuilt(program, archive_callback) :
    this._buildAndArchive(program, archive_callback);
};

Lambda.prototype._archivePrebuilt = function (program, archive_callback) {
  var codeDirectory = this._codeDirectory(program);
  var _this = this;
  this._rsync(program, program.prebuiltDirectory, codeDirectory, false, function (err) {
    if (err) {
      return archive_callback(err);
    }

    console.log('=> Zipping deployment package');
    var archive = process.platform !== 'win32' ? _this._nativeZip : _this._zip;
    archive = archive.bind(_this);

    archive(program, codeDirectory, archive_callback);
  });
};

Lambda.prototype._buildAndArchive = function (program, archive_callback) {
  this._createSampleFile('.env', '.env');

  // Warn if not building on 64-bit linux
  var arch = process.platform + '.' + process.arch;

  var _this = this;
  var codeDirectory = _this._codeDirectory(program);

  _this._cleanDirectory(program, codeDirectory, function (err) {
    if (err) {
      return archive_callback(err);
    }
    console.log('=> Moving files to temporary directory');
    // Move files to tmp folder
    _this._rsync(program, '.', codeDirectory, true, function (err) {
      if (err) {
        return archive_callback(err);
      }

      if (program.skipInstall) return _this._afterInstall(program, codeDirectory, archive_callback);

      if (arch !== 'linux.x64' && !program.dockerImage) {
        console.warn('Warning!!! You are building on a platform that is not 64-bit Linux (%s). ' +
          'If any of your Node dependencies include C-extensions, they may not work as expected in the ' +
          'Lambda environment.\n\n', arch);
      }

      console.log('=> Running npm install --production');
      _this._npmInstall(program, codeDirectory, function (err) {
        if (err) {
          return archive_callback(err);
        }

        _this._afterInstall(program, codeDirectory, archive_callback);
      });
    });
  });
};

Lambda.prototype._afterInstall = function (program, codeDirectory, archive_callback) {
  var _this = this;
  _this._postInstallScript(program, codeDirectory, function (err) {
    if (err) {
      return archive_callback(err);
    }
    console.log('=> Zipping deployment package');

    var archive = process.platform !== 'win32' ? _this._nativeZip : _this._zip;
    archive = archive.bind(_this);

    archive(program, codeDirectory, archive_callback);
  });
};

Lambda.prototype._listEventSourceMappings = function (lambda, params, cb) {
  return lambda.listEventSourceMappings(params, function (err, data) {
    var eventSourceMappings = [];
    if (!err && data && data.EventSourceMappings) {
      eventSourceMappings = data.EventSourceMappings;
    }
    return cb(err, eventSourceMappings);
  });
};

Lambda.prototype._updateEventSources = function (lambda, functionName, existingEventSourceList, eventSourceList, cb) {
  var updateEventSourceList = [];
  // Checking new and update event sources
  for (var i in eventSourceList) {
    var isExisting = false;
    for (var j in existingEventSourceList) {
      if (eventSourceList[i]['EventSourceArn'] === existingEventSourceList[j]['EventSourceArn']) {
        isExisting = true;
        updateEventSourceList.push({
          'type': 'update',
          'FunctionName': functionName,
          'Enabled': eventSourceList[i]['Enabled'],
          'BatchSize': eventSourceList[i]['BatchSize'],
          'UUID': existingEventSourceList[j]['UUID']
        });
        break;
      }
    }

    // If it is new source
    if (!isExisting) {
      updateEventSourceList.push({
        'type': 'create',
        'FunctionName': functionName,
        'EventSourceArn': eventSourceList[i]['EventSourceArn'],
        'Enabled': eventSourceList[i]['Enabled'] ? eventSourceList[i]['Enabled'] : false,
        'BatchSize': eventSourceList[i]['BatchSize'] ? eventSourceList[i]['BatchSize'] : 100,
        'StartingPosition': eventSourceList[i]['StartingPosition'] ? eventSourceList[i]['StartingPosition'] : 'LATEST',
      });
    }
  }

  // Checking delete event sources
  for (var i in existingEventSourceList) {
    var isExisting = false;
    for (var j in eventSourceList) {
      if (eventSourceList[j]['EventSourceArn'] === existingEventSourceList[i]['EventSourceArn']) {
        isExisting = true;
        break;
      }
    }

    // If delete the source
    if (!isExisting) {
      updateEventSourceList.push({
        'type': 'delete',
        'UUID': existingEventSourceList[i]['UUID']
      });
    }
  }

  return async.map(updateEventSourceList, function (updateEventSource, _cb) {
    switch(updateEventSource['type']) {
      case 'create':
        delete updateEventSource['type'];
        lambda.createEventSourceMapping(updateEventSource, function (err, data) {
          return _cb(err, data);
        });
        break;
      case 'update':
        delete updateEventSource['type'];
        lambda.updateEventSourceMapping(updateEventSource, function (err, data) {
          return _cb(err, data);
        });
        break;
      case 'delete':
        delete updateEventSource['type'];
        lambda.deleteEventSourceMapping(updateEventSource, function (err, data) {
          return _cb(err, data);
        });
        break;
    }
  }, function(err, results) {
    return cb(err, results);
  });
};

Lambda.prototype._updateScheduleEvents = function (scheduleEvents, functionArn, scheduleList, cb) {
  return async.series(scheduleList.map(function(schedule) {
    return function(_cb) {
      const params = Object.assign(schedule, { FunctionArn: functionArn });
      scheduleEvents.add(params).then(function (data) {
        _cb(null, params);
      }).catch(function (err) {
        _cb(err);
      });
    };
  }), function(err, results) {
    cb(err, results);
  });
};

Lambda.prototype.package = function (program) {
  var _this = this;
  if (!program.packageDirectory) {
    throw 'packageDirectory not specified!';
  }
  try {
    var isDir = fs.lstatSync(program.packageDirectory).isDirectory();

    if (!isDir) {
      throw program.packageDirectory + ' is not a directory!';
    }
  } catch(err) {
    if (err.code === 'ENOENT') {
      console.log('=> Creating package directory');
      fs.mkdirsSync(program.packageDirectory);
    } else {
      throw err;
    }
  }

  _this._archive(program, function (err, buffer) {
    if (err) {
      throw err;
    }

    var basename = program.functionName + (program.environment ? '-' + program.environment : '');
    var zipfile = path.join(program.packageDirectory, basename + '.zip');
    console.log('=> Writing packaged zip');
    fs.writeFile(zipfile, buffer, function (err) {
      if (err) {
        throw err;
      }
      console.log('Packaged zip created: ' + zipfile);
    });
  });
};

Lambda.prototype.deploy = function (program) {
  var _this = this;
  var regions = program.region.split(',');
  _this._archive(program, function (err, buffer) {
    if (err) {
      throw err;
    }

    console.log('=> Reading zip file to memory');
    var params = _this._params(program, buffer);

    console.log('=> Reading event source file to memory');
    var eventSourceList = _this._eventSourceList(program);

    async.map(regions, function (region, cb) {
      console.log('=> Uploading zip file to AWS Lambda ' + region + ' with parameters:');
      console.log(params);

      var aws_security = {
        region: region
      };

      if (program.profile) {
        aws.config.credentials = new aws.SharedIniFileCredentials({
          profile: program.profile
        });
      } else {
        aws_security.accessKeyId = program.accessKey;
        aws_security.secretAccessKey = program.secretKey;
      }

      if (program.sessionToken) {
        aws_security.sessionToken = program.sessionToken;
      }

      aws.config.update(aws_security);

      var lambda = new aws.Lambda({
        apiVersion: '2015-03-31'
      });
      var scheduleEvents = new ScheduleEvents(aws);

      // Checking function
      return lambda.getFunction({
        'FunctionName': params.FunctionName
      }, function (err) {
        if (err) {
          // Function does not exist
          return _this._uploadNew(lambda, params, function(err, results) {
            if (err) {
              throw err;
            }
            console.log('=> Zip file(s) done uploading. Results follow: ');
            console.log(results);

            async.parallel([
              function(_callback) {
                // Updating event source(s)
                _this._updateEventSources(lambda, params.FunctionName, [], eventSourceList.EventSourceMappings, function(err, results) {
                  _callback(null, results);
                });
              },
              function(_callback) {
                _this._updateScheduleEvents(scheduleEvents, results.FunctionArn, eventSourceList.ScheduleEvents, function(err, results) {
                  _callback(err, results);
                });
              }
            ], function(err, results) {
              cb(err, results);
            });
          });
        }

        // Function exists
        _this._listEventSourceMappings(lambda, {
          'FunctionName': params.FunctionName
        }, function(err, existingEventSourceList) {
          if (err) {
            throw err;
          }
          return async.parallel([
            function(_callback) {
              _this._uploadExisting(lambda, params, function(err, results) {
                if (err) {
                  throw err;
                }
                console.log('=> Zip file(s) done uploading. Results follow: ');
                console.log(results);
                _this._updateScheduleEvents(scheduleEvents, results.FunctionArn, eventSourceList.ScheduleEvents, function(err, results) {
                  _callback(err, results);
                });
              });
            },
            function(_callback) {
              _this._updateEventSources(lambda, params.FunctionName, existingEventSourceList, eventSourceList.EventSourceMappings, function(err, results) {
                _callback(err, results);
              });
            }
          ], function(err, results) {
            cb(err, results);
          });
        });
      });
    }, function (err, results) {
      if (err) {
        throw err;
      }
      const resultsIsEmpty = results.filter(function(result) {
        return result.filter(function(res) {
          return res.length > 0;
        }).length > 0;
      }).length == 0;
      if (!resultsIsEmpty) {
        console.log('=> All tasks done. Results follow: ');
        console.log(JSON.stringify(results, null, ' '));
      }
    });
  });
};


module.exports = new Lambda();
