var fs = require('fs'),
    os = require('os'),
    path = require('path'),
    spawn = require('child_process').spawn,
    async = require('async'),
    pkgcloud = require('pkgcloud'),
    useradd = require('useradd');

function noop() {}

//
// Starts an application.
//
module.exports = function (options, callback) {
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
      async.apply(start, options)
    ], callback);
  });
};

var fetch = module.exports.fetch = function fetch(options, callback) {
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
var createUser = module.exports.createUser = function createUser(options, callback) {
  console.log('Creating user...');

  useradd({
    login: 'nodejitsu-' + options.app.user,
    shell: false,
    home: false
  }, callback);
};

var unpack = module.exports.unpack = function unpack(options, callback) {
  var snapshotPath = path.join(os.tmpDir(), 'snapshot'),
      child;

  console.log('Unpacking snapshot...');

  options.snapshotPath = snapshotPath;
  options.packagePath = path.join(snapshotPath, 'package');

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
};

var readPackageJSON = module.exports.readPackageJSON = function readPackageJSON(options, callback) {
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

var start = module.exports.start = function start(options, callback) {
  var args = [],
      child;

  console.log('Starting application...');

  // XXX(mmalecki): LOLOLOL HACK
  args = ['start', '-o', 'estragon.log', '--'];
  options.instruments.forEach(function (instrument) {
    args.push('-h', instrument.host + ':' + (instruments.port || 8556).toString());
  });
  args.push('--', 'node', options['package.json'].scripts.start.split(' ')[1]);

  child = spawn('aeternum', args, {
    cwd: path.join(snapshotPath, 'package')
  });
};
