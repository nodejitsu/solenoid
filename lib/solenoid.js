var fs = require('fs'),
    os = require('os'),
    path = require('path'),
    spawn = require('child_process').spawn,
    rimraf = require('rimraf'),
    mkdirp = require('mkdirp'),
    async = require('async'),
    pkgcloud = require('pkgcloud'),
    semver = require('semver'),
    uidNumber = require('uid-number'),
    killer = require('killer');


function noop() {}

//
// Starts an application.
//
exports.start = function (options, callback) {
  if (!options.app) {
    return callback(new Error('options.app is required.'));
  }

  async.series([
    async.apply(clean, options),
    async.apply(mkdirp, options.runDir),
    async.apply(fetch, options),
    async.apply(unpack, options),
    async.apply(readPackageJSON, options),
    async.apply(findEngines, options),
    async.apply(readEnv, options),
    async.apply(restrictFilesystem, options),
    async.apply(startApp, options)
  ], callback);
};

exports.restart = function (options, callback) {
  var logger = options.logger;

  fs.exists(options.pidFile, function (exists) {
    if (!exists) {
      return callback(new Error(options.pidFile + ' does not exist.'));
    }

    fs.readFile(options.pidFile, 'utf8', function (err, content) {
      if (err) {
        return callback(err);
      }

      content = parseInt(content, 10);
      logger.info('Sending SIGUSR1 - ' + content);
      if (!Number.isNaN(content)) {
        try { process.kill(content, 'SIGUSR1') }
        catch (ex) { logger.info('SIGUSR1 Error - ' + ex.message) }
      }

      callback();
    });
  });
};

exports.stop = function (options, callback) {
  var logger = options.logger;

  fs.readFile(options.pidFile, 'utf8', function (err, content) {
    if (err) {
      return callback(err);
    }

    content = parseInt(content, 10);
    if (Number.isNaN(content)) {
      //
      // If the content in the pidFile is bad, then
      // **clean the server hard**.
      //
      return clean(options, callback);
    }

    logger.info('Sending terminate signal - ' + content);
    killer({
      pid: content,
      timeout: 10000,
      interval: 100
    }, function () {
      async.parallel([
        function removeCode(next) {
          rimraf(options.runDir, next.bind(null, null));
        },
        function removePid(next) {
          fs.unlink(options.pidFile, next.bind(null, null));
        }
      ], callback);
    });
  });
};

var clean = exports.clean = function clean(options, callback) {
  var commands = [
    ['pkill', '-9', 'aeternum'],
    ['pkill', 'forza'],
    ['rm', '-rf', options.pidFile || path.join(process.env.HOME, 'app.pid')],
    ['rm', '-rf', options.runDir  || ('/' + path.join('opt', 'run'))]
  ];

  var logger = options.logger;

  logger.info('Cleaning ' + options.runDir);
  async.forEachSeries(commands, function (args, next) {
    var command = args.shift(),
        child   = spawn(command, args);

    child.stdout.on('data', function (d) { logger.info('' + d) });
    child.stderr.on('data', function (d) { logger.info('' + d) });
    child.on('exit', next.bind(null, null));
  }, callback);
};

var fetch = exports.fetch = function fetch(options, callback) {
  var client = pkgcloud.storage.createClient(options.storage),
      packedSnapshotPath = path.join(options.runDir, 'snapshot.tgz'),
      logger = options.logger,
      maxTries = 5,
      tries = 0;

  options.packedSnapshotPath = packedSnapshotPath;

  function doFetch(callback) {
    ++tries;

    var stream = client.download({
      container: options.storage.container,
      remote: [ options.app.user, options.app.name, options.app.version ].join('-') + '.tgz'
    });

    stream.pipe(fs.createWriteStream(packedSnapshotPath));
    stream.on('error', function (err) {
      logger.error('Error while fetching snapshot: ' + err.message);
      return tries === maxTries
        ? callback(err)
        : doFetch(callback);
    });

    stream.on('end', function () {
      logger.info('Application snapshot fetched.');
      callback();
    });
  }

  logger.info('Fetching application snapshot...');
  doFetch(callback);
};

