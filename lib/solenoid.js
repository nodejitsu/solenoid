var fs = require('fs'),
    os = require('os'),
    path = require('path'),
    spawn = require('child_process').spawn,
    mkdirp = require('mkdirp'),
    async = require('async'),
    pkgcloud = require('pkgcloud'),
    semver = require('semver'),
    useradd = require('useradd');

function noop() {}

//
// Starts an application.
//
exports.start = function (options, callback) {
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
      async.apply(startApp, options)
    ], callback);
  });
};

exports.stop = function (options, callback) {
  fs.readFile(options.pidFile, 'utf8', function (err, content) {
    if (err) {
      return callback(err);
    }

    try {
      process.kill(parseInt(content, 10));
    }
    catch (ex) {
      return callback(ex);
    }
  });
};

var fetch = exports.fetch = function fetch(options, callback) {
  var client = pkgcloud.storage.createClient(options.storage),
      tries = 0,
      maxTries = 5,
      packedSnapshotPath = path.join(os.tmpDir(), 'snapshot.tgz');

  options.packedSnapshotPath = packedSnapshotPath;

  function doFetch(callback) {
    ++tries;

    var stream = client.download({
      container: options.storage.container,
      remote: [ options.app.user, options.app.name, options.app.version ].join('-') + '.tgz'
    });

    stream.pipe(fs.createWriteStream(packedSnapshotPath))

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
    login: 'nodejitsu-' + options.app.user,
    shell: false,
    home: false
  }, callback);
};

var unpack = exports.unpack = function unpack(options, callback) {
  var snapshotPath = path.join(os.tmpDir(), 'snapshot'),
      child;

  console.log('Unpacking snapshot...');

  options.snapshotPath = snapshotPath;
  options.packagePath = path.join(snapshotPath, 'package');

  mkdirp(snapshotPath, function (err) {
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

    options.enginePath = path.join(options.engines.node.path, match, 'bin', 'node');
    callback();
  });
};

var startApp = exports.startApp = function startApp(options, callback) {
  var args = [],
      pid = '',
      child;

  console.log('Starting application...');

  args = ['start', '-o', 'estragon.log', '--', 'estragon'];
  options.instruments.forEach(function (instrument) {
    args.push('-h', instrument.host + ':' + (instrument.port || 8556).toString());
  });

  args.push('--app-user', options.app.user);
  args.push('--app-name', options.app.name);

  args.push('--', options.enginePath, options['package.json'].scripts.start.split(' ')[1]);

  child = spawn('aeternum', args, {
    cwd: path.join(options.snapshotPath, 'package')
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
};
