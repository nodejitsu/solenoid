var fs = require('fs'),
    os = require('os'),
    path = require('path'),
    spawn = require('child_process').spawn,
    rimraf = require('rimraf'),
    mkdirp = require('mkdirp'),
    async = require('async'),
    pkgcloud = require('pkgcloud'),
    semver = require('semver'),
    useradd = require('useradd'),
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

  mkdirp(options.runDir, function (err) {
    if (err) {
      return callback(err);
    }

    async.parallel([
      async.apply(fetch, options),
      async.apply(createUser, options)
    ], function (err) {
      if (err) {
        return callback(err);
      }

      async.series([
        async.apply(unpack, options),
        async.apply(readPackageJSON, options),
        async.apply(findEngine, options),
        async.apply(readEnv, options),
        async.apply(restrictFilesystem, options),
        async.apply(startApp, options)
      ], callback);
    });
  });
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
    if (!Number.isNaN(content)) {
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
    }
  });
};

var fetch = exports.fetch = function fetch(options, callback) {
  var client = pkgcloud.storage.createClient(options.storage),
      packedSnapshotPath = path.join(options.runDir, 'snapshot.tgz'),
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
      console.error('Error while fetching snapshot: ' + err.message);
      return tries === maxTries
        ? callback(err)
        : doFetch(callback);
    });

    stream.on('end', function () {
      console.log('Application snapshot fetched.');
      callback();
    });
  }

  console.log('Fetching application snapshot...');
  doFetch(callback);
};

//
// Create a dedicated user account.
//
var createUser = exports.createUser = function createUser(options, callback) {
  console.log('Creating user...');

  useradd({
    login: 'solenoid',
    shell: false,
    home: false,
    //
    // Man page documentation for `useradd` says that
    // `-g` can take a string argument.
    //
    gid: 'nogroup'
  }, function (err) {
    return (err && err.code !== 9)
      ? callback(err)
      : callback();
  });
};

var unpack = exports.unpack = function unpack(options, callback) {
  var snapshotPath = path.join(options.runDir, 'snapshot'),
      child;

  console.log('Unpacking snapshot...');

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
  console.log('Reading `package.json`...');

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
  if (!package.engines || !package.engines.node) {
    return callback(new Error('node.js version is required'));
  }

  node = package.engines.node;
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
  options.app.env.NODE_ENV = 'production';
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
      ['-R', 'solenoid:nogroup', options.packagePath],
      'Unable to grab ownership for ' + options.packagePath
    ),
    async.apply(
      runFs,
      'chmod',
      ['-R', '777', options.packagePath],
      'Unable to change permissions for ' + options.packagePath
    )
  ], callback);
};

var startApp = exports.startApp = function startApp(options, callback) {
  var args = [],
      pid = '',
      env = {},
      child;

  console.log('Starting application...');

  //
  // Setup the `aeternum` arguments.
  //
  args = ['start', '-o', path.join(options.runDir, 'forza.log'), '--', 'forza'];
  options.instruments.forEach(function (instrument) {
    args.push('-h', instrument.host + ':' + (instrument.port || 8556).toString());
  });

  args.push('--app-user', options.app.user);
  args.push('--app-name', options.app.name);
  args.push('--', options.enginePath, options['package.json'].scripts.start.split(' ')[1]);

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

    child = spawn('aeternum', args, {
      cwd: path.join(options.snapshotPath, 'package'),
      env: env,
      uid: uid,
      gid: gid
    });

    child.stdout.on('readable', function () {
      var chunk = child.stdout.read();
      if (chunk) {
        pid += chunk.toString('utf8');
      }
    });

    child.stdout.on('end', function () {
      pid = parseInt(pid, 10).toString();
      console.log('`aeternum` pid: ' + pid);
      fs.writeFile(options.pidFile, pid, callback);
    });

    child.on('error', callback);
  });
};