var unpack = exports.unpack = function unpack(options, callback) {
  var snapshotPath = path.join(options.runDir, 'snapshot'),
      logger = options.logger,
      child;

  logger.info('Unpacking snapshot...');

  options.snapshotPath = snapshotPath;
  options.packagePath  = path.join(snapshotPath, 'package');
  options.tmpPath      = path.join(snapshotPath, '.tmp');

  mkdirp(options.tmpPath, function (err) {
    if (err) {
      return callback(err);
    }

    child = spawn('tar', ['-xf', options.packedSnapshotPath], {
      cwd: snapshotPath
    });

    child.on('exit', function (code, signal) {
      fs.unlink(options.packedSnapshotPath, noop);

      if (code !== 0) {
        return callback(
          new Error('`tar` exited with ' + (code
            ? 'code ' + code.toString()
            : 'signal ' + signal.toString()
         ))
        );
      }

      return callback();
    });
  });
};

var readPackageJSON = exports.readPackageJSON = function readPackageJSON(options, callback) {
  var logger = options.logger;

  logger.info('Reading `package.json`...');

  fs.readFile(path.join(options.packagePath, 'package.json'), function (err, data) {
    if (err) {
      return callback(new Error('Error while reading `package.json`: ' + err.message));
    }

    try {
      data = JSON.parse(data);
    }
    catch (ex) {
      return callback(new Error('Error while parsing `package.json`: ' + err.message));
    }

    options['package.json'] = data;
    callback();
  });
};

var findEngines = exports.findEnginess = function findEngines(options, callback) {
  var pkgEngines = options['package.json'].engines,
      paths = [];

  if (!pkgEngines || !Object.keys(pkgEngines).length) {
    pkgEngines = { 'node': (options.engines.node && options.engines.node.default) || '0.6.x' };
  }

  async.map(Object.keys(pkgEngines), resolveEngine, saveEngines);

  function resolveEngine(engine, callback) {
    var versionRange = pkgEngines[engine],
        enginePath = options.engines[engine].path;

    if (!Object.hasOwnProperty.call(options.engines, engine) || !enginePath) {
      return callback(new Error('Unknown engine ' + engine));
    }

    if (!semver.validRange(versionRange)) {
      return callback(new Error(versionRange + ' is not a valid SemVer version range!'));
    }

    fs.readdir(enginePath, function(err, versions) {
      if (err) {
        err.message = 'Cannot read engines directory: ' + err.message;
        return callback(err);
      }

      var version = semver.maxSatisfying(versions, versionRange);

      if (!version) {
        return callback(new Error('No satisfying ' + engine + ' version found.\n'));
      }

      callback(null, path.join(enginePath, version, 'bin'));
    });
  }

  function saveEngines(err, engines) {
    options.enginePaths = engines;
    callback(err);
  }
};

var readEnv = exports.readEnv = function readEnv(options, callback) {
  var env;

  if (options.app.env) {
    try { env = JSON.parse(options.app.env) }
    catch (ex) { }
  }

  options.app.env          = env || {};
  options.app.env.NODE_ENV = options.app.env.NODE_ENV || 'production';
  options.app.env.USER     = 'solenoid';
  options.app.env.HOME     = options.packagePath;
  options.app.env.TEMP     = options.tmpPath;
  options.app.env.TMPDIR   = options.tmpPath;
  callback();
};

var restrictFilesystem = exports.restrictFilesystem = function restrictFilesystem(options, callback) {
  //
  // Helper function to run the specified command
  // and assert a non-zero exit code.
  //
  function runFs(cmd, args, msg, next) {
    spawn(cmd, args).on('exit', function (code) {
      return code
        ? next(new Error(msg))
        : next();
    });
  }

  async.parallel([
    async.apply(
      runFs,
      'chown',
      ['-R', 'solenoid:nogroup', options.runDir],
      'Unable to grab ownership for ' + options.runDir
    ),
    async.apply(
      runFs,
      'chmod',
      ['-R', '777', options.runDir],
      'Unable to change permissions for ' + options.runDir
    )
  ], callback);
};

