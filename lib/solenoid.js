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
    async.apply(findEngine, options),
    async.apply(readEnv, options),
    async.apply(restrictFilesystem, options),
    async.apply(startApp, options)
  ], callback);
};

exports.restart = function (options, callback) {
  fs.exists(options.pidFile, function (exists) {
    if (!exists) {
      return callback(new Error(options.pidFile + ' does not exist.'));
    }

    fs.readFile(options.pidFile, 'utf8', function (err, content) {
      if (err) {
        return callback(err);
      }

      content = parseInt(content, 10);
      if (!Number.isNaN(content)) {
        try { process.kill(content, 'SIGUSR1') }
        catch (ex) { }
      }

      callback();
    });
  });
};

exports.stop = function (options, callback) {
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

var findEngine = exports.findEngine = function findEngine(options, callback) {
  // TODO: support engines other than node
  var package = options['package.json'],
      match,
      node;

  process.stdout.write('Determining node engine...');
  node = !package.engines || !package.engines.node
    ? options.engines.node.default || '0.6.x'
    : package.engines.node;

  if (!semver.validRange(node)) {
    return callback(new Error(node + ' is not a valid SemVer version'));
  }

  fs.readdir(options.engines.node.path, function (err, files) {
    if (err) {
      err.message = 'Cannot read engines directory: ' + err.message;
      return callback(err);
    }

    match = semver.maxSatisfying(files, node);
    if (!match) {
      err = new Error('No satisfying engine version found.\n' +
                      'Available versions are: ' + files.join(','));
      return callback(err);
    }

    process.stdout.write(match + '\n');
    options.enginePath = path.join(options.engines.node.path, match, 'bin', 'node');
    callback();
  });
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
  var coffeeBin = path.join(path.dirname(options.enginePath), 'coffee'),
      startLog = path.join(options.runDir, 'start.log'),
      logger = options.logger,
      responded = false,
      args = [],
      pid = '',
      env = {},
      start,
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
  args.push('--', options.enginePath);

  if (!options['package.json'].scripts || typeof options['package.json'].scripts.start !== 'string'
      || !options['package.json'].scripts.start) {
    return callback(new Error('`scripts.start` property is required'));
  }

  start = options['package.json'].scripts.start.split(' ');
  if (start[0] === 'coffee' || path.extname(start[0]) === '.coffee') {
    //
    // If the binary to start is `coffee` or the file
    // to start is a `.coffee` file then add the `coffee`
    // binary and all start arguments.
    //
    if (start[0] === 'coffee') {
      start.shift();
    }
    args.push.apply(args, [coffeeBin].concat(start));
  }
  else if (start[0] === 'node') {
    //
    // If the binary to start is `node` then add
    // just add all start arguments.
    //
    start.shift();
    args.push.apply(args, start);
  }
  else {
    //
    // Otherwise just push the start arguments.
    //
    args.push.apply(args, start);
  }

  //
  // Merge the env with `app.env` and `process.env`.
  //
  [process.env, options.app.env].forEach(function (obj) {
    if (!obj || typeof obj !== 'object') { return }
    Object.keys(obj).forEach(function (key) {
      env[key] = obj[key];
    });
  });

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

          logger.info('Tailing forza log: ' + startLog);

          setTimeout(function () {
            tail = spawn('tail', ['-f', startLog]);
            tail.stdout.on('data', function (data) {
              allLog += data;

              try { json = JSON.parse(allLog) }
              catch (ex) { return }

              logger.info(JSON.stringify(json));

              try { tail.kill() }
              catch (ex) { }

              next();
            });
          }, 2000);
        }
      ], done);
    }

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