var startApp = exports.startApp = function startApp(options, callback) {
  var startLog = path.join(options.runDir, 'start.log'),
      maxRetries = options.retries || 3,
      logger = options.logger,
      responded = false,
      retries = 0,
      args = [],
      pid = '',
      env = {},
      child,
      tail;

  logger.info('Starting application...');

  //
  // Setup the `aeternum` arguments.
  //
  args = ['start', '--min-uptime', options.minUptime, '-o', path.join(options.runDir, 'forza.log'), '--', 'forza'];
  options.instruments.forEach(function (instrument) {
    args.push('-h', instrument.host + ':' + (instrument.port || 8556).toString());
  });

  args.push('--start-log', startLog);
  args.push('--app-user', options.app.user);
  args.push('--app-name', options.app.name);
  args.push('--');

  if (!options['package.json'].scripts || typeof options['package.json'].scripts.start !== 'string'
      || !options['package.json'].scripts.start) {
    return callback(new Error('`scripts.start` property is required'));
  }

  args.push.apply(args, options['package.json'].scripts.start.split(' '));

  //
  // Merge the env with `app.env` and `process.env`.
  //
  [process.env, options.app.env].forEach(function (obj) {
    if (!obj || typeof obj !== 'object') { return }
    Object.keys(obj).forEach(function (key) {
      env[key] = obj[key];
    });
  });

  env.PATH = [path.join(options.snapshotPath, 'package', 'node_modules', '.bin')].concat(options.enginePaths).concat(env.PATH.split(':'));

  uidNumber('solenoid', 'nogroup', function (err, uid, gid) {
    if (err) {
      //
      // Remark: should we allow for errors here?
      //
      return callback(new Error('Could not get uid/gid of child process.'));
    }

    //
    // ### function done (err)
    // Responds once to the callback
    //
    function done(err) {
      if (!responded) {
        responded = true;
        callback.apply(null, arguments);
      }
    }

    //
    // ### function awaitStart ()
    // Writes `options.pidFile` and tails the `forza`
    // start log for the start event.
    //
    function awaitStart() {
      async.series([
        function writePid(next) {
          logger.info('Writing pidfile: ' + options.pidFile);
          fs.writeFile(options.pidFile, pid, next.bind(null, null));
        },
        function tailLog(next) {
          var allLog = '',
              json;

          //
          // Helper function which attempts to respawn
          // the `tail` process in the (rare) case
          // that forza has not already written to it.
          //
          function retry(err) {
            if (++retries < maxRetries) {
              logger.info('Error tailing forza log: ' + err.message);
              logger.info('Retrying the tail.');
              return tailLog(next);
            }

            next(err);
          }

          logger.info('Tailing forza log: ' + startLog);
          tail = spawn('tail', ['-f', startLog]);
          tail.on('error', retry);

          //
          // Remark: use close event so we ensure we got all possible data out
          // of the streams
          //
          tail.on('close', function (code, signal) {
            logger.info('Tail closing..');
            //
            // Remark: tail.kill() sends sigterm so ensure we have the json and
            // we killed it appropriately
            //
            return signal !== 'SIGTERM' || typeof json === 'undefined'
              ? retry(new Error('tailing start log exited poorly with code ' + code || signal))
              : next();
          });

          tail.stdout.on('data', function (data) {
            allLog += data;

            try { json = JSON.parse(allLog) }
            catch (ex) { return }

            // Use console.log to ensure it is JSON parseable
            console.log(JSON.stringify(json));

            try { tail.kill() }
            catch (ex) { }
          });
        }
      ], done);
    }

    logger.info('Spawn: ' + args.join(' '));
    child = spawn('aeternum', args, {
      cwd: path.join(options.snapshotPath, 'package'),
      env: env,
      uid: uid,
      gid: gid
    });

    child.on('error', done);
    child.stdout.on('data', function (chunk) {
      pid += chunk.toString('utf8');
    });

    child.stdout.on('end', function () {
      pid = parseInt(pid, 10).toString();
      logger.info('`aeternum` pid: ' + pid);
      awaitStart();
    });
  });
};
